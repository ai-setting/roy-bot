import { describe, test, expect } from 'bun:test';
import { TraceFormatter } from './trace-formatter';
import type { TraceEntry, FormatOptions } from '../types';

describe('TraceFormatter', () => {
  const formatter = new TraceFormatter();

  const mockEnterEntry: TraceEntry = {
    traceId: 'trace-001',
    timestamp: '2026-04-08T10:00:00.000',
    function: 'llm.component.invoke',
    action: 'enter',
    params: [
      [{ role: 'user', content: 'Hello' }],
      { providerId: 'openai', model: 'gpt-4' }
    ],
  };

  const mockQuitEntry: TraceEntry = {
    traceId: 'trace-001',
    timestamp: '2026-04-08T10:00:01.000',
    function: 'llm.component.invoke',
    action: 'quit',
    result: { content: 'Hi there!', finishReason: 'stop' },
    durationMs: 1000,
  };

  test('formatEntry - should format enter entry', () => {
    const result = formatter.formatEntry(mockEnterEntry);
    expect(result).toContain('>>>');
    expect(result).toContain('llm.component.invoke');
    expect(result).toContain('enter');
  });

  test('formatEntry - should format quit entry with duration', () => {
    const result = formatter.formatEntry(mockQuitEntry);
    expect(result).toContain('<<<');
    expect(result).toContain('llm.component.invoke');
    expect(result).toContain('1000ms');
  });

  test('formatEntry - should handle multi-line content without breaking layout', () => {
    const entryWithMultiline: TraceEntry = {
      ...mockQuitEntry,
      result: {
        content: 'This is a\nmulti-line\nresponse',
        finishReason: 'stop'
      },
    };
    
    const result = formatter.formatEntry(entryWithMultiline, { pretty: true });
    // Should handle newlines gracefully - indent continuation lines
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // Second line onwards should be indented
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].startsWith('  ')).toBe(true);
    }
  });

  test('formatEntry - should handle deep nesting', () => {
    const deepEntry: TraceEntry = {
      ...mockQuitEntry,
      result: {
        level1: {
          level2: {
            level3: {
              level4: 'deep value'
            }
          }
        }
      },
    };
    
    const result = formatter.formatEntry(deepEntry, { pretty: true, maxDepth: 2 });
    // Should truncate at maxDepth
    expect(result).toContain('level1');
    expect(result).toContain('...');
  });

  test('formatEntries - should format multiple entries', () => {
    const entries = [mockEnterEntry, mockQuitEntry];
    const result = formatter.formatEntries(entries);
    expect(result).toContain('>>>');
    expect(result).toContain('<<<');
  });

  test('formatEntries - should respect pretty option', () => {
    const entries = [mockEnterEntry, mockQuitEntry];
    
    const prettyResult = formatter.formatEntries(entries, { pretty: true });
    const jsonResult = formatter.formatEntries(entries, { pretty: false });
    
    // Pretty should have newlines and indentation
    expect(prettyResult).toContain('\n');
    // Pretty should have separator line
    expect(prettyResult).toContain('-'.repeat(40));
    // JSON should be compact (no separator line between entries)
    expect(jsonResult).not.toContain('-'.repeat(40));
  });

  test('toJSON - should output valid JSON', () => {
    const entries = [mockEnterEntry, mockQuitEntry];
    const result = formatter.toJSON(entries);
    
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].action).toBe('enter');
    expect(parsed[1].action).toBe('quit');
  });

  test('toSummary - should return trace summary', () => {
    const entries = [mockEnterEntry, mockQuitEntry];
    const result = formatter.toSummary(entries);
    
    expect(result).toContain('llm.component.invoke');
    expect(result).toContain('2 entries');
  });
});
