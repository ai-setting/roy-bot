/**
 * @fileoverview MemoryPlugin - Simplified
 * 
 * Hook handler for agent:after.react
 * 
 * 简化设计（移除旧的复杂机制）：
 * - 移除了 DraftManager（草稿管理已废弃）
 * - 移除了 MemoryOrganizer（整理机制已废弃）
 * - 移除了 AccessLog（访问日志已废弃）
 * 
 * 新的记忆管理方式：
 * - 使用 `roy memory recall --extract` 命令手动触发
 * - 使用 Memory Agent 自动分析会话历史
 * - 直接更新 memory.md 文件
 */

import type { HookContext } from "../../agent/types";
import type { AgentComponent } from "../../agent/agent-component";
import type { SessionMessage } from "../../session/session-component";
import type { SessionComponent } from "../../session/session-component";
import type { MemoryPluginConfig } from "./types";
import { DEFAULT_MEMORY_PLUGIN_CONFIG } from "./types";

// Define interface types for plugin compatibility
type IAgentComponent = AgentComponent;
type ISessionComponent = SessionComponent;
import { createLogger } from "../../log-trace/logger";
import path from "path";
import os from "os";
import fs from "fs/promises";
import type { ModelMessage } from "ai";

// Memory Agent imports
import type {
  MemoryAgentInput,
  MemoryAgentResult,
  ProjectSummary,
} from "./memory-agent";
import {
  buildProjectInput,
  buildGlobalInput,
  applyMemoryResult,
  generateProjectSummary,
  formatMemoryInput,
  parseMemoryAgentOutput,
  PROJECT_MEMORY_AGENT_PROMPT,
  GLOBAL_MEMORY_AGENT_PROMPT,
  createMemoryAgent,
} from "./memory-agent";


const logger = createLogger("MemoryPlugin");

/**
 * MemoryPlugin - Simplified
 * 
 * 简化的记忆插件，不再自动处理。
 * 
 * 用户应该使用 `roy memory recall --extract` 命令来手动触发记忆提取。
 * 
 * 保留此插件是为了：
 * 1. 保持 API 兼容性
 * 2. 未来可以扩展为可选的自动触发
 */
export class MemoryPlugin {
  private config: MemoryPluginConfig;
  private disposed: boolean = false;
  private initialized: boolean = false;

  /** 项目 memory 基础目录 */
  private projectBaseDir: string = "";

  /** 全局 memory 基础目录 */
  private globalBaseDir: string = "";

  /** 当前工作目录（用于推断项目路径） */
  private workDir: string = "";

  /** AgentComponent 引用（延迟获取） */
  private agentComponent: IAgentComponent | null = null;

  constructor(baseDir: string, config: MemoryPluginConfig = {}) {
    this.config = { ...DEFAULT_MEMORY_PLUGIN_CONFIG, ...config };
    this.workDir = baseDir;
    this.projectBaseDir = path.join(baseDir, ".roy", "memory");
    this.globalBaseDir = path.join(os.homedir(), ".config", "roy-bot", "memory");
    logger.info("MemoryPlugin (simplified) created", { baseDir, config: this.config });
  }

  /**
   * Plugin 名称
   */
  get name(): string {
    return "MemoryPlugin";
  }

  /**
   * 订阅的 Hook 点
   */
  get hookPoint(): "agent:after.react" {
    return "agent:after.react";
  }

  /**
   * 优先级
   */
  get priority(): number {
    return 50;
  }

  /**
   * 描述
   */
  get description(): string {
    return "Memory management plugin. Use 'roy memory recall --extract' to extract memories.";
  }

  /**
   * 获取 Hook 定义
   */
  get hooks() {
    return [
      {
        point: this.hookPoint as "agent:after.react",
        priority: this.priority,
      },
    ];
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    logger.info("MemoryPlugin (simplified) initialized");
  }

  /**
   * 执行 Hook
   * 
   * 简化为空操作。用户应该使用 `roy memory recall --extract` 命令。
   */
  async execute(ctx: HookContext): Promise<void> {
    if (this.disposed || !this.config.enabled || !this.initialized) {
      return;
    }

    // 不再自动处理。用户应该使用 `roy memory recall --extract`
    logger.debug("MemoryPlugin hook executed. Use 'roy memory recall --extract' for memory extraction.");
  }

  /**
   * 准备关闭
   */
  prepareShutdown(): void {
    // 无需处理
  }

  /**
   * 检查是否有待处理任务
   */
  hasPendingTasks(): boolean {
    return false;
  }

  /**
   * 等待处理完成
   */
  async waitForCompletion(): Promise<void> {
    // 无需等待
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    logger.info("MemoryPlugin (simplified) disposed");
  }

  /**
   * 获取项目 base dir
   */
  getProjectBaseDir(): string {
    return this.projectBaseDir;
  }

  /**
   * 获取全局 base dir
   */
  getGlobalBaseDir(): string {
    return this.globalBaseDir;
  }
}

/**
 * 创建 MemoryPlugin 实例
 */
export function createMemoryPlugin(
  baseDir: string,
  config?: MemoryPluginConfig
): MemoryPlugin {
  return new MemoryPlugin(baseDir, config);
}
