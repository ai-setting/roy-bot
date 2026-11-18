import { describe, it, expect } from 'vitest';
import { 
  inferNextNode,
  findLastInterruptMessage,
  findLastCallMessage,
  parseNodeOutputs,
  extractResumeInfo,
  resolveAgentSessionId,
  enrichResumeInfoWithAgentSessions,
  enrichResumePointWithAgentSessions,
  type ResumePoint,
} from './session-recovery';

// Mock SessionMessage type
interface MockMessage {
  role: string;
  content: string;
  metadata: Record<string, unknown>;
}

function createMessage(role: string, content: string, metadata: Record<string, unknown>): MockMessage {
  return { role, content, metadata };
}

describe('inferNextNode', () => {
  describe('when no messages', () => {
    it('should return entry node from definition', () => {
      const messages: MockMessage[] = [];
      const definition = {
        entryNode: 'node_A',
        nodes: { node_A: { id: 'node_A' } },
      };
      
      const result = inferNextNode(messages as any, definition);
      
      expect(result.type).toBe('entry_node');
      expect(result.nodeId).toBe('node_A');
    });
    
    it('should handle missing entryNode', () => {
      const messages: MockMessage[] = [];
      const definition = {};
      
      const result = inferNextNode(messages as any, definition);
      
      expect(result.type).toBe('entry_node');
      expect(result.nodeId).toBeUndefined();
    });
  });
  
  describe('when last message is workflow.node.call', () => {
    it('should return resume_node type with nodeId', () => {
      const messages = [
        createMessage('workflow.node.call', '{}', {
          type: 'workflow.node.call',
          workflowNodeId: 'node_A',
          workflowNodeType: 'tool',
        }),
      ];
      
      const result = inferNextNode(messages as any, {});
      
      expect(result.type).toBe('resume_node');
      expect(result.nodeId).toBe('node_A');
    });
    
    it('should include agentSessionId if present', () => {
      const messages = [
        createMessage('workflow.node.call', '{}', {
          type: 'workflow.node.call',
          workflowNodeId: 'agent_1',
          workflowNodeType: 'agent',
          agentSessionId: 'agent_agent_1_123',
        }),
      ];
      
      const result = inferNextNode(messages as any, {});
      
      expect(result.type).toBe('resume_node');
      expect(result.nodeId).toBe('agent_1');
      expect(result.agentSessionId).toBe('agent_agent_1_123');
    });
  });
  
  describe('when last message is workflow.node.interrupt', () => {
    it('should return ask_user type with nodeId', () => {
      const messages = [
        createMessage('workflow.node.interrupt', 'Continue?', {
          type: 'workflow.node.interrupt',
          workflowNodeId: 'ask_user_1',
          workflowNodeType: 'ask_user',
          query: 'Continue?',
        }),
      ];
      
      const result = inferNextNode(messages as any, {});
      
      expect(result.type).toBe('ask_user');
      expect(result.nodeId).toBe('ask_user_1');
    });
    
    it('should include agentSessionId if present', () => {
      const messages = [
        createMessage('workflow.node.interrupt', 'Confirm?', {
          type: 'workflow.node.interrupt',
          workflowNodeId: 'agent_1',
          workflowNodeType: 'agent',
          query: 'Confirm?',
          agentSessionId: 'agent_agent_1_456',
        }),
      ];
      
      const result = inferNextNode(messages as any, {});
      
      expect(result.type).toBe('ask_user');
      expect(result.nodeId).toBe('agent_1');
      expect(result.agentSessionId).toBe('agent_agent_1_456');
    });
  });
  
  describe('when last message is workflow.node.result', () => {
    it('should return next_nodes from DAG edges', () => {
      const messages = [
        createMessage('workflow.node.call', '{}', {
          type: 'workflow.node.call',
          workflowNodeId: 'node_A',
        }),
        createMessage('workflow.node.result', '{"output":"done"}', {
          type: 'workflow.node.result',
          workflowNodeId: 'node_A',
          workflowNodeType: 'tool',
          success: true,
        }),
      ];
      
      const definition = {
        edges: [
          { from: 'node_A', to: 'node_B' },
          { from: 'node_A', to: 'node_C' },
        ],
      };
      
      const result = inferNextNode(messages as any, definition);
      
      expect(result.type).toBe('next_nodes');
      expect(result.nodeIds).toEqual(['node_B', 'node_C']);
    });
    
    it('should return empty array if no edges from node', () => {
      const messages = [
        createMessage('workflow.node.result', '{"output":"done"}', {
          type: 'workflow.node.result',
          workflowNodeId: 'node_A',
          success: true,
        }),
      ];
      
      const definition = {
        edges: [
          { from: 'node_B', to: 'node_C' },
        ],
      };
      
      const result = inferNextNode(messages as any, definition);
      
      expect(result.type).toBe('next_nodes');
      expect(result.nodeIds).toEqual([]);
    });
    
    it('should return empty array if no edges defined', () => {
      const messages = [
        createMessage('workflow.node.result', '{"output":"done"}', {
          type: 'workflow.node.result',
          workflowNodeId: 'node_A',
          success: true,
        }),
      ];
      
      const result = inferNextNode(messages as any, {});
      
      expect(result.type).toBe('next_nodes');
      expect(result.nodeIds).toEqual([]);
    });
  });
  
  describe('when last message has unknown type', () => {
    it('should find last call message and resume', () => {
      const messages = [
        createMessage('user', 'hello', {}),
        createMessage('workflow.node.call', '{}', {
          type: 'workflow.node.call',
          workflowNodeId: 'node_A',
        }),
        createMessage('system', 'some status', {
          type: 'unknown',
        }),
      ];
      
      const result = inferNextNode(messages as any, {});
      
      expect(result.type).toBe('resume_node');
      expect(result.nodeId).toBe('node_A');
    });
    
    it('should fallback to entry node if no call found', () => {
      const messages = [
        createMessage('user', 'hello', {}),
      ];
      
      const definition = { entryNode: 'start' };
      
      const result = inferNextNode(messages as any, definition);
      
      expect(result.type).toBe('entry_node');
      expect(result.nodeId).toBe('start');
    });
  });
});

describe('findLastInterruptMessage', () => {
  it('should return last interrupt message', () => {
    const messages = [
      createMessage('workflow.node.call', '{}', { type: 'workflow.node.call' }),
      createMessage('workflow.node.result', '{}', { type: 'workflow.node.result' }),
      createMessage('workflow.node.interrupt', 'Continue?', { 
        type: 'workflow.node.interrupt',
        workflowNodeId: 'ask_1',
      }),
    ];
    
    const result = findLastInterruptMessage(messages as any);
    
    expect(result).not.toBeNull();
    expect(result!.metadata.workflowNodeId).toBe('ask_1');
  });
  
  it('should return null if no interrupt message', () => {
    const messages = [
      createMessage('workflow.node.call', '{}', { type: 'workflow.node.call' }),
      createMessage('workflow.node.result', '{}', { type: 'workflow.node.result' }),
    ];
    
    const result = findLastInterruptMessage(messages as any);
    
    expect(result).toBeNull();
  });
  
  it('should return null for empty array', () => {
    const result = findLastInterruptMessage([]);
    expect(result).toBeNull();
  });
});

describe('findLastCallMessage', () => {
  it('should return last call message', () => {
    const messages = [
      createMessage('workflow.node.call', '{}', { 
        type: 'workflow.node.call',
        workflowNodeId: 'node_A',
      }),
      createMessage('workflow.node.call', '{}', { 
        type: 'workflow.node.call',
        workflowNodeId: 'node_B',
      }),
    ];
    
    const result = findLastCallMessage(messages as any);
    
    expect(result).not.toBeNull();
    expect(result!.metadata.workflowNodeId).toBe('node_B');
  });
  
  it('should return null if no call message', () => {
    const messages = [
      createMessage('user', 'hello', {}),
      createMessage('workflow.node.result', '{}', { type: 'workflow.node.result' }),
    ];
    
    const result = findLastCallMessage(messages as any);
    
    expect(result).toBeNull();
  });
});

describe('parseNodeOutputs', () => {
  it('should parse outputs from call-result pairs', () => {
    const messages = [
      createMessage('workflow.node.call', '{}', { 
        type: 'workflow.node.call',
        workflowNodeId: 'node_A',
      }),
      createMessage('workflow.node.result', '{"output":"result_A"}', { 
        type: 'workflow.node.result',
        workflowNodeId: 'node_A',
      }),
      createMessage('workflow.node.call', '{}', { 
        type: 'workflow.node.call',
        workflowNodeId: 'node_B',
      }),
      createMessage('workflow.node.result', '{"output":"result_B"}', { 
        type: 'workflow.node.result',
        workflowNodeId: 'node_B',
      }),
    ];
    
    const result = parseNodeOutputs(messages as any);
    
    expect(result.get('node_A')).toEqual({ output: 'result_A' });
    expect(result.get('node_B')).toEqual({ output: 'result_B' });
  });
  
  it('should handle JSON parse error gracefully', () => {
    const messages = [
      createMessage('workflow.node.call', '{}', { 
        type: 'workflow.node.call',
        workflowNodeId: 'node_A',
      }),
      createMessage('workflow.node.result', 'not json', { 
        type: 'workflow.node.result',
        workflowNodeId: 'node_A',
      }),
    ];
    
    const result = parseNodeOutputs(messages as any);
    
    expect(result.get('node_A')).toBe('not json');
  });
  
  it('should return empty map for no outputs', () => {
    const messages = [
      createMessage('user', 'hello', {}),
    ];
    
    const result = parseNodeOutputs(messages as any);
    
    expect(result.size).toBe(0);
  });
});

describe('resolveAgentSessionId', () => {
  const agentSessions = [
    { nodeId: 'agent-confirm', sessionId: 'agent_confirm_123', status: 'active' as const },
    { nodeId: 'other-node', sessionId: 'agent_other_456', status: 'active' as const },
  ];

  it('should prefer explicit agentSessionId from messages', () => {
    expect(resolveAgentSessionId('agent-confirm', 'explicit_session', agentSessions)).toBe('explicit_session');
  });

  it('should fall back to metadata.agentSessions by nodeId', () => {
    expect(resolveAgentSessionId('agent-confirm', undefined, agentSessions)).toBe('agent_confirm_123');
  });

  it('should return undefined when no match', () => {
    expect(resolveAgentSessionId('missing-node', undefined, agentSessions)).toBeUndefined();
  });
});

describe('enrichResumeInfoWithAgentSessions', () => {
  it('should fill agentSessionId from metadata when interrupt lacks it', () => {
    const messages = [
      createMessage('workflow.node.interrupt', 'Continue?', {
        type: 'workflow.node.interrupt',
        workflowNodeId: 'agent-confirm',
        workflowNodeType: 'agent',
        query: 'Continue?',
      }),
    ];

    const resumeInfo = enrichResumeInfoWithAgentSessions(extractResumeInfo(messages as any), [
      { nodeId: 'agent-confirm', sessionId: 'agent_from_metadata', status: 'active' },
    ]);

    expect(resumeInfo.pendingNodeId).toBe('agent-confirm');
    expect(resumeInfo.agentSessionId).toBe('agent_from_metadata');
    expect(resumeInfo.hasInterrupt).toBe(true);
  });
});

describe('enrichResumePointWithAgentSessions', () => {
  it('should fill agentSessionId on ask_user resume point', () => {
    const resumePoint: ResumePoint = {
      type: 'ask_user',
      nodeId: 'agent-confirm',
    };

    const enriched = enrichResumePointWithAgentSessions(resumePoint, [
      { nodeId: 'agent-confirm', sessionId: 'agent_from_metadata', status: 'active' },
    ]);

    expect(enriched.agentSessionId).toBe('agent_from_metadata');
  });
});
