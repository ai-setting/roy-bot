/**
 * @fileoverview LarkCliInstance.injectTaskGetter 注入测试（Task #4039 C 项）
 *
 * 验证 registerPluginHooks 会把 taskComponent.getTask 注入给支持 setTaskGetter
 * 的 plugin（PerTaskGroupChatPlugin），用于 sub-task 上溯祖先群。
 */

import { describe, it, expect } from "bun:test";
import { LarkCliInstance } from "./event-source-handlers";
import type { EventSourceConfig } from "./types";

function makeConfig(): EventSourceConfig {
  return {
    id: "es_task_getter_test",
    name: "task getter test",
    type: "lark-cli",
    enabled: true,
    command: "lark-cli --profile default event consume im.message.receive_v1 --as bot",
  };
}

function makePluginWithGetter(): any {
  let injected: unknown = undefined;
  let setCount = 0;
  return {
    name: "test-plugin",
    hookPoint: "chat.message",
    setTaskGetter(getter: unknown) {
      injected = getter;
      setCount += 1;
    },
    hasTaskGetter() {
      return injected !== undefined;
    },
    _getInjected: () => injected,
    _getSetCount: () => setCount,
  };
}

describe("Task #4039 C — injectTaskGetter", () => {
  it("成功注入 taskComponent.getTask", () => {
    const plugin = makePluginWithGetter();
    const instance = new LarkCliInstance(makeConfig());
    const getTask = async (id: number) => ({ id, context: "{}", parent_task_id: null });
    instance.setEnvironment({
      getComponent: (name: string) => (name === "task" ? { getTask } : null),
    });

    (instance as any).registerPluginHooks(plugin);

    expect(plugin.hasTaskGetter()).toBe(true);
    expect(typeof plugin._getInjected()).toBe("function");
  });

  it("幂等：registerPluginHooks 两次只注入一次", () => {
    const plugin = makePluginWithGetter();
    const instance = new LarkCliInstance(makeConfig());
    instance.setEnvironment({
      getComponent: (name: string) => (name === "task" ? { getTask: async () => undefined } : null),
    });

    (instance as any).registerPluginHooks(plugin);
    (instance as any).registerPluginHooks(plugin);

    expect(plugin._getSetCount()).toBe(1);
  });

  it("taskComponent 缺 getTask → graceful 跳过", () => {
    const plugin = makePluginWithGetter();
    const instance = new LarkCliInstance(makeConfig());
    instance.setEnvironment({
      getComponent: (name: string) => (name === "task" ? {} : null),
    });

    expect(() => (instance as any).registerPluginHooks(plugin)).not.toThrow();
    expect(plugin._getSetCount()).toBe(0);
  });

  it("缺 environment → graceful 跳过", () => {
    const plugin = makePluginWithGetter();
    const instance = new LarkCliInstance(makeConfig());
    // 不 setEnvironment

    expect(() => (instance as any).registerPluginHooks(plugin)).not.toThrow();
    expect(plugin._getSetCount()).toBe(0);
  });

  it("plugin 不支持 setTaskGetter → 不抛错", () => {
    const plugin = { name: "no-getter", hookPoint: "chat.message" } as any;
    const instance = new LarkCliInstance(makeConfig());
    instance.setEnvironment({
      getComponent: (name: string) => (name === "task" ? { getTask: async () => undefined } : null),
    });

    expect(() => (instance as any).registerPluginHooks(plugin)).not.toThrow();
  });
});
