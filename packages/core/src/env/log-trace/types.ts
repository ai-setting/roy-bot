/**
 * @fileoverview Log & Trace Component 类型定义
 */

// ============================================================================
// Span Types
// ============================================================================

/**
 * Span 上下文
 */
export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

/**
 * Span 属性
 */
export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined | Record<string, unknown>;
}

/**
 * Span
 */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;

  name: string;
  kind: SpanKind;
  status: SpanStatus;

  startTime: number;
  endTime?: number;

  attributes: SpanAttributes;
  result?: unknown;
  error?: string;

  children?: Span[];
}

/**
 * Span 类型
 */
export enum SpanKind {
  CLIENT = "client",
  SERVER = "server",
  INTERNAL = "internal",
}

/**
 * Span 状态
 */
export enum SpanStatus {
  OK = "ok",
  ERROR = "error",
}

// ============================================================================
// Trace Info Types
// ============================================================================

/**
 * Trace 信息
 */
export interface TraceInfo {
  traceId: string;
  rootSpanName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  spanCount: number;
  status: "ok" | "error" | "mixed";
}

// ============================================================================
// SpanStorage Types
// ============================================================================

/**
 * SpanStorage 接口
 */
export interface SpanStorage {
  initialize(): Promise<void>;
  save(span: Span): void;
  saveBatch(spans: Span[]): void;
  findByTraceId(traceId: string): Span[];
  findBySpanId(spanId: string): Span | undefined;
  listTraces(limit?: number): TraceInfo[];
  deleteByTraceId(traceId: string): void;
  close(): void;
}

// ============================================================================
// TraceContext Types
// ============================================================================

/**
 * TraceContext 选项
 */
export interface TraceContextOptions {
  /** 追踪器实现类型 */
  impl?: "lightweight" | "opentelemetry";
}

/**
 * ITraceContext 接口
 */
export interface ITraceContext {
  /** 获取当前请求的 requestId */
  getRequestId(): string | undefined;
  
  /** 获取当前 Span 上下文 */
  getSpanContext(): SpanContext | undefined;
  
  /** 更新当前 Span 上下文（用于设置子 span 的 parentSpanId） */
  setSpanContext(spanContext: SpanContext): void;
  
  /** 在已存在的追踪上下文中执行函数 */
  runWithContext<T>(fn: () => T): T;
  
  /** 在新追踪上下文中执行函数（同步） */
  runWithNewContext<T>(requestId: string, sessionId: string | undefined, fn: () => T): T;
  
  /** 在已存在的追踪上下文中执行异步函数 */
  runWithContextAsync<T>(fn: () => Promise<T>): Promise<T>;
  
  /** 在新追踪上下文中执行函数（异步） */
  runWithNewContextAsync<T>(requestId: string, sessionId: string | undefined, fn: () => Promise<T>): Promise<T>;
  
  /** 生成新的 requestId */
  generateRequestId(): string;
  
  /** 初始化追踪上下文（请求入口调用） */
  initContext(requestId: string, sessionId?: string): void;

  /** 创建并进入新的追踪上下文（请求入口使用，返回清理函数） */
  startNewContext(requestId: string, sessionId?: string): () => void;
}

// ============================================================================
// Logger Types
// ============================================================================

/**
 * 日志级别
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Logger 配置
 */
export interface LoggerConfig {
  level?: LogLevel;
  prefix?: string;
  filename?: string;
}

/**
 * Logger 接口
 */
export interface ILogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}
