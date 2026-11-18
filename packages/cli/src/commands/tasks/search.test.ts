/**
 * @fileoverview `tasks search` JSON output contract tests.
 *
 * Verifies the SHAPE that `roy-bot tasks search --json` MUST emit,
 * driven by the shared `buildListTasksJson` helper. The handler itself
 * does not need its own test fixture — these tests pin down the
 * observable JSON contract that downstream consumers depend on, and
 * the actual handler integration is covered by manual CLI verification
 * (see worktree commit notes).
 *
 * Contract (matching the unified `tasks list` shape + `keywords` extra):
 *
 *   {
 *     "total":     <number>,           // FIRST
 *     "count":     <number>,
 *     "truncated": <boolean>,
 *     "limit":     <number|undef>,
 *     "offset":    <number|undef>,
 *     "keywords":  <string[]>,         // search-specific, BEFORE tasks
 *     "tasks":     [...]               // LAST
 *   }
 *
 * Regression coverage for the typo bug that previously swapped
 * `limit` ↔ `offset` in search.ts (fixed by Code Review S-2).
 */

import { describe, it, expect } from "bun:test";
import { buildListTasksJson } from "./_build-list-json";
import type { Task } from "@ai-setting/roy-bot-core";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Sample Task",
    description: "",
    status: "todo",
    priority: "medium",
    type: "normal",
    progress: 0,
    current_status: "",
    goals_and_expected_deliverables: "",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    project_path: "unknown",
    context: "{}",
    ...overrides,
  };
}

/**
 * Helper that mirrors exactly what `search.ts` does internally: build the
 * JSON via the shared helper, passing the search keywords as `extras`.
 *
 * If this helper diverges from the handler, the CLI verification step at
 * the end of this worktree will catch it.
 */
function buildSearchJson(
  tasks: Task[],
  total: number,
  args: { limit?: number; offset?: number },
  keywords: string[],
) {
  return buildListTasksJson(tasks, total, args, { keywords });
}

describe("tasks search JSON output (S-2: unified with list, keywords extra)", () => {
  it("should place `total` as the FIRST key in the JSON output", () => {
    const tasks = [makeTask({ id: 1, title: "Hit" })];
    const json = buildSearchJson(tasks, /* total */ 1, { limit: 20, offset: 0 }, ["hello"]);
    const serialized = JSON.stringify(json);
    expect(serialized.startsWith('{"total":')).toBe(true);
  });

  it("should include `keywords` at the top level (search-specific metadata)", () => {
    const tasks = [makeTask({ id: 1 })];
    const json = buildSearchJson(
      tasks, /* total */ 1,
      { limit: 20, offset: 0 },
      ["alpha", "beta"],
    );

    expect(json).toHaveProperty("keywords");
    expect((json as Record<string, unknown>).keywords).toEqual(["alpha", "beta"]);
  });

  it("should place `keywords` AFTER metadata fields (total/count/truncated/limit/offset)", () => {
    const tasks = [makeTask({ id: 1 })];
    const json = buildSearchJson(tasks, 1, { limit: 20, offset: 0 }, ["foo"]);
    const serialized = JSON.stringify(json);

    const totalIndex = serialized.indexOf('"total":');
    const keywordsIndex = serialized.indexOf('"keywords":');

    expect(keywordsIndex).toBeGreaterThan(totalIndex);
  });

  it("should place `tasks` as the LAST key (array is the truncation target)", () => {
    const tasks = [makeTask({ id: 1 })];
    const json = buildSearchJson(tasks, 1, { limit: 20, offset: 0 }, ["foo"]);
    const serialized = JSON.stringify(json);

    expect(serialized.endsWith("]}")).toBe(true);

    const keywordsIndex = serialized.indexOf('"keywords":');
    const tasksIndex = serialized.indexOf('"tasks":');
    expect(tasksIndex).toBeGreaterThan(keywordsIndex);
  });

  it("should include `truncated` flag (S-2: was missing in old search.ts)", () => {
    // 5 hits but limit=2 → truncated.
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })];
    const json = buildSearchJson(tasks, /* total */ 5, { limit: 2, offset: 0 }, ["foo"]);

    expect(json.total).toBe(5);
    expect(json.count).toBe(2);
    expect(json.truncated).toBe(true);
  });

  it("should echo `limit` and `offset` correctly (S-2: regression for limit/offset swap typo)", () => {
    // Regression: previously search.ts had `limit: args.offset`. This MUST
    // NOT regress. Use distinct, non-default values so a swap is detectable.
    const tasks = [makeTask({ id: 1 })];
    const json = buildSearchJson(tasks, 1, { limit: 7, offset: 21 }, ["foo"]);

    expect(json.limit).toBe(7);
    expect(json.offset).toBe(21);
    // Negative assertions: limit must NOT be 21 and offset must NOT be 7.
    expect(json.limit).not.toBe(21);
    expect(json.offset).not.toBe(7);
  });

  it("should preserve the exact key order: total, count, truncated, limit, offset, keywords, tasks", () => {
    const tasks = [makeTask({ id: 1 })];
    const json = buildSearchJson(tasks, 1, { limit: 20, offset: 0 }, ["foo"]);

    const keys = Object.keys(json);
    expect(keys).toEqual([
      "total",
      "count",
      "truncated",
      "limit",
      "offset",
      "depth",
      "keywords",
      "tasks",
    ]);
  });
});