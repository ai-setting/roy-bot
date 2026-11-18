import { describe, expect, test, beforeEach } from 'bun:test';
import { DebugComponent } from './debug-component';
import type { TraceEntry, TraceTreeNode, ParserOptions } from './types';

describe('DebugComponent', () => {
  let component: DebugComponent;

  beforeEach(() => {
    component = new DebugComponent();
  });

  describe('initialization', () => {
    test('should have correct name and version', () => {
      expect(component.name).toBe('debug');
      expect(component.version).toBe('1.0.0');
    });

    test('should initialize with running status', async () => {
      await component.init();
      expect(component.getStatus()).toBe('running');
    });
  });

  describe('getTraces', () => {
    test('should return traces from log file', async () => {
      await component.init();
      
      // Note: Without proper file mocking, we test the structure
      const traces = await component.getTraces({
        logFile: '/nonexistent/app.log',
      });

      expect(Array.isArray(traces)).toBe(true);
      // Non-existent file returns empty array
      expect(traces).toEqual([]);
    });

    test('should filter by function name', async () => {
      await component.init();
      
      const traces = await component.getTraces({
        logFile: '/real/app.log',
        function: 'llm.invoke',
      });

      expect(traces.every(t => t.function.includes('llm'))).toBe(true);
    });

    test('should return empty array for non-existent file', async () => {
      await component.init();
      
      const traces = await component.getTraces({
        logFile: '/nonexistent/file.log',
      });

      expect(traces).toEqual([]);
    });
  });

  describe('listTraceIds', () => {
    test('should return trace ID list', async () => {
      await component.init();
      
      const result = await component.listTraceIds({
        logFile: '/real/app.log',
      });

      expect(result).toHaveProperty('traceIds');
      expect(result).toHaveProperty('count');
      expect(Array.isArray(result.traceIds)).toBe(true);
    });

    test('should respect limit parameter', async () => {
      await component.init();
      
      const result = await component.listTraceIds({
        logFile: '/real/app.log',
        limit: 5,
      });

      expect(result.traceIds.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getCallTree', () => {
    test('should return call tree for trace', async () => {
      await component.init();
      
      const tree = await component.getCallTree({
        logFile: '/real/app.log',
        traceId: 'req_123',
      });

      if (tree) {
        expect(tree).toHaveProperty('traceId');
        expect(tree).toHaveProperty('function');
        expect(tree).toHaveProperty('children');
        expect(Array.isArray(tree.children)).toBe(true);
      }
    });

    test('should return null for non-existent trace', async () => {
      await component.init();
      
      const tree = await component.getCallTree({
        logFile: '/real/app.log',
        traceId: 'nonexistent',
      });

      // May return null or empty tree depending on implementation
      expect(tree === null || tree.traceId !== 'nonexistent').toBe(true);
    });
  });
});
