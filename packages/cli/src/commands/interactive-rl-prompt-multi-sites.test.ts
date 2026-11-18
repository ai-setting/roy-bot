/**
 * @fileoverview Tests for ink-mode rl.prompt safety guards across multiple call sites (Task #2354)
 *
 * 修复 packages/cli/src/commands/run.ts 中 5 处未守卫的
 * `this.rl.prompt(true)` 调用点，在 Ink 模式 (this.rl === null) 下应
 * 不抛 TypeError: null is not an object。
 *
 * Task #2339 只修复了 1/7 调用点（executeInternal finally @ line 1224）。
 * 本任务覆盖剩余 5 处：
 *   - line 430: `/clear` command handler
 *   - line 438: `/cls`  command handler
 *   - line 782: `startReadline` 启动末尾
 *   - line 949: `updatePrompt()` 方法末尾
 *   - line 1355: `promptUser()` 方法开头（ask_user 流程）
 *
 * line 1616（shutdown 块）已有 try/catch 包裹，保留。
 *
 * 修复策略 (TDD):
 *   RED: 写 5 个 ink-mode 测试 + 3 个 readline-mode 回归测试，覆盖每处
 *        守卫在 rl=null / rl=spy 下的行为。
 *   GREEN: 在每个 unguarded call site 加 `if (this.rl) { this.rl.prompt(true); }`。
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import * as readline from "readline";
import { REPL } from "./run";

// ---------------------------------------------------------------------------
// Mock REPL factories
// ---------------------------------------------------------------------------

/**
 * ink 模式 (useInk=true) mock REPL: this.rl === null。
 *
 * 与 Task #2339 测试相同模式: Object.create(REPL.prototype) 跳过真实构造函数
 * (避免读真实 stdin / readline)；后续通过原型方法 (`handleCommand`,
 * `registerDefaultCommands`, `updatePrompt`, `promptUser`) 注入行为。
 */
function createInkMockREPL(): any {
  const repl: any = Object.create(REPL.prototype);
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  // 关键：ink 模式下 this.rl === null
  repl.rl = null;
  repl.options = {
    sessionId: "test",
    sessionTitle: "Test",
    useInk: true,
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
  repl.currentAgentContext = undefined;
  repl.lastUsage = null;
  repl.replMode = "ready";
  repl.statusBarCtx = { cwd: "/tmp", gitBranch: "main", model: "M3" };
  repl.sessionComponent = null;
  repl.sessionManager = null;
  repl.redrawInputArea = vi.fn();
  repl.printHeader = vi.fn();
  repl.askUserTimeoutMs = 50; // 短 timeout 让 promptUser 测试快速结束
  // 关键：initialize commandRegistry so registerDefaultCommands has a Map to populate
  repl.commandRegistry = new Map();
  return repl;
}

/**
 * readline 模式 (useInk=false) mock REPL: this.rl 是一个带 prompt spy 的 fake interface。
 */
function createReadlineMockREPL(): any {
  const repl: any = Object.create(REPL.prototype);
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  repl.rl = {
    close: vi.fn(),
    prompt: vi.fn(),
    setPrompt: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    write: vi.fn(),
    line: "",
  };
  repl.options = {
    sessionId: "test",
    sessionTitle: "Test",
    useInk: false,
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
  repl.currentAgentContext = undefined;
  repl.lastUsage = null;
  repl.replMode = "ready";
  repl.statusBarCtx = {};
  repl.sessionComponent = null;
  repl.sessionManager = null;
  repl.redrawInputArea = vi.fn();
  repl.printHeader = vi.fn();
  repl.askUserTimeoutMs = 50;
  // 关键：initialize commandRegistry so registerDefaultCommands has a Map to populate
  repl.commandRegistry = new Map();
  return repl;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("interactive - Ink-mode rl.prompt guards across 5 call sites (Task #2354)", () => {
  beforeEach(() => {
    // 每个测试前重置 module 状态（不影响 Object.create 的 mock repl）
  });

  // -------------------------------------------------------------------------
  // 测试 1: /clear 命令 (line 430) 在 ink 模式下不抛 TypeError
  // -------------------------------------------------------------------------
  test("line 430 /clear handler: useInk=true + rl=null 不抛 TypeError", async () => {
    const repl = createInkMockREPL();

    // 注入真实的 registerDefaultCommands 来获取 production handlers
    (REPL.prototype as any).registerDefaultCommands.call(repl);
    const clearHandler = repl.commandRegistry.get("clear");
    expect(clearHandler).toBeDefined();

    // Act + Assert: 修复前 this.rl.prompt(true) 在 rl=null 时抛 TypeError（async 函数 → Promise rejection）；
    //                修复后 if (this.rl) 守卫跳过调用，Promise resolves to undefined
    await clearHandler!();

    // 副作用：printHeader 与 redrawInputArea 应被调一次（输入区 UI 重画）
    expect(repl.printHeader).toHaveBeenCalledTimes(1);
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 测试 2: /cls 命令 (line 438) 在 ink 模式下不抛 TypeError
  // -------------------------------------------------------------------------
  test("line 438 /cls handler: useInk=true + rl=null 不抛 TypeError", async () => {
    const repl = createInkMockREPL();

    (REPL.prototype as any).registerDefaultCommands.call(repl);
    const clsHandler = repl.commandRegistry.get("cls");
    expect(clsHandler).toBeDefined();

    await clsHandler!();

    expect(repl.printHeader).toHaveBeenCalledTimes(1);
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 测试 3: startReadline (line 782) 在 readline 接口为 null 时不抛 TypeError
  //
  // 修复前: line 782 `this.rl.prompt(true)` 在 rl=null 时抛 TypeError
  //         → "null is not an object (evaluating 'this.rl.prompt')"
  // 修复后: line 782 `if (this.rl)` 守卫跳过 → 此 TypeError 不再出现
  //         (下游 `this.rl.on("line", ...)` 仍可能抛，但 message 不含 "prompt")
  //
  // 测试策略: catch 任何 rejection，验证 error.message 不含 "this.rl.prompt"
  //           (即 line 782 的崩溃已修复，下游崩溃属于另一个 bug)
  // -------------------------------------------------------------------------
  test("line 782 startReadline 末尾: rl=null 时 line 782 不抛 TypeError", async () => {
    const repl = createInkMockREPL();
    // repl.rl 已为 null（ink 模式默认）

    let caughtError: any = undefined;
    const promise = (REPL.prototype as any).startReadline.call(repl);
    void promise.catch((e: any) => {
      caughtError = e;
    });
    // 给 microtask 跑完的时间
    await new Promise((r) => setImmediate(r));

    // 修复前: caughtError.message 含 "this.rl.prompt"（line 782 崩溃）
    // 修复后: caughtError 是 undefined 或 message 不含 "this.rl.prompt"
    //        (下游 this.rl.on 崩溃属于另一个 bug，本任务不修)
    if (caughtError) {
      expect(String(caughtError.message)).not.toContain("this.rl.prompt");
    } else {
      expect(caughtError).toBeUndefined();
    }

    // 启动序列副作用：printHeader 与 redrawInputArea 应被调一次
    expect(repl.printHeader).toHaveBeenCalledTimes(1);
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 测试 4: updatePrompt (line 949) 在 ink 模式下不抛 TypeError
  // -------------------------------------------------------------------------
  test("line 949 updatePrompt: useInk=true + rl=null 不抛 TypeError", () => {
    const repl = createInkMockREPL();

    // Act + Assert: updatePrompt 是 sync 方法（void return）
    //   修复前: line 948 this.rl.setPrompt(...) 抛 TypeError (rl is null)
    //   修复后: if (this.rl) 守卫跳过，正常走完 setPrompt/redraw/prompt
    expect(() =>
      (REPL.prototype as any).updatePrompt.call(repl),
    ).not.toThrow();

    // 副作用：redrawInputArea 仍被调（UI 重画）
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 测试 5: promptUser (line 1355) 在 ink 模式下不抛 TypeError
  //
  // 修复前: line 1353 `this.rl.setPrompt(...)` 在 rl=null 时抛 TypeError
  //         → "null is not an object (evaluating 'this.rl.setPrompt')"
  // 修复后: line 1353-1356 `if (this.rl)` 守卫跳过 → setPrompt/prompt 不被调用
  //
  // 测试策略: catch 任何 rejection，验证 error.message 不含 setPrompt/prompt
  //           (即 line 1353-1356 的崩溃已修复)
  // -------------------------------------------------------------------------
  test("line 1355 promptUser 开头: useInk=true + rl=null 不抛 TypeError", async () => {
    const repl = createInkMockREPL();
    // repl.rl 已为 null（ink 模式默认）

    let caughtError: any = undefined;
    const promise = (REPL.prototype as any).promptUser.call(
      repl,
      "test question",
      ["opt1", "opt2"],
      undefined,
      { timeoutMs: 50 },
    );
    void promise.catch((e: any) => {
      caughtError = e;
    });

    // 等 promptUser 的 timeout race (50ms) 结束
    await new Promise((r) => setTimeout(r, 100));
    await promise.catch(() => {});

    // 修复前: caughtError.message 含 "setPrompt" 或 "prompt" (line 1353/1356)
    // 修复后: caughtError 是 undefined (line 1353-1356 守卫跳过，正常走完)
    if (caughtError) {
      const msg = String(caughtError.message ?? caughtError);
      expect(msg).not.toContain("setPrompt");
      expect(msg).not.toContain("this.rl.prompt");
    } else {
      expect(caughtError).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // 回归测试 6: /clear 在 readline 模式下，this.rl.prompt(true) 仍被调一次
  // -------------------------------------------------------------------------
  test("line 430 /clear handler 回归: useInk=false + readline 时 prompt 被调一次", async () => {
    const repl = createReadlineMockREPL();

    (REPL.prototype as any).registerDefaultCommands.call(repl);
    const clearHandler = repl.commandRegistry.get("clear");

    await clearHandler!();

    expect(repl.rl.prompt).toHaveBeenCalledTimes(1);
    expect(repl.rl.prompt).toHaveBeenCalledWith(true);
    expect(repl.printHeader).toHaveBeenCalledTimes(1);
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 回归测试 7: /cls 在 readline 模式下，this.rl.prompt(true) 仍被调一次
  // -------------------------------------------------------------------------
  test("line 438 /cls handler 回归: useInk=false + readline 时 prompt 被调一次", async () => {
    const repl = createReadlineMockREPL();

    (REPL.prototype as any).registerDefaultCommands.call(repl);
    const clsHandler = repl.commandRegistry.get("cls");

    await clsHandler!();

    expect(repl.rl.prompt).toHaveBeenCalledTimes(1);
    expect(repl.rl.prompt).toHaveBeenCalledWith(true);
    expect(repl.printHeader).toHaveBeenCalledTimes(1);
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
  });
  // -------------------------------------------------------------------------
  // 回归测试 8: updatePrompt 在 readline 模式下，this.rl.prompt(true) 仍被调一次
  // -------------------------------------------------------------------------
  test("line 949 updatePrompt 回归: useInk=false + readline 时 prompt 被调一次", async () => {
    const repl = createReadlineMockREPL();

    (REPL.prototype as any).updatePrompt.call(repl);

    // updatePrompt: setPrompt + redrawInputArea + prompt(true)
    expect(repl.rl.setPrompt).toHaveBeenCalledTimes(1);
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
    expect(repl.rl.prompt).toHaveBeenCalledTimes(1);
    expect(repl.rl.prompt).toHaveBeenCalledWith(true);
  });

  // -------------------------------------------------------------------------
  // 回归测试 9: promptUser 在 readline 模式下，this.rl.prompt(true) 仍被调一次
  // -------------------------------------------------------------------------
  test("line 1355 promptUser 回归: useInk=false + readline 时 prompt 被调一次", async () => {
    const repl = createReadlineMockREPL();

    const promise = (REPL.prototype as any).promptUser.call(
      repl,
      "test question",
      ["opt1", "opt2"],
      undefined,
      { timeoutMs: 50 },
    );

    // 立刻检查：promptUser 启动同步代码块应已调一次 prompt(true)
    expect(repl.rl.setPrompt).toHaveBeenCalledTimes(1);
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
    expect(repl.rl.prompt).toHaveBeenCalledTimes(1);
    expect(repl.rl.prompt).toHaveBeenCalledWith(true);

    // 等待 timeout race 完成
    await promise;
  });

  // -------------------------------------------------------------------------
  // 回归测试 10: startReadline 在 readline 正常情况下，this.rl.prompt(true) 仍被调一次
  // -------------------------------------------------------------------------
  test("line 782 startReadline 回归: 正常 readline 启动时 prompt 被调一次", async () => {
    const repl = createReadlineMockREPL();

    // startReadline 会 return 一个 pending Promise（等待 rl 'close' 事件）。
    // 为避免测试 hang，我们让 fake rl 立即触发 'close' 来 resolve pending Promise。
    let closeCallback: (() => void) | undefined;
    const fakeRl: any = {
      prompt: vi.fn(),
      setPrompt: vi.fn(),
      on: vi.fn((event: string, cb: any) => {
        if (event === "close") closeCallback = cb;
        return fakeRl;
      }),
      once: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
      write: vi.fn(),
      line: "",
      close: vi.fn(() => closeCallback?.()),
    };
    repl.rl = fakeRl;

    const createInterfaceSpy = vi
      .spyOn(readline, "createInterface")
      .mockReturnValue(fakeRl);

    try {
      // 启动 startReadline，但不等它结束（pending Promise）—— 立即检查同步副作用
      const promise = (REPL.prototype as any).startReadline.call(repl);

      // 同步检查：line 782 应该已经调过一次 prompt(true)
      expect(fakeRl.prompt).toHaveBeenCalledTimes(1);
      expect(fakeRl.prompt).toHaveBeenCalledWith(true);
      expect(repl.printHeader).toHaveBeenCalledTimes(1);
      expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);

      // 触发 close 让 pending Promise resolve
      fakeRl.close();
      await promise;
    } finally {
      createInterfaceSpy.mockRestore();
    }
  });
});
