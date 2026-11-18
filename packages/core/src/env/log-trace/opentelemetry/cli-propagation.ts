/**
 * @fileoverview CLI Propagation 模块
 * 
 * 提供 CLI 启动时从环境变量提取 trace context 的功能：
 * - 从 TRACEPARENT 环境变量提取父 span context
 * - 支持 W3C TraceContext 格式
 * 
 * 使用场景：
 * - Workflow CLI 启动时从父进程传递 trace context
 * - 子进程能够关联到主进程的 trace
 */

import { propagation, type ExtractedContext } from './propagation';
import type { SpanContext } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * CLI 传播选项
 */
export interface CliPropagationOptions {
  /** 是否静默模式（不输出日志） */
  silent?: boolean;
  /** 自定义 carrier（默认从 process.env 读取） */
  carrier?: Record<string, string | undefined>;
}

/**
 * 提取结果
 */
export interface ExtractResult {
  /** 提取的 traceId */
  traceId: string;
  /** 父 spanId（新 span 的 parentSpanId） */
  parentSpanId: string;
  /** 原始的 traceparent 字符串 */
  rawTraceparent: string;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * 从环境变量提取 trace context
 * 
 * @param options 传播选项
 * @returns 提取结果，如果不存在则返回 undefined
 */
export function extractFromEnv(options?: CliPropagationOptions): ExtractResult | undefined {
  const carrier = options?.carrier || process.env;
  const traceparent = carrier.TRACEPARENT;
  
  if (!traceparent) {
    if (!options?.silent) {
      console.debug('[cli-propagation] No TRACEPARENT in environment');
    }
    return undefined;
  }
  
  const extracted = propagation.extract(carrier as Record<string, string | undefined>);
  if (!extracted) {
    if (!options?.silent) {
      console.debug('[cli-propagation] Invalid TRACEPARENT format:', traceparent);
    }
    return undefined;
  }
  
  return {
    traceId: extracted.traceId,
    parentSpanId: extracted.spanId, // spanId is sender's spanId, use as parentSpanId
    rawTraceparent: traceparent,
  };
}

/**
 * 从提取结果构建 SpanContext
 * 
 * 用于初始化 OTelTracerProvider 时构建传入的上下文
 * 
 * @param extracted 提取结果
 * @returns 适用于初始化 provider 的 SpanContext
 */
export function buildSpanContextFromExtracted(extracted: ExtractResult): SpanContext {
  return {
    traceId: extracted.traceId,
    // spanId 在创建第一个 span 时由 provider 生成
    // 这里设置为 undefined，让 provider 生成新的
    spanId: extracted.parentSpanId, // 复用 parentSpanId 作为当前 spanId
    parentSpanId: undefined, // 根 span 没有父
  };
}

/**
 * 从提取结果构建完整 SpanContext（包含占位 spanId）
 * 
 * 用于初始化 OTelTracerProvider 的 tracer.currentContext
 * 
 * @param extracted 提取结果
 * @returns SpanContext，其中 spanId 待 provider 生成新值
 */
export function buildInitialSpanContext(extracted: ExtractResult): SpanContext {
  return {
    traceId: extracted.traceId,
    // 使用 parentSpanId 作为当前 spanId 占位
    // OTelTracerImpl.startSpan 会生成新的 spanId
    spanId: extracted.parentSpanId,
    parentSpanId: undefined,
  };
}

// ============================================================================
// CLI Initialization
// ============================================================================

/**
 * CLI 初始化追踪器
 * 
 * 从环境变量提取 trace context 并初始化 OTelTracerProvider
 * 
 * 使用场景：
 * ```typescript
 * // 在 CLI 启动时调用
 * import { initTracerFromEnv } from './opentelemetry/cli-propagation';
 * import { getTracerProvider } from './opentelemetry/tracer-provider';
 * 
 * async function main() {
 *   const provider = getTracerProvider();
 *   await provider.initialize();
 *   
 *   // 尝试从环境变量恢复上下文
 *   initTracerFromEnv(provider);
 *   
 *   // 继续正常执行...
 * }
 * ```
 * 
 * @param provider OTelTracerProvider 实例
 * @param options 传播选项
 */
export function initTracerFromEnv(
  provider: { getTracer: (name: string) => { setCurrentContext: (ctx: SpanContext | undefined) => void } },
  options?: CliPropagationOptions
): void {
  const extracted = extractFromEnv(options);
  
  if (!extracted) {
    if (!options?.silent) {
      console.debug('[cli-propagation] No trace context found in environment');
    }
    return;
  }
  
  if (!options?.silent) {
    console.debug('[cli-propagation] Restored trace context:', {
      traceId: extracted.traceId,
      parentSpanId: extracted.parentSpanId,
    });
  }
  
  // 构建 SpanContext 并设置到 tracer
  const spanContext = buildInitialSpanContext(extracted);
  const tracer = provider.getTracer('roy-tracer');
  tracer.setCurrentContext(spanContext);
}

/**
 * 检查是否存在 trace context
 * 
 * @returns 是否存在有效的 trace context
 */
export function hasTraceContext(): boolean {
  return extractFromEnv({ silent: true }) !== undefined;
}

/**
 * 获取当前 traceId（如果存在）
 * 
 * @returns traceId 或 undefined
 */
export function getTraceId(): string | undefined {
  return extractFromEnv({ silent: true })?.traceId;
}

/**
 * 获取当前 parentSpanId（如果存在）
 * 
 * @returns parentSpanId 或 undefined
 */
export function getParentSpanId(): string | undefined {
  return extractFromEnv({ silent: true })?.parentSpanId;
}
