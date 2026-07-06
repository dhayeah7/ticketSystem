// Runs (via jest `setupFiles`) before any src module is imported, so the shared
// pool in src/db points at the TEST database rather than the dev database.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://ticket:ticket@localhost:5432/ticketsystem_test";
