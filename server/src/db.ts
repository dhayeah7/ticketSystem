import { Pool } from "pg";
import { config } from "./config";

/**
 * Shared connection pool. In tests, set DATABASE_URL to the test database
 * before this module is imported (see the integration test setup).
 */
export const pool = new Pool({ connectionString: config.databaseUrl });
