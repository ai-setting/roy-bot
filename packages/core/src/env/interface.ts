/**
 * @fileoverview Environment Interface
 * 
 * Environment 是智能体运行时的核心抽象。
 * 
 * 设计原则：
 * 1. Environment 只做两件事：
 *    - 组件管理：持有、注册、获取组件
 *    - 核心调度：handle_query / handle_action / EnvEvent
 * 2. 其他能力归属到对应 Component
 * 
 * 服务配置能力：
 * - loadServiceConfig(): 从配置文件加载服务配置
 * - generateComponentOptions(): 生成组件初始化选项
 * - registerComponentWithConfig(): 注册并用配置初始化组件
 * - initFromConfig(): 从配置文件初始化整个环境
 */

import type { Component } from "./component";
import type { EnvEvent, EnvEventHandler, EnvEventInput, EnvironmentConfig, Action, ToolResult, Context } from "./types";
import type { AgentContext } from "./agent/types";
import type { ContentPart } from "./llm/types";
import type { ConfigComponent } from "../config/config-component";

// Re-export for convenience
export type { AgentContext };

/**
 * 服务配置接口
 */
export interface ServiceConfig {
  /** 环境配置 */
  environment?: {
    name?: string;
    version?: string;
  };
  /** 组件配置映射 */
  components?: Record<string, ComponentConfigEntry>;
}

/**
 * 组件配置项
 */
export interface ComponentConfigEntry {
  /** 配置文件路径（可选） */
  configPath?: string;
  /** 环境变量前缀（可选） */
  envPrefix?: string;
  /** 直接配置对象（可选） */
  config?: Record<string, unknown>;
  /** 是否启用（可选，默认 true） */
  enabled?: boolean;
}

/**
 * 组件初始化选项（由 generateComponentOptions 生成）
 */
export interface GeneratedComponentOptions {
  /** ConfigComponent 实例 */
  configComponent: ConfigComponent;
  /** 配置文件路径 */
  configPath?: string;
  /** 环境变量前缀 */
  envPrefix?: string;
  /** 直接配置对象 */
  config?: Record<string, unknown>;
  /** 允许的其他属性 */
  [key: string]: unknown;
}

/**
 * Environment 接口
 * 
 * 定义 Agent 运行时的核心能力接口。
 */
export interface Environment {
  // ============ 标识 ============
  
  /** 环境名称 */
  readonly name: string;
  
  /** 环境版本 */
  readonly version: string;
  
  /** 获取环境配置 */
  getConfig(): EnvironmentConfig;
  
  // ============ 组件管理（核心职责） ============
  
  /**
   * 注册组件
   */
  registerComponent(component: Component): void;
  
  /**
   * 注销组件
   */
  unregisterComponent(name: string): void;
  
  /**
   * 获取组件
   */
  getComponent<T extends Component>(name: string): T | undefined;
  
  /**
   * 列出所有组件
   */
  listComponents(): Component[];
  
  // ============ 核心能力（Agent 调度） ============
  
  /**
   * 处理自然语言查询（核心入口）
   *
   * @param query 用户查询（文本 string 或多模态 ContentPart[]）
   * @param context 执行上下文（可选）
   * @returns 完整的文本响应
   */
  handle_query(
    query: string | ContentPart[],
    context?: AgentContext
  ): Promise<string>;
  
  /**
   * 处理动作
   */
  handle_action(
    action: Action,
    context: Context
  ): Promise<ToolResult>;
  
  // ============ EnvEvent 机制 ============
  
  /**
   * 订阅 EnvEvent（返回取消订阅函数）
   */
  subscribe(handler: EnvEventHandler): () => void;
  
  /**
   * 订阅指定类型事件
   */
  subscribeTo(
    eventType: string | string[],
    handler: EnvEventHandler
  ): () => void;
  
  /**
   * 订阅所有事件（通配符）
   */
  subscribeAll(handler: EnvEventHandler): () => void;
  
  /**
   * 推送事件
   * 
   * @param event EnvEvent 或 EnvEventInput（部分属性）
   */
  pushEnvEvent(event: EnvEvent | EnvEventInput): void;
  
  // ============ 服务配置能力 ============
  
  /**
   * 从配置文件加载服务配置
   * 
   * @param configPath 配置文件路径（基于 XDG_DATA_HOME）
   * @returns 解析后的服务配置对象
   */
  loadServiceConfig(configPath: string): Promise<ServiceConfig>;
  
  /**
   * 生成组件初始化选项
   * 
   * 根据组件配置项生成可用于初始化的选项对象。
   * 
   * @param componentName 组件名称
   * @param configEntry 组件配置项
   * @returns 生成的组件初始化选项
   */
  generateComponentOptions(
    componentName: string,
    configEntry: ComponentConfigEntry
  ): GeneratedComponentOptions;
  
  /**
   * 注册组件并用配置初始化
   * 
   * 便捷方法：注册组件并通过 ConfigComponent 初始化。
   * 
   * @param component 要注册的组件实例
   * @param configEntry 组件配置项
   */
  registerComponentWithConfig(
    component: Component,
    configEntry: ComponentConfigEntry
  ): Promise<void>;
  
  /**
   * 从配置文件初始化整个环境
   * 
   * 加载服务配置，注册并初始化所有配置的组件。
   * 
   * @param configPath 配置文件路径（基于 XDG_DATA_HOME）
   */
  initFromConfig(configPath: string): Promise<void>;
}
