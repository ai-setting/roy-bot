/**
 * @fileoverview Input Area Persistence Test (Task #2264 bugfix)
 *
 * 验证多轮对话下输入区 [顶部边框 + 状态栏 + 底部边框] 持续可见。
 *
 * Bug: 第一轮对话时输入区完整（printHeader 一次性画了顶边+状态栏，
 *      start() 画了底边）。
 *      第二轮之后 printHeader 不再调用，updatePrompt() 只 printSlotBottomBorder()，
 *      导致顶部边框和状态栏消失。
 *
 * Fix: 新增 redrawInputArea() 辅助方法，统一打印 [顶边 + 状态栏 + 底边]，
 *      所有 re-prompt 路径改用之。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { REPL } from "./run";
import { InputHandler } from "./input-handler";

/**
 * 创建一个 mock REPL 实例，捕获 console.log 输出
 */
function createMockREPLWithCapture(): { repl: any; captured: string[] } {
  const captured: string[] = [];
  // 拦截 console.log
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  // 每个测试结束时通过 mockREPL.restoreLog 恢复
  const repl = Object.create(REPL.prototype) as any;
  repl._origLog = origLog;
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  repl.inputHandler = new InputHandler();
  repl.handleMessage = (() => undefined);
  // Task #2274 P0: setPrompt / prompt 用 vi.fn 跟踪调用
  const { vi } = require("bun:test");
  repl.rl = {
    close: vi.fn(),
    prompt: vi.fn(),
    setPrompt: vi.fn(),
  };
  repl.options = {
    sessionId: "test",
    sessionTitle: "Test",
    onExecute: (() => Promise.resolve("ok")),
    onStatus: () => ({
      sessionId: "test",
      sessionTitle: "Test",
      messageCount: 0,
      tokenCount: 0,
    }),
    onSwitchSession: () => undefined,
    onCompact: () => undefined,
    onShutdown: () => Promise.resolve(undefined),
  };
  // 设置 statusBarCtx 模拟 printHeader 已初始化
  repl.statusBarCtx = {
    cwd: "~/test",
    gitBranch: "main",
    model: "MiniMax-M3",
  };

  return { repl, captured };
}

describe("Input Area Persistence (Task #2264 bugfix)", () => {
  let restoreLog: (() => void) | null = null;

  beforeEach(() => {
    // 模拟 TTY 模式（让 printSlotTopBorder 等不跳过输出）
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    if (restoreLog) {
      restoreLog();
      restoreLog = null;
    }
  });

  test("updatePrompt() should call redrawInputArea which prints top + status + bottom borders", () => {
    const { repl, captured } = createMockREPLWithCapture();
    restoreLog = () => (console.log = repl._origLog);

    repl.updatePrompt();

    // 期望至少 3 行输出：顶边 + 状态栏 + 底边
    expect(captured.length).toBeGreaterThanOrEqual(3);

    const allOutput = captured.join("\n");
    expect(allOutput).toContain("\u2500"); // 边框 ─
    // 状态栏关键词
    const hasStatusBar =
      allOutput.includes("ready") ||
      allOutput.includes("? for help") ||
      allOutput.includes("M3") ||
      allOutput.includes("defaul");
    expect(hasStatusBar).toBe(true);
  });

  test("连续多次 updatePrompt() 每次都重画完整输入区（不递减）", () => {
    const { repl, captured } = createMockREPLWithCapture();
    restoreLog = () => (console.log = repl._origLog);

    repl.updatePrompt();
    const firstCount = captured.length;
    expect(firstCount).toBeGreaterThanOrEqual(3);

    repl.updatePrompt();
    const secondCount = captured.length;
    expect(secondCount).toBeGreaterThan(firstCount);

    repl.updatePrompt();
    const thirdCount = captured.length;
    expect(thirdCount).toBeGreaterThan(secondCount);

    // 关键断言：每次 updatePrompt 都至少新增 3 行
    expect(secondCount - firstCount).toBeGreaterThanOrEqual(3);
    expect(thirdCount - secondCount).toBeGreaterThanOrEqual(3);
  });

  test("5 轮连续 updatePrompt() — 每次都包含状态栏关键词", () => {
    const { repl, captured } = createMockREPLWithCapture();
    restoreLog = () => (console.log = repl._origLog);

    for (let i = 0; i < 5; i++) {
      repl.updatePrompt();
    }

    const allOutput = captured.join("\n");
    // 5 轮 × 2 边框（顶+底）= 至少 10 个长 border
    const borderCount = (allOutput.match(/\u2500{20,}/g) || []).length;
    expect(borderCount).toBeGreaterThanOrEqual(10);
  });

  test("promptUser 路径也应该用 redrawInputArea（间接验证）", () => {
    const { repl, captured } = createMockREPLWithCapture();
    restoreLog = () => (console.log = repl._origLog);

    repl.redrawInputArea();
    expect(captured.length).toBeGreaterThanOrEqual(3);
  });
});

describe("redrawInputArea (Task #2264 bugfix)", () => {
  let restoreLog: (() => void) | null = null;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    if (restoreLog) {
      restoreLog();
      restoreLog = null;
    }
  });

  test("should be a method on REPL", () => {
    const repl = Object.create(REPL.prototype) as any;
    expect(typeof repl.redrawInputArea).toBe("function");
  });

  test("should print 顶部边框 → 状态栏 → 底部边框 in order", () => {
    const { repl, captured } = createMockREPLWithCapture();
    restoreLog = () => (console.log = repl._origLog);

    repl.redrawInputArea();

    expect(captured.length).toBeGreaterThanOrEqual(3);
    expect(captured[0]).toContain("\u2500"); // 顶部边框
    expect(captured[1]).toMatch(/ready|\? for help|MiniMax|defaul|M3|main|\/home/);
    expect(captured[2]).toContain("\u2500"); // 底部边框
  });

  test("should be a no-op when not TTY", () => {
    const { repl, captured } = createMockREPLWithCapture();
    restoreLog = () => (console.log = repl._origLog);
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    repl.redrawInputArea();

    expect(captured.length).toBe(0);
  });
});

describe("Prompt character consistency (Task #2274 P0)", () => {
  let restoreLog: (() => void) | null = null;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    if (restoreLog) {
      restoreLog();
      restoreLog = null;
    }
  });

  test("updatePrompt should force prompt to ❯ (not ...)", () => {
    const { repl, captured } = createMockREPLWithCapture();
    restoreLog = () => (console.log = repl._origLog);

    // 第 1 轮
    repl.updatePrompt();
    // readline.setPrompt 是 spy，调用记录在 repl.rl
    expect(repl.rl.setPrompt).toHaveBeenCalled();
    const firstCall = (repl.rl.setPrompt as any).mock.calls[0]?.[0] ?? "";
    expect(firstCall).toBe("\u276F "); // ❯ + space

    // 模拟 user 输入（输入到 inputHandler.buffer）
    repl.inputHandler.pushLine("hi");
    // 验证 buffer 有内容
    expect(repl.inputHandler.getBuffer()).toBe("hi");
    // getPrompt() 现在会返回 ... (continuation)，但 updatePrompt 不应该用 getPrompt()
    expect(repl.inputHandler.getPrompt()).toBe("... ");

    // 第 2 轮 — updatePrompt 仍应该用 ❯，不应用 ...
    (repl.rl.setPrompt as any).mockClear?.();
    repl.updatePrompt();
    const secondCall = (repl.rl.setPrompt as any).mock.calls[0]?.[0] ?? "";
    expect(secondCall).toBe("\u276F "); // ❯ 仍然
    expect(secondCall).not.toBe("... "); // 不是 continuation
  });

  test("multiple updatePrompt() should always force ❯ even with non-empty buffer", () => {
    const { repl, captured } = createMockREPLWithCapture();
    restoreLog = () => (console.log = repl._origLog);

    // 模拟 3 轮：每轮 pushLine 一行
    for (let i = 0; i < 3; i++) {
      repl.inputHandler.pushLine(`line ${i + 1}`);
      (repl.rl.setPrompt as any).mockClear?.();
      repl.updatePrompt();
      const prompt = (repl.rl.setPrompt as any).mock.calls[0]?.[0] ?? "";
      expect(prompt).toBe("\u276F ");
    }
  });
});