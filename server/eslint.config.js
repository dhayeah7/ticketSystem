const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

// Flat config (ESLint 9). Lints the TypeScript source with the recommended
// JS + typescript-eslint rule sets, plus a couple of project conventions:
//  - unused vars/args are errors, but a leading underscore marks them as
//    intentionally unused (e.g. the 4-arg Express error handler).
//  - console.log is disallowed in the request path (use a real logger); warn
//    and error are allowed for startup/shutdown and error reporting. The
//    migration CLI is exempt since its stdout is its interface.
module.exports = tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "coverage/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // The migration runner is a CLI tool; console.log is its intended output.
    files: ["src/migrate.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Config files (this file, jest.config.js) are plain CommonJS.
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  }
);
