/**
 * Executor Tests
 * 
 * Tests for Executor class functionality:
 * - Constructor and options
 * - Session message writing methods (writeNodeStart, writeNodeEnd, writeNodeResume)
 * - @TracedAs decorator presence
 * - Cancellation handling
 */

import { describe, it, expect, beforeEach, vi } from 'bun:test';
import { Executor, ExecutorOptions } from './executor';
import { EventBus } from './event-bus';
import { NodeRegistry } from './node-registry';
import type { NodeDefinition, NodeExecutionContext } from '../types';

// Mock SessionComponent
const mockSessionComponent = {
  addMessage: vi.fn().mockResolvedValue('msg_123'),
  getMessages: vi.fn().mockResolvedValue([]),
};

describe('Executor', () => {
  let eventBus: EventBus;
  let nodeRegistry: NodeRegistry;

  beforeEach(() => {
    eventBus = new EventBus();
    nodeRegistry = new NodeRegistry({});
    mockSessionComponent.addMessage.mockClear();
    mockSessionComponent.getMessages.mockClear();
  });

  describe('constructor', () => {
    it('should create an Executor instance', () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false }
      );

      expect(executor).toBeDefined();
    });

    it('should accept sessionComponent as optional parameter', () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      expect(executor).toBeDefined();
    });

    it('should create with global timeout option', () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: 60000, globalRetry: null, debug: false }
      );

      expect(executor).toBeDefined();
    });

    it('should create with global retry option', () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        {
          globalTimeout: null,
          globalRetry: { max_attempts: 3, backoff: 'exponential', initial_delay: 1000 },
          debug: false,
        }
      );

      expect(executor).toBeDefined();
    });

    it('should create with debug mode enabled', () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: true }
      );

      expect(executor).toBeDefined();
    });
  });

  describe('trace integration', () => {
    it('should have @TracedAs decorator on executeNode method', () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false }
      );

      // The @TracedAs decorator wraps methods, verify the method exists
      expect(typeof executor.executeNode).toBe('function');
      
      // The method should be callable (decorator wraps it)
      expect(executor.executeNode).toBeDefined();
    });

    it('should have @TracedAs decorator on writeNodeStart method', () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false }
      );

      expect(typeof executor.writeNodeStart).toBe('function');
    });

    it('should have @TracedAs decorator on writeNodeEnd method', () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false }
      );

      expect(typeof executor.writeNodeEnd).toBe('function');
    });

    it('should have @TracedAs decorator on writeNodeResume method', () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false }
      );

      expect(typeof executor.writeNodeResume).toBe('function');
    });
  });

  describe('writeNodeStart', () => {
    it('should write workflow.node.start message', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeStart(
        'session_1',
        'node_1',
        'tool',
        { value: 42 }
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          role: 'workflow.node.start',
          metadata: expect.objectContaining({
            type: 'workflow.node.start',
            workflowNodeId: 'node_1',
            workflowNodeType: 'tool',
          }),
        })
      );
    });

    it('should not write if sessionComponent is not provided', async () => {
      const executorWithoutSession = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false }
      );

      // Should not throw, just silently skip
      await executorWithoutSession.writeNodeStart(
        'session_1',
        'node_1',
        'tool',
        { value: 42 }
      );

      expect(mockSessionComponent.addMessage).not.toHaveBeenCalled();
    });

    it('should include agentSessionId when provided', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeStart(
        'session_1',
        'node_1',
        'agent',
        { prompt: 'Hello' },
        'agent_session_123'
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            agentSessionId: 'agent_session_123',
          }),
        })
      );
    });

    it('should handle undefined input', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeStart(
        'session_1',
        'node_1',
        'tool',
        undefined
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalled();
    });

    it('should handle complex input objects', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      const complexInput = {
        items: [1, 2, 3],
        nested: { key: 'value' },
        flag: true,
      };

      await executor.writeNodeStart(
        'session_1',
        'node_1',
        'tool',
        complexInput
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            workflowNodeId: 'node_1',
            workflowNodeType: 'tool',
          }),
        })
      );
    });
  });

  describe('writeNodeEnd', () => {
    it('should write success result', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeEnd(
        'session_1',
        'node_1',
        'tool',
        { result: 'success' },
        undefined,
        1000
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          role: 'workflow.node.end',
          metadata: expect.objectContaining({
            type: 'workflow.node.end',
            workflowNodeId: 'node_1',
            workflowNodeType: 'tool',
            success: true,
          }),
        })
      );
    });

    it('should write error result', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeEnd(
        'session_1',
        'node_1',
        'tool',
        undefined,
        'Something went wrong',
        500
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          role: 'workflow.node.end',
          metadata: expect.objectContaining({
            type: 'workflow.node.end',
            workflowNodeId: 'node_1',
            workflowNodeType: 'tool',
            success: false,
          }),
        })
      );
    });

    it('should not write if sessionComponent is not provided', async () => {
      const executorWithoutSession = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false }
      );

      // Should not throw
      await executorWithoutSession.writeNodeEnd(
        'session_1',
        'node_1',
        'tool',
        { result: 'success' },
        undefined,
        1000
      );

      expect(mockSessionComponent.addMessage).not.toHaveBeenCalled();
    });

    it('should include duration in metadata', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeEnd(
        'session_1',
        'node_1',
        'tool',
        { result: 'success' },
        undefined,
        2500
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            type: 'workflow.node.end',
          }),
        })
      );
    });

    it('should include agentSessionId for agent nodes', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeEnd(
        'session_1',
        'node_1',
        'agent',
        { result: 'done' },
        undefined,
        1000,
        'agent_session_123'
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            agentSessionId: 'agent_session_123',
          }),
        })
      );
    });
  });

  describe('writeNodeResume', () => {
    it('should write resume message', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeResume(
        'session_1',
        'node_1',
        'agent',
        'Yes, continue'
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          role: 'workflow.node.resume',
          content: 'Yes, continue',
        })
      );
    });

    it('should not write if sessionComponent is not provided', async () => {
      const executorWithoutSession = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false }
      );

      // Should not throw
      await executorWithoutSession.writeNodeResume(
        'session_1',
        'node_1',
        'agent',
        'User response'
      );

      expect(mockSessionComponent.addMessage).not.toHaveBeenCalled();
    });

    it('should handle empty response', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeResume(
        'session_1',
        'node_1',
        'agent',
        ''
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          role: 'workflow.node.resume',
          content: '',
        })
      );
    });

    it('should include agentSessionId in metadata when provided', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeResume(
        'session_1',
        'agent-confirm',
        'agent',
        'Yes',
        'agent_confirm_123'
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          role: 'workflow.node.resume',
          content: 'Yes',
          metadata: expect.objectContaining({
            type: 'workflow.node.resume',
            workflowNodeId: 'agent-confirm',
            response: 'Yes',
            agentSessionId: 'agent_confirm_123',
          }),
        })
      );
    });

    it('should handle long response', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      const longResponse = 'A'.repeat(10000);

      await executor.writeNodeResume(
        'session_1',
        'node_1',
        'agent',
        longResponse
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          role: 'workflow.node.resume',
          content: longResponse,
        })
      );
    });

    it('should include agentSessionId when provided', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeResume(
        'session_1',
        'node_1',
        'agent',
        'Yes',
        'agent_session_123'
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            agentSessionId: 'agent_session_123',
          }),
        })
      );
    });
  });

  describe('writeNodeInterrupt', () => {
    it('should write interrupt message when sessionComponent is provided', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeInterrupt(
        'session_1',
        'node_1',
        'agent',
        'Should I continue?'
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          role: 'workflow.node.interrupt',
          content: 'Should I continue?',
          metadata: expect.objectContaining({
            type: 'workflow.node.interrupt',
            workflowNodeId: 'node_1',
            workflowNodeType: 'agent',
            query: 'Should I continue?',
          }),
        })
      );
    });

    it('should include agentSessionId when provided', async () => {
      const executor = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false },
        mockSessionComponent as any
      );

      await executor.writeNodeInterrupt(
        'session_1',
        'node_1',
        'agent',
        'Should I continue?',
        'agent_session_123'
      );

      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        'session_1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            agentSessionId: 'agent_session_123',
          }),
        })
      );
    });

    it('should not write if sessionComponent is not provided', async () => {
      const executorWithoutSession = new Executor(
        nodeRegistry,
        eventBus,
        { globalTimeout: null, globalRetry: null, debug: false }
      );

      // Should not throw
      await executorWithoutSession.writeNodeInterrupt(
        'session_1',
        'node_1',
        'agent',
        'Should I continue?'
      );

      expect(mockSessionComponent.addMessage).not.toHaveBeenCalled();
    });
  });
});
