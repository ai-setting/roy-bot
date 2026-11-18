/**
 * @fileoverview Tests for ink mode event flow finally-block guard (Task #2339)
 *
 * 修复 packages/cli/src/commands/run.ts executeInternal finally 块
 * 在 Ink 模式 (this.rl === null) 下不应调用 this.rl.prompt(true) 的 bug。
 *
 * Bug 复现链：
 *   TTY 启动 → useInk=true → this.rl = null
 *   飞书/bounty IM event → EventHandler.processQueue
 *   → repl.handleEventMessageWithEnv(formattedEvent)
 *   → executeInternal(message, { showPrompt: true })
 *   → finally 块 → this.rl.prompt(true) → TypeError
 *   → EventHandler try/catch → 打印 `[EventHandler] 处理事件失败: TypeError`
 *
 * 修复策略 (TDD):
 *   RED: 写 3 个测试，覆盖
 *     1. useInk=true + rl=null → handleEventMessageWithEnv 不抛 TypeError
 *     2. useInk=false + readline → handleEventMessageWithEnv 完成后 rl.prompt 仍被调一次 (回归)
 *     3. useInk=true + rl=null → redrawInputArea 仍被调 (UI 行为不变)
 *
 *   GREEN: 在 executeInternal finally 块的 `this.rl.prompt(true)` 前加
 *     `if (this.rl) { ... }` 守卫。
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { REPL } from "./run";

/**
 * 构造一个 ink 模式 (useInk=true) 的 mock REPL 实例：
 * - this.rl === null（构造函数 useInk=true 时 this.rl = null）
 * - mock onExecute (避免真实网络调用)
 * - spy redrawInputArea (验证 UI 重画)
 * - mock sessionComponent + sessionManager (满足 handleEventMessageWithEnv 的 ensureActiveSession)
 *
 * 用 Object.create(REPL.prototype) 跳过真实构造函数（避免读真实 stdin / readline）。
 */
function createInkMockREPL() {
  const repl: any = Object.create(REPL.prototype);
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  // 关键：ink 模式下 this.rl === null
  repl.rl = null;
  repl.options = {
    sessionId: "test",
    sessionTitle: "Test",
    useInk: true, // 让 createMockREPL 走 ink 路径，但 Object.create 跳过构造函数，所以这里只是文档
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
  repl.sessionComponent = null; // handleEventMessageWithEnv 的 ensureActiveSession 在没有时是 no-op
  repl.sessionManager = null;
  // spy on redrawInputArea — 直接替换为 spy，避免依赖真实 printSlotTopBorder/StatusBar/...
  repl.redrawInputArea = vi.fn();
  return repl;
}

/**
 * 构造一个 readline 模式 (useInk=false) 的 mock REPL：
 * - this.rl 是一个有 prompt spy 的 fake interface
 * - redrawInputArea 也 spy
 */
function createReadlineMockREPL() {
  const repl: any = Object.create(REPL.prototype);
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  repl.rl = {
    close: vi.fn(),
    prompt: vi.fn(),
    setPrompt: vi.fn(),
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
  return repl;
}

/**
 * 构造一个最小的 formattedEvent (handleEventMessageWithEnv 的入参)
 */
function makeFormattedEvent(message = "hello from event") {
  return {
    message,
    envEvent: { metadata: {} },
    eventSessionId: "evt-1",
  };
}

describe("interactive - Ink mode event flow finally-block guard (Task #2339)", () => {
  beforeEach(() => {
    // 每个测试前重置 process.stdout.isTTY，否则 redrawInputArea 会因非 TTY 早退
    // 这里 repl.redrawInputArea 已被 spy 替换，所以不依赖 TTY
  });

  // -------------------------------------------------------------------------
  // 测试 1：useInk=true (this.rl=null) 时，handleEventMessageWithEnv 不应抛
  // -------------------------------------------------------------------------
  test("useInk=true + rl=null: handleEventMessageWithEnv 不抛 TypeError (事件流程正常完成)", async () => {
    const repl = createInkMockREPL();
    const formattedEvent = makeFormattedEvent("from-lark");

    // Act: 模拟 EventHandler → repl.handleEventMessageWithEnv
    //   修复前: this.rl.prompt(true) 在 rl=null 时抛 TypeError
    //   修复后: if (this.rl) 守卫跳过调用，正常完成
    await expect(
      (REPL.prototype as any).handleEventMessageWithEnv.call(
        repl,
        formattedEvent,
      ),
    ).resolves.toBeUndefined();

    // onExecute 必须被调一次（事件 → 执行）
    //   入参: (message, traceId, agentContext)
    //   agentContext 是 handleEventMessageWithEnv 在 executeInternal 前
    //   通过 this.currentAgentContext 注入的 (executeInternal 会先读取再清空)
    expect(repl.options.onExecute).toHaveBeenCalledTimes(1);
    expect(repl.options.onExecute).toHaveBeenCalledWith(
      "from-lark",
      expect.any(String), // traceId
      expect.objectContaining({
        agentType: undefined,
        envEvent: { metadata: {} },
        eventSessionId: "evt-1",
        pluginEnabled: {},
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 测试 2：useInk=false (readline) 时，handleEventMessageWithEnv 完成后
  //         this.rl.prompt 仍被调一次 (回归)
  // -------------------------------------------------------------------------
  test("useInk=false + readline: handleEventMessageWithEnv 完成后 this.rl.prompt(true) 被调一次 (回归)", async () => {
    const repl = createReadlineMockREPL();
    const formattedEvent = makeFormattedEvent("from-bounty");

    // Act
    await (REPL.prototype as any).handleEventMessageWithEnv.call(
      repl,
      formattedEvent,
    );

    // Assert: readline 路径下 finally 块应调一次 prompt(true) 恢复输入区
    expect(repl.rl.prompt).toHaveBeenCalledTimes(1);
    expect(repl.rl.prompt).toHaveBeenCalledWith(true);
    // redrawInputArea 也应被调一次
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
    // onExecute 应被调一次
    expect(repl.options.onExecute).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 测试 3：useInk=true 时，redrawInputArea 仍被调 (UI 行为不变)，
  //         只是不再调 this.rl.prompt
  // -------------------------------------------------------------------------
  test("useInk=true + rl=null: redrawInputArea 仍被调 (UI 输入区持续可见)", async () => {
    const repl = createInkMockREPL();
    const formattedEvent = makeFormattedEvent("from-ink-event");

    // Act
    await (REPL.prototype as any).handleEventMessageWithEnv.call(
      repl,
      formattedEvent,
    );

    // Assert: redrawInputArea 仍被调一次（输入区 UI 更新）
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
    // onExecute 被调一次（执行逻辑仍跑）
    expect(repl.options.onExecute).toHaveBeenCalledTimes(1);
    // ink 模式不应有任何 this.rl.xxx 调用（rl 是 null，调就抛错）
    // 这条已经由"不抛 TypeError"隐含验证：rl=null 时 prompt() 会抛
  });
});