/**
 * @fileoverview Task #5193 — EventSource 插件加载共享模块
 *
 * ## 为什么抽出来
 *
 * 插件机制（BUILT_IN_PLUGIN_FACTORIES / getPluginHookPoints /
 * registerPluginHooks）原来**只存在于 LarkCliInstance**（私有方法）。
 * WecomCliInstance 要加载 WecomTaskNotifyPlugin 就得复用同一套逻辑，
 * 但两者是独立的 class —— 直接复制会 drift（Task #4946「声明 ≠ 实现」
 * 的教训：handleRule.plugins 配在 wecom 源上是 dead config）。
 *
 * 本模块把「按名字实例化 + 注册 hook 点」抽成**纯函数**，
 * LarkCliInstance 与 WecomCliInstance 都可以调（lark 侧后续可迁移，
 * 本次不动 lark 行为）。
 *
 * ## Hook 注册语义（与 LarkCliInstance.registerPluginHooks 一致）
 *
 * - Hook 模式（有 execute 无 hookPoint）→ 按 getPluginHookPoints
 *   白名单（5 个 task hook 点）逐点注册
 * - 显式 hookPoint → 单点注册
 * - BasePlugin 模式（有 init）→ 调 init（registerHook 回调注册）
 * - pluginEnabled 检查 key = `${sourceId}:${pluginName}`
 */

import { globalHookManager } from "../hook/global-hook-manager";
// 内置插件工厂（静态 import 让 bundler 内联，避免运行时反射加载）
import {
  createLarkCliTaskNotifyHook,
  createPerTaskGroupChatPlugin,
  createWecomTaskNotifyHook,
  TaskTagPlugin,
} from "../task/plugins";
import { createLarkCliWorkflowNotifyHook } from "../workflow/plugins";

/** 插件工厂配置（工厂收到的最小面） */
export interface PluginFactoryConfig {
  sourceId: string;
  pluginName: string;
  [key: string]: unknown;
}

/**
 * 内置插件工厂注册表。
 *
 * ⚠️ 与 event-source-handlers.ts 的 BUILT_IN_PLUGIN_FACTORIES **同源**：
 * 该表在 handlers 里定义（静态 import 让 bundler 内联），本模块
 * 通过注入函数引用避免循环依赖 —— 调用方（handlers / wecom handler）
 * 传入自己的工厂表。
 */
export type PluginFactory = (cfg: PluginFactoryConfig) => any;

/**
 * 内置插件工厂注册表（单一真相源，Task #5193 迁入）。
 *
 * ⚠️ 原 BUILT_IN_PLUGIN_FACTORIES 在 event-source-handlers.ts，
 * 迁到本模块让 wecom-cli-handler 也能复用（避免循环依赖）。
 * handlers 侧改为引用本表，行为零变化。
 */
export const BUILT_IN_PLUGIN_FACTORIES: Record<string, PluginFactory> = {
  LarkCliTaskNotifyPlugin: (cfg) => createLarkCliTaskNotifyHook(cfg as any),
  // ★ Task #5193：企微任务进展通知（markdown 卡片，无 interactive card）
  // 配置方式：roy-bot eventsource update <id> --plugins "WecomTaskNotifyPlugin"
  // 只在 wecom 事件上下文发送（extractWecomFields 判定），与 lark 插件互斥不双发。
  WecomTaskNotifyPlugin: (cfg) => createWecomTaskNotifyHook(cfg as any),
  // Part 2: 把 workflow run 进展同步到飞书群（复用 task 卡片引擎）
  LarkCliWorkflowNotifyPlugin: (cfg) => createLarkCliWorkflowNotifyHook(cfg as any),
  // Task #3945: 每 task 一个独立飞书群聊
  PerTaskGroupChatPlugin: (cfg) => createPerTaskGroupChatPlugin(cfg as any),
  // 配置中以 "task-tag" 这个 kebab-case 名引用
  "task-tag": () => new TaskTagPlugin(),
};

/** wecom 侧工厂表（当前与全局同源；将来可裁剪 lark 专属插件） */
export function getWecomPluginFactories(): Record<string, PluginFactory> {
  return BUILT_IN_PLUGIN_FACTORIES;
}

/**
 * 获取插件的 hook 点列表（与 LarkCliInstance.getPluginHookPoints 同语义）
 */
export function getPluginHookPointsShared(plugin: any): string[] {
  // TaskPlugin 兼容模式：plugin.hooks 是数组
  if (Array.isArray(plugin.hooks)) {
    return plugin.hooks.map((h: any) => h.point || h);
  }

  // 显式声明 hookPoints 的插件
  if (Array.isArray(plugin.hookPoints)) {
    return plugin.hookPoints.map((h: any) => h.point || h);
  }

  // 新版 Hook 模式：直接有 execute 方法和 hookPoint
  if (typeof plugin.execute === "function" && plugin.hookPoint) {
    return [plugin.hookPoint];
  }

  // LarkCliTaskNotifyHook / WecomTaskNotifyHook 等，按配置的 hook 点注册
  if (plugin.name && typeof plugin.execute === "function") {
    return [
      "task:after.create",
      "task:after.update",
      "task:operation:after.create",
      "task:after.complete",
      "task:after.delete",
    ];
  }

  return [];
}

/**
 * 把插件实例的 hooks 注册到 globalHookManager。
 *
 * @returns 注册的 hook 点列表（诊断用）
 */
export function registerPluginHooksShared(
  plugin: any,
  pluginName: string,
  sourceId: string
): string[] {
  const hookPoints = getPluginHookPointsShared(plugin);

  // BasePlugin 模式：调用 init(env) 注册 hooks
  if (typeof plugin.init === "function") {
    const pluginEnv = {
      getComponent: () => null,
      registerAgent: () => {},
      registerTool: () => {},
      registerHook: (hook: any) => {
        globalHookManager.register(hook.point, {
          name: `${pluginName}:${hook.point}`,
          priority: hook.priority ?? 0,
          pluginName,
          sourceId,
          execute: hook.handler,
        });
      },
      logger: {
        debug: (...args: any[]) => console.debug(`[plugin:${pluginName}]`, ...args),
        info: (...args: any[]) => console.info(`[plugin:${pluginName}]`, ...args),
        warn: (...args: any[]) => console.warn(`[plugin:${pluginName}]`, ...args),
        error: (...args: any[]) => console.error(`[plugin:${pluginName}]`, ...args),
      },
    };
    plugin.init(pluginEnv);
    return hookPoints;
  }

  // 新版 Hook 模式
  if (typeof plugin.execute === "function") {
    if (plugin.hookPoint) {
      globalHookManager.register(plugin.hookPoint, {
        name: `${pluginName}:${plugin.hookPoint}`,
        priority: plugin.priority ?? 0,
        pluginName,
        sourceId,
        execute: plugin.execute.bind(plugin),
      });
    } else {
      // LarkCliTaskNotifyHook / WecomTaskNotifyHook 等 Hook 实例
      for (const hookPoint of hookPoints) {
        globalHookManager.register(hookPoint, {
          name: `${pluginName}:${hookPoint}`,
          priority: plugin.priority ?? 0,
          pluginName,
          sourceId,
          execute: plugin.execute.bind(plugin),
        });
      }
    }
    return hookPoints;
  }

  // TaskPlugin 兼容模式
  if (Array.isArray(plugin.hooks)) {
    for (const hook of plugin.hooks) {
      const hookPoint = hook.point || hook;
      const priority = hook.priority ?? 0;
      globalHookManager.register(hookPoint, {
        name: `${pluginName}:${hookPoint}`,
        priority,
        pluginName,
        sourceId,
        execute: async (ctx: any) => {
          await plugin.execute(ctx);
        },
      });
    }
    return hookPoints;
  }

  return hookPoints;
}

/**
 * 按名字实例化内置插件（工厂表由调用方注入）。
 *
 * @returns 插件实例；未知名字 / 实例化失败 → null
 */
export function importPluginShared(
  name: string,
  factories: Record<string, PluginFactory>,
  pluginConfig: Record<string, unknown> = {}
): any | null {
  const factory = factories[name];
  if (!factory) {
    console.error(`[es-plugins] Unknown plugin: ${name}`);
    return null;
  }
  try {
    return factory({
      sourceId: "",
      pluginName: name,
      ...pluginConfig,
    } as PluginFactoryConfig);
  } catch (error) {
    console.error(`[es-plugins] Failed to instantiate plugin ${name}:`, error);
    return null;
  }
}

/**
 * 注销插件注册的所有 hooks（stop 时调用）
 */
export function unregisterPluginHooksShared(
  pluginName: string,
  hookPoints: string[]
): void {
  for (const hookPoint of hookPoints) {
    globalHookManager.unregister(hookPoint, `${pluginName}:${hookPoint}`);
  }
}
