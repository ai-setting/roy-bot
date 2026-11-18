/**
 * @fileoverview AskUserHandler Timeout Test (Task #1967)
 *
 * TDD: 测试 shared ask-user-handler.getUserChoice 的 timeout 支持，
 *      与 interactive.ts 中的 REPL.promptUser 行为保持一致。
 *
 * 关键约束：
 *  - 默认 timeout 120000ms（生产要求）
 *  - 测试使用短 timeout 注入（30-50ms），绝不真实等待 2 分钟
 *  - timeout 后返回 sentinel，调用方用 `isAskUserTimeoutSentinel()` 识别
 *  - 用户回复与 timeout 竞态：resolve 仅一次
 */

import { describe, test, expect, vi } from "bun:test";
import { EventEmitter } from "node:events";

import {
  ASK_USER_TIMEOUT_MS,
  ASK_USER_TIMEOUT_SENTINEL_PREFIX,
  getUserChoice,
  isAskUserTimeoutSentinel,
  type AskUserErrorInfo,
} from "./ask-user-handler";

/**
 * MockReadline — 模拟 readline.Interface 但用 EventEmitter
 */
class MockReadline extends EventEmitter {
  public readonly setPrompt = vi.fn();
  public readonly prompt = vi.fn();
  public readonly close = vi.fn();

  feedLine(value: string): boolean {
    return this.emit("line", value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const baseErrorInfo: AskUserErrorInfo = {
  query: "请选择处理方式 (选项: A, B, C)",
  sessionId: "wf_x",
  agentSessionId: "ag_x",
  nodeId: "node_x",
  nodeType: "agent",
};

// ==========================================================================
// Sentinel 检测
// ==========================================================================

describe("ask-user-handler sentinel 检测", () => {
  test("isAskUserTimeoutSentinel 识别 sentinel", () => {
    expect(isAskUserTimeoutSentinel("__ASK_USER_TIMEOUT__:")).toBe(false); // 不是 sentinel, 是前缀
    expect(isAskUserTimeoutSentinel("__ASK_USER_TIMEOUT__:{}")).toBe(true);
    expect(isAskUserTimeoutSentinel("__ASK_USER_ERROR__:foo")).toBe(false);
    expect(isAskUserTimeoutSentinel(42)).toBe(false);
    expect(isAskUserTimeoutSentinel(null)).toBe(false);
    expect(isAskUserTimeoutSentinel(undefined)).toBe(false);
  });

  test("ASK_USER_TIMEOUT_SENTINEL_PREFIX 是常量字符串", () => {
    expect(ASK_USER_TIMEOUT_SENTINEL_PREFIX).toBe("__ASK_USER_TIMEOUT__:");
  });
});

// ==========================================================================
// 默认 timeout
// ==========================================================================

describe("默认 timeout 常量", () => {
  test("ASK_USER_TIMEOUT_MS === 120000", () => {
    expect(ASK_USER_TIMEOUT_MS).toBe(120_000);
  });
});

// ==========================================================================
// A — 用户正常回复（先于 timeout）
// ==========================================================================

describe("A. 用户在 timeout 前回复", () => {
  test("用户输入选项编号 1 → 返回对应选项文本", async () => {
    const rl = new MockReadline();
    const promise = getUserChoice(rl as any, baseErrorInfo, { timeoutMs: 200 });

    // 模拟用户立即输入 "1"
    rl.feedLine("1");

    const result = await promise;
    expect(result).toBe("A");
    // listen cleanup
    expect(rl.listenerCount("line")).toBe(0);
  });

  test("用户输入自由文本 → 原样返回", async () => {
    const rl = new MockReadline();
    const promise = getUserChoice(rl as any, baseErrorInfo, { timeoutMs: 200 });

    rl.feedLine("hello world");

    const result = await promise;
    expect(result).toBe("hello world");
    expect(rl.listenerCount("line")).toBe(0);
  });
});

// ==========================================================================
// B — timeout 触发
// ==========================================================================

describe("B. timeout 触发后返回 sentinel", () => {
  test("30ms 后 timeout，返回 sentinel 字符串", async () => {
    const rl = new MockReadline();
    const promise = getUserChoice(rl as any, baseErrorInfo, { timeoutMs: 30 });

    await sleep(80);

    const result = await promise;
    expect(typeof result).toBe("string");
    expect(result.startsWith(ASK_USER_TIMEOUT_SENTINEL_PREFIX)).toBe(true);
    expect(isAskUserTimeoutSentinel(result)).toBe(true);
  });

  test("timeout 触发的 sentinel 解码后包含原始 errorInfo", async () => {
    const rl = new MockReadline();
    const promise = getUserChoice(rl as any, baseErrorInfo, { timeoutMs: 30 });

    await sleep(80);

    const result: string = await promise;
    const payload = JSON.parse(
      result.substring(ASK_USER_TIMEOUT_SENTINEL_PREFIX.length),
    );

    expect(payload.query).toBe(baseErrorInfo.query);
    expect(payload.sessionId).toBe(baseErrorInfo.sessionId);
    expect(payload.agentSessionId).toBe(baseErrorInfo.agentSessionId);
    expect(payload.nodeId).toBe(baseErrorInfo.nodeId);
    expect(payload.nodeType).toBe(baseErrorInfo.nodeType);
    expect(payload.timeoutMs).toBe(30);
    expect(typeof payload.timestamp).toBe("number");
  });

  test("timeout 后 line listener 已被清理", async () => {
    const rl = new MockReadline();
    const promise = getUserChoice(rl as any, baseErrorInfo, { timeoutMs: 30 });

    await sleep(80);
    await promise;

    expect(rl.listenerCount("line")).toBe(0);
  });
});

// ==========================================================================
// C — 竞态：用户回复 与 timeout 同时到达
// ==========================================================================

describe("C. 竞态: resolve 恰好一次", () => {
  test("回复先到达（即使后续超时）只 resolve 一次", async () => {
    const rl = new MockReadline();
    let resolveCount = 0;
    let resolvedValue: string | undefined;

    const promise = getUserChoice(rl as any, baseErrorInfo, { timeoutMs: 30 }).then(
      (v: string) => {
        resolveCount++;
        resolvedValue = v;
        return v;
      },
    );

    // 立即回复
    rl.feedLine("1");

    const result = await promise;
    expect(result).toBe("A");

    // 等待远超 timeout
    await sleep(80);

    // 验证: 只 resolve 了一次, 值依然是 "A"
    expect(resolveCount).toBe(1);
    expect(resolvedValue).toBe("A");
  });

  test("timeout 先到达后, line listener 已被清理, 后续 feedLine 不影响结果", async () => {
    const rl = new MockReadline();
    const promise = getUserChoice(rl as any, baseErrorInfo, { timeoutMs: 30 });

    await sleep(80);
    const result = await promise;
    expect(isAskUserTimeoutSentinel(result)).toBe(true);

    // 尝试再发 line — 不应该触发任何 listener
    rl.feedLine("1");

    // 再等一段, 确保没有任何 unhandled promise 异常
    await sleep(50);

    expect(rl.listenerCount("line")).toBe(0);
  });
});

// ==========================================================================
// D — 向后兼容：opts 是可选参数
// ==========================================================================

describe("D. 向后兼容", () => {
  test("不传 opts 时使用默认 ASK_USER_TIMEOUT_MS", async () => {
    // 我们无法真正等 2 分钟, 这里只断言函数签名/调用不抛错
    const rl = new MockReadline();
    const promise = getUserChoice(rl as any, baseErrorInfo);
    // 立即喂一行, 让测试不超时
    rl.feedLine("C");
    const result = await promise;
    expect(result).toBe("C");
    expect(rl.listenerCount("line")).toBe(0);
  });

  test("opts.timeoutMs 为 0 时立即 timeout", async () => {
    const rl = new MockReadline();
    const promise = getUserChoice(rl as any, baseErrorInfo, { timeoutMs: 0 });

    const result = await promise;
    expect(isAskUserTimeoutSentinel(result)).toBe(true);
  });
});
