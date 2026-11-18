import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Executor, ExecutorOptions } from './executor';
import { EventBus } from './event-bus';
import type { NodeRegistry } from './node-registry';

describe('Executor - agentSessionId in messages', () => {
  let executor: Executor;
  let mockSessionComponent: any;
  let addedMessages: any[] = [];
  
  beforeEach(() => {
    addedMessages = [];
    mockSessionComponent = {
      addMessage: vi.fn(async (sessionId: string, message: any) => {
        addedMessages.push({ sessionId, message });
      }),
    };
    
    executor = new Executor(
      {} as NodeRegistry,
      new EventBus(),
      {} as ExecutorOptions,
      mockSessionComponent
    );
  });
  
  describe('writeNodeStart', () => {
    it('should include agentSessionId in metadata when provided', async () => {
      await executor.writeNodeStart(
        'session-1',
        'agent_node',
        'agent',
        { input: 'test' },
        'agent_agent_node_123'
      );
      
      expect(addedMessages).toHaveLength(1);
      const metadata = addedMessages[0].message.metadata;
      expect(metadata.agentSessionId).toBe('agent_agent_node_123');
    });
    
    it('should not include agentSessionId in metadata when not provided', async () => {
      await executor.writeNodeStart(
        'session-1',
        'tool_node',
        'tool',
        { input: 'test' }
      );
      
      expect(addedMessages).toHaveLength(1);
      const metadata = addedMessages[0].message.metadata;
      expect(metadata.agentSessionId).toBeUndefined();
    });
  });
  
  describe('writeNodeInterrupt', () => {
    it('should include agentSessionId in metadata when provided', async () => {
      await executor.writeNodeInterrupt(
        'session-1',
        'ask_user',
        'ask_user',
        'Continue?',
        'agent_agent_node_456'
      );
      
      expect(addedMessages).toHaveLength(1);
      const metadata = addedMessages[0].message.metadata;
      expect(metadata.agentSessionId).toBe('agent_agent_node_456');
    });
    
    it('should not include agentSessionId in metadata when not provided', async () => {
      await executor.writeNodeInterrupt(
        'session-1',
        'ask_user',
        'ask_user',
        'Continue?'
      );
      
      expect(addedMessages).toHaveLength(1);
      const metadata = addedMessages[0].message.metadata;
      expect(metadata.agentSessionId).toBeUndefined();
    });
  });
});
