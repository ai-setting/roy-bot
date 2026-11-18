/**
 * @fileoverview OpenTelemetry TracerProvider 实现
 * 
 * 提供 OpenTelemetry 风格的追踪能力：
 * - TracerProvider: 全局 Tracer 管理器
 * - OTelTracer: 具体 Tracer 实现
 * - OTelSpan: Span 实现
 * 
 * 支持 W3C TraceContext 格式的跨进程上下文传递
 */

import { AsyncLocalStorage } from "async_hooks";
import type { SpanContext, SpanAttributes } from "../types";
import { SQLiteSpanStorage, type SpanStorage } from "../span-storage";
import { propagation, type ExtractedContext } from "./propagation";
import { SpanStatus } from "../types";
import * as loggerModule from "../logger";

// Lazy logger: avoid module-init circular dependency between
// logger.ts and tracer-provider.ts (logger.ts calls getTracerProvider
// at format time). The logger is created on first use, after both
// modules have finished initializing.
type LoggerLike = ReturnType<typeof loggerModule.createLogger>;
let _otelLogger: LoggerLike | null = null;
function getOtelLogger(): LoggerLike {
  if (!_otelLogger) {
    _otelLogger = loggerModule.createLogger("otel-tracer");
  }
  return _otelLogger;
}

function isOtelTraceDebugEnabled(): boolean {
  return process.env.ROY_TRACE_DEBUG_OTEL === "1" || process.env.ROY_TRACE_DEBUG === "1";
}

function otelLog(message: string, ...args: unknown[]): void {
  getOtelLogger().info(message, ...args);
}

function otelLogWarn(message: string, ...args: unknown[]): void {
  getOtelLogger().warn(message, ...args);
}

function otelLogError(message: string, ...args: unknown[]): void {
  getOtelLogger().error(message, ...args);
}

// ============================================================================
// Types
// ============================================================================

/**
 * Span 选项
 */
export interface SpanOptions {
  /** 父 Span 上下文（可选） */
  parent?: SpanContext;
  /** Span 属性 */
  attributes?: SpanAttributes;
  /** Span 类型 */
  kind?: string;
  /** 指定 traceId（可选，如果不提供则自动生成） */
  traceId?: string;
  /**
   * 直接传入完整的 SpanContext（可选）
   * 如果提供，将使用此 context 而忽略 parent 和 traceId 选项
   * 用于从外部（如 ES 事件）注入已构建的 context
   */
  context?: SpanContext;
}

/**
 * OTel Span 接口
 */
export interface OTelSpan {
  readonly name: string;
  readonly kind: string;
  readonly spanContext: SpanContext;
  readonly attributes: SpanAttributes;
  startTime?: number;
  endTime?: number;
  error?: string;

  setAttribute(key: string, value: unknown): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  end(result?: unknown, error?: Error): void;
}

/**
 * 结束 span 并返回清理函数（用于恢复父上下文）
 */
export interface OTelSpanEndResult {
  /** 结束后的父上下文 */
  parentContext?: SpanContext;
  /** traceId（用于显示） */
  traceId: string;
}

/**
 * OTel Span 接口扩展 - 提供 endSpan 方法
 */
export interface OTelSpanWithEndSpan extends OTelSpan {
  /**
   * 结束 span 并返回父上下文
   * 用于结束根 span 后恢复之前的上下文
   */
  endSpan(): OTelSpanEndResult;
}

/**
 * Span 结束时的回调函数类型
 */
type SpanEndCallback = (spanId: string, parentSpanId?: string) => void;

/**
 * OTel Tracer 接口
 */
export interface OTelTracer {
  readonly name: string;
  readonly version?: string;
  
  startSpan(name: string, options?: SpanOptions): OTelSpan;
  /**
   * 结束指定 span 并恢复父上下文
   * @param span 要结束的 span
   * @returns 结束后的父上下文（用于恢复之前的上下文）
   */
  endSpan(span: OTelSpan): SpanContext | undefined;
  injectToEnv(env: Record<string, string | undefined>): void;
  getCurrentContext(): SpanContext | undefined;
  setCurrentContext(context: SpanContext | undefined): void;
  
  /**
   * 生成符合 OTel 格式的 traceId（32 字符 16 进制）
   */
  generateTraceId(): string;
  
  /**
   * 生成符合 OTel 格式的 spanId（16 字符 16 进制）
   */
  generateSpanId(): string;
}

// ============================================================================
// Span Implementation
// ============================================================================

/**
 * OTel Span 实现
 */
class OTelSpanImpl implements OTelSpan {
  readonly name: string;
  readonly kind: string;
  readonly spanContext: SpanContext;
  readonly attributes: SpanAttributes = {};
  startTime?: number;
  endTime?: number;
  error?: string;
  
  private storage: SpanStorage;
  private parentSpanContext?: SpanContext;
  private onEnd?: () => void;

  constructor(
    name: string,
    spanContext: SpanContext,
    storage: SpanStorage,
    parentSpanContext?: SpanContext,
    onEnd?: () => void
  ) {
    this.name = name;
    this.kind = "internal";
    this.spanContext = spanContext;
    this.parentSpanContext = parentSpanContext;
    this.startTime = Date.now();
    this.storage = storage;
    this.onEnd = onEnd;
  }

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value as any;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    // 事件暂时存储在 attributes 中
    const events = (this.attributes as any)._events as Array<{ name: string; attributes?: Record<string, unknown> }> || [];
    events.push({ name, attributes });
    (this.attributes as any)._events = events;
  }

  end(result?: unknown, error?: Error): void {
    this.endTime = Date.now();
    if (error) {
      this.error = error.message;
    }

    const duration = this.endTime - (this.startTime || 0);
    if (isOtelTraceDebugEnabled()) {
      otelLog(
        `[OTelSpan] Ending span: name="${this.name}" traceId=${this.spanContext.traceId} spanId=${this.spanContext.spanId} duration=${duration}ms status=${error ? "ERROR" : "OK"}`
      );
    }

    // 保存到存储
    // 如果 storage 为空，尝试重新获取（解决插件初始化时 storage 未就绪的问题）
    let storage = this.storage;
    if (!storage) {
      otelLogWarn(`[OTelSpan] storage is null for "${this.name}", attempting to re-fetch...`);
      const provider = getTracerProvider();
      storage = provider.getStorage();
    }

    if (storage) {
      // 检查 storage 是否已初始化（通过检查 db 是否就绪）
      // SQLiteSpanStorage 会在 initialize() 后设置 this.db
      const isInitialized = (storage as any).db || (storage as any).initialized;
      if (!isInitialized) {
        otelLogWarn(`[OTelSpan] storage not initialized for "${this.name}", initializing now...`);
        // 异步初始化（不阻塞 span 结束）
        storage.initialize().catch(err => {
          otelLogError(`[OTelSpan] Failed to initialize storage:`, err);
        });
      }
      storage.save({
        traceId: this.spanContext.traceId,
        spanId: this.spanContext.spanId,
        parentSpanId: this.spanContext.parentSpanId,
        name: this.name,
        kind: this.kind as any,
        status: error ? SpanStatus.ERROR : SpanStatus.OK,
        startTime: this.startTime!,
        endTime: this.endTime,
        attributes: this.attributes,
        result,
        error: this.error,
      });
    } else {
      otelLogError(`[OTelSpan] Failed to save span "${this.name}": storage still null after re-fetch`);
    }

    // 调用回调（用于上下文恢复等）
    this.onEnd?.();
  }
}

// ============================================================================
// Tracer Implementation
// ============================================================================

/**
 * OTel Tracer 实现
 */
class OTelTracerImpl implements OTelTracer {
  readonly name: string;
  readonly version?: string;
  
  private storage: SpanStorage;
  /**
   * ★ Task #4515 (H1): `currentContext` 不再是实例字段，改为**访问器对**，
   * 存到 Provider 的 ALS 作用域里（每次 run 一张 `instanceId → context` 表）。
   *
   * 为什么：原来的实例单槽优先级高于 `globalContext`，而生产所有调用点共用
   * `getTracer("roy-tracer")` 同一个实例 → 并发 run 共享 currentContext，
   * `withGlobalContext` 的 ALS 对它完全无效（H1 根因）。
   *
   * 用访问器而不是改所有读写点：本文件内 `this.currentContext` 的出现位置
   * （startSpan / endSpan / handleSpanEnd / injectToEnv / get/setCurrentContext）
   * 语义完全不变，只是落点变成了「当前 run 的 map」或「进程级 map」。
   */
  private get currentContext(): SpanContext | undefined {
    return this.provider.getTracerCurrentContext(this.instanceId);
  }
  private set currentContext(context: SpanContext | undefined) {
    this.provider.setTracerCurrentContext(this.instanceId, context);
  }

  private activeSpans: Map<string, OTelSpan> = new Map();
  private onSpanEndCallback?: SpanEndCallback;
  
  // 引用到 Provider，用于访问全局 context
  private provider: OTelTracerProvider;
  
  // 实例唯一标识
  public readonly instanceId: string;

  constructor(name: string, version: string | undefined, storage: SpanStorage, provider: OTelTracerProvider) {
    this.name = name;
    this.version = version;
    this.storage = storage;
    this.provider = provider;
    this.instanceId = `${name}@${provider.instanceId}`;
  }

  /**
   * 设置 span 结束时的回调
   */
  setOnSpanEndCallback(callback: SpanEndCallback): void {
    this.onSpanEndCallback = callback;
  }

  /**
   * 获取当前 tracer 的活跃 span 数量（用于调试）
   */
  getActiveSpanCount(): number {
    return this.activeSpans.size;
  }

  /**
   * 启动新 Span
   * 
   * parentSpanId 确定逻辑：
   * 1. 跨进程场景（options.parent 显式指定）：
   *    → options.parent.parentSpanId || options.parent.spanId
   * 2. 同进程嵌套（隐式继承 currentContext）：
   *    → currentContext.spanId（忽略 currentContext.parentSpanId）
   * 3. 无父上下文：parentSpanId = undefined
   * 
   * 关键：currentContext.parentSpanId 是当前 span 的父 span，不应该作为新 span 的父 span
   */
  startSpan(name: string, options?: SpanOptions): OTelSpan {
    // 优先级：
    // 1. options.context 显式传入（完整 SpanContext）：直接使用
    // 2. options.parent 显式传入（即使值是 undefined）
    // 3. 当前 tracer 的 currentContext
    // 4. Provider 全局 context（所有 tracer 共享）
    // 5. 自动生成新的 traceId
    const parentFromOptions = options?.parent;
    // 使用 'in' 操作符检查 parent 是否在 options 中被显式设置
    const hasExplicitParent = options && 'parent' in options;
    const hasExplicitContext = options && 'context' in options;
    const globalContext = this.provider.getGlobalContext();
    
    let effectiveParentContext: SpanContext | undefined;
    let traceId: string;
    let spanId: string;
    let parentSpanId: string | undefined;
    let spanContext: SpanContext;

    // 情况1: 直接注入完整 context（用于从外部注入已构建的 context）
    if (hasExplicitContext && options?.context) {
      const injectedContext = options.context;
      traceId = injectedContext.traceId;
      spanId = this.generateSpanId(); // 生成新的 spanId
      parentSpanId = injectedContext.spanId; // 新 span 的父 span 是注入 context 的 span
      
      spanContext = {
        traceId,
        spanId,
        parentSpanId,
      } as SpanContext;

      // 更新 currentContext
      this.currentContext = {
        traceId,
        spanId,
        parentSpanId,
      };

      const span = new OTelSpanImpl(
        name,
        spanContext,
        this.storage,
        injectedContext, // 传递注入的 context 作为父上下文
        () => this.handleSpanEnd(spanContext.spanId, injectedContext.spanId)
      );

      if (options?.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
          span.setAttribute(key, value);
        }
      }

      this.activeSpans.set(spanId, span);
      return span;
    }

    // 情况2-4: 正常逻辑（使用 parent、currentContext 或全局 context）
    if (hasExplicitParent) {
      effectiveParentContext = parentFromOptions;
    } else if (this.currentContext) {
      effectiveParentContext = this.currentContext;
    } else if (globalContext) {
      effectiveParentContext = globalContext;
    }
    
    traceId = effectiveParentContext?.traceId || this.generateTraceId();
    spanId = this.generateSpanId();
    
    // parentSpanId 确定：
    // 1. 显式 options.parent（跨进程场景）：优先用 parentSpanId
    // 2. 隐式继承 currentContext（同进程嵌套）：只用 effectiveParentContext.spanId
    // 3. 无父上下文：undefined
    if (hasExplicitParent && parentFromOptions) {
      // 跨进程场景：显式传递 parent
      parentSpanId = parentFromOptions.parentSpanId || parentFromOptions.spanId;
    } else if (this.currentContext) {
      // 同进程嵌套：继承 currentContext，忽略 currentContext.parentSpanId
      parentSpanId = this.currentContext.spanId;
    } else if (globalContext) {
      // 使用全局 context 作为 parent
      parentSpanId = globalContext.spanId;
    }

    // ⚠️ 关键：创建独立的 spanContext 对象，而不是修改现有对象
    // 因为 parent?.spanId 可能指向 currentContext.spanContext（span 的 spanContext）
    // 如果直接赋值，parentContext.spanContext.spanId 会被修改
    // 使用对象展开确保创建新对象
    spanContext = {
      traceId,
      spanId,
      parentSpanId,
    } as SpanContext;

    // ⚠️ 关键：在创建 Span 之前，先更新 currentContext
    // 这样子 span 获取 parent 时，currentContext 已经是当前 span 的上下文
    // 而不是被新 span 的上下文覆盖
    this.currentContext = {
      traceId,
      spanId,
      parentSpanId,
    };

    // 创建 Span，传递完整的父上下文（用于存储和上下文恢复）
    const span = new OTelSpanImpl(
      name,
      spanContext,
      this.storage,
      effectiveParentContext, // 传递完整父上下文
      () => this.handleSpanEnd(spanContext.spanId, effectiveParentContext?.spanId)
    );

    // 设置初始属性
    if (options?.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) {
        span.setAttribute(key, value);
      }
    }

    this.activeSpans.set(spanId, span);
    if (isOtelTraceDebugEnabled()) {
      otelLog(
        `[OTelTracer] ✓ Span created: name="${name}" traceId=${traceId} spanId=${spanId} parentSpanId=${parentSpanId || "-"}`
      );
    }

    return span;
  }

  /**
   * 将当前上下文注入到环境变量
   */
  injectToEnv(env: Record<string, string | undefined>): void {
    if (this.currentContext) {
      propagation.inject(env, this.currentContext);
    }
  }

  /**
   * 获取当前上下文
   */
  getCurrentContext(): SpanContext | undefined {
    return this.currentContext;
  }

  /**
   * 设置当前上下文（用于从外部恢复上下文）
   */
  setCurrentContext(context: SpanContext | undefined): void {
    this.currentContext = context;
  }

  /**
   * 查找栈中的上层 span
   * 
   * 在 span 结束时，如果当前 span 没有直接的父 span（parentSpanId=undefined），
   * 但可能有其他 span 以当前 span 为父。我们需要找到最近的"栈上层"span，
   * 使得上下文恢复后，后续 span 能正确继承 traceId。
   * 
   * 例如：
   * root (spanId=root, parentSpanId=undefined)
   *   child (spanId=child, parentSpanId=root)
   *     grandchild (spanId=grandchild, parentSpanId=child)
   * 
   * 如果 child 先结束，root 还在活跃，那么应该恢复 root 的上下文。
   * 
   * @param spanId 当前 span 的 ID
   * @returns 栈中最近的上层 span，如果没有则返回 undefined
   */
  private findStackParentSpan(spanId: string): OTelSpan | undefined {
    // 找到直接子 span（其 parentSpanId 指向传入的 spanId）
    for (const [, span] of this.activeSpans) {
      if (span.spanContext.parentSpanId === spanId) {
        return span;
      }
    }
    return undefined;
  }

  /**
   * 结束 Span 并恢复父上下文
   * 
   * 关键：需要正确恢复 parentSpanId，使得子 span 可以正确关联到父 span
   * 
   * 上下文恢复逻辑（优先级从高到低）：
   * 1. 如果有 parentSpanId 且父 span 在 activeSpans 中 → 恢复父上下文
   * 2. 如果有 parentSpanId 但父 span 不存在（跨进程） → 保留 traceId
   * 3. 如果没有 parentSpanId 但有栈上层 span → 恢复栈上层 span 的上下文
   * 4. 否则 → 清除上下文
   * 
   * @returns 结束后的父上下文（用于恢复之前的上下文）
   */
  endSpan(span: OTelSpan): SpanContext | undefined {
    const spanContext = span.spanContext;
    this.activeSpans.delete(spanContext.spanId);

    // 保存当前 span 的 traceId（如果存在）
    const currentTraceId = this.currentContext?.traceId;

    if (spanContext.parentSpanId) {
      // 尝试找到父 Span 并恢复其上下文
      const parentSpan = this.activeSpans.get(spanContext.parentSpanId);
      if (parentSpan) {
        // 正确恢复完整上下文：包含 parentSpanId（父 span 的 spanId）
        const parentContext: SpanContext = {
          traceId: spanContext.traceId,
          spanId: parentSpan.spanContext.spanId,
          parentSpanId: parentSpan.spanContext.parentSpanId,
        };
        this.currentContext = parentContext;
        return parentContext;
      }
      
      // 父 span 不存在（跨进程场景）
      // 保留 traceId，让后续 span 能继承，而不是创建新的根
      if (currentTraceId) {
        const parentContext: SpanContext = {
          traceId: currentTraceId,
          spanId: spanContext.parentSpanId,
          parentSpanId: undefined,
        };
        this.currentContext = parentContext;
        return parentContext;
      }
    }
    
    // 当前 span 没有 parentSpanId 或没有找到父 span
    // 尝试找到栈中的上层 span 并恢复其上下文
    const stackParentSpan = this.findStackParentSpan(spanContext.spanId);
    if (stackParentSpan) {
      const parentContext: SpanContext = {
        traceId: stackParentSpan.spanContext.traceId,
        spanId: stackParentSpan.spanContext.spanId,
        parentSpanId: stackParentSpan.spanContext.parentSpanId,
      };
      this.currentContext = parentContext;
      return parentContext;
    }
    
    // 没有任何活跃 span，清除上下文
    this.currentContext = undefined;
    return undefined;
  }

  generateTraceId(): string {
    // 生成 32 字符的十六进制 traceId (128 位)
    const timestamp = Date.now().toString(16).padStart(12, "0");
    const random = Array.from({ length: 5 }, () => 
      Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, "0")
    ).join("");
    return (timestamp + random).slice(0, 32).padStart(32, "0");
  }

  generateSpanId(): string {
    // 生成 16 字符的十六进制 spanId (64 位)
    return Math.floor(Math.random() * 0xFFFFFFFFFFFFFFFF)
      .toString(16)
      .padStart(16, "0");
  }

  /**
   * 处理 span 结束
   * 
   * 当 span 结束时，尝试恢复父 span 的上下文。
   * 使用与 endSpan 相同的逻辑：
   * 1. 如果有 parentSpanId 且父 span 在 activeSpans 中 → 恢复父上下文
   * 2. 如果有 parentSpanId 但父 span 不存在（跨进程） → 保留 traceId
   * 3. 如果没有 parentSpanId 但有栈上层 span → 恢复栈上层 span 的上下文
   * 4. 否则 → 清除上下文
   */
  private handleSpanEnd(spanId: string, parentSpanId?: string): void {
    // ⚠️ 先把自己从 activeSpans 中移除，防止 findStackParentSpan 找到已结束的 span
    // 注意：span.end() 直接调用时不会调用 tracer.endSpan()，所以 activeSpans.delete() 需要在这里执行
    this.activeSpans.delete(spanId);

    if (parentSpanId) {
      const parentSpan = this.activeSpans.get(parentSpanId);
      if (parentSpan) {
        this.currentContext = {
          traceId: parentSpan.spanContext.traceId,
          spanId: parentSpan.spanContext.spanId,
          parentSpanId: parentSpan.spanContext.parentSpanId,
        };
        return;
      }
      // 父 span 不存在，保留 traceId
      if (this.currentContext?.traceId) {
        this.currentContext = {
          traceId: this.currentContext.traceId,
          spanId: parentSpanId,
          parentSpanId: undefined,
        };
        return;
      }
    }
    
    // 当前 span 没有 parentSpanId 或没有找到父 span
    // 尝试找到栈中的上层 span 并恢复其上下文
    const stackParentSpan = this.findStackParentSpan(spanId);
    if (stackParentSpan) {
      this.currentContext = {
        traceId: stackParentSpan.spanContext.traceId,
        spanId: stackParentSpan.spanContext.spanId,
        parentSpanId: stackParentSpan.spanContext.parentSpanId,
      };
      return;
    }
    
    this.currentContext = undefined;
  }
}

// ============================================================================
// TracerProvider Implementation
// ============================================================================

/**
 * OpenTelemetry TracerProvider
 * 
 * 全局 Tracer 管理器，负责：
 * - 维护 Tracer 缓存
 * - 管理存储
 * - 处理上下文初始化
 * - 提供全局 context 供所有 tracer 共享
 */
export class OTelTracerProvider {
  private tracers: Map<string, OTelTracerImpl> = new Map();
  private storage: SpanStorage;
  private initialized = false;
  
  // 全局 context - 所有 tracer 共享
  // 用于在不同的 tracer 实例之间传递 traceId
  private globalContext: SpanContext | undefined;

  /**
   * ★ Task #4486 Phase 3: per-run trace context 作用域（AsyncLocalStorage）。
   *
   * 为什么需要：`globalContext` 是进程级单槽。并发多 session 时
   *   - run B 的 startSpan() 会继承 run A 刚设的 traceId（串 trace）
   *   - run A 收尾 setGlobalContext(undefined) 会把 run B 的父上下文清掉
   *
   * `withGlobalContext(ctx, fn)` 在异步链内覆盖读值（链外仍回落进程级单槽，
   * 完全向后兼容既有调用方）。
   *
   * 用 `{ value }` 包装而不是直接存 SpanContext：需要区分
   * "链内显式设为 undefined"（屏蔽继承）与 "链内没设置"（回落进程级）。
   */
  private globalContextScope: AsyncLocalStorage<{ value: SpanContext | undefined }> =
    new AsyncLocalStorage();

  /**
   * ★ Task #4515 (H1): 进程级 tracer currentContext 表（ALS 作用域外使用）。
   *
   * `instanceId → SpanContext`。取代原来 `OTelTracerImpl` 的私有单槽字段。
   * 作用域外的读写在**同一个 map** 上做，所以既有的"同步链式嵌套"语义
   * （root → child 自动继承）完全不变。
   */
  private tracerContexts: Map<string, SpanContext | undefined> = new Map();

  /**
   * ★ Task #4515 (H1): 当前 ALS 作用域内的 tracer currentContext 表。
   *
   * `withGlobalContext()` 为每次 run 建一张**独立的 map**，所以并发 run 的
   * `startSpan()` / `span.end()` 各改各的槽，互不可见 —— 这是 H1 的根治点。
   */
  private tracerContextScope: AsyncLocalStorage<{
    contexts: Map<string, SpanContext | undefined>;
  }> = new AsyncLocalStorage();
  
  // 实例唯一标识
  public readonly instanceId: string;

  constructor(storage?: SpanStorage, dbPath?: string) {
    providerCounter++;
    this.instanceId = `Provider#${providerCounter}`;
    this.storage = storage || new SQLiteSpanStorage(dbPath || getDefaultDbPath());
  }

  /**
   * 初始化 Provider
   * 
   * 从环境变量恢复上下文（如 TRACEPARENT）
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.storage.initialize();
    this.initialized = true;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取当前 trace context。
   *
   * ★ Task #4486 Phase 3: 优先读 ALS 作用域（withGlobalContext 设置），
   * 没有作用域时回落进程级单槽（旧语义）。
   */
  getGlobalContext(): SpanContext | undefined {
    const scoped = this.globalContextScope.getStore();
    if (scoped) return scoped.value;
    return this.globalContext;
  }

  /**
   * 设置全局 context（所有 tracer 共享）
   *
   * ⚠️ 并发场景请优先用 `withGlobalContext()` —— 直接设置是进程级、
   * 会被其他并发 run 观察到，且单方 set(undefined) 会连带清掉别人的父上下文。
   */
  setGlobalContext(context: SpanContext | undefined): void {
    this.globalContext = context;
  }

  /**
   * ★ Task #4486 Phase 3: 在指定 trace context 作用域内执行异步函数。
   *
   * - 作用域内 `getGlobalContext()` 返回 `context`（即使传 undefined 也会
   *   屏蔽进程级单槽，即"本次 run 没有父 trace"）
   * - 作用域外不受影响，也不影响其他并发 run
   * - 嵌套调用以内层为准，退出后恢复外层
   *
   * @param context 本次 run 的 trace context（可为 undefined = 无父）
   * @param fn 要执行的异步函数
   */
  withGlobalContext<T>(
    context: SpanContext | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    // ★ Task #4515 (H1): 同时开一张**独立的** tracer currentContext 表。
    //   并发 run 各自拿到自己的 map，startSpan / span.end 不再互相踩。
    //   层内先查自己的 map；miss 时（例如作用域内首次 startSpan）从进程级表
    //   播种一个**快照**，保证"作用域建立前已有的父上下文"仍能被继承。
    const seeded = new Map(this.tracerContexts);
    return this.globalContextScope.run({ value: context }, () =>
      this.tracerContextScope.run({ contexts: seeded }, fn)
    );
  }

  /**
   * ★ Task #4515 (H1-c): 在指定 context 的**同步**作用域内执行 `fn`。
   *
   * 为什么要这个：`withGlobalContext` 只接受 async 函数，而 `span.end()` 是
   * 同步调用。如果 end() 在作用域外执行，`handleSpanEnd()` 会把恢复出的父上下文
   * 写进**进程级**表 —— 于是下一轮 run 的 ALS 播种快照会继承上一轮的 trace，
   * 表现为"下一轮复用了上一轮的 traceId"。
   *
   * 用这个把 end() 包回本 run 的作用域，写入就落在本 run 那张（随后丢弃的）表里。
   */
  runInGlobalContextSync<T>(context: SpanContext | undefined, fn: () => T): T {
    const seeded = new Map(this.tracerContexts);
    return this.globalContextScope.run({ value: context }, () =>
      this.tracerContextScope.run({ contexts: seeded }, fn)
    );
  }

  /**
   * ★ Task #4515 (H1): 读某 tracer 实例的 currentContext。
   *
   * 作用域内 → 读该 run 的 map（miss 回落进程级表，兼容作用域外设的上下文）；
   * 作用域外 → 读进程级表（旧语义）。
   */
  getTracerCurrentContext(instanceId: string): SpanContext | undefined {
    const scoped = this.tracerContextScope.getStore();
    if (scoped) {
      return scoped.contexts.get(instanceId);
    }
    return this.tracerContexts.get(instanceId);
  }

  /**
   * ★ Task #4515 (H1): 写某 tracer 实例的 currentContext。
   *
   * 作用域内 → 只写该 run 的 map（并发 run 互不可见）；
   * 作用域外 → 写进程级表（旧语义）。
   */
  setTracerCurrentContext(instanceId: string, context: SpanContext | undefined): void {
    const scoped = this.tracerContextScope.getStore();
    if (scoped) {
      scoped.contexts.set(instanceId, context);
      return;
    }
    this.tracerContexts.set(instanceId, context);
  }

  /**
   * ★ Task #4519: 清空**所有** tracer 实例的 currentContext（当前作用域内）。
   *
   * 为什么需要它、而不是逐个 `getTracer(name).setCurrentContext(undefined)`：
   * 按名字清只能清掉**已实例化**的那个 tracer。而 `tracerContexts` 表是
   * `instanceId → context`，此前其它名字的 tracer 若在进程级表里留了父上下文，
   * 它仍会被继承（交叉复核指出：只清 "roy-tracer" 清不干净）。
   * 这里直接清整表，保证**任何** tracer 名都不在事件之间串味。
   *
   * 作用域内 → 只清本 run 那张 map（不动进程级，并发 run 互不影响）；
   * 作用域外 → 清进程级表。
   */
  clearAllTracerCurrentContexts(): void {
    const scoped = this.tracerContextScope.getStore();
    if (scoped) {
      scoped.contexts.clear();
      return;
    }
    this.tracerContexts.clear();
  }

  /**
   * 获取 Tracer
   */
  getTracer(name: string, version?: string): OTelTracer {
    const key = `${name}@${version || "0.0.0"}`;
    
    let tracer = this.tracers.get(key);
    if (!tracer) {
      tracer = new OTelTracerImpl(name, version, this.storage, this);
      this.tracers.set(key, tracer);

      // 检查环境变量中是否有父上下文（仅在初始化后）
      if (this.initialized) {
        this.restoreFromEnv(tracer);
      }
    }

    return tracer;
  }

  /**
   * 从环境变量恢复上下文
   */
  private restoreFromEnv(tracer: OTelTracerImpl): void {
    const extracted = propagation.extract(process.env as Record<string, string | undefined>);
    if (extracted) {
      // 恢复上下文：设置 spanId 为发送方的 spanId，作为后续 span 的 parentSpanId
      tracer.setCurrentContext({
        traceId: extracted.traceId,
        spanId: extracted.spanId, // 发送方 span ID，用于后续 span 的 parentSpanId
        parentSpanId: undefined, // 根 span 没有父
      });
    }
  }

  /**
   * 关闭 Provider
   */
  shutdown(): void {
    for (const tracer of this.tracers.values()) {
      // 结束所有活跃的 span
    }
    this.tracers.clear();
    this.storage.close();
    this.initialized = false;
    // 清除全局 context，确保下次创建 tracer 时不会继承旧上下文
    this.globalContext = undefined;
    // 清除环境变量中的 trace context，避免影响后续测试
    delete process.env['TRACEPARENT'];
    delete process.env['TRACE_ID'];
    delete process.env['LOG_TRACE_REQUEST_ID'];
  }

  /**
   * 获取存储
   */
  getStorage(): SpanStorage {
    return this.storage;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let providerInstance: OTelTracerProvider | null = null;
let providerCounter = 0;

/**
 * 获取 TracerProvider 单例
 */
export function getTracerProvider(): OTelTracerProvider {
  if (!providerInstance) {
    providerInstance = new OTelTracerProvider();
  }
  return providerInstance;
}

/**
 * 重置 TracerProvider（用于测试）
 */
export function resetTracerProvider(): void {
  if (providerInstance) {
    providerInstance.shutdown();
    providerInstance = null;
  }
}

/**
 * 设置 TracerProvider 单例（用于测试中注入自定义 storage）
 *
 * Task #2580 (round 3) — 测试需要为 @TracedAs / wrapFunction 装饰的
 * 函数提供一个带 SQLite 存储的 TracerProvider，以验证 span 名称
 * 和 attributes。
 */
export function setTracerProvider(provider: OTelTracerProvider): void {
  if (providerInstance) {
    providerInstance.shutdown();
  }
  providerInstance = provider;
}

/**
 * 获取默认的 SQLite 数据库路径
 */
function getDefaultDbPath(): string {
  const os = require("os");
  const path = require("path");
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(dataHome, "roy-bot", "traces.db");
}
