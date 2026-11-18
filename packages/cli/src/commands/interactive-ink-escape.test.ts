/**
 * @fileoverview Tests for ink REPL ESC → interactive.handleEscKey wiring (Task #2294 hotfix)
 *
 * 验证 interactive.startInk() 在启动 ink REPL 时传入的 onEscape callback
 * 正确桥接到 handleEscKey()：
 *
 * - 场景 1: startInk() 调 renderInkREPL 时传入的 props 包含 onEscape
 * - 场景 2: 调用 props.onEscape() → 触发 handleEscKey()
 * - 场景 3: 当 isExecuting=true 时，ink onEscape 触发 cascade stop
 * - 场景 4: 当 isExecuting=false 时，ink onEscape 是 no-op
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 *
 * Bug 上下文:
 * - main 上 interactive.startInk() 调 renderInkREPL 时没传 onEscape prop
 * - 导致 ink REPL 的 ESC handler 只清空 buffer，从不触发 cascade stop
 * - 用户按 ESC 无法中断 in-flight execution
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

describe("interactive.startInk() — ESC wiring (Task #2294 hotfix)", () => {
  let mockExecute: ReturnType<typeof mock>;
  let mockShutdown: ReturnType<typeof mock>;
  let mockAbort: ReturnType<typeof mock>;
  let mockEnv: any;

  beforeEach(() => {
    capturedProps.length = 0;
    resetStreamAbort();

    mockExecute = mock(async () => "done");
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

  test("场景 1: startInk() 调 renderInkREPL 时传入 props.onEscape", async () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute as any,
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

    // 等待 startInk 的 await import 和 renderInkREPL 调用完成
    await new Promise((r) => setTimeout(r, 50));

    // Assert: renderInkREPL 被调用，且 props 包含 onEscape
    expect(capturedProps.length).toBeGreaterThanOrEqual(1);
    const lastProps = capturedProps[capturedProps.length - 1]!;
    expect(typeof lastProps.onEscape).toBe("function");
  });

  test("场景 2: 调用 props.onEscape() → 触发 handleEscKey() 路径（idle no-op）", async () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute as any,
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

    // Act: 模拟用户在 ink REPL 里按 ESC（触发 onEscape callback）
    const lastProps = capturedProps[capturedProps.length - 1]!;
    expect(typeof lastProps.onEscape).toBe("function");

    // isExecuting = false（idle），所以 abortAll 不该被调
    mockAbort.mockClear();
    await lastProps.onEscape!();
    await new Promise((r) => setTimeout(r, 50));

    // Assert: idle 状态下 abortAll 不该被调（no-op）
    expect(mockAbort).not.toHaveBeenCalled();
  });

  test("场景 3: isExecuting=true 时 ink onEscape 触发 cascade stop（abortAll）", async () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute as any,
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

    // 模拟正在执行
    (repl as any).isExecuting = true;

    // Act: 用户在 ink REPL 里按 ESC
    const lastProps = capturedProps[capturedProps.length - 1]!;
    mockAbort.mockClear();
    await lastProps.onEscape!();
    await new Promise((r) => setTimeout(r, 50));

    // Assert: 触发 cascade stop → abortAll 被调
    expect(mockAbort).toHaveBeenCalled();
  });

  test("场景 4: startReadline() 路径不走 ink REPL（不应调 renderInkREPL）", async () => {
    // Arrange
    const repl = new REPL(
      {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: mockExecute as any,
        onStatus: mock(() => ({
          sessionId: "test",
          sessionTitle: "Test",
          messageCount: 0,
          tokenCount: 0,
        })) as any,
        onSwitchSession: mock(() => {}) as any,
        onCompact: mock(() => {}) as any,
        onShutdown: mockShutdown as any,
        useInk: false, // 走 readline
        model: "M3",
      },
      mockEnv,
    );

    // Act: 启动（readline 路径）
    void repl.start();
    await new Promise((r) => setTimeout(r, 50));

    // Assert: 不应调 renderInkREPL
    expect(capturedProps.length).toBe(0);
  });
});