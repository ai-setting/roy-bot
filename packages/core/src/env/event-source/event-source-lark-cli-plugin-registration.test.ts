/**
 * TDD 回归测试：LarkCliInstance 注册 plugin 时不能漏掉 task:after.complete
 *
 * 背景 (Task #3957)：
 * - PerTaskGroupChatPlugin（Task #3945 实现）的 execute() 在 switch 中包含
 *   case TaskHookPoints.AFTER_COMPLETE -> onAfterComplete() 任务完成摘要
 * - 但 LarkCliInstance.getPluginHookPoints() 的"LarkCliTaskNotifyHook 等"fallback
 *   分支硬编码只返回 3 个 hook 点（task:after.create / task:after.update /
 *   task:operation:after.create），不包含 task:after.complete
 * - 结果：PerTaskGroupChatPlugin.onAfterComplete() 永远不会被触发
 * - 单测因为直接调 plugin.execute(ctx) 绕过了 getPluginHookPoints，所以测试都通过
 *
 * 本测试覆盖：
 * - 白盒：getPluginHookPoints() 返回值
 * - 真实 plugin：PerTaskGroupChatPlugin
 * - 端到端：importPlugin → registerPluginHooks → globalHookManager.register
 *   → globalHookManager.execute(AFTER_COMPLETE) 真能调到 fake plugin
 *     （前提：metadata.pluginEnabled["<sourceId>:FakePlugin"] === true，
 *      模拟真实 eventsource.handleEvent 构建的 pluginEnabled）
 */

import { describe, test, expect as expectFn, beforeEach, afterEach } from "bun:test";

import { globalHookManager } from "../hook/global-hook-manager";
import { larkCliHandler } from "./event-source-handlers";
import type { EventSourceConfig } from "./types";
import { TaskHookPoints } from "../task/hooks/task-hook-points";
import { createPerTaskGroupChatPlugin } from "../task/plugins/per-task-group-chat-plugin";
import { WorkflowHookPoints } from "../workflow/hooks/workflow-hook-points";
import { createLarkCliWorkflowNotifyHook } from "../workflow/plugins/lark-cli-workflow-notify-plugin";

// =============================================================================
// 测试辅助：通过 holder 让 fake plugin 的 execute 函数引用 holder 字段，
// registration 后通过 mutate holder 字段来切换 observed 函数（不重新赋值 .execute）
// =============================================================================

interface FakePluginHandle {
  name: string;
  execute: (ctx: unknown) => Promise<void>;
  /**
   * 设置当前被 observed 的函数。下次 fakePlugin.execute() 被调时会调它。
   */
  setObserved: (fn: (ctx: unknown) => Promise<void>) => void;
  /** 当前观察计数（reset 用） */
  getCallCount: () => number;
  /** 重置计数 */
  resetCount: () => void;
}

function createFakeHookPlugin(name: string): FakePluginHandle {
  let count = 0;
  let currentObserved: (ctx: unknown) => Promise<void> = async () => {};
  return {
    name,
    execute: async (ctx: unknown) => {
      count++;
      return currentObserved(ctx);
    },
    setObserved: (fn) => {
      currentObserved = fn;
    },
    getCallCount: () => count,
    resetCount: () => {
      count = 0;
    },
  };
}

describe("LarkCliInstance plugin registration (Task #3957)", () => {
  let config: EventSourceConfig;

  beforeEach(() => {
    globalHookManager.clear();

    config = {
      id: "es-test-task3957",
      name: "Test Event Source for Task #3957",
      type: "lark-cli",
      enabled: true,
      command: "echo test",
      handleRule: {
        plugins: ["FakePlugin"],
      },
    } as EventSourceConfig;
  });

  afterEach(() => {
    globalHookManager.clear();
  });

  test("RED: getPluginHookPoints() 必须返回包含 task:after.complete 的 hook 点列表", () => {
    // 白盒测试：直接验证内部方法返回值
    const fakePlugin = createFakeHookPlugin("FakePlugin");
    const instance = larkCliHandler.createInstance(config);

    const hookPoints = (instance as any).getPluginHookPoints(fakePlugin);

    expectFn(hookPoints).toContain("task:after.create");
    expectFn(hookPoints).toContain("task:after.update");
    expectFn(hookPoints).toContain("task:operation:after.create");
    expectFn(hookPoints).toContain("task:after.complete");
  });

  test("RED: PerTaskGroupChatPlugin 实例（真实 plugin）走 Hook 模式分支时必须包含 AFTER_COMPLETE", () => {
    // 真实 plugin 实例，无 hookPoint，依赖 fallback 分支
    const realPlugin = createPerTaskGroupChatPlugin({
      pluginName: "PerTaskGroupChatPlugin",
      sourceId: "es-test-1",
    });
    const instance = larkCliHandler.createInstance(config);

    const hookPoints = (instance as any).getPluginHookPoints(realPlugin);

    expectFn(hookPoints).toContain(TaskHookPoints.AFTER_COMPLETE);
  });

  test("RED: importPlugin 流程后必须能在 AFTER_COMPLETE 上触发 fake plugin execute", async () => {
    // 端到端：模拟真实 eventsource.handleEvent 流程
    // - loadPlugins() → globalHookManager 上有 FakePlugin:task:after.complete 注册
    // - globalHookManager.execute("task:after.complete", ..., {pluginEnabled: {"es-test-task3957:FakePlugin": true}})
    //   必须调到 fakePlugin.execute
    const fakePlugin = createFakeHookPlugin("FakePlugin");
    let observed = false;
    fakePlugin.setObserved(async () => {
      observed = true;
    });

    const instance = larkCliHandler.createInstance(config) as any;

    const originalImportPlugin = instance.importPlugin.bind(instance);
    instance.importPlugin = async function (_name: string) {
      return fakePlugin;
    };

    try {
      await instance.loadPlugins();
      fakePlugin.resetCount();
      observed = false;

      // 模拟 eventsource.handleEvent 构建的 metadata
      const metadata = {
        pluginEnabled: { "es-test-task3957:FakePlugin": true },
      };

      await globalHookManager.execute(
        TaskHookPoints.AFTER_COMPLETE,
        { task: { id: 1 } },
        metadata
      );

      expectFn(observed).toBe(true);
      expectFn(fakePlugin.getCallCount()).toBeGreaterThan(0);
    } finally {
      instance.importPlugin = originalImportPlugin;
      instance.unloadPlugins();
    }
  });

  test("RED: importPlugin 流程后 4 个 task 生命周期 hook 点都能触发 fake plugin execute", async () => {
    const fakePlugin = createFakeHookPlugin("FakePlugin");
    const instance = larkCliHandler.createInstance(config) as any;

    const originalImportPlugin = instance.importPlugin.bind(instance);
    instance.importPlugin = async function (_name: string) {
      return fakePlugin;
    };

    try {
      await instance.loadPlugins();

      const hookPointsToCheck = [
        TaskHookPoints.AFTER_CREATE,
        TaskHookPoints.AFTER_UPDATE,
        TaskHookPoints.OPERATION_AFTER_CREATE,
        TaskHookPoints.AFTER_COMPLETE,
      ];

      for (const hookPoint of hookPointsToCheck) {
        let observed = false;
        fakePlugin.setObserved(async () => {
          observed = true;
        });
        fakePlugin.resetCount();

        await globalHookManager.execute(
          hookPoint,
          {},
          { pluginEnabled: { "es-test-task3957:FakePlugin": true } }
        );
        expectFn(observed).toBe(true);
      }
    } finally {
      instance.importPlugin = originalImportPlugin;
      instance.unloadPlugins();
    }
  });

  // =============================================================================
  // P0 修复：自动注入 setTaskUpdater
  // =============================================================================

  test("GREEN: registerPluginHooks 自动注入 setTaskUpdater（plugin 支持 + env 提供 taskComponent）", async () => {
    const realPlugin = createPerTaskGroupChatPlugin({
      pluginName: "PerTaskGroupChatPlugin",
      sourceId: "es-test-task3957",
      autoCreateGroup: true,   // ★ Task #4331：测试显式开启默认建群
    });

    expectFn(realPlugin.hasTaskUpdater()).toBe(false);

    // mock createGroupChat 避免真的调 lark-cli
    (realPlugin as any).createGroupChat = async () => "oc_test_chat";
    (realPlugin as any).sendToChat = async () => {};
    (realPlugin as any).sendToMain = async () => {};

    const instance = larkCliHandler.createInstance(config) as any;

    const originalImportPlugin = instance.importPlugin.bind(instance);
    instance.importPlugin = async function (_name: string) {
      return realPlugin;
    };

    // mock taskComponent.updateTask
    let capturedTaskId: number | undefined;
    let capturedContext: string | undefined;
    const mockTaskComponent = {
      updateTask: async (id: number, options: { context?: string }) => {
        capturedTaskId = id;
        capturedContext = options.context;
      },
    };

    // 注入 env（含 taskComponent）
    instance.setEnvironment({
      getComponent: (name: string) => (name === "task" ? mockTaskComponent : undefined),
    });

    try {
      await instance.loadPlugins();

      // setTaskUpdater 应该已被注入
      expectFn(realPlugin.hasTaskUpdater()).toBe(true);

      // 触发 onAfterCreate（模拟 task 创建）
      const task = {
        id: 42,
        title: "测试任务",
        context: "{}",
        parent_task_id: 0,
      };

      await globalHookManager.execute(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        {
          pluginEnabled: { "es-test-task3957:PerTaskGroupChatPlugin": true },
          envContext: {
            replyChannel: { chatId: "oc_test", messageId: "om_test", profile: "default" },
          },
        }
      );

      // 验证 updateTask 被调用，context 包含 larkPerTaskChatId
      expectFn(capturedTaskId).toBe(42);
      expectFn(capturedContext).toBeDefined();
      const parsed = JSON.parse(capturedContext!);
      expectFn(parsed.larkPerTaskChatId).toBe("oc_test_chat");
      expectFn(parsed.larkPerTaskChatProfile).toBe("default");
    } finally {
      instance.importPlugin = originalImportPlugin;
      instance.unloadPlugins();
    }
  });

  test("GREEN: env 未注入时，setTaskUpdater 不注入（plugin 走 in-memory fallback）", async () => {
    const realPlugin = createPerTaskGroupChatPlugin({
      pluginName: "PerTaskGroupChatPlugin",
      sourceId: "es-test-task3957",
    });

    expectFn(realPlugin.hasTaskUpdater()).toBe(false);

    const instance = larkCliHandler.createInstance(config) as any;

    const originalImportPlugin = instance.importPlugin.bind(instance);
    instance.importPlugin = async function (_name: string) {
      return realPlugin;
    };

    // 不调用 setEnvironment

    try {
      await instance.loadPlugins();

      // setTaskUpdater 未注入（因为 env 没注入）
      expectFn(realPlugin.hasTaskUpdater()).toBe(false);
    } finally {
      instance.importPlugin = originalImportPlugin;
      instance.unloadPlugins();
    }
  });

  test("GREEN: env.getComponent('task') 不存在时，setTaskUpdater 不注入", async () => {
    const realPlugin = createPerTaskGroupChatPlugin({
      pluginName: "PerTaskGroupChatPlugin",
      sourceId: "es-test-task3957",
    });

    const instance = larkCliHandler.createInstance(config) as any;

    const originalImportPlugin = instance.importPlugin.bind(instance);
    instance.importPlugin = async function (_name: string) {
      return realPlugin;
    };

    // 注入 env 但 taskComponent 不存在
    instance.setEnvironment({
      getComponent: () => undefined,
    });

    try {
      await instance.loadPlugins();

      // setTaskUpdater 未注入（因为 taskComponent 不存在）
      expectFn(realPlugin.hasTaskUpdater()).toBe(false);
    } finally {
      instance.importPlugin = originalImportPlugin;
      instance.unloadPlugins();
    }
  });

  test("GREEN: setTaskUpdater 不会被重复注入", async () => {
    const realPlugin = createPerTaskGroupChatPlugin({
      pluginName: "PerTaskGroupChatPlugin",
      sourceId: "es-test-task3957",
    });

    let callCount = 0;
    realPlugin.setTaskUpdater(async () => {
      callCount++;
    });

    expectFn(realPlugin.hasTaskUpdater()).toBe(true);

    const instance = larkCliHandler.createInstance(config) as any;

    const originalImportPlugin = instance.importPlugin.bind(instance);
    instance.importPlugin = async function (_name: string) {
      return realPlugin;
    };

    instance.setEnvironment({
      getComponent: () => ({
        updateTask: async () => {
          callCount++;
        },
      }),
    });

    try {
      await instance.loadPlugins();
      // 第一次注入已被调用（callCount=1），再次 loadPlugins 不应该再次注入
      const firstCount = callCount;
      await instance.loadPlugins();
      expectFn(callCount).toBe(firstCount);  // 没有增加
    } finally {
      instance.importPlugin = originalImportPlugin;
      instance.unloadPlugins();
    }
  });

  // =============================================================================
  // P1 修复：buildReplyChannel 必须透传 appId（PerTaskGroupChatPlugin 拉 bot 入群）
  // =============================================================================

  test("GREEN: buildReplyChannel 必须透传 appId（plugin 拉 bot 入群必需）", () => {
    // 直接调 LarkCliInstance.buildReplyChannel，验证 env-context replyChannel 包含 appId
    const rawReplyChannel = {
      type: "lark-cli",
      appId: "cli_test_bot",
      profile: "default",
      chatId: "oc_main_chat",
      messageId: "om_msg_main",
      params: { userId: "ou_user" },
    };

    const instance = larkCliHandler.createInstance(config) as any;
    const envReplyChannel = instance.buildReplyChannel(rawReplyChannel);

    expectFn(envReplyChannel).toBeDefined();
    expectFn(envReplyChannel.appId).toBe("cli_test_bot");
    // 同时保留原有字段
    expectFn(envReplyChannel.profile).toBe("default");
    expectFn(envReplyChannel.chatId).toBe("oc_main_chat");
    expectFn(envReplyChannel.messageId).toBe("om_msg_main");
    expectFn(envReplyChannel.userId).toBe("ou_user");
  });

  test("GREEN: buildReplyChannel 缺失 appId 时仍能工作（向后兼容）", () => {
    const rawReplyChannel = {
      type: "lark-cli",
      // 没有 appId（bounty-im / bounty-cli / 老 eventsource 没有此字段）
      profile: "default",
      chatId: "oc_main_chat",
      messageId: "om_msg_main",
    };

    const instance = larkCliHandler.createInstance(config) as any;
    const envReplyChannel = instance.buildReplyChannel(rawReplyChannel);

    expectFn(envReplyChannel).toBeDefined();
    // appId 应为 undefined（不报错）
    expectFn(envReplyChannel.appId).toBeUndefined();
  });

  test("GREEN: buildReplyChannel 透传 appId 后，PerTaskGroupChatPlugin 能正确解析 bot", async () => {
    const realPlugin = createPerTaskGroupChatPlugin({
      pluginName: "PerTaskGroupChatPlugin",
      sourceId: "es-test-task3957",
      autoCreateGroup: true,   // ★ Task #4331：测试显式开启默认建群
    });

    expectFn(realPlugin.hasTaskUpdater()).toBe(false);

    // 捕获传给 createGroupChat 的 opts
    let capturedOpts: any = undefined;
    (realPlugin as any).createGroupChat = function (opts: any) {
      capturedOpts = opts;
      return Promise.resolve("oc_test_chat");
    };

    const instance = larkCliHandler.createInstance(config) as any;

    const originalImportPlugin = instance.importPlugin.bind(instance);
    instance.importPlugin = async function (_name: string) {
      return realPlugin;
    };

    // 模拟 LarkCliInstance 注入 env（含 buildReplyChannel 的结果）
    instance.setEnvironment({
      getComponent: () => undefined,
    });

    try {
      await instance.loadPlugins();

      // 模拟 pluginEnabled metadata 中的 envContext（含 buildReplyChannel 结果）
      const envContext = {
        replyChannel: {
          type: "lark-cli",
          appId: "cli_test_bot_xyz",  // ★ 这是 buildReplyChannel 应该透传的 appId
          profile: "default",
          chatId: "oc_main_chat",
          messageId: "om_msg",
        },
        pluginEnabled: { "es-test-task3957:PerTaskGroupChatPlugin": true },
      };

      const task = {
        id: 999,
        title: "测试任务",
        context: "{}",
        parent_task_id: 0,
      };

      await globalHookManager.execute(
        TaskHookPoints.AFTER_CREATE,
        { task, sessionId: "s", tagService: {} as any },
        envContext
      );

      // 验证 createGroupChat 被调用，botAppIds 来自 replyChannel.appId
      expectFn(capturedOpts).toBeDefined();
      expectFn(capturedOpts.botAppIds).toBeDefined();
      expectFn(capturedOpts.botAppIds).toContain("cli_test_bot_xyz");
    } finally {
      instance.importPlugin = originalImportPlugin;
      instance.unloadPlugins();
    }
  });
});

// =============================================================================
// Part 2：workflow 通知插件注册（getPluginHookPoints 必须返回 4 个 workflow 点，
// 且不能破坏 task 插件原有的 4 个 task 点 fallback）
// =============================================================================

describe("LarkCliInstance plugin registration — workflow notify (Part 2)", () => {
  let config: EventSourceConfig;

  beforeEach(() => {
    globalHookManager.clear();
    config = {
      id: "es-test-workflow",
      name: "Test Event Source for workflow notify",
      type: "lark-cli",
      enabled: true,
      command: "echo test",
      handleRule: { plugins: ["LarkCliWorkflowNotifyPlugin"] },
    } as EventSourceConfig;
  });

  afterEach(() => {
    globalHookManager.clear();
  });

  test("getPluginHookPoints(workflow plugin) 返回 4 个 workflow hook 点", () => {
    const plugin = createLarkCliWorkflowNotifyHook({
      pluginName: "LarkCliWorkflowNotifyPlugin",
      sourceId: "es-test-workflow",
    });
    const instance = larkCliHandler.createInstance(config);

    const hookPoints = (instance as any).getPluginHookPoints(plugin);

    expectFn(hookPoints).toContain(WorkflowHookPoints.BEFORE_RUN);
    expectFn(hookPoints).toContain(WorkflowHookPoints.AFTER_RUN);
    expectFn(hookPoints).toContain(WorkflowHookPoints.BEFORE_NODE);
    expectFn(hookPoints).toContain(WorkflowHookPoints.AFTER_NODE);
    expectFn(hookPoints).toHaveLength(4);
    // 不应误配 task 点
    expectFn(hookPoints).not.toContain("task:after.create");
  });

  test("无 hookPoints 的 flat execute 插件仍走 task 兜底（不破坏现有 task 行为）", () => {
    const fake = { name: "FakeFlatPlugin", execute: async () => {} };
    const instance = larkCliHandler.createInstance(config);
    const hookPoints = (instance as any).getPluginHookPoints(fake);

    expectFn(hookPoints).toContain("task:after.create");
    expectFn(hookPoints).toContain("task:after.update");
    expectFn(hookPoints).toContain("task:operation:after.create");
    expectFn(hookPoints).toContain("task:after.complete");
  });

  test("端到端：loadPlugins 后 4 个 workflow hook 点都注册上（真实工厂）", async () => {
    const instance = larkCliHandler.createInstance(config) as any;

    try {
      await instance.loadPlugins();

      for (const hookPoint of Object.values(WorkflowHookPoints)) {
        expectFn(globalHookManager.count(hookPoint)).toBe(1);
      }
      // 执行不抛错（无 ALS replyChannel → 插件安全 no-op，绝不 spawn lark-cli）
      await globalHookManager.execute(WorkflowHookPoints.BEFORE_RUN, {
        runId: "workflow_run_reg",
        sessionId: "workflow_run_reg",
        workflowId: "wf-1",
        workflowName: "注册流程",
        status: "running",
        totalNodes: 1,
      });
    } finally {
      instance.unloadPlugins();
    }
  });
});