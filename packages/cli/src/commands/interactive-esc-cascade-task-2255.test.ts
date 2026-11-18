/**
 * @fileoverview REPL.handleEscKey ESC cascade — Task #2255 RED tests
 *
 * 覆盖 Task #2245 RED tests 没覆盖的关键场景：
 * **主 REPL LLM 已返回（isExecuting=false），但 parent session tree 下仍有
 * active background task / workflow descendant 在运行时，按 ESC 应该 cascade stop。**
 *
 * 旧逻辑（interactive.ts:1027 `if (!isExecuting) return;`）会静默拦截 ESC，
 * 导致用户感觉"按 ESC 没反应" + 子 session 永远在跑。
 *
 * 新设计（Task #2255 选项 A）：
 * - ESC 在以下任一情况触发 cascade：
 *   1. isExecuting=true（主 LLM 正在执行，abort + cascade）
 *   2. parent session tree 下有 active background task / workflow descendant
 * - 其他情况（idle 且无 active descendant）保持 no-op，不污染正常 readline
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 * 当前这些 test 必须先 RED（fail），然后修改 handleEscKey 后转 GREEN。
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the cascadeStopSessionTree export from core (must be registered BEFORE
// the dynamic import of REPL below). See interactive-esc-cascade.test.ts for
// the full rationale.
// ---------------------------------------------------------------------------

const cascadeCalls: Array<{ parent: string; opts: any }> = [];

/**
 * Default cascade implementation — used as the canonical mock body.
 * Note: we keep this as a plain function (NOT a mock) and pass it to
 * `mock(...)` so that `mockImplementation(...)` can swap it without
 * creating self-referential recursion.
 */
async function defaultCascadeImpl(_env: any, parent: string, opts: any) {
  cascadeCalls.push({ parent, opts });
  return {
    stoppedTaskIds: ["bgTask_test_1"],
    stoppedWorkflowSessionIds: ["wf_test_1"],
    force: opts?.force ?? false,
    errors: [],
  };
}

const cascadeMock = mock(defaultCascadeImpl);

const __filenameUrl = new URL(import.meta.url).pathname;
const __dirnameUrl = __filenameUrl.substring(0, __filenameUrl.lastIndexOf("/"));
const targetModulePath = new URL(
  "../../../core/src/env/session-tree-stopper.ts",
  `file://${__dirnameUrl}/`,
).pathname;
mock.module(targetModulePath, () => ({
  cascadeStopSessionTree: cascadeMock,
}));

// Now safe to import REPL — it will pull `cascadeStopSessionTree` from the
// mocked source module via the index re-export.
const { REPL } = await import("./run");

// ---------------------------------------------------------------------------
// Helpers — build a REPL with a configurable mock env (BackgroundTaskManager
// state + workflow service state + agent component).
// ---------------------------------------------------------------------------

interface MockEnvOptions {
  /** Active background tasks for parentSessionId. Empty = no active children. */
  activeBackgroundTasks?: Array<{ id: string; status: "running" | "pending" }>;
  /** Active workflow sessions for parentSessionId. */
  activeWorkflowSessions?: Array<{ id: string; status: "running" }>;
  /** If agent abortAll exists. Default: yes. */
  hasAgentAbortAll?: boolean;
}

function buildMockEnv(opts: MockEnvOptions = {}) {
  const activeBgTasks = opts.activeBackgroundTasks ?? [];
  const activeWfSessions = opts.activeWorkflowSessions ?? [];
  const hasAbortAll = opts.hasAgentAbortAll ?? true;

  const mgr = {
    listTasks: mock(() =>
      activeBgTasks.map((t) => ({
        id: t.id,
        parentSessionId: "main_session_idle",
        status: t.status,
      })),
    ),
    hasActiveTaskForParent: mock((parentId: string) =>
      activeBgTasks.some((t) => t.status === "running" || t.status === "pending") &&
      parentId === "main_session_idle",
    ),
  };

  return {
    getComponent: mock((name: string) => {
      if (name === "agent") {
        return hasAbortAll
          ? { abortAll: mock(() => {}), abort: mock(() => {}) }
          : { abort: mock(() => {}) };
      }
      if (name === "task") {
        return {
          getBackgroundTaskManager: mock(() => mgr),
          backgroundTaskManager: mgr,
        };
      }
      if (name === "workflow") {
        return {
          workflowService: {
            listSessions: mock(() =>
              activeWfSessions.map((s) => ({
                id: s.id,
                parentSessionId: "main_session_idle",
                status: s.status,
              })),
            ),
            hasActiveWorkflowForParent: mock((parentId: string) =>
              activeWfSessions.length > 0 && parentId === "main_session_idle",
            ),
          },
        };
      }
      return undefined;
    }),
  };
}

function buildRepl(mockEnv: any) {
  return new REPL(
    {
      sessionId: "main_session_idle",
      sessionTitle: "Test",
      onExecute: mock(() => Promise.resolve("done")),
      onStatus: mock(() => ({
        sessionId: "main_session_idle",
        sessionTitle: "Test",
        messageCount: 0,
        tokenCount: 0,
      })),
      onSwitchSession: mock(() => Promise.resolve({ sessionId: "x", sessionTitle: "y" })),
      onCompact: mock(() => Promise.resolve()),
      onShutdown: mock(() => Promise.resolve()),
    },
    mockEnv,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("REPL.handleEscKey — Task #2255: idle ESC + active descendant (RED)", () => {
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    cascadeCalls.length = 0;
    originalDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  // -------------------------------------------------------------------------
  // Group A — Real bug regression: ESC when isExecuting=false but
  // active background/descendant exists.
  // -------------------------------------------------------------------------

  test("RED-1: ESC when isExecuting=false BUT active background task running → MUST cascade", async () => {
    // 子 session 已创建并跑，主 LLM 已返回，isExecuting=false，
    // BackgroundTaskManager.tasks 里有 running task。
    // 当前实现会早退（bug）。期望：cascade 被调用。
    const env = buildMockEnv({
      activeBackgroundTasks: [{ id: "bg_running_1", status: "running" }],
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = false;

    let now = 1000000;
    Date.now = () => now;

    await (repl as any).handleEscKey();

    await new Promise((r) => setTimeout(r, 20));

    // 关键断言：cascade 必须被调用（这是当前实现失败的断言）
    expect(cascadeCalls).toHaveLength(1);
    expect(cascadeCalls[0].parent).toBe("main_session_idle");
    expect(cascadeCalls[0].opts.force).toBe(false);
  });

  test("RED-2: ESC when isExecuting=false + active workflow descendant → MUST cascade", async () => {
    // 主 session 直接 workflow_run 启动的 workflow 还在跑（不是通过 delegate）。
    // 用户按 ESC 应该 cascade stop。
    const env = buildMockEnv({
      activeWorkflowSessions: [{ id: "wf_running_1", status: "running" }],
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = false;

    await (repl as any).handleEscKey();

    await new Promise((r) => setTimeout(r, 20));

    expect(cascadeCalls.length).toBeGreaterThanOrEqual(1);
    expect(cascadeCalls[0].parent).toBe("main_session_idle");
  });

  test("RED-3: ESC when isExecuting=false + both bg + wf active → MUST cascade", async () => {
    const env = buildMockEnv({
      activeBackgroundTasks: [{ id: "bg_running_1", status: "running" }],
      activeWorkflowSessions: [{ id: "wf_running_1", status: "running" }],
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = false;

    await (repl as any).handleEscKey();

    await new Promise((r) => setTimeout(r, 20));

    expect(cascadeCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Group B — Idle no-op regression: ESC when nothing to stop
  // -------------------------------------------------------------------------

  test("RED-4: ESC when isExecuting=false + NO active descendant → MUST NOT cascade (preserve readline UX)", async () => {
    // 真 idle：主 LLM 不跑，没有任何子任务在跑。
    // 按 ESC 应该什么都不做（不能误触发 cascade 或污染 prompt）。
    const env = buildMockEnv({
      activeBackgroundTasks: [],
      activeWorkflowSessions: [],
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = false;

    await (repl as any).handleEscKey();

    await new Promise((r) => setTimeout(r, 20));

    expect(cascadeCalls).toHaveLength(0);
    // agent abortAll 也不应被调用（idle 没在跑）
    // 这个我们通过 mock.calls 验证
  });

  test("RED-5: ESC when isExecuting=false + ONLY completed/failed bg tasks → MUST NOT cascade", async () => {
    // 只有完成 / 失败的历史任务（status 不在 running/pending）。
    // 不应触发 cascade。
    const env = buildMockEnv({
      activeBackgroundTasks: [], // listTasks 返回空（不区分 status）
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = false;

    await (repl as any).handleEscKey();

    await new Promise((r) => setTimeout(r, 20));

    expect(cascadeCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Group C — Force escalation when active descendant exists
  // -------------------------------------------------------------------------

  test("RED-6: 两次 ESC（在窗口内）+ active bg task → force 升级到 true", async () => {
    // 子 session 在跑 + active descendant。第一次 ESC 触发 cascade（force=false）；
    // 在 2s 窗口内再按 ESC，force 应升级到 true（graceful→force 升级）。
    // 当前实现：isExecuting=false 路径下 force 永远不升级。
    const env = buildMockEnv({
      activeBackgroundTasks: [{ id: "bg_running_1", status: "running" }],
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = false;

    let now = 1000000;
    Date.now = () => now;

    await (repl as any).handleEscKey();
    await new Promise((r) => setTimeout(r, 20));
    expect(cascadeCalls).toHaveLength(1);
    expect(cascadeCalls[0].opts.force).toBe(false);

    // 500ms 后第二次按：在窗口内，force 应升级
    now += 500;
    await (repl as any).handleEscKey();
    await new Promise((r) => setTimeout(r, 20));

    expect(cascadeCalls).toHaveLength(2);
    expect(cascadeCalls[1].opts.force).toBe(true);
  });

  test("RED-7: 两次 ESC（>2s 后）+ active bg task → 第二次仍 force=false（不误升级）", async () => {
    // 子 session 长时间在跑。第一次按 ESC 触发 cascade；
    // 超过 2s 后再按，force 不应升级（避免误 force）。
    const env = buildMockEnv({
      activeBackgroundTasks: [{ id: "bg_running_1", status: "running" }],
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = false;

    let now = 1000000;
    Date.now = () => now;

    await (repl as any).handleEscKey();
    await new Promise((r) => setTimeout(r, 20));
    expect(cascadeCalls).toHaveLength(1);

    // 超过 FORCE_STOP_WINDOW_MS 后再按
    now += 3000;
    await (repl as any).handleEscKey();
    await new Promise((r) => setTimeout(r, 20));

    expect(cascadeCalls).toHaveLength(2);
    expect(cascadeCalls[1].opts.force).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Group D — isExecuting=true path 保留（不能破坏原 graceful abort 行为）
  // -------------------------------------------------------------------------

  test("RED-8: ESC when isExecuting=true + NO active descendant → MUST cascade（保留原 abort 路径）", async () => {
    // 主 LLM 在跑，没有子任务。第一次按 ESC 应该 cascade。
    const env = buildMockEnv({
      activeBackgroundTasks: [],
      activeWorkflowSessions: [],
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = true;

    await (repl as any).handleEscKey();

    await new Promise((r) => setTimeout(r, 20));

    expect(cascadeCalls).toHaveLength(1);
    expect(cascadeCalls[0].opts.force).toBe(false);
  });

  test("RED-9: ESC when isExecuting=true + active bg task → cascade（graceful abort 路径）", async () => {
    const env = buildMockEnv({
      activeBackgroundTasks: [{ id: "bg_running_1", status: "running" }],
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = true;

    await (repl as any).handleEscKey();

    await new Promise((r) => setTimeout(r, 20));

    expect(cascadeCalls).toHaveLength(1);
    expect(cascadeCalls[0].opts.force).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Group E — Observability / stability
  // -------------------------------------------------------------------------

  test("RED-10: ESC + active bg task + cascade throws → handler 稳定不抛错", async () => {
    // cascade 抛错（mock 一次 reject），handler 必须 catch + 不污染 REPL。
    cascadeMock.mockImplementation(async () => {
      throw new Error("simulated cascade failure");
    });

    const env = buildMockEnv({
      activeBackgroundTasks: [{ id: "bg_running_1", status: "running" }],
    });
    const repl = buildRepl(env);
    (repl as any).isExecuting = false;

    // 不应抛错
    let threw = false;
    try {
      await (repl as any).handleEscKey();
      await new Promise((r) => setTimeout(r, 30));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // 恢复默认实现
    cascadeMock.mockImplementation(defaultCascadeImpl);
  });
});

// ---------------------------------------------------------------------------
// (no trailing mock rewiring needed — defaultCascadeImpl is the canonical body)
// ---------------------------------------------------------------------------