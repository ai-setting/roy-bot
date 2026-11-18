/**
 * @fileoverview Tests for the `list-output-json-key-order` ESLint rule.
 *
 * The rule enforces that list-style JSON output (e.g. `output.json({...})`
 * or `JSON.stringify({...})`) places metadata keys (total/count/...)
 * BEFORE array keys (tasks/items/...). This guarantees that downstream
 * tail-truncation (ToolComponent.truncateOutput, `head -c`, LLM context
 * windows) cannot accidentally drop the summary metadata.
 *
 * Background (Code Review Suggestion S-3):
 *   Without an automated check, the "total-first" convention has been
 *   accidentally violated 4 times across the codebase (commits eeaad3ab,
 *   04b02d89, 5a46462d, c18ab1d2). This rule prevents future regressions.
 *
 * Tests use ESLint's programmatic `Linter` so the rule can be exercised
 * without a full ESLint config / project setup.
 */

import { describe, it, expect } from "bun:test";
import { Linter } from "eslint";
import rule from "./list-output-json-key-order.js";

const linter = new Linter();

// ESLint v10 flat-config shape: register the rule via `plugins`, then
// enable it under its namespaced name. We use a stub plugin entry that
// points to our default export.
const baseConfig = [
  {
    plugins: {
      local: {
        rules: {
          "list-output-json-key-order": rule,
        },
      },
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "local/list-output-json-key-order": "error",
    },
  },
];

/**
 * Run the rule on a snippet of source code and return its diagnostic
 * messages. Snippets use the built-in espree parser (JS only), so
 * plain JS object literals are sufficient.
 */
function run(code) {
  return linter.verify(code, baseConfig);
}

/**
 * Apply the rule's autofix and return the resulting source.
 * If no autofix was applied, returns the original code.
 */
function applyFix(code) {
  const result = linter.verifyAndFix(code, baseConfig);
  return result.output;
}

describe("list-output-json-key-order rule — detection (RED phase 1)", () => {
  it("flags `output.json({ tasks: [], total: 1 })` (array key before metadata)", () => {
    const code = `output.json({ tasks: [], total: 1 });`;
    const messages = run(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe("local/list-output-json-key-order");
    expect(messages[0].message).toMatch(/metadata/i);
    expect(messages[0].message).toMatch(/array/i);
  });

  it("flags `JSON.stringify({ tasks: [], total: 1 })` (array key before metadata)", () => {
    const code = `JSON.stringify({ tasks: [], total: 1 });`;
    const messages = run(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe("local/list-output-json-key-order");
  });

  it("flags mixed ordering: { total: 1, tasks: [], count: 2 } (array in the middle)", () => {
    const code = `output.json({ total: 1, tasks: [], count: 2 });`;
    const messages = run(code);
    // The violation occurs at tasks[] (which sits between two metas).
    // Expected: one report on the call.
    expect(messages).toHaveLength(1);
  });

  it("flags multiple array keys interleaved with metadata", () => {
    const code = `output.json({ items: [1,2], total: 5, results: [3] });`;
    const messages = run(code);
    expect(messages).toHaveLength(1);
  });
});

describe("list-output-json-key-order rule — no false positives (RED phase 2)", () => {
  it("does NOT flag `output.json({ total: 1, count: 1, truncated: false, tasks: [] })` (already correct)", () => {
    const code = `output.json({ total: 1, count: 1, truncated: false, tasks: [] });`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });

  it("does NOT flag an object that only has metadata (no array key present)", () => {
    const code = `output.json({ total: 5, count: 5, truncated: false });`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });

  it("does NOT flag an object that only has array keys (no metadata present)", () => {
    const code = `output.json({ tasks: [], items: [] });`;
    const messages = run(code);
    // `items` + `tasks` are both array keys; no ordering issue.
    expect(messages).toHaveLength(0);
  });

  it("does NOT flag a non-list-style object (e.g. user config: { name, age })", () => {
    const code = `output.json({ name: "foo", age: 30, email: "x@y" });`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });

  it("does NOT flag unrelated calls (non-target callee like console.log({...}))", () => {
    const code = `console.log({ tasks: [], total: 1 });`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });
});

describe("list-output-json-key-order rule — autofix (RED phase 3)", () => {
  it("autofix reorders `output.json({ tasks: [], total: 1 })` to `{ total: 1, tasks: [] }`", () => {
    const code = `output.json({ tasks: [], total: 1 });`;
    const fixed = applyFix(code);
    expect(fixed).toBe(`output.json({ total: 1, tasks: [] });`);
  });

  it("autofix reorders `JSON.stringify({ tasks: [], total: 1 })` to correct order", () => {
    const code = `JSON.stringify({ tasks: [], total: 1 });`;
    const fixed = applyFix(code);
    expect(fixed).toBe(`JSON.stringify({ total: 1, tasks: [] });`);
  });

  it("autofix groups all metadata first, then unknown, then all array keys (preserving relative order within each group)", () => {
    const code = `output.json({
  keywords: ["k1"],
  tasks: [1, 2],
  offset: 0,
  total: 5,
  count: 2,
  limit: 20,
});`;
    const fixed = applyFix(code);
    // Expected after fix:
    // - metadata group (preserved order from original): offset, total, count, limit
    // - unknown group: keywords
    // - array group: tasks
    expect(fixed).toBe(`output.json({
  offset: 0,
  total: 5,
  count: 2,
  limit: 20,
  keywords: ["k1"],
  tasks: [1, 2],
});`);
  });

  it("autofix with 2 metadata keys and 2 array keys: metadata→other→array", () => {
    const code = `output.json({ items: [], total: 5, count: 1, tasks: [{ id: 1 }] });`;
    const fixed = applyFix(code);
    expect(fixed).toBe(`output.json({ total: 5, count: 1, items: [], tasks: [{ id: 1 }] });`);
  });
});

describe("list-output-json-key-order rule — call-shape detection (RED phase 4)", () => {
  it("only inspects the FIRST argument of the target call (ignores other args)", () => {
    // The second argument is unrelated — the rule should not report on it.
    const code = `output.json({ items: [], total: 5 }, { debug: true });`;
    const fixed = applyFix(code);
    // Only the first object's keys should be reordered.
    expect(fixed).toBe(`output.json({ total: 5, items: [] }, { debug: true });`);
  });

  it("does NOT flag `output.json` calls that lack an object literal first argument", () => {
    const code = `output.json(someVariable);`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });

  it("does NOT flag nested objects inside target calls (only the top-level is checked)", () => {
    // The inner `tasks` array contains objects with `id` key — that's fine.
    // We're checking that the rule inspects the OUTER object, not deep into values.
    const code = `output.json({ total: 1, tasks: [{ id: 1, title: "x" }] });`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });
});

describe("list-output-json-key-order rule — key-shape edge cases (RED phase 5)", () => {
  it("detects violations with string-literal keys (not just identifiers)", () => {
    const code = `output.json({ "tasks": [], "total": 1 });`;
    const messages = run(code);
    expect(messages).toHaveLength(1);
  });

  it("detects violations with mixed identifier and string-literal keys", () => {
    const code = `output.json({ tasks: [], "total": 1 });`;
    const messages = run(code);
    expect(messages).toHaveLength(1);
  });

  it("does NOT flag objects with computed keys (cannot verify statically)", () => {
    const code = `const K = "tasks"; output.json({ [K]: [], total: 1 });`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });

  it("does NOT flag objects with spread elements (cannot verify ordering through them)", () => {
    const code = `const base = { x: 1 }; output.json({ ...base, tasks: [], total: 1 });`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });

  it("does NOT flag nested array-style keys in VALUES (only top-level literal checked)", () => {
    // The inner `items: [1, 2]` is a VALUE, not a property of the outer object.
    // The outer object has only `total` + `tasks` (correctly ordered).
    const code = `output.json({ total: 1, tasks: [{ items: [1, 2] }] });`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });
});

describe("list-output-json-key-order rule — extended ARRAY_KEYS coverage (Code Review S-4 polish)", () => {
  // Code Review S-4 found that the original ARRAY_KEYS whitelist
  // (tasks/items/results/data/list/rows/entries/records) did NOT cover
  // domain-specific plural keys like workflows/agents/tools/skills.
  // These tests lock in the expansion so future regressions are caught.

  it("flags `workflows` (extended array key) when it appears BEFORE total", () => {
    // Mirrors the actual bug in `workflow list --json` pre-S-4 fix:
    //   { workflows: [...], available_tags: [], total, count, ... }
    const code = `output.json({ workflows: [], total: 1 });`;
    const messages = run(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe("local/list-output-json-key-order");
  });

  it("flags `agents` (extended array key) when it appears BEFORE total", () => {
    const code = `output.json({ agents: [{}], total: 5 });`;
    const messages = run(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe("local/list-output-json-key-order");
  });

  it("flags `tools` (extended array key) when it appears BEFORE total", () => {
    const code = `output.json({ tools: [], total: 3 });`;
    const messages = run(code);
    expect(messages).toHaveLength(1);
  });

  it("flags `skills` (extended array key) when it appears BEFORE total", () => {
    const code = `output.json({ skills: [], total: 7 });`;
    const messages = run(code);
    expect(messages).toHaveLength(1);
  });

  it("does NOT flag a correctly-ordered object using extended array keys (e.g. workflows first as KEY)", () => {
    // Same `workflows` key, but placed LAST — should be allowed.
    const code = `output.json({ total: 1, count: 1, truncated: false, workflows: [] });`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });

  it("autofix reorders a mis-ordered object using extended array keys (workflows BEFORE total → metadata first)", () => {
    const code = `output.json({ workflows: [], total: 1 });`;
    const fixed = applyFix(code);
    expect(fixed).toBe(`output.json({ total: 1, workflows: [] });`);
  });

  it("autofix reorders objects with multiple extended array keys (agents, tools, skills)", () => {
    const code = `output.json({ agents: [], tools: [], skills: [], total: 5, count: 0 });`;
    const fixed = applyFix(code);
    // Metadata (total, count) first; array keys (agents, tools, skills) last,
    // preserving the original relative order within each group.
    expect(fixed).toBe(`output.json({ total: 5, count: 0, agents: [], tools: [], skills: [] });`);
  });
});

describe("list-output-json-key-order rule — extended METADATA_KEYS coverage (Code Review S-4 polish)", () => {
  // Some commands expose summary-info fields that live in the metadata block
  // (e.g. `available_tags` for workflow list, `keywords` for tasks search)
  // even though they're not numbers. These tests ensure such "command-specific
  // metadata" is treated like metadata, not like payload arrays.

  it("does NOT flag `available_tags` AFTER `total` (workflow list pattern)", () => {
    const code = `output.json({
  total: 1,
  count: 1,
  truncated: false,
  limit: 50,
  offset: 0,
  page: 1,
  available_tags: [{ name: "ai", count: 3 }],
  workflows: [],
});`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });

  it("does NOT flag `keywords` AFTER `total` (tasks search pattern)", () => {
    const code = `output.json({
  total: 5,
  count: 5,
  truncated: false,
  limit: 20,
  offset: 0,
  keywords: ["test"],
  tasks: [],
});`;
    const messages = run(code);
    expect(messages).toHaveLength(0);
  });

  it("autofix places `available_tags` BETWEEN meta and array groups (canonical order)", () => {
    // Pre-S-4 bug shape: { workflows: [], available_tags: [], total, count, ... }
    // Available_tags is treated as "other" (not pure meta, not pure array),
    // so it lives in the middle group between metadata and the array.
    // → After fix: { total, count, limit, offset, page, available_tags, workflows }
    //
    // We deliberately do NOT add `available_tags` to METADATA_KEYS — that
    // would force it to be sorted within the meta group by source order,
    // breaking the canonical "available_tags just before workflows" layout.
    // Treating it as "other" produces the desired output naturally.
    const code = `output.json({
  workflows: [],
  available_tags: [],
  total: 1,
  count: 0,
  limit: 50,
  offset: 0,
  page: 1,
});`;
    const fixed = applyFix(code);
    expect(fixed).toBe(`output.json({
  total: 1,
  count: 0,
  limit: 50,
  offset: 0,
  page: 1,
  available_tags: [],
  workflows: [],
});`);
  });
});
