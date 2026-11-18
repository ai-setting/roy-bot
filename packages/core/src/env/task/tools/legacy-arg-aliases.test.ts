/**
 * Task #4619 — RED test: the task tool schemas must accept the **legacy
 * argument names** as well as the current ones.
 *
 * ## The break this pins
 *
 * The plugin used to publish its **own** hand-written MCP tool catalogue
 * (`claude/mcp/tools.mjs`), which had drifted from roy's real schemas:
 *
 * | tool          | old plugin schema        | roy's real schema         |
 * |---------------|--------------------------|---------------------------|
 * | `task_get`    | `id` (required)          | `task_id` (required)      |
 * | `task_update` | `id` (required)          | `task_id` (required)      |
 * | `task_complete` | `id` (required)        | `task_id` (required)      |
 * | `task_create` | `required: ["title"]`    | `project_path` + `context` also required |
 *
 * Task #4619 replaced the drifted copy with roy's **real** schemas (the
 * whole point: one source of truth). That is correct — but it is a
 * **breaking change** for anyone who wrote a client against the published
 * plugin's catalogue:
 *
 * - `task_get({ id: 5 })` now fails with "task_id required" (zod's
 *   `.object()` strips unknown keys, and `task_id` is required);
 * - `task_create({ title })` now fails for the missing `project_path` /
 *   `context`.
 *
 * ## The fix
 *
 * The schemas accept **both** spellings and **relax** the two fields that
 * were only ever meaningful for the roy-bot runtime:
 *
 * - `id` is an accepted alias of `task_id`;
 * - `project_path` / `context` fall back to sensible defaults instead of
 *   being required.
 *
 * The defaults are not arbitrary: roy's own `task_create` tool already
 * documents `project_path` as "Use 'unknown' if unknown" and `context` as
 * `'{}'` / `'{"type":"unknown"}'`.
 */

import { describe, expect, test } from "bun:test";
import {
  CreateTaskToolSchema,
  GetTaskToolSchema,
  UpdateTaskToolSchema,
  CompleteTaskToolSchema,
} from "./task-types";

describe("Task #4619: task tool schemas accept the legacy argument names", () => {
  test("task_get accepts the legacy `id`", () => {
    const parsed = GetTaskToolSchema.parse({ id: 42 });
    expect(parsed.task_id).toBe(42);
  });

  test("task_get still accepts the current `task_id`", () => {
    const parsed = GetTaskToolSchema.parse({ task_id: 42 });
    expect(parsed.task_id).toBe(42);
  });

  test("task_update accepts the legacy `id`", () => {
    const parsed = UpdateTaskToolSchema.parse({ id: 7, title: "x" });
    expect(parsed.task_id).toBe(7);
  });

  test("task_complete accepts the legacy `id`", () => {
    const parsed = CompleteTaskToolSchema.parse({ id: 7 });
    expect(parsed.task_id).toBe(7);
  });

  test("task_create no longer requires project_path (it defaults)", () => {
    const parsed = CreateTaskToolSchema.parse({ title: "t" });
    expect(parsed.title).toBe("t");
    expect(parsed.project_path).toBe("unknown");
  });

  test("task_create no longer requires context (it defaults)", () => {
    const parsed = CreateTaskToolSchema.parse({ title: "t" });
    expect(parsed.context).toBe('{"type":"unknown"}');
  });

  test("task_create still honours an explicit project_path / context", () => {
    const parsed = CreateTaskToolSchema.parse({
      title: "t",
      project_path: "/tmp/x",
      context: '{"worktree_path":"/tmp/x"}',
    });
    expect(parsed.project_path).toBe("/tmp/x");
    expect(parsed.context).toBe('{"worktree_path":"/tmp/x"}');
  });

  test("the legacy `id` and the current `task_id` must not disagree silently", () => {
    // If both are given with different values, the current name wins and the
    // legacy one is ignored — never a silent "both applied" ambiguity.
    const parsed = GetTaskToolSchema.parse({ id: 1, task_id: 2 });
    expect(parsed.task_id).toBe(2);
  });
});
