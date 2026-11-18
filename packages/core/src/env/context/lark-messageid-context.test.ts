/**
 * @fileoverview EventEnvelope generic API tests (Task #2331)
 *
 * 验证 env context 通用化为 EventEnvelope 后, 各 event source (lark/github/jira/...)
 * 都能注入到 env context, 但 lark-cli plugin 只处理 source='lark' 事件.
 *
 * 与 Task #2326 区别：
 * - Task #2326: EnvContext.larkEvent (lark 专属) + LARK_ENV_PREFIX helper
 * - Task #2331: EnvContext.event (EventEnvelope 通用) + EVENT_ENV_PREFIX helper
 *              + lark-cli plugin 内部用 extractLarkFields() 转换 lark 字段
 *
 * TDD: 这些测试先 RED（实现修复后转 GREEN）。
 */

import { describe, test, expect } from "bun:test";
import {
  type EnvContext,
  type ReplyChannel,
  type EventEnvelope,
  getEnvContext,
  runWithEnvContext,
  runWithEnvContextAsync,
  createEnvContext,
  mergeEnvContext,
  EVENT_ENV_PREFIX,
  serializeEventToEnv,
  restoreEventFromEnv,
  getEventFromEnvContext,
  isLarkEvent,
  isGithubEvent,
  isJiraEvent,
  getLarkMessageId,
  getLarkChatId,
  getLarkUserId,
} from "./env-context";

// ============================================================================
// 改 1: EventEnvelope 注入 (替代 larkEvent 字段)
// ============================================================================

describe("改 1: createEnvContext 接受 event 字段 (EventEnvelope 通用化)", () => {
  test("createEnvContext 接受 event 选项并写入 envContext (lark source)", () => {
    const event: EventEnvelope = {
      source: "lark",
      id: "om_lark_001",
      receivedAt: "2026-07-23T10:00:00.000Z",
      payload: { type: "im.message.receive_v1", message_id: "om_lark_001" },
      metadata: { chatType: "p2p", profile: "myapp" },
    };

    const envContext = createEnvContext({
      envEvent: { type: "im.message.receive_v1" },
      sourceId: "es-lark-1",
      userId: "ou_xyz",
      event,
    } as any);

    // ★ 关键: event 字段被存储
    expect(envContext.event).toEqual(event);
    expect(envContext.event?.source).toBe("lark");
    expect(envContext.event?.id).toBe("om_lark_001");
    // ★ lark source 时, 顶层 messageId 仍然从 event.id 推导 (backward compat)
    expect(envContext.messageId).toBe("om_lark_001");
  });

  test("createEnvContext 接受非 lark source 事件 (github)", () => {
    const event: EventEnvelope = {
      source: "github",
      id: "issue_123",
      receivedAt: "2026-07-23T10:00:00.000Z",
      payload: { action: "opened", number: 123 },
    };

    const envContext = createEnvContext({
      envEvent: { type: "github.issue.opened" },
      sourceId: "es-github-1",
      userId: "gh_user_42",
      event,
    } as any);

    expect(envContext.event?.source).toBe("github");
    expect(envContext.event?.id).toBe("issue_123");
    // ★ 非 lark source 时, 顶层 messageId 不推导 (保持 backward compat 不污染)
    expect(envContext.messageId).toBeUndefined();
  });

  test("createEnvContext 接受未知 source 事件 (unknown)", () => {
    const event: EventEnvelope = {
      source: "unknown",
      id: "evt_001",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };

    const envContext = createEnvContext({
      envEvent: { type: "custom.event" },
      sourceId: "es-custom-1",
      userId: "user_001",
      event,
    } as any);

    expect(envContext.event?.source).toBe("unknown");
    expect(envContext.messageId).toBeUndefined();
  });

  test("runWithEnvContext 把 event 暴露给下游异步调用", async () => {
    const event: EventEnvelope = {
      source: "lark",
      id: "om_async_42",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };

    const envContext = createEnvContext({
      envEvent: { type: "im.message.receive_v1" },
      sourceId: "es-lark-1",
      userId: "ou_async_42",
      event,
    } as any);

    let capturedEvent: EventEnvelope | undefined;
    await runWithEnvContextAsync(envContext, async () => {
      await Promise.resolve();
      await Promise.resolve();
      const ctx = getEnvContext();
      capturedEvent = ctx?.event;
    });

    expect(capturedEvent?.source).toBe("lark");
    expect(capturedEvent?.id).toBe("om_async_42");
  });
});

// ============================================================================
// 改 2: backward compat - 只传 messageId 时自动构造 lark event envelope
// ============================================================================

describe("改 2: backward compat - messageId 透传构造 lark event envelope", () => {
  test("只传 messageId 时自动派生 lark source event envelope", () => {
    const replyChannel: ReplyChannel = {
      type: "lark",
      messageId: "om_legacy_001",
      chatId: "oc_legacy_001",
      userId: "ou_legacy_001",
      identity: "bot",
      sendText: async () => {},
      sendMarkdown: async () => {},
      sendMessage: async () => {},
      reply: async () => {},
    };

    const envContext = createEnvContext({
      envEvent: { type: "im.message.receive_v1" },
      sourceId: "es-lark-1",
      userId: "ou_legacy_001",
      messageId: "om_legacy_001",
      replyChannel,
    } as any);

    // 旧 API: 只传 messageId + replyChannel
    expect(envContext.messageId).toBe("om_legacy_001");
    expect(envContext.replyChannel?.messageId).toBe("om_legacy_001");
    // 新 API: 自动派生 lark event envelope (向后兼容)
    expect(envContext.event?.source).toBe("lark");
    expect(envContext.event?.id).toBe("om_legacy_001");
  });
});

// ============================================================================
// 改 3: EnvContext.event 通过 spread 继承 (sub-agent 透传)
// ============================================================================

describe("改 3: EnvContext.event 通过 spread 父 context 继承", () => {
  test("sub-agent 通过 spread parentEnvContext 继承 event", () => {
    const event: EventEnvelope = {
      source: "lark",
      id: "om_spread_002",
      receivedAt: "2026-07-23T10:00:00.000Z",
      payload: { type: "im.message.receive_v1" },
    };

    const parent = createEnvContext({
      envEvent: { type: "im.message.receive_v1" },
      sourceId: "es-lark-1",
      userId: "ou_parent",
      event,
    } as any);

    runWithEnvContext(parent, () => {
      const parentCtx = getEnvContext();
      const subAgentCtx: EnvContext = {
        ...parentCtx!,
        sourceId: "sub-agent",
      } as EnvContext;

      runWithEnvContext(subAgentCtx, () => {
        const ctx = getEnvContext();
        expect(ctx?.event?.source).toBe("lark");
        expect(ctx?.event?.id).toBe("om_spread_002");
        expect(ctx?.messageId).toBe("om_spread_002");
      });
    });
  });

  test("mergeEnvContext 不会丢失 parent 的 event", () => {
    const event: EventEnvelope = {
      source: "lark",
      id: "om_merge_777",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };

    const parent = createEnvContext({
      envEvent: { type: "im.message.receive_v1" },
      sourceId: "es-lark-1",
      userId: "ou_parent",
      event,
    } as any);

    runWithEnvContext(parent, () => {
      mergeEnvContext({
        pluginEnabled: { "es-lark-1:task-notify": true },
      });
      const ctx = getEnvContext();
      expect(ctx?.event?.source).toBe("lark");
      expect(ctx?.event?.id).toBe("om_merge_777");
    });
  });
});

// ============================================================================
// 改 4: lark-cli 命令构建 (消息决策)
// ============================================================================

describe("改 4: lark-cli 发送决策 (lark source only)", () => {
  function pickLarkCliArgs(args: {
    chatId?: string;
    messageId?: string;
    content: string;
    profile?: string;
  }): string[] {
    const cmd: string[] = [];
    if (args.profile) {
      cmd.push(`--profile ${args.profile}`);
    }
    if (args.messageId) {
      cmd.push(
        `im +messages-reply --message-id ${args.messageId} --markdown ${args.content}`
      );
    } else if (args.chatId) {
      cmd.push(
        `im +messages-send --chat-id ${args.chatId} --markdown ${args.content}`
      );
    }
    return cmd;
  }

  test("replyChannel 有 messageId 时优先用 +messages-reply", () => {
    const replyChannel: ReplyChannel = {
      type: "lark",
      messageId: "om_reply_target",
      chatId: "oc_chat_target",
      userId: "ou_user_target",
      identity: "bot",
      sendText: async () => {},
      sendMarkdown: async () => {},
      sendMessage: async () => {},
      reply: async () => {},
    };

    const args = pickLarkCliArgs({
      chatId: replyChannel.chatId,
      messageId: replyChannel.messageId,
      content: "task done",
      profile: "myapp",
    });

    expect(args.join(" ")).toContain("+messages-reply");
    expect(args.join(" ")).toContain("--message-id om_reply_target");
    expect(args.join(" ")).not.toContain("+messages-send");
    expect(args.join(" ")).toContain("--profile myapp");
  });

  test("replyChannel 无 messageId 时 fallback 到 +messages-send", () => {
    const replyChannel: ReplyChannel = {
      type: "lark",
      chatId: "oc_only_chat",
      userId: "ou_only_user",
      identity: "bot",
      sendText: async () => {},
      sendMarkdown: async () => {},
      sendMessage: async () => {},
      reply: async () => {},
    };

    const args = pickLarkCliArgs({
      chatId: replyChannel.chatId,
      messageId: replyChannel.messageId,
      content: "new msg",
    });

    expect(args.join(" ")).toContain("+messages-send");
    expect(args.join(" ")).toContain("--chat-id oc_only_chat");
    expect(args.join(" ")).not.toContain("+messages-reply");
  });

  test("都没有时返回空数组（plugin 静默跳过）", () => {
    const args = pickLarkCliArgs({
      content: "drop",
    });

    expect(args).toHaveLength(0);
  });
});

// ============================================================================
// 改 5: lark-cli plugin 只处理 source='lark' 事件
// ============================================================================

describe("改 5: lark-cli plugin 只处理 source='lark' 事件", () => {
  /**
   * 模拟 lark-cli plugin 的 sendNotify 决策:
   * - event.source='lark' + 有 replyChannel → 发送
   * - event.source='github'/'jira'/other → 跳过
   */
  function shouldLarkPluginSend(env: Partial<EnvContext>): boolean {
    // 旧逻辑: 有 replyChannel 就发送
    if (!env.replyChannel) return false;
    // 新逻辑 (Task #2331): event 存在但不是 lark source → 跳过
    if (env.event && !isLarkEvent(env.event)) {
      return false;
    }
    return !!(env.replyChannel.chatId || env.replyChannel.messageId);
  }

  test("lark source + replyChannel → 发送", () => {
    const env: Partial<EnvContext> = {
      event: {
        source: "lark",
        id: "om_xxx",
        receivedAt: "2026-07-23T10:00:00.000Z",
      },
      replyChannel: {
        type: "lark",
        messageId: "om_xxx",
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      } as ReplyChannel,
    };
    expect(shouldLarkPluginSend(env)).toBe(true);
  });

  test("github source → 跳过 (不应发送 lark 通知)", () => {
    const env: Partial<EnvContext> = {
      event: {
        source: "github",
        id: "issue_123",
        receivedAt: "2026-07-23T10:00:00.000Z",
      },
      replyChannel: {
        type: "lark",
        messageId: "om_xxx", // 即便有 replyChannel, github 事件也不发 lark
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      } as ReplyChannel,
    };
    expect(shouldLarkPluginSend(env)).toBe(false);
  });

  test("jira source → 跳过", () => {
    const env: Partial<EnvContext> = {
      event: {
        source: "jira",
        id: "PROJ-456",
        receivedAt: "2026-07-23T10:00:00.000Z",
      },
      replyChannel: {
        type: "lark",
        messageId: "om_xxx",
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      } as ReplyChannel,
    };
    expect(shouldLarkPluginSend(env)).toBe(false);
  });

  test("无 event 字段 + 有 replyChannel → 发送 (backward compat)", () => {
    const env: Partial<EnvContext> = {
      // 无 event 字段
      replyChannel: {
        type: "lark",
        messageId: "om_legacy",
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      } as ReplyChannel,
    };
    expect(shouldLarkPluginSend(env)).toBe(true);
  });
});

// ============================================================================
// 改 6: ROY_EVENT_* subprocess env serialization/restore helper
// ============================================================================

describe("改 6: ROY_EVENT_* env 序列化/恢复 helper (Task #2331 通用化)", () => {
  test("serializeEventToEnv 生成 ROY_EVENT_* 前缀字段 (lark)", () => {
    const event: EventEnvelope = {
      source: "lark",
      id: "om_env_001",
      receivedAt: "2026-07-23T10:00:00.000Z",
      payload: { message_id: "om_env_001", chat_id: "oc_env_001" },
      metadata: { chatType: "group", profile: "myapp" },
    };

    const env = serializeEventToEnv(event);

    expect(env[`${EVENT_ENV_PREFIX}SOURCE`]).toBe("lark");
    expect(env[`${EVENT_ENV_PREFIX}ID`]).toBe("om_env_001");
    expect(env[`${EVENT_ENV_PREFIX}RECEIVED_AT`]).toBe("2026-07-23T10:00:00.000Z");
    expect(env[`${EVENT_ENV_PREFIX}PAYLOAD`]).toBe(
      JSON.stringify(event.payload)
    );
    expect(env[`${EVENT_ENV_PREFIX}METADATA`]).toBe(
      JSON.stringify(event.metadata)
    );
  });

  test("serializeEventToEnv 接受其他 source (github/jira/unknown)", () => {
    const ghEvent: EventEnvelope = {
      source: "github",
      id: "issue_42",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };
    const env = serializeEventToEnv(ghEvent);
    expect(env[`${EVENT_ENV_PREFIX}SOURCE`]).toBe("github");
    expect(env[`${EVENT_ENV_PREFIX}ID`]).toBe("issue_42");
    // payload/metadata undefined 时不写入
    expect(env[`${EVENT_ENV_PREFIX}PAYLOAD`]).toBeUndefined();
    expect(env[`${EVENT_ENV_PREFIX}METADATA`]).toBeUndefined();
  });

  test("restoreEventFromEnv 还原 EventEnvelope (lark)", () => {
    const env = serializeEventToEnv({
      source: "lark",
      id: "om_restore_001",
      receivedAt: "2026-07-23T10:00:00.000Z",
      payload: { message_id: "om_restore_001" },
      metadata: { chatType: "p2p" },
    });

    const restored = restoreEventFromEnv(env);
    expect(restored).toBeDefined();
    expect(restored?.source).toBe("lark");
    expect(restored?.id).toBe("om_restore_001");
    expect(restored?.receivedAt).toBe("2026-07-23T10:00:00.000Z");
    expect(restored?.payload).toEqual({ message_id: "om_restore_001" });
    expect(restored?.metadata).toEqual({ chatType: "p2p" });
  });

  test("restoreEventFromEnv 还原 github event", () => {
    const env = serializeEventToEnv({
      source: "github",
      id: "issue_42",
      receivedAt: "2026-07-23T10:00:00.000Z",
      payload: { action: "opened" },
    });

    const restored = restoreEventFromEnv(env);
    expect(restored?.source).toBe("github");
    expect(restored?.id).toBe("issue_42");
    expect(restored?.payload).toEqual({ action: "opened" });
  });

  test("restoreEventFromEnv 缺少 ROY_EVENT_SOURCE 返回 undefined", () => {
    const restored = restoreEventFromEnv({});
    expect(restored).toBeUndefined();
  });

  test("serialize → restore 往返一致 (round-trip)", () => {
    const original: EventEnvelope = {
      source: "jira",
      id: "PROJ-123",
      receivedAt: "2026-07-23T10:00:00.000Z",
      payload: { issue: { key: "PROJ-123" } },
      metadata: { priority: "high" },
    };
    const env = serializeEventToEnv(original);
    const restored = restoreEventFromEnv(env);
    expect(restored).toEqual(original);
  });
});

// ============================================================================
// 改 7: getEventFromEnvContext - 从 EnvContext 提取 EventEnvelope
// ============================================================================

describe("改 7: getEventFromEnvContext helper (替代 getLarkContextFromEnvContext)", () => {
  test("优先 event 字段, fallback replyChannel.messageId 构造 lark envelope", () => {
    // 优先 event
    const event: EventEnvelope = {
      source: "lark",
      id: "om_direct_001",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };
    const ctx1: Partial<EnvContext> = { event };
    expect(getEventFromEnvContext(ctx1)?.id).toBe("om_direct_001");

    // Fallback: replyChannel.messageId
    const ctx2: Partial<EnvContext> = {
      replyChannel: {
        type: "lark",
        messageId: "om_via_reply_001",
        chatId: "oc_via_reply_001",
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      } as ReplyChannel,
    };
    const result2 = getEventFromEnvContext(ctx2);
    expect(result2?.source).toBe("lark");
    expect(result2?.id).toBe("om_via_reply_001");

    // Fallback: 顶层 messageId
    const ctx3: Partial<EnvContext> = { messageId: "om_only_msg_001" };
    const result3 = getEventFromEnvContext(ctx3);
    expect(result3?.source).toBe("lark");
    expect(result3?.id).toBe("om_only_msg_001");

    // 都没有时
    expect(getEventFromEnvContext({})).toBeUndefined();
    expect(getEventFromEnvContext(undefined)).toBeUndefined();
  });
});

// ============================================================================
// 改 8: Source-specific helpers
// ============================================================================

describe("改 8: source-specific helpers (isLarkEvent/getLarkMessageId/...)", () => {
  test("isLarkEvent / isGithubEvent / isJiraEvent 正确判断", () => {
    const lark: EventEnvelope = {
      source: "lark",
      id: "om_1",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };
    const gh: EventEnvelope = {
      source: "github",
      id: "issue_1",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };
    const jira: EventEnvelope = {
      source: "jira",
      id: "PROJ-1",
      receivedAt: "2026-07-23T10:00:00.000Z",
    };

    expect(isLarkEvent(lark)).toBe(true);
    expect(isLarkEvent(gh)).toBe(false);
    expect(isLarkEvent(undefined)).toBe(false);

    expect(isGithubEvent(gh)).toBe(true);
    expect(isGithubEvent(lark)).toBe(false);

    expect(isJiraEvent(jira)).toBe(true);
    expect(isJiraEvent(lark)).toBe(false);
  });

  test("getLarkMessageId 从 lark envelope 提取 message_id", () => {
    // 优先 event.id
    expect(
      getLarkMessageId({
        source: "lark",
        id: "om_id_001",
        receivedAt: "2026-07-23T10:00:00.000Z",
      })
    ).toBe("om_id_001");

    // Fallback payload.message.message_id
    expect(
      getLarkMessageId({
        source: "lark",
        id: "",
        receivedAt: "2026-07-23T10:00:00.000Z",
        payload: { message: { message_id: "om_nested_002" } },
      })
    ).toBe("om_nested_002");

    // Fallback payload.message_id
    expect(
      getLarkMessageId({
        source: "lark",
        id: "",
        receivedAt: "2026-07-23T10:00:00.000Z",
        payload: { message_id: "om_flat_003" },
      })
    ).toBe("om_flat_003");

    // 非 lark source 返回 undefined
    expect(
      getLarkMessageId({
        source: "github",
        id: "issue_1",
        receivedAt: "2026-07-23T10:00:00.000Z",
      })
    ).toBeUndefined();

    expect(getLarkMessageId(undefined)).toBeUndefined();
  });

  test("getLarkChatId 从 lark envelope 提取 chat_id", () => {
    expect(
      getLarkChatId({
        source: "lark",
        id: "om_1",
        receivedAt: "2026-07-23T10:00:00.000Z",
        payload: { chat_id: "oc_chat_001" },
      })
    ).toBe("oc_chat_001");

    // 非 lark source 返回 undefined
    expect(
      getLarkChatId({
        source: "github",
        id: "1",
        receivedAt: "2026-07-23T10:00:00.000Z",
        payload: { chat_id: "oc_xxx" },
      })
    ).toBeUndefined();
  });

  test("getLarkUserId 从 lark envelope 提取 user_id (sender 嵌套)", () => {
    expect(
      getLarkUserId({
        source: "lark",
        id: "om_1",
        receivedAt: "2026-07-23T10:00:00.000Z",
        payload: {
          event: {
            sender: { sender_id: { open_id: "ou_user_001" } },
          },
        },
      })
    ).toBe("ou_user_001");

    // 非 lark source
    expect(
      getLarkUserId({
        source: "github",
        id: "1",
        receivedAt: "2026-07-23T10:00:00.000Z",
        payload: {
          event: {
            sender: { sender_id: { open_id: "ou_user_001" } },
          },
        },
      })
    ).toBeUndefined();
  });
});

// ============================================================================
// 端到端: lark event → createEnvContext → sub-agent 继承
// ============================================================================

describe("E2E: lark event 完整透传到 EnvContext (Task #2331 通用化后)", () => {
  test("嵌套 lark event payload → extractMetadata → createEnvContext 端到端", () => {
    // 真实飞书 event payload (嵌套格式)
    const rawEvent = {
      header: { event_type: "im.message.receive_v1", app_id: "cli_xxx" },
      event: {
        message: {
          message_id: "om_e2e_real_123",
          chat_id: "oc_e2e_real_456",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello agent" }),
        },
        sender: {
          sender_id: { open_id: "ou_e2e_user_789" },
        },
      },
    };

    // Step 1: 模拟 extractMetadata 提取
    const innerEvent = rawEvent.event as Record<string, unknown>;
    const message = innerEvent.message as Record<string, unknown>;
    const sender = innerEvent.sender as Record<string, unknown>;
    const senderId = sender.sender_id as Record<string, unknown>;
    const messageId = message.message_id as string;
    const chatId = message.chat_id as string;
    const userId = senderId.open_id as string;

    // Step 2: 构造 EventEnvelope (Task #2331 模式)
    const event: EventEnvelope = {
      source: "lark",
      id: messageId,
      receivedAt: new Date().toISOString(),
      payload: rawEvent,
      metadata: {
        chatId,
        userId,
        chatType: message.chat_type as string,
        profile: "myapp",
      },
    };

    const replyChannel: ReplyChannel = {
      type: "lark",
      messageId,
      chatId,
      userId,
      identity: "bot",
      sendText: async () => {},
      sendMarkdown: async () => {},
      sendMessage: async () => {},
      reply: async () => {},
    };

    // Step 3: createEnvContext 接受 event
    const envContext = createEnvContext({
      envEvent: { type: "im.message.receive_v1" },
      sourceId: "es-lark-1",
      userId,
      event,
      replyChannel,
    } as any);

    expect(envContext.event?.source).toBe("lark");
    expect(envContext.event?.id).toBe(messageId);
    expect(envContext.messageId).toBe(messageId);
    expect(envContext.replyChannel?.messageId).toBe(messageId);

    // Step 4: runWithEnvContext 暴露给下游
    let downstreamEvent: EventEnvelope | undefined;
    let downstreamMessageId: string | undefined;
    runWithEnvContext(envContext, () => {
      const ctx = getEnvContext();
      downstreamEvent = ctx?.event;
      downstreamMessageId = ctx?.messageId;
    });

    expect(downstreamEvent?.source).toBe("lark");
    expect(downstreamEvent?.id).toBe("om_e2e_real_123");
    expect(downstreamMessageId).toBe("om_e2e_real_123");
  });
});
