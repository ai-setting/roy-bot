/**
 * @fileoverview CLI Propagation 测试
 * 
 * 测试 CLI 启动时从环境变量提取 trace context 的功能：
 * - 从 TRACEPARENT 环境变量提取父 span context
 * - 提供便捷函数用于 CLI 初始化
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'bun:test';
import { propagation, type ExtractedContext } from './propagation';

// 测试目标模块
// 注意：这是 TDD，测试先于实现
// import { initTracerFromEnv, extractFromEnv } from './cli-propagation';

describe('cli-propagation', () => {
  describe('extractFromEnv', () => {
    // 模拟环境变量
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      // 恢复环境变量
      process.env = originalEnv;
    });

    test('should return undefined when TRACEPARENT is not set', () => {
      delete process.env.TRACEPARENT;
      
      // 模拟从环境变量提取
      const carrier = { TRACEPARENT: process.env.TRACEPARENT };
      const result = propagation.extract(carrier);
      
      expect(result).toBeUndefined();
    });

    test('should extract valid TRACEPARENT from env', () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      process.env.TRACEPARENT = traceparent;
      
      const carrier = { TRACEPARENT: process.env.TRACEPARENT };
      const result = propagation.extract(carrier);
      
      expect(result).toBeDefined();
      expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(result!.spanId).toBe('b7ad6b7169203331');
    });

    test('should handle invalid TRACEPARENT gracefully', () => {
      process.env.TRACEPARENT = 'invalid-traceparent';
      
      const carrier = { TRACEPARENT: process.env.TRACEPARENT };
      const result = propagation.extract(carrier);
      
      expect(result).toBeUndefined();
    });
  });

  describe('initTracerFromEnv', () => {
    // 模拟 OTelTracerProvider
    const mockProvider = {
      initialized: false,
      tracers: new Map(),
      
      async initialize(): Promise<void> {
        this.initialized = true;
      },
      
      isInitialized(): boolean {
        return this.initialized;
      },
      
      getTracer(name: string): any {
        return {
          name,
          setCurrentContext: vi.fn(),
        };
      },
    };

    test('should initialize with extracted context', async () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const originalEnv = process.env.TRACEPARENT;
      process.env.TRACEPARENT = traceparent;
      
      try {
        // 模拟从环境变量提取并初始化
        const carrier = { TRACEPARENT: process.env.TRACEPARENT };
        const extracted = propagation.extract(carrier);
        
        expect(extracted).toBeDefined();
        expect(extracted!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
        expect(extracted!.spanId).toBe('b7ad6b7169203331');
      } finally {
        process.env.TRACEPARENT = originalEnv;
      }
    });

    test('should not initialize when TRACEPARENT is missing', async () => {
      const originalEnv = process.env.TRACEPARENT;
      delete process.env.TRACEPARENT;
      
      try {
        const carrier = { TRACEPARENT: process.env.TRACEPARENT };
        const extracted = propagation.extract(carrier);
        
        expect(extracted).toBeUndefined();
      } finally {
        process.env.TRACEPARENT = originalEnv;
      }
    });
  });

  describe('integration with OTelTracerProvider', () => {
    test('should create SpanContext from extracted env context', async () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const originalEnv = process.env.TRACEPARENT;
      process.env.TRACEPARENT = traceparent;
      
      try {
        // 模拟从环境变量提取
        const carrier = { TRACEPARENT: process.env.TRACEPARENT };
        const extracted = propagation.extract(carrier);
        
        // 验证提取的内容
        expect(extracted).toBeDefined();
        
        // 从 ExtractedContext 构建 SpanContext
        // 注意：spanId 由接收方生成，parentSpanId 是发送方的 spanId
        const spanContext = {
          traceId: extracted!.traceId,
          // 生成新的 spanId（这里用 extracted 的 parentSpanId 作为占位）
          spanId: '0000000000000000', // placeholder - new spanId will be generated
          parentSpanId: extracted!.spanId,
        };
        
        expect(spanContext.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
        expect(spanContext.parentSpanId).toBe('b7ad6b7169203331');
      } finally {
        process.env.TRACEPARENT = originalEnv;
      }
    });
  });
});
