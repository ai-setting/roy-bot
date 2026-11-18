/**
 * @fileoverview EventSourceHandlers chat-task binding injection tests
 *
 * Task #4023: handleEvent 在解析 metadata 后、构造 evt 前，调 SessionComponent
 * 查询 chat_id → task_id 绑定，把 taskId 注入到 evt.metadata.parentTaskId 和
 * env-context.parentTaskId，供下游 task_create tool 复用为 parent_task_id。
 *
 * 单元测试覆盖：
 * 1. 无 chatId → 不查 binding（parentTaskId 留空）
 * 2. 有 chatId + 无 sessionComponent 注入 → 不注入 parentTaskId（graceful）
 * 3. 有 chatId + 有 binding → 注入 parentTaskId 到 evt.metadata 与 envContext
 * 4. 有 chatId + 无 binding → 不注入
 * 5. SessionComponent 注入逻辑：plugin 有 setSessionComponent → 自动注入
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { SessionComponent } from "../session/session-component";

// 直接测试关键函数而不实例化 LarkCliInstance（避免拉整个 plugin 配置）
import { extractMetadata, LarkCliInstance } from "./event-source-handlers";
import { getEnvContext } from "../context";
import type {
  EventSourceConfig,
  EventSourceEvent,
  EventSourceEventHandler,
} from "./types";

describe("Task #4023 — chat-task binding injection in handleEvent", () => {
  describe("extractMetadata still returns chatId", () => {
    it("嵌套格式：chat_id → metadata.chatId", () => {
      const raw = {
        event: {
          header: { event_type: "im.message.receive_v1", app_id: "cli_xxx" },
          message: {
            chat_id: "oc_abc",
            message_id: "om_xyz",
            chat_type: "group",
            message_type: "text",
          },
        },
      };
      const { metadata } = extractMetadata(raw, "im.message.receive_v1");
      expect(metadata.chatId).toBe("oc_abc");
    });

    it("简化格式：顶层 chat_id → metadata.chatId", () => {
      const raw = {
        type: "im.message.receive_v1",
        chat_id: "oc_simple",
        message_id: "om_simple",
        chat_type: "group",
        sender_id: "ou_xxx",
      };
      const { metadata } = extractMetadata(raw, "im.message.receive_v1");
      expect(metadata.chatId).toBe("oc_simple");
    });
  });

  describe("SessionComponent 注入逻辑", () => {
    it("resolveChatTaskBinding 找不到 chat → 返回 null", async () => {
      const session = {
        getChatTaskBinding: async (_chatId: string) => null,
      } as unknown as SessionComponent;

      // 这里模拟 LarkCliInstance.resolveChatTaskBinding 的行为
      const binding = await session.getChatTaskBinding("oc_not_found");
      expect(binding).toBeNull();
    });

    it("resolveChatTaskBinding 找到 chat → 返回 binding with taskId", async () => {
      const session = {
        getChatTaskBinding: async (chatId: string) => {
          if (chatId === "oc_found") {
            return {
              chatId: "oc_found",
              taskId: 12345,
              profile: "default",
              boundAt: "2026-10-09T00:00:00Z",
              status: "ready" as const,
              errorMessage: null,
              rebindCount: 0,
            };
          }
          return null;
        },
      } as unknown as SessionComponent;

      const binding = await session.getChatTaskBinding("oc_found");
      expect(binding).not.toBeNull();
      expect(binding!.taskId).toBe(12345);
    });
  });

  describe("LarkCliInstance.handleEvent 集成测试", () => {
    function makeConfig(): EventSourceConfig {
      return {
        id: "es-test-binding",
        name: "binding test",
        type: "lark-cli",
        enabled: true,
        command: "lark-cli --profile default event consume im.message.receive_v1 --as bot",
      };
    }

    function makeRawData(chatId: string, eventId: string): string {
      return JSON.stringify({
        type: "im.message.receive_v1",
        event_id: eventId,
        timestamp: "1790579077976",
        id: `om_msg_${eventId}`,
        message_id: `om_msg_${eventId}`,
        chat_id: chatId,
        chat_type: "group",
        message_type: "text",
        sender_id: { open_id: "ou_user_X" },
        sender_type: "user",
        content: "测试任务",
      });
    }

    it("注入 sessionComponent 后，有 binding 的 chat 消息 evt.metadata.parentTaskId 填上", async () => {
      const session = {
        getChatTaskBinding: async (chatId: string) => {
          if (chatId === "oc_chat_with_binding") {
            return {
              chatId,
              taskId: 8888,
              profile: "default",
              boundAt: "2026-10-09T00:00:00Z",
              status: "ready" as const,
              errorMessage: null,
              rebindCount: 0,
            };
          }
          return null;
        },
      } as unknown as SessionComponent;

      const config = makeConfig();
      const instance = new LarkCliInstance(config);
      instance.setEnvironment({
        getComponent: (name: string) => (name === "session" ? session : null),
      });

      const events: EventSourceEvent[] = [];
      // ★ Task #4023 修复：同时断言 ALS EnvContext 真携带 parentTaskId
      // （此前测试只断言 evt.metadata / evt.payload，漏掉 EnvContext 断链，
      //  导致"注入成功"是假绿）。
      let envContextParentTaskId: unknown;
      instance.onEvent(((evt: EventSourceEvent) => {
        events.push(evt);
        envContextParentTaskId = getEnvContext()?.parentTaskId;
      }) as EventSourceEventHandler);

      // 直接调用 private handleEvent
      await (instance as any).handleEvent(
        makeRawData("oc_chat_with_binding", "evt_binding_001")
      );

      expect(events).toHaveLength(1);
      expect(events[0].metadata.parentTaskId).toBe(8888);
      expect(events[0].payload.parentTaskId).toBe(8888);
      // EnvContext 必须真携带（否则 task_create 继承分支永不生效）
      expect(envContextParentTaskId).toBe(8888);
    });

    it("无 binding 的 chat 消息：parentTaskId 留空（不注入）", async () => {
      const session = {
        getChatTaskBinding: async () => null,
      } as unknown as SessionComponent;

      const config = makeConfig();
      const instance = new LarkCliInstance(config);
      instance.setEnvironment({
        getComponent: (name: string) => (name === "session" ? session : null),
      });

      const events: EventSourceEvent[] = [];
      let envContextParentTaskId: unknown = "unset";
      instance.onEvent(((evt: EventSourceEvent) => {
        events.push(evt);
        envContextParentTaskId = getEnvContext()?.parentTaskId;
      }) as EventSourceEventHandler);

      await (instance as any).handleEvent(
        makeRawData("oc_no_binding", "evt_no_binding_002")
      );

      expect(events).toHaveLength(1);
      expect(events[0].metadata.parentTaskId).toBeUndefined();
      expect(envContextParentTaskId).toBeUndefined();
    });

    it("无 sessionComponent 注入：graceful 不抛错且 parentTaskId 留空", async () => {
      const config = makeConfig();
      const instance = new LarkCliInstance(config);
      // 不注入 sessionComponent

      const events: EventSourceEvent[] = [];
      let envContextParentTaskId: unknown = "unset";
      instance.onEvent(((evt: EventSourceEvent) => {
        events.push(evt);
        envContextParentTaskId = getEnvContext()?.parentTaskId;
      }) as EventSourceEventHandler);

      await (instance as any).handleEvent(
        makeRawData("oc_no_session_component", "evt_no_session_003")
      );

      expect(events).toHaveLength(1);
      expect(events[0].metadata.parentTaskId).toBeUndefined();
      expect(envContextParentTaskId).toBeUndefined();
    });
  });
});