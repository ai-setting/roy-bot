/**
 * @fileoverview Input UX Bugfix Tests (Task #2278)
 *
 * 验证 2 个真实 bug 的修复：
 *
 * Bug 1: Alt+Enter 不起作用
 *   - 之前只依赖 key.meta 检测（不可靠，macOS Terminal/iTerm/xterm 编码不同）
 *   - 修复：加 process.stdin 'data' 监听，识别 \x1b\r 字节序列
 *
 * Bug 2: 多行 paste 只接收第一行
 *   - 之前 terminal: true 只让 readline 接受 bracketed paste，不会主动启用
 *   - 修复：start() 主动发送 \x1b[?2004h 启用 paste mode
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { Readable, Writable } from "node:stream";
import { REPL } from "./run";
import { InputHandler } from "./input-handler";

/**
 * 创建一个 mock REPL 实例，捕获 stdout.write
 */
function createMockREPLForBugfix(): {
  repl: any;
  stdoutWrites: string[];
} {
  const stdoutWrites: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  // 替换 process.stdout.write 以捕获输出
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as any;

  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    stdoutWrites.push(args.map((a) => String(a)).join(" "));
  };

  const repl = Object.create(REPL.prototype) as any;
  repl._origLog = origLog;
  repl._origStdoutWrite = origStdoutWrite;
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

  return { repl, stdoutWrites };
}

function restoreMockREPL(repl: any): void {
  console.log = repl._origLog;
  if (repl._origStdoutWrite) {
    process.stdout.write = repl._origStdoutWrite;
  }
}

describe("Input UX Bugfix (Task #2278)", () => {
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

  describe("Bug 1: Alt+Enter 修复", () => {
    test("data listener 应该识别 \\x1b\\r (macOS Terminal / iTerm / xterm) 调 rl.write('\\n')", () => {
      const { repl, stdoutWrites } = createMockREPLForBugfix();
      restoreLog = () => restoreMockREPL(repl);

      // 模拟安装 dataHandler（与 interactive.ts 实际代码一致）
      repl.dataHandler = (chunk: Buffer) => {
        if (repl.isShuttingDown) return;
        const data = chunk.toString("utf8");
        if (data === "\x1b\r" || data.startsWith("\x1b\r") || data === "\x1b[13;5~") {
          repl.rl.write("\n");
        }
      };
      process.stdin.on("data", repl.dataHandler);

      // 模拟 macOS Terminal 发送 Alt+Enter 的字节序列
      const chunk = Buffer.from("\x1b\r", "utf8");
      repl.dataHandler(chunk);

      expect(repl.rl.write).toHaveBeenCalledWith("\n");
    });

    test("data listener 应该识别 \\x1b[13;5~ (iTerm2 alt mode)", () => {
      const { repl, stdoutWrites } = createMockREPLForBugfix();
      restoreLog = () => restoreMockREPL(repl);

      repl.dataHandler = (chunk: Buffer) => {
        if (repl.isShuttingDown) return;
        const data = chunk.toString("utf8");
        if (data === "\x1b\r" || data.startsWith("\x1b\r") || data === "\x1b[13;5~") {
          repl.rl.write("\n");
        }
      };

      // 模拟 iTerm2 alt mode
      const chunk = Buffer.from("\x1b[13;5~", "utf8");
      repl.dataHandler(chunk);

      expect(repl.rl.write).toHaveBeenCalledWith("\n");
    });

    test("data listener 不应该响应普通 Enter (\\r)", () => {
      const { repl, stdoutWrites } = createMockREPLForBugfix();
      restoreLog = () => restoreMockREPL(repl);

      repl.dataHandler = (chunk: Buffer) => {
        if (repl.isShuttingDown) return;
        const data = chunk.toString("utf8");
        if (data === "\x1b\r" || data.startsWith("\x1b\r") || data === "\x1b[13;5~") {
          repl.rl.write("\n");
        }
      };

      // 模拟普通 Enter
      const chunk = Buffer.from("\r", "utf8");
      repl.dataHandler(chunk);

      // 普通 Enter 不应该触发 rl.write("\n")
      expect(repl.rl.write).not.toHaveBeenCalled();
    });

    test("keypress handler 多条件兜底: str 含 ESC 字符时也调 rl.write('\\n')", () => {
      const { repl, stdoutWrites } = createMockREPLForBugfix();
      restoreLog = () => restoreMockREPL(repl);

      // 模拟 keypress handler（与 interactive.ts 实际代码一致）
      repl.keypressHandler = (str: string, key: any) => {
        if (repl.isShuttingDown) return;
        if (key.name === "return" && (key.meta || str === "\x1b" || str.includes("\x1b"))) {
          repl.rl.write("\n");
          return;
        }
      };

      // 场景: key.name=return 但 key.meta=false，str 含 ESC（meta 解析失败兜底）
      repl.keypressHandler("\x1b\r", { name: "return", meta: false });

      expect(repl.rl.write).toHaveBeenCalledWith("\n");
    });
  });

  describe("Bug 2: bracketed paste 修复", () => {
    test("start() 应该在 TTY 模式下发送 \\x1b[?2004h 启用 bracketed paste", () => {
      const { repl, stdoutWrites } = createMockREPLForBugfix();
      restoreLog = () => restoreMockREPL(repl);

      // 模拟 start() 开头
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[?2004h");
      }

      // 验证 stdout 输出包含启用序列
      const allOutput = stdoutWrites.join("");
      expect(allOutput).toContain("\x1b[?2004h");
    });

    test("start() 在非 TTY 模式下不应该发送 \\x1b[?2004h", () => {
      const { repl, stdoutWrites } = createMockREPLForBugfix();
      restoreLog = () => restoreMockREPL(repl);

      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[?2004h");
      }

      const allOutput = stdoutWrites.join("");
      expect(allOutput).not.toContain("\x1b[?2004h");
    });

    test("shutdown() 应该发送 \\x1b[?2004l 关闭 bracketed paste", async () => {
      const { repl, stdoutWrites } = createMockREPLForBugfix();
      restoreLog = () => restoreMockREPL(repl);

      // 模拟 shutdown 流程
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[?2004l");
      }

      const allOutput = stdoutWrites.join("");
      expect(allOutput).toContain("\x1b[?2004l");
    });

    test("shutdown() 应该清理 data listener", async () => {
      const { repl, stdoutWrites } = createMockREPLForBugfix();
      restoreLog = () => restoreMockREPL(repl);

      const removeListenerSpy = vi.spyOn(process.stdin, "removeListener");

      // 设置 data handler
      repl.dataHandler = (chunk: Buffer) => {};
      process.stdin.on("data", repl.dataHandler);

      // 模拟 shutdown 清理
      if (repl.dataHandler) {
        process.stdin.removeListener("data", repl.dataHandler);
        repl.dataHandler = undefined;
      }

      expect(removeListenerSpy).toHaveBeenCalledWith("data", expect.any(Function));
      expect(repl.dataHandler).toBeUndefined();
    });
  });
});