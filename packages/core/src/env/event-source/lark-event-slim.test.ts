/**
 * ★ Task #5473 — 精简飞书 event→agent 消息内容（去冗余栏位）
 *
 * 背景：agent 收到的 user message = payload.message =
 *   JSON.stringify({ rawData, recommendedAction, triggerEventId? })
 * 其中 rawData 是**完整原始 event JSON**，含大量 agent 用不到的
 * 冗余栏位（createTime / updateTime / type / event_id / timestamp /
 * id / message_type / sender_type ...），白白消耗 token。
 *
 * 本测试守护：payload.message 信封里的 rawData 只保留
 *   chat_id / message_id / sender_id / chat_type / content / mentions
 * 等必要字段；而 payload.rawEvent（下游 self-echo filter / dedup /
 * extractMetadata 的数据源）**保持完整不动**。
 */
import { describe, test, expect, beforeEach } from "bun:test";

describe("Task #5473 精简飞书 event→agent 消息字段", () => {
  // 真实 nohup.out 中的简化格式（lark-cli event consume 输出）
  function makeSimplifiedLarkEvent(overrides: any = {}): any {
    return {
      type: "im.message.receive_v1",
      event_id: overrides.event_id || "b557f678055d679a18ebb79986dc0792",
      timestamp: overrides.timestamp || "1790651558434",
      id: overrides.messageId || "om_x100b6486849189",
      message_id: overrides.messageId || "om_x100b6486849189",
      create_time: overrides.create_time || "1790651557929",
      update_time: overrides.update_time || "1790651557930",
      chat_id: overrides.chatId || "oc_ce59231c7152ae7e2e948608e8294b18",
      chat_type: overrides.chatType || "group",
      message_type: "text",
      sender_id: overrides.senderId || "ou_1759934f98e0677e17f09591389c24f1",
      sender_type: "user",
      content: overrides.content || "你好，帮我看看",
      ...(overrides.mentions ? { mentions: overrides.mentions } : {}),
    };
  }

  async function capture(config: any, rawEvent: any): Promise<any> {
    const { larkCliHandler } = await import("./event-source-handlers");
    const { LarkCliInstance } = await import("./event-source-handlers");
    LarkCliInstance.__resetDedupForTest();
    const instance = larkCliHandler.createInstance(config);
    let captured: any = null;
    instance.onEvent((evt: any) => {
      captured = evt;
    });
    await (instance as any).handleEvent(JSON.stringify(rawEvent));
    return captured;
  }

  const leanConfig = {
    id: "es-slim-test",
    name: "slim-test",
    type: "lark-cli",
    enabled: true,
    channelPromptMode: "lean",
    profile: "tongzhuli",
  };

  beforeEach(async () => {
    const { LarkCliInstance } = await import("./event-source-handlers");
    LarkCliInstance.__resetDedupForTest();
  });

  test("payload.message 信封里不含被删字段（createTime/updateTime/type/event_id/timestamp/id/message_type/sender_type）", async () => {
    const evt = await capture(leanConfig, makeSimplifiedLarkEvent());
    expect(evt).not.toBeNull();
    const envelope = JSON.parse(evt.payload.message as string);
    const raw = envelope.rawData as Record<string, unknown>;

    // 被删字段：不允许出现在 agent 可见信封里
    const forbidden = [
      "createTime",
      "updateTime",
      "type",
      "event_id",
      "timestamp",
      "id",
      "message_type",
      "sender_type",
      // 驼峰变体也一并禁（create_time / update_time 同义冗余）
      "create_time",
      "update_time",
    ];
    for (const key of forbidden) {
      expect(Object.keys(raw)).not.toContain(key);
    }
    // 整个序列化文本也不含这些键名
    const text = evt.payload.message as string;
    expect(text).not.toContain('"event_id"');
    expect(text).not.toContain('"message_type"');
    expect(text).not.toContain('"sender_type"');
    expect(text).not.toContain('"create_time"');
  });

  test("payload.message 信封里保留必要字段（chat_id/message_id/sender_id/chat_type/content）", async () => {
    const evt = await capture(leanConfig, makeSimplifiedLarkEvent());
    const envelope = JSON.parse(evt.payload.message as string);
    const raw = envelope.rawData as Record<string, unknown>;

    expect(raw.chat_id).toBe("oc_ce59231c7152ae7e2e948608e8294b18");
    expect(raw.message_id).toBe("om_x100b6486849189");
    expect(raw.sender_id).toBe("ou_1759934f98e0677e17f09591389c24f1");
    expect(raw.chat_type).toBe("group");
    expect(raw.content).toBe("你好，帮我看看");
  });

  test("mentions 字段保留（@ 收件人语义，self-echo 协作规则需要）", async () => {
    const evt = await capture(
      leanConfig,
      makeSimplifiedLarkEvent({
        mentions: [{ key: "@_user_1", id: "ou_bot_001", name: "通助理" }],
      }),
    );
    const envelope = JSON.parse(evt.payload.message as string);
    const raw = envelope.rawData as Record<string, unknown>;
    expect(Array.isArray(raw.mentions)).toBe(true);
    expect((raw.mentions as any[])[0].id).toBe("ou_bot_001");
  });

  test("payload.rawEvent 保持完整（下游 self-echo filter / dedup 数据源不动）", async () => {
    const evt = await capture(leanConfig, makeSimplifiedLarkEvent());
    const rawEvent = evt.payload.rawEvent as Record<string, unknown>;

    // 下游门禁依赖的字段必须还在 rawEvent 上
    expect(rawEvent.sender_type).toBe("user");
    expect(rawEvent.event_id).toBe("b557f678055d679a18ebb79986dc0792");
    expect(rawEvent.message_type).toBe("text");
    expect(rawEvent.chat_type).toBe("group");
    expect(rawEvent.sender_id).toBe("ou_1759934f98e0677e17f09591389c24f1");
  });

  test("recommendedAction.replyTo 四元组不受影响（profile/chatId/messageId）", async () => {
    const evt = await capture(leanConfig, makeSimplifiedLarkEvent());
    const envelope = JSON.parse(evt.payload.message as string);
    const replyTo = envelope.recommendedAction.replyTo;

    expect(replyTo.profile).toBe("tongzhuli");
    expect(replyTo.chatId).toBe("oc_ce59231c7152ae7e2e948608e8294b18");
    expect(replyTo.messageId).toBe("om_x100b6486849189");
  });

  test("嵌套格式（webhook）同样被精简", async () => {
    const nested = {
      type: "im.message.receive_v1",
      event_id: "evt_nested_001",
      event: {
        header: {
          event_type: "im.message.receive_v1",
          app_id: "cli_app123",
          tenant_key: "tenant_xyz",
        },
        message: {
          message_id: "om_nested_001",
          chat_id: "oc_nested_001",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "nested hi" }),
        },
        sender: { sender_id: { open_id: "ou_user_001" } },
      },
    };
    const evt = await capture(leanConfig, nested);
    const envelope = JSON.parse(evt.payload.message as string);
    const raw = envelope.rawData as Record<string, unknown>;

    // 精简后是扁平的必要字段
    expect(raw.chat_id).toBe("oc_nested_001");
    expect(raw.message_id).toBe("om_nested_001");
    expect(raw.sender_id).toBe("ou_user_001");
    expect(raw.content).toContain("nested hi");
    // 冗余字段不出现
    expect(Object.keys(raw)).not.toContain("event_id");
    expect(Object.keys(raw)).not.toContain("message_type");
    // rawEvent 原样保留嵌套结构
    const rawEvent = evt.payload.rawEvent as any;
    expect(rawEvent.event.message.message_id).toBe("om_nested_001");
  });
});
