/**
 * TDD: Workflow session metadata (P0/P1/P2) and unified message writing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Executor } from './executor';
import { EventBus } from './event-bus';
import { getWorkflowNodeIdFromMetadata } from '../utils/workflow-message-metadata';

describe('Executor workflow message metadata (P0)', () => {
  let mockSessionComponent: {
    addMessage: ReturnType<typeof vi.fn>;
    getMessages: ReturnType<typeof vi.fn>;
    updateMessage: ReturnType<typeof vi.fn>;
  };
  let executor: Executor;
  let eventBus: EventBus;

  beforeEach(() => {
    mockSessionComponent = {
      addMessage: vi.fn().mockResolvedValue('msg_1'),
      getMessages: vi.fn().mockResolvedValue([]),
      updateMessage: vi.fn().mockResolvedValue(true),
    };
    eventBus = new EventBus();
    executor = new Executor(
      {} as any,
      eventBus,
      { globalTimeout: null, globalRetry: null, debug: false },
      mockSessionComponent as any
    );
  });

  it('writeNodeInterrupt should include nodeId, parts, and _workflowNodeMetadata', async () => {
    await executor.writeNodeInterrupt(
      'wf_session',
      'agent-confirm',
      'agent',
      'Proceed?',
      'agent_sub_1'
    );

    expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
      'wf_session',
      expect.objectContaining({
        role: 'workflow.node.interrupt',
        parts: expect.arrayContaining([
          expect.objectContaining({
            type: 'workflow-node-interrupt',
            nodeId: 'agent-confirm',
            agentSessionId: 'agent_sub_1',
          }),
        ]),
        metadata: expect.objectContaining({
          _workflowNodeMetadata: true,
          type: 'workflow.node.interrupt',
          nodeId: 'agent-confirm',
          workflowNodeId: 'agent-confirm',
          query: 'Proceed?',
          agentSessionId: 'agent_sub_1',
        }),
      })
    );
  });

  it('writeNodeResume should include nodeId, parts, and _workflowNodeMetadata', async () => {
    await executor.writeNodeResume('wf_session', 'agent-confirm', 'agent', 'Yes', 'agent_sub_1');

    expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
      'wf_session',
      expect.objectContaining({
        role: 'workflow.node.resume',
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'workflow-node-resume', nodeId: 'agent-confirm' }),
        ]),
        metadata: expect.objectContaining({
          nodeId: 'agent-confirm',
          workflowNodeId: 'agent-confirm',
          response: 'Yes',
          agentSessionId: 'agent_sub_1',
        }),
      })
    );
  });

  it('writeNodeStart should include nodeId alias in metadata', async () => {
    await executor.writeNodeStart('wf_session', 'start', 'tool', {}, undefined);

    const call = mockSessionComponent.addMessage.mock.calls[0][1];
    expect(call.metadata.nodeId).toBe('start');
    expect(call.metadata.workflowNodeId).toBe('start');
  });

  it('attachAgentSessionToLastStart should patch last start message (P1)', async () => {
    mockSessionComponent.getMessages.mockResolvedValue([
      {
        id: 'msg_start',
        role: 'workflow.node.start',
        metadata: {
          type: 'workflow.node.start',
          nodeId: 'agent-confirm',
          workflowNodeId: 'agent-confirm',
        },
        parts: [{ type: 'workflow-node-start', nodeId: 'agent-confirm', nodeType: 'agent' }],
      },
    ]);

    await executor.attachAgentSessionToLastStart('wf_session', 'agent-confirm', 'agent_sub_1');

    expect(mockSessionComponent.updateMessage).toHaveBeenCalledWith(
      'wf_session',
      'msg_start',
      expect.objectContaining({
        metadata: expect.objectContaining({
          nodeId: 'agent-confirm',
          agentSessionId: 'agent_sub_1',
        }),
        parts: expect.arrayContaining([
          expect.objectContaining({ agentSessionId: 'agent_sub_1' }),
        ]),
      })
    );
  });
});

describe('inferNextNode with nodeId metadata', () => {
  it('should resume from interrupt using nodeId field', async () => {
    const { inferNextNode } = await import('../utils/session-recovery');
    const result = inferNextNode(
      [
        {
          role: 'workflow.node.interrupt',
          content: 'Proceed?',
          metadata: {
            type: 'workflow.node.interrupt',
            nodeId: 'agent-confirm',
            agentSessionId: 'agent_sub_1',
          },
        },
      ] as any,
      {}
    );

    expect(result.type).toBe('ask_user');
    expect(result.nodeId).toBe('agent-confirm');
    expect(result.agentSessionId).toBe('agent_sub_1');
    expect(getWorkflowNodeIdFromMetadata({ nodeId: 'agent-confirm' })).toBe('agent-confirm');
  });
});
