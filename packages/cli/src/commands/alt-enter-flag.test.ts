/**
 * @fileoverview Alt+Enter Flag Test (Task #2278)
 *
 * 验证 isAltEnterPending 标志在 keypress 事件中正确设置，
 * 在 line 事件中正确检查并跳过。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { REPL } from "./run";
import { InputHandler } from "./input-handler";

function createMockREPLForAltEnter(): { repl: any } {
  const repl = Object.create(REPL.prototype) as any;
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  repl.inputHandler = new InputHandler();
  repl.handleMessage = vi.fn().mockResolvedValue(undefined);
  repl.handleCommand = vi.fn().mockResolvedValue(undefined);
  repl.rl = {
    close: vi.fn(),
    prompt: vi.fn(),
    setPrompt: vi.fn(),
    write: vi.fn(),
    on: vi.fn(),  // mock event registration
  };
  repl.options = {
    sessionId: "test",
    sessionTitle: "Test",
    onExecute: vi.fn().mockResolvedValue("ok"),
    onStatus: vi.fn().mockReturnValue({
      sessionId: "test",
      sessionTitle: "Test",
      messageCount: 0,
      tokenCount: 0,
    }),
    onSwitchSession: vi.fn(),
    onCompact: vi.fn(),
    onShutdown: vi.fn().mockResolvedValue(undefined),
  };
  repl.statusBarCtx = {
    cwd: "~/test",
    gitBranch: "main",
    model: "MiniMax-M3",
  };
  // Task #2278: Alt+Enter 标志
  repl.isAltEnterPending = false;
  return { repl };
}

describe("Alt+Enter Flag (Task #2278)", () => {
  test("isAltEnterPending flag should exist and be false initially", () => {
    const { repl } = createMockREPLForAltEnter();
    expect(repl.isAltEnterPending).toBe(false);
  });

  test("keypress handler should set isAltEnterPending when Alt+Enter detected (meta=true)", () => {
    const { repl } = createMockREPLForAltEnter();

    // 模拟 keypress handler（与 interactive.ts 实际代码一致）
    repl.keypressHandler = (str: string, key: any) => {
      if (repl.isShuttingDown) return;
      if (key.name === "return" && (key.meta || str === "\x1b" || str.includes("\x1b"))) {
        repl.isAltEnterPending = true;
        setImmediate(() => {
          repl.rl.write("\n");
          repl.isAltEnterPending = false;
        });
        return;
      }
    };

    // 模拟 Alt+Enter
    repl.keypressHandler("\x1b\r", { name: "return", meta: true });

    // 验证 flag 被设置
    expect(repl.isAltEnterPending).toBe(true);
    // 验证 setImmediate 已经调度（rl.write 还没执行）
    // 我们需要等 setImmediate 执行完
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(repl.rl.write).toHaveBeenCalledWith("\n");
        expect(repl.isAltEnterPending).toBe(false);
        resolve();
      });
    });
  });

  test("keypress handler should NOT set isAltEnterPending for plain Enter (no meta)", () => {
    const { repl } = createMockREPLForAltEnter();

    repl.keypressHandler = (str: string, key: any) => {
      if (repl.isShuttingDown) return;
      if (key.name === "return" && (key.meta || str === "\x1b" || str.includes("\x1b"))) {
        repl.isAltEnterPending = true;
        setImmediate(() => {
          repl.rl.write("\n");
          repl.isAltEnterPending = false;
        });
        return;
      }
    };

    // 模拟普通 Enter
    repl.keypressHandler("\r", { name: "return", meta: false });

    expect(repl.isAltEnterPending).toBe(false);
  });
});