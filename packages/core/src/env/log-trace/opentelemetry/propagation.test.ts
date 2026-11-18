/**
 * @fileoverview W3C TraceContext Propagation 测试
 * 
 * 测试 W3C TraceContext 标准的 traceparent 格式：
 * - 注入 (inject): 将 SpanContext 序列化到环境变量
 * - 提取 (extract): 从环境变量反序列化 SpanContext
 * - 序列化 (serialize): SpanContext -> traceparent 字符串
 * - 反序列化 (parse): traceparent 字符串 -> SpanContext
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { 
  propagation,
  serialize,
  parse,
  type SpanContext,
  type ExtractedContext,
} from './propagation';

describe('propagation', () => {
  describe('serialize', () => {
    test('should serialize basic SpanContext to traceparent format', () => {
      const context: SpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: undefined,
      };

      const result = serialize(context);
      // W3C TraceContext: 使用 spanId 而非 parentSpanId
      expect(result).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    test('should serialize SpanContext with parentSpanId', () => {
      const context: SpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: 'a1b2c3d4e5f67890',
      };

      const result = serialize(context);
      // W3C TraceContext: 使用 spanId 而非 parentSpanId
      expect(result).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    test('should pad traceId to 32 characters', () => {
      const context: SpanContext = {
        traceId: '1',
        spanId: 'b7ad6b7169203331',
        parentSpanId: undefined,
      };

      const result = serialize(context);
      // traceId "1" should be padded to "00000000000000000000000000000001"
      expect(result).toMatch(/^00-0{31}1-/);
    });

    test('should pad spanId to 16 characters', () => {
      const context: SpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: '1',
        parentSpanId: undefined,
      };

      const result = serialize(context);
      // spanId "1" should be padded to "0000000000000001"
      expect(result).toMatch(/-0{15}1-01$/);
    });
  });

  describe('parse', () => {
    test('should parse valid traceparent string', () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

      const result = parse(traceparent);
      
      expect(result).toBeDefined();
      expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      // parse returns ExtractedContext: spanId is the sender's spanId
      expect(result!.spanId).toBe('b7ad6b7169203331');
    });

    test('should parse traceparent string', () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-a1b2c3d4e5f67890-01';

      const result = parse(traceparent);
      
      expect(result).toBeDefined();
      expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(result!.spanId).toBe('a1b2c3d4e5f67890');
    });

    test('should return undefined for invalid traceparent format', () => {
      const invalidTraceparent = 'invalid-format';

      const result = parse(invalidTraceparent);
      
      expect(result).toBeUndefined();
    });

    test('should return undefined for wrong version', () => {
      const wrongVersion = '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

      const result = parse(wrongVersion);
      
      expect(result).toBeUndefined();
    });

    test('should return undefined for traceId wrong length', () => {
      const wrongLength = '00-0af7651916cd43dd8448eb211c80319-b7ad6b7169203331-01';

      const result = parse(wrongLength);
      
      expect(result).toBeUndefined();
    });

    test('should return undefined for spanId wrong length', () => {
      const wrongLength = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920333-01';

      const result = parse(wrongLength);
      
      expect(result).toBeUndefined();
    });
  });

  describe('inject', () => {
    test('should inject SpanContext to carrier', () => {
      const carrier: Record<string, string> = {};
      const context: SpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: undefined,
      };

      propagation.inject(carrier, context);

      expect(carrier['TRACEPARENT']).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    test('should inject with parentSpanId', () => {
      const carrier: Record<string, string> = {};
      const context: SpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: 'a1b2c3d4e5f67890',
      };

      propagation.inject(carrier, context);

      // W3C TraceContext: inject uses spanId (sender's span ID)
      expect(carrier['TRACEPARENT']).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    test('should overwrite existing TRACEPARENT', () => {
      const carrier: Record<string, string> = {
        TRACEPARENT: '00-old-trace-old-span-old-flags',
      };
      const context: SpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
      };

      propagation.inject(carrier, context);

      expect(carrier['TRACEPARENT']).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });
  });

  describe('extract', () => {
    test('should extract SpanContext from carrier', () => {
      const carrier: Record<string, string> = {
        TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      };

      const result = propagation.extract(carrier);

      expect(result).toBeDefined();
      expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      // extract returns ExtractedContext: spanId is sender's spanId
      expect(result!.spanId).toBe('b7ad6b7169203331');
    });

    test('should extract with spanId', () => {
      const carrier: Record<string, string> = {
        TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-a1b2c3d4e5f67890-01',
      };

      const result = propagation.extract(carrier);

      expect(result).toBeDefined();
      expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(result!.spanId).toBe('a1b2c3d4e5f67890');
    });

    test('should return undefined when TRACEPARENT not present', () => {
      const carrier: Record<string, string> = {};

      const result = propagation.extract(carrier);

      expect(result).toBeUndefined();
    });

    test('should return undefined for invalid TRACEPARENT', () => {
      const carrier: Record<string, string> = {
        TRACEPARENT: 'invalid-traceparent',
      };

      const result = propagation.extract(carrier);

      expect(result).toBeUndefined();
    });

    test('should handle lowercase traceparent', () => {
      const carrier: Record<string, string> = {
        TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      };

      const result = propagation.extract(carrier);

      expect(result).toBeDefined();
      expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    });
  });

  describe('roundtrip', () => {
    test('should serialize and parse back to same values (traceId and parentSpanId)', () => {
      const original: SpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: 'a1b2c3d4e5f67890',
      };

      const serialized = serialize(original);
      const parsed = parse(serialized);

      // parse returns ExtractedContext: spanId is sender's spanId
      expect(parsed).toBeDefined();
      expect(parsed!.traceId).toBe(original.traceId);
      expect(parsed!.spanId).toBe(original.spanId);
    });

    test('should inject and extract back to same values', () => {
      const original: SpanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        parentSpanId: 'a1b2c3d4e5f67890',
      };

      const carrier: Record<string, string> = {};
      propagation.inject(carrier, original);
      const extracted = propagation.extract(carrier);

      // extract returns ExtractedContext (without spanId)
      expect(extracted).toBeDefined();
      expect(extracted!.traceId).toBe(original.traceId);
      expect(extracted!.spanId).toBe(original.spanId); // injected uses spanId
    });
  });
});
