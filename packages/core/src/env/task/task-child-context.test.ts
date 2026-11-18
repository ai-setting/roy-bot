/**
 * @fileoverview Task Child Context — RED phase test suite.
 *
 * Cover the rules for inheriting context when creating a child task
 * under an existing parent:
 *   - project_path: always inherit from parent (unless overridden)
 *   - branch / worktree_path / parent_branch: inherit when applicable
 *   - context (JSON): merge + preserve safe fields; drop sensitive keys
 *   - tags: NOT inherited by default (caller can pass its own)
 *   - prior_context.commit: never copied (security: avoid leaking private SHA)
 *   - created_at: always overwritten with current timestamp
 *
 * Backward compatibility: the helper is a NEW pure function that the
 * createTask tool may call; it does NOT alter existing createTask
 * behavior unless the caller explicitly opts in.
 */

import { describe, test, expect } from "bun:test";
import {
  inheritChildContext,
  type ParentContextSnapshot,
  type ChildContextOverrides,
} from "./task-child-context";

function makeParent(overrides: Partial<ParentContextSnapshot> = {}): ParentContextSnapshot {
  return {
    taskId: 100,
    projectPath: "/repo/root",
    contextJson: JSON.stringify({
      worktree_path: "/repo/root/.worktrees/feat-a",
      branch: "feat/a",
      parent_branch: "main",
      type: "feature",
      prior_context: { prev_task: 50, commit: "abc123def456" },
      custom_field: "preserve-me",
    }),
    tags: ["a-stock-screener", "v0.7.0"],
    ...overrides,
  };
}

describe("inheritChildContext", () => {
  // ===== Basic inheritance =====
  test("inherits project_path from parent by default", () => {
    const r = inheritChildContext({ parent: makeParent() });
    expect(r.project_path).toBe("/repo/root");
  });

  test("inherits worktree_path + branch from parent's parsed context", () => {
    const r = inheritChildContext({ parent: makeParent() });
    const ctx = JSON.parse(r.context);
    expect(ctx.worktree_path).toBe("/repo/root/.worktrees/feat-a");
    expect(ctx.branch).toBe("feat/a");
    expect(ctx.parent_branch).toBe("main");
  });

  test("does NOT inherit tags by default (caller provides own)", () => {
    const r = inheritChildContext({ parent: makeParent() });
    expect(r.inheritedTags).toEqual([]);
  });

  test("inherits tags when inheritTags=true (opt-in)", () => {
    const r = inheritChildContext({
      parent: makeParent(),
      overrides: { inheritTags: true },
    });
    expect(r.inheritedTags).toEqual(["a-stock-screener", "v0.7.0"]);
  });

  // ===== Overrides =====
  test("overrides.projectPath replaces inherited project_path", () => {
    const r = inheritChildContext({
      parent: makeParent({ projectPath: "/parent/proj" }),
      overrides: { projectPath: "/override/proj" },
    });
    expect(r.project_path).toBe("/override/proj");
  });

  test("overrides.branch replaces inherited branch", () => {
    const r = inheritChildContext({
      parent: makeParent(),
      overrides: { branch: "fix/child" },
    });
    const ctx = JSON.parse(r.context);
    expect(ctx.branch).toBe("fix/child");
  });

  test("overrides.worktreePath replaces inherited worktree_path", () => {
    const r = inheritChildContext({
      parent: makeParent(),
      overrides: { worktreePath: "/custom/wt" },
    });
    const ctx = JSON.parse(r.context);
    expect(ctx.worktree_path).toBe("/custom/wt");
  });

  // ===== Sensitive field stripping =====
  test("never copies prior_context.commit (security)", () => {
    const r = inheritChildContext({ parent: makeParent() });
    const ctx = JSON.parse(r.context);
    expect(ctx.prior_context).toBeDefined();
    expect(ctx.prior_context.commit).toBeUndefined();
    // prior_context.prev_task IS preserved (helpful for trail)
    expect(ctx.prior_context.prev_task).toBe(50);
  });

  test("drops entire prior_context if it becomes empty after stripping", () => {
    const parent = makeParent({
      contextJson: JSON.stringify({
        worktree_path: "/wt",
        branch: "feat/x",
        prior_context: { commit: "only-commit-no-other" },
      }),
    });
    const r = inheritChildContext({ parent: parent });
    const ctx = JSON.parse(r.context);
    expect(ctx.prior_context).toBeUndefined();
  });

  test("preserves custom non-prior_context keys", () => {
    const r = inheritChildContext({ parent: makeParent() });
    const ctx = JSON.parse(r.context);
    expect(ctx.custom_field).toBe("preserve-me");
  });

  // ===== created_at auto-injection =====
  test("auto-injects created_at with current timestamp", () => {
    const before = Date.now();
    const r = inheritChildContext({ parent: makeParent() });
    const after = Date.now();
    const ctx = JSON.parse(r.context);
    const ts = Date.parse(ctx.created_at);
    expect(ts >= before - 1).toBe(true);
    expect(ts <= after + 1).toBe(true);
  });

  test("preserves manual created_at override when provided", () => {
    const r = inheritChildContext({
      parent: makeParent(),
      overrides: { createdAt: "2026-01-01T00:00:00.000Z" },
    });
    const ctx = JSON.parse(r.context);
    expect(ctx.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  // ===== Malformed parent context =====
  test("falls back gracefully when parent context is malformed JSON", () => {
    const parent = makeParent({ contextJson: "not valid json" });
    const r = inheritChildContext({ parent });
    expect(r.project_path).toBe("/repo/root"); // still inherited
    // context still produced (just without worktree/branch/etc.)
    expect(() => JSON.parse(r.context)).not.toThrow();
  });

  test("handles empty parent context string", () => {
    const parent = makeParent({ contextJson: "" });
    const r = inheritChildContext({ parent });
    expect(r.project_path).toBe("/repo/root");
  });

  // ===== child_marker =====
  test("adds child_marker=task_id of parent to context", () => {
    const r = inheritChildContext({ parent: makeParent({ taskId: 2379 }) });
    const ctx = JSON.parse(r.context);
    expect(ctx.child_of).toBe(2379);
  });

  // ===== No context inherit when contextInherit=false =====
  test("contextInherit=false skips all inherited context fields", () => {
    const r = inheritChildContext({
      parent: makeParent(),
      overrides: { contextInherit: false },
    });
    const ctx = JSON.parse(r.context);
    // created_at still auto-injected (not inherited from parent)
    expect(ctx.created_at).toBeDefined();
    // No branch / worktree_path / prior_context
    expect(ctx.worktree_path).toBeUndefined();
    expect(ctx.branch).toBeUndefined();
    expect(ctx.parent_branch).toBeUndefined();
    expect(ctx.prior_context).toBeUndefined();
  });

  // ===== Returns ready-to-use payload =====
  test("returns object with keys compatible with CreateTaskOptions", () => {
    const r = inheritChildContext({ parent: makeParent() });
    expect(r).toHaveProperty("project_path");
    expect(r).toHaveProperty("context");
    expect(r).toHaveProperty("inheritedTags");
    expect(typeof r.context).toBe("string");
  });

  // ===== Override type explicit =====
  test("override.branch=undefined means 'keep inherited branch'", () => {
    const r = inheritChildContext({
      parent: makeParent(),
      overrides: { branch: undefined },
    });
    const ctx = JSON.parse(r.context);
    expect(ctx.branch).toBe("feat/a");
  });
});