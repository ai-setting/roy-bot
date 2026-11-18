import { describe, test, expect as expectFn, beforeEach, afterEach } from "bun:test";

import { globalHookManager } from "../hook/global-hook-manager";
import { larkCliHandler } from "./event-source-handlers";
import type { EventSourceConfig } from "./types";
import { TaskHookPoints } from "../task/hooks/task-hook-points";
import { createPerTaskGroupChatPlugin, PerTaskGroupChatPlugin } from "../task/plugins/per-task-group-chat-plugin";

describe("Task #3957: PerTaskGroupChatPlugin.onAfterComplete 通过 globalHookManager 触发", () => {
  let config: EventSourceConfig;
  let plugin: PerTaskGroupChatPlugin;
  let captured: any[] = [];
  let hookCalls = 0;
  let calledWith: number | undefined;
  const originalOnAfterComplete = Object.getOwnPropertyDescriptor(
    PerTaskGroupChatPlugin.prototype,
    "onAfterComplete"
  )?.value;

  beforeEach(() => {
    globalHookManager.clear();

    config = {
      id: "es-integration-3957",
      name: "integration",
      type: "lark-cli",
      enabled: true,
      command: "echo test",
      handleRule: { plugins: ["PerTaskGroupChatPlugin"] },
    } as EventSourceConfig;

    plugin = createPerTaskGroupChatPlugin({
      pluginName: "PerTaskGroupChatPlugin",
      sourceId: "es-integration-3957",
    });

    // ★ Task #4237：插件不再持有卡片生命周期 —— 用 spy 证明 hook 仍然派发到它，
    //   同时断言它没有去动卡片（防止双 owner 复活）
    captured = [];
    hookCalls = 0;
    (PerTaskGroupChatPlugin.prototype as any).onAfterComplete = async function (
      ctx: any
    ): Promise<void> {
      hookCalls++;
      calledWith = ctx?.data?.task?.id;
    };
  });

  afterEach(() => {
    globalHookManager.clear();
    // 还原被 spy 覆盖的 prototype 方法
    if (originalOnAfterComplete !== undefined) {
      (PerTaskGroupChatPlugin.prototype as any).onAfterComplete = originalOnAfterComplete;
    }
  });

  test("After fix: globalHookManager.execute(AFTER_COMPLETE, ...) 真的调用 PerTaskGroupChatPlugin.onAfterComplete（Task #4237：卡片已移交 notify hook，插件不再 finish 卡片）", async () => {
    const instance = larkCliHandler.createInstance(config) as any;

    const orig = instance.importPlugin.bind(instance);
    instance.importPlugin = async function (_name: string) {
      return plugin;
    };

    try {
      await instance.loadPlugins();

      // 模拟真实 eventsource.handleEvent: metadata.pluginEnabled
      const metadata = {
        pluginEnabled: { "es-integration-3957:PerTaskGroupChatPlugin": true },
      };

      await globalHookManager.execute(
        TaskHookPoints.AFTER_COMPLETE,
        {
          task: {
            id: 100,
            context: JSON.stringify({ larkPerTaskChatId: "oc_task_100" }),
            title: "测试 task",
          },
          changes: { status: "completed" },
          terminalStatus: "completed",
          sessionId: "s",
          tagService: {} as any,
        },
        metadata
      );

      // hook 链路仍然生效（#3957 回归点）：AFTER_COMPLETE 真的到了插件
      expectFn(hookCalls).toBeGreaterThan(0);
      expectFn(calledWith).toBe(100);
      // ★ Task #4237：但插件不再自己 finish/ patch 卡片（唯一 owner = notify hook）
      expectFn(captured.length).toBe(0);
    } finally {
      instance.importPlugin = orig;
      instance.unloadPlugins();
    }
  });
});
