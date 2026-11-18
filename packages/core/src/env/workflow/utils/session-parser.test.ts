import { describe, it, expect } from 'bun:test';
import {
  findLastInterruptMessage,
  parseNodeOutputs,
  getNextPendingNode,
  getAgentSessionIdFromInterrupt,
  isWaitingForUser,
} from './session-parser';
import type { SessionMessage } from '../../session/types';

describe('session-parser', () => {
  const createMessage = (metadata: any, content = '{}'): SessionMessage => ({
    id: `msg_${Math.random()}`,
    sessionID: 'workflow_test',
    role: 'user' as any,
    content,
    timestamp: Date.now(),
    metadata,
  });
  
  describe('findLastInterruptMessage', () => {
    it('should return last interrupt message', () => {
      const messages: SessionMessage[] = [
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n1' }),
        createMessage({ type: 'workflow.node.end', workflowNodeId: 'n1' }),
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n2' }),
        createMessage({ type: 'workflow.node.interrupt', workflowNodeId: 'n2', query: 'Q1' }),
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n3' }),
        createMessage({ type: 'workflow.node.interrupt', workflowNodeId: 'n3', query: 'Q2' }),
      ];
      
      const result = findLastInterruptMessage(messages);
      expect(result?.metadata?.workflowNodeId).toBe('n3');
    });
    
    it('should return null if no interrupt', () => {
      const messages: SessionMessage[] = [
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n1' }),
        createMessage({ type: 'workflow.node.end', workflowNodeId: 'n1' }),
      ];
      
      expect(findLastInterruptMessage(messages)).toBeNull();
    });
  });
  
  describe('parseNodeOutputs', () => {
    it('should parse all node outputs', () => {
      const messages: SessionMessage[] = [
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n1' }),
        createMessage({ type: 'workflow.node.end', workflowNodeId: 'n1' }, '{"result":"output1"}'),
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n2' }),
        createMessage({ type: 'workflow.node.end', workflowNodeId: 'n2' }, '{"result":"output2"}'),
      ];
      
      const outputs = parseNodeOutputs(messages);
      expect(outputs.get('n1')).toEqual({ result: 'output1' });
      expect(outputs.get('n2')).toEqual({ result: 'output2' });
    });
  });
  
  describe('getNextPendingNode', () => {
    it('should return last incomplete node', () => {
      const messages: SessionMessage[] = [
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n1' }),
        createMessage({ type: 'workflow.node.end', workflowNodeId: 'n1' }, '{"o":"1"}'),
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n2' }),
        // n2 没有 end，所以是 pending
      ];
      
      expect(getNextPendingNode(messages)).toBe('n2');
    });
  });
  
  describe('getAgentSessionIdFromInterrupt', () => {
    it('should return agentSessionId from interrupt', () => {
      const msg = createMessage({
        type: 'workflow.node.interrupt',
        workflowNodeId: 'n1',
        agentSessionId: 'agent_123',
      });
      
      expect(getAgentSessionIdFromInterrupt(msg)).toBe('agent_123');
    });
    
    it('should return undefined if not interrupt', () => {
      const msg = createMessage({ type: 'workflow.node.start' });
      expect(getAgentSessionIdFromInterrupt(msg)).toBeUndefined();
    });
  });
  
  describe('isWaitingForUser', () => {
    it('should return true if interrupt without resume', () => {
      const messages: SessionMessage[] = [
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n1' }),
        createMessage({ type: 'workflow.node.interrupt', workflowNodeId: 'n1' }),
      ];
      
      expect(isWaitingForUser(messages)).toBe(true);
    });
    
    it('should return false if resume exists', () => {
      const messages: SessionMessage[] = [
        createMessage({ type: 'workflow.node.start', workflowNodeId: 'n1' }),
        createMessage({ type: 'workflow.node.interrupt', workflowNodeId: 'n1' }),
        createMessage({ type: 'workflow.node.resume', workflowNodeId: 'n1' }),
      ];
      
      expect(isWaitingForUser(messages)).toBe(false);
    });
  });
});
