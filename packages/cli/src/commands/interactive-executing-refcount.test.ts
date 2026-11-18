/**
 * @fileoverview executingSessions 引用计数测试 (Task #4515 / H2b)
 *
 * ## 问题（#4514 复审 H2b）
 *
 * `executingSessions` 是 `Set<string>`：
 *
 *     markSessionExecuting("oc_A", true);   // set = {oc_A}
 *     markSessionExecuting("oc_A", true);   // set 仍 = {oc_A}（Set 幂等）
 *     markSessionExecuting("oc_A", false);  // run1 先结束 → set = {}  ← 提前释放！
 *     // 此时 run2 还在跑，但 isSessionIdle("oc_A") 已经返回 true
 *
 * 后果（用户可见）：
 *   - EventHandler 的同 session 门禁提前打开 → 第三轮可以插进来并发跑
 *   - 底部状态栏提前翻 "ready"
 *   - ESC 的 `canCascade = isExecuting || ...` 判定失效（以为没在跑）
 *
 * ## 修复
 *
 * 改成 `Map<string, number>` 引用计数：
 *   - `markSessionExecuting(sid, true)`  → 计数 +1
 *   - `markSessionExecuting(sid, false)` → 计数 -1，减到 0 才真正释放
 *   - `isSessionIdle(sid)` → 计数为 0/不存在
 *
 * 即使 H2 根治后同 session 双跑理论上不该发生，引用计数仍是**防御性必需**：
 * 其它路径（用户打字 + 事件并发、ESC 竞态、异常重试）仍可能双重 mark。
 */

import { describe, test, expect, vi } from "bun:test";
import { REPL } from "./run";

// ============================================================================
// Helpers
// ============================================================================

function makeRepl() {
  const repl = Object.create(REPL.prototype) as any;
  repl.isShuttingDown = false;
  repl.executingSessions = new Map<string, number>();
  repl.replMode = "ready";
  repl.statusBarCtx = {};
  repl.options = {
    sessionId: "sess_default",
    sessionTitle: "Test",
    onExecute: vi.fn().mockResolvedValue("ok"),
    onStatus: vi.fn(),
    onSwitchSession: vi.fn(),
    onCompact: vi.fn(),
    onShutdown: vi.fn().mockResolvedValue(undefined),
  };
  repl.setMode = vi.fn();
  repl.redrawInputArea = vi.fn();
  repl.updatePrompt = vi.fn();
  repl.rl = null;
  return repl;
}

// ============================================================================
// H2b: 引用计数
// ============================================================================

describe("Task #4515 (H2b): executingSessions 引用计数", () => {
  test("同一 session 两次 mark 后仍算忙；两次 unmark 后才回空闲", () => {
    const repl = makeRepl();

    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_A", true);

    // 第二 次 mark 不能让计数还是 1（Set 的老行为）
    expect(repl.isSessionIdle("oc_A")).toBe(false);

    // run1 结束
    repl.markSessionExecuting("oc_A", false);
    // ★ 核心不变量：run2 还在跑 → 仍必须是忙
    expect(repl.isSessionIdle("oc_A")).toBe(false);
    expect(repl.isIdle()).toBe(false);
    expect(repl.isExecuting).toBe(true);

    // run2 结束 → 才真正空闲
    repl.markSessionExecuting("oc_A", false);
    expect(repl.isSessionIdle("oc_A")).toBe(true);
    expect(repl.isIdle()).toBe(true);
    expect(repl.isExecuting).toBe(false);
  });

  test("三次 mark 需要三次 unmark（计数不是布尔开关）", () => {
    const repl = makeRepl();

    repl.markSessionExecuting("s", true);
    repl.markSessionExecuting("s", true);
    repl.markSessionExecuting("s", true);

    repl.markSessionExecuting("s", false);
    repl.markSessionExecuting("s", false);
    expect(repl.isSessionIdle("s")).toBe(false);

    repl.markSessionExecuting("s", false);
    expect(repl.isSessionIdle("s")).toBe(true);
  });

  test("多余的 unmark 不会变成负数 / 不会把别人的占用搞乱", () => {
    const repl = makeRepl();

    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_B", true);

    // 对 A 多减几次
    repl.markSessionExecuting("oc_A", false);
    repl.markSessionExecuting("oc_A", false);
    repl.markSessionExecuting("oc_A", false);

    expect(repl.isSessionIdle("oc_A")).toBe(true);
    // B 不受影响
    expect(repl.isSessionIdle("oc_B")).toBe(false);
    expect(repl.isExecuting).toBe(true);
  });

  test("两个 session 同时各 mark 两次，各自独立计数", () => {
    const repl = makeRepl();

    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_B", true);
    repl.markSessionExecuting("oc_B", true);

    repl.markSessionExecuting("oc_A", false);
    repl.markSessionExecuting("oc_A", false);
    expect(repl.isSessionIdle("oc_A")).toBe(true);
    expect(repl.isSessionIdle("oc_B")).toBe(false);
    expect(repl.isIdle()).toBe(false);

    repl.markSessionExecuting("oc_B", false);
    repl.markSessionExecuting("oc_B", false);
    expect(repl.isIdle()).toBe(true);
  });

  test("getExecutingSessionIds 只列真正忙的 session（引用计数>0）", () => {
    const repl = makeRepl();

    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_B", true);
    repl.markSessionExecuting("oc_B", false); // B 归零 → 不再出现

    const ids = repl.getExecutingSessionIds();
    expect(ids).toContain("oc_A");
    expect(ids).not.toContain("oc_B");
    expect(ids.length).toBe(1);
  });

  test("isExecuting = false setter 仍清空所有占用（旧布尔语义）", () => {
    const repl = makeRepl();

    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_B", true);

    repl.isExecuting = false;

    expect(repl.isIdle()).toBe(true);
    expect(repl.isSessionIdle("oc_A")).toBe(true);
    expect(repl.isSessionIdle("oc_B")).toBe(true);
  });

  test("isExecuting = true setter 让全局视角变忙（兼容旧测试）", () => {
    const repl = makeRepl();

    repl.isExecuting = true;
    expect(repl.isExecuting).toBe(true);
    expect(repl.isIdle()).toBe(false);

    repl.isExecuting = false;
    expect(repl.isIdle()).toBe(true);
  });

  test("abortAllExecutingSessions（abortAll）清空计数", () => {
    const repl = makeRepl();

    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_B", true);

    // 走真实的 abortAll 入口
    repl.abortAllExecutingSessions();

    expect(repl.isIdle()).toBe(true);
    expect(repl.getExecutingSessionIds()).toEqual([]);
  });

  test("未初始化的替身（Object.create 不走字段初始化器）也能工作", () => {
    const repl = Object.create(REPL.prototype) as any;
    repl.options = { sessionId: "s" };
    // 故意不给 executingSessions —— 懒初始化必须兜住

    expect(repl.isIdle()).toBe(true);
    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_A", true);
    expect(repl.isSessionIdle("oc_A")).toBe(false);
    repl.markSessionExecuting("oc_A", false);
    expect(repl.isSessionIdle("oc_A")).toBe(false);
    repl.markSessionExecuting("oc_A", false);
    expect(repl.isSessionIdle("oc_A")).toBe(true);
  });
});

// ============================================================================
// M6: mark 之后、try 之前抛错不能永久占用 session
// ============================================================================

describe("Task #4515 (M6): 提前 mark 的失败路径必须清理", () => {
  test("mark 之后立即抛错时 session 不被永久占用", async () => {
    const repl = makeRepl();

    // ★ 判别点：`setMode("executing")` 紧跟在 mark 之后。
    //   - 修复前：mark 在 try 之外，setMode 抛错 → finally 不执行 → 永久占用
    //   - 修复后：mark + setMode 都在 try 内 → finally 一定释放
    //   （故意不用 getTracer 之类的点：它在 mark 之前，抛错时本来就不会漏）
    repl.setMode = vi.fn().mockImplementation(() => {
      throw new Error("simulated failure right after mark");
    });

    await expect(
      repl.executeInternal("x", { showPrompt: false, sessionId: "sess_X" }),
    ).rejects.toThrow();

    // ★ 核心断言：失败后该 session 必须回到空闲（否则 EventHandler 门禁永久关着）
    expect(repl.isSessionIdle("sess_X")).toBe(true);
    expect(repl.isIdle()).toBe(true);
    expect(repl.isExecuting).toBe(false);
  });

  test("tracer 不可用（mark 之前的失败）也不会留下占用", async () => {
    const repl = makeRepl();

    const core = await import("@ai-setting/roy-bot-core");
    const provider = core.getTracerProvider();
    const origGetTracer = provider.getTracer.bind(provider);
    (provider as any).getTracer = () => {
      throw new Error("simulated tracer failure");
    };

    try {
      await expect(
        repl.executeInternal("x", { showPrompt: false, sessionId: "sess_X" }),
      ).rejects.toThrow();
      expect(repl.isSessionIdle("sess_X")).toBe(true);
      expect(repl.isIdle()).toBe(true);
    } finally {
      (provider as any).getTracer = origGetTracer;
    }
  });

  test("onExecute 抛错时 session 正常释放（既有行为的回归护栏）", async () => {
    const repl = makeRepl(async () => {
      throw new Error("boom");
    });

    await repl.executeInternal("x", { showPrompt: false, sessionId: "sess_Y" });

    expect(repl.isSessionIdle("sess_Y")).toBe(true);
    expect(repl.isIdle()).toBe(true);
  });
});
