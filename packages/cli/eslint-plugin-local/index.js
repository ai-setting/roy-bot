/**
 * @fileoverview Local ESLint plugin for @ai-setting/roy-bot-cli.
 *
 * Contains project-specific lint rules that are not part of any
 * public ESLint plugin. See rules/ for individual rule definitions.
 *
 * Why a local plugin?
 * -------------------
 * Some of our conventions (e.g. "list-style JSON output must put
 * `total` first") are too domain-specific to live in a public plugin
 * but are worth enforcing mechanically. Housing them in
 * `eslint-plugin-local` keeps the rules alongside the code they
 * govern, so they can evolve together.
 *
 * Add new rules to ./rules/<name>.js and export them below.
 */

import listOutputJsonKeyOrder from "./rules/list-output-json-key-order.js";

export default {
  meta: {
    name: "eslint-plugin-local",
  },
  rules: {
    "list-output-json-key-order": listOutputJsonKeyOrder,
  },
};
