import { pool } from "../src/db";
import { runMigrations } from "../src/migrate";

/** Ensure the test database schema exists (idempotent). */
export async function migrateTestDb(): Promise<void> {
  await runMigrations(pool);
}

/**
 * Wipe all data between tests. CASCADE clears shifts/assignments too.
 *
 * NOTE: implementation.md §6 describes integration isolation as "rolled-back
 * transactions", but we deliberately TRUNCATE instead. The service acquires its
 * own pooled connection and runs its own BEGIN/COMMIT, and the concurrency tests
 * fire N parallel requests to exercise real pg_advisory_xact_lock contention.
 * A single shared rollback-able transaction would force all of that onto one
 * connection, making the idempotency/concurrency guarantees untestable. Truncation
 * keeps those tests representative at the cost of matching the doc's wording.
 */
export async function resetDb(): Promise<void> {
  await pool.query("TRUNCATE assignments, shifts, agents RESTART IDENTITY CASCADE");
}

/** Close the shared pool so the Jest worker can exit cleanly. */
export async function closePool(): Promise<void> {
  await pool.end();
}

export interface SeedShift {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  crossesMidnight?: boolean;
}

export interface SeedAgentOptions {
  companyId: string;
  name?: string;
  timezone?: string;
  active?: boolean;
  shifts?: SeedShift[];
}

/** Insert an agent (and any shifts); returns the new agent id. */
export async function seedAgent(opts: SeedAgentOptions): Promise<string> {
  const {
    companyId,
    name = "Agent",
    timezone = "UTC",
    active = true,
    shifts = [],
  } = opts;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO agents (company_id, name, timezone, active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, name, timezone, active]
  );
  const agentId = inserted.rows[0].id;

  for (const s of shifts) {
    await pool.query(
      `INSERT INTO shifts (agent_id, day_of_week, start_minute, end_minute, crosses_midnight)
       VALUES ($1, $2, $3, $4, $5)`,
      [agentId, s.dayOfWeek, s.startMinute, s.endMinute, s.crossesMidnight ?? false]
    );
  }
  return agentId;
}

/** Open-ticket counts per agent for a company, as a map of agentId -> count. */
export async function openCountsByAgent(
  companyId: string
): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ agent_id: string; count: string }>(
    `SELECT agent_id, count(*)::text AS count
       FROM assignments
      WHERE company_id = $1 AND closed_at IS NULL
      GROUP BY agent_id`,
    [companyId]
  );
  return new Map(rows.map((r) => [r.agent_id, Number(r.count)]));
}
