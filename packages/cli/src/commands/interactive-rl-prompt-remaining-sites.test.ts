/**
 * @fileoverview Tests for ink-mode rl.prompt safety guards for remaining call sites (Task #2368)
 *
 * 修复 packages/cli/src/commands/run.ts 中剩余的 `this.rl.prompt(true)`
 * 调用点 (line 1642 handleEscKey 末尾 try/catch)，在 Ink 模式 (this.rl === null) 下应
 * 不产生 TypeError: null is not an object。
 *
 * 历史:
 *   Task #2339 修复 1/7 (executeInternal finally @ line 1224)
 *   Task #2354 修复 5/7 (line 430/438/782/949/1355) — 全部 `if (this.rl) { ... }` 守卫
 *   Task #2368 修复 1/7 (line 1642) — try/catch 路径，需加 if (this.rl) 守卫包裹
 *
 * line 1642 try/catch 当前行为:
 *   - try { this.redrawInputArea(); this.rl.prompt(true); } catch {}
 *   - rl === null 时 TypeError 被 swallow，但 redrawInputArea 仍被调 (try 块第一行)
 *     而且属不一致风格
 *
 * 修复策略 (TDD):
 *   RED: 写 ink-mode 测试验证 handleEscKey 在 rl=null 时
 *        - 不抛 TypeError (catch 已 swallow，所以额外检查 redrawInputArea 未被调用)
 *   GREEN: 把 try/catch 改为 `if (this.rl) { try { ... } catch {} }`
 *          (整个 block 在 ink 模式下跳过)
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { REPL } from "./run";

// ---------------------------------------------------------------------------
// Mock REPL factories
// ---------------------------------------------------------------------------

/**
 * ink 模式 (useInk=true) mock REPL: this.rl === null。
 *
 * 与 Task #2354 测试相同模式: Object.create(REPL.prototype) 跳过真实构造函数
 * (避免读真实 stdin / readline)；后续通过原型方法 (handleEscKey) 注入行为。
 */
function createInkMockREPL(): any {
  const repl: any = Object.create(REPL.prototype);
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  // 关键: ink 模式下 this.rl === null
  repl.rl = null;
  repl.env = null;
  repl.options = {
    sessionId: "test-session",
    sessionTitle: "Test",
    useInk: true,
    onExecute: vi.fn().mockResolvedValue("ok"),
    onStatus: vi.fn().mockReturnValue({
      sessionId: "test-session",
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
  repl.printStatusBar = vi.fn(); // setMode 调用 printStatusBar
  repl.askUserTimeoutMs = 50;
  repl.commandRegistry = new Map();
  repl.lastEscPressTime = 0;
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
  repl.env = null;
  repl.options = {
    sessionId: "test-session",
    sessionTitle: "Test",
    useInk: false,
    onExecute: vi.fn().mockResolvedValue("ok"),
    onStatus: vi.fn().mockReturnValue({
      sessionId: "test-session",
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
  repl.printStatusBar = vi.fn();
  repl.askUserTimeoutMs = 50;
  repl.commandRegistry = new Map();
  repl.lastEscPressTime = 0;
  return repl;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("interactive - Ink-mode rl.prompt guard for line 1642 (Task #2368)", () => {
  beforeEach(() => {
    // 每个测试前重置 module 状态
  });

  // -------------------------------------------------------------------------
  // 测试 1 (RED→GREEN): handleEscKey (line 1642 try/catch) 在 ink 模式下
  //   修复前: try { this.redrawInputArea(); this.rl.prompt(true); } catch {}
  //           redrawInputArea 被调一次, this.rl.prompt(true) 抛 TypeError 被吞
  //   修复后: if (this.rl) { try { this.redrawInputArea(); this.rl.prompt(true); } catch {} }
  //           整个 block 在 ink 模式下跳过 — redrawInputArea NOT called
  //
  // 测试策略: 设置 isExecuting=true + env=null 让 handleEscKey 走到 line 1642
  //   验证 handleEscKey 不抛，且 redrawInputArea NOT called
  // -------------------------------------------------------------------------
  test("line 1642 handleEscKey try/catch: useInk=true + rl=null 时 line 1642 整个块跳过 (redrawInputArea 不被调)", async () => {
    const repl = createInkMockREPL();
    repl.isExecuting = true;  // 触发 canCascade=true
    repl.lastEscPressTime = 0; // 第一次 ESC → force=false

    // Act + Assert: handleEscKey 是 async 方法，不应抛
    await (REPL.prototype as any).handleEscKey.call(repl);

    // 关键断言: line 1642 try/catch 在 ink 模式下应整块跳过
    //   修复前 redrawInputArea 被调一次（try 块第一行），try/catch 吞掉 TypeError
    //   修复后 if (this.rl) 守卫让 redrawInputArea NOT called
    expect(repl.redrawInputArea).not.toHaveBeenCalled();

    // 副作用: setMode("ready") 应被调 (恢复状态栏) — 与 redrawInputArea 是不同调用
    expect(repl.printStatusBar).toHaveBeenCalled();
    // isExecuting 应被重置 (canCascade path 完成)
    expect(repl.isExecuting).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 测试 2 (回归): handleEscKey readline 模式下，prompt 仍被调一次
  //
  // 修复后: if (this.rl) 守卫让 readline 模式照常调 prompt (与现有 7 处守卫一致)
  // -------------------------------------------------------------------------
  test("line 1642 handleEscKey 回归: useInk=false + readline 时 prompt 被调一次", async () => {
    const repl = createReadlineMockREPL();
    repl.isExecuting = true;

    await (REPL.prototype as any).handleEscKey.call(repl);

    expect(repl.rl.prompt).toHaveBeenCalledTimes(1);
    expect(repl.rl.prompt).toHaveBeenCalledWith(true);
    expect(repl.redrawInputArea).toHaveBeenCalledTimes(1);
    expect(repl.isExecuting).toBe(false);
  });
});