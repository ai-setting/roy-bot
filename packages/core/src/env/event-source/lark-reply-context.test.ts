/**
 * Task #5212 — lark 引用消息上下文（replyContext）
 *
 * lark-cli `im.message.receive_v1` 简化格式顶层已带
 * root_id / parent_id（reply_to）/ thread_id 字段（schema 实证），
 * 但 extractMetadata 只提取 chat_id/message_id/chat_type/
 * message_type/sender_id —— 引用字段全部丢弃，agent 不知道
 * 当前消息是对哪条消息的回复。
 *
 * 本组测试守护：
 *   1. 简化格式 + 嵌套格式都能提取 root_id/parent_id/thread_id
 *   2. metadata.replyContext 结构（rootId/parentId/threadId）
 *   3. 无引用字段时不产生 replyContext（undefined，不空对象）
 *   4. replyChannel / recommendedAction.replyTo 语义不被破坏
 *
 * ★ Task #5212 DS review 补强（opencodego/deepseek-v4.1-flash）：
 *   A5 — lean 渠道 prompt 长度守护（<= 5300，防膨胀）
 *   A6 — replyContext 必须进入 **agent 可见文本**（需求核心：
 *        「让 agent LLM 看到是对某消息 id 的回复」）。此前只写进
 *        metadata，而 agent 的 user message = payload.message =
 *        {rawData, recommendedAction, triggerEventId?} → 不含 metadata
 *        → agent 拿不到 parentId，需求未闭环。
 *   MINOR-2 — 嵌套格式 thread_id 覆盖
 *   MINOR-3 — 归一优先级（嵌套 parent_id 优先于顶层 reply_to）锁定
 */

import { describe, test, expect } from "bun:test";
import {
  extractMetadata,
  buildLarkChannelSystemPrompt,
  LARK_PROMPT_LENGTH_BUDGET,
} from "./event-source-handlers";

describe("extractMetadata replyContext（Task #5212 lark 引用消息）", () => {
  // 简化格式（lark-cli event consume 实际吐出的形态）
  function makeSimplifiedEvent(overrides: Record<string, unknown> = {}): any {
    return {
      type: "im.message.receive_v1",
      profile: "tongzhuli",
      message_id: "om_reply_002",
      chat_id: "oc_chat_001",
      chat_type: "group",
      message_type: "text",
      content: "好的收到",
      sender_id: "ou_user_001",
      ...overrides,
    };
  }

  test("简化格式：root_id/parent_id/thread_id 提取进 metadata.replyContext", () => {
    const { metadata } = extractMetadata(
      makeSimplifiedEvent({
        root_id: "om_root_001",
        reply_to: "om_parent_001",
        thread_id: "om_thread_001",
      }),
      "im.message.receive_v1",
    );
    expect(metadata.replyContext).toEqual({
      rootId: "om_root_001",
      parentId: "om_parent_001",
      threadId: "om_thread_001",
    });
  });

  test("简化格式：只有 reply_to（无 root/thread）时只填 parentId", () => {
    const { metadata } = extractMetadata(
      makeSimplifiedEvent({ reply_to: "om_parent_001" }),
      "im.message.receive_v1",
    );
    expect(metadata.replyContext).toEqual({ parentId: "om_parent_001" });
  });

  test("嵌套格式：event.message.root_id/parent_id 同样提取", () => {
    const { metadata } = extractMetadata(
      {
        type: "im.message.receive_v1",
        event: {
          header: { event_type: "im.message.receive_v1", app_id: "cli_x" },
          message: {
            message_id: "om_reply_002",
            chat_id: "oc_chat_001",
            chat_type: "p2p",
            message_type: "text",
            content: "{}",
            root_id: "om_root_001",
            parent_id: "om_parent_001",
          },
          sender: { sender_id: { open_id: "ou_1" } },
        },
      },
      "im.message.receive_v1",
    );
    expect(metadata.replyContext).toEqual({
      rootId: "om_root_001",
      parentId: "om_parent_001",
    });
  });

  test("无引用字段：replyContext 为 undefined（不产生空对象）", () => {
    const { metadata } = extractMetadata(
      makeSimplifiedEvent(),
      "im.message.receive_v1",
    );
    expect(metadata.replyContext).toBeUndefined();
  });

  test("replyTo 语义不破坏：messageId 仍是当前消息 id", () => {
    const { metadata, replyChannel, recommendedAction } = extractMetadata(
      makeSimplifiedEvent({ reply_to: "om_parent_001" }),
      "im.message.receive_v1",
    );
    expect(metadata.messageId).toBe("om_reply_002");
    expect(replyChannel?.messageId).toBe("om_reply_002");
    expect(recommendedAction?.replyTo?.messageId).toBe("om_reply_002");
  });

  test("card.action.trigger 事件（无引用字段）不产生 replyContext", () => {
    const { metadata } = extractMetadata(
      makeSimplifiedEvent(),
      "card.action.trigger",
    );
    expect(metadata.replyContext).toBeUndefined();
  });

  // ── MINOR-3：归一优先级锁定 ──
  //   嵌套同时含 event.message.parent_id 与顶层 reply_to 时取 parent_id
  //   （嵌套 = 飞书原生字段，更权威；顶层 reply_to 是 lark-cli 简化形态）。
  test("MINOR-3 归一优先级：嵌套 parent_id 优先于顶层 reply_to", () => {
    const { metadata } = extractMetadata(
      {
        type: "im.message.receive_v1",
        reply_to: "om_top_reply_to",
        event: {
          header: { event_type: "im.message.receive_v1", app_id: "cli_x" },
          message: {
            message_id: "om_reply_002",
            chat_id: "oc_chat_001",
            parent_id: "om_nested_parent",
          },
          sender: { sender_id: { open_id: "ou_1" } },
        },
      },
      "im.message.receive_v1",
    );
    expect(metadata.replyContext?.parentId).toBe("om_nested_parent");
  });

  // ── MINOR-2：嵌套格式 thread_id 覆盖 ──
  test("MINOR-2 嵌套格式：thread_id 也被提取", () => {
    const { metadata } = extractMetadata(
      {
        type: "im.message.receive_v1",
        event: {
          header: { event_type: "im.message.receive_v1", app_id: "cli_x" },
          message: {
            message_id: "om_reply_002",
            chat_id: "oc_chat_001",
            root_id: "om_root_001",
            parent_id: "om_parent_001",
            thread_id: "om_thread_001",
          },
          sender: { sender_id: { open_id: "ou_1" } },
        },
      },
      "im.message.receive_v1",
    );
    expect(metadata.replyContext).toEqual({
      rootId: "om_root_001",
      parentId: "om_parent_001",
      threadId: "om_thread_001",
    });
  });
});

// =============================================================================
// ★ DS review A6：replyContext 必须进入 agent 可见文本
// =============================================================================
//
// agent 实际收到的 user message = payload.message =
//   JSON.stringify({ rawData, recommendedAction, triggerEventId? })
// metadata.replyContext 只写进 evt.metadata / evt.payload.metadata，
// **不进** agent 可见文本 → agent 看不到「对哪条消息的回复」→ 需求未闭环。
//
// 修法：把 replyContext 挂到 recommendedAction 上（recommendedAction 是
// agent 可见文本的一部分），并在 prompt 章节里指向该真实位置。
describe("A6 agent 可见文本含 replyContext（DS review MAJOR-2）", () => {
  function makeSimplifiedEvent(overrides: Record<string, unknown> = {}): any {
    return {
      type: "im.message.receive_v1",
      profile: "tongzhuli",
      message_id: "om_reply_002",
      chat_id: "oc_chat_001",
      chat_type: "group",
      message_type: "text",
      content: "好的收到",
      sender_id: "ou_user_001",
      ...overrides,
    };
  }

  test("lean 模式：recommendedAction.replyContext 带 parentId/rootId/threadId", () => {
    const { recommendedAction } = extractMetadata(
      makeSimplifiedEvent({
        root_id: "om_root_001",
        reply_to: "om_parent_001",
        thread_id: "om_thread_001",
      }),
      "im.message.receive_v1",
    );
    expect(recommendedAction?.replyContext).toEqual({
      rootId: "om_root_001",
      parentId: "om_parent_001",
      threadId: "om_thread_001",
    });
  });

  test("legacy 模式：recommendedAction.replyContext 同样带引用字段", () => {
    const { recommendedAction } = extractMetadata(
      makeSimplifiedEvent({ reply_to: "om_parent_001", channelPromptMode: "legacy" }),
      "im.message.receive_v1",
    );
    expect(recommendedAction?.replyContext?.parentId).toBe("om_parent_001");
  });

  test("无引用字段：recommendedAction.replyContext 为 undefined（不产生空对象）", () => {
    const { recommendedAction } = extractMetadata(
      makeSimplifiedEvent(),
      "im.message.receive_v1",
    );
    expect(recommendedAction?.replyContext).toBeUndefined();
  });

  test("agent 可见文本（payload.message 序列化后）含 parentId 的值", () => {
    // 复刻 event-source-handlers 的 message 构造：
    //   JSON.stringify({ rawData, recommendedAction })
    const rawEvent = makeSimplifiedEvent({ reply_to: "om_parent_001" });
    const rawData = JSON.stringify(rawEvent);
    const { recommendedAction } = extractMetadata(rawEvent, "im.message.receive_v1");
    const agentVisibleText = JSON.stringify({ rawData, recommendedAction });
    expect(agentVisibleText).toContain("om_parent_001");
    expect(agentVisibleText).toContain("replyContext");
  });

  test("A3 不破坏：replyContext 存在时 replyTo.messageId 仍是当前消息 id", () => {
    const { recommendedAction } = extractMetadata(
      makeSimplifiedEvent({ reply_to: "om_parent_001" }),
      "im.message.receive_v1",
    );
    expect(recommendedAction?.replyTo?.messageId).toBe("om_reply_002");
    expect(recommendedAction?.replyContext?.parentId).toBe("om_parent_001");
  });
});

// =============================================================================
// ★ DS review A5：渠道 prompt 长度守护（防膨胀）
// =============================================================================
describe("A5 lean 渠道 prompt 长度守护（DS review MAJOR-1）", () => {
  // 单一来源常量（DS review MINOR-3）：与 lark-channel-system-prompt.test.ts
  // (G) 组共用同一个 LARK_PROMPT_LENGTH_BUDGET，避免两处写死漂移。
  const PROMPT_LENGTH_BUDGET = LARK_PROMPT_LENGTH_BUDGET;

  test("渠道 prompt 长度不超上限（含引用消息上下文章节）", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(sp.length).toBeLessThanOrEqual(PROMPT_LENGTH_BUDGET);
  });

  test("渠道 prompt 含引用消息上下文章节（章节不能被压缩掉）", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(sp).toMatch(/引用消息上下文/);
    // 文案必须指向 agent 真实能看到的位置（recommendedAction.replyContext），
    // 不能指向 agent 看不到的 metadata.replyContext（DS review MINOR-1）。
    expect(sp).toMatch(/recommendedAction\.replyContext/);
  });
});
