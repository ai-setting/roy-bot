/**
 * Blocker 1（Task #4111 P0-2 / #4108 v2 根因）回归测试。
 *
 * 关键：直接调用**真实生产函数** `buildRunEnvContext`（agent-component.ts），
 * 不再 inline 复刻优先级逻辑 —— 这样 revert 生产代码会导致测试失败
 * （旧测试 inline re-implement，revert 后仍全绿 = tautological）。
 *
 * 覆盖：
 *   1. effective envEvent.metadata.replyChannel 覆盖被污染的 parent ALS replyChannel
 *   2. effective 无 replyChannel → 继承 parent（向后兼容）
 *   3. 无 effective envEvent → 回落 parent envEvent + replyChannel
 *   4. envBoundParentTaskId 正确透传
 */

import { describe, expect, test } from "bun:test";
import { buildRunEnvContext } from "./agent-component";

function rc(chatId: string, messageId: string): any {
  return { type: "lark", chatId, messageId, userId: "ou_x", identity: "bot" };
}

describe("buildRunEnvContext — real production EnvContext builder", () => {
  test("effective envEvent.metadata.replyChannel overrides polluted parent ALS replyChannel (P0-2)", () => {
    const parentEnvContext = {
      userId: "ou_parent",
      replyChannel: rc("oc_3990_polluted_chat", "om_polluted_parent_msg"),
    } as any;

    const effectiveContext = {
      sessionId: "sess_child",
      metadata: {},
      envEvent: {
        type: "event-source.event.lark-cli",
        metadata: { replyChannel: rc("oc_4106_correct_chat", "om_current_event_msg") },
      },
    } as any;

    const ctx = buildRunEnvContext({
      effectiveContext,
      parentEnvContext,
      envBoundParentTaskId: 4106,
    });

    expect(ctx.replyChannel?.chatId).toBe("oc_4106_correct_chat");
    expect(ctx.replyChannel?.messageId).toBe("om_current_event_msg");
    expect(ctx.replyChannel?.chatId).not.toBe("oc_3990_polluted_chat");
    expect(ctx.envEvent).toBe(effectiveContext.envEvent);
    expect(ctx.parentTaskId).toBe(4106);
  });

  test("effective envEvent without replyChannel → inherits parent replyChannel (backward compat)", () => {
    const parentEnvContext = {
      userId: "ou_parent",
      replyChannel: rc("oc_parent_chat", "om_parent_msg"),
    } as any;

    const effectiveContext = {
      sessionId: "sess_child",
      metadata: {},
      envEvent: { type: "child-event", metadata: {} },
    } as any;

    const ctx = buildRunEnvContext({
      effectiveContext,
      parentEnvContext,
      envBoundParentTaskId: undefined,
    });

    expect(ctx.replyChannel?.chatId).toBe("oc_parent_chat");
    expect(ctx.replyChannel?.messageId).toBe("om_parent_msg");
    expect(ctx.parentTaskId).toBeUndefined();
  });

  test("no effective envEvent → falls back to parent envEvent + replyChannel", () => {
    const parentEnvContext = {
      userId: "ou_parent",
      envEvent: { type: "parent-event" },
      replyChannel: rc("oc_parent_chat", "om_parent_msg"),
    } as any;

    const effectiveContext = {
      sessionId: "sess_child",
      metadata: {},
      // no envEvent
    } as any;

    const ctx = buildRunEnvContext({
      effectiveContext,
      parentEnvContext,
      envBoundParentTaskId: undefined,
    });

    expect(ctx.envEvent).toBe(parentEnvContext.envEvent);
    expect(ctx.replyChannel?.chatId).toBe("oc_parent_chat");
  });

  test("no parent context (first run) → uses effective envEvent replyChannel, agentContext initialized", () => {
    const effectiveContext = {
      sessionId: "sess_first",
      metadata: {},
      envEvent: { type: "evt", metadata: { replyChannel: rc("oc_first", "om_first") } },
    } as any;

    const ctx = buildRunEnvContext({
      effectiveContext,
      parentEnvContext: undefined,
      envBoundParentTaskId: undefined,
    });

    expect(ctx.replyChannel?.chatId).toBe("oc_first");
    expect(ctx.agentContext).toBeDefined();
  });
});
