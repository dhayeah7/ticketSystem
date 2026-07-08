import dotenv from "dotenv";

dotenv.config();

/** Parse a TCP port from the environment, rejecting non-integers and out-of-range values. */
function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT "${raw}": expected an integer 1..65535`);
  }
  return port;
}

/**
 * Central config. Defaults match docker-compose.yml so a fresh checkout runs
 * with no .env. Tests point DATABASE_URL at the test database.
 */
export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://ticket:ticket@localhost:5432/ticketsystem",
  testDatabaseUrl:
    process.env.TEST_DATABASE_URL ??
    "postgres://ticket:ticket@localhost:5432/ticketsystem_test",
  port: parsePort(process.env.PORT, 3001),
};
