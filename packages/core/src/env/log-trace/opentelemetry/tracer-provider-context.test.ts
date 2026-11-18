/**
 * @fileoverview OTelTracerImpl 上下文管理测试
 * 
 * 验证 OTelTracerImpl 的 startSpan/endSpan 正确维护 currentContext
 * 以及嵌套 span 的父子关系建立
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { 
  OTelTracerProvider, 
  getTracerProvider, 
  resetTracerProvider,
  type OTelTracer,
  type OTelSpan,
} from './tracer-provider';
import { join } from 'path';

describe('OTelTracerImpl Context Management', () => {
  const dbPath = join('/tmp', `test-otel-context-${Date.now()}.db`);
  
  beforeEach(() => {
    resetTracerProvider();
  });

  afterEach(() => {
    resetTracerProvider();
  });

  describe('startSpan/endSpan context lifecycle', () => {
    test('should set currentContext after startSpan', async () => {
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer('test-context');

      const span = tracer.startSpan('test-span');
      
      expect(tracer.getCurrentContext()).toBeDefined();
      expect(tracer.getCurrentContext()!.traceId).toBeDefined();
      expect(tracer.getCurrentContext()!.spanId).toBe(span.spanContext.spanId);
    });

    test('should clear currentContext after endSpan', async () => {
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer('test-context');

      const span = tracer.startSpan('test-span');
      expect(tracer.getCurrentContext()).toBeDefined();

      // 调用 end 方法
      span.end();
      
      // 对于根 span，end 后 currentContext 应该为 undefined
      expect(tracer.getCurrentContext()).toBeUndefined();
    });

    test('should maintain currentContext after endSpan when parent exists', async () => {
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer('test-context');

      // 创建父 span
      const parentSpan = tracer.startSpan('parent');
      const parentContext = tracer.getCurrentContext();
      expect(parentContext).toBeDefined();

      // 创建子 span
      const childSpan = tracer.startSpan('child');
      expect(tracer.getCurrentContext()!.spanId).toBe(childSpan.spanContext.spanId);
      expect(tracer.getCurrentContext()!.parentSpanId).toBe(parentSpan.spanContext.spanId);

      // 结束子 span，应该恢复到父上下文
      childSpan.end();
      
      // ⚠️ 这里会失败，因为当前实现有问题
      expect(tracer.getCurrentContext()!.spanId).toBe(parentSpan.spanContext.spanId);
      expect(tracer.getCurrentContext()!.parentSpanId).toBe(parentContext!.parentSpanId);
    });
  });

  describe('nested span parent-child relationship', () => {
    test('should create child span with correct parentSpanId', async () => {
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer('test-nested');

      // 父 span
      const parentSpan = tracer.startSpan('parent');
      const parentSpanId = parentSpan.spanContext.spanId;
      const traceId = parentSpan.spanContext.traceId;

      // 子 span - 应该继承 traceId，parentSpanId 指向父 span
      const childSpan = tracer.startSpan('child');
      
      expect(childSpan.spanContext.traceId).toBe(traceId);
      expect(childSpan.spanContext.parentSpanId).toBe(parentSpanId);
    });

    test('should build correct span tree in storage', async () => {
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer('test-tree');
      const storage = provider.getStorage();

      // 创建嵌套 span
      const parent = tracer.startSpan('parent');
      const parentId = parent.spanContext.spanId;
      const parentTraceId = parent.spanContext.traceId;
      
      const child1 = tracer.startSpan('child1');
      child1.end();
      
      const child2 = tracer.startSpan('child2');
      child2.end();
      
      parent.end();

      // 验证存储中的 span - SQLiteSpanStorage 返回树结构根节点
      // 需要直接查询所有 span
      const rootSpans = storage.findByTraceId(parentTraceId);
      
      // 树中应该有 1 个根 span（parent），children 包含 child1 和 child2
      expect(rootSpans.length).toBeGreaterThanOrEqual(1);
      
      const parentStored = rootSpans.find(s => s.spanId === parentId);
      expect(parentStored).toBeDefined();
      // 根 span 的 parentSpanId 应该是 undefined 或 null
      expect(parentStored!.parentSpanId || undefined).toBeUndefined();
      
      // 验证子 span 存在（通过 flatten）
      function flattenSpans(span: any): any[] {
        const result: any[] = [];
        if (span.children) {
          for (const child of span.children) {
            result.push(child);
            result.push(...flattenSpans(child));
          }
        }
        return result;
      }
      const flatSpans = rootSpans.flatMap(s => [s, ...flattenSpans(s)]);
      expect(flatSpans.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('async span context', () => {
    test('should maintain context across async boundaries', async () => {
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer('test-async');

      const span = tracer.startSpan('async-parent');
      const traceId = span.spanContext.traceId;

      // 在异步操作中
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 应该仍然能访问到相同的 traceId
      const currentContext = tracer.getCurrentContext();
      expect(currentContext).toBeDefined();
      expect(currentContext!.traceId).toBe(traceId);

      span.end();
    });
  });
});
