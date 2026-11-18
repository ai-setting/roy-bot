/**
 * @fileoverview compact_session Tool Tests (TDD RED)
 *
 * Task #4982 — Default agent 专用工具：压缩 sub-session 并继续复用。
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 *
 * 验证目标：
 * - 工具定义（name / allowedAgentTypes=["default"] / category）
 * - 成功路径：ownership 通过 → hint + compact 被调 → JSON 摘要返回
 * - 安全分支：
 *   1. deps 未注入 → success=false, error="not initialized"
 *   2. 压缩当前会话 → success=false（防止 default agent 自毁上下文）
 *   3. session 不存在 / 非自己的 sub-session → status='not_found'
 *      （不暴露存在性，与 query_background_process 同一哲学）
 *   4. 后台任务仍在 running/pending → success=false（增量落盘竞态）
 *   5. 可压缩消息 < 3 → success=false
 * - hint 失败不阻塞（generateCompactHint 抛错 → compact 仍执行）
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { createCompactSessionTool } from "./compact-session-tool";
import type { BackgroundTask } from "../../task/delegate/delegate-tool";

// ============================================================================
// Mock helpers
// ============================================================================

interface MockDeps {
  backgroundTaskManager: {
    getTask: (id: string) => BackgroundTask | undefined;
    listTasks: () => BackgroundTask[];
  } | null;
  sessionComponent: {
    get: (id: string) => Promise<any>;
    previewCompact: (id: string) => Promise<{ messageCountToCompact: number; estimatedCheckpointTokens: number; wouldTrigger: boolean }>;
    generateCompactHint: (id: string) => Promise<string>;
    compact: (id: string, options?: { scenarioHint?: string }) => Promise<any>;
    pushEnvEvent?: never;
  } | null;
}

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  const now = Date.now();
  return {
    id: "process_1",
    subSessionId: "sub_1",
    parentSessionId: "parent_1",
    description: "long-running task",
    subagentType: "roy",
    status: "completed",
    createdAt: now - 60_000,
    startedAt: now - 50_000,
    lastUpdatedAt: now - 1_000,
    ...overrides,
  } as BackgroundTask;
}

/** 成功 compact 的标准返回 */
function makeCompactResult(messages = 30) {
  return {
    checkpoint: {
      id: "cp_test_123",
      messageIndex: 0,
      title: "Checkpoint: feature work",
      content: "This checkpoint summarizes the work...",
      messageCountBefore: messages,
      createdAt: Date.now(),
      type: "compact",
    },
    deletedMessageCount: messages - 1,
    remainingMessageCount: 1,
    checkpointCount: 1,
  };
}

function buildDeps(opts: {
  tasks?: BackgroundTask[];
  compactError?: Error;
  hintError?: Error;
  compactResult?: any;
  sessionExists?: boolean;
} = {}): MockDeps {
  const tasksMap = new Map<string, BackgroundTask>();
  for (const t of opts.tasks ?? []) tasksMap.set(t.id, t);
  // index by subSessionId too, so ownership check can find tasks
  const subSessionIndex = new Map<string, BackgroundTask>();
  for (const t of opts.tasks ?? []) subSessionIndex.set(t.subSessionId, t);

  return {
    backgroundTaskManager: {
      getTask: (id: string) => {
        const t = tasksMap.get(id) ?? subSessionIndex.get(id);
        return t ? { ...t } : undefined;
      },
      listTasks: () => Array.from(tasksMap.values()).map((t) => ({ ...t })),
    },
    sessionComponent: {
      get: async (id: string) =>
        opts.sessionExists === false ? undefined : {
          id,
          messageCount: 30,
          metadata: { created_by: "subagent" },
          updatedAt: Date.now(),
        },
      previewCompact: async () => ({
        messageCountToCompact: 30,
        estimatedCheckpointTokens: 800,
        wouldTrigger: true,
      }),
      generateCompactHint: async () => {
        if (opts.hintError) throw opts.hintError;
        return "Focus points: TDD, safety checks";
      },
      compact: async () => {
        if (opts.compactError) throw opts.compactError;
        return opts.compactResult ?? makeCompactResult();
      },
    },
  } as unknown as MockDeps;
}

const parentCtx = { session_id: "parent_1" } as any;

// ============================================================================
// Tool definition
// ============================================================================

describe("compact_session tool definition", () => {
  test("no-deps default instance should exist with correct name", async () => {
    const { compactSessionTool } = await import("./compact-session-tool");
    expect(compactSessionTool.name).toBe("compact_session");
    // No-deps instance must refuse execution (not initialized)
    const result = await compactSessionTool.execute(
      { session_id: "sub_1" },
      parentCtx,
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("not initialized");
  });

  test("should accept session_id parameter only", () => {
    const tool = createCompactSessionTool(null, null);
    const shape = tool.parameters.shape as { session_id: z.ZodString };
    expect(shape.session_id).toBeDefined();
    expect(shape.subSessionId).toBeUndefined();
  });

  test("metadata.allowedAgentTypes should be ['default'] only", () => {
    const tool = createCompactSessionTool(null, null);
    expect(tool.metadata?.allowedAgentTypes).toEqual(["default"]);
  });

  test("should be categorized as task/session tool", () => {
    const tool = createCompactSessionTool(null, null);
    expect(tool.metadata?.category).toBe("task");
    expect(tool.metadata?.tags).toContain("compact");
    expect(tool.metadata?.tags).toContain("session");
  });

  test("description should mention reuse via delegate_task sub_session_id", () => {
    const tool = createCompactSessionTool(null, null);
    expect(tool.description).toContain("delegate_task");
    expect(tool.description).toContain("sub_session_id");
  });
});

// ============================================================================
// Success path
// ============================================================================

describe("compact_session success path", () => {
  test("should compact own completed sub-session and return summary JSON", async () => {
    const deps = buildDeps({ tasks: [makeTask()] });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute({ session_id: "sub_1" }, parentCtx);

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string);
    expect(parsed.status).toBe("compacted");
    expect(parsed.sessionId).toBe("sub_1");
    expect(parsed.checkpointId).toBe("cp_test_123");
    expect(parsed.originalMessages).toBe(30);
    expect(parsed.deletedMessages).toBe(29);
    expect(parsed.remainingMessages).toBe(1);
    expect(parsed.checkpointTitle).toContain("Checkpoint");
    expect(parsed.contentLength).toBeGreaterThan(0);
  });

  test("should pass scenarioHint from generateCompactHint into compact", async () => {
    let capturedOptions: { scenarioHint?: string } | undefined;
    const deps = buildDeps({ tasks: [makeTask()] });
    // Spy on compact options
    const spyCompact = async (id: string, options?: { scenarioHint?: string }) => {
      capturedOptions = options;
      return makeCompactResult();
    };
    (deps.sessionComponent as any).compact = spyCompact;

    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );
    await tool.execute({ session_id: "sub_1" }, parentCtx);

    expect(capturedOptions?.scenarioHint).toContain("Focus points");
  });

  test("hint failure should NOT block compaction (hint is optional)", async () => {
    const deps = buildDeps({
      tasks: [makeTask()],
      hintError: new Error("hint agent failed"),
    });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute({ session_id: "sub_1" }, parentCtx);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string);
    expect(parsed.status).toBe("compacted");
  });
});

// ============================================================================
// Safety: initialization
// ============================================================================

describe("compact_session safety: initialization", () => {
  test("null manager → success=false with not-initialized error", async () => {
    const deps = buildDeps({ tasks: [makeTask()] });
    const tool = createCompactSessionTool(
      null,
      deps.sessionComponent as any,
    );
    const result = await tool.execute({ session_id: "sub_1" }, parentCtx);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("not initialized");
  });

  test("null sessionComponent → success=false with not-initialized error", async () => {
    const deps = buildDeps({ tasks: [makeTask()] });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      null,
    );
    const result = await tool.execute({ session_id: "sub_1" }, parentCtx);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("not initialized");
  });
});

// ============================================================================
// Safety: self-compaction guard
// ============================================================================

describe("compact_session safety: self-compaction", () => {
  test("compressing the CURRENT session must be refused (self-destruction guard)", async () => {
    const deps = buildDeps({ tasks: [makeTask()] });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    // Default agent compressing its own session
    const result = await tool.execute(
      { session_id: "parent_1" },
      { session_id: "parent_1" } as any,
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("OWN current session");
  });

  test("missing ctx.session_id must be refused (cannot verify ownership)", async () => {
    const deps = buildDeps({ tasks: [makeTask()] });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute({ session_id: "sub_1" }, {} as any);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Safety: ownership (not_found semantics — do not leak existence)
// ============================================================================

describe("compact_session safety: ownership", () => {
  test("unknown session_id → status='not_found', success=true", async () => {
    const deps = buildDeps({ tasks: [] });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute(
      { session_id: "session_unknown" },
      parentCtx,
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string);
    expect(parsed.status).toBe("not_found");
  });

  test("session that is NOT own sub-session → status='not_found'", async () => {
    // Task exists but belongs to a different parent session
    const foreignTask = makeTask({
      id: "process_foreign",
      subSessionId: "sub_foreign",
      parentSessionId: "parent_OTHER",
    });
    const deps = buildDeps({ tasks: [foreignTask] });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute(
      { session_id: "sub_foreign" },
      parentCtx,
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string);
    expect(parsed.status).toBe("not_found");
  });

  test("not_found output should NOT include checkpoint fields", async () => {
    const deps = buildDeps({ tasks: [] });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute(
      { session_id: "session_unknown" },
      parentCtx,
    );
    const parsed = JSON.parse(result.output as string);
    expect(parsed.checkpointId).toBeUndefined();
  });
});

// ============================================================================
// Safety: running task guard
// ============================================================================

describe("compact_session safety: running task", () => {
  test("running sub-session → success=false with clear reason (not not_found)", async () => {
    const runningTask = makeTask({
      id: "process_running",
      subSessionId: "sub_1",
      status: "running",
    });
    const deps = buildDeps({ tasks: [runningTask] });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute({ session_id: "sub_1" }, parentCtx);
    expect(result.success).toBe(false);
    // Must be a real refusal, not a silent not_found
    const combined = `${result.error ?? ""}${result.output ?? ""}`;
    expect(combined).toContain("running");
    expect(combined).toContain("stop_task");
  });

  test("pending sub-session → same refusal as running", async () => {
    const pendingTask = makeTask({
      id: "process_pending",
      subSessionId: "sub_1",
      status: "pending",
    });
    const deps = buildDeps({ tasks: [pendingTask] });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute({ session_id: "sub_1" }, parentCtx);
    expect(result.success).toBe(false);
    const combined = `${result.error ?? ""}${result.output ?? ""}`;
    expect(combined).toContain("stop_task");
  });
});

// ============================================================================
// Safety: minimum messages
// ============================================================================

describe("compact_session safety: minimum messages", () => {
  test("session with < 3 compactable messages → success=false", async () => {
    const deps = buildDeps({ tasks: [makeTask()] });
    (deps.sessionComponent as any).previewCompact = async () => ({
      messageCountToCompact: 2,
      estimatedCheckpointTokens: 40,
      wouldTrigger: false,
    });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute({ session_id: "sub_1" }, parentCtx);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("minimum");
  });
});

// ============================================================================
// Error handling: compact failure
// ============================================================================

describe("compact_session error handling", () => {
  test("sessionComponent.compact throwing → success=false with error message", async () => {
    const deps = buildDeps({
      tasks: [makeTask()],
      compactError: new Error("compact agent returned no usable checkpoint output"),
    });
    const tool = createCompactSessionTool(
      deps.backgroundTaskManager as any,
      deps.sessionComponent as any,
    );

    const result = await tool.execute({ session_id: "sub_1" }, parentCtx);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("compact");
  });
});
