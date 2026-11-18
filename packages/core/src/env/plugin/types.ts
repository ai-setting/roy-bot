/**
 * @fileoverview Unified Plugin System Types
 *
 * 统一插件接口定义
 */

import type { HookContext, HookResult } from "../hook/types";
import type { ILogger as Logger } from "../log-trace/logger";
import type { NotificationOptions } from "./notification-channel";

// ========================================================================
// Hook Types
// ========================================================================

/**
 * Hook 处理函数
 */
export type HookHandler = (
  ctx: HookContext
) => void | Promise<void> | HookResult | Promise<HookResult>;

/**
 * Hook 定义
 */
export interface HookDefinition {
  /** Hook 点名称 */
  point: string;
  /** 优先级（数字越大越先执行，默认 0）*/
  priority?: number;
  /** 处理函数 */
  handler: HookHandler;
}

// ========================================================================
// Plugin Environment
// ========================================================================

/**
 * Plugin 环境接口
 *
 * 注入到每个 Plugin 的统一环境
 */
export interface PluginEnv {
  /** 获取组件 */
  getComponent<T>(name: string): T | undefined;

  /** 注册 Agent */
  registerAgent(config: AgentInstanceConfig): void;

  /** 注册 Tool */
  registerTool(tool: ToolDefinition): void;

  /** 注册 Hook */
  registerHook(hook: HookDefinition): void;

  /**
   * 发送通知
   *
   * Plugin 调用此方法发出"通知"，由 PluginComponent 路由到已注册的
   * NotificationChannel（默认 EventBusNotificationChannel）。
   *
   * 注意：
   * - 此方法不抛错（channel.send 异常会被 swallow）
   * - 如果没有任何 channel 能路由（canRoute 全 false），通知被丢弃
   *
   * @example
   * ```ts
   * await env.notify({
   *   type: "visualization_ready",
   *   title: "Viz Ready",
   *   content: "Chart rendered",
   *   metadata: { taskId: 42 },
   * });
   * ```
   */
  notify(options: NotificationOptions): Promise<void>;

  /** 日志器 */
  logger: Logger;
}

// ========================================================================
// Agent Config (Plugin 依赖)
// ========================================================================

/**
 * Agent 实例配置（Plugin 注册时需要）
 */
export interface AgentInstanceConfig {
  name: string;
  description?: string;
  systemPrompt?: string;
  tools?: string[];
  model?: string;
  maxIterations?: number;
  // 其他 Agent 配置...
}

// ========================================================================
// Tool Definition (Plugin 注册时需要)
// ========================================================================

/**
 * Tool 定义（Plugin 注册时需要）
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: any;
  handler: (...args: any[]) => any;
}

// ========================================================================
// Base Plugin
// ========================================================================

/**
 * Plugin 基类
 *
 * 所有插件都必须继承此类或实现相同接口
 *
 * @example
 * ```typescript
 * class MyPlugin extends BasePlugin {
 *   readonly name = "my-plugin";
 *   readonly version = "1.0.0";
 *
 *   constructor(config?: MyConfig) {
 *     super();
 *     this.config = config;
 *   }
 *
 *   init(env: PluginEnv): void {
 *     env.registerHook({
 *       point: "agent:before.llm",
 *       handler: this.onBeforeLLM.bind(this),
 *     });
 *   }
 *
 *   private async onBeforeLLM(ctx: HookContext): Promise<void> {
 *     // ...
 *   }
 * }
 * ```
 */
export abstract class BasePlugin {
  /** 插件唯一名称 */
  abstract readonly name: string;

  /** 插件版本 */
  readonly version: string = "1.0.0";

  /** 插件描述 */
  readonly description?: string;

  /** 插件优先级（数字越大优先级越高，默认 0）*/
  readonly priority: number = 0;

  /**
   * 构造函数
   *
   * 子类可覆盖以接收配置参数
   */
  constructor() {}

  /**
   * 初始化
   *
   * 在插件注册到 PluginComponent 时调用
   * - 获取依赖组件
   * - 注册 Hooks
   * - 注册 Agents/Tools
   *
   * @param env - Plugin 环境
   */
  init(env: PluginEnv): void | Promise<void> {}

  /**
   * 销毁
   *
   * 在插件注销时调用
   * - 清理资源
   * - 关闭连接
   */
  dispose(): void | Promise<void> {}
}

// ========================================================================
// Export Hook Types from hook module
// ========================================================================

export type { HookContext, HookResult } from "../hook/types";
