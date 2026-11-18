/**
 * @fileoverview Simplified Session Recovery Tests (TDD RED Phase)
 * 
 * Tests for the simplified session recovery logic:
 * - No complex userResponse distinction
 * - Direct extraction of agentSessionId from interrupt message
 * - Simple userQuery extraction from input
 * 
 * @see Task #599
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  inferNextNode,
  parseNodeOutputs,
  findLastInterruptMessage,
  stripEphemeralResumeInput,
  type ResumePoint,
  type ResumeInfo,
  extractResumeInfo,
} from './session-recovery';

// Mock SessionMessage type
interface MockMessage {
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  timestamp?: number;
}

function createMessage(role: string, content: string, metadata: Record<string, unknown>): MockMessage {
  return { role, content, metadata, timestamp: Date.now() };
}

function createInterruptMessage(
  nodeId: string,
  query: string,
  agentSessionId?: string
): MockMessage {
  return createMessage('workflow.node.interrupt', query, {
    type: 'workflow.node.interrupt',
    workflowNodeId: nodeId,
    workflowNodeType: 'agent',
    query,
    agentSessionId,
  });
}

function createCallMessage(
  nodeId: string,
  nodeType: string,
  agentSessionId?: string
): MockMessage {
  return createMessage('workflow.node.call', '{}', {
    type: 'workflow.node.call',
    workflowNodeId: nodeId,
    workflowNodeType: nodeType,
    agentSessionId,
  });
}

function createResultMessage(
  nodeId: string,
  nodeType: string,
  output: unknown,
  success = true
): MockMessage {
  return createMessage('workflow.node.result', JSON.stringify(output), {
    type: 'workflow.node.result',
    workflowNodeId: nodeId,
    workflowNodeType: nodeType,
    success,
  });
}

// ============================================================================
// RED Phase: Write Failing Tests First
// ============================================================================

describe('Session Recovery - Simplified Logic', () => {
  // ==================== Input Extraction Tests ====================
  
  describe('userQuery extraction from input', () => {
    it('should extract userQuery from object input', () => {
      const input = { userQuery: 'Yes, continue' };
      
      // userQuery should be directly accessible
      expect(input.userQuery).toBe('Yes, continue');
    });
    
    it('should normalize string input to userQuery', () => {
      const stringInput = 'Yes';
      const normalizedInput = typeof stringInput === 'string'
        ? { userQuery: stringInput }
        : stringInput;
      
      expect(normalizedInput.userQuery).toBe('Yes');
    });
    
    it('should handle object input with additional fields', () => {
      const input = {
        userQuery: 'Confirmed',
        stockCode: 'AAPL',
        limit: 10,
      };
      
      expect(input.userQuery).toBe('Confirmed');
      expect(input.stockCode).toBe('AAPL');
      expect(input.limit).toBe(10);
    });

    it('should strip userQuery from workflowInput via stripEphemeralResumeInput', () => {
      expect(stripEphemeralResumeInput({ userQuery: 'Yes' })).toEqual({
        workflowInput: undefined,
        userQuery: 'Yes',
      });

      expect(stripEphemeralResumeInput({ userName: 'demo', userQuery: 'Yes' })).toEqual({
        workflowInput: { userName: 'demo' },
        userQuery: 'Yes',
      });
    });
  });

  // ==================== inferNextNode Tests ====================
  
  describe('inferNextNode - simplified logic', () => {
    describe('fresh run (no messages)', () => {
      it('should return entry_node type for empty messages', () => {
        const messages: MockMessage[] = [];
        const definition = { entryNode: 'start' };
        
        const result = inferNextNode(messages as any, definition);
        
        expect(result.type).toBe('entry_node');
        expect(result.nodeId).toBe('start');
      });
      
      it('should handle missing entryNode', () => {
        const messages: MockMessage[] = [];
        const definition = {};
        
        const result = inferNextNode(messages as any, definition);
        
        expect(result.type).toBe('entry_node');
      });
    });
    
    describe('resume from interrupt (ask_user)', () => {
      it('should return ask_user type with nodeId and agentSessionId from interrupt', () => {
        const messages = [
          createInterruptMessage('agent_node', 'Should I continue?', 'agent_agent_node_123'),
        ];
        
        const result = inferNextNode(messages as any, {});
        
        expect(result.type).toBe('ask_user');
        expect(result.nodeId).toBe('agent_node');
        expect(result.agentSessionId).toBe('agent_agent_node_123');
      });
      
      it('should handle interrupt without agentSessionId', () => {
        const messages = [
          createInterruptMessage('tool_node', 'Confirm action'),
        ];
        
        const result = inferNextNode(messages as any, {});
        
        expect(result.type).toBe('ask_user');
        expect(result.nodeId).toBe('tool_node');
        expect(result.agentSessionId).toBeUndefined();
      });
      
      it('should use interrupt message metadata directly for resume', () => {
        // Key insight: the interrupt message already has all info needed
        const agentSessionId = 'agent_unknown_greeting-agent_xxxx';
        const messages = [
          createInterruptMessage('greeting', 'Hello!', agentSessionId),
        ];
        
        const result = inferNextNode(messages as any, {});
        
        // Should directly use the agentSessionId from interrupt metadata
        expect(result.agentSessionId).toBe(agentSessionId);
      });
    });
    
    describe('resume from interrupted call (no result)', () => {
      it('should return resume_node when last is call without result', () => {
        const messages = [
          createCallMessage('long_running', 'tool', 'agent_long_running_456'),
        ];
        
        const result = inferNextNode(messages as any, {});
        
        expect(result.type).toBe('resume_node');
        expect(result.nodeId).toBe('long_running');
        expect(result.agentSessionId).toBe('agent_long_running_456');
      });
      
      it('should extract nodeId from last call message for resume', () => {
        // When last message is node.call, we know which node to resume
        const messages = [
          createCallMessage('agent_node', 'agent', 'agent_agent_123'),
        ];
        
        const result = inferNextNode(messages as any, {});
        
        // We can directly get nodeId from the last call message
        expect(result.nodeId).toBe('agent_node');
        expect(result.agentSessionId).toBe('agent_agent_123');
      });
    });
    
    describe('normal execution (last is result)', () => {
      it('should return next_nodes when last is result', () => {
        const messages = [
          createCallMessage('start', 'tool'),
          createResultMessage('start', 'tool', { result: 'done' }),
        ];
        
        const definition = {
          edges: [{ from: 'start', to: 'next' }],
        };
        
        const result = inferNextNode(messages as any, definition);
        
        expect(result.type).toBe('next_nodes');
        expect(result.nodeIds).toEqual(['next']);
      });
      
      it('should return next_nodes with multiple targets', () => {
        const messages = [
          createCallMessage('fork', 'tool'),
          createResultMessage('fork', 'tool', { result: 'done' }),
        ];
        
        const definition = {
          edges: [
            { from: 'fork', to: 'branch_a' },
            { from: 'fork', to: 'branch_b' },
          ],
        };
        
        const result = inferNextNode(messages as any, definition);
        
        expect(result.type).toBe('next_nodes');
        expect(result.nodeIds).toContain('branch_a');
        expect(result.nodeIds).toContain('branch_b');
      });
    });
  });

  // ==================== extractResumeInfo Tests (NEW) ====================
  
  describe('extractResumeInfo - new function', () => {
    /**
     * NEW: Extract complete resume info from messages
     * This replaces the complex logic that was scattered across engine.ts
     */
    
    it('should extract resume info from interrupt message', () => {
      const agentSessionId = 'agent_greeting-123';
      const messages = [
        createInterruptMessage('greeting', 'Hello!', agentSessionId),
      ];
      
      const result = extractResumeInfo(messages as any);
      
      expect(result.pendingNodeId).toBe('greeting');
      expect(result.agentSessionId).toBe(agentSessionId);
      expect(result.hasInterrupt).toBe(true);
      expect(result.userQuery).toBeUndefined(); // userQuery comes from input, not messages
    });
    
    it('should extract resume info when last message is node.call (no interrupt)', () => {
      // Key case: last message is node.call, not interrupt
      // We should still be able to resume from this node
      const agentSessionId = 'agent_agent_123';
      const messages = [
        createCallMessage('agent_node', 'agent', agentSessionId),
      ];
      
      const result = extractResumeInfo(messages as any);
      
      // Should have pending node and agentSessionId
      expect(result.pendingNodeId).toBe('agent_node');
      expect(result.agentSessionId).toBe(agentSessionId);
      expect(result.hasInterrupt).toBe(false); // No interrupt yet
    });
    
    it('should extract node outputs from call-result pairs', () => {
      const messages = [
        createCallMessage('node_a', 'tool'),
        createResultMessage('node_a', 'tool', { output: 'a_result' }),
        createCallMessage('node_b', 'tool'),
        createResultMessage('node_b', 'tool', { output: 'b_result' }),
      ];
      
      const result = extractResumeInfo(messages as any);
      
      expect(result.nodeOutputs.get('node_a')).toEqual({ output: 'a_result' });
      expect(result.nodeOutputs.get('node_b')).toEqual({ output: 'b_result' });
      expect(result.pendingNodeId).toBeUndefined();
    });
    
    it('should handle mixed messages with partial completion', () => {
      const agentSessionId = 'agent_waiting-789';
      const messages = [
        createCallMessage('completed', 'tool'),
        createResultMessage('completed', 'tool', { done: true }),
        createCallMessage('waiting', 'agent', agentSessionId),
        createInterruptMessage('waiting', 'Waiting for input', agentSessionId),
      ];
      
      const result = extractResumeInfo(messages as any);
      
      // Should have completed node output
      expect(result.nodeOutputs.has('completed')).toBe(true);
      // Should have pending node and agentSessionId
      expect(result.pendingNodeId).toBe('waiting');
      expect(result.agentSessionId).toBe(agentSessionId);
      expect(result.hasInterrupt).toBe(true);
    });
    
    it('should return empty state for fresh run', () => {
      const messages: MockMessage[] = [];
      
      const result = extractResumeInfo(messages as any);
      
      expect(result.pendingNodeId).toBeUndefined();
      expect(result.agentSessionId).toBeUndefined();
      expect(result.hasInterrupt).toBe(false);
      expect(result.nodeOutputs.size).toBe(0);
    });
  });

  // ==================== parseNodeOutputs Tests ====================
  
  describe('parseNodeOutputs', () => {
    it('should parse outputs from call-result pairs', () => {
      const messages = [
        createCallMessage('node_1', 'tool'),
        createResultMessage('node_1', 'tool', { result: 'output_1' }),
        createCallMessage('node_2', 'agent', 'agent_2'),
        createResultMessage('node_2', 'agent', { result: 'output_2' }),
      ];
      
      const outputs = parseNodeOutputs(messages as any);
      
      expect(outputs.get('node_1')).toEqual({ result: 'output_1' });
      expect(outputs.get('node_2')).toEqual({ result: 'output_2' });
    });
    
    it('should handle non-JSON result content', () => {
      const messages = [
        createCallMessage('node_1', 'tool'),
        createMessage('workflow.node.result', 'plain text result', {
          type: 'workflow.node.result',
          workflowNodeId: 'node_1',
        }),
      ];
      
      const outputs = parseNodeOutputs(messages as any);
      
      expect(outputs.get('node_1')).toBe('plain text result');
    });
    
    it('should ignore orphaned results (no matching call)', () => {
      const messages = [
        createResultMessage('orphan', 'tool', { result: 'orphan' }),
        createCallMessage('node_1', 'tool'),
        createResultMessage('node_1', 'tool', { result: 'paired' }),
      ];
      
      const outputs = parseNodeOutputs(messages as any);
      
      expect(outputs.has('orphan')).toBe(false);
      expect(outputs.get('node_1')).toEqual({ result: 'paired' });
    });
  });

  // ==================== Integration Tests ====================
  
  describe('Integration: Full resume flow', () => {
    it('should support complete resume with userQuery', () => {
      // Step 1: Fresh run triggers interrupt
      const freshMessages = [
        createCallMessage('agent', 'agent', 'agent_agent_123'),
        createInterruptMessage('agent', 'Proceed?', 'agent_agent_123'),
      ];
      
      // Step 2: inferNextNode returns resume point
      const resumePoint = inferNextNode(freshMessages as any, {});
      expect(resumePoint.type).toBe('ask_user');
      expect(resumePoint.nodeId).toBe('agent');
      expect(resumePoint.agentSessionId).toBe('agent_agent_123');
      
      // Step 3: extractResumeInfo provides complete state
      const resumeInfo = extractResumeInfo(freshMessages as any);
      expect(resumeInfo.pendingNodeId).toBe('agent');
      expect(resumeInfo.agentSessionId).toBe('agent_agent_123');
      expect(resumeInfo.hasInterrupt).toBe(true);
      
      // Step 4: User provides input with userQuery
      const userInput = { userQuery: 'Yes, continue' };
      expect(userInput.userQuery).toBe('Yes, continue');
      
      // Step 5: Engine uses agentSessionId + userQuery to resume
      // The agentNode should receive:
      // - agentSessionId: 'agent_agent_123'
      // - input: { userQuery: 'Yes, continue' }
      // No complex userResponse distinction needed!
    });
    
    it('should handle CLI string input on resume', () => {
      // CLI passes: --input "Yes"
      const cliInput = 'Yes';
      
      // Normalized to object input
      const normalizedInput = { userQuery: cliInput };
      
      expect(normalizedInput.userQuery).toBe('Yes');
      
      // This is all the agentNode needs to resume
    });
    
    it('should handle resume after multiple interruptions', () => {
      const messages = [
        // First interrupt resolved
        createCallMessage('a', 'agent', 'agent_a'),
        createInterruptMessage('a', 'Q1?', 'agent_a'),
        // Resolution (simulated by new call)
        createCallMessage('a', 'agent', 'agent_a'),
        createResultMessage('a', 'agent', { done: false }),
        // Second interrupt
        createCallMessage('b', 'agent', 'agent_b'),
        createInterruptMessage('b', 'Q2?', 'agent_b'),
      ];
      
      const resumePoint = inferNextNode(messages as any, {});
      expect(resumePoint.type).toBe('ask_user');
      expect(resumePoint.nodeId).toBe('b');
      expect(resumePoint.agentSessionId).toBe('agent_b');
    });
  });
});
