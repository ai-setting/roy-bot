/**
 * @fileoverview Tests for ink REPL ESC cascade stop while in-flight (Task #2297 follow-up)
 *
 * Task #2295 hotfix (33babbe1) wired ink REPL ESC keypress to
 * `interactive.handleEscKey()`. However users reported ESC still couldn't
 * interrupt in-flight execution in ink REPL mode. Root cause: the ink path's
 * `onSubmit` closure calls `this.options.onExecute(input)` directly,
 * bypassing `executeInternal()` (the only place that sets
 * `this.isExecuting = true`). With `isExecuting` permanently false, the
 * `handleEscKey()` guard `if (!canCascade) return;` takes the idle no-op
 * branch (canCascade = isExecuting || hasActiveDescendant, and a plain
 * "hi" query has no delegate_task/workflow_run children), so abortAll
 * and cascadeStopSessionTree are never invoked.
 *
 * These tests cover the real path (not the manual `isExecuting = true`
 * pre-set used by the Task #2295 tests) and verify:
 *
 * - 场景 1: ink onSubmit actually sets `repl.isExecuting = true` while the
 *   user query is in-flight (so ESC can know we're executing).
 * - 场景 2: pressing ESC during in-flight ink REPL execution triggers
 *   abortAll on the AgentComponent (real cascade path, not manual flag set).
 * - 场景 3: when the in-flight query eventually resolves,
 *   `repl.isExecuting` returns to false (no state leak).
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock repl-ink module BEFORE importing REPL — capture props passed to renderInkREPL
// ---------------------------------------------------------------------------
//
// Trick: 先静态 import 真实 repl-ink 模块（拿到所有真实导出），然后 mock.module
// 用 spread re-export 所有真实导出，仅替换 renderInkREPL。这样 mock 不会污染
// 后续的 repl-ink-escape.test.tsx（它需要 REPLInk 真实导出）。
//
// 注意 Bun 的 mock.module 是全局的——任何 test 文件 import 这个路径都会拿到
// mock。但因为我们的 mock 用 spread 保留了所有真实导出，所以 REPLInk 等依然可用。

interface CapturedProps {
  onReady?: (api: any) => void;
  onSubmit?: (input: string) => void | Promise<void>;
  onCommand?: (cmd: string) => Promise<boolean> | boolean;
  onEscape?: () => void | Promise<void>;
  initialContext?: any;
  initialMode?: string;
  initialStatusBarCtx?: any;
}

const capturedProps: CapturedProps[] = [];

// 先 import 真实模块拿到所有真实导出（re-export 给 mock）
const realReplInkMod = await import("./repl-ink");

// Mock 的目标路径 = 相对路径解析后的绝对路径
const __filenameUrl = new URL(import.meta.url).pathname;
const __dirnameUrl = __filenameUrl.substring(0, __filenameUrl.lastIndexOf("/"));
const targetModulePath = new URL(
  "./repl-ink.tsx",
  `file://${__dirnameUrl}/`,
).pathname;

mock.module(targetModulePath, () => {
  // 返回 pass-through mock：所有真实导出保留，仅 renderInkREPL 被替换。
  return {
    ...realReplInkMod,
    renderInkREPL: (props: CapturedProps) => {
      capturedProps.push(props);
      // 返回一个永远不会 resolve 的 Promise，避免 startInk 走到 .then/.catch 关闭
      return new Promise<void>(() => {});
    },
  };
});

// Now safe to import REPL — 它通过动态 import("./repl-ink") 会拿到上面注册的 mock
const { REPL } = await import("./run");
const { resetStreamAbort } = await import("../services/stream-output.service");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("interactive.startInk() — ESC cascade in-flight (Task #2297 follow-up)", () => {
  let mockShutdown: ReturnType<typeof mock>;
  let mockAbort: ReturnType<typeof mock>;
  let mockEnv: any;

  beforeEach(() => {
    capturedProps.length = 0;
    resetStreamAbort();

    mockShutdown = mock(async () => undefined);
    mockAbort = mock(() => {});

    mockEnv = {
      getComponent: mock((name: string) => {
        if (name === "agent") {
          return { abortAll: mockAbort, abort: mockAbort };
        }
        return undefined;
      }),
    };
  });

  /**
   * 场景 1 (RED): ink onSubmit 设置 isExecuting=true
   *
   * 这暴露了 main 上 ink REPL 路径绕过 executeInternal 导致 isExecuting
   * 永远是 false 的 root cause。
   *
   * 测试逻辑：onExecute 返回一个永远不会 resolve 的 promise 模拟 in-flight
   * 查询。模拟用户提交消息并等待异步开始。验证 `repl.isExecuting` 是 true。
   */
  test("场景 1: ink onSubmit 在 in-flight 查询期间设置 isExecuting=true", async () => {
    // Arrange: onExecute 永远不 resolve，模拟正在 streaming
    let neverResolve: () => void = () => {};
    const onExecute = mock(
      () =>
        new Promise<string>((resolve) => {
          neverResolve = () => resolve("done");
        }),
    );

    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: onExecute as any,
        onStatus: mock(() => ({
          sessionId: "test",
          sessionTitle: "Test",
          messageCount: 0,
          tokenCount: 0,
        })) as any,
        onSwitchSession: mock(() => {}) as any,
        onCompact: mock(() => {}) as any,
        onShutdown: mockShutdown as any,
        useInk: true,
        model: "M3",
      },
      mockEnv,
    );

    // Act: 启动 ink REPL
    void repl.start();
    await new Promise((r) => setTimeout(r, 50));

    const lastProps = capturedProps[capturedProps.length - 1]!;
    expect(typeof lastProps.onSubmit).toBe("function");

    // 触发 onSubmit（fire-and-forget；onExecute 会 hang）
    void lastProps.onSubmit!("hello world");
    // 给异步 onSubmit 一点时间把 onExecute 启动
    await new Promise((r) => setTimeout(r, 50));

    // Assert: isExecuting 必须为 true
    // 当前 main 实现 ink onSubmit 没有 set isExecuting=true，所以这个断言会失败。
    expect((repl as any).isExecuting).toBe(true);

    // 清理：resolve 悬挂的 onExecute
    neverResolve();
    await new Promise((r) => setTimeout(r, 50));
  });

  /**
   * 场景 2 (RED): ink 在 in-flight 时按 ESC 真正触发 abortAll
   *
   * 完整端到端：onSubmit 把 queryExecutor 启动成 in-flight（isExecuting=true）
   * → 用户按 ESC → handleEscKey 应该走 cascade 路径 → abortAll 被调。
   *
   * 当前 main 因为 isExecuting 永远 false，handleEscKey 走 idle no-op 路径，
   * abortAll 不会被调。
   */
  test("场景 2: ink 在 in-flight 查询时按 ESC 触发 cascade stop (abortAll)", async () => {
    let neverResolve: () => void = () => {};
    const onExecute = mock(
      () =>
        new Promise<string>((resolve) => {
          neverResolve = () => resolve("done");
        }),
    );

    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: onExecute as any,
        onStatus: mock(() => ({
          sessionId: "test",
          sessionTitle: "Test",
          messageCount: 0,
          tokenCount: 0,
        })) as any,
        onSwitchSession: mock(() => {}) as any,
        onCompact: mock(() => {}) as any,
        onShutdown: mockShutdown as any,
        useInk: true,
        model: "M3",
      },
      mockEnv,
    );

    void repl.start();
    await new Promise((r) => setTimeout(r, 50));

    const lastProps = capturedProps[capturedProps.length - 1]!;

    // Act 1: 用户提交消息（in-flight 启动）
    void lastProps.onSubmit!("hello world");
    await new Promise((r) => setTimeout(r, 50));

    // 验证前置状态
    expect((repl as any).isExecuting).toBe(true);
    mockAbort.mockClear();

    // Act 2: 用户按 ESC
    await lastProps.onEscape!();
    await new Promise((r) => setTimeout(r, 100));

    // Assert: cascade stop 被触发 → abortAll 被调
    // 当前 main 这个断言会失败，因为 isExecuting=false → canCascade=false → idle no-op
    expect(mockAbort).toHaveBeenCalled();

    // 清理
    neverResolve();
    await new Promise((r) => setTimeout(r, 50));
  });

  /**
   * 场景 3: ink onSubmit 在查询完成后清理 isExecuting (无状态泄漏)
   *
   * 修复后验证 finally 块正确重置 isExecuting=false。
   */
  test("场景 3: ink 查询完成后 isExecuting 重置为 false", async () => {
    let resolveExecute: (value: string) => void = () => {};
    const onExecute = mock(
      () =>
        new Promise<string>((resolve) => {
          resolveExecute = resolve;
        }),
    );

    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: onExecute as any,
        onStatus: mock(() => ({
          sessionId: "test",
          sessionTitle: "Test",
          messageCount: 0,
          tokenCount: 0,
        })) as any,
        onSwitchSession: mock(() => {}) as any,
        onCompact: mock(() => {}) as any,
        onShutdown: mockShutdown as any,
        useInk: true,
        model: "M3",
      },
      mockEnv,
    );

    void repl.start();
    await new Promise((r) => setTimeout(r, 50));

    const lastProps = capturedProps[capturedProps.length - 1]!;

    // 启动 in-flight
    const submitPromise = lastProps.onSubmit!("hello world");
    await new Promise((r) => setTimeout(r, 50));
    expect((repl as any).isExecuting).toBe(true);

    // 完成 in-flight
    resolveExecute("done");
    await submitPromise;
    await new Promise((r) => setTimeout(r, 50));

    // Assert: isExecuting 已重置
    expect((repl as any).isExecuting).toBe(false);
  });
});