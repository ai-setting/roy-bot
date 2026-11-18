/**
 * @fileoverview Propagation Env Module
 * 
 * 提供便捷的环境变量注入功能，用于在子进程执行时传递 trace context。
 * 
 * @example
 * ```typescript
 * import { injectToEnv, injectToEnvWithContext } from './propagation-env';
 * 
 * // 在 Bash 工具中执行子进程前：
 * const traceEnv = injectToEnv();  // 从当前 OTelTracerProvider 获取并注入
 * const options = {
 *   env: { ...process.env, ...traceEnv, ...env },
 * };
 * spawn(command, args, options);
 * ```
 */

import type { SpanContext } from "../types";
import { propagation } from "./propagation";
import { getTracerProvider } from "./tracer-provider";

// ============================================================================
// Types
// ============================================================================

/**
 * 环境变量对象类型
 */
export type EnvCarrier = Record<string, string | undefined>;

// ============================================================================
// Core Functions
// ============================================================================

/**
 * 从当前 OTelTracerProvider 获取上下文并注入到环境变量
 * 
 * 这是一个便捷函数，封装了常见的注入模式：
 * 1. 从全局 TracerProvider 获取当前 Tracer
 * 2. 获取当前 span context
 * 3. 注入到目标环境变量
 * 
 * @param env 目标环境变量对象（默认：{}）
 * @returns 注入了 TRACEPARENT 的环境变量对象
 * 
 * @example
 * ```typescript
 * const env = injectToEnv({ PATH: '/usr/bin' });
 * // env.TRACEPARENT = '00-{traceId}-{spanId}-01'
 * // env.PATH = '/usr/bin'
 * ```
 */
export function injectToEnv(env: EnvCarrier = {}): EnvCarrier {
  const provider = getTracerProvider();
  
  // 如果 provider 未初始化，尝试获取 tracer（可能会自动初始化）
  const tracer = provider.getTracer('roy-tracer');
  
  tracer.injectToEnv(env);
  
  return env;
}

/**
 * 将指定的 SpanContext 直接注入到环境变量
 * 
 * 与 injectToEnv 不同，这个函数不需要访问全局 TracerProvider，
 * 直接使用传入的 SpanContext 进行注入。
 * 
 * @param env 目标环境变量对象
 * @param context 要注入的 SpanContext
 * @returns 注入了 TRACEPARENT 的环境变量对象
 * 
 * @example
 * ```typescript
 * const span = tracer.startSpan('my-span');
 * const env = injectToEnvWithContext({}, span.spanContext);
 * ```
 */
export function injectToEnvWithContext(env: EnvCarrier, context: SpanContext): EnvCarrier {
  propagation.inject(env, context);
  return env;
}

/**
 * 从源环境变量 carrier 复制 TRACEPARENT 到目标 carrier
 * 
 * 用于将一个环境变量对象中的 trace context 传递到另一个：
 * - 从 process.env 复制到子进程的环境变量
 * - 从父进程环境变量复制到子进程环境变量
 * 
 * @param target 目标 carrier（将被修改）
 * @param source 源 carrier
 * @returns 目标 carrier
 * 
 * @example
 * ```typescript
 * // 在 fork 子进程时继承父进程的 trace context
 * const childEnv = injectToEnvFromCarrier({}, process.env);
 * ```
 */
export function injectToEnvFromCarrier(target: EnvCarrier, source: EnvCarrier): EnvCarrier {
  const extracted = propagation.extract(source);
  
  if (extracted) {
    // 将提取的上下文重新注入到目标
    // ExtractedContext 包含发送方的 traceId 和 spanId
    // 需要构造新的 SpanContext 用于传播
    const context: SpanContext = {
      traceId: extracted.traceId,
      spanId: extracted.spanId, // 使用发送方的 spanId
      parentSpanId: undefined, // 新的 span 将作为根 span（但会继承 traceId）
    };
    propagation.inject(target, context);
  }
  
  return target;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * 获取 TRACEPARENT 字段名
 */
export function getTraceparentHeader(): string {
  return propagation.getTraceparentHeader();
}

// ============================================================================
// Re-exports
// ============================================================================

export type { SpanContext } from "../types";
