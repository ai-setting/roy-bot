/**
 * @fileoverview OTelTracerProvider 测试
 * 
 * 测试 OpenTelemetry TracerProvider 实现：
 * - 单例模式
 * - 获取 Tracer
 * - 启动/结束 Span
 * - 上下文注入环境变量
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'bun:test';
import { 
  OTelTracerProvider,
  getTracerProvider,
  resetTracerProvider,
  type SpanOptions,
  type OTelSpan,
} from './tracer-provider';
import { propagation, parse } from './propagation';

// Create mock storage object for testing (instead of vi.mock to prevent cross-test pollution)
function createMockStorage() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(),
    findByTraceId: vi.fn().mockReturnValue([]),
    findBySpanId: vi.fn(),
    listTraces: vi.fn().mockReturnValue([]),
    deleteByTraceId: vi.fn(),
    close: vi.fn(),
  };
}

describe('OTelTracerProvider', () => {
  let provider: OTelTracerProvider;
  let mockStorage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    mockStorage = createMockStorage();
    provider = new OTelTracerProvider(mockStorage as any);
  });

  afterEach(() => {
    provider.shutdown();
  });

  describe('singleton', () => {
    test('should return singleton instance', () => {
      const instance1 = getTracerProvider();
      const instance2 = getTracerProvider();
      
      expect(instance1).toBe(instance2);
    });

    test('should allow reset for testing', () => {
      const instance1 = getTracerProvider();
      provider.shutdown();
      
      // Reset and get new instance
      const instance2 = getTracerProvider();
      
      // They should be the same instance (singleton)
      expect(instance1).toBe(instance2);
    });
  });

  describe('getTracer', () => {
    test('should return a tracer with given name', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      expect(tracer).toBeDefined();
      expect(tracer.name).toBe('test-tracer');
    });

    test('should return same tracer for same name', async () => {
      await provider.initialize();
      const tracer1 = provider.getTracer('test-tracer');
      const tracer2 = provider.getTracer('test-tracer');
      
      expect(tracer1).toBe(tracer2);
    });

    test('should return different tracers for different names', async () => {
      await provider.initialize();
      const tracer1 = provider.getTracer('tracer-a');
      const tracer2 = provider.getTracer('tracer-b');
      
      expect(tracer1).not.toBe(tracer2);
      expect(tracer1.name).toBe('tracer-a');
      expect(tracer2.name).toBe('tracer-b');
    });

    test('should include version when provided', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer', '1.0.0');
      
      expect(tracer.name).toBe('test-tracer');
      expect(tracer.version).toBe('1.0.0');
    });
  });

  describe('startSpan', () => {
    test('should start a new span with name', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      const span = tracer.startSpan('my-span');
      
      expect(span).toBeDefined();
      expect(span.name).toBe('my-span');
      expect(span.spanContext).toBeDefined();
      expect(span.spanContext.traceId).toBeDefined();
      expect(span.spanContext.spanId).toBeDefined();
    });

    test('should generate unique spanId for each span', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      const span1 = tracer.startSpan('span-1');
      const span2 = tracer.startSpan('span-2');
      
      expect(span1.spanContext.spanId).not.toBe(span2.spanContext.spanId);
    });

    test('should set parentSpanId from current context', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      const parentSpan = tracer.startSpan('parent-span');
      const childSpan = tracer.startSpan('child-span');
      
      expect(childSpan.spanContext.parentSpanId).toBe(parentSpan.spanContext.spanId);
    });

    test('should end span with result', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      const span = tracer.startSpan('my-span');
      span.end({ data: 'test result' });
      
      expect(span.endTime).toBeDefined();
    });

    test('should end span with error', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      const span = tracer.startSpan('my-span');
      const error = new Error('test error');
      span.end(undefined, error);
      
      expect(span.endTime).toBeDefined();
      expect(span.error).toBe(error.message);
    });

    test('should set attributes', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      const span = tracer.startSpan('my-span', {
        attributes: { key1: 'value1', key2: 123 },
      });
      
      expect(span.attributes).toEqual({ key1: 'value1', key2: 123 });
    });
  });

  describe('injectToEnv', () => {
    test('should inject current span context to env', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      const span = tracer.startSpan('my-span');
      
      const env: Record<string, string | undefined> = {};
      tracer.injectToEnv(env);
      
      expect(env['TRACEPARENT']).toBeDefined();
      expect(env['TRACEPARENT']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    test('should include traceId in injected env', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      const span = tracer.startSpan('my-span');
      
      const env: Record<string, string | undefined> = {};
      tracer.injectToEnv(env);
      
      const parsed = parse(env['TRACEPARENT']!);
      expect(parsed).toBeDefined();
      expect(parsed!.traceId).toBe(span.spanContext.traceId);
      expect(parsed!.spanId).toBe(span.spanContext.spanId);
    });
  });

  describe('context propagation', () => {
    test('should propagate context across nested spans', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      const span1 = tracer.startSpan('span-1');
      expect(span1.spanContext.parentSpanId).toBeUndefined(); // root span
      
      const span2 = tracer.startSpan('span-2');
      expect(span2.spanContext.parentSpanId).toBe(span1.spanContext.spanId);
      
      const span3 = tracer.startSpan('span-3');
      expect(span3.spanContext.parentSpanId).toBe(span2.spanContext.spanId);
      
      span3.end();
      span2.end();
      span1.end();
      
      // Verify traceId is same for all spans
      expect(span1.spanContext.traceId).toBe(span2.spanContext.traceId);
      expect(span2.spanContext.traceId).toBe(span3.spanContext.traceId);
    });

    test('should restore parentSpanId in currentContext after ending span', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      // Start and end root span
      const span1 = tracer.startSpan('span-1');
      expect(span1.spanContext.parentSpanId).toBeUndefined();
      const span1Id = span1.spanContext.spanId;
      span1.end();
      
      // After ending root span, currentContext should be undefined (no active spans)
      expect(tracer.getCurrentContext()).toBeUndefined();
      
      // Start a new span - it should be a new root (no parent)
      const span2 = tracer.startSpan('span-2');
      expect(span2.spanContext.traceId).not.toBe(span1.spanContext.traceId);
      expect(span2.spanContext.parentSpanId).toBeUndefined();
      span2.end();
    });

    test('should restore correct context after ending child span', async () => {
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      // Start root span
      const rootSpan = tracer.startSpan('root-span');
      const rootSpanId = rootSpan.spanContext.spanId;
      expect(rootSpan.spanContext.parentSpanId).toBeUndefined();
      
      // Start child span
      const childSpan = tracer.startSpan('child-span');
      const childSpanId = childSpan.spanContext.spanId;
      expect(childSpan.spanContext.parentSpanId).toBe(rootSpanId);
      
      // End child span
      childSpan.end();
      
      // After ending child, currentContext should have parentSpanId pointing to root
      const ctxAfterChild = tracer.getCurrentContext();
      expect(ctxAfterChild).toBeDefined();
      expect(ctxAfterChild!.traceId).toBe(rootSpan.spanContext.traceId);
      expect(ctxAfterChild!.spanId).toBe(rootSpanId);
      expect(ctxAfterChild!.parentSpanId).toBeUndefined(); // root span has no parent
      
      // Start another child of root - should have correct parentSpanId
      const childSpan2 = tracer.startSpan('child-span-2');
      expect(childSpan2.spanContext.parentSpanId).toBe(rootSpanId);
      
      // End all
      childSpan2.end();
      rootSpan.end();
    });
  });

  describe('initialize from environment', () => {
    test('should restore context from TRACEPARENT env', async () => {
      // Set up parent trace
      const parentTraceId = '0af7651916cd43dd8448eb211c80319c';
      const parentSpanId = 'b7ad6b7169203331';
      
      // Simulate environment with TRACEPARENT
      const originalEnv = process.env.TRACEPARENT;
      process.env.TRACEPARENT = `00-${parentTraceId}-${parentSpanId}-01`;
      
      try {
        await provider.initialize();
        const tracer = provider.getTracer('test-tracer');
        
        const span = tracer.startSpan('child-span');
        
        expect(span.spanContext.traceId).toBe(parentTraceId);
        expect(span.spanContext.parentSpanId).toBe(parentSpanId);
      } finally {
        process.env.TRACEPARENT = originalEnv;
      }
    });
  });

  describe('cross-process context propagation', () => {
    test('should preserve traceId when parent span is not in activeSpans', async () => {
      // 模拟跨进程场景：
      // 1. 主进程创建 root span
      // 2. bash tool 创建 child span 并将其 spanId 传给子进程
      // 3. 子进程结束时，主进程的 child span 已经不在 activeSpans 中
      // 4. 此时应该保留 traceId，而不是清空上下文
      
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      // 主进程创建 root span (模拟 agent.component.executeTool)
      const rootSpan = tracer.startSpan('root-span');
      const rootSpanId = rootSpan.spanContext.spanId;
      const traceId = rootSpan.spanContext.traceId;
      
      // 主进程创建 child span (模拟 bash tool)
      const childSpan = tracer.startSpan('bash: ls');
      const childSpanId = childSpan.spanContext.spanId;
      
      // child span 的 parent 是 root span
      expect(childSpan.spanContext.parentSpanId).toBe(rootSpanId);
      expect(childSpan.spanContext.traceId).toBe(traceId);
      
      // 结束 child span（模拟子进程完成）
      childSpan.end();
      
      // 关键验证：结束 child span 后，即使 root span 仍在 activeSpans 中，
      // currentContext 应该恢复为 root span 的上下文
      const ctxAfterChild = tracer.getCurrentContext();
      expect(ctxAfterChild).toBeDefined();
      expect(ctxAfterChild!.traceId).toBe(traceId);
      expect(ctxAfterChild!.spanId).toBe(rootSpanId);
      
      // 结束 root span
      rootSpan.end();
      
      // 验证：root span 结束后，currentContext 被清空
      expect(tracer.getCurrentContext()).toBeUndefined();
    });

    test('should preserve traceId when ending span with non-existent parent', async () => {
      // 模拟跨进程场景：子进程结束时找不到父 span
      // 这是修复的关键场景
      
      await provider.initialize();
      const tracer = provider.getTracer('test-tracer');
      
      // 创建父 span (在主进程中)
      const parentSpan = tracer.startSpan('parent-span');
      const parentSpanId = parentSpan.spanContext.spanId;
      const traceId = parentSpan.spanContext.traceId;
      
      // 创建子 span (模拟 bash tool 创建的 span)
      const childSpan = tracer.startSpan('bash-span');
      expect(childSpan.spanContext.parentSpanId).toBe(parentSpanId);
      
      // 模拟跨进程场景：从 activeSpans 中移除父 span
      // 这模拟了子进程无法访问主进程 activeSpans 的情况
      // 手动从 activeSpans 中删除父 span
      (tracer as any).activeSpans.delete(parentSpanId);
      
      // 结束子 span（此时父 span 不在 activeSpans 中）
      childSpan.end();
      
      // 关键验证：currentContext 应该保留 traceId，而不是被清空
      // 这样后续创建的 span 能继承 traceId
      const ctxAfterEnd = tracer.getCurrentContext();
      expect(ctxAfterEnd).toBeDefined();
      expect(ctxAfterEnd!.traceId).toBe(traceId);
      
      // 创建新 span，应该继承 traceId（而不是创建新的根）
      const newSpan = tracer.startSpan('new-span');
      expect(newSpan.spanContext.traceId).toBe(traceId);
      
      newSpan.end();
      parentSpan.end();
    });
  });
});
