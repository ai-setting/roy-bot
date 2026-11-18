/**
 * Task #4042 ESPlugin v2 Phase 5：端到端集成测试 + bug 回归
 *
 * 复现 #4035/#4038/#4039 三个 sub-agent 场景（简化版）：
 *   - 用户在 #4034 群（oc_4732f37a05dfaea4646792a3fe99f0d）说"调研 deepseek"
 *   - 主 agent 调 larkCliHandler.emitTriggerEvent → 拿到 triggerEventId
 *   - 主 agent 调 delegate_task(prompt=..., triggerEventId=...)
 *     → BackgroundTaskManager 创建 sub-agent task，发 task.background.completed event
 *     → event.metadata.triggerEventId === triggerEventId
 *   - CLI EventHandler 收到 event，调 EventStore 反查，buildNotifyHandlePrompt
 *   - 断言 formatted.chatId === oc_4732f37a05dfaea4646792a3fe99f0d（trigger event 的 chatId）
 *     而不是 metadata.replyChannel.chatId（fallback 老路径会发错群）
 *
 * 这是 #4035/#4038/#4039 修复的核心验证：chatId 必须来自 trigger event。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BackgroundTaskManager,
  BackgroundTaskEventTypes,
  type BackgroundTaskCompletedPayload,
} from "@ai-setting/roy-bot-core/env/task/delegate/delegate-tool";
import { EventStoreImpl } from "@ai-setting/roy-bot-core/env/event-source/event-store";
import { larkCliHandler } from "@ai-setting/roy-bot-core/env/event-source/event-source-handlers";
import { EventHandler } from "./event-handler";
import type { EnvEvent } from "@ai-setting/roy-bot-core";

// ============================================================================
// 测试 fixture（#4035/#4038/#4039 真实 chatId）
// ============================================================================

// 用户在 #4034 群触发 #4035（来自 bug #4039 实证报告）
const CHAT_4034 = "oc_4732f37a05dfaea4646792a3fe99f0d";
const MSG_4034 = "om_x100b63b2f47998a8c2b793e1c0121de";
// 用户在 #3996 群触发 #4038（sub-agent 报告发错群的群）
const CHAT_3996 = "oc_6d035f10dfbe0ff60e9c54b2066dcf91";

let tmpDir: string;
let dbPath: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "esplugin-v2-e2e-test-"));
  dbPath = join(tmpDir, "events.db");
  store = new EventStoreImpl({ dbPath });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeMockEnv() {
  return {
    subscribeAll: (_h: (e: EnvEvent) => void) => () => {},
    subscribeTo: (_t: string, _h: (e: EnvEvent) => void) => () => {},
    pushEnvEvent: () => {},
    getComponent: () => null,
  };
}

/**
 * 模拟主 agent 收到 #4034 群飞书消息后的完整链路。
 *
 * 真实链路：
 *   1. REPL 收到飞书事件（larkCliInstance.handleEvent）
 *   2. 主 agent 用 EventStore.insertTriggerEvent 落库（v2）
 *   3. 主 agent 调 delegate_task(prompt, triggerEventId)
 *   4. BackgroundTaskManager 发 task.background.completed
 *   5. CLI EventHandler 收到 event，反查 EventStore，构造 prompt
 */
async function simulateCompleteFlow(opts: {
  triggerChatId: string;
  triggerMessageId: string;
  notifyChatId: string; // 模拟 replyChannel fallback（如果 bug 还在）
  description: string;
  result: string;
}) {
  // Step 1: 主 agent emitTriggerEvent
  const triggerEventId = await larkCliHandler.emitTriggerEvent(
    {
      senderId: "ou_user_real",
      text: "请调研 DeepSeek 模型能力",
      metadata: {
        eventType: "im.message.receive_v1",
        appId: "cli_app_tongzhuli",
        chatId: opts.triggerChatId,
        chatType: "group",
        messageId: opts.triggerMessageId,
        messageType: "text",
        senderId: "ou_user_real",
        tenantKey: "tnt_tongzhuli",
      },
    },
    store,
  );

  // Step 2: 主 agent 调 delegate_task，triggerEventId 透传
  // BackgroundTaskManager 用 mock env（推 event 到 capturedEvents）
  const capturedEvents: EnvEvent[] = [];
  const env = {
    ...makeMockEnv(),
    pushEnvEvent: (e: any) => capturedEvents.push(e),
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          get: async (id: string) => ({
            id,
            info: { metadata: {} },
          }),
          create: async (sessOpts: any) => ({
            id: `sub_${Math.random().toString(36).slice(2, 10)}`,
            info: { metadata: { ...(sessOpts.metadata ?? {}) } },
          }),
          update: async () => {},
        };
      }
      return null;
    },
  };
  const mgr = new BackgroundTaskManager(env as any);

  // simulate createTask + publishCompleted
  mgr.publishBackgroundEventWithTrigger(
    BackgroundTaskEventTypes.COMPLETED,
    {
      backgroundTaskId: "bg_4035",
      subSessionId: "sub_4035",
      parentSessionId: "parent_repl_4035",
      status: "completed",
      description: opts.description,
      result: opts.result,
      executionTimeMs: 12000,
      associatedTaskId: 4035,
    } as BackgroundTaskCompletedPayload,
    "parent_repl_4035",
    triggerEventId,
  );

  expect(capturedEvents.length).toBe(1);
  const notifyEvent = capturedEvents[0];

  // 注入恶意 fallback chatId（模拟老 plugin 行为：replyChannel 错误指向其他群）
  notifyEvent.metadata.replyChannel = {
    type: "lark-cli",
    chatId: opts.notifyChatId, // ⚠️ 这就是 #4035 误发 #3996 的原因（replyChannel.chatId 是错的 fallback）
    messageId: "om_wrong_fallback",
    profile: "tongzhuli",
  };

  // Step 3: CLI EventHandler 收到 notify event
  const capturedFormatted: any[] = [];
  const handler = new EventHandler({
    env: makeMockEnv() as any,
    eventTypes: ["task.background.*"],
    onEventWithEnv: async (formatted) => {
      capturedFormatted.push(formatted);
    },
    eventStore: store,
    getHandlerForEsType: (esType: string) =>
      esType === "lark-cli" ? larkCliHandler : undefined,
  });
  await handler.handleNotifyEventForTest(notifyEvent);

  return { triggerEventId, notifyEvent, formatted: capturedFormatted[0] };
}

describe("ESPlugin v2 E2E — #4035 regression test", () => {
  test("trigger event in #4034 群 → notify event processed with #4034 chatId (not #3996 fallback)", async () => {
    const { formatted } = await simulateCompleteFlow({
      triggerChatId: CHAT_4034, // oc_4732f37a05dfaea4646792a3fe99f0d
      triggerMessageId: MSG_4034, // om_x100b63b2f47998a8c2b793e1c0121de
      notifyChatId: CHAT_3996, // 恶意 fallback: 老路径会发到 #3996 群（错的）
      description: "调研 DeepSeek 模型能力",
      result: "DeepSeek 是 MoE 架构...",
    });

    expect(formatted).toBeDefined();
    // ★ 核心断言：chatId 必须来自 trigger event (#4034 群)，不是 fallback (#3996 群)
    expect(formatted.chatId).toBe(CHAT_4034);
    expect(formatted.chatId).not.toBe(CHAT_3996);
    // promptText 必须显式包含 trigger chatId
    expect(formatted.message).toContain(CHAT_4034);
    // promptText 必须显式包含 trigger messageId
    expect(formatted.message).toContain(MSG_4034);
    // 提示主 agent "不要 fallback"
    expect(formatted.message).toContain("不要 fallback");
  });

  test("trigger event in #3996 群 → notify event processed with #3996 chatId (consistent)", async () => {
    // 另一场景：触发群是 #3996
    const { formatted } = await simulateCompleteFlow({
      triggerChatId: CHAT_3996,
      triggerMessageId: "om_msg_3996",
      notifyChatId: CHAT_4034, // 即使 replyChannel fallback 到 #4034，也不应该用
      description: "sub-agent 报告任务",
      result: "report...",
    });

    expect(formatted.chatId).toBe(CHAT_3996);
    expect(formatted.chatId).not.toBe(CHAT_4034);
  });
});

describe("ESPlugin v2 E2E — A/B comparison (老 fallback path vs 新 v2 path)", () => {
  test("A: 老 path (无 eventStore) → 用 replyChannel.chatId（错的）", async () => {
    // 不传 eventStore → 老路径
    const triggerEventId = await store.insertTriggerEvent(
      {
        senderId: "ou_test",
        text: "x",
        metadata: { chatId: CHAT_4034, messageId: "om_x", senderId: "ou_test" },
      },
      "lark-cli",
    );
    const captured: any[] = [];
    const handler = new EventHandler({
      env: makeMockEnv() as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (f) => captured.push(f),
      // 故意不传 eventStore
    });

    await handler.handleNotifyEventForTest({
      id: "evt_a",
      type: "task.background.completed",
      timestamp: Date.now(),
      metadata: {
        source: "task.background",
        triggerEventId, // 透传了，但没 eventStore，老路径用 replyChannel
        replyChannel: {
          type: "lark-cli",
          chatId: CHAT_3996, // 老 plugin 错用 fallback
          messageId: "om_legacy",
          profile: "tongzhuli",
        },
      },
      payload: { description: "测试 A", result: "test", associatedTaskId: 4035 },
    } as EnvEvent);

    expect(captured.length).toBe(1);
    // 老路径：用 replyChannel.chatId (错的)
    expect(captured[0].chatId).toBe(CHAT_3996);
    expect(captured[0].message).toContain("测试 A");
    expect(captured[0].message).not.toContain("不要 fallback");
  });

  test("B: 新 v2 path (有 eventStore) → 用 trigger event chatId (对的)", async () => {
    const triggerEventId = await store.insertTriggerEvent(
      {
        senderId: "ou_test",
        text: "x",
        metadata: { chatId: CHAT_4034, messageId: "om_x", senderId: "ou_test" },
      },
      "lark-cli",
    );
    const captured: any[] = [];
    const handler = new EventHandler({
      env: makeMockEnv() as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (f) => captured.push(f),
      eventStore: store,
      getHandlerForEsType: (esType: string) =>
        esType === "lark-cli" ? larkCliHandler : undefined,
    });

    await handler.handleNotifyEventForTest({
      id: "evt_b",
      type: "task.background.completed",
      timestamp: Date.now(),
      metadata: {
        source: "task.background",
        triggerEventId,
        replyChannel: {
          type: "lark-cli",
          chatId: CHAT_3996, // 老 plugin 错用 fallback（应该被忽略）
          messageId: "om_legacy",
          profile: "tongzhuli",
        },
      },
      payload: { description: "测试 B", result: "test", associatedTaskId: 4035 },
    } as EnvEvent);

    expect(captured.length).toBe(1);
    // 新路径：用 trigger event chatId (对的)
    expect(captured[0].chatId).toBe(CHAT_4034);
    expect(captured[0].chatId).not.toBe(CHAT_3996);
    expect(captured[0].message).toContain("不要 fallback");
  });
});

describe("ESPlugin v2 E2E — robustness", () => {
  test("ESStore miss → graceful fallback (no crash)", async () => {
    const captured: any[] = [];
    const handler = new EventHandler({
      env: makeMockEnv() as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (f) => captured.push(f),
      eventStore: store,
      getHandlerForEsType: (esType: string) =>
        esType === "lark-cli" ? larkCliHandler : undefined,
    });
    await handler.handleNotifyEventForTest({
      id: "evt_miss",
      type: "task.background.completed",
      timestamp: Date.now(),
      metadata: {
        source: "task.background",
        triggerEventId: "evt_does_not_exist",
        replyChannel: { type: "lark-cli", chatId: CHAT_4034, messageId: "om_x" },
      },
      payload: { description: "miss test", result: "ok", associatedTaskId: 4035 },
    } as EnvEvent);
    expect(captured.length).toBe(1);
    // 老路径用 replyChannel.chatId（fallback 安全）
    expect(captured[0].chatId).toBe(CHAT_4034);
    expect(captured[0].message).toContain("miss test");
  });

  test("ESHandler.buildNotifyHandlePrompt throws → fallback (no crash)", async () => {
    const triggerEventId = await store.insertTriggerEvent(
      {
        senderId: "ou_t",
        text: "x",
        metadata: { chatId: CHAT_4034, messageId: "om_t", senderId: "ou_t" },
      },
      "lark-cli",
    );
    const throwingHandler = {
      ...larkCliHandler,
      buildNotifyHandlePrompt: () => {
        throw new Error("simulated buildNotifyHandlePrompt failure");
      },
    };
    const captured: any[] = [];
    const handler = new EventHandler({
      env: makeMockEnv() as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (f) => captured.push(f),
      eventStore: store,
      getHandlerForEsType: (esType: string) =>
        esType === "lark-cli" ? (throwingHandler as any) : undefined,
    });
    await handler.handleNotifyEventForTest({
      id: "evt_throw",
      type: "task.background.completed",
      timestamp: Date.now(),
      metadata: {
        source: "task.background",
        triggerEventId,
        replyChannel: { type: "lark-cli", chatId: CHAT_4034, messageId: "om_x" },
      },
      payload: { description: "throw test", result: "ok", associatedTaskId: 4035 },
    } as EnvEvent);
    expect(captured.length).toBe(1);
    // 老路径
    expect(captured[0].chatId).toBe(CHAT_4034);
  });
});