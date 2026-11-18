/**
 * @fileoverview Commands Component Types
 * 
 * 定义 CommandsComponent 的类型系统（收藏式）
 */

import type { ConfigComponent } from "../../config/config-component";

// ============================================================================
// 配置类型
// ============================================================================

/**
 * CommandsComponent 配置（通过 options 传递）
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的 config 对象（最高优先级）
 */
export interface CommandsComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "COMMAND"） */
  envPrefix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<CommandsComponentConfig>;
}

/**
 * CommandsComponent 配置
 */
export interface CommandsComponentConfig {
  /** User 级别命令目录 */
  userCommandsDir?: string;
  /** 项目级别命令目录 */
  projectCommandsDir?: string;
  /** 描述缓存目录 */
  cacheDir?: string;
}

// ============================================================================
// 命令来源
// ============================================================================

/**
 * 命令来源
 */
export type CommandSource = 'user' | 'project';

// ============================================================================
// 命令索引
// ============================================================================

/**
 * 命令索引
 */
export interface CommandIndex {
  /** 命令名称（文件名） */
  name: string;
  /** 命令路径 */
  path: string;
  /** 来源类型 */
  source: CommandSource;
  /** 简短描述（从 --help 第一行提取） */
  shortDescription: string;
  /** 最后获取描述时间 */
  lastFetched?: number;
}

// ============================================================================
// 扫描结果
// ============================================================================

/**
 * 来源统计
 */
export interface SourceStats {
  /** User 级别命令数 */
  userCount: number;
  /** Project 级别命令数 */
  projectCount: number;
}

/**
 * 扫描结果
 */
export interface ScanResult {
  /** 命令列表 */
  commands: CommandIndex[];
  /** 来源统计 */
  stats: SourceStats;
}

// ============================================================================
// 发现选项
// ============================================================================

/**
 * 发现选项
 */
export interface DiscoverOptions {
  /** glob 过滤模式 */
  pattern?: string;
  /** 来源过滤 */
  source?: CommandSource;
}

// ============================================================================
// 添加选项
// ============================================================================

/**
 * 添加命令选项
 */
export interface AddCommandOptions {
  /** 命令名称 */
  name: string;
  /** 目标路径或命令 */
  target: string;
  /** 来源类型 */
  source?: CommandSource;
  /** 功能描述（用于 Prompt 注入） */
  description?: string;
  /** 探索提示（用于 Prompt 注入） */
  tips?: string;
}

// ============================================================================
// 命令元信息（用于 Prompt 注入）
// ============================================================================

/**
 * 命令元信息（用于 Prompt 注入）
 */
export interface CommandMeta {
  /** 命令名称 */
  name: string;
  /** 功能描述 */
  description: string;
  /** 探索提示 */
  tips?: string;
  /** meta.md 文件路径 */
  filePath: string;
  /** 来源类型 */
  source: CommandSource;
}

// ============================================================================
// 移除选项
// ============================================================================

/**
 * 移除命令选项
 */
export interface RemoveCommandOptions {
  /** 命令名称 */
  name: string;
  /** 来源类型（可选，不指定则尝试两个目录） */
  source?: CommandSource;
}

// ============================================================================
// 执行结果
// ============================================================================

/**
 * 执行结果
 */
export interface ExecutionResult {
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number;
  /** 是否成功 */
  success: boolean;
}
