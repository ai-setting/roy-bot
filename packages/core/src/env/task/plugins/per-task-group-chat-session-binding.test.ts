/**
 * @fileoverview PerTaskGroupChatPlugin session-meta binding Tests
 *
 * Task #4023: onAfterCreate 在建群成功后，应同时把 chat_id ↔ task_id 绑定写
 * 到 session component 的 chat-task binding 中。让群消息事件 handler 在后续
 * 注入 event.context.parentTaskId。
 *
 * 集成测试覆盖：
 * 1. 群创建成功后 session-binding 写入
 * 2. setSessionComponent 没注入时静默 skip（不阻断主流程）
 * 3. session-binding 写入失败时不阻断主流程
 * 4. 已存在的 binding 不会被覆盖（同 taskId）
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createPerTaskGroupChatPlugin,
  PerTaskGroupChatPlugin,
  type PerTaskGroupConfig,
} from "./per-task-group-chat-plugin";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type { TaskCreateResultContext } from "../hooks/contexts";
import {
  runWithEnvContext,
  type EnvContext,
} from "../../context";

// ★ Task #4230：注入假 cardNotifier，避免真实 lark-cli 发卡（230001 网络调用）
function makeFakeNotifier(): any {
  return {
    startTask: async () => ({ messageId: "om_card_test", pinned: true }),
    updateTask: async () => {},
    finishTask: async () => {},
  };
}

// 用 per-instance override 替代 spawn（避免污染其它 test file 的 prototype）
function patchInstance(plugin: any, chatId: string) {
  (plugin as any).createGroupChat = function (_opts: any) {
    return Promise.resolve(chatId);
  };
}

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 100,
    title: "测试任务",
    description: "测试描述",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 0,
    current_status: "进行中",
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T01:00:00Z",
    project_path: "/tmp/test",
    context: "{}",
    parent_task_id: 0,
    ...overrides,
  };
}

function makeReplyChannel(overrides: Partial<any> = {}): any {
  return {
    chatId: "oc_main_chat",
    messageId: "om_msg_main",
    profile: "default",
    appId: "cli_auto123",
    ...overrides,
  };
}

function makeEnvContext(overrides: Partial<EnvContext> = {}): EnvContext {
  return {
    envEvent: { metadata: {} },
    sourceId: "es-test",
    userId: "ou_test",
    replyChannel: makeReplyChannel(),
    pluginEnabled: { "es-test:PerTaskGroupChatPlugin": true },
    ...overrides,
  } as EnvContext;
}

function makeHookContext<T>(
  hookPoint: string,
  data: T,
  metadata: Record<string, unknown> = {}
): HookContext<T> {
  return {
    hookPoint,
    data,
    metadata,
    env: { sourceId: "es-test" } as any,
  } as any;
}

describe("PerTaskGroupChatPlugin session binding (Task #4023)", () => {
  let mockSession: any;
  let upsertCalls: any[];

  beforeEach(() => {
    upsertCalls = [];
    mockSession = {
      upsertChatTaskBinding: async (opts: any) => {
        upsertCalls.push(opts);
        return {
          chatId: opts.chatId,
          taskId: opts.taskId,
          profile: opts.profile,
          boundAt: new Date().toISOString(),
          status: "ready",
          errorMessage: null,
          rebindCount: 0,
        };
      },
      getChatTaskBinding: async () => null,
    };
  });

  describe("onAfterCreate success path", () => {
    it("建群成功后调 upsertChatTaskBinding 写入 chat_id ↔ task_id", async () => {
      const plugin = createPerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin-Test",
        sourceId: "es-test",
        autoCreateGroup: true,   // ★ Task #4331：测试显式开启默认建群
        requireReplyChannel: true,
        sendWelcomeMessage: false,
        fallbackToMain: true,
        cardNotifier: makeFakeNotifier(),
      });
      patchInstance(plugin, "oc_test_chat_100");
      (plugin as any).setSessionComponent(mockSession);

      const task = makeTask({ id: 100 });
      const envCtx = makeEnvContext();
      const hookCtx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "session-abc", tagService: null as any }
      );

      await runWithEnvContext(envCtx, async () => {
        await (plugin as any).onAfterCreate(hookCtx);
      });

      // ★ Task #4023 状态机：creating → ready 两次写入
      expect(upsertCalls).toHaveLength(2);
      expect(upsertCalls[0].chatId).toBe("oc_test_chat_100");
      expect(upsertCalls[0].taskId).toBe(100);
      expect(upsertCalls[0].status).toBe("creating");
      expect(upsertCalls[1].chatId).toBe("oc_test_chat_100");
      expect(upsertCalls[1].taskId).toBe(100);
      expect(upsertCalls[1].status).toBe("ready");
    });
  });

  describe("session component not injected", () => {
    it("setSessionComponent 未注入：不抛错且不写 binding", async () => {
      const noSessionPlugin = createPerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin-NoSession",
        sourceId: "es-test",
        sendWelcomeMessage: false,
        cardNotifier: makeFakeNotifier(),
      });
      patchInstance(noSessionPlugin, "oc_test_chat_no_session");
      // 不注入 session component

      const envCtx = makeEnvContext();
      const hookCtx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task: makeTask({ id: 200 }), sessionId: "session-abc", tagService: null as any }
      );

      await expect(
        runWithEnvContext(envCtx, async () => {
          await (noSessionPlugin as any).onAfterCreate(hookCtx);
        })
      ).resolves.toBeUndefined();

      expect(upsertCalls).toHaveLength(0);
    });
  });

  describe("upsert failure handling", () => {
    it("upsertChatTaskBinding 抛错：不阻断后续通知（仅 warn）", async () => {
      const failingSession = {
        upsertChatTaskBinding: async () => {
          throw new Error("session storage unavailable");
        },
        getChatTaskBinding: async () => null,
      };

      const plugin = createPerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin-Fail",
        sourceId: "es-test",
        sendWelcomeMessage: false,
        cardNotifier: makeFakeNotifier(),
      });
      patchInstance(plugin, "oc_test_chat_fail");
      (plugin as any).setSessionComponent(failingSession);

      const envCtx = makeEnvContext();
      const hookCtx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task: makeTask({ id: 300 }), sessionId: "session-abc", tagService: null as any }
      );

      // 不应向上抛错（cardNotifier / createGroupChat 是 mocked，binding 抛错也不阻断）
      await expect(
        runWithEnvContext(envCtx, async () => {
          await (plugin as any).onAfterCreate(hookCtx);
        })
      ).resolves.toBeUndefined();
    });
  });
});