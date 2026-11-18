/**
 * @fileoverview EnvContext Tests - TDD
 *
 * 测试新的 EnvContext 设计：
 * 1. envEvent 作为必填字段，存储完整的 EnvEvent
 * 2. sourceId、userId 从 envEvent 提取
 * 3. ReplyChannel 接口
 * 4. 自动生成 traceId/requestId
 */

import { describe, it, expect } from "bun:test";
import {
  EnvContext,
  ReplyChannel,
  getEnvContext,
  getEnvContextOrEmpty,
  hasEnvContext,
  runWithEnvContext,
  runWithEnvContextAsync,
  createEnvContext,
  mergeEnvContext,
  getCurrentTaskId,
  setCurrentTaskId,
} from "./env-context";

// ============================================================================
// Types Tests
// ============================================================================

describe("EnvContext Types", () => {
  describe("ReplyChannel", () => {
    it("should have correct interface structure", () => {
      const mockReplyChannel: ReplyChannel = {
        type: "lark",
        messageId: "om_xxx",
        userId: "ou_xxx",
        chatId: "oc_xxx",
        identity: "bot",
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      };

      expect(mockReplyChannel.type).toBe("lark");
      expect(mockReplyChannel.messageId).toBe("om_xxx");
      expect(mockReplyChannel.userId).toBe("ou_xxx");
      expect(mockReplyChannel.chatId).toBe("oc_xxx");
      expect(mockReplyChannel.identity).toBe("bot");
      expect(typeof mockReplyChannel.sendText).toBe("function");
      expect(typeof mockReplyChannel.sendMarkdown).toBe("function");
      expect(typeof mockReplyChannel.sendMessage).toBe("function");
      expect(typeof mockReplyChannel.reply).toBe("function");
    });

    it("should require messageId for reply operations", () => {
      const replyChannel: ReplyChannel = {
        type: "lark",
        messageId: "om_reply_target",
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      };

      expect(replyChannel.messageId).toBe("om_reply_target");
    });

    it("should require userId or chatId for send operations", () => {
      const sendChannel: ReplyChannel = {
        type: "lark",
        userId: "ou_direct_user",
        sendText: async () => {},
        sendMarkdown: async () => {},
        sendMessage: async () => {},
        reply: async () => {},
      };

      expect(sendChannel.userId).toBe("ou_direct_user");
      expect(sendChannel.chatId).toBeUndefined();
    });
  });

  describe("EnvContext", () => {
    describe("required fields", () => {
      it("should require envEvent, sourceId, and userId", () => {
        const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
        const context: EnvContext = {
          envEvent: mockEnvEvent,
          sourceId: "es-1",
          userId: "user-1",
        };

        expect(context.envEvent).toEqual(mockEnvEvent);
        expect(context.sourceId).toBe("es-1");
        expect(context.userId).toBe("user-1");
      });
    });

    describe("optional fields", () => {
      it("should accept traceId and requestId", () => {
        const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
        const context: EnvContext = {
          envEvent: mockEnvEvent,
          sourceId: "es-1",
          userId: "user-1",
          traceId: "trace-abc",
          requestId: "req-xyz",
        };

        expect(context.traceId).toBe("trace-abc");
        expect(context.requestId).toBe("req-xyz");
      });

      it("should accept timestamp", () => {
        const now = Date.now();
        const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
        const context: EnvContext = {
          envEvent: mockEnvEvent,
          sourceId: "es-1",
          userId: "user-1",
          timestamp: now,
        };

        expect(context.timestamp).toBe(now);
      });
    });

    describe("ReplyChannel", () => {
      it("should accept ReplyChannel", () => {
        const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
        const context: EnvContext = {
          envEvent: mockEnvEvent,
          sourceId: "es-1",
          userId: "user-1",
          replyChannel: {
            type: "lark",
            sendText: async () => {},
            sendMarkdown: async () => {},
            sendMessage: async () => {},
            reply: async () => {},
          },
        };

        expect(context.replyChannel).toBeDefined();
        expect(context.replyChannel?.type).toBe("lark");
        expect(typeof context.replyChannel?.sendText).toBe("function");
      });
    });

    describe("plugin fields", () => {
      it("should accept pluginEnabled mapping", () => {
        const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
        const context: EnvContext = {
          envEvent: mockEnvEvent,
          sourceId: "es-1",
          userId: "user-1",
          pluginEnabled: {
            "es-1:task-notify": true,
            "es-1:task-tag": false,
          },
          plugins: ["task-notify", "task-tag"],
        };

        expect(context.pluginEnabled?.["es-1:task-notify"]).toBe(true);
        expect(context.pluginEnabled?.["es-1:task-tag"]).toBe(false);
        expect(context.plugins).toEqual(["task-notify", "task-tag"]);
      });
    });
  });
});

// ============================================================================
// Storage Tests
// ============================================================================

describe("envContextStorage", () => {
  describe("getEnvContext", () => {
    it("should return undefined when no context is set", () => {
      const context = getEnvContext();
      expect(context).toBeUndefined();
    });

    it("should return context when set via runWithEnvContext", () => {
      const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
      const testContext: EnvContext = {
        envEvent: mockEnvEvent,
        sourceId: "es-test",
        userId: "user-test",
      };

      const result = runWithEnvContext(testContext, () => {
        return getEnvContext();
      });

      expect(result).toEqual(testContext);
    });
  });

  describe("getEnvContextOrEmpty", () => {
    it("should return empty object when no context is set", () => {
      const context = getEnvContextOrEmpty();
      expect(context).toEqual({});
    });

    it("should return actual context when set", () => {
      const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
      const testContext: EnvContext = {
        envEvent: mockEnvEvent,
        sourceId: "es-empty",
        userId: "user-empty",
      };

      const result = runWithEnvContext(testContext, () => {
        return getEnvContextOrEmpty();
      });

      expect(result).toEqual(testContext);
    });
  });

  describe("hasEnvContext", () => {
    it("should return false when no context is set", () => {
      expect(hasEnvContext()).toBe(false);
    });

    it("should return true when context is set", () => {
      const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
      const testContext: EnvContext = {
        envEvent: mockEnvEvent,
        sourceId: "es-has",
        userId: "user-has",
      };

      const result = runWithEnvContext(testContext, () => {
        return hasEnvContext();
      });

      expect(result).toBe(true);
    });
  });
});

// ============================================================================
// runWithEnvContext Tests
// ============================================================================

describe("runWithEnvContext", () => {
  it("should execute function with provided context", () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const testContext: EnvContext = {
      envEvent: mockEnvEvent,
      sourceId: "es-run",
      userId: "user-run",
    };

    let capturedContext: EnvContext | undefined;

    runWithEnvContext(testContext, () => {
      capturedContext = getEnvContext();
    });

    expect(capturedContext).toEqual(testContext);
    expect(capturedContext?.sourceId).toBe("es-run");
  });

  it("should return function result", () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const testContext: EnvContext = {
      envEvent: mockEnvEvent,
      sourceId: "es-result",
      userId: "user-result",
    };

    const result = runWithEnvContext(testContext, () => {
      return "success";
    });

    expect(result).toBe("success");
  });

  it("should execute without context when undefined passed", () => {
    let capturedContext: EnvContext | undefined;

    const result = runWithEnvContext(undefined, () => {
      capturedContext = getEnvContext();
      return "success";
    });

    expect(capturedContext).toBeUndefined();
    expect(result).toBe("success");
  });
});

// ============================================================================
// runWithEnvContextAsync Tests
// ============================================================================

describe("runWithEnvContextAsync", () => {
  it("should execute async function with provided context", async () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const testContext: EnvContext = {
      envEvent: mockEnvEvent,
      sourceId: "es-async",
      userId: "user-async",
    };

    const result = await runWithEnvContextAsync(testContext, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getEnvContext();
    });

    expect(result?.sourceId).toBe("es-async");
  });

  it("should isolate context between nested calls", async () => {
    const mockEnvEvent1 = { type: "event-1", payload: {} };
    const mockEnvEvent2 = { type: "event-2", payload: {} };
    const context1: EnvContext = {
      envEvent: mockEnvEvent1,
      sourceId: "es-outer",
      userId: "user-outer",
    };
    const context2: EnvContext = {
      envEvent: mockEnvEvent2,
      sourceId: "es-inner",
      userId: "user-inner",
    };

    await runWithEnvContextAsync(context1, async () => {
      expect(getEnvContext()?.sourceId).toBe("es-outer");

      await runWithEnvContextAsync(context2, async () => {
        expect(getEnvContext()?.sourceId).toBe("es-inner");
      });

      // After nested call, should restore outer context
      expect(getEnvContext()?.sourceId).toBe("es-outer");
    });
  });

  it("should propagate context through promise chains", async () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const testContext: EnvContext = {
      envEvent: mockEnvEvent,
      sourceId: "es-promise",
      userId: "user-promise",
    };

    const result = await runWithEnvContextAsync(testContext, async () => {
      const step1 = await Promise.resolve(1);
      const step2 = await Promise.resolve(2);
      const context = getEnvContext();
      return step1 + step2 + (context?.sourceId === "es-promise" ? 100 : 0);
    });

    expect(result).toBe(103);
  });

  it("should execute without context when undefined passed", async () => {
    let capturedContext: EnvContext | undefined;

    const result = await runWithEnvContextAsync(undefined, async () => {
      capturedContext = getEnvContext();
      return "success";
    });

    expect(capturedContext).toBeUndefined();
    expect(result).toBe("success");
  });
});

// ============================================================================
// createEnvContext Tests
// ============================================================================

describe("createEnvContext", () => {
  it("should create context with required fields", () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const context = createEnvContext({
      envEvent: mockEnvEvent,
      sourceId: "es-create",
      userId: "user-create",
    });

    expect(context.envEvent).toEqual(mockEnvEvent);
    expect(context.sourceId).toBe("es-create");
    expect(context.userId).toBe("user-create");
  });

  it("should auto-generate traceId", () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const context = createEnvContext({
      envEvent: mockEnvEvent,
      sourceId: "es-id",
      userId: "user-id",
    });

    expect(context.traceId).toBeDefined();
    expect(typeof context.traceId).toBe("string");
  });

  it("should auto-generate requestId", () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const context = createEnvContext({
      envEvent: mockEnvEvent,
      sourceId: "es-id",
      userId: "user-id",
    });

    expect(context.requestId).toBeDefined();
    expect(typeof context.requestId).toBe("string");
  });

  it("should auto-generate unique traceId and requestId", () => {
    const mockEnvEvent1 = { type: "event-1", payload: {} };
    const mockEnvEvent2 = { type: "event-2", payload: {} };
    const context1 = createEnvContext({
      envEvent: mockEnvEvent1,
      sourceId: "es-1",
      userId: "user-1",
    });
    const context2 = createEnvContext({
      envEvent: mockEnvEvent2,
      sourceId: "es-2",
      userId: "user-2",
    });

    expect(context1.traceId).not.toBe(context2.traceId);
    expect(context1.requestId).not.toBe(context2.requestId);
  });

  it("should set timestamp", () => {
    const before = Date.now();
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const context = createEnvContext({
      envEvent: mockEnvEvent,
      sourceId: "es-ts",
      userId: "user-ts",
    });
    const after = Date.now();

    expect(context.timestamp).toBeDefined();
    expect(context.timestamp!).toBeGreaterThanOrEqual(before);
    expect(context.timestamp!).toBeLessThanOrEqual(after);
  });

  it("should include optional fields", () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const mockReplyChannel: ReplyChannel = {
      type: "lark",
      sendText: async () => {},
      sendMarkdown: async () => {},
      sendMessage: async () => {},
      reply: async () => {},
    };

    const context = createEnvContext({
      envEvent: mockEnvEvent,
      sourceId: "es-optional",
      userId: "user-optional",
      replyChannel: mockReplyChannel,
      pluginEnabled: { "es-optional:plugin": true },
      plugins: ["plugin"],
    });

    expect(context.replyChannel).toBe(mockReplyChannel);
    expect(context.pluginEnabled).toEqual({ "es-optional:plugin": true });
    expect(context.plugins).toEqual(["plugin"]);
  });

  it("should allow override of auto-generated fields", () => {
    const customTraceId = "custom-trace-id";
    const customRequestId = "custom-request-id";
    const customTimestamp = 1234567890;
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };

    const context = createEnvContext({
      envEvent: mockEnvEvent,
      sourceId: "es-override",
      userId: "user-override",
      traceId: customTraceId,
      requestId: customRequestId,
      timestamp: customTimestamp,
    });

    expect(context.traceId).toBe(customTraceId);
    expect(context.requestId).toBe(customRequestId);
    expect(context.timestamp).toBe(customTimestamp);
  });
});

// ============================================================================
// mergeEnvContext Tests
// ============================================================================

describe("mergeEnvContext", () => {
  it("should merge fields into current context", () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    const testContext: EnvContext = {
      envEvent: mockEnvEvent,
      sourceId: "es-merge",
      userId: "user-merge",
    };

    runWithEnvContext(testContext, () => {
      // Merge additional fields
      mergeEnvContext({
        plugins: ["task-notify"],
        pluginEnabled: { "es-merge:task-notify": true },
      });

      const updated = getEnvContext();
      expect(updated?.sourceId).toBe("es-merge");
      expect(updated?.userId).toBe("user-merge");
      expect(updated?.plugins).toEqual(["task-notify"]);
      expect(updated?.pluginEnabled?.["es-merge:task-notify"]).toBe(true);
    });
  });

  it("should not throw when no context is set", () => {
    expect(() => {
      mergeEnvContext({ plugins: ["task-notify"] });
    }).not.toThrow();
  });
});

// ============================================================================
// Plugin Usage Scenarios Tests
// ============================================================================

describe("Plugin usage scenarios", () => {
  describe("TaskNotifyPlugin pattern", () => {
    it("should get replyChannel for sending notifications", async () => {
      const mockSendText = async () => {};
      const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
      const context = createEnvContext({
        envEvent: mockEnvEvent,
        sourceId: "es-lark",
        userId: "user-ou123",
        replyChannel: {
          type: "lark",
          sendText: mockSendText,
          sendMarkdown: async () => {},
          sendMessage: async () => {},
          reply: async () => {},
        },
      });

      // Simulate Plugin code
      const pluginResult = await runWithEnvContextAsync(context, async () => {
        const ctx = getEnvContext();
        if (!ctx?.replyChannel) {
          return { success: false, reason: "no replyChannel" };
        }
        await ctx.replyChannel.sendText("Task #123 completed!");
        return { success: true };
      });

      expect(pluginResult.success).toBe(true);
    });

    it("should get traceId for logging correlation", async () => {
      const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
      const context = createEnvContext({
        envEvent: mockEnvEvent,
        sourceId: "es-lark",
        userId: "user-xyz",
      });

      const logs: string[] = [];

      await runWithEnvContextAsync(context, async () => {
        const ctx = getEnvContext();

        // Simulate multiple log points
        logs.push(`[${ctx?.traceId}] Operation started`);
        await Promise.resolve();
        logs.push(`[${ctx?.traceId}] Operation continued`);
        await Promise.resolve();
        logs.push(`[${ctx?.traceId}] Operation completed`);
      });

      // All logs should have the same traceId
      const traceIds = logs.map(l => l.match(/\[(.*?)\]/)?.[1]);
      expect(traceIds[0]).toBe(traceIds[1]);
      expect(traceIds[1]).toBe(traceIds[2]);
    });

    it("should get envEvent for full access", async () => {
      const mockEnvEvent = {
        type: "im.message.receive_v1",
        payload: {
          message_id: "om_123",
          sender_id: "ou_456",
          chat_id: "oc_789",
        },
      };
      const context = createEnvContext({
        envEvent: mockEnvEvent,
        sourceId: "es-lark",
        userId: "ou_456",
      });

      const result = await runWithEnvContextAsync(context, async () => {
        const ctx = getEnvContext();
        // Plugin can access full envEvent
        const event = ctx?.envEvent as typeof mockEnvEvent;
        return {
          messageId: event?.payload?.message_id,
          senderId: event?.payload?.sender_id,
          chatId: event?.payload?.chat_id,
        };
      });

      expect(result.messageId).toBe("om_123");
      expect(result.senderId).toBe("ou_456");
      expect(result.chatId).toBe("oc_789");
    });

    it("should check pluginEnabled for conditional logic", async () => {
      const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
      const context = createEnvContext({
        envEvent: mockEnvEvent,
        sourceId: "es-lark",
        userId: "user-plugin",
        pluginEnabled: {
          "es-lark:task-notify": true,
          "es-lark:task-tag": false,
        },
        plugins: ["task-notify", "task-tag"],
      });

      const result = await runWithEnvContextAsync(context, async () => {
        const ctx = getEnvContext();
        const shouldNotify = ctx?.pluginEnabled?.["es-lark:task-notify"];
        const shouldTag = ctx?.pluginEnabled?.["es-lark:task-tag"];
        return { shouldNotify, shouldTag, allPlugins: ctx?.plugins };
      });

      expect(result.shouldNotify).toBe(true);
      expect(result.shouldTag).toBe(false);
      expect(result.allPlugins).toEqual(["task-notify", "task-tag"]);
    });

    it("should handle missing replyChannel gracefully", async () => {
      const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
      const context = createEnvContext({
        envEvent: mockEnvEvent,
        sourceId: "es-no-reply",
        userId: "user-no-reply",
        // No replyChannel
      });

      const result = await runWithEnvContextAsync(context, async () => {
        const ctx = getEnvContext();
        if (!ctx?.replyChannel) {
          return { handled: true, reason: "no replyChannel" };
        }
        return { handled: false };
      });

      expect(result.handled).toBe(true);
      expect(result.reason).toBe("no replyChannel");
    });
  });
});

// ============================================================================
// AsyncLocalStorage Isolation Tests
// ============================================================================

describe("AsyncLocalStorage isolation", () => {
  it("should not leak context after runWithEnvContext completes", () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    runWithEnvContext(
      { envEvent: mockEnvEvent, sourceId: "es-leak", userId: "user-leak" },
      () => {
        expect(getEnvContext()?.sourceId).toBe("es-leak");
      }
    );

    // After completion, should be undefined
    expect(getEnvContext()).toBeUndefined();
  });

  it("should not leak context after runWithEnvContextAsync completes", async () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    await runWithEnvContextAsync(
      { envEvent: mockEnvEvent, sourceId: "es-leak-async", userId: "user-leak-async" },
      async () => {
        await Promise.resolve();
        expect(getEnvContext()?.sourceId).toBe("es-leak-async");
      }
    );

    // After completion, should be undefined
    expect(getEnvContext()).toBeUndefined();
  });

  it("should handle errors and still clean up context", async () => {
    const mockEnvEvent = { type: "im.message.receive_v1", payload: {} };
    try {
      await runWithEnvContextAsync(
        { envEvent: mockEnvEvent, sourceId: "es-error", userId: "user-error" },
        async () => {
          throw new Error("Test error");
        }
      );
    } catch (e) {
      // Expected
    }

    expect(getEnvContext()).toBeUndefined();
  });
});


// ============================================================================
// currentTaskId Tests (via agentContext)
// ============================================================================

describe("currentTaskId via agentContext", () => {
  it("should return undefined by default", () => {
    expect(getCurrentTaskId()).toBeUndefined();
  });

  it("should be set via setCurrentTaskId", () => {
    runWithEnvContext(
      { envEvent: { type: "test" }, sourceId: "test", userId: "test" },
      () => {
        expect(getCurrentTaskId()).toBeUndefined();
        
        setCurrentTaskId(42);
        expect(getCurrentTaskId()).toBe(42);
        
        setCurrentTaskId(100);
        expect(getCurrentTaskId()).toBe(100);
      }
    );
  });

  it("should be cleared via setCurrentTaskId(undefined)", () => {
    runWithEnvContext(
      { envEvent: { type: "test" }, sourceId: "test", userId: "test" },
      () => {
        setCurrentTaskId(42);
        expect(getCurrentTaskId()).toBe(42);
        
        setCurrentTaskId(undefined);
        expect(getCurrentTaskId()).toBeUndefined();
      }
    );
  });

  it("should be isolated per AsyncLocalStorage context", async () => {
    const results: (number | undefined)[] = [];
    
    await Promise.all([
      runWithEnvContextAsync(
        { envEvent: { type: "test" }, sourceId: "s1", userId: "u1" },
        async () => {
          setCurrentTaskId(1);
          await new Promise(r => setTimeout(r, 10));
          results.push(getCurrentTaskId());
        }
      ),
      runWithEnvContextAsync(
        { envEvent: { type: "test" }, sourceId: "s2", userId: "u2" },
        async () => {
          setCurrentTaskId(2);
          await new Promise(r => setTimeout(r, 5));
          results.push(getCurrentTaskId());
        }
      ),
    ]);
    
    expect(results.sort()).toEqual([1, 2]);
  });

  it("should auto-create agentContext on first setCurrentTaskId", () => {
    runWithEnvContext(
      { envEvent: { type: "test" }, sourceId: "test", userId: "test" },
      () => {
        // Initially no agentContext
        const ctx = getEnvContext()!;
        expect(ctx.agentContext).toBeUndefined();
        
        // First set should create it
        setCurrentTaskId(42);
        expect(ctx.agentContext).toBeDefined();
        expect(ctx.agentContext!.currentTaskId).toBe(42);
      }
    );
  });
});

// ============================================================================
// agentContext Reference Sharing Tests
// ============================================================================

describe("agentContext reference sharing", () => {
  it("should share agentContext reference between parent and child contexts via spread", () => {
    const shared = { currentTaskId: 100 };
    const parentContext: EnvContext = {
      envEvent: { type: "test" },
      sourceId: "parent",
      userId: "parent-user",
      agentContext: shared,
    };
    // child spreads parent — agentContext is the SAME reference
    const childContext: EnvContext = {
      ...parentContext,
    };

    // Both should point to the same object
    expect(childContext.agentContext).toBe(parentContext.agentContext);
    expect(childContext.agentContext!.currentTaskId).toBe(100);
  });

  it("should propagate setCurrentTaskId from child to parent via shared reference", async () => {
    const parentContext: EnvContext = {
      envEvent: { type: "test" },
      sourceId: "parent",
      userId: "parent-user",
      agentContext: {}, // 共享容器—parent 初始化，child spread 自然共享引用
    };

    // Child context inherits via spread — agentContext 引用自然共享
    const childContext: EnvContext = {
      ...parentContext,
    };

    await runWithEnvContextAsync(parentContext, async () => {
      expect(getCurrentTaskId()).toBeUndefined();

      await runWithEnvContextAsync(childContext, async () => {
        // Child sets taskId via setCurrentTaskId
        setCurrentTaskId(200);
        expect(getCurrentTaskId()).toBe(200);
      });

      // Parent should SEE the child's taskId because agentContext is shared!
      expect(getCurrentTaskId()).toBe(200);
    });
  });

  it("should propagate setCurrentTaskId through multiple nesting levels", async () => {
    const rootContext: EnvContext = {
      envEvent: { type: "test" },
      sourceId: "root",
      userId: "root-user",
      agentContext: {}, // 共享容器
    };

    // mid 和 leaf 通过 spread 自然共享 agentContext 引用
    const midContext: EnvContext = {
      ...rootContext,
    };

    const leafContext: EnvContext = {
      ...midContext,
    };

    await runWithEnvContextAsync(rootContext, async () => {
      // Root sets taskId
      setCurrentTaskId(1);
      expect(getCurrentTaskId()).toBe(1);

      await runWithEnvContextAsync(midContext, async () => {
        expect(getCurrentTaskId()).toBe(1); // inherited via shared ref

        await runWithEnvContextAsync(leafContext, async () => {
          // Leaf overwrites
          setCurrentTaskId(999);
          expect(getCurrentTaskId()).toBe(999);
        });

        // Back in mid, should see leaf's change
        expect(getCurrentTaskId()).toBe(999);
      });

      // Back in root, should see leaf's change too
      expect(getCurrentTaskId()).toBe(999);
    });
  });

  it("should allow clearing taskId from any level and parent sees it", async () => {
    const rootContext: EnvContext = {
      envEvent: { type: "test" },
      sourceId: "root",
      userId: "root-user",
      agentContext: {}, // 共享容器
    };

    const childContext: EnvContext = {
      ...rootContext,
    };

    await runWithEnvContextAsync(rootContext, async () => {
      setCurrentTaskId(42);
      expect(getCurrentTaskId()).toBe(42);

      await runWithEnvContextAsync(childContext, async () => {
        setCurrentTaskId(undefined);
        expect(getCurrentTaskId()).toBeUndefined();
      });

      // Parent should see cleared
      expect(getCurrentTaskId()).toBeUndefined();
    });
  });
});
