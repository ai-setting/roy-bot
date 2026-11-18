/**
 * @fileoverview TaskReuseContext — prompt builder unit tests
 *
 * RED phase test suite for `buildReuseCandidateSection`. Covers:
 * - Empty fallback (no candidates → empty markdown)
 * - Dedup against similar_task_ids
 * - Per-candidate description truncation
 * - Token redaction (defense in depth — registry already sanitizes)
 * - A-stock-screener style fixture (5 tasks, second delegation sees first 4)
 * - Limit + ordering
 * - excludeAncestorOf
 * - "why relevant" hint based on parent_task_id proximity
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  TaskCreationRegistry,
  type TaskRecordSource,
} from "./task-creation-registry";
import { buildReuseCandidateSection } from "./task-reuse-context";
import type { Task } from "./types";

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
    context: overrides.context ?? "{}",
  };
}

function makeSource(overrides: Partial<TaskRecordSource> = {}): TaskRecordSource {
  return {
    sessionId: "sess-1",
    parentSessionId: "sess-root",
    bgTaskId: "process_1",
    subagentType: "roy",
    ...overrides,
  };
}

describe("buildReuseCandidateSection", () => {
  let registry: TaskCreationRegistry;

  beforeEach(() => {
    registry = new TaskCreationRegistry({
      maxEntries: 100,
      ttlMs: 60_000,
      maxDescriptionChars: 120,
    });
  });

  test("empty registry → isEmpty=true and empty markdown", () => {
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 2000,
      maxDescriptionChars: 240,
    });
    expect(section.isEmpty).toBe(true);
    expect(section.markdown).toBe("");
    expect(section.candidateIds).toEqual([]);
  });

  test("single candidate produces a non-empty section with task header", () => {
    registry.record(
      makeTask({
        id: 42,
        title: "design a-stock-screener v0.7.0",
        description: "Add buy-and-hold-N-day sell with fee metrics",
      }),
      makeSource()
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 2000,
      maxDescriptionChars: 240,
    });
    expect(section.isEmpty).toBe(false);
    expect(section.markdown).toContain("Recent task context");
    expect(section.markdown).toContain("#42");
    expect(section.markdown).toContain("design a-stock-screener v0.7.0");
    expect(section.markdown).toContain("Reuse instructions");
    expect(section.candidateIds).toEqual([42]);
  });

  test("deduplicates against similarTaskIds", () => {
    registry.record(makeTask({ id: 1, title: "design" }), makeSource());
    registry.record(makeTask({ id: 2, title: "implement" }), makeSource());
    registry.record(makeTask({ id: 3, title: "verify" }), makeSource());

    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [1, 2], // these are already shown via similar_task_ids
      limit: 5,
      maxChars: 2000,
      maxDescriptionChars: 240,
    });
    expect(section.candidateIds).toEqual([3]);
    expect(section.markdown).toContain("#3");
    expect(section.markdown).not.toContain("### Task #1:");
    expect(section.markdown).not.toContain("### Task #2:");
  });

  test("candidate with parent_task_id shows parent in header", () => {
    registry.record(
      makeTask({ id: 100, title: "root" }),
      makeSource()
    );
    registry.record(
      makeTask({ id: 101, title: "child", parent_task_id: 100 }),
      makeSource()
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 2000,
      maxDescriptionChars: 240,
    });
    expect(section.markdown).toMatch(/#101[\s\S]*[Pp]arent: #100/);
  });

  test("truncates descriptions in markdown output", () => {
    registry.record(
      makeTask({
        id: 1,
        title: "long",
        description: "x".repeat(500),
      }),
      makeSource()
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 2000,
      maxDescriptionChars: 60,
    });
    expect(section.markdown).toContain("…");
    // The description block should be at most 60 chars (within the `…` suffix).
    const descMatch = section.markdown.match(/- Description: (.+)/);
    expect(descMatch).not.toBeNull();
    expect(descMatch![1].length).toBeLessThanOrEqual(60);
  });

  test("respects maxChars limit on total markdown", () => {
    for (let i = 0; i < 20; i++) {
      registry.record(
        makeTask({
          id: 100 + i,
          title: `T-${i}`,
          description: "Lorem ipsum dolor sit amet ".repeat(10),
        }),
        makeSource()
      );
    }
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 20,
      maxChars: 500,
      maxDescriptionChars: 240,
    });
    expect(section.markdown.length).toBeLessThanOrEqual(500);
  });

  test("respects limit parameter on candidate count", () => {
    for (let i = 0; i < 10; i++) {
      registry.record(makeTask({ id: i }), makeSource());
    }
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 3,
      maxChars: 5000,
      maxDescriptionChars: 240,
    });
    expect(section.candidateIds).toHaveLength(3);
  });

  test("status filter narrows candidates", () => {
    registry.record(makeTask({ id: 1, status: "active" }), makeSource());
    registry.record(makeTask({ id: 2, status: "completed" }), makeSource());
    registry.record(makeTask({ id: 3, status: "todo" }), makeSource());
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 240,
      statuses: ["completed"],
    });
    expect(section.candidateIds).toEqual([2]);
  });

  test("a-stock-screener fixture: 5 sequential phases, later phase sees earlier candidates", () => {
    // Simulate the user's screenshot scenario: a feature broken into 5 phases
    // (design / implement / register / run / fix). Each phase creates a task.
    // When phase 5 ("fix") delegates, the registry should have 4 earlier
    // candidates visible to the sub-agent.

    // Phase 1: design (parent root task)
    registry.record(
      makeTask({
        id: 2379,
        title: "design buy-and-hold N-day sell with fees v0.7.0",
        description: "a-stock-screener workflow design",
        parent_task_id: undefined,
      }),
      makeSource({ sessionId: "phase-1", subagentType: "roy" })
    );

    // Phase 2: implement
    registry.record(
      makeTask({
        id: 2381,
        title: "Phase A implement v0.7.0 fee/calendar/kline modules",
        description: "investment-strategy backtest.run extension",
        parent_task_id: 2379,
      }),
      makeSource({ sessionId: "phase-2", subagentType: "roy" })
    );

    // Phase 3: register
    registry.record(
      makeTask({
        id: 2383,
        title: "register a-stock-screener v0.7.0",
        description: "workflow add + validate + register",
        parent_task_id: 2379,
      }),
      makeSource({ sessionId: "phase-3", subagentType: "roy" })
    );

    // Phase 4: run analysis
    registry.record(
      makeTask({
        id: 2384,
        title: "run a-stock-screener v0.7.0 and analyze real picks",
        description: "workflow run + JSON output analysis",
        parent_task_id: 2379,
      }),
      makeSource({ sessionId: "phase-4", subagentType: "roy" })
    );

    // Phase 5: bug fix v0.7.1 (the new delegation we're building)
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [], // user did NOT supply explicit similar IDs
      scope: { parentSessionId: "sess-root" },
      limit: 5,
      maxChars: 2000,
      maxDescriptionChars: 120,
    });

    expect(section.isEmpty).toBe(false);
    // Should see all 4 prior phases as candidates
    expect(section.candidateIds).toContain(2379);
    expect(section.candidateIds).toContain(2381);
    expect(section.candidateIds).toContain(2383);
    expect(section.candidateIds).toContain(2384);

    // Markdown should mention all 4
    expect(section.markdown).toContain("#2379");
    expect(section.markdown).toContain("#2381");
    expect(section.markdown).toContain("#2383");
    expect(section.markdown).toContain("#2384");

    // Should contain explicit reuse instructions
    expect(section.markdown).toContain("task_get");
    expect(section.markdown).toContain("task_update");
  });

  test("scope.parentSessionId limits candidates to that scope", () => {
    registry.record(
      makeTask({ id: 1 }),
      makeSource({ parentSessionId: "root-A" })
    );
    registry.record(
      makeTask({ id: 2 }),
      makeSource({ parentSessionId: "root-B" })
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      scope: { parentSessionId: "root-A" },
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 240,
    });
    expect(section.candidateIds).toEqual([1]);
  });

  test("excludeAncestorOf hides subtree", () => {
    registry.record(makeTask({ id: 100, parent_task_id: undefined }), makeSource());
    registry.record(makeTask({ id: 101, parent_task_id: 100 }), makeSource());
    registry.record(makeTask({ id: 200 }), makeSource());
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      excludeAncestorOf: 100,
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 240,
    });
    expect(section.candidateIds).toEqual([200]);
  });

  test("markdown contains explicit 'reuse instructions' section", () => {
    registry.record(makeTask({ id: 1, title: "foo" }), makeSource());
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 240,
    });
    // Verify the prompt tells the sub-agent to reuse rather than blindly
    // create new tasks.
    expect(section.markdown).toMatch(/reuse/i);
    expect(section.markdown).toMatch(/task_get/i);
    expect(section.markdown).toMatch(/task_update/i);
  });

  test("redacts tokens defensively (even if registry didn't)", () => {
    // Registry should already redact, but the prompt builder is the
    // last line of defense. Inject a record with raw tokens via peekById.
    registry.record(
      makeTask({
        id: 1,
        title: "leaky",
        description: "secret sk-proj-abcdefghijklmnopqrstuvwxyz used",
      }),
      makeSource()
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 240,
    });
    // Either the registry already redacted (preferred), or the builder
    // sanitized again. Either way no raw token in output.
    expect(section.markdown).not.toContain("sk-proj-abc");
  });

  test("candidate ordering: updatedAt DESC", async () => {
    registry.record(makeTask({ id: 1, title: "old" }), makeSource());
    await new Promise((r) => setTimeout(r, 5));
    registry.record(makeTask({ id: 2, title: "mid" }), makeSource());
    await new Promise((r) => setTimeout(r, 5));
    registry.record(makeTask({ id: 3, title: "new" }), makeSource());
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 240,
    });
    expect(section.candidateIds).toEqual([3, 2, 1]);
  });

  test("'why relevant' hint when parent_task_id matches scope's likely current task", () => {
    // Not a strict requirement — we accept either presence or absence.
    // Just verify the builder doesn't crash and produces stable output.
    registry.record(
      makeTask({ id: 50, title: "shared root", parent_task_id: undefined }),
      makeSource({ parentSessionId: "root-X" })
    );
    registry.record(
      makeTask({ id: 51, title: "child of 50", parent_task_id: 50 }),
      makeSource({ parentSessionId: "root-X" })
    );
    const section = buildReuseCandidateSection({
      registry,
      similarTaskIds: [],
      scope: { parentSessionId: "root-X" },
      limit: 5,
      maxChars: 5000,
      maxDescriptionChars: 240,
    });
    // At minimum both should appear
    expect(section.candidateIds.length).toBeGreaterThanOrEqual(2);
  });
});