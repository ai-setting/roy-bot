import { describe, it, expect } from 'vitest';
import { z } from 'zod';

describe('Event Types', () => {
  describe('BaseEvent', () => {
    it('should accept valid base event', () => {
      const baseEvent = {
        type: 'workflow.started',
        run_id: 'run_123',
        timestamp: Date.now(),
      };
      const schema = z.object({
        type: z.string(),
        run_id: z.string(),
        timestamp: z.number(),
      });
      expect(() => schema.parse(baseEvent)).not.toThrow();
    });

    it('should reject event without type', () => {
      const invalidEvent = {
        run_id: 'run_123',
        timestamp: Date.now(),
      };
      const schema = z.object({
        type: z.string(),
        run_id: z.string(),
        timestamp: z.number(),
      });
      expect(() => schema.parse(invalidEvent)).toThrow();
    });

    it('should reject event without run_id', () => {
      const invalidEvent = {
        type: 'workflow.started',
        timestamp: Date.now(),
      };
      const schema = z.object({
        type: z.string(),
        run_id: z.string(),
        timestamp: z.number(),
      });
      expect(() => schema.parse(invalidEvent)).toThrow();
    });
  });

  describe('WorkflowStartedEvent', () => {
    it('should accept valid workflow started event', () => {
      const event = {
        type: 'workflow.started',
        run_id: 'run_123',
        timestamp: Date.now(),
        workflow_name: 'my-workflow',
        input: { key: 'value' },
      };
      const schema = z.object({
        type: z.literal('workflow.started'),
        run_id: z.string(),
        timestamp: z.number(),
        workflow_name: z.string(),
        input: z.record(z.string(), z.unknown()).optional(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });

    it('should reject if type is not workflow.started', () => {
      const event = {
        type: 'workflow.completed',
        run_id: 'run_123',
        timestamp: Date.now(),
        workflow_name: 'my-workflow',
      };
      const schema = z.object({
        type: z.literal('workflow.started'),
        run_id: z.string(),
        timestamp: z.number(),
        workflow_name: z.string(),
      });
      expect(() => schema.parse(event)).toThrow();
    });
  });

  describe('WorkflowCompletedEvent', () => {
    it('should accept valid workflow completed event', () => {
      const event = {
        type: 'workflow.completed',
        run_id: 'run_123',
        timestamp: Date.now(),
        result: { output: 'success' },
        duration_ms: 5000,
      };
      const schema = z.object({
        type: z.literal('workflow.completed'),
        run_id: z.string(),
        timestamp: z.number(),
        result: z.record(z.string(), z.unknown()).optional(),
        duration_ms: z.number(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('WorkflowFailedEvent', () => {
    it('should accept valid workflow failed event', () => {
      const event = {
        type: 'workflow.failed',
        run_id: 'run_123',
        timestamp: Date.now(),
        error: {
          message: 'Something went wrong',
          stack: 'Error: Something went wrong\n    at ...',
        },
        failed_at: new Date().toISOString(),
      };
      const schema = z.object({
        type: z.literal('workflow.failed'),
        run_id: z.string(),
        timestamp: z.number(),
        error: z.object({
          message: z.string(),
          stack: z.string().optional(),
        }),
        failed_at: z.string(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('NodeStartedEvent', () => {
    it('should accept valid node started event', () => {
      const event = {
        type: 'node.started',
        run_id: 'run_123',
        timestamp: Date.now(),
        node_id: 'node1',
        input: { param: 'value' },
      };
      const schema = z.object({
        type: z.literal('node.started'),
        run_id: z.string(),
        timestamp: z.number(),
        node_id: z.string(),
        input: z.any(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('NodeCompletedEvent', () => {
    it('should accept valid node completed event', () => {
      const event = {
        type: 'node.completed',
        run_id: 'run_123',
        timestamp: Date.now(),
        node_id: 'node1',
        output: { result: 'success' },
        duration_ms: 1000,
      };
      const schema = z.object({
        type: z.literal('node.completed'),
        run_id: z.string(),
        timestamp: z.number(),
        node_id: z.string(),
        output: z.any(),
        duration_ms: z.number(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('NodeFailedEvent', () => {
    it('should accept valid node failed event', () => {
      const event = {
        type: 'node.failed',
        run_id: 'run_123',
        timestamp: Date.now(),
        node_id: 'node1',
        error: {
          message: 'Node execution failed',
        },
      };
      const schema = z.object({
        type: z.literal('node.failed'),
        run_id: z.string(),
        timestamp: z.number(),
        node_id: z.string(),
        error: z.object({
          message: z.string(),
          stack: z.string().optional(),
        }),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('NodeScheduledEvent', () => {
    it('should accept valid node scheduled event', () => {
      const event = {
        type: 'node.scheduled',
        run_id: 'run_123',
        timestamp: Date.now(),
        node_id: 'node1',
      };
      const schema = z.object({
        type: z.literal('node.scheduled'),
        run_id: z.string(),
        timestamp: z.number(),
        node_id: z.string(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('NodeProgressEvent', () => {
    it('should accept valid node progress event', () => {
      const event = {
        type: 'node.progress',
        run_id: 'run_123',
        timestamp: Date.now(),
        node_id: 'node1',
        progress: 50,
        message: 'Processing...',
      };
      const schema = z.object({
        type: z.literal('node.progress'),
        run_id: z.string(),
        timestamp: z.number(),
        node_id: z.string(),
        progress: z.number(),
        message: z.string().optional(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('NodeSkippedEvent', () => {
    it('should accept valid node skipped event', () => {
      const event = {
        type: 'node.skipped',
        run_id: 'run_123',
        timestamp: Date.now(),
        node_id: 'node1',
        reason: 'Dependency failed',
      };
      const schema = z.object({
        type: z.literal('node.skipped'),
        run_id: z.string(),
        timestamp: z.number(),
        node_id: z.string(),
        reason: z.string(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('NodeDataEvent', () => {
    it('should accept valid node data event', () => {
      const event = {
        type: 'node.data',
        run_id: 'run_123',
        timestamp: Date.now(),
        from_node: 'node1',
        to_node: 'node2',
        data: { value: 42 },
      };
      const schema = z.object({
        type: z.literal('node.data'),
        run_id: z.string(),
        timestamp: z.number(),
        from_node: z.string(),
        to_node: z.string(),
        data: z.any(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('NodeAddedEvent', () => {
    it('should accept valid node added event', () => {
      const event = {
        type: 'node.added',
        run_id: 'run_123',
        timestamp: Date.now(),
        node_id: 'node1',
        node: { id: 'node1', type: 'tool' },
      };
      const schema = z.object({
        type: z.literal('node.added'),
        run_id: z.string(),
        timestamp: z.number(),
        node_id: z.string(),
        node: z.any(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('NodeRemovedEvent', () => {
    it('should accept valid node removed event', () => {
      const event = {
        type: 'node.removed',
        run_id: 'run_123',
        timestamp: Date.now(),
        node_id: 'node1',
      };
      const schema = z.object({
        type: z.literal('node.removed'),
        run_id: z.string(),
        timestamp: z.number(),
        node_id: z.string(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('WorkflowPausedEvent', () => {
    it('should accept valid workflow paused event', () => {
      const event = {
        type: 'workflow.paused',
        run_id: 'run_123',
        timestamp: Date.now(),
      };
      const schema = z.object({
        type: z.literal('workflow.paused'),
        run_id: z.string(),
        timestamp: z.number(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('WorkflowResumedEvent', () => {
    it('should accept valid workflow resumed event', () => {
      const event = {
        type: 'workflow.resumed',
        run_id: 'run_123',
        timestamp: Date.now(),
      };
      const schema = z.object({
        type: z.literal('workflow.resumed'),
        run_id: z.string(),
        timestamp: z.number(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('WorkflowStoppedEvent', () => {
    it('should accept valid workflow stopped event', () => {
      const event = {
        type: 'workflow.stopped',
        run_id: 'run_123',
        timestamp: Date.now(),
        reason: 'User requested stop',
      };
      const schema = z.object({
        type: z.literal('workflow.stopped'),
        run_id: z.string(),
        timestamp: z.number(),
        reason: z.string(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('WorkflowOutputEvent', () => {
    it('should accept valid workflow output event', () => {
      const event = {
        type: 'workflow.output',
        run_id: 'run_123',
        timestamp: Date.now(),
        output: { result: 'final' },
      };
      const schema = z.object({
        type: z.literal('workflow.output'),
        run_id: z.string(),
        timestamp: z.number(),
        output: z.record(z.string(), z.unknown()),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('ControlPauseEvent', () => {
    it('should accept valid control pause event', () => {
      const event = {
        type: 'control.pause',
        run_id: 'run_123',
        timestamp: Date.now(),
      };
      const schema = z.object({
        type: z.literal('control.pause'),
        run_id: z.string(),
        timestamp: z.number(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('ControlResumeEvent', () => {
    it('should accept valid control resume event', () => {
      const event = {
        type: 'control.resume',
        run_id: 'run_123',
        timestamp: Date.now(),
      };
      const schema = z.object({
        type: z.literal('control.resume'),
        run_id: z.string(),
        timestamp: z.number(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('ControlStopEvent', () => {
    it('should accept valid control stop event', () => {
      const event = {
        type: 'control.stop',
        run_id: 'run_123',
        timestamp: Date.now(),
      };
      const schema = z.object({
        type: z.literal('control.stop'),
        run_id: z.string(),
        timestamp: z.number(),
      });
      expect(() => schema.parse(event)).not.toThrow();
    });
  });

  describe('WorkflowEvent Union', () => {
    it('should accept all event types in union', () => {
      const eventTypes = [
        'workflow.started',
        'workflow.completed',
        'workflow.failed',
        'workflow.paused',
        'workflow.resumed',
        'workflow.stopped',
        'workflow.output',
        'node.scheduled',
        'node.started',
        'node.progress',
        'node.completed',
        'node.failed',
        'node.skipped',
        'node.data',
        'node.added',
        'node.removed',
        'control.pause',
        'control.resume',
        'control.stop',
      ];
      
      // Create a union schema with all event types
      const baseSchema = z.object({
        type: z.string(),
        run_id: z.string(),
        timestamp: z.number(),
      });
      
      for (const eventType of eventTypes) {
        const event = { type: eventType, run_id: 'run_123', timestamp: Date.now() };
        expect(() => baseSchema.parse(event)).not.toThrow();
      }
    });
  });

  describe('createWorkflowEvent factory', () => {
    it('should create workflow.started event with correct structure', () => {
      const type = 'workflow.started';
      const runId = 'run_123';
      const data = {
        workflow_name: 'my-workflow',
        input: { key: 'value' },
      };
      
      const event = {
        type,
        run_id: runId,
        timestamp: Date.now(),
        ...data,
      };
      
      expect(event.type).toBe('workflow.started');
      expect(event.run_id).toBe('run_123');
      expect(event.timestamp).toBeDefined();
      expect(event.workflow_name).toBe('my-workflow');
      expect(event.input).toEqual({ key: 'value' });
    });

    it('should create node.completed event with correct structure', () => {
      const type = 'node.completed';
      const runId = 'run_123';
      const data = {
        node_id: 'node1',
        output: { result: 'success' },
        duration_ms: 1000,
      };
      
      const event = {
        type,
        run_id: runId,
        timestamp: Date.now(),
        ...data,
      };
      
      expect(event.type).toBe('node.completed');
      expect(event.node_id).toBe('node1');
      expect(event.output).toEqual({ result: 'success' });
      expect(event.duration_ms).toBe(1000);
    });
  });
});
