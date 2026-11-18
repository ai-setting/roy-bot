/**
 * notify 跨-chat 路由修复回归测试（Task #4042 follow-up / #4038/#4035）
 *
 * 覆盖三处根因修复：
 *   1. delegate.execute 在 LLM 未显式传 triggerEventId 时，从 EnvContext 派生
 *      （deriveTriggerEventIdFromEnvContext）——让 ESPlugin v2 生产路径不再 dead。
 *   2. createTask 捕获 replyChannel 快照（captureReplyChannelSnapshot）——让每个
 *      notify event 自带回复目标，不再依赖 REPL 全局 lastReplyChannel。
 *   3. publishBackgroundEvent 把 replyChannel 写进 event.metadata——EventHandler
 *      extractChatId 命中 chat-keyed session 隔离。
 */

import { describe, expect, test } from "bun:test";

import {
  BackgroundTaskManager,
  deriveTriggerEventIdFromEnvContext,
  captureReplyChannelSnapshot,
} from "./delegate-tool";
import { runWithEnvContext } from "../../context";

// ============================================================================
// Mock env（最小可用）
// ============================================================================

interface CapturedEvent {
  type: string;
  payload: unknown;
  metadata: Record<string, unknown>;
}

function makeMockEnv() {
  const events: CapturedEvent[] = [];
  return {
    events,
    pushEnvEvent: (input: { type: string; payload?: unknown; metadata?: Record<string, unknown> }) => {
      events.push({ type: input.type, payload: input.payload, metadata: input.metadata ?? {} });
    },
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          create: async (opts: any) => ({
            id: `sub_${Math.random().toString(36).slice(2, 10)}`,
            info: { metadata: { ...(opts.metadata ?? {}) } },
          }),
          get: async () => null,
          update: async () => {},
        };
      }
      return null;
    },
  };
}

// ============================================================================
// 1. triggerEventId 从 EnvContext 派生
// ============================================================================

describe("deriveTriggerEventIdFromEnvContext", () => {
  test("从 envEvent.metadata.triggerEventId 派生", () => {
    const got = runWithEnvContext(
      {
        envEvent: { metadata: { triggerEventId: "evt_from_meta" } },
      } as any,
      () => deriveTriggerEventIdFromEnvContext(),
    );
    expect(got).toBe("evt_from_meta");
  });

  test("metadata 缺失时从 payload.triggerEventId 兜底", () => {
    const got = runWithEnvContext(
      {
        envEvent: { metadata: {}, payload: { triggerEventId: "evt_from_payload" } },
      } as any,
      () => deriveTriggerEventIdFromEnvContext(),
    );
    expect(got).toBe("evt_from_payload");
  });

  test("无 EnvContext / 无 triggerEventId 时返回 undefined（非 ES 触发，向后兼容）", () => {
    expect(runWithEnvContext(undefined, () => deriveTriggerEventIdFromEnvContext())).toBeUndefined();
    const got = runWithEnvContext(
      { envEvent: { metadata: {} } } as any,
      () => deriveTriggerEventIdFromEnvContext(),
    );
    expect(got).toBeUndefined();
  });
});

// ============================================================================
// 2. replyChannel 快照捕获
// ============================================================================

describe("captureReplyChannelSnapshot", () => {
  test("捕获 chatId/messageId/profile（多 appId + userId 转 params）", () => {
    const snap = runWithEnvContext(
      {
        envEvent: {},
        replyChannel: {
          type: "lark-cli",
          appId: "cli_x",
          chatId: "oc_3996",
          messageId: "om_x",
          userId: "ou_user",
          profile: "tongzhuli",
        },
      } as any,
      () => captureReplyChannelSnapshot(),
    );
    expect(snap).toEqual({
      type: "lark-cli",
      appId: "cli_x",
      chatId: "oc_3996",
      messageId: "om_x",
      profile: "tongzhuli",
      params: { userId: "ou_user" },
    });
  });

  test("保留 replyChannel 原有 params（不丢 token/thread_id 等业务字段）", () => {
    const snap = runWithEnvContext(
      {
        envEvent: {},
        replyChannel: {
          type: "lark-cli",
          chatId: "oc_A",
          messageId: "om_A",
          userId: "ou_user",
          params: { thread_id: "th_1", token: "tok", userId: "keep_me" },
        },
      } as any,
      () => captureReplyChannelSnapshot(),
    );
    // 原有 params 全保留；已有 userId 不被覆盖
    expect(snap?.params).toEqual({ thread_id: "th_1", token: "tok", userId: "keep_me" });
  });

  test("无 replyChannel / 无有效目标时返回 undefined", () => {
    expect(runWithEnvContext(undefined, () => captureReplyChannelSnapshot())).toBeUndefined();
    const empty = runWithEnvContext(
      { envEvent: {}, replyChannel: { type: "lark-cli" } } as any,
      () => captureReplyChannelSnapshot(),
    );
    expect(empty).toBeUndefined();
  });
});

// ============================================================================
// 3. publishBackgroundEvent 透传 replyChannel
// ============================================================================

describe("publishBackgroundEvent replyChannel 透传", () => {
  test("replyChannel 写进 event.metadata（与 triggerEventId 并存）", () => {
    const env = makeMockEnv();
    const mgr = new BackgroundTaskManager(env as any);
    mgr.publishBackgroundEventWithTrigger(
      "task.background.completed",
      { backgroundTaskId: "bg", subSessionId: "sub", parentSessionId: "p", description: "d", result: "r" },
      "p_3996",
      "evt_1",
      { type: "lark-cli", chatId: "oc_3996", messageId: "om_1", profile: "tongzhuli" },
    );
    expect(env.events.length).toBe(1);
    expect(env.events[0].metadata.triggerEventId).toBe("evt_1");
    expect(env.events[0].metadata.replyChannel).toEqual({
      type: "lark-cli",
      chatId: "oc_3996",
      messageId: "om_1",
      profile: "tongzhuli",
    });
  });

  test("不传 replyChannel 时 metadata 不含该字段（向后兼容）", () => {
    const env = makeMockEnv();
    const mgr = new BackgroundTaskManager(env as any);
    mgr.publishBackgroundEventWithTrigger(
      "task.background.started",
      { backgroundTaskId: "bg", subSessionId: "sub", parentSessionId: "p", description: "d", subagentType: "general" },
      "p",
      "evt_2",
    );
    expect(env.events[0].metadata.replyChannel).toBeUndefined();
  });
});
