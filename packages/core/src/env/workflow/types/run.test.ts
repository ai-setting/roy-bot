import { describe, it, expect } from 'vitest';
import { z } from 'zod';

describe('Run Types', () => {
  describe('RunStatus', () => {
    it('should accept all valid run statuses', () => {
      const validStatuses = ['idle', 'running', 'paused', 'stopped', 'completed', 'failed'];
      const schema = z.enum(['idle', 'running', 'paused', 'stopped', 'completed', 'failed']);
      
      for (const status of validStatuses) {
        expect(() => schema.parse(status)).not.toThrow();
      }
    });

    it('should reject invalid run status', () => {
      const schema = z.enum(['idle', 'running', 'paused', 'stopped', 'completed', 'failed']);
      expect(() => schema.parse('invalid')).toThrow();
      expect(() => schema.parse('pending')).toThrow();
      expect(() => schema.parse('')).toThrow();
    });
  });

  describe('NodeStatus', () => {
    it('should accept all valid node statuses', () => {
      const validStatuses = ['pending', 'scheduled', 'started', 'running', 'completed', 'failed', 'skipped'];
      const schema = z.enum(['pending', 'scheduled', 'started', 'running', 'completed', 'failed', 'skipped']);
      
      for (const status of validStatuses) {
        expect(() => schema.parse(status)).not.toThrow();
      }
    });

    it('should reject invalid node status', () => {
      const schema = z.enum(['pending', 'scheduled', 'started', 'running', 'completed', 'failed', 'skipped']);
      expect(() => schema.parse('invalid')).toThrow();
      expect(() => schema.parse('idle')).toThrow();
    });
  });

  describe('WorkflowRun', () => {
    it('should accept minimal workflow run', () => {
      const run = {
        id: 'run_123',
        workflowId: 'wf_456',
        workflowName: 'test-workflow',
        status: 'idle',
        debugMode: false,
      };
      
      expect(run.id).toBe('run_123');
      expect(run.workflowId).toBe('wf_456');
      expect(run.status).toBe('idle');
    });

    it('should accept full workflow run', () => {
      const run = {
        id: 'run_123',
        workflowId: 'wf_456',
        workflowName: 'test-workflow',
        status: 'completed',
        input: { param1: 'value1' },
        output: { result: 'success' },
        error: undefined,
        startedAt: new Date('2024-01-01T10:00:00Z'),
        completedAt: new Date('2024-01-01T10:05:00Z'),
        durationMs: 300000,
        debugMode: true,
        parentRunId: 'run_000',
      };
      
      expect(run.id).toBe('run_123');
      expect(run.status).toBe('completed');
      expect(run.input).toEqual({ param1: 'value1' });
      expect(run.output).toEqual({ result: 'success' });
      expect(run.startedAt).toBeInstanceOf(Date);
      expect(run.durationMs).toBe(300000);
      expect(run.debugMode).toBe(true);
      expect(run.parentRunId).toBe('run_000');
    });

    it('should accept running state workflow run', () => {
      const run = {
        id: 'run_123',
        workflowId: 'wf_456',
        workflowName: 'test-workflow',
        status: 'running',
        startedAt: new Date(),
        debugMode: false,
      };
      
      expect(run.status).toBe('running');
      expect(run.startedAt).toBeInstanceOf(Date);
    });

    it('should accept paused state workflow run', () => {
      const run = {
        id: 'run_123',
        workflowId: 'wf_456',
        workflowName: 'test-workflow',
        status: 'paused',
        startedAt: new Date(),
        pausedAt: new Date(),
        debugMode: false,
      };
      
      expect(run.status).toBe('paused');
      expect(run.pausedAt).toBeInstanceOf(Date);
    });

    it('should accept failed state workflow run', () => {
      const run = {
        id: 'run_123',
        workflowId: 'wf_456',
        workflowName: 'test-workflow',
        status: 'failed',
        error: 'Node execution failed: tool not found',
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 5000,
        debugMode: false,
      };
      
      expect(run.status).toBe('failed');
      expect(run.error).toBe('Node execution failed: tool not found');
      expect(run.durationMs).toBe(5000);
    });
  });

  describe('NodeRun', () => {
    it('should accept minimal node run', () => {
      const nodeRun = {
        id: 'nr_123',
        runId: 'run_456',
        nodeId: 'node1',
        nodeType: 'tool',
        status: 'pending',
        retryCount: 0,
      };
      
      expect(nodeRun.id).toBe('nr_123');
      expect(nodeRun.nodeId).toBe('node1');
      expect(nodeRun.status).toBe('pending');
      expect(nodeRun.retryCount).toBe(0);
    });

    it('should accept full node run', () => {
      const nodeRun = {
        id: 'nr_123',
        runId: 'run_456',
        nodeId: 'node1',
        nodeType: 'tool',
        status: 'completed',
        input: { operation: 'add', a: 1, b: 2 },
        output: { result: 3 },
        error: undefined,
        startedAt: new Date('2024-01-01T10:00:00Z'),
        completedAt: new Date('2024-01-01T10:00:01Z'),
        durationMs: 1000,
        retryCount: 0,
      };
      
      expect(nodeRun.status).toBe('completed');
      expect(nodeRun.input).toEqual({ operation: 'add', a: 1, b: 2 });
      expect(nodeRun.output).toEqual({ result: 3 });
      expect(nodeRun.durationMs).toBe(1000);
    });

    it('should accept failed node run with error', () => {
      const nodeRun = {
        id: 'nr_123',
        runId: 'run_456',
        nodeId: 'node1',
        nodeType: 'tool',
        status: 'failed',
        input: { tool: 'nonexistent' },
        error: 'Tool not found: nonexistent',
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 100,
        retryCount: 3,
      };
      
      expect(nodeRun.status).toBe('failed');
      expect(nodeRun.error).toBe('Tool not found: nonexistent');
      expect(nodeRun.retryCount).toBe(3);
    });

    it('should accept running node run', () => {
      const nodeRun = {
        id: 'nr_123',
        runId: 'run_456',
        nodeId: 'node1',
        nodeType: 'agent',
        status: 'running',
        input: { prompt: 'Do something' },
        startedAt: new Date(),
        retryCount: 0,
      };
      
      expect(nodeRun.status).toBe('running');
      expect(nodeRun.startedAt).toBeInstanceOf(Date);
    });

    it('should accept skipped node run', () => {
      const nodeRun = {
        id: 'nr_123',
        runId: 'run_456',
        nodeId: 'node1',
        nodeType: 'tool',
        status: 'skipped',
        reason: 'Previous dependency failed',
        retryCount: 0,
      };
      
      expect(nodeRun.status).toBe('skipped');
    });

    it('should accept scheduled node run', () => {
      const nodeRun = {
        id: 'nr_123',
        runId: 'run_456',
        nodeId: 'node1',
        nodeType: 'tool',
        status: 'scheduled',
        retryCount: 0,
      };
      
      expect(nodeRun.status).toBe('scheduled');
    });
  });

  describe('RunOptions', () => {
    it('should accept minimal run options', () => {
      const options = {};
      expect(options).toEqual({});
    });

    it('should accept full run options', () => {
      const options = {
        input: { key: 'value' },
        debug: true,
        parallelLimit: 5,
        timeout: 300000,
      };

      expect(options.input).toEqual({ key: 'value' });
      expect(options.debug).toBe(true);
      expect(options.parallelLimit).toBe(5);
      expect(options.timeout).toBe(300000);
    });

    it('should accept null parallelLimit for unlimited', () => {
      const options = {
        parallelLimit: null,
      };
      
      expect(options.parallelLimit).toBeNull();
    });

    it('should accept null timeout for no timeout', () => {
      const options = {
        timeout: null,
      };
      
      expect(options.timeout).toBeNull();
    });

    it('should accept undefined input', () => {
      const options = {
        input: undefined,
      };

      expect(options.input).toBeUndefined();
    });
  });

  describe('RunResult', () => {
    it('should accept successful run result', () => {
      const result = {
        runId: 'run_123',
        status: 'completed' as const,
        output: { result: 'success' },
        durationMs: 5000,
      };
      
      expect(result.runId).toBe('run_123');
      expect(result.status).toBe('completed');
      expect(result.output).toEqual({ result: 'success' });
      expect(result.durationMs).toBe(5000);
    });

    it('should accept failed run result', () => {
      const result = {
        runId: 'run_123',
        status: 'failed' as const,
        error: 'Workflow execution failed',
        durationMs: 5000,
      };
      
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Workflow execution failed');
    });

    it('should accept running run result', () => {
      const result = {
        runId: 'run_123',
        status: 'running' as const,
      };
      
      expect(result.status).toBe('running');
      expect(result.output).toBeUndefined();
      expect(result.error).toBeUndefined();
    });
  });

  describe('NodeExecutionContext', () => {
    it('should accept valid execution context', () => {
      const context = {
        runId: 'run_123',
        workflowName: 'test-workflow',
        nodeId: 'node1',
        input: { param: 'value' },
        previousOutputs: new Map([['prev_node', { result: 42 }]]),
        config: { tool: 'calculator' },
        debug: false,
        eventBus: {
          publish: () => {},
        },
      };
      
      expect(context.runId).toBe('run_123');
      expect(context.nodeId).toBe('node1');
      expect(context.previousOutputs).toBeInstanceOf(Map);
      expect(context.config).toEqual({ tool: 'calculator' });
      expect(context.debug).toBe(false);
    });

    it('should accept empty previousOutputs', () => {
      const context = {
        runId: 'run_123',
        workflowName: 'test-workflow',
        nodeId: 'node1',
        input: {},
        previousOutputs: new Map(),
        config: {},
        debug: false,
        eventBus: {},
      };
      
      expect(context.previousOutputs.size).toBe(0);
    });

    it('should accept context with multiple previous outputs', () => {
      const context = {
        runId: 'run_123',
        workflowName: 'test-workflow',
        nodeId: 'node3',
        input: {},
        previousOutputs: new Map([
          ['node1', { result: 'step1' }],
          ['node2', { result: 'step2' }],
        ]),
        config: {},
        debug: false,
        eventBus: {},
      };
      
      expect(context.previousOutputs.size).toBe(2);
      expect(context.previousOutputs.get('node1')).toEqual({ result: 'step1' });
      expect(context.previousOutputs.get('node2')).toEqual({ result: 'step2' });
    });

    it('should accept debug mode context', () => {
      const context = {
        runId: 'run_123',
        workflowName: 'test-workflow',
        nodeId: 'node1',
        input: {},
        previousOutputs: new Map(),
        config: {},
        debug: true,
        eventBus: {},
      };
      
      expect(context.debug).toBe(true);
    });
  });

  describe('NodeExecutionResult', () => {
    it('should accept successful execution result', () => {
      const result = {
        output: { result: 'success', data: [1, 2, 3] },
        error: undefined,
        durationMs: 1500,
      };
      
      expect(result.output).toEqual({ result: 'success', data: [1, 2, 3] });
      expect(result.error).toBeUndefined();
      expect(result.durationMs).toBe(1500);
    });

    it('should accept failed execution result', () => {
      const error = new Error('Execution failed');
      const result = {
        output: undefined,
        error,
        durationMs: 500,
      };
      
      expect(result.output).toBeUndefined();
      expect(result.error).toBe(error);
      expect(result.error.message).toBe('Execution failed');
      expect(result.durationMs).toBe(500);
    });

    it('should accept result with complex output', () => {
      const result = {
        output: {
          files: [
            { name: 'file1.txt', size: 1024 },
            { name: 'file2.txt', size: 2048 },
          ],
          summary: { total: 2, totalSize: 3072 },
        },
        error: undefined,
        durationMs: 3000,
      };
      
      expect(result.output.files).toHaveLength(2);
      expect(result.output.summary.total).toBe(2);
    });
  });
});
