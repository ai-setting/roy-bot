/**
 * @fileoverview ReminderPlugin 单元测试
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ReminderPlugin } from "./reminder-plugin";
import type { PluginEnv, HookContext } from "@ai-setting/roy-bot-core";

// Mock PluginEnv
const createMockEnv = (): PluginEnv => ({
  getComponent: () => undefined,
  registerAgent: () => {},
  registerTool: () => {},
  registerHook: () => {},
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any,
});

describe("ReminderPlugin", () => {
  let plugin: ReminderPlugin;
  let registeredHooks: { point: string; priority: number; handler: Function }[] = [];

  beforeEach(() => {
    registeredHooks = [];
    plugin = new ReminderPlugin();
    plugin.init(createMockEnv() as any);
  });

  describe("init", () => {
    it("注册 agent:before.llm hook", () => {
      const mockEnv = createMockEnv();
      mockEnv.registerHook = (hook: any) => {
        registeredHooks.push(hook);
      };

      const newPlugin = new ReminderPlugin();
      newPlugin.init(mockEnv as any);

      expect(registeredHooks.length).toBe(1);
      expect(registeredHooks[0].point).toBe("agent:before.llm");
      expect(registeredHooks[0].priority).toBe(100);
    });
  });

  describe("onBeforeLLM", () => {
    it("当 iteration < maxIterations 时，不注入提醒", async () => {
      const ctx = {
        component: { name: "agent", version: "1.0.0" },
        data: {
          iteration: 99,
          maxIterations: 200,
          messages: [{ role: "user" as const, content: "Hello" }],
        },
        metadata: {},
        phase: "before" as const,
        hookPoint: "agent:before.llm",
      } as HookContext;

      const result = await (plugin as any).onBeforeLLM(ctx);

      expect(result).toEqual({ stopped: false, results: [] });
      expect(ctx.data.messages.length).toBe(1);
    });

    it("当 iteration === maxIterations 时，注入 user message", async () => {
      const ctx = {
        component: { name: "agent", version: "1.0.0" },
        data: {
          iteration: 200,
          maxIterations: 200,
          messages: [{ role: "user" as const, content: "Hello" }],
        },
        metadata: {},
        phase: "before" as const,
        hookPoint: "agent:before.llm",
      } as HookContext;

      const result = await (plugin as any).onBeforeLLM(ctx);

      expect(result).toEqual({ stopped: false, results: [] });
      expect(ctx.data.messages.length).toBe(2);
      expect(ctx.data.messages[1].role).toBe("user");
      expect(ctx.data.messages[1].content).toContain("200");
    });

    it("提醒消息包含 maxIterations 占位符", async () => {
      const ctx = {
        component: { name: "agent", version: "1.0.0" },
        data: {
          iteration: 50,
          maxIterations: 50,
          messages: [],
        },
        metadata: {},
        phase: "before" as const,
        hookPoint: "agent:before.llm",
      } as HookContext;

      await (plugin as any).onBeforeLLM(ctx);

      expect(ctx.data.messages.length).toBe(1);
      expect(ctx.data.messages[0].content).toContain("50");
    });

    it("返回 stopped: false，不中断执行", async () => {
      const ctx = {
        component: { name: "agent", version: "1.0.0" },
        data: {
          iteration: 200,
          maxIterations: 200,
          messages: [],
        },
        metadata: {},
        phase: "before" as const,
        hookPoint: "agent:before.llm",
      } as HookContext;

      const result = await (plugin as any).onBeforeLLM(ctx);

      expect(result.stopped).toBe(false);
    });

    it("提醒消息包含要求总结的内容", async () => {
      const ctx = {
        component: { name: "agent", version: "1.0.0" },
        data: {
          iteration: 100,
          maxIterations: 100,
          messages: [],
        },
        metadata: {},
        phase: "before" as const,
        hookPoint: "agent:before.llm",
      } as HookContext;

      await (plugin as any).onBeforeLLM(ctx);

      expect(ctx.data.messages.length).toBe(1);
      const content = ctx.data.messages[0].content as string;
      expect(content).toContain("不要再调用任何工具");
      expect(content).toContain("总结");
    });
  });

  describe("自定义消息模板", () => {
    it("支持自定义消息模板", async () => {
      const customPlugin = new ReminderPlugin({
        messageTemplate: "Custom: {maxIterations} iterations reached!",
      });
      customPlugin.init(createMockEnv() as any);

      const ctx = {
        component: { name: "agent", version: "1.0.0" },
        data: {
          iteration: 100,
          maxIterations: 100,
          messages: [],
        },
        metadata: {},
        phase: "before" as const,
        hookPoint: "agent:before.llm",
      } as HookContext;

      await (customPlugin as any).onBeforeLLM(ctx);

      expect(ctx.data.messages.length).toBe(1);
      expect(ctx.data.messages[0].content).toBe("Custom: 100 iterations reached!");
    });
  });

  describe("元信息", () => {
    it("有正确的 name 和 version", () => {
      expect(plugin.name).toBe("ReminderPlugin");
      expect(plugin.version).toBe("1.0.0");
    });

    it("有描述", () => {
      expect(plugin.description).toBeDefined();
      expect(plugin.description).toContain("最后一次 LLM 调用前注入提醒");
    });

    it("有正确的 priority", () => {
      expect(plugin.priority).toBe(100);
    });
  });
});
