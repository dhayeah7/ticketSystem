/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/*.test.ts"],
  // Integration tests open real Postgres connections; give them room and
  // run serially so per-company advisory-lock behavior is deterministic.
  testTimeout: 20000,
  // Point the shared pool at the test database before any src module loads.
  setupFiles: ["<rootDir>/test/env.ts"],
};
