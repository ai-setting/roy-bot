/**
 * @fileoverview Trace Context 实现
 * 
 * 基于 AsyncLocalStorage 的轻量级追踪上下文实现
 */

import { AsyncLocalStorage } from "async_hooks";
import { type SpanContext, type ITraceContext, type TraceContextOptions } from "./types";

interface RequestContextData {
  requestId: string;
  sessionId?: string;
  timestamp: number;
  spanContext?: SpanContext;
}

const contextStore = new AsyncLocalStorage<RequestContextData>();
export { contextStore };

/**
 * 创建轻量级 TraceContext 实现
 */
function createLightweightContext(): ITraceContext {
  return new LightweightTraceContext();
}

/**
 * 轻量级 TraceContext 实现
 */
class LightweightTraceContext implements ITraceContext {
  getRequestId(): string | undefined {
    return contextStore.getStore()?.requestId;
  }

  getSpanContext(): SpanContext | undefined {
    return contextStore.getStore()?.spanContext;
  }

  setSpanContext(spanContext: SpanContext): void {
    const store = contextStore.getStore();
    if (store) {
      store.spanContext = spanContext;
    }
  }

  runWithContext<T>(fn: () => T): T {
    const store = contextStore.getStore();
    if (store) {
      return contextStore.run(store, fn);
    }
    return fn();
  }

  runWithNewContext<T>(requestId: string, sessionId: string | undefined, fn: () => T): T {
    const context: RequestContextData = {
      requestId,
      sessionId,
      timestamp: Date.now(),
      spanContext: {
        traceId: requestId,
        spanId: this.generateSpanId(),
      },
    };
    return contextStore.run(context, fn);
  }

  async runWithContextAsync<T>(fn: () => Promise<T>): Promise<T> {
    const store = contextStore.getStore();
    if (store) {
      return contextStore.run(store, fn);
    }
    return fn();
  }

  async runWithNewContextAsync<T>(requestId: string, sessionId: string | undefined, fn: () => Promise<T>): Promise<T> {
    const context: RequestContextData = {
      requestId,
      sessionId,
      timestamp: Date.now(),
      spanContext: {
        traceId: requestId,
        spanId: this.generateSpanId(),
      },
    };
    return contextStore.run(context, fn);
  }

  generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private generateSpanId(): string {
    return `span_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  initContext(requestId: string, sessionId?: string): void {
    const context: RequestContextData = {
      requestId,
      sessionId,
      timestamp: Date.now(),
      spanContext: {
        traceId: requestId,
        spanId: this.generateSpanId(),
      },
    };
    contextStore.enterWith(context);
  }

  startNewContext(requestId: string, sessionId?: string): () => void {
    const context: RequestContextData = {
      requestId,
      sessionId,
      timestamp: Date.now(),
      spanContext: {
        traceId: requestId,
        spanId: this.generateSpanId(),
      },
    };
    const previousStore = contextStore.getStore();
    contextStore.enterWith(context);
    
    // 清理函数：恢复之前的上下文
    // 注意：如果之前没有上下文，清理后 getStore() 会返回 undefined
    return () => {
      contextStore.enterWith(previousStore!);
    };
  }
}

// ============================================================================
// 全局单例
// ============================================================================

let traceContextImpl: ITraceContext | null = null;

/**
 * 获取当前 TraceContext 实例
 */
export function getTraceContext(): ITraceContext {
  if (!traceContextImpl) {
    traceContextImpl = createLightweightContext();
  }
  return traceContextImpl;
}

/**
 * 设置 TraceContext 实现（用于测试或替换）
 */
export function setTraceContext(impl: ITraceContext): void {
  traceContextImpl = impl;
}

/**
 * 初始化 TraceContext
 */
export function initTraceContext(options?: TraceContextOptions): ITraceContext {
  // 目前只支持轻量级实现
  traceContextImpl = createLightweightContext();
  return traceContextImpl;
}

export type { ITraceContext, TraceContextOptions } from "./types";
