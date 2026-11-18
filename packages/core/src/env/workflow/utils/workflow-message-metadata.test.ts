import { describe, it, expect } from 'vitest';
import {
  getWorkflowNodeIdFromMetadata,
  buildWorkflowNodeMetadata,
  patchAgentSessionIdOnMessage,
} from './workflow-message-metadata';

describe('workflow-message-metadata', () => {
  describe('getWorkflowNodeIdFromMetadata', () => {
    it('should prefer nodeId when both are present', () => {
      expect(getWorkflowNodeIdFromMetadata({ nodeId: 'a', workflowNodeId: 'b' })).toBe('a');
    });

    it('should fall back to workflowNodeId', () => {
      expect(getWorkflowNodeIdFromMetadata({ workflowNodeId: 'agent-confirm' })).toBe('agent-confirm');
    });

    it('should return undefined for empty metadata', () => {
      expect(getWorkflowNodeIdFromMetadata(undefined)).toBeUndefined();
    });
  });

  describe('buildWorkflowNodeMetadata', () => {
    it('should include nodeId and workflowNodeId aliases', () => {
      const meta = buildWorkflowNodeMetadata('workflow.node.interrupt', 'agent-confirm', 'agent', {
        query: 'Proceed?',
        agentSessionId: 'agent_sub_1',
      });

      expect(meta).toEqual({
        _workflowNodeMetadata: true,
        type: 'workflow.node.interrupt',
        nodeId: 'agent-confirm',
        workflowNodeId: 'agent-confirm',
        workflowNodeType: 'agent',
        query: 'Proceed?',
        agentSessionId: 'agent_sub_1',
      });
    });
  });

  describe('patchAgentSessionIdOnMessage', () => {
    it('should patch metadata and parts with agentSessionId', () => {
      const { metadata, parts } = patchAgentSessionIdOnMessage(
        { type: 'workflow.node.start', nodeId: 'agent-confirm' },
        [{ type: 'workflow-node-start', nodeId: 'agent-confirm', nodeType: 'agent' }],
        'agent_sub_1'
      );

      expect(metadata.agentSessionId).toBe('agent_sub_1');
      expect(parts?.[0]).toMatchObject({ agentSessionId: 'agent_sub_1' });
    });
  });
});
