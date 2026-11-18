/**
 * @fileoverview W3C TraceContext Propagation
 * 
 * 实现 W3C Trace Context 标准中的 traceparent 格式：
 * https://www.w3.org/TR/trace-context/#traceparent-header
 * 
 * 格式: 00-{traceId}-{parentSpanId}-{flags}
 * - version: 2字符，固定 "00"
 * - traceId: 32字符，128位追踪ID
 * - parentSpanId: 16字符，64位父Span ID
 * - flags: 2字符，采样标志（当前固定 "01"）
 */

import type { SpanContext } from "../types";

// ============================================================================
// Constants
// ============================================================================

/** W3C TraceContext 版本号 */
const TRACE_CONTEXT_VERSION = "00";

/** 采样标志（01 = sampled） */
const TRACE_FLAGS_SAMPLED = "01";

/** traceparent 字段名 */
const TRACEPARENT_HEADER = "TRACEPARENT";

/** 版本号长度 */
const VERSION_LENGTH = 2;

/** traceId 长度 */
const TRACE_ID_LENGTH = 32;

/** parentSpanId 长度 */
const PARENT_SPAN_ID_LENGTH = 16;

/** flags 长度 */
const FLAGS_LENGTH = 2;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * 左补零到指定长度
 */
function padLeft(str: string, length: number): string {
  return str.padStart(length, "0");
}

/**
 * 验证是否为有效的十六进制字符串
 */
function isValidHex(str: string): boolean {
  return /^[0-9a-f]+$/i.test(str);
}

// ============================================================================
// Serialization (SpanContext -> traceparent)
// ============================================================================

/**
 * 将 SpanContext 序列化为 traceparent 字符串
 * 
 * W3C TraceContext 语义：
 * - traceparent 中的 spanId 是"发送方 span"的 ID
 * - 接收方会将其作为新 span 的 parentSpanId
 * - 所以应该使用 context.spanId，而非 parentSpanId
 * 
 * @param context SpanContext
 * @returns traceparent 格式字符串
 */
export function serialize(context: SpanContext): string {
  const traceId = padLeft(context.traceId.toLowerCase(), TRACE_ID_LENGTH);
  const spanId = padLeft(context.spanId.toLowerCase(), PARENT_SPAN_ID_LENGTH);

  // 格式: 00-{traceId}-{spanId}-{flags}
  // 注意：使用 spanId 而非 parentSpanId，因为这是发送方 span 的 ID
  const parts = [
    TRACE_CONTEXT_VERSION,
    traceId,
    spanId,
    TRACE_FLAGS_SAMPLED,
  ];

  return parts.join("-");
}

// ============================================================================
// Deserialization (traceparent -> SpanContext)
// ============================================================================

/**
 * 提取的 Trace Context
 * 
 * W3C TraceContext 格式: 00-{traceId}-{spanId}-{flags}
 * - {spanId} 是发送方 span 的 ID
 * - 接收方应将其作为新 span 的 parentSpanId
 */
export interface ExtractedContext {
  traceId: string;
  /** 发送方 span 的 ID，接收方应作为新 span 的 parentSpanId */
  spanId: string;
}

/**
 * 将 traceparent 字符串反序列化为 ExtractedContext
 * 
 * W3C TraceContext 语义：
 * - traceparent 中的 "span-id" 是发送方 span 的 ID
 * - 接收方应该：
 *   - 使用提取的 traceId
 *   - 将提取的 spanId 作为 parentSpanId
 *   - 生成自己的新 spanId
 * 
 * @param traceparent traceparent 格式字符串
 * @returns 接收方 ExtractedContext 或 undefined（格式无效）
 */
export function parse(traceparent: string): ExtractedContext | undefined {
  if (!traceparent || typeof traceparent !== "string") {
    return undefined;
  }

  const trimmed = traceparent.trim();
  const parts = trimmed.split("-");

  // 必须有 4 个部分
  if (parts.length !== 4) {
    return undefined;
  }

  const [version, traceId, senderSpanId, flags] = parts;

  // 验证版本（当前只支持 "00"）
  if (version !== TRACE_CONTEXT_VERSION) {
    // 未来版本兼容：对于 "ff" 及以上的未来版本，忽略
    if (version > TRACE_CONTEXT_VERSION) {
      return undefined;
    }
  }

  // 验证 traceId 长度和格式
  if (traceId.length !== TRACE_ID_LENGTH || !isValidHex(traceId)) {
    return undefined;
  }

  // 验证 spanId 长度和格式（W3C 标准中叫 span-id，但这是发送方 span 的 ID）
  if (senderSpanId.length !== PARENT_SPAN_ID_LENGTH || !isValidHex(senderSpanId)) {
    return undefined;
  }

  // 验证 flags 长度（当前忽略 flags 值，只验证格式）
  if (flags.length !== FLAGS_LENGTH || !isValidHex(flags)) {
    return undefined;
  }

  // 返回提取的上下文
  // - traceId: 保持不变
  // - spanId: 发送方 span 的 ID（接收方应作为新 span 的 parentSpanId）
  return {
    traceId: traceId.toLowerCase(),
    spanId: senderSpanId.toLowerCase(),
  };
}

// ============================================================================
// Propagation Interface
// ============================================================================

/**
 * W3C TraceContext Propagation 实现
 * 
 * 用于在进程间传递 trace 上下文：
 * - inject: 将 SpanContext 注入到 carrier（环境变量）
 * - extract: 从 carrier（环境变量）提取 SpanContext
 */
export const propagation = {
  /**
   * 将 SpanContext 注入到 carrier
   * 
   * @param carrier 载体对象（通常是环境变量对象）
   * @param context Span 上下文
   */
  inject(carrier: Record<string, string | undefined>, context: SpanContext): void {
    carrier[TRACEPARENT_HEADER] = serialize(context);
  },

  /**
   * 从 carrier 提取 SpanContext
   * 
   * @param carrier 载体对象（通常是环境变量对象）
   * @returns ExtractedContext 或 undefined
   */
  extract(carrier: Record<string, string | undefined>): ExtractedContext | undefined {
    const traceparent = carrier[TRACEPARENT_HEADER];
    if (!traceparent) {
      return undefined;
    }
    return parse(traceparent);
  },

  /**
   * 获取 traceparent 字段名
   */
  getTraceparentHeader(): string {
    return TRACEPARENT_HEADER;
  },
};

// ============================================================================
// Type Exports
// ============================================================================

export type { SpanContext } from "../types";
