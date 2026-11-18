/**
 * @fileoverview TaskReuseContext — three-path decision model tests (Task #2395)
 *
 * Covers the new prompt builder behavior:
 *  - Each candidate shows its project_path, branch, worktree_path
 *  - Each candidate shows subtree summary (children count + active count)
 *  - Decision matrix section with three paths: continuation / child / root
 *  - Copy-able `task_create(parent_task_id=N, ...)` template
 *  - Operation audit templates for each path
 *  - Warning when parent has active child (don't reopen blindly)
 *  - parent/child candidates are NOT collapsed to one
 *  - Backward compat: existing similar_task_ids dedup still works
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { TaskCreationRegistry } from "./task-creation-registry";
import type { Task } from "./types";
import { buildReuseCandidateSection } from "./task-reuse-context";

function makeTask(overrides: Partial<Task> & { id: number }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task #${overrides.id}`,
    description: overrides.description ?? "",
    status: overrides.status ?? "active",
    priority: overrides.priority ?? "medium",
    type: overrides.type ?? "normal",
    progress: overrides.progress ?? 0,
    current_status: overrides.current_status ?? "",
    goals_and_expected_deliverables:
      overrides.goals_and_expected_deliverables ?? "",
    parent_task_id: overrides.parent_task_id,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    tags: overrides.tags ?? [],
    project_path: overrides.project_path ?? "/test/proj",
    context: overrides.context ?? '{"type":"feature"}',
  };
}

function makeSource(overrides: Partial<{ subagentType: string }> = {}) {
  return { ...overrides };
}

describe("buildReuseCandidateSection — three-path decision model (Task #2395)", () => {
  let registry: TaskCreationRegistry;

  beforeEach(() => {
    registry = new TaskCreationRegistry({
      maxEntries: 100,
      ttlMs: 60_000,
      maxDescriptionChars: 200,
    });
  });

  // ===== project context display =====
  test("candidate markdown includes project_path when present", () => {
    registry.record(
      makeTask({
        id: 1,
        title: "design X",
        project_path: "/repo/root",
        context: JSON.stringify({
          branch: "feat/x",
          worktree_path: "/repo/root/.worktrees/feat-x",
        }),
      }),
      makeSource()
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 3000,
      maxDescriptionChars: 200,
    });
    expect(section.markdown).toContain("Project: /repo/root");
    expect(section.markdown).toContain("Branch: feat/x");
  });

  test("candidate with no project_path gracefully omits those lines", () => {
    registry.record(makeTask({ id: 1, project_path: undefined as any }), makeSource());
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 3000,
      maxDescriptionChars: 200,
    });
    expect(section.markdown).toContain("### Task #1");
    expect(section.markdown).not.toContain("Project: undefined");
  });

  // ===== subtree summary display =====
  test("candidate markdown shows subtree summary when present", () => {
    registry.record(makeTask({ id: 1, title: "design" }), makeSource());
    registry.record(
      makeTask({ id: 2, parent_task_id: 1, status: "active", title: "implement" })
    );
    registry.record(
      makeTask({ id: 3, parent_task_id: 1, status: "completed", title: "doc" })
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 3000,
      maxDescriptionChars: 200,
    });
    // Subtree line should mention children counts and active count
    expect(section.markdown).toMatch(/Children:.*active/);
  });

  test("parent with active child shows warning hint in prompt", () => {
    registry.record(
      makeTask({ id: 1, title: "design", status: "completed" }),
      makeSource()
    );
    registry.record(
      makeTask({ id: 2, parent_task_id: 1, status: "active", title: "child bug" })
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 200,
    });
    // When parent is completed but has an active child, prompt should
    // suggest child task creation (avoid blind reopen)
    expect(section.markdown).toMatch(/active child/i);
    expect(section.markdown).toContain("task_create(parent_task_id=");
  });

  // ===== decision matrix section =====
  test("section includes three-path decision matrix", () => {
    registry.record(makeTask({ id: 1, title: "design" }), makeSource());
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 200,
    });
    expect(section.markdown).toContain("### Decision matrix");
    // Three paths
    expect(section.markdown).toContain("Path A");
    expect(section.markdown).toContain("Path B");
    expect(section.markdown).toContain("Path C");
    // Three audit templates
    expect(section.markdown).toContain("continuation");
    expect(section.markdown).toContain("child task");
  });

  // ===== task_create template =====
  test("section includes copy-able task_create(parent_task_id=...) template", () => {
    registry.record(
      makeTask({
        id: 2379,
        title: "design a-stock-screener v0.7.0",
        project_path: "/repo",
      }),
      makeSource()
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 200,
    });
    expect(section.markdown).toContain("task_create(parent_task_id=2379");
    expect(section.markdown).toContain("/repo");
  });

  // ===== operation audit templates =====
  test("section includes operation audit templates for both paths", () => {
    registry.record(makeTask({ id: 1, title: "design" }), makeSource());
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 200,
    });
    // continuation template
    expect(section.markdown).toMatch(/task_operation_create.*milestone_type.*decision/);
    // child-task template
    expect(section.markdown).toMatch(/task_operation_create.*milestone_type.*milestone/);
  });

  // ===== parent/child distinct candidates =====
  test("parent and its child are not collapsed — both appear as candidates", () => {
    registry.record(makeTask({ id: 1, title: "design", status: "completed" }), makeSource());
    registry.record(
      makeTask({ id: 2, parent_task_id: 1, status: "active", title: "implement" }),
      makeSource()
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 200,
    });
    expect(section.markdown).toContain("### Task #1");
    expect(section.markdown).toContain("### Task #2");
    expect(section.candidateIds).toContain(1);
    expect(section.candidateIds).toContain(2);
  });

  // ===== Backward compat: similar_task_ids dedup =====
  test("similar_task_ids still dedupes candidates (Task #2389 compat)", () => {
    registry.record(makeTask({ id: 1, title: "design" }), makeSource());
    registry.record(makeTask({ id: 2, title: "implement" }), makeSource());
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [1],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 200,
    });
    expect(section.candidateIds).toEqual([2]);
    expect(section.markdown).not.toContain("### Task #1:");
  });

  // ===== No candidates → no section =====
  test("no candidates → isEmpty=true", () => {
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 3000,
      maxDescriptionChars: 200,
    });
    expect(section.isEmpty).toBe(true);
  });

  // ===== existing fields preserved (reopen instructions still there) =====
  test("existing Reuse instructions for continuation are still present", () => {
    registry.record(makeTask({ id: 1, title: "design" }), makeSource());
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 200,
    });
    expect(section.markdown).toContain("### Reuse instructions");
    expect(section.markdown).toContain("task_get");
    expect(section.markdown).toContain("task_update");
  });

  // ===== completion ratio on the candidate itself =====
  test("candidate markdown mentions active child count specifically", () => {
    registry.record(makeTask({ id: 1, title: "parent" }), makeSource());
    registry.record(
      makeTask({ id: 2, parent_task_id: 1, status: "active", title: "child-A" })
    );
    registry.record(
      makeTask({ id: 3, parent_task_id: 1, status: "active", title: "child-B" })
    );
    registry.record(
      makeTask({ id: 4, parent_task_id: 1, status: "completed", title: "child-C" })
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 200,
    });
    expect(section.markdown).toMatch(/Children:\s*3/);
    expect(section.markdown).toMatch(/active:\s*2/);
  });
});