/**
 * @fileoverview LarkCliInstance.injectSessionComponent 幂等 + duck-typing 测试
 *
 * Task #4023 + #4025 OC track 推荐 #5/#6 改进：
 * - injectSessionComponent 调用前先查 plugin.hasSessionComponent()，已注入则跳过
 * - 注入路径用 duck-typing 检查 `sessionComponent.upsertChatTaskBinding` 是否存在
 *   而非依赖具体类（降低模块耦合）
 * - 注入成功 + 失败均有 debug 日志
 *
 * 这些测试在 A 现有实现下应失败（RED）：
 * - A 没有 hasSessionComponent 幂等检查（重复注入）
 * - A 没有 upsertChatTaskBinding duck-typing 检查（仍会注入整个对象）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LarkCliInstance } from "./event-source-handlers";
import type { EventSourceConfig } from "./types";

describe("Task #4023+#4025 OC #5/#6 — injectSessionComponent 幂等 + duck-typing", () => {
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    originalEnv = {
      ROY_TASK_NOTIFY_DEBUG: process.env.ROY_TASK_NOTIFY_DEBUG,
      ROY_TRACE_DEBUG: process.env.ROY_TRACE_DEBUG,
    };
    process.env.ROY_TASK_NOTIFY_DEBUG = "1";
  });
  afterEach(() => {
    process.env.ROY_TASK_NOTIFY_DEBUG = originalEnv.ROY_TASK_NOTIFY_DEBUG;
    process.env.ROY_TRACE_DEBUG = originalEnv.ROY_TRACE_DEBUG;
  });

  function makeConfig(): EventSourceConfig {
    return {
      id: "es_inject_test",
      name: "inject test",
      type: "lark-cli",
      enabled: true,
      command: "lark-cli --profile default event consume im.message.receive_v1 --as bot",
    };
  }

  function makePluginWithSession(): any {
    let injected: unknown = undefined;
    let setCount = 0;
    return {
      name: "test-plugin",
      hookPoint: "chat.message",
      initCalled: false,
      setSessionComponent(component: unknown) {
        injected = component;
        setCount += 1;
      },
      hasSessionComponent() {
        return injected !== undefined;
      },
      _getInjected: () => injected,
      _getSetCount: () => setCount,
    };
  }

  function makePluginWithoutSession(): any {
    return {
      name: "no-session-plugin",
      hookPoint: "chat.message",
      initCalled: false,
      // 故意没有 setSessionComponent/hasSessionComponent
    };
  }

  it("重复 registerPluginHooks 时 hasSessionComponent 幂等检查生效：setCount=1", () => {
    const plugin = makePluginWithSession();
    const config = makeConfig();
    const instance = new LarkCliInstance(config);

    const session = {
      upsertChatTaskBinding: async (_opts: any) => {},
    };

    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    // 模拟 registerPluginHooks 调用两次（典型场景：组件热重载 / 多次 start）
    (instance as any).registerPluginHooks(plugin);
    (instance as any).registerPluginHooks(plugin);

    // 期望 hasSessionComponent 幂等检查避免重复注入
    expect(plugin._getSetCount()).toBe(1);
  });

  it("注入路径：sessionComponent 缺 upsertChatTaskBinding 时 graceful 跳过（duck-typing）", () => {
    const plugin = makePluginWithSession();
    const config = makeConfig();
    const instance = new LarkCliInstance(config);

    // 模拟 sessionComponent 但缺少 upsertChatTaskBinding
    const sessionWithoutUpsert = {} as any;

    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? sessionWithoutUpsert : null),
    });

    (instance as any).registerPluginHooks(plugin);

    // 期望：plugin.setSessionComponent 没有被调用（duck-typing 失败 → graceful skip）
    expect(plugin._getSetCount()).toBe(0);
  });

  it("注入路径：缺 environment 时 graceful 跳过", () => {
    const plugin = makePluginWithSession();
    const config = makeConfig();
    const instance = new LarkCliInstance(config);

    // 不调用 setEnvironment

    (instance as any).registerPluginHooks(plugin);

    // 期望：plugin.setSessionComponent 没有被调用
    expect(plugin._getSetCount()).toBe(0);
  });

  it("缺 setSessionComponent 方法的 plugin：graceful 跳过（不抛错）", () => {
    const plugin = makePluginWithoutSession();
    const config = makeConfig();
    const instance = new LarkCliInstance(config);

    const session = {
      upsertChatTaskBinding: async (_opts: any) => {},
    };

    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    // 期望：不会抛错
    expect(() => {
      (instance as any).registerPluginHooks(plugin);
    }).not.toThrow();
  });

  it("成功注入：hasSessionComponent() 之后返回 true", () => {
    const plugin = makePluginWithSession();
    const config = makeConfig();
    const instance = new LarkCliInstance(config);

    const session = {
      upsertChatTaskBinding: async (_opts: any) => {},
    };

    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    (instance as any).registerPluginHooks(plugin);

    expect(plugin.hasSessionComponent()).toBe(true);
    expect(plugin._getInjected()).toBe(session);
  });
});