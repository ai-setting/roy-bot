/**
 * @fileoverview EnvContext Integration Tests - TDD
 *
 * 测试 EnvContext 在 EventSource 数据流中的集成：
 * 1. LarkCliInstance.handleEvent() 创建 EnvContext 并注入
 * 2. Plugin 通过 getEnvContext() 获取 EnvContext
 * 3. ReplyChannel 可用
 */

import { describe, it, expect } from "bun:test";
import {
  EnvContext,
  getEnvContext,
  runWithEnvContextAsync,
  createEnvContext,
} from "./env-context";

// ============================================================================
// Mock types for testing
// ============================================================================

/**
 * Mock EventSourceEventPayload (简化版)
 */
interface MockEventPayload {
  sourceId: string;
  sourceType: string;
  rawEvent: Record<string, unknown>;
  message: string;
  metadata: {
    messageId?: string;
    chatId?: string;
    senderId?: string;
    [key: string]: unknown;
  };
  replyChannel?: {
    type: string;
    messageId?: string;
    chatId?: string;
    userId?: string;
  };
}

/**
 * Mock EventSourceEvent
 */
interface MockEventSourceEvent {
  id: string;
  type: string;
  timestamp: number;
  metadata: {
    sourceId: string;
    sourceMessageType?: string;
  };
  payload: MockEventPayload;
}

// ============================================================================
// Helper functions (模拟 LarkCliInstance 的实现)
// ============================================================================

/**
 * 从 rawEvent 中提取 userId
 */
function extractUserId(rawEvent: unknown): string {
  const event = rawEvent as Record<string, unknown>;
  const innerEvent = event.event as Record<string, unknown>;
  const message = innerEvent?.message as Record<string, unknown>;
  const sender = message?.sender as Record<string, unknown>;
  const senderId = sender?.sender_id as Record<string, unknown>;
  return (senderId?.open_id as string) || "unknown";
}

/**
 * 从 rawEvent 构建 ReplyChannel
 */
function buildReplyChannel(rawEvent: unknown, metadata: MockEventPayload["metadata"]): {
  type: string;
  messageId?: string;
  chatId?: string;
  userId?: string;
} | undefined {
  const event = rawEvent as Record<string, unknown>;
  const innerEvent = event.event as Record<string, unknown>;
  const message = innerEvent?.message as Record<string, unknown>;
  const sender = message?.sender as Record<string, unknown>;
  const senderId = sender?.sender_id as Record<string, unknown>;

  const messageId = metadata.messageId || (message?.message_id as string);
  const chatId = metadata.chatId || (message?.chat_id as string);
  const userId = senderId?.open_id as string;

  if (!messageId && !chatId && !userId) {
    return undefined;
  }

  return {
    type: "lark",
    messageId,
    chatId,
    userId,
  };
}

// ============================================================================
// Integration Tests
// ============================================================================

describe("EnvContext Integration with EventSource", () => {
  describe("LarkCliInstance.handleEvent flow", () => {
    it("should create EnvContext from EventSourceEvent", async () => {
      // 模拟 LarkCliInstance 收到的事件
      const mockRawEvent = {
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: {
            message_id: "om_123456",
            chat_id: "oc_789012",
            content: JSON.stringify({ text: "Hello!" }),
            sender: {
              sender_id: { open_id: "ou_abc123" },
            },
          },
        },
      };

      const mockEvent: MockEventSourceEvent = {
        id: "es-lark-1-1716200000000",
        type: "event-source.event.lark-cli",
        timestamp: Date.now(),
        metadata: {
          sourceId: "es-lark-1",
          sourceMessageType: "im.message.receive_v1",
        },
        payload: {
          sourceId: "es-lark-1",
          sourceType: "lark-cli",
          rawEvent: mockRawEvent,
          message: "[飞书消息] ou_abc123: Hello!",
          metadata: {
            messageId: "om_123456",
            chatId: "oc_789012",
            senderId: "ou_abc123",
          },
        },
      };

      // 模拟 EnvContext 创建逻辑（如同 LarkCliInstance.handleEvent）
      const userId = extractUserId(mockEvent.payload.rawEvent);
      const replyChannel = buildReplyChannel(
        mockEvent.payload.rawEvent,
        mockEvent.payload.metadata
      );

      const envContext = createEnvContext({
        envEvent: mockEvent,
        sourceId: mockEvent.metadata.sourceId,
        userId,
        replyChannel: replyChannel
          ? {
              type: replyChannel.type,
              messageId: replyChannel.messageId,
              chatId: replyChannel.chatId,
              userId: replyChannel.userId,
              identity: "bot",
              sendText: async () => {},
              sendMarkdown: async () => {},
              sendMessage: async () => {},
              reply: async () => {},
            }
          : undefined,
        plugins: ["task-notify"],
        pluginEnabled: { "es-lark-1:task-notify": true },
      });

      // 验证 EnvContext 创建正确
      expect(envContext.sourceId).toBe("es-lark-1");
      expect(envContext.userId).toBe("ou_abc123");
      expect(envContext.envEvent).toEqual(mockEvent);
      expect(envContext.replyChannel?.messageId).toBe("om_123456");
      expect(envContext.replyChannel?.chatId).toBe("oc_789012");
    });

    it("should inject EnvContext into async chain", async () => {
      const mockRawEvent = {
        event: {
          message: {
            message_id: "om_async",
            sender: { sender_id: { open_id: "ou_async" } },
          },
        },
      };

      const mockEvent: MockEventSourceEvent = {
        id: "es-async-1",
        type: "event-source.event.lark-cli",
        timestamp: Date.now(),
        metadata: { sourceId: "es-async-1" },
        payload: {
          sourceId: "es-async-1",
          sourceType: "lark-cli",
          rawEvent: mockRawEvent,
          message: "test",
          metadata: {},
        },
      };

      const userId = extractUserId(mockEvent.payload.rawEvent);
      const envContext = createEnvContext({
        envEvent: mockEvent,
        sourceId: "es-async-1",
        userId,
      });

      // 模拟异步调用链（如同 AgentComponent）
      let capturedContext: EnvContext | undefined;

      await runWithEnvContextAsync(envContext, async () => {
        // 模拟嵌套调用
        await Promise.resolve();
        await Promise.resolve();

        // 模拟 ToolComponent
        capturedContext = getEnvContext();
      });

      expect(capturedContext?.sourceId).toBe("es-async-1");
      expect(capturedContext?.userId).toBe("ou_async");
    });

    it("should provide replyChannel for Plugin notifications", async () => {
      const mockRawEvent = {
        event: {
          message: {
            message_id: "om_plugin_test",
            chat_id: "oc_plugin_chat",
            sender: { sender_id: { open_id: "ou_plugin_user" } },
          },
        },
      };

      const mockEvent: MockEventSourceEvent = {
        id: "es-plugin-1",
        type: "event-source.event.lark-cli",
        timestamp: Date.now(),
        metadata: { sourceId: "es-plugin-1" },
        payload: {
          sourceId: "es-plugin-1",
          sourceType: "lark-cli",
          rawEvent: mockRawEvent,
          message: "test",
          metadata: {
            messageId: "om_plugin_test",
            chatId: "oc_plugin_chat",
          },
        },
      };

      const userId = extractUserId(mockEvent.payload.rawEvent);
      const replyChannel = buildReplyChannel(
        mockEvent.payload.rawEvent,
        mockEvent.payload.metadata
      );

      const envContext = createEnvContext({
        envEvent: mockEvent,
        sourceId: "es-plugin-1",
        userId,
        replyChannel: replyChannel
          ? {
              type: replyChannel.type,
              messageId: replyChannel.messageId,
              chatId: replyChannel.chatId,
              userId: replyChannel.userId,
              identity: "bot",
              sendText: async () => {},
              sendMarkdown: async () => {},
              sendMessage: async () => {},
              reply: async () => {},
            }
          : undefined,
      });

      // 模拟 Plugin 代码（如 LarkCliTaskNotifyPlugin）
      const pluginResult = await runWithEnvContextAsync(envContext, async () => {
        const ctx = getEnvContext();
        const replyCh = ctx?.replyChannel;

        if (!replyCh) {
          return { success: false, reason: "no replyChannel" };
        }

        // 模拟发送通知
        await replyCh.sendText("Task #123 completed!");
        return { success: true };
      });

      expect(pluginResult.success).toBe(true);
    });

    it("should handle missing replyChannel gracefully", async () => {
      // 没有 replyChannel 的事件（如心跳事件）
      const mockRawEvent = { event: "heartbeat" };

      const mockEvent: MockEventSourceEvent = {
        id: "es-no-reply-1",
        type: "event-source.event.lark-cli",
        timestamp: Date.now(),
        metadata: { sourceId: "es-no-reply-1" },
        payload: {
          sourceId: "es-no-reply-1",
          sourceType: "lark-cli",
          rawEvent: mockRawEvent,
          message: "heartbeat",
          metadata: {},
        },
      };

      const envContext = createEnvContext({
        envEvent: mockEvent,
        sourceId: "es-no-reply-1",
        userId: "system",
      });

      const pluginResult = await runWithEnvContextAsync(envContext, async () => {
        const ctx = getEnvContext();
        if (!ctx?.replyChannel) {
          return { handled: true, reason: "no replyChannel" };
        }
        return { handled: false };
      });

      expect(pluginResult.handled).toBe(true);
      expect(pluginResult.reason).toBe("no replyChannel");
    });

    it("should preserve traceId across async calls", async () => {
      const mockRawEvent = {
        event: {
          message: {
            sender: { sender_id: { open_id: "ou_trace" } },
          },
        },
      };

      const mockEvent: MockEventSourceEvent = {
        id: "es-trace-1",
        type: "event-source.event.lark-cli",
        timestamp: Date.now(),
        metadata: { sourceId: "es-trace-1" },
        payload: {
          sourceId: "es-trace-1",
          sourceType: "lark-cli",
          rawEvent: mockRawEvent,
          message: "test",
          metadata: {},
        },
      };

      const envContext = createEnvContext({
        envEvent: mockEvent,
        sourceId: "es-trace-1",
        userId: "ou_trace",
      });

      const traceId = envContext.traceId!;
      const logs: string[] = [];

      // 模拟多个日志点
      await runWithEnvContextAsync(envContext, async () => {
        logs.push(`[TRACE:${getEnvContext()?.traceId}] Step 1`);
        await Promise.resolve();
        logs.push(`[TRACE:${getEnvContext()?.traceId}] Step 2`);
        await Promise.resolve();
        logs.push(`[TRACE:${getEnvContext()?.traceId}] Step 3`);
      });

      // 所有日志应该有相同的 traceId
      expect(logs.every(l => l.includes(traceId))).toBe(true);
    });
  });

  describe("Plugin scenarios", () => {
    it("should extract fields from envEvent in Plugin", async () => {
      const mockRawEvent = {
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: {
            message_id: "om_full_event",
            chat_id: "oc_full_chat",
            sender: { sender_id: { open_id: "ou_full_user" } },
          },
        },
      };

      const mockEvent: MockEventSourceEvent = {
        id: "es-full-1",
        type: "event-source.event.lark-cli",
        timestamp: Date.now(),
        metadata: { sourceId: "es-full-1" },
        payload: {
          sourceId: "es-full-1",
          sourceType: "lark-cli",
          rawEvent: mockRawEvent,
          message: "test",
          metadata: {
            messageId: "om_full_event",
            chatId: "oc_full_chat",
          },
        },
      };

      const envContext = createEnvContext({
        envEvent: mockEvent,
        sourceId: "es-full-1",
        userId: "ou_full_user",
      });

      // 模拟 Plugin 访问完整事件
      const result = await runWithEnvContextAsync(envContext, async () => {
        const ctx = getEnvContext();
        const event = ctx?.envEvent as MockEventSourceEvent;

        return {
          sourceId: event?.metadata?.sourceId,
          messageId: event?.payload?.metadata?.messageId,
          chatId: event?.payload?.metadata?.chatId,
          userId: ctx?.userId,
        };
      });

      expect(result.sourceId).toBe("es-full-1");
      expect(result.messageId).toBe("om_full_event");
      expect(result.chatId).toBe("oc_full_chat");
      expect(result.userId).toBe("ou_full_user");
    });
  });
});

// ============================================================================
// Nested Agent agentContext Reference Sharing Tests
// ============================================================================

describe("Nested agent agentContext sharing", () => {
  it("should propagate currentTaskId from child to parent via shared agentContext", async () => {
    // 模拟父 Agent — 初始化 agentContext 作为共享容器
    // （真实场景中，父 agent 通过首次 setCurrentTaskId 创建该容器）
    const parentContext = createEnvContext({
      envEvent: { type: "test", payload: {} },
      sourceId: "parent-agent",
      userId: "user-parent",
    });
    // 初始化共享容器（父 agent 首次 setCurrentTaskId 时会创建）
    parentContext.agentContext = {};

    // 子 context 通过展开继承父级 — agentContext 引用自然共享
    const childContext: EnvContext = {
      ...parentContext,
    };

    await runWithEnvContextAsync(parentContext, async () => {
      expect(getEnvContext()?.agentContext?.currentTaskId).toBeUndefined();

      // 子 Agent 设置 taskId（模拟 task_create）
      await runWithEnvContextAsync(childContext, async () => {
        const ctx = getEnvContext();
        // 通过 agentContext 共享引用设置
        ctx!.agentContext!.currentTaskId = 200;
      });

      // ✅ 父级可以看到子级设置的 taskId（agentContext 引用共享）
      expect(getEnvContext()?.agentContext?.currentTaskId).toBe(200);
    });
  });

  it("should propagate currentTaskId through multiple nesting levels", async () => {
    const rootContext = createEnvContext({
      envEvent: { type: "test", payload: {} },
      sourceId: "root-agent",
      userId: "user-root",
    });
    rootContext.agentContext = {}; // 共享容器

    const childContext: EnvContext = {
      ...rootContext,
    };

    const grandchildContext: EnvContext = {
      ...childContext,
    };

    await runWithEnvContextAsync(rootContext, async () => {
      await runWithEnvContextAsync(childContext, async () => {

        await runWithEnvContextAsync(grandchildContext, async () => {
          const ctx = getEnvContext();
          ctx!.agentContext!.currentTaskId = 99;
        });

        // 子级可以看到孙级的修改
        expect(getEnvContext()?.agentContext?.currentTaskId).toBe(99);
      });

      // 根级也可以看到
      expect(getEnvContext()?.agentContext?.currentTaskId).toBe(99);
    });
  });

  it("should handle concurrent children with independent agentContext (different ALS roots)", async () => {
    // 不同 ALS root context 有不同的 agentContext 引用，互不影响
    const parentA = createEnvContext({
      envEvent: { type: "test", payload: {} },
      sourceId: "A",
      userId: "user-A",
    });
    parentA.agentContext = {};
    const childA: EnvContext = {
      ...parentA,
    };

    const parentB = createEnvContext({
      envEvent: { type: "test", payload: {} },
      sourceId: "B",
      userId: "user-B",
    });
    parentB.agentContext = {};
    const childB: EnvContext = {
      ...parentB,
    };

    // 并发执行—两个独立的 ALS root，各自有独立的 agentContext
    const [resultA, resultB] = await Promise.all([
      runWithEnvContextAsync(parentA, async () => {
        await runWithEnvContextAsync(childA, async () => {
          const ctx = getEnvContext();
          ctx!.agentContext!.currentTaskId = 10;
        });
        return getEnvContext()?.agentContext?.currentTaskId;
      }),
      runWithEnvContextAsync(parentB, async () => {
        await runWithEnvContextAsync(childB, async () => {
          const ctx = getEnvContext();
          ctx!.agentContext!.currentTaskId = 20;
        });
        return getEnvContext()?.agentContext?.currentTaskId;
      }),
    ]);

    expect(resultA).toBe(10);
    expect(resultB).toBe(20);
  });

  /**
   * 嵌套 Agent replyChannel 传递测试
   *
   * 验证场景：
   * - 父 Agent 创建 EnvContext（包含 replyChannel）
   * - 子 Agent（嵌套场景）通过 runWithEnvContextAsync 创建新的 EnvContext
   * - 子 Agent 的 EnvContext 应继承父级的 replyChannel（parent 优先策略）
   * - 子 Agent 可以使用该 replyChannel 发送通知
   *
   * 设计原理：
   * EnvContext 构建时 replyChannel 的优先级策略为 parent 优先：
   * replyChannel: parentEnvContext?.replyChannel ?? (effectiveContext.envEvent as any)?.metadata?.replyChannel
   * 这确保子 Agent 即使没有显式设置 replyChannel，也能使用父级的回复通道。
   */
  it("should propagate replyChannel from parent to nested agent", async () => {
    // 模拟父 Agent 的 EnvContext（包含 replyChannel）
    let childReplyChannel: any = undefined;
    let parentReplyChannel: any = undefined;

    const parentEnvContext = createEnvContext({
      envEvent: { type: "event-source.event.lark-cli" },
      sourceId: "es-parent-1",
      userId: "ou_parent_user",
      replyChannel: {
        type: "lark",
        messageId: "om_parent_msg",
        chatId: "oc_parent_chat",
        userId: "ou_parent_user",
        identity: "bot",
        sendText: async (_text: string) => {},
        sendMarkdown: async (_md: string) => {},
        sendMessage: async (_msg: unknown) => {},
        reply: async (_msg: unknown) => {},
      },
    });

    // 模拟子 Agent 的 effectiveContext（无 replyChannel）
    // 这与 AgentComponent 构建子 Agent EnvContext 时的参数一致
    const childEffectiveContext = createEnvContext({
      envEvent: { type: "event-source.event.lark-cli" },
      sourceId: "es-child-1",
      userId: "ou_child_user",
      // 注意：子 Agent 没有显式设置 replyChannel
    });

    // 模拟 AgentComponent 构建嵌套 EnvContext 的逻辑：
    // replyChannel: parentEnvContext?.replyChannel ?? effectiveContext.envEvent?.metadata?.replyChannel
    await runWithEnvContextAsync(parentEnvContext, async () => {
      parentReplyChannel = getEnvContext()?.replyChannel;

      // 模拟 AgentComponent 的 EnvContext 构建过程
      // 从 ALS 获取父级上下文
      const parentCtx = getEnvContext();

      // ★ AgentComponent 构建子 EnvContext 时用到的逻辑：
      // replyChannel: parentEnvContext?.replyChannel ?? (effectiveContext.envEvent as any)?.metadata?.replyChannel
      const childEnvContext = createEnvContext({
        ...childEffectiveContext,
        // parent 优先策略：优先继承父级 ALS 上下文的 replyChannel
        replyChannel: parentCtx?.replyChannel ?? (childEffectiveContext.envEvent as any)?.metadata?.replyChannel,
      });

      // 子 Agent 使用构建好的 childEnvContext 运行
      await runWithEnvContextAsync(childEnvContext, async () => {
        const childCtx = getEnvContext();
        childReplyChannel = childCtx?.replyChannel;
      });
    });

    // 验证父级有 replyChannel
    expect(parentReplyChannel).toBeDefined();
    expect(parentReplyChannel?.messageId).toBe("om_parent_msg");

    // 验证子级继承了父级的 replyChannel（parent 优先策略）
    expect(childReplyChannel).toBeDefined();
    expect(childReplyChannel?.messageId).toBe("om_parent_msg");
    expect(childReplyChannel?.chatId).toBe("oc_parent_chat");
  });

  /**
   * 子 Agent 的 envEvent 覆盖不影响父级 replyChannel 传递
   *
   * 验证场景：
   * - 子 Agent 显式设置了 envEvent（effective 优先），但没有设置 replyChannel
   * - replyChannel 仍然从父级继承（parent 优先），不受 envEvent 覆盖影响
   *
   * 这验证了 envEvent 和 replyChannel 有不同的优先级策略：
   * - envEvent: effective 优先，parent 兜底
   * - replyChannel: parent 优先，effective 兜底
   */
  it("should keep parent replyChannel when child overrides envEvent", async () => {
    const parentEnvContext = createEnvContext({
      envEvent: { type: "original" },
      sourceId: "es-parent-2",
      userId: "ou_parent_2",
      replyChannel: {
        type: "lark",
        messageId: "om_parent_2",
        chatId: "oc_parent_2",
        userId: "ou_parent_2",
        identity: "bot",
        sendText: async (_text: string) => {},
        sendMarkdown: async (_md: string) => {},
        sendMessage: async (_msg: unknown) => {},
        reply: async (_msg: unknown) => {},
      },
    });

    // 子 Agent 的 effectiveContext 有自己独立的 envEvent 但没有 replyChannel
    // 模拟 AgentComponent 的场景：effectiveContext.envEvent 存在，但 replyChannel 从 parent 继承
    const childEffectiveContext = createEnvContext({
      envEvent: { type: "child-event", id: "custom_123" },  // 子 Agent 自己的 envEvent
      sourceId: "es-child-2",
      userId: "ou_child_2",
      // 没有 replyChannel
    });

    let childEnvEvent: any = undefined;
    let childReplyChannel: any = undefined;

    // 模拟 AgentComponent 的 EnvContext 构建：
    // envEvent: effectiveContext.envEvent ?? parentEnvContext?.envEvent
    // replyChannel: parentEnvContext?.replyChannel ?? effectiveContext.envEvent?.metadata?.replyChannel
    await runWithEnvContextAsync(parentEnvContext, async () => {
      const parentCtx = getEnvContext();

      // ★ AgentComponent 构建子 EnvContext 时用到的逻辑
      const childEnvContext = createEnvContext({
        ...childEffectiveContext,
        // envEvent: effective 优先
        envEvent: childEffectiveContext.envEvent ?? parentCtx?.envEvent,
        // replyChannel: parent 优先
        replyChannel: parentCtx?.replyChannel ?? (childEffectiveContext.envEvent as any)?.metadata?.replyChannel,
      });

      await runWithEnvContextAsync(childEnvContext, async () => {
        const ctx = getEnvContext();
        childEnvEvent = ctx?.envEvent;
        childReplyChannel = ctx?.replyChannel;
      });
    });

    // envEvent 应是子 Agent 自己的（effective 优先）
    // 因为 childEffectiveContext.envEvent 存在，不会回退到 parent
    expect(childEnvEvent).toBeDefined();
    expect((childEnvEvent as any).type).toBe("child-event");

    // replyChannel 应从父级继承（parent 优先）
    expect(childReplyChannel).toBeDefined();
    expect(childReplyChannel?.messageId).toBe("om_parent_2");
    expect(childReplyChannel?.chatId).toBe("oc_parent_2");
  });

  /**
   * Task #4111 P0-2: effective 优先（修复 #4106 → #3990 群送错群 bug）
   *
   * 背景：#4108 v2 根因分析发现，sub-agent 进程内 parentEnvContext?.replyChannel
   * 往往是上一事件 ALS 缓存的污染值（用户切换群聊后，main process 长期持有的
   * parentEnvContext.replyChannel 不会立即更新）。如果继续走 parent 优先策略，
   * 当前事件的 envEvent.metadata.replyChannel 会被父级污染值覆盖，导致通知送错群。
   *
   * 修复策略（与 v2 报告一致）：envEvent.metadata.replyChannel 优先（= 当前事件），
   * parentEnvContext.replyChannel 兜底（= 继承父级 ALS 上下文）。
   */
  it("Task #4111 P0-2: effective envEvent.metadata.replyChannel should override parent (cross-chat pollution fix)", async () => {
    // 父级 ALS 持有的是上一事件（用户上一群）的污染值
    const parentEnvContext = createEnvContext({
      envEvent: { type: "event-source.event.lark-cli" },
      sourceId: "es-polluted-parent",
      userId: "ou_parent_3",
      replyChannel: {
        type: "lark",
        messageId: "om_polluted_parent_msg",
        chatId: "oc_3990_polluted_chat", // 父级 ALS 缓存的上一群
        userId: "ou_parent_3",
        identity: "bot",
        sendText: async (_text: string) => {},
        sendMarkdown: async (_md: string) => {},
        sendMessage: async (_msg: unknown) => {},
        reply: async (_msg: unknown) => {},
      },
    });

    // 当前事件（effective）的 envEvent.metadata.replyChannel 是正确的当前群
    const childEffectiveContext = createEnvContext({
      envEvent: {
        type: "event-source.event.lark-cli",
        metadata: {
          replyChannel: {
            type: "lark",
            messageId: "om_current_event_msg",
            chatId: "oc_4106_correct_chat", // 当前事件的正确群
            userId: "ou_current_user",
            identity: "bot",
            sendText: async (_text: string) => {},
            sendMarkdown: async (_md: string) => {},
            sendMessage: async (_msg: unknown) => {},
            reply: async (_msg: unknown) => {},
          },
        },
      },
      sourceId: "es-current-effective",
      userId: "ou_current_user",
    });

    let childReplyChannel: any = undefined;

    // 模拟修复后的 AgentComponent EnvContext 构建：
    // replyChannel: (effectiveContext.envEvent as any)?.metadata?.replyChannel ?? parentEnvContext?.replyChannel
    await runWithEnvContextAsync(parentEnvContext, async () => {
      const parentCtx = getEnvContext();

      // ★ Task #4111 P0-2 修复后优先级
      const childEnvContext = createEnvContext({
        ...childEffectiveContext,
        // effective 优先：envEvent.metadata.replyChannel 覆盖 parent ALS
        replyChannel:
          (childEffectiveContext.envEvent as any)?.metadata?.replyChannel ??
          parentCtx?.replyChannel,
      });

      await runWithEnvContextAsync(childEnvContext, async () => {
        const ctx = getEnvContext();
        childReplyChannel = ctx?.replyChannel;
      });
    });

    // ★ 关键断言：child 必须用 effective 的当前事件 replyChannel（不是父级污染值）
    expect(childReplyChannel).toBeDefined();
    expect(childReplyChannel?.messageId).toBe("om_current_event_msg");
    expect(childReplyChannel?.chatId).toBe("oc_4106_correct_chat");
    // 显式断言：父级污染值必须被覆盖
    expect(childReplyChannel?.chatId).not.toBe("oc_3990_polluted_chat");
    expect(childReplyChannel?.messageId).not.toBe("om_polluted_parent_msg");
  });
});
