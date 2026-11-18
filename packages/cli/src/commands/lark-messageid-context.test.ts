/**
 * @fileoverview EventEnvelope generic API smoke test (Task #2331)
 *
 * CLI 层 smoke 测试 — 验证 core package 暴露的 EventEnvelope 通用化 API
 * (event 字段 + ROY_EVENT_* subprocess env helpers) 全部可用。
 *
 * 真正的逻辑测试在 packages/core/src/env/context/lark-messageid-context.test.ts。
 *
 * 路径策略：本文件用相对路径 import 源码,避免依赖 core/dist build artifact。
 * 这样 cli 测试和 core 测试用同一份源码,避免重复编译。
 */

import { describe, test, expect } from "bun:test";
// ★ Task #5592 CV 返工（MINOR-3）：跨包相对导入改为包名导入。
//   相对路径导入会被 bunup inline（见 tui-solid/app-config-io.ts
//   的 Task #5592 注释），且发布守卫测试会把它标为违规。
//   core exports 的 `./*` 通配已覆盖 env/context/env-context。
import {
  type EnvContext,
  type ReplyChannel,
  type EventEnvelope,
  createEnvContext,
  EVENT_ENV_PREFIX,
  serializeEventToEnv,
  restoreEventFromEnv,
  getEventFromEnvContext,
  isLarkEvent,
  getLarkMessageId,
} from "@ai-setting/roy-bot-core/env/context/env-context";

// ============================================================================
// CLI 层 smoke: 验证 CLI 可访问 core EventEnvelope 通用化 API
// ============================================================================

describe("CLI smoke: Task #2331 EventEnvelope 通用化 API 可在 CLI 层访问", () => {
  test("createEnvContext 支持 event 字段, CLI 可用 (lark source)", () => {
    const replyChannel: ReplyChannel = {
      type: "lark",
      messageId: "om_cli_smoke_001",
      chatId: "oc_cli_smoke_001",
      userId: "ou_cli_smoke_001",
      identity: "bot",
      sendText: async () => {},
      sendMarkdown: async () => {},
      sendMessage: async () => {},
      reply: async () => {},
    };

    const event: EventEnvelope = {
      source: "lark",
      id: "om_cli_smoke_001",
      receivedAt: "2026-07-23T10:00:00.000Z",
      payload: { type: "im.message.receive_v1" },
      metadata: { chatType: "p2p", profile: "myapp" },
    };

    const envContext = createEnvContext({
      envEvent: { type: "im.message.receive_v1" },
      sourceId: "es-lark-cli-smoke",
      userId: "ou_cli_smoke_001",
      event,
      replyChannel,
    } as any) as EnvContext & { messageId?: string; event?: EventEnvelope };

    // ★ 关键断言: event 字段在 EnvContext 上
    expect(envContext.event?.source).toBe("lark");
    expect(envContext.event?.id).toBe("om_cli_smoke_001");
    expect(envContext.messageId).toBe("om_cli_smoke_001");
    expect(envContext.replyChannel?.messageId).toBe("om_cli_smoke_001");
  });

  test("createEnvContext 支持非 lark source 事件 (github)", () => {
    const event: EventEnvelope = {
      source: "github",
      id: "issue_42",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };

    const envContext = createEnvContext({
      envEvent: { type: "github.issue.opened" },
      sourceId: "es-github-smoke",
      userId: "gh_user_42",
      event,
    } as any);

    expect(envContext.event?.source).toBe("github");
    expect(envContext.event?.id).toBe("issue_42");
    // 非 lark source → messageId 不派生
    expect(envContext.messageId).toBeUndefined();
  });

  test("ROY_EVENT_* env helper: serialize ↔ restore 往返 (lark)", () => {
    const event: EventEnvelope = {
      source: "lark",
      id: "om_cli_env_001",
      receivedAt: "2026-07-23T10:00:00.000Z",
      payload: { message_id: "om_cli_env_001" },
    };
    const env = serializeEventToEnv(event);
    expect(env[`${EVENT_ENV_PREFIX}SOURCE`]).toBe("lark");
    expect(env[`${EVENT_ENV_PREFIX}ID`]).toBe("om_cli_env_001");
    const restored = restoreEventFromEnv(env);
    expect(restored?.source).toBe("lark");
    expect(restored?.id).toBe("om_cli_env_001");
  });

  test("ROY_EVENT_* env helper: serialize ↔ restore 往返 (github)", () => {
    const event: EventEnvelope = {
      source: "github",
      id: "issue_99",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };
    const env = serializeEventToEnv(event);
    expect(env[`${EVENT_ENV_PREFIX}SOURCE`]).toBe("github");
    const restored = restoreEventFromEnv(env);
    expect(restored?.source).toBe("github");
    expect(restored?.id).toBe("issue_99");
  });

  test("getEventFromEnvContext 兼容 fallback (从 replyChannel 构造 lark envelope)", () => {
    const ctx: Partial<EnvContext> = {
      replyChannel: {
        type: "lark",
        messageId: "om_fallback_002",
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      } as ReplyChannel,
    };
    const result = getEventFromEnvContext(ctx);
    expect(result?.source).toBe("lark");
    expect(result?.id).toBe("om_fallback_002");
  });

  test("isLarkEvent + getLarkMessageId 组合使用 (CLI plugin 内部模式)", () => {
    const larkEvent: EventEnvelope = {
      source: "lark",
      id: "om_combo_001",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };
    const ghEvent: EventEnvelope = {
      source: "github",
      id: "issue_99",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };

    // lark: isLarkEvent + getLarkMessageId 都返回有意义值
    expect(isLarkEvent(larkEvent)).toBe(true);
    expect(getLarkMessageId(larkEvent)).toBe("om_combo_001");

    // github: isLarkEvent false, getLarkMessageId undefined (plugin 跳过)
    expect(isLarkEvent(ghEvent)).toBe(false);
    expect(getLarkMessageId(ghEvent)).toBeUndefined();
  });
});
