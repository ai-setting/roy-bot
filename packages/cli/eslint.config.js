// ESLint v10 flat-config for @ai-setting/roy-bot-cli
// Docs: https://eslint.org/docs/latest/use/configure/configuration-files
//
// To extend, add more config objects to the exported array. Object
// precedence: later entries override earlier ones.
//
// To run:  pnpm exec eslint <path>
// To fix:  pnpm exec eslint --fix <path>

import tsParser from "@typescript-eslint/parser";
import localPlugin from "./eslint-plugin-local/index.js";

export default [
  {
    // Apply to all .ts / .tsx / .js / .jsx files under src/, except tests.
    files: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    ignores: [
      "**/*.test.{ts,tsx,js,jsx}",
      "**/__tests__/**",
      "**/__integration__/**",
      "dist/**",
      "node_modules/**",
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: {
        // Node.js + a few project-wide globals
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
    plugins: {
      local: localPlugin,
    },
    rules: {
      // Project-specific rules
      "local/list-output-json-key-order": "warn",
    },
  },
];
