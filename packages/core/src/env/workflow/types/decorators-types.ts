/**
 * @fileoverview Workflow Decorators - Type Definitions
 * 
 * 定义 @Workflow、@NodeAs、@Edge 装饰器相关的类型
 * 
 * 注意: RetryConfig 和 WorkflowConfig 已迁移到 ../types.ts
 */

// Re-export shared types
export type { RetryConfig } from '../types';

// Re-export WorkflowConfig (保持兼容性)
export { type WorkflowConfig } from '../types';

// ==================== @Workflow 选项 ====================

/**
 * @Workflow 装饰器选项
 */
export interface WorkflowOptions {
  /** Workflow 名称 */
  name: string;
  /** 版本号，默认 "1.0" */
  version?: string;
  /** 描述 */
  description?: string;
  /** 入口节点 ID */
  entry?: string | string[];
  /** 全局配置 */
  config?: {
    parallel_limit?: number | null;
    timeout?: number | null;
    retry?: {
      max_attempts: number;
      backoff: 'fixed' | 'exponential';
      initial_delay: number;
    };
    debug?: boolean;
  };
  /** 标签 */
  tags?: string[];
  /** 作者 */
  author?: string;
}

// ==================== @NodeAs 选项 ====================

/**
 * @NodeAs 装饰器选项
 */
export interface NodeAsOptions {
  /** 节点 ID，默认使用方法名 */
  nodeId?: string;
  /** 节点类型 */
  nodeType?: 'tool' | 'skill' | 'agent' | 'workflow';
  /** 显示名称 */
  name?: string;
  /** 依赖的节点 ID 列表 */
  dependsOn?: string | string[];
  /** 执行条件 */
  condition?: string;
  /** 重试配置 */
  retry?: {
    max_attempts: number;
    backoff: 'fixed' | 'exponential';
    initial_delay: number;
  };
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 节点配置 */
  config?: Record<string, unknown>;
}

// ==================== @Edge 选项 ====================

/**
 * @Edge 装饰器选项
 */
export interface EdgeOptions {
  from: string;
  to: string;
  /** 条件表达式 */
  condition?: string;
}

// ==================== 元数据类型 ====================

/**
 * Workflow 元数据（存储在类的 Reflect Metadata 中）
 */
export interface WorkflowMetadata {
  name: string;
  version: string;
  description?: string;
  entry?: string | string[];
  config?: {
    parallel_limit?: number | null;
    timeout?: number | null;
    retry?: {
      max_attempts: number;
      backoff: 'fixed' | 'exponential';
      initial_delay: number;
    };
    debug?: boolean;
  };
  tags?: string[];
  author?: string;
  /** 类实例引用 */
  instance?: any;
}

/**
 * Node 元数据（存储在类的 Reflect Metadata 中）
 */
export interface NodeMetadata {
  nodeId: string;
  nodeType: string;
  name?: string;
  dependsOn: string[];
  condition?: string;
  retry?: {
    max_attempts: number;
    backoff: 'fixed' | 'exponential';
    initial_delay: number;
  };
  timeout?: number;
  config: Record<string, unknown>;
  methodName: string;
  method: Function;
}

/**
 * Edge 元数据（存储在类的 Reflect Metadata 中）
 */
export interface EdgeMetadata {
  from: string;
  to: string;
  condition?: string;
}

// ==================== 验证结果类型 ====================

/**
 * Workflow 验证结果
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ==================== 转换为标准 Workflow 类型 ====================

/**
 * 转换为 workflow 包中的 NodeDefinition
 * 这是最终输出给 WorkflowEngine 使用的格式
 */
export interface ConvertedNodeDefinition {
  id: string;
  type: string;
  name?: string;
  config: Record<string, unknown>;
  depends_on: string[];
  condition?: string;
  retry?: {
    max_attempts: number;
    backoff: 'fixed' | 'exponential';
    initial_delay: number;
  };
  timeout?: number;
}

/**
 * 转换为标准的 WorkflowDefinition
 * 这是最终输出给 WorkflowEngine 使用的格式
 */
export interface ConvertedWorkflowDefinition {
  name: string;
  version: string;
  description?: string;
  config: {
    parallel_limit?: number | null;
    timeout?: number | null;
    retry?: {
      max_attempts: number;
      backoff: 'fixed' | 'exponential';
      initial_delay: number;
    };
    debug?: boolean;
  };
  nodes: ConvertedNodeDefinition[];
  edges?: Array<{ from: string; to: string; when?: string }>;
  entry: string | string[];
  outputs: Array<{ name: string; source: string; path: string }>;
  metadata: {
    tags?: string[];
    author?: string;
  };
}
