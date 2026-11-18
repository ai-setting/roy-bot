/**
 * @fileoverview Propagation Env 测试
 * 
 * 测试 propagation-env 模块：
 * - injectToEnv: 从当前 OTelTracerProvider 获取上下文并注入环境变量
 * - injectToEnvWithContext: 直接注入指定 SpanContext
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'bun:test';
import { 
  injectToEnv,
  injectToEnvWithContext,
  injectToEnvFromCarrier,
} from './propagation-env';
import { propagation } from './propagation';

// Mock the tracer-provider module
const mockInjectToEnv = vi.fn();
const mockGetCurrentContext = vi.fn();

vi.mock('./tracer-provider', () => ({
  getTracerProvider: vi.fn().mockReturnValue({
    getTracer: vi.fn().mockReturnValue({
      injectToEnv: mockInjectToEnv,
      getCurrentContext: mockGetCurrentContext,
    }),
    isInitialized: vi.fn().mockReturnValue(true),
  }),
}));

describe('propagation-env', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('injectToEnv', () => {
    test('should inject TRACEPARENT to provided env object', async () => {
      // Create a mock tracer with current context
      const mockSpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: undefined,
      };

      mockGetCurrentContext.mockReturnValue(mockSpanContext);
      mockInjectToEnv.mockImplementation((env: Record<string, string | undefined>) => {
        env['TRACEPARENT'] = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      });

      const env: Record<string, string | undefined> = {};
      injectToEnv(env);

      expect(env['TRACEPARENT']).toBeDefined();
      expect(env['TRACEPARENT']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    test('should not inject if no current context', () => {
      mockGetCurrentContext.mockReturnValue(undefined);
      mockInjectToEnv.mockImplementation((_env: Record<string, string | undefined>) => {});

      const env: Record<string, string | undefined> = {};
      injectToEnv(env);

      // injectToEnv should not set TRACEPARENT when no context
      expect(mockInjectToEnv).toHaveBeenCalledWith(env);
    });

    test('should preserve existing env variables', () => {
      const mockSpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: undefined,
      };

      mockGetCurrentContext.mockReturnValue(mockSpanContext);
      mockInjectToEnv.mockImplementation((env: Record<string, string | undefined>) => {
        env['TRACEPARENT'] = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      });

      const env: Record<string, string | undefined> = {
        HOME: '/home/user',
        PATH: '/usr/bin',
        CUSTOM_VAR: 'custom-value',
      };
      
      injectToEnv(env);

      expect(env['HOME']).toBe('/home/user');
      expect(env['PATH']).toBe('/usr/bin');
      expect(env['CUSTOM_VAR']).toBe('custom-value');
      expect(env['TRACEPARENT']).toBeDefined();
    });
  });

  describe('injectToEnvWithContext', () => {
    test('should inject given SpanContext to env', () => {
      const context = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: 'a1b2c3d4e5f67890',
      };

      const env: Record<string, string | undefined> = {};
      injectToEnvWithContext(env, context);

      // 验证 propagation.inject 被正确调用
      expect(env['TRACEPARENT']).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    test('should inject traceparent format correctly', () => {
      const context = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: undefined,
      };

      const env: Record<string, string | undefined> = {};
      injectToEnvWithContext(env, context);

      const traceparent = env['TRACEPARENT'];
      expect(traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    test('should overwrite existing TRACEPARENT', () => {
      const context = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: undefined,
      };

      const env: Record<string, string | undefined> = {
        TRACEPARENT: '00-old-trace-old-span-old-flags',
      };
      
      injectToEnvWithContext(env, context);

      expect(env['TRACEPARENT']).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });
  });

  describe('injectToEnvFromCarrier', () => {
    test('should inject from source carrier to target carrier', () => {
      const sourceCarrier: Record<string, string | undefined> = {
        TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      };

      const targetCarrier: Record<string, string | undefined> = {};
      injectToEnvFromCarrier(targetCarrier, sourceCarrier);

      expect(targetCarrier['TRACEPARENT']).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    test('should return undefined if source has no TRACEPARENT', () => {
      const sourceCarrier: Record<string, string | undefined> = {};
      const targetCarrier: Record<string, string | undefined> = {};
      
      injectToEnvFromCarrier(targetCarrier, sourceCarrier);

      expect(targetCarrier['TRACEPARENT']).toBeUndefined();
    });
  });
});

describe('propagation-env integration', () => {
  test('should produce valid W3C traceparent format', () => {
    const context = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      parentSpanId: undefined,
    };

    const env: Record<string, string | undefined> = {};
    injectToEnvWithContext(env, context);

    // Parse and verify format
    const parsed = propagation.extract(env);
    expect(parsed).toBeDefined();
    expect(parsed!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(parsed!.spanId).toBe('b7ad6b7169203331');
  });
});
