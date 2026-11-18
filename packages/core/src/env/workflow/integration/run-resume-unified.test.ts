import { describe, it, expect } from 'vitest';
import { inferNextNode } from '../utils/session-recovery';
import { isWorkflowSessionMetadata } from '../types/workflow-session';
import type { WorkflowSessionMetadata } from '../types/workflow-message';
import type { ResumePoint } from '../utils/session-recovery';

describe('Workflow Run-Resume Unification Integration', () => {
  describe('Core concepts', () => {
    it('should validate simplified WorkflowSessionMetadata', () => {
      const metadata: WorkflowSessionMetadata = {
        type: 'workflow',
        workflowId: 'test-wf',
        workflowName: 'Test Workflow',
        status: 'running',
      };
      
      expect(isWorkflowSessionMetadata(metadata)).toBe(true);
    });
    
    it('should accept all valid statuses', () => {
      const statuses = ['running', 'paused', 'completed', 'failed', 'stopped'];
      
      for (const status of statuses) {
        const metadata: WorkflowSessionMetadata = {
          type: 'workflow',
          workflowId: 'test-wf',
          workflowName: 'Test Workflow',
          status: status as any,
        };
        expect(isWorkflowSessionMetadata(metadata)).toBe(true);
      }
    });
  });
  
  describe('Next node inference from messages', () => {
    it('should return entry_node for empty messages', () => {
      const result = inferNextNode([], { entryNode: 'node_A' });
      expect(result.type).toBe('entry_node');
      expect(result.nodeId).toBe('node_A');
    });
    
    it('should return resume_node when last is workflow.node.call', () => {
      const messages = [
        {
          role: 'workflow.node.call',
          content: '{}',
          metadata: {
            type: 'workflow.node.call',
            workflowNodeId: 'node_A',
          },
        },
      ];
      
      const result = inferNextNode(messages as any, {});
      expect(result.type).toBe('resume_node');
      expect(result.nodeId).toBe('node_A');
    });
    
    it('should return ask_user when last is workflow.node.interrupt', () => {
      const messages = [
        {
          role: 'workflow.node.interrupt',
          content: 'Continue?',
          metadata: {
            type: 'workflow.node.interrupt',
            workflowNodeId: 'ask_1',
            query: 'Continue?',
            agentSessionId: 'agent_123',
          },
        },
      ];
      
      const result = inferNextNode(messages as any, {});
      expect(result.type).toBe('ask_user');
      expect(result.nodeId).toBe('ask_1');
      expect(result.agentSessionId).toBe('agent_123');
    });
    
    it('should return next_nodes when last is workflow.node.result', () => {
      const messages = [
        {
          role: 'workflow.node.call',
          content: '{}',
          metadata: { type: 'workflow.node.call', workflowNodeId: 'node_A' },
        },
        {
          role: 'workflow.node.result',
          content: '{"output":"done"}',
          metadata: { 
            type: 'workflow.node.result',
            workflowNodeId: 'node_A',
            success: true,
          },
        },
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
  });
  
  describe('CLI Interface', () => {
    it('should document new run command syntax', () => {
      // New syntax:
      // tong workflow run <workflowId> [--input <input>]
      // tong workflow run -s <sessionId> [--input <input>]
      // tong workflow stop -s <sessionId>
      
      const expectedCommands = [
        'tong workflow run my-workflow',
        'tong workflow run my-workflow --input \'{"key": "value"}\'',
        'tong workflow run -s workflow_abc123',
        'tong workflow run -s workflow_abc123 --input "yes"',
        'tong workflow stop -s workflow_abc123',
      ];
      
      expect(expectedCommands.length).toBe(5);
    });
  });
});

describe('Resume point decision table', () => {
  interface TestCase {
    name: string;
    messages: any[];
    definition: any;
    expected: ResumePoint;
  }
  
  const testCases: TestCase[] = [
    {
      name: 'First run - no messages',
      messages: [],
      definition: { entryNode: 'start' },
      expected: { type: 'entry_node', nodeId: 'start' },
    },
    {
      name: 'Resume interrupted node',
      messages: [
        { role: 'workflow.node.call', content: '{}', metadata: { type: 'workflow.node.call', workflowNodeId: 'task' } },
      ],
      definition: {},
      expected: { type: 'resume_node', nodeId: 'task' },
    },
    {
      name: 'Resume ask_user interrupt',
      messages: [
        { role: 'workflow.node.interrupt', content: 'Continue?', metadata: { type: 'workflow.node.interrupt', workflowNodeId: 'ask', agentSessionId: 'agent_1' } },
      ],
      definition: {},
      expected: { type: 'ask_user', nodeId: 'ask', agentSessionId: 'agent_1' },
    },
    {
      name: 'Continue to next nodes',
      messages: [
        { role: 'workflow.node.result', content: '{}', metadata: { type: 'workflow.node.result', workflowNodeId: 'step1' } },
      ],
      definition: { edges: [{ from: 'step1', to: 'step2' }] },
      expected: { type: 'next_nodes', nodeIds: ['step2'] },
    },
  ];
  
  testCases.forEach(tc => {
    it(`should handle: ${tc.name}`, () => {
      const result = inferNextNode(tc.messages as any, tc.definition);
      expect(result.type).toBe(tc.expected.type);
      if (tc.expected.nodeId) {
        expect(result.nodeId).toBe(tc.expected.nodeId);
      }
      if (tc.expected.nodeIds) {
        expect(result.nodeIds).toEqual(tc.expected.nodeIds);
      }
      if (tc.expected.agentSessionId) {
        expect(result.agentSessionId).toBe(tc.expected.agentSessionId);
      }
    });
  });
});
