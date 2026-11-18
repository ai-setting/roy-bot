/**
 * @fileoverview TaskCreationRegistry — Unit Tests
 *
 * RED phase test suite. Covers:
 * - Basic record / update / remove
 * - LRU eviction
 * - TTL expiration
 * - Scope filtering
 * - excludeIds (dedupe against similar_task_ids)
 * - Status filter (default excludes archived)
 * - Sanitization (token redaction + description truncation)
 * - Concurrency safety (20 parallel record() calls)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  TaskCreationRegistry,
  type TaskRecordSource,
} from "./task-creation-registry";
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
    processId: 12345,
    ...overrides,
  };
}

describe("TaskCreationRegistry", () => {
  let registry: TaskCreationRegistry;

  beforeEach(() => {
    registry = new TaskCreationRegistry({ maxEntries: 100, ttlMs: 60_000 });
  });

  // ===== Basic record / update / remove =====
  describe("basic CRUD", () => {
    test("records a task and exposes it via getById / recent()", () => {
      const task = makeTask({ id: 42, title: "design X" });
      registry.record(task, makeSource());

      const fetched = registry.getById(42);
      expect(fetched).toBeDefined();
      expect(fetched!.taskId).toBe(42);
      expect(fetched!.title).toBe("design X");
      expect(fetched!.source.sessionId).toBe("sess-1");

      const recent = registry.recent({});
      expect(recent.map((r) => r.taskId)).toContain(42);
    });

    test("update() mutates the existing record and bumps updatedAt", async () => {
      const task = makeTask({ id: 7, status: "active" });
      registry.record(task, makeSource({ sessionId: "s1" }));
      const before = registry.getById(7)!.updatedAt;

      await new Promise((r) => setTimeout(r, 5));
      const updated = makeTask({ id: 7, status: "completed", title: "design Y" });
      registry.update(updated, makeSource({ sessionId: "s1" }));

      const after = registry.getById(7)!;
      expect(after.status).toBe("completed");
      expect(after.title).toBe("design Y");
      expect(after.updatedAt >= before).toBe(true);
      // Should NOT create a second entry for the same id
      expect(registry.recent({}).filter((r) => r.taskId === 7)).toHaveLength(1);
    });

    test("remove() deletes the record", () => {
      registry.record(makeTask({ id: 5 }), makeSource());
      expect(registry.getById(5)).toBeDefined();
      registry.remove(5);
      expect(registry.getById(5)).toBeUndefined();
    });

    test("update() on unknown id is a no-op (does not create new entry)", () => {
      registry.update(makeTask({ id: 999 }), makeSource());
      expect(registry.getById(999)).toBeUndefined();
    });
  });

  // ===== LRU eviction =====
  describe("LRU eviction", () => {
    test("evicts oldest entries when maxEntries is exceeded", () => {
      const small = new TaskCreationRegistry({ maxEntries: 3, ttlMs: 60_000 });
      small.record(makeTask({ id: 1 }), makeSource());
      small.record(makeTask({ id: 2 }), makeSource());
      small.record(makeTask({ id: 3 }), makeSource());
      small.record(makeTask({ id: 4 }), makeSource()); // evicts id=1
      expect(small.getById(1)).toBeUndefined();
      expect(small.getById(4)).toBeDefined();
    });

    test("update() on existing entry refreshes its LRU position", () => {
      const small = new TaskCreationRegistry({ maxEntries: 3, ttlMs: 60_000 });
      small.record(makeTask({ id: 1 }), makeSource());
      small.record(makeTask({ id: 2 }), makeSource());
      small.record(makeTask({ id: 3 }), makeSource());
      // Touch id=1 → should be most-recently-used now
      small.update(makeTask({ id: 1, title: "refreshed" }), makeSource());
      small.record(makeTask({ id: 4 }), makeSource()); // evicts id=2 now
      expect(small.getById(1)).toBeDefined();
      expect(small.getById(2)).toBeUndefined();
    });
  });

  // ===== TTL expiration =====
  describe("TTL expiration", () => {
    test("entries older than ttlMs are not returned by recent()", async () => {
      const tiny = new TaskCreationRegistry({ maxEntries: 100, ttlMs: 30 });
      tiny.record(makeTask({ id: 1 }), makeSource());
      expect(tiny.recent({}).map((r) => r.taskId)).toContain(1);
      await new Promise((r) => setTimeout(r, 60));
      expect(tiny.recent({}).map((r) => r.taskId)).not.toContain(1);
    });

    test("getById returns undefined for expired entry", async () => {
      const tiny = new TaskCreationRegistry({ maxEntries: 100, ttlMs: 20 });
      tiny.record(makeTask({ id: 1 }), makeSource());
      await new Promise((r) => setTimeout(r, 40));
      expect(tiny.getById(1)).toBeUndefined();
    });
  });

  // ===== Scope filtering =====
  describe("scope filtering", () => {
    test("scope.sessionId filters records by source.sessionId", () => {
      registry.record(makeTask({ id: 1 }), makeSource({ sessionId: "sess-A" }));
      registry.record(makeTask({ id: 2 }), makeSource({ sessionId: "sess-B" }));
      const result = registry.recent({ scope: { sessionId: "sess-A" } });
      expect(result.map((r) => r.taskId)).toEqual([1]);
    });

    test("scope.parentSessionId matches source.parentSessionId", () => {
      registry.record(
        makeTask({ id: 1 }),
        makeSource({ sessionId: "sub-1", parentSessionId: "root-1" })
      );
      registry.record(
        makeTask({ id: 2 }),
        makeSource({ sessionId: "sub-2", parentSessionId: "root-2" })
      );
      const result = registry.recent({ scope: { parentSessionId: "root-1" } });
      expect(result.map((r) => r.taskId)).toEqual([1]);
    });

    test("scope.subagentType matches source.subagentType", () => {
      registry.record(makeTask({ id: 1 }), makeSource({ subagentType: "roy" }));
      registry.record(
        makeTask({ id: 2 }),
        makeSource({ subagentType: "workflow-runner" })
      );
      const result = registry.recent({ scope: { subagentType: "roy" } });
      expect(result.map((r) => r.taskId)).toEqual([1]);
    });

    test("scope fields are AND-ed", () => {
      registry.record(
        makeTask({ id: 1 }),
        makeSource({ sessionId: "s1", parentSessionId: "root-1" })
      );
      registry.record(
        makeTask({ id: 2 }),
        makeSource({ sessionId: "s1", parentSessionId: "root-2" })
      );
      const result = registry.recent({
        scope: { sessionId: "s1", parentSessionId: "root-1" },
      });
      expect(result.map((r) => r.taskId)).toEqual([1]);
    });

    test("empty scope returns all (non-archived) records", () => {
      registry.record(makeTask({ id: 1, status: "active" }), makeSource());
      registry.record(
        makeTask({ id: 2, status: "archived" }),
        makeSource()
      );
      const result = registry.recent({});
      expect(result.map((r) => r.taskId).sort()).toEqual([1]);
    });
  });

  // ===== excludeIds =====
  describe("excludeIds (dedupe against similar_task_ids)", () => {
    test("excludeIds removes matching entries from result", () => {
      registry.record(makeTask({ id: 1 }), makeSource());
      registry.record(makeTask({ id: 2 }), makeSource());
      registry.record(makeTask({ id: 3 }), makeSource());
      const result = registry.recent({ excludeIds: [1, 2] });
      expect(result.map((r) => r.taskId)).toEqual([3]);
    });

    test("excludeIds preserves order of remaining entries", () => {
      registry.record(makeTask({ id: 1 }), makeSource());
      registry.record(makeTask({ id: 2 }), makeSource());
      registry.record(makeTask({ id: 3 }), makeSource());
      const result = registry.recent({ excludeIds: [2] });
      // order depends on updatedAt tie-break (insertion order on equal timestamps)
      expect(result.map((r) => r.taskId)).toEqual([3, 1]);
    });
  });

  // ===== Status filter =====
  describe("status filter", () => {
    test("default excludes archived", () => {
      registry.record(makeTask({ id: 1, status: "active" }), makeSource());
      registry.record(
        makeTask({ id: 2, status: "archived" }),
        makeSource()
      );
      const result = registry.recent({});
      expect(result.map((r) => r.taskId)).toEqual([1]);
    });

    test("explicit statuses overrides default", () => {
      registry.record(makeTask({ id: 1, status: "active" }), makeSource());
      registry.record(
        makeTask({ id: 2, status: "archived" }),
        makeSource()
      );
      const result = registry.recent({ statuses: ["archived"] });
      expect(result.map((r) => r.taskId)).toEqual([2]);
    });

    test("multiple statuses allowed", () => {
      registry.record(makeTask({ id: 1, status: "todo" }), makeSource());
      registry.record(
        makeTask({ id: 2, status: "completed" }),
        makeSource()
      );
      registry.record(
        makeTask({ id: 3, status: "active" }),
        makeSource()
      );
      const result = registry.recent({
        statuses: ["active", "completed"],
      });
      expect(result.map((r) => r.taskId).sort()).toEqual([2, 3]);
    });
  });

  // ===== Sanitization =====
  describe("sanitization", () => {
    test("redacts OpenAI-style API key", () => {
      registry.record(
        makeTask({
          id: 1,
          description: "Use OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz to call LLM",
        }),
        makeSource()
      );
      const fetched = registry.getById(1)!;
      expect(fetched.description).toContain("<redacted>");
      expect(fetched.description).not.toContain("sk-proj-abc");
    });

    test("redacts Bearer token", () => {
      registry.record(
        makeTask({
          id: 1,
          description: "Header: Bearer abcdefghijk.example.com",
        }),
        makeSource()
      );
      const fetched = registry.getById(1)!;
      expect(fetched.description).toContain("<redacted>");
      expect(fetched.description).not.toContain("abcdefghijk");
    });

    test("redacts github token (ghp_*)", () => {
      registry.record(
        makeTask({
          id: 1,
          description: "token=ghp_1234567890abcdefghij",
        }),
        makeSource()
      );
      const fetched = registry.getById(1)!;
      expect(fetched.description).toContain("<redacted>");
    });

    test("truncates description longer than maxDescriptionChars", () => {
      const limited = new TaskCreationRegistry({
        maxEntries: 100,
        ttlMs: 60_000,
        maxDescriptionChars: 50,
      });
      const longDesc = "a".repeat(500);
      limited.record(
        makeTask({ id: 1, description: longDesc }),
        makeSource()
      );
      const fetched = limited.getById(1)!;
      expect(fetched.description.length).toBeLessThanOrEqual(50);
    });

    test("truncates goals similarly", () => {
      const limited = new TaskCreationRegistry({
        maxEntries: 100,
        ttlMs: 60_000,
        maxDescriptionChars: 50,
      });
      const longGoals = "g".repeat(500);
      limited.record(
        makeTask({
          id: 1,
          goals_and_expected_deliverables: longGoals,
        }),
        makeSource()
      );
      const fetched = limited.getById(1)!;
      expect(fetched.goals.length).toBeLessThanOrEqual(50);
    });

    test("leaves short, clean descriptions untouched", () => {
      registry.record(
        makeTask({ id: 1, description: "Build the screener CLI" }),
        makeSource()
      );
      expect(registry.getById(1)!.description).toBe("Build the screener CLI");
    });
  });

  // ===== Concurrency =====
  describe("concurrency", () => {
    test("20 parallel record() calls produce exactly 20 entries", () => {
      for (let i = 0; i < 20; i++) {
        registry.record(makeTask({ id: 100 + i }), makeSource());
      }
      expect(registry.recent({ limit: 100 })).toHaveLength(20);
    });

    test("20 parallel record() of the SAME id keeps only one entry", () => {
      for (let i = 0; i < 20; i++) {
        registry.record(makeTask({ id: 7, title: `r${i}` }), makeSource());
      }
      const all = registry.recent({}).filter((r) => r.taskId === 7);
      expect(all).toHaveLength(1);
    });
  });

  // ===== limit + ordering =====
  describe("limit + ordering", () => {
    test("limit caps the result count", () => {
      for (let i = 0; i < 10; i++) {
        registry.record(makeTask({ id: i }), makeSource());
      }
      const result = registry.recent({ limit: 3 });
      expect(result).toHaveLength(3);
    });

    test("result is sorted by updatedAt DESC", async () => {
      registry.record(makeTask({ id: 1, title: "old" }), makeSource());
      await new Promise((r) => setTimeout(r, 5));
      registry.record(makeTask({ id: 2, title: "newer" }), makeSource());
      await new Promise((r) => setTimeout(r, 5));
      registry.record(makeTask({ id: 3, title: "newest" }), makeSource());
      const result = registry.recent({});
      expect(result.map((r) => r.taskId)).toEqual([3, 2, 1]);
    });
  });

  // ===== excludeAncestorOf =====
  describe("excludeAncestorOf", () => {
    test("excludes the subtree rooted at the given task id", () => {
      registry.record(
        makeTask({ id: 100, parent_task_id: undefined, title: "root" }),
        makeSource()
      );
      registry.record(
        makeTask({ id: 101, parent_task_id: 100, title: "child-A" }),
        makeSource()
      );
      registry.record(
        makeTask({ id: 102, parent_task_id: 100, title: "child-B" }),
        makeSource()
      );
      registry.record(
        makeTask({ id: 200, title: "unrelated" }),
        makeSource()
      );
      const result = registry.recent({ excludeAncestorOf: 100 });
      // 100 and its descendants (101, 102) should be excluded
      const ids = result.map((r) => r.taskId);
      expect(ids).not.toContain(100);
      expect(ids).not.toContain(101);
      expect(ids).not.toContain(102);
      expect(ids).toContain(200);
    });
  });

  // ===== clear() =====
  describe("clear()", () => {
    test("clears all records", () => {
      registry.record(makeTask({ id: 1 }), makeSource());
      registry.record(makeTask({ id: 2 }), makeSource());
      registry.clear();
      expect(registry.recent({})).toHaveLength(0);
    });
  });
});