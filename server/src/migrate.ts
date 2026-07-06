import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { pool } from "./db";

/**
 * Minimal forward-only migration runner: applies every .sql file in
 * ../migrations (lexicographic order) exactly once, tracked in
 * schema_migrations. Each file runs in its own transaction. The caller owns
 * the pool lifecycle (so tests can reuse the shared pool).
 */
export async function runMigrations(targetPool: Pool): Promise<void> {
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await targetPool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );

    const { rows } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations"
    );
    const applied = new Set(rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      console.log(`apply  ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

// CLI entry: migrate the configured database, then close the pool.
if (require.main === module) {
  runMigrations(pool)
    .then(() => {
      console.log("migrations complete");
      return pool.end();
    })
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}
