import { describe, test, expect } from 'bun:test';
import { TreeFormatter } from './tree-formatter';
import type { TraceTreeNode, TraceEntry } from '../types';

describe('TreeFormatter', () => {
  const formatter = new TreeFormatter();

  const mockRootNode: TraceTreeNode = {
    traceId: 'trace-001',
    function: 'agent.execute',
    startTime: '2026-04-08T10:00:00.000',
    endTime: '2026-04-08T10:00:05.000',
    durationMs: 5000,
    children: [
      {
        traceId: 'trace-001',
        function: 'llm.component.invoke',
        startTime: '2026-04-08T10:00:01.000',
        endTime: '2026-04-08T10:00:03.000',
        durationMs: 2000,
        children: [],
        entry: {} as TraceEntry,
      },
      {
        traceId: 'trace-001',
        function: 'tool.execute',
        startTime: '2026-04-08T10:00:03.000',
        endTime: '2026-04-08T10:00:04.000',
        durationMs: 1000,
        children: [],
        entry: {} as TraceEntry,
      },
    ],
    entry: {} as TraceEntry,
  };

  test('formatTree - should format tree with proper indentation', () => {
    const result = formatter.formatTree(mockRootNode);
    
    // Should show root function
    expect(result).toContain('agent.execute');
    // Should show duration (5s because it's > 1000ms)
    expect(result).toContain('5.00s');
    // Should have tree branch connectors
    expect(result).toContain('├──');
    expect(result).toContain('└──');
  });

  test('formatTree - should show children with correct markers', () => {
    const result = formatter.formatTree(mockRootNode);
    
    // Should show children
    expect(result).toContain('llm.component.invoke');
    expect(result).toContain('tool.execute');
  });

  test('formatTree - should handle empty children', () => {
    const leafNode: TraceTreeNode = {
      traceId: 'trace-001',
      function: 'leaf.function',
      startTime: '2026-04-08T10:00:00.000',
      children: [],
      entry: {} as TraceEntry,
    };
    
    const result = formatter.formatTree(leafNode);
    expect(result).toContain('leaf.function');
    expect(result).not.toContain('children');
  });

  test('formatTree - should format duration', () => {
    const result = formatter.formatTree(mockRootNode);
    
    // Duration should be visible (formatted as seconds for values >= 1000ms)
    expect(result).toContain('5.00s');  // 5000ms
    expect(result).toContain('2.00s');  // 2000ms
    expect(result).toContain('1.00s');  // 1000ms
  });

  test('formatTrees - should format multiple trees', () => {
    const node2: TraceTreeNode = {
      ...mockRootNode,
      traceId: 'trace-002',
      function: 'another.function',
    };
    
    const result = formatter.formatTrees([mockRootNode, node2]);
    
    // Should have two separate trees
    expect(result.split('\n\n')).toHaveLength(2);
    expect(result).toContain('agent.execute');
    expect(result).toContain('another.function');
  });

  test('formatTrees - should handle empty array', () => {
    const result = formatter.formatTrees([]);
    expect(result).toBe('No trace trees');
  });

  test('toJSON - should output valid JSON', () => {
    const result = formatter.toJSON([mockRootNode]);
    const parsed = JSON.parse(result);
    
    expect(parsed).toHaveLength(1);
    expect(parsed[0].function).toBe('agent.execute');
  });
});
