import { describe, expect, test, beforeEach } from 'bun:test';
import { RegexParser } from './regex-parser';

describe('RegexParser', () => {
  let parser: RegexParser;

  beforeEach(() => {
    parser = new RegexParser();
  });

  describe('parseLogLine', () => {
    test('should parse enter trace line', () => {
      const line = '2026-04-08 19:12:36.134 [INFO] [cli/src/bin/roy.js:80752][traced:llm.component.invoke] [TRACE] >>> llm.component.invoke enter: [{\"messages\":[{\"role\":\"user\"}]},{\"providerId\":\"minimax\"}]';
      
      const result = parser.parseLogLine(line);
      
      expect(result).not.toBeNull();
      expect(result!.timestamp).toBe('2026-04-08T19:12:36.134'); // ISO format with T
      expect(result!.level).toBe('INFO');
      expect(result!.source).toBe('cli/src/bin/roy.js:80752');
      expect(result!.category).toBe('traced:llm.component.invoke');
      expect(result!.action).toBe('>>>');
      expect(result!.method).toBe('llm.component.invoke');
      expect(result!.actionType).toBe('enter');
    });

    test('should parse quit trace line', () => {
      const line = '2026-04-08 19:12:39.213 [INFO] [cli/src/bin/roy.js:80752][traced:llm.component.invoke] [TRACE] <<< llm.component.invoke quit: {\"output\":{\"content\":\"Hello\"}}';
      
      const result = parser.parseLogLine(line);
      
      expect(result).not.toBeNull();
      expect(result!.action).toBe('<<<');
      expect(result!.actionType).toBe('quit');
    });

    test('should parse error trace line', () => {
      const line = '2026-04-08 19:12:39.213 [ERROR] [cli/src/bin/roy.js:80752][traced:llm.component.invoke] [TRACE] !!! llm.component.invoke error: Connection timeout';
      
      const result = parser.parseLogLine(line);
      
      expect(result).not.toBeNull();
      expect(result!.action).toBe('!!!');
      expect(result!.actionType).toBe('error');
      expect(result!.level).toBe('ERROR');
    });

    test('should return null for non-trace lines', () => {
      const line = '2026-04-08 19:12:36.134 [INFO] Some regular log message';
      
      const result = parser.parseLogLine(line);
      
      expect(result).toBeNull();
    });

    test('should return null for malformed trace lines', () => {
      const line = '2026-04-08 19:12:36.134 [INFO] [TRACE] >>> invalid line';
      
      const result = parser.parseLogLine(line);
      
      expect(result).toBeNull();
    });

    test('should parse line with method name', () => {
      // Note: The requestId is extracted separately via extractTraceId
      const line = '2026-04-08 19:12:36.134 [INFO] [cli/src/bin/roy.js:80752][traced:llm.component.invoke] [TRACE] >>> llm.component.invoke enter: [{}]';
      
      const result = parser.parseLogLine(line);
      
      expect(result).not.toBeNull();
      expect(result!.method).toBe('llm.component.invoke');
    });
  });

  describe('parseArgs', () => {
    test('should parse JSON array args', () => {
      const raw = '[{\"messages\":[{\"role\":\"user\"}]},{\"providerId\":\"minimax\"}]';
      
      const result = parser.parseArgs(raw);
      
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ messages: [{ role: 'user' }] });
      expect(result[1]).toEqual({ providerId: 'minimax' });
    });

    test('should parse JSON object args', () => {
      const raw = '{\"name\":\"test\",\"value\":123}';
      
      const result = parser.parseArgs(raw);
      
      expect(result).toEqual({ name: 'test', value: 123 });
    });

    test('should parse simple string args', () => {
      const raw = 'simple string argument';
      
      const result = parser.parseArgs(raw);
      
      expect(result).toBe('simple string argument');
    });

    test('should handle empty args', () => {
      const raw = '';
      
      const result = parser.parseArgs(raw);
      
      expect(result).toBeNull();
    });

    test('should handle malformed JSON gracefully', () => {
      const raw = '{invalid json}';
      
      const result = parser.parseArgs(raw);
      
      expect(result).toBe(raw); // Return raw string on parse failure
    });
  });

  describe('isTraceLine', () => {
    test('should return true for trace lines', () => {
      const line = '2026-04-08 19:12:36.134 [INFO] [TRACE] >>> method enter: [{}]';
      expect(parser.isTraceLine(line)).toBe(true);
    });

    test('should return false for non-trace lines', () => {
      const line = '2026-04-08 19:12:36.134 [INFO] Regular log message';
      expect(parser.isTraceLine(line)).toBe(false);
    });
  });

  describe('filterByLevel', () => {
    test('should filter by info level', () => {
      const lines = [
        '2026-04-08 19:12:36.134 [INFO] [TRACE] >>> method enter: [{}]',
        '2026-04-08 19:12:36.134 [DEBUG] [TRACE] >>> method enter: [{}]',
        '2026-04-08 19:12:36.134 [ERROR] [TRACE] >>> method enter: [{}]',
      ];

      const filtered = parser.filterByLevel(lines, 'info');
      
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toContain('[INFO]');
    });

    test('should return all lines if no level specified', () => {
      const lines = [
        '2026-04-08 19:12:36.134 [INFO] [TRACE] >>> method enter: [{}]',
        '2026-04-08 19:12:36.134 [DEBUG] [TRACE] >>> method enter: [{}]',
      ];

      const filtered = parser.filterByLevel(lines);
      
      expect(filtered).toHaveLength(2);
    });
  });

  describe('filterByFunction', () => {
    test('should filter by function name', () => {
      const lines = [
        '2026-04-08 19:12:36.134 [INFO] [TRACE] >>> llm.invoke enter: [{}]',
        '2026-04-08 19:12:36.134 [INFO] [TRACE] >>> tool.execute enter: [{}]',
        '2026-04-08 19:12:36.134 [INFO] [TRACE] >>> db.query enter: [{}]',
      ];

      const filtered = parser.filterByFunction(lines, 'llm');
      
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toContain('llm.invoke');
    });

    test('should return all lines if no function specified', () => {
      const lines = [
        '2026-04-08 19:12:36.134 [INFO] [TRACE] >>> llm.invoke enter: [{}]',
        '2026-04-08 19:12:36.134 [INFO] [TRACE] >>> tool.execute enter: [{}]',
      ];

      const filtered = parser.filterByFunction(lines);
      
      expect(filtered).toHaveLength(2);
    });
  });

  describe('extractTraceId', () => {
    test('should extract traceId from category', () => {
      const line = '2026-04-08 19:12:36.134 [INFO] [source][requestId=req_123] [TRACE] >>> method enter: [{}]';
      
      const traceId = parser.extractTraceId(line);
      
      expect(traceId).toBe('req_123');
    });

    test('should return null if no traceId found', () => {
      const line = '2026-04-08 19:12:36.134 [INFO] [source] [TRACE] >>> method enter: [{}]';
      
      const traceId = parser.extractTraceId(line);
      
      expect(traceId).toBeNull();
    });
  });
});
