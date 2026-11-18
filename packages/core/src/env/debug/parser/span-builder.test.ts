import { describe, expect, test, beforeEach } from 'bun:test';
import { SpanBuilder } from './span-builder';
import type { ParsedLogLine, TraceEntry, TraceTreeNode } from '../types';

describe('SpanBuilder', () => {
  let builder: SpanBuilder;

  beforeEach(() => {
    builder = new SpanBuilder();
  });

  describe('buildTraceEntries', () => {
    test('should build entries from parsed lines', () => {
      const lines: ParsedLogLine[] = [
        {
          raw: '2026-04-08 19:12:36.134 [INFO] [source][traced:llm] [TRACE] >>> llm.invoke enter: [{}]',
          timestamp: '2026-04-08T19:12:36.134',
          level: 'INFO',
          source: 'source',
          category: 'traced:llm',
          action: '>>>',
          method: 'llm.invoke',
          actionType: 'enter',
          rawArgs: '[{}]',
        },
        {
          raw: '2026-04-08 19:12:39.213 [INFO] [source][traced:llm] [TRACE] <<< llm.invoke quit: {}',
          timestamp: '2026-04-08T19:12:39.213',
          level: 'INFO',
          source: 'source',
          category: 'traced:llm',
          action: '<<<',
          method: 'llm.invoke',
          actionType: 'quit',
          rawArgs: '{}',
        },
      ];

      const entries = builder.buildTraceEntries(lines);

      expect(entries).toHaveLength(2);
      expect(entries[0].action).toBe('enter');
      expect(entries[1].action).toBe('quit');
    });

    test('should extract params from enter action', () => {
      const lines: ParsedLogLine[] = [
        {
          raw: 'test',
          timestamp: '2026-04-08T19:12:36.134',
          level: 'INFO',
          source: 'source',
          category: 'traced:llm',
          action: '>>>',
          method: 'llm.invoke',
          actionType: 'enter',
          rawArgs: '[{"messages":[]},{"model":"gpt-4"}]',
        },
      ];

      const entries = builder.buildTraceEntries(lines);

      expect(entries[0].params).toEqual([{ messages: [] }, { model: 'gpt-4' }]);
    });

    test('should extract result from quit action', () => {
      const lines: ParsedLogLine[] = [
        {
          raw: 'test',
          timestamp: '2026-04-08T19:12:39.213',
          level: 'INFO',
          source: 'source',
          category: 'traced:llm',
          action: '<<<',
          method: 'llm.invoke',
          actionType: 'quit',
          rawArgs: '{"output":"Hello","latencyMs":100}',
        },
      ];

      const entries = builder.buildTraceEntries(lines);

      expect(entries[0].result).toEqual({ output: 'Hello', latencyMs: 100 });
    });

    test('should extract error from error action', () => {
      const lines: ParsedLogLine[] = [
        {
          raw: 'test',
          timestamp: '2026-04-08T19:12:39.213',
          level: 'ERROR',
          source: 'source',
          category: 'traced:llm',
          action: '!!!',
          method: 'llm.invoke',
          actionType: 'error',
          rawArgs: 'Connection timeout',
        },
      ];

      const entries = builder.buildTraceEntries(lines);

      expect(entries[0].error).toBe('Connection timeout');
    });

    test('should extract traceId from category', () => {
      const lines: ParsedLogLine[] = [
        {
          raw: '2026-04-08 19:12:36.134 [INFO] [source][requestId=req_123][traced:llm] [TRACE] >>> llm.invoke enter: [{}]',
          timestamp: '2026-04-08T19:12:36.134',
          level: 'INFO',
          source: 'source',
          category: 'requestId=req_123][traced:llm',
          action: '>>>',
          method: 'llm.invoke',
          actionType: 'enter',
          rawArgs: '[{}]',
        },
      ];

      const entries = builder.buildTraceEntries(lines);

      expect(entries[0].traceId).toBe('req_123');
    });
  });

  describe('calculateDuration', () => {
    test('should calculate duration between enter and quit', () => {
      const enter: TraceEntry = {
        traceId: 'req_123',
        timestamp: '2026-04-08T19:12:36.134',
        function: 'llm.invoke',
        action: 'enter',
      };

      const quit: TraceEntry = {
        traceId: 'req_123',
        timestamp: '2026-04-08T19:12:39.213',
        function: 'llm.invoke',
        action: 'quit',
      };

      const duration = builder.calculateDuration(enter, quit);

      expect(duration).toBe(3079); // ~3079ms
    });

    test('should return 0 for invalid timestamps', () => {
      const enter: TraceEntry = {
        traceId: 'req_123',
        timestamp: 'invalid',
        function: 'llm.invoke',
        action: 'enter',
      };

      const quit: TraceEntry = {
        traceId: 'req_123',
        timestamp: '2026-04-08T19:12:39.213',
        function: 'llm.invoke',
        action: 'quit',
      };

      const duration = builder.calculateDuration(enter, quit);

      expect(duration).toBe(0);
    });
  });

  describe('buildCallTree', () => {
    test('should build single node tree', () => {
      const entries: TraceEntry[] = [
        {
          traceId: 'req_123',
          timestamp: '2026-04-08T19:12:36.134',
          function: 'llm.invoke',
          action: 'enter',
        },
        {
          traceId: 'req_123',
          timestamp: '2026-04-08T19:12:39.213',
          function: 'llm.invoke',
          action: 'quit',
          durationMs: 3079,
        },
      ];

      const tree = builder.buildCallTree(entries);

      expect(tree).not.toBeNull();
      expect(tree!.function).toBe('llm.invoke');
      expect(tree!.durationMs).toBe(3079);
      expect(tree!.children).toHaveLength(0);
    });

    test('should return null for empty entries', () => {
      const tree = builder.buildCallTree([]);
      expect(tree).toBeNull();
    });

    test('should return null for unmatched enter/quit', () => {
      const entries: TraceEntry[] = [
        {
          traceId: 'req_123',
          timestamp: '2026-04-08T19:12:36.134',
          function: 'llm.invoke',
          action: 'enter',
        },
      ];

      const tree = builder.buildCallTree(entries);
      expect(tree).toBeNull();
    });
  });

  describe('pairEnterQuit', () => {
    test('should pair enter and quit entries', () => {
      const entries: TraceEntry[] = [
        {
          traceId: 'req_123',
          timestamp: '2026-04-08T19:12:36.134',
          function: 'llm.invoke',
          action: 'enter',
          params: [{ arg1: 'value1' }],
        },
        {
          traceId: 'req_123',
          timestamp: '2026-04-08T19:12:39.213',
          function: 'llm.invoke',
          action: 'quit',
          result: { output: 'result' },
        },
      ];

      const paired = builder.pairEnterQuit(entries);

      expect(paired).toHaveLength(1);
      expect(paired[0].enter.params).toEqual([{ arg1: 'value1' }]);
      expect(paired[0].quit.result).toEqual({ output: 'result' });
    });
  });
});
