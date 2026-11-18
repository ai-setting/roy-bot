import { describe, expect, test } from 'bun:test';
import type {
  TraceEntry,
  TraceTreeNode,
  ParserOptions,
  LogDiscoveryOptions,
  TraceIdInfo,
  ParsedLogLine,
} from './types';

describe('Debug Types', () => {
  describe('TraceEntry', () => {
    test('should have correct structure for enter action', () => {
      const entry: TraceEntry = {
        traceId: 'req_123_abc',
        timestamp: '2026-04-08T19:12:36.134',
        function: 'llm.component.invoke',
        action: 'enter',
        params: [
          { messages: [{ role: 'system', content: 'You are Roy...' }] },
          { providerId: 'minimax', model: 'MiniMax-M2.7' },
        ],
      };

      expect(entry.traceId).toBe('req_123_abc');
      expect(entry.function).toBe('llm.component.invoke');
      expect(entry.action).toBe('enter');
      expect(entry.params).toHaveLength(2);
    });

    test('should have correct structure for quit action', () => {
      const entry: TraceEntry = {
        traceId: 'req_123_abc',
        timestamp: '2026-04-08T19:12:39.213',
        function: 'llm.component.invoke',
        action: 'quit',
        result: {
          output: { content: 'Hello!', finishReason: 'stop' },
          latencyMs: 3077,
        },
        durationMs: 3077,
      };

      expect(entry.action).toBe('quit');
      expect(entry.durationMs).toBe(3077);
      expect(entry.result).toBeDefined();
    });

    test('should have correct structure for error action', () => {
      const entry: TraceEntry = {
        traceId: 'req_123_abc',
        timestamp: '2026-04-08T19:12:39.213',
        function: 'llm.component.invoke',
        action: 'error',
        error: 'Connection timeout',
      };

      expect(entry.action).toBe('error');
      expect(entry.error).toBe('Connection timeout');
    });
  });

  describe('TraceTreeNode', () => {
    test('should have correct structure', () => {
      const node: TraceTreeNode = {
        traceId: 'req_123_abc',
        function: 'llm.component.invoke',
        startTime: '2026-04-08T19:12:36.134',
        endTime: '2026-04-08T19:12:39.213',
        durationMs: 3077,
        children: [],
        entry: {
          traceId: 'req_123_abc',
          timestamp: '2026-04-08T19:12:36.134',
          function: 'llm.component.invoke',
          action: 'enter',
        },
      };

      expect(node.children).toHaveLength(0);
      expect(node.durationMs).toBe(3077);
    });

    test('should support nested children', () => {
      const childNode: TraceTreeNode = {
        traceId: 'req_123_abc',
        function: 'tool.execute',
        startTime: '2026-04-08T19:12:37.000',
        endTime: '2026-04-08T19:12:37.500',
        durationMs: 500,
        children: [],
        entry: {
          traceId: 'req_123_abc',
          timestamp: '2026-04-08T19:12:37.000',
          function: 'tool.execute',
          action: 'enter',
        },
      };

      const rootNode: TraceTreeNode = {
        traceId: 'req_123_abc',
        function: 'llm.component.invoke',
        startTime: '2026-04-08T19:12:36.134',
        endTime: '2026-04-08T19:12:39.213',
        durationMs: 3077,
        children: [childNode],
        entry: {
          traceId: 'req_123_abc',
          timestamp: '2026-04-08T19:12:36.134',
          function: 'llm.component.invoke',
          action: 'enter',
        },
      };

      expect(rootNode.children).toHaveLength(1);
      expect(rootNode.children[0].function).toBe('tool.execute');
    });
  });

  describe('ParserOptions', () => {
    test('should support all optional fields', () => {
      const options: ParserOptions = {
        logFile: '/path/to/app.log',
        traceId: 'req_123',
        function: 'llm.component.invoke',
        since: '2026-04-08T10:00:00',
        until: '2026-04-08T12:00:00',
        level: 'info',
      };

      expect(options.logFile).toBe('/path/to/app.log');
      expect(options.level).toBe('info');
    });

    test('should allow empty options', () => {
      const options: ParserOptions = {};
      expect(options.logFile).toBeUndefined();
      expect(options.traceId).toBeUndefined();
    });
  });

  describe('LogDiscoveryOptions', () => {
    test('should have default pattern', () => {
      const options: LogDiscoveryOptions = {
        logDir: '/custom/logs',
        pattern: '*.log',
      };

      expect(options.pattern).toBe('*.log');
    });
  });

  describe('TraceIdInfo', () => {
    test('should have correct structure', () => {
      const info: TraceIdInfo = {
        traceId: 'req_123_abc',
        firstTime: '2026-04-08T19:12:36',
        lastTime: '2026-04-08T19:12:45',
        count: 15,
      };

      expect(info.traceId).toBe('req_123_abc');
      expect(info.count).toBe(15);
    });
  });

  describe('ParsedLogLine', () => {
    test('should have correct structure', () => {
      const line: ParsedLogLine = {
        raw: '2026-04-08 19:12:36.134 [INFO] [cli/src/bin/roy.js:80752][traced:llm.component.invoke] [TRACE] >>> llm.component.invoke enter: [{}]',
        timestamp: '2026-04-08 19:12:36.134',
        level: 'INFO',
        source: 'cli/src/bin/roy.js:80752',
        category: 'traced:llm.component.invoke',
        action: '>>>',
        method: 'llm.component.invoke',
        actionType: 'enter',
        rawArgs: '[{}]',
      };

      expect(line.timestamp).toBe('2026-04-08 19:12:36.134');
      expect(line.level).toBe('INFO');
      expect(line.action).toBe('>>>');
      expect(line.method).toBe('llm.component.invoke');
    });
  });
});
