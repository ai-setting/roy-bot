import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ReplFormatter } from './repl-formatter';
import type { TraceEntry, TraceTreeNode } from '../types';

// Mock readline
const mockReadline = {
  createInterface: mock(() => ({
    on: mock(() => {}),
    close: mock(() => {}),
  })),
};

describe('ReplFormatter', () => {
  let formatter: ReplFormatter;

  beforeEach(() => {
    formatter = new ReplFormatter();
  });

  test('should create ReplFormatter instance', () => {
    expect(formatter).toBeDefined();
  });

  test('should have welcome message', () => {
    const welcome = formatter.getWelcomeMessage();
    expect(welcome).toContain('Debug REPL');
    expect(welcome).toContain('Commands:');
  });

  test('should format prompt with context', () => {
    const prompt = formatter.formatPrompt();
    expect(prompt).toContain('debug');
  });

  test('should format prompt with trace context', () => {
    const prompt = formatter.formatPrompt({ traceId: 'trace-001' });
    expect(prompt).toContain('trace-001');
  });

  test('should format prompt with function context', () => {
    const prompt = formatter.formatPrompt({ function: 'llm.invoke' });
    expect(prompt).toContain('llm.invoke');
  });

  test('should return help text', () => {
    const help = formatter.getHelpText();
    expect(help).toContain('list');
    expect(help).toContain('trace');
    expect(help).toContain('tree');
    expect(help).toContain('exit');
  });

  test('should format command result - list', () => {
    const mockTraces = [
      { traceId: 'trace-001', firstTime: '2026-04-08T10:00:00', count: 2 },
      { traceId: 'trace-002', firstTime: '2026-04-08T10:01:00', count: 1 },
    ];
    
    const result = formatter.formatCommandResult('list', { traceIds: mockTraces, count: 2 });
    expect(result).toContain('trace-001');
    expect(result).toContain('trace-002');
  });

  test('should format command result - trace', () => {
    const mockEntries: TraceEntry[] = [
      {
        traceId: 'trace-001',
        timestamp: '2026-04-08T10:00:00',
        function: 'llm.invoke',
        action: 'enter',
        params: [{ msg: 'hello' }],
      },
      {
        traceId: 'trace-001',
        timestamp: '2026-04-08T10:00:01',
        function: 'llm.invoke',
        action: 'quit',
        result: { content: 'hi' },
        durationMs: 1000,
      },
    ];
    
    const result = formatter.formatCommandResult('trace', mockEntries);
    expect(result).toContain('>>>');
    expect(result).toContain('<<<');
    expect(result).toContain('llm.invoke');
  });

  test('should format command result - tree', () => {
    const mockTree: TraceTreeNode = {
      traceId: 'trace-001',
      function: 'root',
      startTime: '2026-04-08T10:00:00',
      children: [
        {
          traceId: 'trace-001',
          function: 'child1',
          startTime: '2026-04-08T10:00:01',
          children: [],
          entry: {} as TraceEntry,
        },
      ],
      entry: {} as TraceEntry,
    };
    
    const result = formatter.formatCommandResult('tree', [mockTree]);
    expect(result).toContain('root');
    expect(result).toContain('child1');
  });

  test('should handle empty results', () => {
    const result = formatter.formatCommandResult('trace', []);
    expect(result).toContain('No');
    expect(result).toContain('trace');
  });

  test('should handle unknown command', () => {
    const result = formatter.formatCommandResult('unknown', {});
    expect(result).toContain('Unknown');
  });

  test('should parse simple commands', () => {
    expect(formatter.parseCommand('list')).toEqual({ command: 'list', args: {} });
    expect(formatter.parseCommand('list 5')).toEqual({ command: 'list', args: { limit: '5' } });
    expect(formatter.parseCommand('trace --func llm')).toEqual({ command: 'trace', args: { func: 'llm' } });
    expect(formatter.parseCommand('trace -f llm')).toEqual({ command: 'trace', args: { f: 'llm' } });
  });

  test('should return unknown for invalid command', () => {
    const result = formatter.parseCommand('invalid command');
    expect(result.command).toBe('invalid');
  });

  test('should handle exit command', () => {
    expect(formatter.parseCommand('exit')).toEqual({ command: 'exit', args: {} });
    expect(formatter.parseCommand('quit')).toEqual({ command: 'exit', args: {} });
    expect(formatter.parseCommand('q')).toEqual({ command: 'exit', args: {} });
  });
});
