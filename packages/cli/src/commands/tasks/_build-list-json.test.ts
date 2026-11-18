/**
 * @fileoverview Shared `buildListTasksJson` helper — JSON output structure tests
 *
 * This helper was extracted from `list.ts` so that `search.ts` can reuse it
 * (Code Review Suggestion S-2). The shape produced here is the SINGLE
 * SOURCE OF TRUTH for both `tasks list --json` and `tasks search --json`,
 * so any change to key ordering MUST be reflected here AND in the search
 * command's own tests.
 *
 * Tests verify the structural invariants that downstream tooling depends on:
 *
 *   1. `total` is the FIRST key (so it survives tail-truncation).
 *   2. `truncated` is true when total > count.
 *   3. `truncated` is false when total === count.
 *   4. `tasks` is the LAST key (so the array is the truncation target).
 *   5. `limit` and `offset` echo back `args.limit` and `args.offset`
 *      correctly — regression guard against the typo that previously
 *      swapped these in `search.ts`.
 *   6. Optional `extras` (e.g. `keywords` for search) are inserted
 *      BEFORE `tasks` but AFTER the standard metadata, preserving the
 *      "metadata first, array last" invariant.
 */

import { describe, it, expect } from "bun:test";
import { buildListTasksJson, type ListTaskJson } from "./_build-list-json";
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

describe("buildListTasksJson - shared JSON output structure", () => {
  it("should place `total` as the FIRST key in the serialized JSON output (regression: structural parity with tool path)", () => {
    const tasks = [makeTask({ id: 1, title: "A" }), makeTask({ id: 2, title: "B" })];
    const result = buildListTasksJson(tasks, /* total */ 2, {
      limit: 20,
      offset: 0,
    });
    const serialized = JSON.stringify(result);

    // The serialized JSON's literal first key MUST be "total".
    expect(serialized.startsWith('{"total":')).toBe(true);
  });

  it("should set `truncated: true` when total > count (pagination in effect)", () => {
    // 5 tasks in DB, but only 2 returned because limit=2.
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })];
    const result = buildListTasksJson(tasks, /* total */ 5, {
      limit: 2,
      offset: 0,
    });

    expect(result.total).toBe(5);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("should set `truncated: false` when total === count (no pagination truncation)", () => {
    // 1 task in DB, default limit 20 → no truncation.
    const tasks = [makeTask({ id: 1 })];
    const result = buildListTasksJson(tasks, /* total */ 1, {
      limit: 20,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.count).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("should place `tasks` as the LAST key in the serialized JSON output (metadata-first ordering)", () => {
    const tasks = [makeTask({ id: 1 })];
    const result = buildListTasksJson(tasks, /* total */ 1, {
      limit: 20,
      offset: 0,
    });
    const serialized = JSON.stringify(result);

    // The serialized JSON MUST end with the tasks array closing bracket
    // `]}` so that tail-truncation (if applied by a downstream consumer)
    // cuts the array, not the summary metadata that precedes it.
    expect(serialized.endsWith("]}")).toBe(true);

    // Object.keys preserves insertion order for non-integer-like keys.
    const keys = Object.keys(result);
    expect(keys[0]).toBe("total");
    expect(keys[keys.length - 1]).toBe("tasks");

    // The "tasks" key in the serialized JSON must appear AFTER "total".
    const totalIndex = serialized.indexOf('"total":');
    const tasksIndex = serialized.indexOf('"tasks":');
    expect(tasksIndex).toBeGreaterThan(totalIndex);
  });

  it("should echo `limit` and `offset` from args (regression: search.ts typo bug fix)", () => {
    // Regression guard for the typo in search.ts where `limit: args.offset`
    // was used. The helper MUST pass `args.limit` to `limit` and
    // `args.offset` to `offset` — never swapped.
    const tasks = [makeTask({ id: 1 })];
    const result = buildListTasksJson(tasks, /* total */ 1, {
      limit: 7,
      offset: 21,
    });

    expect(result.limit).toBe(7);
    expect(result.offset).toBe(21);
    // Negative assertion: limit must NOT be 21 and offset must NOT be 7.
    expect(result.limit).not.toBe(21);
    expect(result.offset).not.toBe(7);
  });

  it("should insert optional `extras` (e.g. keywords) BEFORE `tasks` but AFTER metadata", () => {
    // search.ts uses extras to surface the search keywords at the top level
    // of the JSON output. They MUST appear after the metadata fields
    // (total/count/truncated/limit/offset) and BEFORE the `tasks` array,
    // so the "metadata first, array last" invariant holds for both commands.
    const tasks = [makeTask({ id: 1 })];
    const result = buildListTasksJson(tasks, /* total */ 1, {
      limit: 20,
      offset: 0,
    }, {
      keywords: ["alpha", "beta"],
    });

    expect(result).toHaveProperty("keywords");
    expect((result as Record<string, unknown>).keywords).toEqual(["alpha", "beta"]);

    const serialized = JSON.stringify(result);
    const totalIndex = serialized.indexOf('"total":');
    const keywordsIndex = serialized.indexOf('"keywords":');
    const tasksIndex = serialized.indexOf('"tasks":');

    expect(keywordsIndex).toBeGreaterThan(totalIndex);
    expect(tasksIndex).toBeGreaterThan(keywordsIndex);
  });

  it("should produce the documented task projection (ListTaskJson fields only)", () => {
    const tasks = [makeTask({
      id: 42,
      title: "Projection Test",
      status: "active",
      priority: "high",
      type: "cycle",
      progress: 75,
      current_status: "Working on it",
      project_path: "/tmp/proj",
      context: '{"k":"v"}',
    })];
    const result = buildListTasksJson(tasks, 1, { limit: 20, offset: 0 });

    expect(result.tasks).toHaveLength(1);
    const projected = result.tasks[0];
    // Should NOT have extra fields like description or goals_and_expected_deliverables.
    const expectedKeys: Array<keyof ListTaskJson> = [
      "id", "title", "status", "priority", "type", "progress",
      "current_status", "project_path", "context", "createdAt", "updatedAt",
    ];
    expect(Object.keys(projected).sort()).toEqual(expectedKeys.sort());
    expect(projected.id).toBe(42);
    expect(projected.title).toBe("Projection Test");
    expect(projected.context).toBe('{"k":"v"}');
  });
});