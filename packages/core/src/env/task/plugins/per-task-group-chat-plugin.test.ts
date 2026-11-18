/**
 * @fileoverview PerTaskGroupChatPlugin Tests
 *
 * 测试 PerTaskGroupChatPlugin（Task #3945）
 *
 * 覆盖场景：
 * - Plugin interface compliance
 * - P0-1: onAfterUpdate replyChannel fallback to task.context.larkPerTaskChatProfile
 * - P0-2: botAppIds 自动从 replyChannel.appId 推导
 * - P0-3: 双发问题（不同 plugin 配置行为不同）
 * - task:after.create → 创建群聊 + 存 chat_id
 * - task:after.update → 发到 task 群聊
 * - task:operation:after.create → 节流后发到 task 群聊
 * - task:after.complete → 发"任务完成"到 task 群聊
 * - sub-task 跳过建群
 * - 模板渲染
 * - 异常降级
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import {
  PerTaskGroupChatPlugin,
  createPerTaskGroupChatPlugin,
  type PerTaskGroupConfig,
} from "./per-task-group-chat-plugin";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskCompleteResultContext,
  TaskOperationCreateResultContext,
} from "../hooks/contexts";
import {
  runWithEnvContext,
  type EnvContext,
} from "../../context";

// ============================================================================
// 测试辅助
// ============================================================================

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 100,
    title: "测试任务",
    description: "测试描述",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 50,
    current_status: "进行中",
    createdAt: "2026-09-28T00:00:00Z",
    updatedAt: "2026-09-28T01:00:00Z",
    project_path: "/tmp/test",
    context: "{}",
    parent_task_id: 0,
    ...overrides,
  };
}

function makeOperation(overrides: Partial<any> = {}): any {
  return {
    id: 200,
    taskId: 100,
    sessionId: "session-abc",
    milestoneType: "milestone",
    milestoneTitle: "完成需求分析",
    milestoneDescription: "已完成核心功能的需求拆解",
    timestamp: "2026-09-28T02:00:00Z",
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
    sourceId: "es-test-1",
    userId: "ou_test",
    replyChannel: makeReplyChannel(),
    pluginEnabled: { "es-test-1:PerTaskGroupChatPlugin": true },
    ...overrides,
  } as EnvContext;
}

function makeHookContext<T>(
  hookPoint: string,
  data: T,
  metadata: Record<string, unknown> = {}
): HookContext<T> {
  return {
    component: { name: "task", version: "1.0.0" },
    data,
    metadata,
    phase: "after",
    hookPoint,
  };
}

// ============================================================================
// 通过原型替换 mock 私有方法（参考 lark-cli-task-notify-plugin.test.ts 的模式）
// ============================================================================

interface SpawnCall {
  cmd: string;
  args: string[];
  options: any;
}

let spawnCalls: SpawnCall[] = [];

function setupSpawnMock(): void {
  spawnCalls = [];

  // ★ Task #4230：旧 sendToChat / sendToMain 纯文本路径已删除，
  //   只 mock createGroupChat（避免真实 lark-cli +chat-create）。
  (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
    spawnCalls.push({ cmd: "lark-cli", args: ["im", "+chat-create", "--name", opts.name], options: {} });
    return Promise.resolve("oc_test_chat");
  };
}

// ============================================================================
// 卡片 notifier mock（★ Task #4230）
//
// 直接 patch LarkCardPatchNotifier.prototype 的 startTask / updateTask / finishTask，
// 把每次调用推进 cardCalls，避免真实 lark-cli 进程（会触发 230001 invalid receive_id）。
// 原始方法在 beforeAll 保存、afterEach 恢复，避免污染其它 test file。
// ============================================================================

interface CardCall {
  op: "start" | "update" | "finish";
  opts: any;
}

let cardCalls: CardCall[] = [];
const NOTIFIER_PROTO = LarkCardPatchNotifier.prototype as any;
const ORIGINAL_NOTIFIER_METHODS: {
  startTask?: any;
  updateTask?: any;
  finishTask?: any;
} = {};

function saveOriginalNotifierMethods(): void {
  for (const m of ["startTask", "updateTask", "finishTask"] as const) {
    if (ORIGINAL_NOTIFIER_METHODS[m] === undefined) {
      const desc = Object.getOwnPropertyDescriptor(LarkCardPatchNotifier.prototype, m);
      if (desc) ORIGINAL_NOTIFIER_METHODS[m] = desc.value;
    }
  }
}

function setupNotifierMock(): void {
  cardCalls = [];
  NOTIFIER_PROTO.startTask = async (opts: any) => {
    cardCalls.push({ op: "start", opts });
    return { messageId: "om_card_test", pinned: true };
  };
  NOTIFIER_PROTO.updateTask = async (opts: any) => {
    cardCalls.push({ op: "update", opts });
  };
  NOTIFIER_PROTO.finishTask = async (opts: any) => {
    cardCalls.push({ op: "finish", opts });
  };
}

function restoreNotifierMock(): void {
  for (const m of ["startTask", "updateTask", "finishTask"] as const) {
    if (ORIGINAL_NOTIFIER_METHODS[m] !== undefined) {
      NOTIFIER_PROTO[m] = ORIGINAL_NOTIFIER_METHODS[m];
    }
  }
}

// 保存原始方法（test isolation 修复）
// 之前用 delete 会破坏后续 test file 的 prototype 方法查找
// 改为保存原始方法并在 afterEach 恢复
const ORIGINAL_METHODS: {
  createGroupChat?: any;
} = {};

function saveOriginalMethods(): void {
  if (ORIGINAL_METHODS.createGroupChat === undefined) {
    const desc = Object.getOwnPropertyDescriptor(PerTaskGroupChatPlugin.prototype, "createGroupChat");
    if (desc) ORIGINAL_METHODS.createGroupChat = desc.value;
  }
}

function restoreSpawnMock(): void {
  // 恢复原始方法（而不是 delete），保证跨 test file 的 prototype 不被破坏
  if (ORIGINAL_METHODS.createGroupChat !== undefined) {
    (PerTaskGroupChatPlugin.prototype as any).createGroupChat = ORIGINAL_METHODS.createGroupChat;
  }
}

function setupFailingCreateMock(errorMsg: string = "create failed"): void {
  spawnCalls = [];
  (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function () {
    return Promise.reject(new Error(errorMsg));
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("PerTaskGroupChatPlugin", () => {
  beforeAll(() => {
    saveOriginalMethods();
    saveOriginalNotifierMethods();
  });

  beforeEach(() => {
    setupSpawnMock();
    setupNotifierMock();
  });

  afterEach(() => {
    restoreSpawnMock();
    restoreNotifierMock();
  });

  // ========================================================================
  // 1. Plugin interface compliance
  // ========================================================================
  describe("Plugin interface compliance", () => {
    it("should implement Hook interface", () => {
      const plugin = new PerTaskGroupChatPlugin();
      expect(typeof (plugin as any).execute).toBe("function");
      expect(typeof plugin.name).toBe("string");
      expect(typeof plugin.priority).toBe("number");
    });

    it("should have correct default priority 100", () => {
      const plugin = new PerTaskGroupChatPlugin();
      expect(plugin.priority).toBe(100);
    });

    it("should accept custom config", () => {
      const plugin = new PerTaskGroupChatPlugin({
        priority: 50,
        pluginName: "CustomName",
        nameTemplate: "Custom {id}",
      });
      expect(plugin.priority).toBe(50);
      expect(plugin.name).toBe("CustomName");
    });

    it("createPerTaskGroupChatPlugin should return instance", () => {
      const plugin = createPerTaskGroupChatPlugin();
      expect(plugin).toBeInstanceOf(PerTaskGroupChatPlugin);
    });
  });

  // ========================================================================
  // 2. disabled state
  // ========================================================================
  describe("disabled state", () => {
    it("should skip execute when enabled=false", async () => {
      const plugin = new PerTaskGroupChatPlugin({ enabled: false });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task: makeTask(), sessionId: "s", tagService: {} as any }
      );

      await plugin.execute(ctx);

      expect(spawnCalls.length).toBe(0);
    });
  });

  // ========================================================================
  // 3. pluginEnabled 检查
  // ========================================================================
  describe("pluginEnabled check", () => {
    it("should skip when pluginEnabled[sourceId:pluginName] is not true", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task: makeTask(), sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext({ pluginEnabled: {} }) }
      );

      await runWithEnvContext(makeEnvContext({ pluginEnabled: {} }), async () => {
        await plugin.execute(ctx);
      });

      expect(spawnCalls.length).toBe(0);
    });

    it("should run when pluginEnabled[sourceId:pluginName] is true", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task: makeTask({ id: 999 }), sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      expect(spawnCalls.length).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // 4. onAfterCreate
  // ========================================================================
  describe("onAfterCreate", () => {
    it("should create group chat and persist chat_id to task.context", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      let updatedContext: string | undefined;
      plugin.setTaskUpdater(async (_taskId, context) => {
        updatedContext = context;
      });

      const task = makeTask({ id: 123 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      // ★ Task #4230：建群 1 次 + 立刻发初始卡片（卡片走 notifier，不再有 sendToMain 文本路径）
      const chatCreateCall = spawnCalls.find((c) => c.args?.includes("+chat-create"));
      expect(chatCreateCall).toBeDefined();
      // ★ Task #4237：首张卡片 owner 已收归 LarkCliTaskNotifyHook ——
      //   PerTaskGroupChatPlugin 只建群，不再自己发初始卡片（避免同 task 多卡 + 双 notifier 各自 patch）
      expect(cardCalls.some((c) => c.op === "start")).toBe(false);

      // 验证 chat-create 时 name 已经包含 task id 123
      const nameIdx = chatCreateCall!.args.indexOf("--name");
      expect(chatCreateCall!.args[nameIdx + 1]).toContain("Task 123");

      // 验证 context 写入
      expect(updatedContext).toBeDefined();
      const parsed = JSON.parse(updatedContext!);
      expect(parsed.larkPerTaskChatId).toBe("oc_test_chat");
      expect(parsed.larkPerTaskChatProfile).toBe("default");
      expect(parsed.larkPerTaskChatTaskId).toBe(123);
    });

    it("should skip if replyChannel.chatId is missing", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task: makeTask(), sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext({ replyChannel: { chatId: "" } as any }) }
      );

      await runWithEnvContext(
        makeEnvContext({ replyChannel: { chatId: "" } as any }),
        async () => {
          await plugin.execute(ctx);
        }
      );

      expect(spawnCalls.length).toBe(0);
    });

    it("should skip sub-task (parent_task_id > 0)", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const subTask = makeTask({ id: 200, parent_task_id: 100 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task: subTask, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      expect(spawnCalls.length).toBe(0);
    });

    it("should fallback gracefully when chat create fails", async () => {
      setupFailingCreateMock("chat create failed");
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        fallbackToMain: true,
      });

      const task = makeTask();
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        // Should not throw
        await plugin.execute(ctx);
      });
    });

    it("should throw when fallbackToMain=false and create fails", async () => {
      setupFailingCreateMock("chat create failed");
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
        fallbackToMain: false,
      });

      const task = makeTask();
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      let threwError = false;
      await runWithEnvContext(makeEnvContext(), async () => {
        try {
          await plugin.execute(ctx);
        } catch {
          threwError = true;
        }
      });
      expect(threwError).toBe(true);
    });

    // ========================================================================
    // disableSubTaskSkip / requireReplyChannel 配置项测试
    // ========================================================================

    it("sub-task: should skip by default (disableSubTaskSkip=false)", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        // disableSubTaskSkip: false (default)
      });

      const task = makeTask({ id: 42, parent_task_id: 1 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      // sub-task 默认不建群聊
      const chatCreateCall = spawnCalls.find((c) => c.args?.includes("+chat-create"));
      expect(chatCreateCall).toBeUndefined();
    });

    it("sub-task: should create group chat when disableSubTaskSkip=true", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
        disableSubTaskSkip: true,
      });

      const task = makeTask({ id: 42, parent_task_id: 1 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      const chatCreateCall = spawnCalls.find((c) => c.args?.includes("+chat-create"));
      expect(chatCreateCall).toBeDefined();
      // 验证 group chat 是为 sub-task #42 创建的
      const nameIdx = chatCreateCall!.args.indexOf("--name");
      expect(chatCreateCall!.args[nameIdx + 1]).toContain("Task 42");
    });

    it("replyChannel missing: should skip by default (requireReplyChannel=true)", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        // requireReplyChannel: true (default)
      });

      const task = makeTask({ id: 100 });
      // env.replyChannel.chatId 为空（模拟 CLI/无 IM 场景）
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        {
          envContext: makeEnvContext({
            replyChannel: { chatId: "", messageId: "", profile: "" } as any,
          }),
        }
      );

      await runWithEnvContext(
        makeEnvContext({
          replyChannel: { chatId: "", messageId: "", profile: "" } as any,
        }),
        async () => {
          await plugin.execute(ctx);
        }
      );

      const chatCreateCall = spawnCalls.find((c) => c.args?.includes("+chat-create"));
      expect(chatCreateCall).toBeUndefined();
    });

    it("replyChannel missing: should still create chat when requireReplyChannel=false", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
        requireReplyChannel: false,
        fallbackProfile: "test-fallback-profile",
      });

      // 重新 mock createGroupChat，捕获完整 opts（含 profile）
      let capturedOpts: any = undefined;
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
        capturedOpts = opts;
        return Promise.resolve("oc_test_chat");
      };

      const task = makeTask({ id: 200 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        {
          envContext: makeEnvContext({
            replyChannel: { chatId: "", messageId: "", profile: "" } as any,
          }),
        }
      );

      await runWithEnvContext(
        makeEnvContext({
          replyChannel: { chatId: "", messageId: "", profile: "" } as any,
        }),
        async () => {
          await plugin.execute(ctx);
        }
      );

      // 应该创建群聊，使用 fallbackProfile
      expect(capturedOpts).toBeDefined();
      expect(capturedOpts.profile).toBe("test-fallback-profile");
      expect(capturedOpts.name).toContain("Task 200");

      // 不应该 sendToMain（没有 replyChannel.chatId）
      const sendToMainCall = spawnCalls.find((c) =>
        c.args?.includes("+messages-reply") ||
        (c.args?.includes("+messages-send") && c.args?.includes("oc_main_chat"))
      );
      expect(sendToMainCall).toBeUndefined();
    });

    // ★ P0 修复验证：bot 应该被自动拉入群聊
    it("should auto-include bot appId from replyChannel when creating group chat", async () => {
      // 重新 mock createGroupChat 捕获完整 opts（含 botAppIds）
      let capturedOpts: any = undefined;
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
        capturedOpts = opts;
        return Promise.resolve("oc_test_chat");
      };
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const task = makeTask({ id: 333 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      // makeEnvContext 默认 replyChannel.appId = "cli_auto123"
      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      // 验证 createGroupChat 收到的 opts.botAppIds 包含 replyChannel.appId
      expect(capturedOpts).toBeDefined();
      expect(capturedOpts.botAppIds).toBeDefined();
      expect(capturedOpts.botAppIds).toEqual(["cli_auto123"]);
    });

    it("should use config.botAppIds when explicitly provided (overrides replyChannel.appId)", async () => {
      let capturedOpts: any = undefined;
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
        capturedOpts = opts;
        return Promise.resolve("oc_test_chat");
      };
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
        botAppIds: ["cli_explicit", "cli_other"],
      });

      const task = makeTask({ id: 444 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      // config.botAppIds 应该覆盖 replyChannel.appId
      expect(capturedOpts.botAppIds).toEqual(["cli_explicit", "cli_other"]);
    });

    it("should pass empty botAppIds when neither config nor replyChannel.appId is set", async () => {
      let capturedOpts: any = undefined;
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
        capturedOpts = opts;
        return Promise.resolve("oc_test_chat");
      };
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
        requireReplyChannel: false,
        fallbackProfile: "default",
      });

      const task = makeTask({ id: 555 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        {
          envContext: makeEnvContext({
            replyChannel: {
              chatId: "oc_main",
              messageId: "om_msg",
              profile: "default",
              // 注意：没有 appId
            } as any,
          }),
        }
      );

      await runWithEnvContext(
        makeEnvContext({
          replyChannel: {
            chatId: "oc_main",
            messageId: "om_msg",
            profile: "default",
          } as any,
        }),
        async () => {
          await plugin.execute(ctx);
        }
      );

      // 群聊创建了，但 botAppIds 是空（replyChannel.appId 缺失且 config.botAppIds 也没设）
      expect(capturedOpts.botAppIds).toEqual([]);
    });

    // ★ P1 修复：replyChannel 必须能从 AsyncLocalStorage 读出来
    // 之前 plugin 只读 ctx.metadata.envContext.replyChannel，但 task component
    // 通过 runWithEnvContext 设置到 AsyncLocalStorage，所以 plugin 必须也读 ALS。
    it("P1: should read replyChannel from AsyncLocalStorage (not just ctx.metadata)", async () => {
      let capturedOpts: any = undefined;
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
        capturedOpts = opts;
        return Promise.resolve("oc_test_chat");
      };
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const task = makeTask({ id: 800 });

      // 模拟 task component 调 hook manager：metadata 是空的（默认 {}）
      // replyChannel 只在 ALS 里（runWithEnvContext 设置的）
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        {} // 空的 metadata，不含 envContext.replyChannel
      );

      await runWithEnvContext(
        makeEnvContext({
          replyChannel: makeReplyChannel({ chatId: "oc_main", appId: "cli_als_bot" }) as any,
        }),
        async () => {
          await plugin.execute(ctx);
        }
      );

      // 期望 createGroupChat 被调用（plugin 从 ALS 拿到 replyChannel）
      expect(capturedOpts).toBeDefined();
      expect(capturedOpts.botAppIds).toEqual(["cli_als_bot"]);
    });

    // ★ Task #4196: 旧 sendWelcomeMessage 路径已干掉，默认走卡片路径
    // - 默认行为：不发文本欢迎消息，改发卡片（cardInitialMessage=true）
    // - sendWelcomeMessage=false: 同样不发（Task #4196: 干掉了该分支）
    // ★ Task #4237 契约变更：首张卡片 owner 收归 LarkCliTaskNotifyHook。
    //   本插件只建群；不再自己 startTask（否则同 task 多卡 + 双 notifier 各自 patch）。
    it("should NOT send initial card to new group chat (Task #4237: first card owned by notify hook)", async () => {
      const notifierProto = LarkCardPatchNotifier.prototype as any;
      const originalStartTask = notifierProto.startTask;
      const startTaskSpy = mock(async () => ({ messageId: "om_card_test" }));
      notifierProto.startTask = startTaskSpy;

      try {
        const plugin = new PerTaskGroupChatPlugin({
          pluginName: "PerTaskGroupChatPlugin",
          sourceId: "es-test-1",
        autoCreateGroup: true,
        });

        const task = makeTask({ id: 700, title: "重要任务" });
        const ctx = makeHookContext<TaskCreateResultContext>(
          TaskHookPoints.AFTER_CREATE,
          { task, sessionId: "s", tagService: {} as any },
          { envContext: makeEnvContext() }
        );

        await runWithEnvContext(makeEnvContext(), async () => {
          await plugin.execute(ctx);
        });

        // 群照建（chat-create 被调）
        expect(
          spawnCalls.some((c) => c.args?.includes("+chat-create"))
        ).toBe(true);
        // ★ 但不再由本插件发首卡
        expect(startTaskSpy).not.toHaveBeenCalled();
        // 也不发纯文本欢迎消息
        const welcomeCall = spawnCalls.find((c) =>
          c.args?.includes("+messages-send") && c.args?.includes("oc_test_chat")
        );
        expect(welcomeCall).toBeUndefined();
      } finally {
        notifierProto.startTask = originalStartTask;
      }
    });

    it("should NOT send welcome text when sendWelcomeMessage=false (Task #4196: legacy deprecated)", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        sendWelcomeMessage: false,
      });

      const task = makeTask({ id: 701 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      // ★ Task #4230：卡片模式下不再发任何纯文本欢迎消息
      // 验证 +messages-send to oc_test_chat 没有被调用
      const welcomeCall = spawnCalls.find((c) =>
        c.args?.includes("+messages-send") && c.args?.includes("oc_test_chat")
      );
      expect(welcomeCall).toBeUndefined();
    });

    it("should continue normally when group chat creation fails (Task #4237: graceful degradation)", async () => {
      // ★ Task #4237：插件不再发卡，本测试改注入「建群失败」验证主流程不抛
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function () {
        return Promise.reject(new Error("chat-create failed"));
      };

      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const task = makeTask({ id: 702 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      // 期望不抛异常（graceful degradation）
      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      // ★ Task #4237：建群失败 → 不写 chatId，后续 update/complete 自然 skip
      expect((plugin as any).cardMessageIds.get(702)).toBeUndefined();
      expect((plugin as any).parseChatIdFromContext((task as any).context)).toBeUndefined();
      // ★ 旧"群已创建 → 主聊天框纯文本"通知路径已删除
      expect(spawnCalls.some((c) => c.args?.includes("+messages-reply"))).toBe(false);
    });
  });

  // ========================================================================
  // 5. onAfterUpdate
  // ========================================================================
  describe("onAfterUpdate", () => {
    // ★ Task #4237：卡片 patch 已移交 LarkCliTaskNotifyHook（插件不再 patch），
    //   这里只保留"无群则跳过"的守卫测试。
    it("should skip update when no chat_id in context", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const taskNoChat = makeTask({ context: "{}" });
      // 即便有 card messageId，没有群也应该 skip（否则会 patch 到错误群）
      (plugin as any).cardMessageIds.set(100, "om_card_test");
      const ctx = makeHookContext<TaskUpdateResultContext>(
        TaskHookPoints.AFTER_UPDATE,
        { task: taskNoChat, changes: { progress: 90 }, tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      expect(spawnCalls.length).toBe(0);
      expect(cardCalls.length).toBe(0);
    });

    it("should skip update with no meaningful change", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const taskWithChat = makeTask({
        context: JSON.stringify({ larkPerTaskChatId: "oc_task_100" }),
      });
      (plugin as any).cardMessageIds.set(100, "om_card_test");
      // ★ 修复后 current_status 也是 meaningful change，应该发通知
      // 用 context-only update 来测"必须 skip"
      const ctx = makeHookContext<TaskUpdateResultContext>(
        TaskHookPoints.AFTER_UPDATE,
        {
          task: taskWithChat,
          changes: { context: "{...}" },
          tagService: {} as any,
        },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      expect(spawnCalls.length).toBe(0);
      expect(cardCalls.length).toBe(0);
    });
  });

  // ========================================================================
  // 6. onAfterOperationCreate
  // ========================================================================
  describe("onAfterOperationCreate", () => {
    // ★ Task #4237：operation → 卡片时间线由 LarkCliTaskNotifyHook 负责；
    //   插件侧只保留"无群则跳过"的守卫测试。
    it("should skip when no chat_id", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const taskNoChat = makeTask({ context: "{}" });
      (plugin as any).cardMessageIds.set(100, "om_card_test");
      const operation = makeOperation({ taskId: 100 });

      const ctx = makeHookContext<TaskOperationCreateResultContext>(
        TaskHookPoints.OPERATION_AFTER_CREATE,
        { operation },
        { task: taskNoChat, envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      expect(spawnCalls.length).toBe(0);
      expect(cardCalls.length).toBe(0);
    });
  });

  // ========================================================================
  // 7. onAfterComplete
  // ========================================================================
  describe("onAfterComplete", () => {
    // ★ Task #4237：终态 patch + unpin 归 LarkCliTaskNotifyHook ——
    //   本插件不再参与卡片生命周期，故该 describe 不再有断言（保留占位说明）。
  });

  // ========================================================================
  // 8. P0-2: botAppIds 自动推导
  // ========================================================================
  describe("P0-2: botAppIds resolution", () => {
    it("should use configured botAppIds if provided", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
        botAppIds: ["cli_explicit"],
      });

      // Mock createGroupChat 来捕获传入的 opts
      let capturedBots: string[] | undefined;
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
        capturedBots = opts.botAppIds;
        return Promise.resolve("oc_x");
      };

      const task = makeTask();
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        {
          envContext: makeEnvContext({
            replyChannel: makeReplyChannel({ appId: "cli_auto" }) as any,
          }),
        }
      );

      await runWithEnvContext(
        makeEnvContext({
          replyChannel: makeReplyChannel({ appId: "cli_auto" }) as any,
        }),
        async () => {
          await plugin.execute(ctx);
        }
      );

      // 期望使用 cli_explicit（不是 cli_auto）
      expect(capturedBots).toEqual(["cli_explicit"]);
    });

    it("should fallback to replyChannel.appId if no botAppIds configured", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
        // botAppIds 未配置
      });

      let capturedBots: string[] | undefined;
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
        capturedBots = opts.botAppIds;
        return Promise.resolve("oc_x");
      };

      const task = makeTask();
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        {
          envContext: makeEnvContext({
            replyChannel: makeReplyChannel({ appId: "cli_auto_from_rc" }) as any,
          }),
        }
      );

      await runWithEnvContext(
        makeEnvContext({
          replyChannel: makeReplyChannel({ appId: "cli_auto_from_rc" }) as any,
        }),
        async () => {
          await plugin.execute(ctx);
        }
      );

      // 期望从 replyChannel.appId 自动推导
      expect(capturedBots).toEqual(["cli_auto_from_rc"]);
    });

    it("should return empty botAppIds when no config and no replyChannel.appId", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      let capturedBots: string[] | undefined;
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
        capturedBots = opts.botAppIds;
        return Promise.resolve("oc_x");
      };

      const task = makeTask();
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        {
          envContext: makeEnvContext({
            replyChannel: makeReplyChannel({ appId: undefined }) as any,
          }),
        }
      );

      await runWithEnvContext(
        makeEnvContext({
          replyChannel: makeReplyChannel({ appId: undefined }) as any,
        }),
        async () => {
          await plugin.execute(ctx);
        }
      );

      // 期望返回空数组（plugin 内部会跳过 --bots 参数）
      expect(capturedBots).toEqual([]);
    });
  });

  // ========================================================================
  // 9. 模板渲染
  // ========================================================================
  describe("template rendering", () => {
    it("should render nameTemplate with task id and title", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
        nameTemplate: "Task #{id} - #{title}",
      });

      let capturedName: string | undefined;
      (PerTaskGroupChatPlugin.prototype as any).createGroupChat = function (opts: any) {
        capturedName = opts.name;
        return Promise.resolve("oc_x");
      };

      const task = makeTask({ id: 999, title: "MyTitle" });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      expect(capturedName).toBe("Task 999 - MyTitle");
    });
  });

  // ========================================================================
  // 9.5 buildCreateGroupChatArgs（lark-cli +chat-create 命令行构造）
  // ========================================================================
  describe("buildCreateGroupChatArgs", () => {
    // ★ P1 修复：profile 有值时必须加 --as bot
    // 否则 lark-cli 用 user 身份建群，profile 对应的 bot 不是群成员
    it("should include --as bot when profile is set (even without botAppIds)", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const args = (plugin as any).buildCreateGroupChatArgs({
        name: "Test Group",
        description: "test description",
        profile: "default",
        botAppIds: [],
      });

      expect(args).toContain("--as");
      expect(args[args.indexOf("--as") + 1]).toBe("bot");
    });

    it("should include --bots and --set-bot-manager when botAppIds provided", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const args = (plugin as any).buildCreateGroupChatArgs({
        name: "Test Group",
        description: "test description",
        profile: "default",
        botAppIds: ["cli_xxx", "cli_yyy"],
      });

      expect(args).toContain("--bots");
      expect(args[args.indexOf("--bots") + 1]).toBe("cli_xxx,cli_yyy");
      expect(args).toContain("--set-bot-manager");
      expect(args).toContain("--as");
      expect(args[args.indexOf("--as") + 1]).toBe("bot");
    });

    it("should NOT include --as bot when profile is missing (use user identity)", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const args = (plugin as any).buildCreateGroupChatArgs({
        name: "Test Group",
        description: "test description",
        // profile 缺失
        botAppIds: ["cli_xxx"],
      });

      // 这种情况不应该发生（profile 应由 eventsource 提供），但代码逻辑应一致
      // botAppIds 给了，但没 profile → 不加 --as bot
      expect(args).not.toContain("--as");
    });

    it("should put --profile flag at the start of args", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const args = (plugin as any).buildCreateGroupChatArgs({
        name: "Test Group",
        description: "test description",
        profile: "default",
        botAppIds: ["cli_xxx"],
      });

      expect(args[0]).toBe("--profile");
      expect(args[1]).toBe("default");
      expect(args[2]).toBe("im");
      expect(args[3]).toBe("+chat-create");
    });

    // ★ P0 修复：userIds 应加入 --users flag（不邀请则 user 看不到群聊）
    it("should include --users when userIds provided", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const args = (plugin as any).buildCreateGroupChatArgs({
        name: "Test Group",
        description: "test description",
        profile: "default",
        botAppIds: [],
        userIds: ["ou_aaa", "ou_bbb"],
      });

      expect(args).toContain("--users");
      expect(args[args.indexOf("--users") + 1]).toBe("ou_aaa,ou_bbb");
    });

    it("should NOT include --users when userIds is empty", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const args = (plugin as any).buildCreateGroupChatArgs({
        name: "Test Group",
        description: "test description",
        profile: "default",
        botAppIds: [],
        userIds: [],
      });

      expect(args).not.toContain("--users");
    });

    // ★ P0 修复：lark-cli --name 最大 60, --description 最大 100 字符
    //   Task #3974 案例：path 太长 → description 105 chars → lark-cli exit code 2 → chat 未创建
    it("should handle long description gracefully (truncate to 100 chars)", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const longDescription = "roy-bot task 3974 - ~/work/codework/personal/roy_world/roy-bot/.worktrees/feat-per-task-group";
      expect(longDescription.length).toBeGreaterThan(100);
      const args = (plugin as any).buildCreateGroupChatArgs({
        name: "Task 3974 - AI Agent 创业方向调研报告（2025-2026）",
        description: longDescription,
        profile: "default",
        botAppIds: [],
        userIds: ["ou_aaa"],
      });
      const descArgIndex = args.indexOf("--description");
      expect(descArgIndex).toBeGreaterThan(-1);
      const actualDesc = args[descArgIndex + 1];
      expect(actualDesc.length).toBeLessThanOrEqual(100);
      expect(actualDesc).toMatch(/\.\.\.$/);  // truncated marker
    });

    it("should handle long name gracefully (truncate to 60 chars)", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const longName = "Task 1234 - This is a very very long task title that exceeds the 60 char limit easily";
      expect(longName.length).toBeGreaterThan(60);
      const args = (plugin as any).buildCreateGroupChatArgs({
        name: longName,
        description: "short",
        profile: "default",
        botAppIds: [],
        userIds: ["ou_aaa"],
      });
      const nameArgIndex = args.indexOf("--name");
      expect(nameArgIndex).toBeGreaterThan(-1);
      const actualName = args[nameArgIndex + 1];
      expect(actualName.length).toBeLessThanOrEqual(60);
      expect(actualName).toMatch(/\.\.\.$/);
    });
  });

  // ========================================================================
  // 9.5 resolveUserIds（interactive mode 等无 sender open_id 场景）
  // ========================================================================
  describe("resolveUserIds", () => {
    it("should use inviteUserIds from explicit config", () => {
      const plugin = new PerTaskGroupChatPlugin({
        inviteUserIds: ["ou_explicit1", "ou_explicit2"],
      });
      const userIds = (plugin as any).resolveUserIds(undefined);
      expect(userIds).toEqual(["ou_explicit1", "ou_explicit2"]);
    });

    it("should derive sender from replyChannel.userId when inviteUserIds includes 'sender'", () => {
      const plugin = new PerTaskGroupChatPlugin({
        inviteUserIds: ["sender"],
      });
      const userIds = (plugin as any).resolveUserIds({
        userId: "ou_from_replychannel",
      });
      expect(userIds).toContain("ou_from_replychannel");
    });

    it("should derive sender from replyChannel.params.userId as fallback", () => {
      const plugin = new PerTaskGroupChatPlugin({
        inviteUserIds: ["sender"],
      });
      const userIds = (plugin as any).resolveUserIds({
        params: { userId: "ou_from_params" },
      });
      expect(userIds).toContain("ou_from_params");
    });

    it("should ignore non-ou_ sender values", () => {
      const plugin = new PerTaskGroupChatPlugin({
        inviteUserIds: ["sender"],
      });
      const userIds = (plugin as any).resolveUserIds({
        userId: "not_an_open_id",
      });
      expect(userIds).toEqual([]);
    });

    it("should combine explicit inviteUserIds + derived sender", () => {
      const plugin = new PerTaskGroupChatPlugin({
        inviteUserIds: ["ou_explicit", "sender"],
      });
      const userIds = (plugin as any).resolveUserIds({
        userId: "ou_sender",
      });
      expect(userIds).toContain("ou_explicit");
      expect(userIds).toContain("ou_sender");
      expect(userIds.length).toBe(2);
    });

    it("should accept pluginConfig from eventsource handleRule (interactive mode)", () => {
      // ★ 关键场景：interactive mode 下没有 lark 消息，sender 拿不到
      // 用户在 ~/.roy-bot/event-sources.json 的 handleRule.pluginConfig.PerTaskGroupChatPlugin.inviteUserIds
      // 显式指定要邀请的 user open_id
      const plugin = new PerTaskGroupChatPlugin({
        inviteUserIds: ["ou_b9924f48dc122c3dad0ff4f37851c09b"],
      });
      // 即便 replyChannel 完全 undefined（interactive mode），也应返回 userIds
      const userIds = (plugin as any).resolveUserIds(undefined);
      expect(userIds).toEqual(["ou_b9924f48dc122c3dad0ff4f37851c09b"]);
    });

    // ========================================================================
    // ★ Task #3987：defaultInviteUserIds（始终邀请）+ inviteUserIds（动态 sender）
    // ========================================================================
    describe("defaultInviteUserIds + inviteUserIds (Task #3987)", () => {
      it("should use defaultInviteUserIds when inviteUserIds is empty", () => {
        const plugin = new PerTaskGroupChatPlugin({
          defaultInviteUserIds: ["ou_admin"],
          inviteUserIds: [],
        });
        const userIds = (plugin as any).resolveUserIds(undefined);
        expect(userIds).toEqual(["ou_admin"]);
      });

      it("should union defaultInviteUserIds with explicit inviteUserIds (dedup)", () => {
        const plugin = new PerTaskGroupChatPlugin({
          defaultInviteUserIds: ["ou_admin", "ou_shared"],
          inviteUserIds: ["ou_explicit1", "ou_shared"],  // ou_shared 与 default 重合
        });
        const userIds = (plugin as any).resolveUserIds(undefined);
        expect(userIds).toContain("ou_admin");
        expect(userIds).toContain("ou_shared");
        expect(userIds).toContain("ou_explicit1");
        expect(userIds.length).toBe(3);  // 去重后 3 个
      });

      it("should add derived sender (from 'sender' placeholder) on top of defaultInviteUserIds", () => {
        const plugin = new PerTaskGroupChatPlugin({
          defaultInviteUserIds: ["ou_admin"],
          inviteUserIds: ["sender"],
        });
        const userIds = (plugin as any).resolveUserIds({
          userId: "ou_sender_from_event",
        });
        expect(userIds).toContain("ou_admin");
        expect(userIds).toContain("ou_sender_from_event");
        expect(userIds.length).toBe(2);
      });

      it("should NOT treat 'sender' placeholder inside defaultInviteUserIds", () => {
        const plugin = new PerTaskGroupChatPlugin({
          defaultInviteUserIds: ["sender"],  // 即使配了 "sender" 也应忽略（不占位）
          inviteUserIds: ["ou_explicit"],
        });
        const userIds = (plugin as any).resolveUserIds({
          userId: "ou_sender_from_event",
        });
        // "sender" 占位符在 defaultInviteUserIds 里被忽略
        expect(userIds).toContain("ou_explicit");
        expect(userIds).not.toContain("sender");
      });

      it("should ignore non-ou_ values in defaultInviteUserIds", () => {
        const plugin = new PerTaskGroupChatPlugin({
          defaultInviteUserIds: ["ou_admin", "garbage_value", "ou_other"],
        });
        const userIds = (plugin as any).resolveUserIds(undefined);
        expect(userIds).toContain("ou_admin");
        expect(userIds).toContain("ou_other");
        expect(userIds).not.toContain("garbage_value");
        expect(userIds.length).toBe(2);
      });

      it("should default defaultInviteUserIds to [] (no extra invitations)", () => {
        const plugin = new PerTaskGroupChatPlugin();
        const cfg = (plugin as any).config;
        expect(cfg.defaultInviteUserIds).toEqual([]);
      });
    });
  });

  // ========================================================================
  // 10. P0-3: 双发问题文档验证
  // ========================================================================
  describe("P0-3: dual-send problem (doc check)", () => {
    it("plugin should clearly document dual-send behavior in source", () => {
      // 文档级别测试：确保源码里有清晰的 P0-3 提示
      const fs = require("fs");
      const path = require("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "./per-task-group-chat-plugin.ts"),
        "utf-8"
      );
      expect(src).toContain("双发");
      expect(src).toContain("LarkCliTaskNotifyPlugin");
      expect(src).toContain("--plugins");
      expect(src).toContain("PerTaskGroupChatPlugin");
    });
  });

  // ========================================================================
  // 11. setTaskUpdater injection
  // ========================================================================
  describe("setTaskUpdater", () => {
    it("should call taskUpdater when chat created", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      let capturedTaskId: number | undefined;
      let capturedContext: string | undefined;
      plugin.setTaskUpdater(async (taskId, context) => {
        capturedTaskId = taskId;
        capturedContext = context;
      });

      const task = makeTask({ id: 555 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      expect(capturedTaskId).toBe(555);
      expect(capturedContext).toBeDefined();
      const parsed = JSON.parse(capturedContext!);
      expect(parsed.larkPerTaskChatId).toBe("oc_test_chat");
    });

    it("should still update in-memory when no taskUpdater", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const task = makeTask({ id: 666 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        // Should not throw
        await plugin.execute(ctx);
      });

      // In-memory task.context should be updated even without taskUpdater
      const parsed = JSON.parse(task.context);
      expect(parsed.larkPerTaskChatId).toBe("oc_test_chat");
    });

    it("hasTaskUpdater: should return false initially, true after setTaskUpdater", () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      // 初始状态：未注入
      expect(plugin.hasTaskUpdater()).toBe(false);

      // 注入后
      plugin.setTaskUpdater(async () => {});
      expect(plugin.hasTaskUpdater()).toBe(true);
    });
  });

  // ========================================================================
  // 12. profile injection
  // ========================================================================
  describe("profile injection", () => {
    // ★ Task #4237：卡片 patch 已移交 LarkCliTaskNotifyHook —— profile 注入断言
    //   移到 lark-cli-task-notify-routing.test.ts（那里覆盖 --profile 注入）。
  });

  // ========================================================================
  // 13. parseChatId helper (直接调底层方法)
  // ========================================================================
  describe("parseChatId helper", () => {
    it("should parse chat_id from JSON output", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const result = (plugin as any).parseChatId('{"ok":true,"data":{"chat_id":"oc_parsed_xyz"}}');
      expect(result).toBe("oc_parsed_xyz");
    });

    it("should fallback to regex when JSON parse fails", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const result = (plugin as any).parseChatId("Some text oc_abc123 trailing");
      expect(result).toBe("oc_abc123");
    });

    it("should return undefined for empty input", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const result = (plugin as any).parseChatId("");
      expect(result).toBeUndefined();
    });
  });

  // ========================================================================
  // 14. hasMeaningfulChange
  // ========================================================================
  describe("hasMeaningfulChange", () => {
    it("should detect status change", () => {
      const plugin = new PerTaskGroupChatPlugin();
      expect((plugin as any).hasMeaningfulChange({ status: "active" })).toBe(true);
    });

    it("should detect progress change", () => {
      const plugin = new PerTaskGroupChatPlugin();
      expect((plugin as any).hasMeaningfulChange({ progress: 80 })).toBe(true);
    });

    it("should detect priority change", () => {
      const plugin = new PerTaskGroupChatPlugin();
      expect((plugin as any).hasMeaningfulChange({ priority: "high" })).toBe(true);
    });

    it("should ignore current_status change", () => {
      const plugin = new PerTaskGroupChatPlugin();
      // ★ 修复：之前返回 false 导致 update 通知 silently skip，
      //   现在 current_status / tags / goals 也是 meaningful change
      expect((plugin as any).hasMeaningfulChange({ current_status: "in progress" })).toBe(true);
    });

    it("should detect tags change", () => {
      const plugin = new PerTaskGroupChatPlugin();
      expect((plugin as any).hasMeaningfulChange({ tags: ["research"] })).toBe(true);
    });

    it("should detect goals_and_expected_deliverables change", () => {
      const plugin = new PerTaskGroupChatPlugin();
      expect(
        (plugin as any).hasMeaningfulChange({ goals_and_expected_deliverables: "new goals" })
      ).toBe(true);
    });

    it("should ignore non-meaningful changes (e.g. context)", () => {
      const plugin = new PerTaskGroupChatPlugin();
      // context 写回（如 attachChatIdToTask 写 larkPerTaskChatId）不应该触发通知
      expect((plugin as any).hasMeaningfulChange({ context: "{...}" })).toBe(false);
    });

    it("should ignore empty changes", () => {
      const plugin = new PerTaskGroupChatPlugin();
      expect((plugin as any).hasMeaningfulChange({})).toBe(false);
      expect((plugin as any).hasMeaningfulChange(undefined)).toBe(false);
    });
  });

  // ========================================================================
  // 15. isSubTask
  // ========================================================================
  describe("isSubTask", () => {
    it("should return true when parent_task_id > 0", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ parent_task_id: 100 });
      expect((plugin as any).isSubTask(task)).toBe(true);
    });

    it("should return false when parent_task_id = 0", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ parent_task_id: 0 });
      expect((plugin as any).isSubTask(task)).toBe(false);
    });

    it("should return false when parent_task_id is undefined", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ parent_task_id: undefined });
      expect((plugin as any).isSubTask(task)).toBe(false);
    });
  });

  // ========================================================================
  // 16. getTaskChatId / getTaskChatProfile
  // ========================================================================
  describe("getTaskChatId and getTaskChatProfile", () => {
    it("should return chat_id from task.context", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({
        context: JSON.stringify({ larkPerTaskChatId: "oc_chat_42", larkPerTaskChatProfile: "my-prof" }),
      });
      expect((plugin as any).getTaskChatId(task)).toBe("oc_chat_42");
      expect((plugin as any).getTaskChatProfile(task)).toBe("my-prof");
    });

    it("should return undefined for invalid context JSON", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ context: "not json{" });
      expect((plugin as any).getTaskChatId(task)).toBeUndefined();
    });

    it("should return undefined for empty context", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ context: undefined });
      expect((plugin as any).getTaskChatId(task)).toBeUndefined();
    });
  });

  // ========================================================================
  // 17. renderTemplate
  // ========================================================================
  describe("renderTemplate", () => {
    it("should replace #{id} and #{title}", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ id: 7, title: "Hello" });
      const result = (plugin as any).renderTemplate("Task #{id} - #{title}", task);
      expect(result).toBe("Task 7 - Hello");
    });

    it("should replace #{project_path}", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ project_path: "/home/me/project" });
      const result = (plugin as any).renderTemplate("#{project_path}", task);
      expect(result).toBe("/home/me/project");
    });

    // ★ P1 修复：默认模板用 `{var}` 但 renderTemplate 只替换 `#{var}`，
    //   导致字面 `{title}` / `{project_path}` 残留。
    it("should replace {var} format (without hash) — backward compat", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ id: 7, title: "Hello", project_path: "/p" });
      const result = (plugin as any).renderTemplate("Task #{id}: {title}", task);
      expect(result).toBe("Task 7: Hello");
    });

    it("should replace {project_path} without hash", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ id: 7, title: "Hello", project_path: "/p" });
      const result = (plugin as any).renderTemplate("roy-bot task #{id} - {project_path}", task);
      expect(result).toBe("roy-bot task 7 - /p");
    });

    it("should leave unknown {var} placeholders unchanged (for debug)", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({ id: 7, title: "Hello" });
      const result = (plugin as any).renderTemplate("hello {unknown_var}", task);
      expect(result).toBe("hello {unknown_var}");
    });

    it("should use default templates with real task data", () => {
      const plugin = new PerTaskGroupChatPlugin();
      const task = makeTask({
        id: 3973,
        title: "GitHub 调研",
        project_path: "/work/codework",
      });
      const name = (plugin as any).renderTemplate("Task #{id} - #{title}", task);
      const desc = (plugin as any).renderTemplate("roy-bot task #{id} - #{project_path}", task);
      expect(name).toBe("Task 3973 - GitHub 调研");
      expect(desc).toBe("roy-bot task 3973 - /work/codework");
    });
  });

  // ========================================================================
  // 18. 端到端集成场景：完整生命周期
  // ========================================================================
  describe("integration: full task lifecycle", () => {
    it("create → update → complete flow should hit all hooks", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      const task = makeTask({ id: 777 });
      const envCtx = makeEnvContext();

      // 1) AFTER_CREATE
      const createCtx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: envCtx }
      );

      await runWithEnvContext(envCtx, async () => {
        await plugin.execute(createCtx);
      });

      // 期望 chat-create 被调
      expect(spawnCalls.find((c) => c.args?.includes("+chat-create"))).toBeDefined();

      // 验证 task.context 被写入了 chat_id
      const parsed = JSON.parse(task.context);
      expect(parsed.larkPerTaskChatId).toBe("oc_test_chat");
    });
  
  // ========================================================================
  // Task #4230 follow-up: ensureGroupChat（按需为 task 补建专属群）
  // ========================================================================
  describe("ensureGroupChat (Task #4230 follow-up)", () => {
    it("按需建群：建群 + 写 creating/ready 绑定 + 持久化 chatId 到 task.context", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });
      const upserts: any[] = [];
      plugin.setSessionComponent({
        upsertChatTaskBinding: async (opts: any) => {
          upserts.push(opts);
          return { ...opts, boundAt: "x", status: opts.status, errorMessage: null, rebindCount: 0 };
        },
      } as any);
      const persisted: Array<{ id: number; context: string }> = [];
      plugin.setTaskUpdater(async (id, context) => {
        persisted.push({ id, context });
      });

      // sub-task（parent #2066）—— ensureGroupChat **不做** sub-task skip
      const task = makeTask({ id: 4226, parent_task_id: 2066 });

      const result = await runWithEnvContext(makeEnvContext(), async () =>
        plugin.ensureGroupChat(task)
      );

      expect(result?.chatId).toBe("oc_test_chat");
      expect(upserts.map((u) => u.status)).toEqual(["creating", "ready"]);
      expect(upserts[0].taskId).toBe(4226);
      expect(persisted.length).toBe(1);
      const ctx = JSON.parse(persisted[0].context);
      expect(ctx.larkPerTaskChatId).toBe("oc_test_chat");
    });

    it("建群失败 → 返回 undefined（caller 自行降级，不抛）", async () => {
      const plugin = new PerTaskGroupChatPlugin({ sourceId: "es-test-1" });
      (plugin as any).createGroupChat = async () => {
        throw new Error("lark-cli down");
      };

      const result = await runWithEnvContext(makeEnvContext(), async () =>
        plugin.ensureGroupChat(makeTask({ id: 1 }))
      );
      expect(result).toBeUndefined();
    });

    it("requireReplyChannel=true 且没有 replyChannel → 不建群（返回 undefined）", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        sourceId: "es-test-1",
        requireReplyChannel: true,
      });
      const envNoChannel = { ...makeEnvContext(), replyChannel: undefined } as any;
      (plugin as any).createGroupChat = async () => {
        throw new Error("不该被调用");
      };

      const result = await runWithEnvContext(envNoChannel, async () =>
        plugin.ensureGroupChat(makeTask({ id: 1 }))
      );
      expect(result).toBeUndefined();
    });
  });

  // ========================================================================
  // Task #4331: autoCreateGroup 配置项（默认关闭默认建群）
  // ========================================================================

  describe("autoCreateGroup (Task #4331)", () => {
    it("默认（不传 autoCreateGroup） → onAfterCreate 不调 createGroupChat", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        // autoCreateGroup 不传 → 默认 false
      });

      let updatedContext: string | undefined;
      plugin.setTaskUpdater(async (_taskId, context) => {
        updatedContext = context;
      });

      const task = makeTask({ id: 999 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      // ★ Task #4331 默认建群关掉 → 不调 chat-create
      const chatCreateCall = spawnCalls.find((c) =>
        c.args?.includes("+chat-create")
      );
      expect(chatCreateCall).toBeUndefined();

      // context 也不应被写
      expect(updatedContext).toBeUndefined();
    });

    it("autoCreateGroup=false 显式 → onAfterCreate 也不建群", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: false,
      });

      const task = makeTask({ id: 1000 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      const chatCreateCall = spawnCalls.find((c) =>
        c.args?.includes("+chat-create")
      );
      expect(chatCreateCall).toBeUndefined();
    });

    it("autoCreateGroup=true 显式 → onAfterCreate 仍然建群（向后兼容）", async () => {
      const plugin = new PerTaskGroupChatPlugin({
        pluginName: "PerTaskGroupChatPlugin",
        sourceId: "es-test-1",
        autoCreateGroup: true,
      });

      plugin.setTaskUpdater(async () => {});

      const task = makeTask({ id: 1001 });
      const ctx = makeHookContext<TaskCreateResultContext>(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        { envContext: makeEnvContext() }
      );

      await runWithEnvContext(makeEnvContext(), async () => {
        await plugin.execute(ctx);
      });

      // 显式开启 → 仍然调 chat-create
      const chatCreateCall = spawnCalls.find((c) =>
        c.args?.includes("+chat-create")
      );
      expect(chatCreateCall).toBeDefined();
    });
  });
});

  // 注：卡片发送/finish 的命令行构造由 lark-card-patch-notifier.test.ts 覆盖；
  // 旧 sendToChat / sendToMain 纯文本路径已在 Task #4230 删除。
});