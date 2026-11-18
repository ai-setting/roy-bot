/**
 * @fileoverview query_background_process Tool Tests
 *
 * TDD: 测试 query_background_process 内置工具的行为
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 *
 * 验证：
 * - 已存在且 running 的 bgProcessId → alive=true
 * - 已存在且 completed 的 bgProcessId → alive=false + result
 * - 已存在且 failed 的 bgProcessId → alive=false + error
 * - 已存在且 stopped 的 bgProcessId → alive=false (status='stopped')
 * - 已存在且 timeout 的 bgProcessId → alive=false (status='timeout')
 * - 不存在的 bgProcessId → status='not_found' (alive=false)
 * - result 字段在 completed 时返回
 * - error 字段在 failed 时返回
 * - description 字段总是返回
 * - createdAt / lastUpdatedAt 时间戳正确
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import {
  createQueryBackgroundProcessTool,
  queryBackgroundProcessTool,
} from "./query-background-process-tool";
import {
  BackgroundTaskManager,
  type BackgroundTask,
} from "../../task/delegate/delegate-tool";

// ============================================================================
// Mock helpers
// ============================================================================

/**
 * Build a mock BackgroundTaskManager that has only the methods needed by the tool.
 * Avoids pulling in env/session/agent for unit-testing the tool in isolation.
 */
function buildMockManager(initialTasks: BackgroundTask[] = []): BackgroundTaskManager {
  const tasks = new Map<string, BackgroundTask>();
  for (const t of initialTasks) {
    tasks.set(t.id, { ...t });
  }

  const manager = {
    getTask: (taskId: string): BackgroundTask | undefined => {
      const t = tasks.get(taskId);
      if (!t) return undefined;
      // Return a clone so the tool cannot mutate the mock state
      return { ...t };
    },
    listTasks: (): BackgroundTask[] => Array.from(tasks.values()).map((t) => ({ ...t })),
  } as unknown as BackgroundTaskManager;

  return manager;
}

// ============================================================================
// Tests
// ============================================================================

describe("query_background_process tool", () => {
  // Note: No beforeEach/afterEach needed because manager is now bound per-tool
  // via the factory function (no module-global state to reset).

  describe("tool definition", () => {
    test("name should be 'query_background_process'", () => {
      expect(queryBackgroundProcessTool.name).toBe("query_background_process");
    });

    test("should accept bgProcessId parameter", () => {
      const shape = queryBackgroundProcessTool.parameters.shape as { bgProcessId: z.ZodString };
      expect(shape.bgProcessId).toBeDefined();
    });

    test("description should mention background process", () => {
      expect(queryBackgroundProcessTool.description).toContain("background process");
    });

    test("metadata.allowedAgentTypes should include 'default'", () => {
      expect(queryBackgroundProcessTool.metadata?.allowedAgentTypes).toContain("default");
    });

    test("should be a safe-level tool (read-only)", () => {
      expect(queryBackgroundProcessTool.permission?.level).toBe("safe");
    });

    test("factory and named-export should produce equivalent tools", () => {
      // The named export is built lazily — both should have the same name
      const factoryTool = createQueryBackgroundProcessTool();
      expect(factoryTool.name).toBe(queryBackgroundProcessTool.name);
    });
  });

  describe("execute: running task", () => {
    test("should return alive=true with status='running' and no result/error", async () => {
      const now = Date.now();
      const runningTask: BackgroundTask = {
        id: "process_running",
        subSessionId: "sub_1",
        parentSessionId: "parent_1",
        description: "long-running task",
        subagentType: "roy",
        status: "running",
        createdAt: now - 60_000,
        startedAt: now - 50_000,
        lastUpdatedAt: now - 1_000,
      };
      const tool = createQueryBackgroundProcessTool(
        buildMockManager([runningTask]),
      );

      const result = await tool.execute(
        { bgProcessId: "process_running" },
        { session_id: "parent_1" } as any,
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.alive).toBe(true);
      expect(parsed.status).toBe("running");
      expect(parsed.createdAt).toBe(now - 60_000);
      expect(parsed.lastUpdatedAt).toBe(now - 1_000);
      expect(parsed.description).toBe("long-running task");
      expect(parsed.result).toBeUndefined();
      expect(parsed.error).toBeUndefined();
    });
  });

  describe("execute: completed task", () => {
    test("should return alive=false with status='completed' and result", async () => {
      const now = Date.now();
      const completedTask: BackgroundTask = {
        id: "process_completed",
        subSessionId: "sub_2",
        parentSessionId: "parent_1",
        description: "done task",
        subagentType: "roy",
        status: "completed",
        createdAt: now - 120_000,
        startedAt: now - 115_000,
        completedAt: now - 10_000,
        lastUpdatedAt: now - 10_000,
        result: "task result string",
      };
      const tool = createQueryBackgroundProcessTool(
        buildMockManager([completedTask]),
      );

      const result = await tool.execute(
        { bgProcessId: "process_completed" },
        { session_id: "parent_1" } as any,
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.alive).toBe(false);
      expect(parsed.status).toBe("completed");
      expect(parsed.result).toBe("task result string");
      expect(parsed.error).toBeUndefined();
      expect(parsed.lastUpdatedAt).toBe(now - 10_000);
    });
  });

  describe("execute: failed task", () => {
    test("should return alive=false with status='failed' and error", async () => {
      const now = Date.now();
      const failedTask: BackgroundTask = {
        id: "process_failed",
        subSessionId: "sub_3",
        parentSessionId: "parent_1",
        description: "errored task",
        subagentType: "roy",
        status: "failed",
        createdAt: now - 30_000,
        startedAt: now - 25_000,
        completedAt: now - 5_000,
        lastUpdatedAt: now - 5_000,
        error: "boom — null pointer",
      };
      const tool = createQueryBackgroundProcessTool(
        buildMockManager([failedTask]),
      );

      const result = await tool.execute(
        { bgProcessId: "process_failed" },
        { session_id: "parent_1" } as any,
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.alive).toBe(false);
      expect(parsed.status).toBe("failed");
      expect(parsed.error).toBe("boom — null pointer");
      expect(parsed.result).toBeUndefined();
    });
  });

  describe("execute: stopped task", () => {
    test("should return alive=false with status='stopped'", async () => {
      const now = Date.now();
      const stoppedTask: BackgroundTask = {
        id: "process_stopped",
        subSessionId: "sub_4",
        parentSessionId: "parent_1",
        description: "manually stopped",
        subagentType: "roy",
        status: "stopped",
        createdAt: now - 20_000,
        startedAt: now - 15_000,
        completedAt: now - 2_000,
        lastUpdatedAt: now - 2_000,
      };
      const tool = createQueryBackgroundProcessTool(
        buildMockManager([stoppedTask]),
      );

      const result = await tool.execute(
        { bgProcessId: "process_stopped" },
        { session_id: "parent_1" } as any,
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.alive).toBe(false);
      expect(parsed.status).toBe("stopped");
    });
  });

  describe("execute: timeout task", () => {
    test("should return alive=false with status='timeout'", async () => {
      const now = Date.now();
      const timeoutTask: BackgroundTask = {
        id: "process_timeout",
        subSessionId: "sub_5",
        parentSessionId: "parent_1",
        description: "timed out task",
        subagentType: "roy",
        status: "timeout",
        createdAt: now - 600_000,
        startedAt: now - 590_000,
        completedAt: now - 580_000,
        lastUpdatedAt: now - 580_000,
      };
      const tool = createQueryBackgroundProcessTool(
        buildMockManager([timeoutTask]),
      );

      const result = await tool.execute(
        { bgProcessId: "process_timeout" },
        { session_id: "parent_1" } as any,
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.alive).toBe(false);
      expect(parsed.status).toBe("timeout");
    });
  });

  describe("execute: pending task", () => {
    test("should return alive=true with status='pending' (not yet started)", async () => {
      const now = Date.now();
      const pendingTask: BackgroundTask = {
        id: "process_pending",
        subSessionId: "sub_6",
        parentSessionId: "parent_1",
        description: "just created",
        subagentType: "roy",
        status: "pending",
        createdAt: now - 100,
        lastUpdatedAt: now - 100,
      };
      const tool = createQueryBackgroundProcessTool(
        buildMockManager([pendingTask]),
      );

      const result = await tool.execute(
        { bgProcessId: "process_pending" },
        { session_id: "parent_1" } as any,
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.alive).toBe(true);
      expect(parsed.status).toBe("pending");
    });
  });

  describe("execute: not_found task", () => {
    test("should return alive=false with status='not_found'", async () => {
      const tool = createQueryBackgroundProcessTool(buildMockManager([]));

      const result = await tool.execute(
        { bgProcessId: "process_nonexistent" },
        { session_id: "parent_1" } as any,
      );

      // not_found is a normal answer, not a tool failure
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.alive).toBe(false);
      expect(parsed.status).toBe("not_found");
      expect(parsed.error).toBeUndefined();
      expect(parsed.result).toBeUndefined();
    });
  });

  describe("execute: missing manager injection", () => {
    test("should return success=false with informative error when manager is null", async () => {
      // No manager passed to factory → tool has null manager
      const tool = createQueryBackgroundProcessTool(null);

      const result = await tool.execute(
        { bgProcessId: "process_any" },
        { session_id: "parent_1" } as any,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });
  });

  describe("execute: schema validation", () => {
    test("should reject empty bgProcessId via schema", async () => {
      const tool = createQueryBackgroundProcessTool(buildMockManager([]));

      // Empty string is invalid per zod schema (min 1)
      await expect(
        tool.execute({ bgProcessId: "" }, {} as any),
      ).rejects.toThrow();
    });

    test("should reject missing bgProcessId via schema", async () => {
      const tool = createQueryBackgroundProcessTool(buildMockManager([]));

      await expect(
        // @ts-expect-error — intentionally missing required field
        tool.execute({}, {} as any),
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // High #1: Tool factory pattern (env-scoped BackgroundTaskManager injection)
  // ==========================================================================
  // Goal: each Environment/TaskComponent owns its own manager; no module-global
  //       state, so two Environments with two TaskComponents do not share or
  //       overwrite each other's manager.
  //
  // Tests verify:
  // - createQueryBackgroundProcessTool(manager) returns a Tool whose execute()
  //   uses the passed-in manager (closure)
  // - Two factory calls with different managers produce two independent tools
  // - Passing null makes the tool fail with "not initialized"
  // ==========================================================================
  describe("tool factory (env-scoped manager injection)", () => {
    test("createQueryBackgroundProcessTool(manager) should return a Tool bound to that manager", async () => {
      const task: BackgroundTask = {
        id: "process_factory_001",
        subSessionId: "sub_factory",
        parentSessionId: "parent_factory",
        description: "factory bound task",
        subagentType: "roy",
        status: "running",
        createdAt: 1000,
        startedAt: 2000,
        lastUpdatedAt: 2000,
      };
      const manager = buildMockManager([task]);
      const tool = createQueryBackgroundProcessTool(manager);

      expect(tool.name).toBe("query_background_process");
      const result = await tool.execute(
        { bgProcessId: "process_factory_001" },
        { session_id: "parent_factory" } as any,
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.description).toBe("factory bound task");
      expect(parsed.status).toBe("running");
    });

    test("two factory calls with different managers should be isolated", async () => {
      const taskA: BackgroundTask = {
        id: "process_a",
        subSessionId: "sub_a",
        parentSessionId: "parent_a",
        description: "from manager A",
        subagentType: "roy",
        status: "running",
        createdAt: 1,
        startedAt: 2,
        lastUpdatedAt: 2,
      };
      const taskB: BackgroundTask = {
        id: "process_b",
        subSessionId: "sub_b",
        parentSessionId: "parent_b",
        description: "from manager B",
        subagentType: "roy",
        status: "completed",
        createdAt: 1,
        completedAt: 3,
        lastUpdatedAt: 3,
        result: "B's output",
      };
      const managerA = buildMockManager([taskA]);
      const managerB = buildMockManager([taskB]);
      const toolA = createQueryBackgroundProcessTool(managerA);
      const toolB = createQueryBackgroundProcessTool(managerB);

      // Tool A only sees process_a (use parent_a session to pass ownership check)
      const resA = await toolA.execute(
        { bgProcessId: "process_a" },
        { session_id: "parent_a" } as any,
      );
      expect(JSON.parse(resA.output as string).description).toBe("from manager A");
      const resAMissing = await toolA.execute(
        { bgProcessId: "process_b" },
        { session_id: "parent_a" } as any,
      );
      expect(JSON.parse(resAMissing.output as string).status).toBe("not_found");

      // Tool B only sees process_b (use parent_b session)
      const resB = await toolB.execute(
        { bgProcessId: "process_b" },
        { session_id: "parent_b" } as any,
      );
      expect(JSON.parse(resB.output as string).description).toBe("from manager B");
      const resBMissing = await toolB.execute(
        { bgProcessId: "process_a" },
        { session_id: "parent_b" } as any,
      );
      expect(JSON.parse(resBMissing.output as string).status).toBe("not_found");
    });

    test("createQueryBackgroundProcessTool(null) should produce a tool that fails with 'not initialized'", async () => {
      const tool = createQueryBackgroundProcessTool(null);
      const result = await tool.execute({ bgProcessId: "process_any" }, {} as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });

    test("createQueryBackgroundProcessTool() with no argument should also produce a 'not initialized' tool", async () => {
      // No-arg call → default null manager
      const tool = createQueryBackgroundProcessTool();
      const result = await tool.execute({ bgProcessId: "process_any" }, {} as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });
  });

  // ==========================================================================
  // High #2: Session ownership check (security — prevent cross-session reads)
  // ==========================================================================
  // Goal: a session must only be able to read background processes it owns.
  //       If session B holds a real bgProcessId from session A, it should see
  //       not_found (so existence is not leaked).
  //
  // Tests verify:
  // - Same session → task data is returned
  // - Different session → not_found (NOT the actual data)
  // - Missing session_id in context → not_found (fail-safe)
  // - Sessions are matched strictly (no prefix or substring matching)
  // ==========================================================================
  describe("session ownership check", () => {
    function buildManagerWithSessionTask(): BackgroundTaskManager {
      const task: BackgroundTask = {
        id: "process_owned_by_sessionA",
        subSessionId: "sub_owned",
        parentSessionId: "sessionA",
        description: "task owned by session A",
        subagentType: "roy",
        status: "running",
        createdAt: 1000,
        startedAt: 2000,
        lastUpdatedAt: 2000,
      };
      return buildMockManager([task]);
    }

    test("matching session_id should return task data", async () => {
      const manager = buildManagerWithSessionTask();
      const tool = createQueryBackgroundProcessTool(manager);
      const result = await tool.execute(
        { bgProcessId: "process_owned_by_sessionA" },
        { session_id: "sessionA" } as any,
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.status).toBe("running");
      expect(parsed.description).toBe("task owned by session A");
    });

    test("non-matching session_id should return not_found (no existence leak)", async () => {
      const manager = buildManagerWithSessionTask();
      const tool = createQueryBackgroundProcessTool(manager);
      const result = await tool.execute(
        { bgProcessId: "process_owned_by_sessionA" },
        { session_id: "sessionB" } as any,
      );
      // success=true but status=not_found — exactly like a truly missing ID
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.status).toBe("not_found");
      expect(parsed.alive).toBe(false);
      // Description should NOT include the real task description
      expect(parsed.description).not.toBe("task owned by session A");
    });

    test("missing session_id in context should return not_found (fail-safe)", async () => {
      const manager = buildManagerWithSessionTask();
      const tool = createQueryBackgroundProcessTool(manager);
      // No session_id in ctx
      const result = await tool.execute(
        { bgProcessId: "process_owned_by_sessionA" },
        {} as any,
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.status).toBe("not_found");
    });

    test("session_id is matched strictly (substring of A does not match A)", async () => {
      const manager = buildManagerWithSessionTask();
      const tool = createQueryBackgroundProcessTool(manager);
      // "session" is a substring of "sessionA" but should not match
      const result = await tool.execute(
        { bgProcessId: "process_owned_by_sessionA" },
        { session_id: "session" } as any,
      );
      const parsed = JSON.parse(result.output as string);
      expect(parsed.status).toBe("not_found");
    });
  });

  describe("legacy task timestamp compatibility", () => {
    test("accepts a BackgroundTask without lastUpdatedAt and falls back to completedAt", async () => {
      const legacyTask: BackgroundTask = {
        id: "process_legacy_timestamp",
        subSessionId: "sub_legacy",
        parentSessionId: "parent_legacy",
        description: "legacy task without the newer timestamp field",
        subagentType: "roy",
        status: "completed",
        createdAt: 1_000,
        startedAt: 2_000,
        completedAt: 3_000,
        result: "legacy result",
      };
      const tool = createQueryBackgroundProcessTool(
        buildMockManager([legacyTask]),
      );

      const result = await tool.execute(
        { bgProcessId: legacyTask.id },
        { session_id: legacyTask.parentSessionId } as any,
      );

      expect(result.success).toBe(true);
      expect(JSON.parse(result.output as string)).toMatchObject({
        status: "completed",
        lastUpdatedAt: 3_000,
        result: "legacy result",
      });
    });
  });
});
