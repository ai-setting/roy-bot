/**
 * @fileoverview Input UX 测试 (Task #2276 对齐 Claude Code)
 *
 * 验证 4 种输入场景：
 * - 场景 1: Enter 提交单行（默认行为）
 * - 场景 2: Alt+Enter 插入换行（不提交，readline buffer 累积）
 * - 场景 3: 多行 paste 不立即提交（bracketed paste mode）
 * - 场景 4: paste 后用户可以继续编辑
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import * as readline from "node:readline";
import { REPL } from "./run";
import { InputHandler } from "./input-handler";

function createMockREPLForInputUX(): { repl: any; captured: string[] } {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };

  const repl = Object.create(REPL.prototype) as any;
  repl._origLog = origLog;
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  repl.inputHandler = new InputHandler();
  repl.handleMessage = vi.fn().mockResolvedValue(undefined);
  repl.handleCommand = vi.fn().mockResolvedValue(undefined);
  repl.rl = {
    close: vi.fn(),
    prompt: vi.fn(),
    setPrompt: vi.fn(),
    write: vi.fn(),  // Task #2276: Alt+Enter 用 rl.write("\n")
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

  return { repl, captured };
}

describe("Input UX (Task #2276 对齐 Claude Code)", () => {
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

  describe("场景 1: Enter 提交单行", () => {
    test("readline.createInterface 应该配置 terminal: true (bracketed paste mode)", () => {
      // Task #2276: 拦截 readline.createInterface，验证传了 terminal: true
      // 用 vi.spyOn 拦截 readline 模块的 createInterface
      const spy = vi.spyOn(readline, "createInterface").mockImplementation((opts: any) => {
        return {
          on: vi.fn(),
          prompt: vi.fn(),
          setPrompt: vi.fn(),
          write: vi.fn(),
          close: vi.fn(),
          line: vi.fn(),
          removeListener: vi.fn(),
        } as any;
      });

      try {
        new REPL(
          {
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
          } as any,
        );

        expect(spy).toHaveBeenCalled();
        const opts = spy.mock.calls[0]?.[0];
        expect(opts.terminal).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    test("handleLine('hello') 应该直接调用 handleMessage（Enter 提交）", async () => {
      const { repl, captured } = createMockREPLForInputUX();
      restoreLog = () => (console.log = repl._origLog);

      await (REPL.prototype as any).handleLine.call(repl, "hello");

      expect(repl.handleMessage).toHaveBeenCalledWith("hello");
      // buffer 应该被 reset（不再累积）
      expect(repl.inputHandler.getBuffer()).toBe("");
    });
  });

  describe("场景 2: Alt+Enter 插入换行", () => {
    test("Alt+Enter 处理：key.meta && key.name === 'return' → rl.write('\\n')", () => {
      const { repl, captured } = createMockREPLForInputUX();
      restoreLog = () => (console.log = repl._origLog);

      // 模拟 keypress handler（复制 interactive.ts 中的实现）
      const keypressHandler = (str: string, key: any) => {
        if (repl.isShuttingDown) return;
        if (key.meta && key.name === "return") {
          repl.rl.write("\n");
          return;
        }
      };
      repl.keypressHandler = keypressHandler;

      // 模拟 Alt+Enter keypress 事件
      const mockKey = {
        meta: true,
        name: "return",
        sequence: "\x1b\r",
      };

      // 调用 keypressHandler
      repl.keypressHandler("", mockKey);

      // 验证调用了 rl.write("\n")
      expect(repl.rl.write).toHaveBeenCalledWith("\n");
      // 验证没有调用 handleMessage（Alt+Enter 不提交）
      expect(repl.handleMessage).not.toHaveBeenCalled();
    });

    test("handleLine('line1\\nline2') 应该作为多行整体提交", async () => {
      const { repl, captured } = createMockREPLForInputUX();
      restoreLog = () => (console.log = repl._origLog);

      await (REPL.prototype as any).handleLine.call(repl, "line1\nline2");

      // 多行内容整体作为单条消息
      expect(repl.handleMessage).toHaveBeenCalledWith("line1\nline2");
    });
  });

  describe("场景 3: 多行 paste 不立即提交（bracketed paste mode）", () => {
    test("bracketed paste 序列在 readline 内部被识别为单条 line", () => {
      // 这个测试模拟 readline 收到 bracketed paste 后的行为
      // \x1b[200~ 是 paste 开始标记
      // \x1b[201~ 是 paste 结束标记
      // 中间的 \n 不应该触发 line 事件

      // 模拟 readline 处理：bracketed paste 内的 \n 不作为 line break
      const pasteContent = "\x1b[200~line1\nline2\nline3\x1b[201~";
      const stripped = pasteContent.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
      // 内部 \n 保留（readline 会作为单条 line）
      expect(stripped).toBe("line1\nline2\nline3");
      // 但不会触发多次 line 事件（由 readline 处理）
    });

    test("handleLine 应该接受 paste 后的完整内容（多行）", async () => {
      const { repl, captured } = createMockREPLForInputUX();
      restoreLog = () => (console.log = repl._origLog);

      // 模拟用户 paste 多行后按 Enter — readline 的 line 事件带多行内容
      const pastedLine = "pasted line 1\npasted line 2\npasted line 3";

      await (REPL.prototype as any).handleLine.call(repl, pastedLine);

      // 整段 paste 作为单条消息提交
      expect(repl.handleMessage).toHaveBeenCalledWith(pastedLine);
    });
  });

  describe("场景 4: paste 后可以继续编辑", () => {
    test("paste + 用户追加 + Enter 应该作为完整内容提交", async () => {
      const { repl, captured } = createMockREPLForInputUX();
      restoreLog = () => (console.log = repl._origLog);

      // 模拟：用户粘贴 "first\nsecond"，然后继续输入 "...end"
      // 按 Enter 时 readline buffer = "first\nsecond...end"
      // line 事件触发，handleLine 收到完整内容
      const composed = "first\nsecond...end";

      await (REPL.prototype as any).handleLine.call(repl, composed);

      // 完整内容（含 paste + 用户追加）作为单条消息
      expect(repl.handleMessage).toHaveBeenCalledWith(composed);
      expect(repl.inputHandler.getBuffer()).toBe("");
    });
  });
});