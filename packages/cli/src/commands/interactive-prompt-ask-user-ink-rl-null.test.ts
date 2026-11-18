/**
 * @fileoverview Tests for ink-mode promptUser withAskUserTimeoutRace null guard (Task #2377)
 *
 * 修复 packages/cli/src/commands/run.ts `promptUser` 函数（line 1408）
 * 中漏掉的 `if (this.rl)` 守卫。在 Ink 模式 (this.rl === null) 下调用
 * `withAskUserTimeoutRace({ rl: this.rl, ... })` 会抛
 * "TypeError: null is not an object (evaluating 'rl.on')"。
 *
 * 历史（同一函数其它 5 处已陆续修复）:
 *   Task #2281 修复 1/6 (shutdown)
 *   Task #2339 修复 1/6 (executeInternal finally @ line 1224)
 *   Task #2354 修复 3/6 (line 1374/1378 promptUser 开头 + updatePrompt + 多处其它)
 *   Task #2368 修复 1/6 (line 1642 handleEscKey try/catch)
 *   Task #2377 修复 1/6 (line 1408 promptUser withAskUserTimeoutRace) ← 本 task
 *
 * 修复策略 (TDD):
 *   RED: 写 ink-mode 测试验证 promptUser 在 rl=null 时
 *        - 不抛 TypeError "null is not an object (evaluating 'rl.on')"
 *        - resolve 一个 AskUserTimeoutSentinel (复用 Task #1967 基础设施)
 *        - 现有 readline 模式仍走原有 race 流程（回归保护）
 *   GREEN: 加 `if (this.rl)` 守卫，ink 模式走 sentinel resolve 分支
 *   REFACTOR: withAskUserTimeoutRace 内部也加 null check 深度防御
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  REPL,
  isAskUserTimeoutSentinel,
  createAskUserTimeoutSentinel,
  ASK_USER_TIMEOUT_MS,
} from "./run";
import {
  withAskUserTimeoutRace,
  type WithAskUserTimeoutRaceRl,
} from "./shared/ask-user-timeout";

// ---------------------------------------------------------------------------
// Mock REPL factories
// ---------------------------------------------------------------------------

/**
 * ink 模式 (useInk=true) mock REPL: this.rl === null。
 *
 * 与 Task #2354 / #2368 测试相同模式: Object.create(REPL.prototype) 跳过真实构造函数
 * (避免读真实 stdin / readline)；后续通过原型方法 (promptUser) 注入行为。
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
  repl.printStatusBar = vi.fn();
  repl.askUserTimeoutMs = 50; // 短 timeout 让 promptUser 测试快速结束
  repl.commandRegistry = new Map();
  repl.lastEscPressTime = 0;
  return repl;
}

/**
 * readline 模式 (useInk=false) mock REPL: this.rl 是一个带 spy 的 fake interface。
 *
 * EventEmitter-based mock 提供 on/removeListener，与真实 readline 接口一致。
 */
function createReadlineMockREPL(): any {
  const rl = new EventEmitter();
  const repl: any = Object.create(REPL.prototype);
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  repl.rl = rl;
  (repl.rl as any).setPrompt = vi.fn();
  (repl.rl as any).prompt = vi.fn();
  (repl.rl as any).close = vi.fn();
  (repl.rl as any).line = "";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("interactive - Ink-mode promptUser withAskUserTimeoutRace null guard (Task #2377)", () => {
  beforeEach(() => {
    // 每个测试前重置 module 状态
  });

  // -------------------------------------------------------------------------
  // RED 测试 (主断言): promptUser line 1408 在 ink 模式 (rl=null) 下
  //   - 不抛 TypeError "null is not an object (evaluating 'rl.on')"
  //   - 立即 resolve 一个 AskUserTimeoutSentinel（ink 模式 ask_user 暂未实现交互，
  //     超时 sentinel 让 caller 走 handleAskUserInteraction 的优雅分支）
  // -------------------------------------------------------------------------
  test("line 1408 promptUser withAskUserTimeoutRace: useInk=true + rl=null 不抛 TypeError, resolve AskUserTimeoutSentinel", async () => {
    const repl = createInkMockREPL();
    // repl.rl 已为 null（ink 模式默认）

    // Act: 直接调用 promptUser，期望不抛错，且最终 resolve 一个 sentinel
    let caughtError: any = undefined;
    let resolvedValue: string | undefined;
    const promise = (REPL.prototype as any).promptUser.call(
      repl,
      "test question",
      ["opt1", "opt2"],
      { query: "test question" },
      { timeoutMs: 30 },
    );

    // catch 任何 rejection
    promise.catch((e: any) => {
      caughtError = e;
    });

    // 等 timeout 触发 + microtask 排空
    await sleep(80);
    resolvedValue = await promise.catch(() => "");

    // 修复前断言: caughtError.message 含 "null is not an object" 或 "rl.on"
    if (caughtError) {
      const msg = String(caughtError.message ?? caughtError);
      expect(msg).not.toContain("null is not an object");
      expect(msg).not.toContain("rl.on");
    }

    // 修复后断言: resolvedValue 是 AskUserTimeoutSentinel（ink 模式暂未实现交互，
    //             复用 Task #1967 sentinel 走优雅分支）
    expect(typeof resolvedValue).toBe("string");
    expect(isAskUserTimeoutSentinel(resolvedValue)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 回归保护 1: readline 模式 (useInk=false, rl 非 null) 时
  //   - withAskUserTimeoutRace 仍被调用（原有 race 流程）
  //   - 用户正常输入时 resolve 用户输入（非 sentinel）
  // -------------------------------------------------------------------------
  test("line 1408 promptUser 回归: useInk=false + readline 时 withAskUserTimeoutRace 正常 race", async () => {
    const repl = createReadlineMockREPL();
    const rl = repl.rl;

    const promise = (REPL.prototype as any).promptUser.call(
      repl,
      "请选择",
      ["A", "B"],
      undefined,
      { timeoutMs: 200 },
    );

    // rl 上应有 line listener 被注册（race 流程起效）
    expect(rl.listenerCount("line")).toBeGreaterThanOrEqual(1);

    // 模拟用户输入 "1" → 解析为 "A"
    rl.emit("line", "1");

    const result = await promise;
    expect(result).toBe("A");

    // race 结束后 listener 已清理
    expect(rl.listenerCount("line")).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 回归保护 2: readline 模式下超时分支仍走原流程（返回 sentinel）
  // -------------------------------------------------------------------------
  test("line 1408 promptUser 回归: useInk=false + readline 时超时返回 sentinel", async () => {
    const repl = createReadlineMockREPL();
    const rl = repl.rl;

    const promise = (REPL.prototype as any).promptUser.call(
      repl,
      "请选择",
      ["A", "B"],
      { query: "请选择" },
      { timeoutMs: 30 },
    );

    // 等超时
    await sleep(80);

    const result = await promise;
    expect(isAskUserTimeoutSentinel(result)).toBe(true);
    expect(rl.listenerCount("line")).toBe(0);
  });
});

// ===========================================================================
// 深度防御测试: withAskUserTimeoutRace({ rl: null, ... }) 应优雅返回
// ===========================================================================

describe("withAskUserTimeoutRace defensive null guard (Task #2377)", () => {
  test("withAskUserTimeoutRace({ rl: null, ... }) 不抛错, 返回 { cancel } stub", () => {
    let caughtError: any = undefined;
    let cancelHandle: { cancel: () => void } | undefined;

    try {
      cancelHandle = withAskUserTimeoutRace({
        rl: null as unknown as WithAskUserTimeoutRaceRl, // 故意传 null
        timeoutMs: 50,
        onLine: () => {},
        onTimeout: () => {},
      });
    } catch (e: any) {
      caughtError = e;
    }

    // 不抛 TypeError
    expect(caughtError).toBeUndefined();

    // 返回一个 cancel stub（调用 cancel 不抛错）
    expect(cancelHandle).toBeDefined();
    expect(typeof cancelHandle!.cancel).toBe("function");

    // 调用 cancel 也应不抛错
    expect(() => cancelHandle!.cancel()).not.toThrow();
  });

  test("withAskUserTimeoutRace({ rl: null, ... }) 立即不调 onTimeout", async () => {
    const onTimeout = vi.fn();
    const onLine = vi.fn();

    const handle = withAskUserTimeoutRace({
      rl: null as unknown as WithAskUserTimeoutRaceRl,
      timeoutMs: 30,
      onLine,
      onTimeout,
    });

    // 等久于 timeout，确保即使没 null guard，onTimeout 也不会被误调
    await sleep(80);

    // 防御性 null guard 让 timer 根本没被注册，onTimeout 不应被调
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onLine).not.toHaveBeenCalled();

    // cancel 也不应抛错
    expect(() => handle.cancel()).not.toThrow();
  });
});
