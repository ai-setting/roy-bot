/**
 * @fileoverview Task #5144 — ES-M1 端到端接线测试（handleEvent → metadata.systemPrompt）
 *
 * 验证 LarkCliInstance.handleEvent 在 lean/legacy 两种模式下：
 *   - lean：evt.metadata.systemPrompt = 渠道静态 prompt（逐字节稳定）
 *   - legacy：evt.metadata.systemPrompt = undefined（与旧版一致）
 *   - 两条消息（不同 chatId/messageId）：metadata.systemPrompt 逐字节一致
 *     （channel prompt 的 cache 前缀稳定性 —— 实测 LLM cache usage 的前置断言）
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createChildProcessMockModule } from "../../test-utils/child-process-mock";

const spawnMock = mock((cmd: string, args: string[]) => ({
  stdout: { on: () => {} },
  stderr: { on: () => {} },
  on: (event: string, cb: Function) => {
    if (event === "close") cb(0);
  },
  kill: () => {},
  pid: 99996,
} as any));

const execStub = mock((_cmd: string, cb?: Function) => {
  if (typeof cb === "function") cb(null, { stdout: "", stderr: "" });
  return { on: () => {}, kill: () => {}, pid: 99995 } as any;
});

beforeEach(() => {
  spawnMock.mockClear();
  execStub.mockClear();
  mock.module("child_process", () =>
    createChildProcessMockModule({
      spawn: spawnMock,
      exec: execStub as any,
    }),
  );
});

function makeLarkMessageEvent(overrides: any = {}): any {
  return {
    type: "im.message.receive_v1",
    event_id: overrides.eventId,
    event: {
      header: {
        event_type: "im.message.receive_v1",
        app_id: overrides.appId || "cli_app123",
        tenant_key: "tenant_xyz",
      },
      message: {
        message_id: overrides.messageId || "om_msg_001",
        chat_id: overrides.chatId || "oc_chat_001",
        chat_type: overrides.chatType || "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
      sender: {
        sender_id: { open_id: "ou_user_001" },
      },
    },
  };
}

async function captureEvents(config: any, rawEvents: any[]): Promise<any[]> {
  const { larkCliHandler } = await import("./event-source-handlers");
  const { LarkCliInstance } = await import("./event-source-handlers");
  LarkCliInstance.__resetDedupForTest();
  const instance = larkCliHandler.createInstance(config);
  const captured: any[] = [];
  instance.onEvent((evt: any) => {
    captured.push(evt);
  });
  for (const raw of rawEvents) {
    await (instance as any).handleEvent(JSON.stringify(raw));
  }
  return captured;
}

const leanConfig = {
  id: "es-e2e-lean",
  name: "lean",
  type: "lark-cli",
  enabled: true,
  profile: "tongzhuli",
} as any;

const legacyConfig = {
  id: "es-e2e-legacy",
  name: "legacy",
  type: "lark-cli",
  enabled: true,
  profile: "tongzhuli",
  channelPromptMode: "legacy",
} as any;

describe("ES-M1 端到端：handleEvent → metadata.systemPrompt", () => {
  test("lean：metadata.systemPrompt 含渠道规则（关键 0 + profile）", async () => {
    const events = await captureEvents(leanConfig, [makeLarkMessageEvent()]);
    expect(events).toHaveLength(1);
    const sp = events[0].metadata.systemPrompt as string;
    expect(sp).toBeDefined();
    expect(sp).toContain("关键 0");
    expect(sp).toContain('profile="tongzhuli"');
    // 用户配置的 config.systemPrompt（未配置时不存在用户前缀）——
    // 这里 channel prompt 是唯一内容来源
    expect(sp).toContain("飞书回复规范");
    // ★ DS review MINOR-1（Task #5144）：payload.metadata 与 evt.metadata
    //   两处注入的显式端到端断言（同一变量，逐字节一致）
    expect(events[0].payload.metadata.systemPrompt).toBe(sp);
  });

  test("lean：同一渠道连续 3 条消息（不同 chatId/messageId）systemPrompt 逐字节一致", async () => {
    const events = await captureEvents(leanConfig, [
      makeLarkMessageEvent({ eventId: "evt_a", chatId: "oc_a", messageId: "om_a" }),
      makeLarkMessageEvent({ eventId: "evt_b", chatId: "oc_b", messageId: "om_b" }),
      makeLarkMessageEvent({ eventId: "evt_c", chatId: "oc_c", messageId: "om_c" }),
    ]);
    expect(events).toHaveLength(3);
    const [a, b, c] = events.map((e) => e.metadata.systemPrompt as string);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("lean：payload.message 的 recommendedAction 是动态卡片（无 mktemp/30KB 规则文本）", async () => {
    const events = await captureEvents(leanConfig, [makeLarkMessageEvent()]);
    const payload = events[0].payload;
    const action = payload.recommendedAction;
    expect(action.action).not.toContain("mktemp");
    expect(action.action).not.toMatch(/30\s*KB/);
    expect(action.action).toMatch(/system prompt/);
    expect(action.staticRulesInSystemPrompt).toBe(true);
    // message 信封里 recommendedAction 也是瘦身版
    const envelope = JSON.parse(payload.message as string);
    expect(envelope.recommendedAction.action).not.toContain("mktemp");
    expect(envelope.recommendedAction.replyTo.chatId).toBe("oc_chat_001");
    expect(envelope.recommendedAction.replyTo.profile).toBe("tongzhuli");
  });

  test("legacy：metadata.systemPrompt 为 undefined，action 为长模板（与旧版一致）", async () => {
    const events = await captureEvents(legacyConfig, [makeLarkMessageEvent()]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.systemPrompt).toBeUndefined();
    const action = events[0].payload.recommendedAction;
    expect(action.action).toContain("mktemp");
    expect(action.action).toMatch(/30\s*KB/);
    expect(action.staticRulesInSystemPrompt).toBeUndefined();
  });

  test("lean：config.systemPrompt 用户配置在前 + 渠道 prompt 在后（拼接顺序稳定）", async () => {
    const config = { ...leanConfig, id: "es-e2e-user-sp", systemPrompt: "USER-CHANNEL-CONTEXT" };
    const events = await captureEvents(config, [
      makeLarkMessageEvent(),
      makeLarkMessageEvent({ eventId: "evt_b", chatId: "oc_b", messageId: "om_b" }),
    ]);
    const [a, b] = events.map((e) => e.metadata.systemPrompt as string);
    expect(a).toContain("USER-CHANNEL-CONTEXT");
    expect(a.indexOf("USER-CHANNEL-CONTEXT")).toBeLessThan(a.indexOf("关键 0"));
    expect(a).toBe(b);
  });
});
