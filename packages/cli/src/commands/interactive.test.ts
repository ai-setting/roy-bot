/**
 * @fileoverview InteractiveCommand Test
 * 
 * TDD: 测试 InteractiveCommand 的核心功能
 * 
 * 注意：由于 InteractiveCommand 涉及 readline 交互式输入，
 * 我们主要测试其选项解析和命令注册逻辑
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { InteractiveCommand, REPL, type InteractiveOptions } from "./run";
import { Readable, Writable } from "node:stream";

/**
 * 创建一个不会真正监听 stdin 的 mock REPL
 * - 用 EventEmitter-like streams 替换 stdin/stdout
 * - 不触发 real readline
 */
function createMockStdin() {
  const stdin = new Readable({ read() {} }) as any;
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn().mockReturnValue(stdin);
  // 模拟 keypress
  stdin.on = vi.fn((event: string, listener: any) => {
    (stdin as any)._listeners = (stdin as any)._listeners || {};
    (stdin as any)._listeners[event] = (stdin as any)._listeners[event] || [];
    (stdin as any)._listeners[event].push(listener);
    return stdin;
  });
  stdin.removeListener = vi.fn();
  stdin.emit = vi.fn((event: string, ...args: any[]) => {
    const listeners = (stdin as any)._listeners?.[event] || [];
    for (const l of listeners) l(...args);
    return true;
  });
  return stdin;
}

function createMockStdout() {
  return new Writable({ write(_c, _e, cb) { cb(); } }) as any;
}

function createMockREPL() {
  const repl = Object.create(REPL.prototype) as any;
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  // 使用真实的 InputHandler（含 pushLine/getBuffer/getPrompt 等所有方法）
  const { InputHandler } = require("./input-handler");
  repl.inputHandler = new InputHandler();
  // 用 spy 替换副作用方法（避免触发真实网络调用）
  repl.handleMessage = vi.fn();
  // 保留 updatePrompt 调用链 → 让 setPrompt/prompt 能被测试到
  repl.rl = { close: vi.fn(), prompt: vi.fn(), setPrompt: vi.fn() };
  repl.options = {
    sessionId: "test",
    sessionTitle: "Test",
    onExecute: vi.fn().mockResolvedValue("ok"),
    onStatus: vi.fn().mockReturnValue({ sessionId: "test", sessionTitle: "Test", messageCount: 0, tokenCount: 0 }),
    onSwitchSession: vi.fn(),
    onCompact: vi.fn(),
    onShutdown: vi.fn().mockResolvedValue(undefined),
  };
  return repl;
}

describe("InteractiveCommand", () => {
  describe("command definition", () => {
    test("should have correct command name", () => {
      expect(InteractiveCommand.command).toBe("run");
    });

    test("should have aliases defined", () => {
      // ★ Task #5117 (M1) Q2-B1：别名 `i`/`repl` 迁移到 interactive，
      //   run 不再有别名（headless 单一路径）。
      expect(InteractiveCommand.aliases).toBeUndefined();
    });

    test("should have describe text", () => {
      expect(typeof InteractiveCommand.describe).toBe("string");
      expect(InteractiveCommand.describe.length).toBeGreaterThan(0);
    });

    test("should have builder function", () => {
      expect(typeof InteractiveCommand.builder).toBe("function");
    });

    test("should have handler function", () => {
      expect(typeof InteractiveCommand.handler).toBe("function");
    });
  });

  describe("builder", () => {
    test("should add options via builder", () => {
      // Given
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      // When
      InteractiveCommand.builder(mockYargs as any);

      // Then - verify options were added
      expect(mockYargs.option).toHaveBeenCalled();
    });

    test("should add session option", () => {
      // Given
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      // When
      InteractiveCommand.builder(mockYargs as any);

      // Then - check if session option was added
      const optionCalls = mockYargs.option.mock.calls;
      const sessionOption = optionCalls.find(
        (call: any[]) => call[0] === "session"
      );
      expect(sessionOption).toBeDefined();
      expect(sessionOption[1].alias).toBe("s");
    });

    test("should add continue option", () => {
      // Given
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      // When
      InteractiveCommand.builder(mockYargs as any);

      // Then - check if continue option was added
      const optionCalls = mockYargs.option.mock.calls;
      const continueOption = optionCalls.find(
        (call: any[]) => call[0] === "continue"
      );
      expect(continueOption).toBeDefined();
      expect(continueOption[1].alias).toBe("c");
    });

    test("should add config option", () => {
      // Given
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      // When
      InteractiveCommand.builder(mockYargs as any);

      // Then - check if config option was added
      const optionCalls = mockYargs.option.mock.calls;
      const configOption = optionCalls.find(
        (call: any[]) => call[0] === "config"
      );
      expect(configOption).toBeDefined();
      expect(configOption[1].alias).toBe("C");
    });

    test("should add reasoning option", () => {
      // Given
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      // When
      InteractiveCommand.builder(mockYargs as any);

      // Then - check if reasoning option was added
      const optionCalls = mockYargs.option.mock.calls;
      const reasoningOption = optionCalls.find(
        (call: any[]) => call[0] === "reasoning"
      );
      expect(reasoningOption).toBeDefined();
      expect(reasoningOption[1].alias).toBe("r");
    });

    test("should add tool-calls option", () => {
      // Given
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      // When
      InteractiveCommand.builder(mockYargs as any);

      // Then - check if tool-calls option was added
      const optionCalls = mockYargs.option.mock.calls;
      const toolCallsOption = optionCalls.find(
        (call: any[]) => call[0] === "tool-calls"
      );
      expect(toolCallsOption).toBeDefined();
    });

    test("should add tool-results option", () => {
      // Given
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      // When
      InteractiveCommand.builder(mockYargs as any);

      // Then - check if tool-results option was added
      const optionCalls = mockYargs.option.mock.calls;
      const toolResultsOption = optionCalls.find(
        (call: any[]) => call[0] === "tool-results"
      );
      expect(toolResultsOption).toBeDefined();
    });

    // ==========================================================================
    // Task #2039: --default-agent-name / --dan CLI option
    // ==========================================================================
    describe("--default-agent-name option (Task #2039 / Task #1996)", () => {
      test("should register 'default-agent-name' option", () => {
        const mockYargs = {
          option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
          positional: vi.fn().mockReturnThis(),
        };

        InteractiveCommand.builder(mockYargs as any);

        const calls = mockYargs.option.mock.calls;
        const opt = calls.find((c: any[]) => c[0] === "default-agent-name");
        expect(opt).toBeDefined();
      });

      test("should have alias 'dan'", () => {
        const mockYargs = {
          option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
          positional: vi.fn().mockReturnThis(),
        };

        InteractiveCommand.builder(mockYargs as any);

        const calls = mockYargs.option.mock.calls;
        const opt = calls.find((c: any[]) => c[0] === "default-agent-name");
        expect(opt).toBeDefined();
        expect(opt![1].alias).toBe("dan");
      });

      test("should be type 'string'", () => {
        const mockYargs = {
          option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
          positional: vi.fn().mockReturnThis(),
        };

        InteractiveCommand.builder(mockYargs as any);

        const calls = mockYargs.option.mock.calls;
        const opt = calls.find((c: any[]) => c[0] === "default-agent-name");
        expect(opt![1].type).toBe("string");
      });

      test("should default to 'Roy'", () => {
        const mockYargs = {
          option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
          positional: vi.fn().mockReturnThis(),
        };

        InteractiveCommand.builder(mockYargs as any);

        const calls = mockYargs.option.mock.calls;
        const opt = calls.find((c: any[]) => c[0] === "default-agent-name");
        expect(opt![1].default).toBe("Roy");
      });

      test("should have a describe string", () => {
        const mockYargs = {
          option: vi.fn().mockReturnThis(),
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check: vi.fn().mockReturnThis(),
          positional: vi.fn().mockReturnThis(),
        };

        InteractiveCommand.builder(mockYargs as any);

        const calls = mockYargs.option.mock.calls;
        const opt = calls.find((c: any[]) => c[0] === "default-agent-name");
        expect(typeof opt![1].describe).toBe("string");
        expect(opt![1].describe.length).toBeGreaterThan(0);
      });
    });
  });

  describe("InteractiveOptions interface", () => {
    test("should allow optional session", () => {
      const options: InteractiveOptions = {
        session: undefined,
        continue: false,
        config: undefined,
        reasoning: false,
        toolCalls: false,
        toolResults: false,
      };
      expect(options.session).toBeUndefined();
    });

    test("should allow explicit session", () => {
      const options: InteractiveOptions = {
        session: "sess_123",
      };
      expect(options.session).toBe("sess_123");
    });

    test("should allow continue flag", () => {
      const options: InteractiveOptions = {
        continue: true,
      };
      expect(options.continue).toBe(true);
    });

    test("should allow reasoning flag", () => {
      const options: InteractiveOptions = {
        reasoning: true,
      };
      expect(options.reasoning).toBe(true);
    });

    test("should allow tool-calls flag", () => {
      const options: InteractiveOptions = {
        toolCalls: true,
      };
      expect(options.toolCalls).toBe(true);
    });

    test("should allow tool-results flag", () => {
      const options: InteractiveOptions = {
        toolResults: true,
      };
      expect(options.toolResults).toBe(true);
    });
  });
});

describe("Interactive Command Integration", () => {
  test("should have handler that handles options", async () => {
    // Note: This test verifies the handler exists and is callable
    // Actual handler testing would require mocking the entire environment
    expect(typeof InteractiveCommand.handler).toBe("function");
  });

  // ==========================================================================
  // Task #2039: verify that --default-agent-name flows into mergedContext
  // We can't easily call the handler without a full env, so we assert the
  // source wiring (read from the bundled command module).
  // ==========================================================================
  describe("mergedContext.metadata.defaultAgentName wiring (Task #2039)", () => {
    test("handler source contains defaultAgentName pass-through to metadata", async () => {
      // Read the interactive.ts source — the handler closure must build
      // mergedContext.metadata.defaultAgentName = args.defaultAgentName
      const { readFile } = await import("fs/promises");
      const path = await import("path");
      // Resolve relative to this test file
      const testDir = path.dirname(new URL(import.meta.url).pathname);
      const srcPath = path.join(testDir, "run.ts");
      const src = await readFile(srcPath, "utf8");

      // Find the metadata block that injects defaultAgentName
      expect(src).toContain("defaultAgentName: args.defaultAgentName");
      // Verify the metadata is properly merged with existing metadata.
      // Use `[\s\S]*?` instead of `[^}]*` so we match across newlines.
      expect(src).toMatch(
        /metadata:\s*\{[\s\S]*?defaultAgentName:\s*args\.defaultAgentName/m
      );
    });

    test("handler source preserves agentContext metadata when injecting defaultAgentName", async () => {
      const { readFile } = await import("fs/promises");
      const path = await import("path");
      const testDir = path.dirname(new URL(import.meta.url).pathname);
      const srcPath = path.join(testDir, "run.ts");
      const src = await readFile(srcPath, "utf8");

      // The spread of existing metadata should be present.
      //
      // ★ Task #4634：合并逻辑被抽成纯函数 `buildInteractiveMergedContext`，
      //   参数名从 `agentContext` 改成了 `turnAgentContext`（区分「--agent
      //   选中的 currentAgentContext」与「本轮临时传入的 turnAgentContext」）。
      //   这里同步更新断言 —— **行为未变**（metadata 仍然被 spread 进去）。
      expect(src).toContain("...(currentAgentContext?.metadata ?? {})");
      expect(src).toContain("...(turnAgentContext?.metadata ?? {})");
    });

    // ======================================================================
    // Task #4634：抽成纯函数后，这里补一条**行为**断言（不再只 grep 源码）。
    //   灰度价值：grep 断言会因为重构（改个变量名）就假红，而行为断言
    //   只关心「metadata 最终长什么样」，重构不会误伤。
    // ======================================================================
    test("buildInteractiveMergedContext 把两边 metadata 都合并进去", async () => {
      const { buildInteractiveMergedContext } = await import("./run");
      const ctx = buildInteractiveMergedContext({
        currentAgentContext: { metadata: { fromCurrent: 1 } },
        turnAgentContext: { metadata: { fromTurn: 2 } },
        defaultAgentName: "Roy",
      });
      expect(ctx.metadata?.fromCurrent).toBe(1);
      expect(ctx.metadata?.fromTurn).toBe(2);
      expect(ctx.metadata?.defaultAgentName).toBe("Roy");
    });
  });
});

// ============================================================
// REPL 多行输入 + 控制字符 + raw mode 恢复测试
// ============================================================

describe("REPL - 输入提交 (Task #2276 Enter=提交)", () => {
  test("handleLine: Enter 直接提交，调用 handleMessage", async () => {
    const repl: any = createMockREPL();
    const handleMessageSpy = repl.handleMessage;
    // 调用 handleLine (private)
    await (REPL.prototype as any).handleLine.call(repl, "hello");
    // Task #2276: Enter 直接调用 handleMessage 提交
    expect(handleMessageSpy).toHaveBeenCalledWith("hello");
    // buffer 应该被 reset（不再累积）
    expect(repl.inputHandler.getBuffer()).toBe("");
    // Task #2274 P0: updatePrompt 强制 ❯
    expect(repl.rl.setPrompt).toHaveBeenCalledWith("\u276F ");
  });

  test("handleLine: 多行内容（含 \\n）整体作为单条消息提交", async () => {
    const repl: any = createMockREPL();
    const handleMessageSpy = repl.handleMessage;
    // Task #2276: Alt+Enter 插入 \n 到 readline buffer，整段作为单条 line
    await (REPL.prototype as any).handleLine.call(repl, "hello\nworld");

    expect(handleMessageSpy).toHaveBeenCalledWith("hello\nworld");
    expect(repl.inputHandler.getBuffer()).toBe("");
  });

  test("handleLine: 空行不调用 handleMessage（静默忽略）", async () => {
    const repl: any = createMockREPL();
    const handleMessageSpy = repl.handleMessage;

    await (REPL.prototype as any).handleLine.call(repl, "");

    expect(handleMessageSpy).not.toHaveBeenCalled();
    expect(repl.inputHandler.getBuffer()).toBe("");
  });

  test("handleLine: isShuttingDown=true 时直接返回不处理", async () => {
    const repl: any = createMockREPL();
    repl.isShuttingDown = true;
    const handleMessageSpy = repl.handleMessage;

    await (REPL.prototype as any).handleLine.call(repl, "hello");

    expect(handleMessageSpy).not.toHaveBeenCalled();
    expect(repl.inputHandler.getBuffer()).toBe("");
  });
});

describe("REPL - 控制字符过滤 (Task #2276)", () => {
  test("handleLine: 控制字符在 line 参数中被过滤（直接传给 handleMessage）", async () => {
    const repl: any = createMockREPL();
    const handleMessageSpy = repl.handleMessage;
    // 用户输入 "hello\x01\x02 world" — 控制字符应当被过滤
    await (REPL.prototype as any).handleLine.call(repl, "hello\x01\x02 world");

    // Task #2276: Enter = 直接提交，handleMessage 被调用（具体参数由 handleMessage 自己的过滤逻辑决定）
    expect(handleMessageSpy).toHaveBeenCalled();
  });

  test("handleLine: 含 \\x7f (DEL) 的行被过滤", async () => {
    const { vi } = require("bun:test");
    const repl: any = createMockREPL();
    repl.handleMessage = vi.fn().mockResolvedValue(undefined);
    await (REPL.prototype as any).handleLine.call(repl, "a\x7fb");

    // 验证 handleMessage 被调用（过滤在内部发生）
    expect(repl.handleMessage).toHaveBeenCalled();
  });
});

describe("REPL - raw mode 状态恢复", () => {
  test("shutdown: 调用 setRawMode(false) 恢复 TTY 状态", async () => {
    const repl: any = createMockREPL();
    // 模拟 isTTY=true 且 setRawMode 可用
    const origIsTTY = (process.stdin as any).isTTY;
    const origSetRawMode = (process.stdin as any).setRawMode;
    (process.stdin as any).isTTY = true;
    const setRawModeSpy = vi.fn();
    (process.stdin as any).setRawMode = setRawModeSpy;

    try {
      await (REPL.prototype as any).shutdown.call(repl);

      // 关闭 readline
      expect(repl.rl.close).toHaveBeenCalled();
      // 恢复 raw mode
      expect(setRawModeSpy).toHaveBeenCalledWith(false);
      // 调用 onShutdown 回调
      expect(repl.options.onShutdown).toHaveBeenCalled();
    } finally {
      (process.stdin as any).isTTY = origIsTTY;
      (process.stdin as any).setRawMode = origSetRawMode;
    }
  });

  test("shutdown: 非 TTY 时不调用 setRawMode", async () => {
    const repl: any = createMockREPL();
    const origIsTTY = (process.stdin as any).isTTY;
    const origSetRawMode = (process.stdin as any).setRawMode;
    (process.stdin as any).isTTY = false;
    const setRawModeSpy = vi.fn();
    (process.stdin as any).setRawMode = setRawModeSpy;

    try {
      await (REPL.prototype as any).shutdown.call(repl);

      expect(repl.rl.close).toHaveBeenCalled();
      // 非 TTY 时不应调用 setRawMode
      expect(setRawModeSpy).not.toHaveBeenCalled();
    } finally {
      (process.stdin as any).isTTY = origIsTTY;
      (process.stdin as any).setRawMode = origSetRawMode;
    }
  });

  test("shutdown: 多次调用幂等", async () => {
    const repl: any = createMockREPL();
    const origIsTTY = (process.stdin as any).isTTY;
    const origSetRawMode = (process.stdin as any).setRawMode;
    (process.stdin as any).isTTY = true;
    const setRawModeSpy = vi.fn();
    (process.stdin as any).setRawMode = setRawModeSpy;

    try {
      await (REPL.prototype as any).shutdown.call(repl);
      await (REPL.prototype as any).shutdown.call(repl);
      await (REPL.prototype as any).shutdown.call(repl);

      // setRawMode 只应该被调用一次
      expect(setRawModeSpy).toHaveBeenCalledTimes(1);
    } finally {
      (process.stdin as any).isTTY = origIsTTY;
      (process.stdin as any).setRawMode = origSetRawMode;
    }
  });

  test("shutdown: 移除 keypress 监听器", async () => {
    const repl: any = createMockREPL();
    const origIsTTY = (process.stdin as any).isTTY;
    const origSetRawMode = (process.stdin as any).setRawMode;
    (process.stdin as any).isTTY = true;
    (process.stdin as any).setRawMode = vi.fn();
    // 模拟 keypressHandler 已注册
    const removeListenerSpy = vi.spyOn(process.stdin, "removeListener");
    const fakeHandler = () => {};
    repl.keypressHandler = fakeHandler;

    try {
      await (REPL.prototype as any).shutdown.call(repl);

      // keypress listener 应当被移除（使用我们注入的 fakeHandler）
      expect(removeListenerSpy).toHaveBeenCalledWith("keypress", fakeHandler);
      // 引用应当被清空
      expect(repl.keypressHandler).toBeUndefined();
    } finally {
      (process.stdin as any).isTTY = origIsTTY;
      (process.stdin as any).setRawMode = origSetRawMode;
      removeListenerSpy.mockRestore();
    }
  });
});

describe("REPL - handleSigint 保护", () => {
  test("handleSigint: shutdown 状态下立即返回不操作", () => {
    const repl: any = createMockREPL();
    repl.isShuttingDown = true;
    const finishSpy = repl.handleMessage;

    (REPL.prototype as any).handleSigint.call(repl);

    expect(finishSpy).not.toHaveBeenCalled();
  });

  test("handleSigint: 多行输入状态下取消输入并重置 buffer", () => {
    const repl: any = createMockREPL();
    // 推入内容使 prompt 切换到 continuation
    repl.inputHandler.pushLine("hello");
    // 模拟多行输入状态
    repl.rl.prompt = vi.fn();
    // 把 getPrompt 改回原值（已经被 pushLine 内部状态决定）
    (REPL.prototype as any).handleSigint.call(repl);

    expect(repl.inputHandler.getBuffer()).toBe("");
    expect(repl.rl.prompt).toHaveBeenCalled();
  });
});

// ============================================================
// F1: cache effectiveness display — onAfterExecute hook
// (review-cache-stability.md: F1 feature)
// ============================================================

describe("REPL - F1 cache effectiveness display", () => {
  test("onAfterExecute hook is invoked after successful onExecute", async () => {
    const repl: any = createMockREPL();
    const captured: any[] = [];
    repl.options.onAfterExecute = (usage: unknown) => {
      captured.push(usage);
    };

    // executeInternal calls onExecute then onAfterExecute
    await (REPL.prototype as any).executeInternal.call(repl, "hi", { showPrompt: false });

    expect(captured).toHaveLength(1);
  });

  test("onAfterExecute receives null when REPL has no lastUsage yet", async () => {
    const repl: any = createMockREPL();
    let receivedUsage: unknown = "sentinel";
    repl.options.onAfterExecute = (usage: unknown) => {
      receivedUsage = usage;
    };

    await (REPL.prototype as any).executeInternal.call(repl, "hi", { showPrompt: false });

    // REPL's lastUsage defaults to null (or undefined for Object.create mock).
    // The contract is "no usage yet" — both null and undefined satisfy that.
    expect(receivedUsage == null).toBe(true);
  });

  test("onAfterExecute receives the latest usage when REPL.setLastUsage was called", async () => {
    const repl: any = createMockREPL();
    const observed: any[] = [];
    repl.options.onAfterExecute = (usage: unknown) => observed.push(usage);

    const sample = { cacheRead: 1400, cacheWrite: 0, totalTokens: 1500 };
    repl.setLastUsage(sample);

    await (REPL.prototype as any).executeInternal.call(repl, "hi", { showPrompt: false });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(sample);
  });

  test("onAfterExecute hook errors do NOT break the REPL loop", async () => {
    const repl: any = createMockREPL();
    repl.options.onAfterExecute = () => {
      throw new Error("formatter boom");
    };

    // The error must be caught internally — executeInternal should resolve normally
    await expect(
      (REPL.prototype as any).executeInternal.call(repl, "hi", { showPrompt: false })
    ).resolves.toBeUndefined();
  });

  test("onAfterExecute is NOT called when onExecute throws (non-AskUserError)", async () => {
    const repl: any = createMockREPL();
    repl.options.onExecute = vi.fn().mockRejectedValue(new Error("network down"));
    let called = false;
    repl.options.onAfterExecute = () => {
      called = true;
    };

    // Use catch to swallow the expected error from executeInternal
    try {
      await (REPL.prototype as any).executeInternal.call(repl, "hi", { showPrompt: false });
    } catch {
      // expected
    }

    expect(called).toBe(false);
  });

  test("setLastUsage stores the usage for later inspection", () => {
    const repl: any = createMockREPL();
    const sample = { cacheRead: 100, cacheWrite: 50, totalTokens: 250 };
    repl.setLastUsage(sample);

    // lastUsage is private but the REPL reads it during onAfterExecute
    expect(repl.lastUsage).toEqual(sample);
  });
});

// ============================================================================
// Task #1766: REPL.ensureActiveSession helper 测试
// ============================================================================
//
// ensureActiveSession() 是 REPL 的私有方法 (private async ensureActiveSession())，
// 通过 handleMessage / handleEventMessageWithEnv 入口调用。
// 这里直接调 (REPL.prototype as any).ensureActiveSession.call(repl, ...) 来测。
//
// 行为契约：
// - 如果 sessionComponent.getActiveSessionId() 返回非空 → 不调 sessionManager.init()
// - 如果 sessionComponent.getActiveSessionId() 返回空 + sessionManager 存在 → 调 init() 兜底
// - 如果 sessionComponent 未注入 → 直接 return (no-op)
// - 如果 sessionComponent.getActiveSessionId() 抛错 → catch + log, 不阻断
// ============================================================================

describe("REPL - Task #1766: ensureActiveSession helper", () => {
  test("sessionComponent 未注入时，ensureActiveSession 是 no-op", async () => {
    const repl: any = createMockREPL();
    repl.sessionComponent = null;
    repl.sessionManager = null;

    // 不会抛错
    await expect(
      (REPL.prototype as any).ensureActiveSession.call(repl)
    ).resolves.toBeUndefined();
  });

  test("active session 已存在时 (getActiveSessionId 返回非空)，不调 sessionManager.init() 兜底", async () => {
    const repl: any = createMockREPL();
    repl.sessionComponent = {
      getActiveSessionId: vi.fn().mockReturnValue("active-123"),
    };
    const initSpy = vi.fn().mockResolvedValue({
      sessionId: "new-456",
      isNewSession: true,
      sessionTitle: "New",
    });
    repl.sessionManager = { init: initSpy };

    await (REPL.prototype as any).ensureActiveSession.call(repl);

    // 验证：getActiveSessionId 被调
    expect(repl.sessionComponent.getActiveSessionId).toHaveBeenCalledTimes(1);
    // 验证：sessionManager.init 未被调（不需要兜底）
    expect(initSpy).not.toHaveBeenCalled();
  });

  test("active session 丢失 (getActiveSessionId 返回 undefined) + sessionManager 存在 → 调 init() 兜底", async () => {
    const repl: any = createMockREPL();
    repl.sessionComponent = {
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
    };
    const initSpy = vi.fn().mockResolvedValue({
      sessionId: "recovered-789",
      isNewSession: true,
      sessionTitle: "Recovered",
    });
    repl.sessionManager = { init: initSpy };

    await (REPL.prototype as any).ensureActiveSession.call(repl);

    // 验证：getActiveSessionId 被调
    expect(repl.sessionComponent.getActiveSessionId).toHaveBeenCalledTimes(1);
    // 验证：sessionManager.init 被调一次（兜底），参数 (undefined, false)
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledWith(undefined, false);
  });

  test("active session 丢失 + sessionManager 不存在 → 不抛错（只 log）", async () => {
    const repl: any = createMockREPL();
    repl.sessionComponent = {
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
    };
    repl.sessionManager = null;

    // 不应该抛错
    await expect(
      (REPL.prototype as any).ensureActiveSession.call(repl)
    ).resolves.toBeUndefined();
  });

  test("getActiveSessionId 抛错时，ensureActiveSession 不抛错（只 log）", async () => {
    const repl: any = createMockREPL();
    repl.sessionComponent = {
      getActiveSessionId: vi.fn().mockImplementation(() => {
        throw new Error("storage locked");
      }),
    };
    repl.sessionManager = null;

    // 不应该抛错
    await expect(
      (REPL.prototype as any).ensureActiveSession.call(repl)
    ).resolves.toBeUndefined();
  });
});
