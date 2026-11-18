/**
 * @fileoverview Hook 系统统一类型定义
 * 
 * 提供所有 Component 使用的统一 Hook 接口
 */

/**
 * Hook 执行阶段
 */
export type HookPhase = "before" | "after" | "error";

/**
 * Hook 元信息
 */
export interface HookMeta {
  /** Hook 唯一名称 */
  name: string;
  /** 执行优先级，默认 0，数值越小越先执行 */
  priority?: number;
  /** 描述 */
  description?: string;
  /** Plugin 名称（EventSource 加载的 plugin） */
  pluginName?: string;
  /** 事件源 ID（EventSource 加载的 plugin） */
  sourceId?: string;
}

/**
 * 统一 Hook 上下文
 * 
 * 泛型参数 T 表示该 Component 的上下文数据类型
 */
export interface HookContext<T = unknown> {
  /** 当前组件信息 */
  component: {
    /** 组件名称 */
    name: string;
    /** 组件版本 */
    version: string;
  };
  /** 上下文数据（Component 特定） */
  data: T;
  /** 元数据（可用于传递额外信息） */
  metadata: Record<string, unknown>;
  /** 执行阶段 */
  phase: HookPhase;
  /** 关联的 hook 点名称 */
  hookPoint: string;
}

/**
 * 统一 Hook 接口
 * 
 * 所有 Component 的 Hook 都应实现此接口
 */
export interface Hook<T = unknown> extends HookMeta {
  /** 执行 Hook
   * @param ctx 上下文
   */
  execute(ctx: HookContext<T>): void | Promise<void>;
}

/**
 * Hook 函数类型（便捷别名）
 */
export type HookFn<T = unknown> = (ctx: HookContext<T>) => void | Promise<void>;

// ========================================================================
// Hook 干预机制
// ========================================================================

/**
 * Hook 干预动作类型
 */
export type HookActionType =
  | "stop"          // 停止执行
  | "retry"         // 重试
  | "compress"      // 压缩上下文
  | "extract_memory" // 提取记忆
  | "inject_message" // 注入消息
  | "skip_tool"     // 跳过工具调用
  | "custom";       // 自定义动作

/**
 * Hook 干预动作
 */
export interface HookAction {
  /** 动作类型 */
  type: HookActionType;
  /** 动作参数 */
  params?: Record<string, unknown>;
  /** 动作描述 */
  description?: string;
}

/**
 * Hook 执行结果
 */
export interface HookResult {
  /** 是否被停止 */
  stopped?: boolean;
  /** 干预动作（如果有） */
  action?: HookAction;
  /** 执行结果数据 */
  results?: unknown[];
}

/**
 * 创建 Hook 的工厂函数
 * 
 * @param meta Hook 元信息
 * @param fn 执行函数
 * @returns Hook 实例
 * 
 * @example
 * ```typescript
 * const hook = createHook(
 *   { name: "my-hook", priority: 10 },
 *   async (ctx) => { console.log(ctx.data); }
 * );
 * ```
 */
export function createHook<T = unknown>(
  meta: HookMeta,
  fn: HookFn<T>
): Hook<T> {
  return {
    ...meta,
    execute: fn,
  };
}

/**
 * 创建带优先级的 Hook 的便捷函数
 */
export function createPriorityHook<T = unknown>(
  name: string,
  fn: HookFn<T>,
  priority: number
): Hook<T> {
  return createHook({ name, priority }, fn);
}
