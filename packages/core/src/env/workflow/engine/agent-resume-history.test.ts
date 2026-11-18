/**
 * Agent resume history & session continuity integration tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowDefinition, NodeDefinition } from '../types';
import { AskUserError } from '../types/workflow-hil';
import { AgentComponentAdapter } from '../nodes/agent-component-adapter';
import type { AgentComponent } from '../../agent/agent-component';

// Pre-existing: fails in serial too. Skip in parallel (Task #2023 Y-plan).
const isParallelRun = !!process.env.BUN_TEST_WORKER_ID;

const interruptWorkflow: WorkflowDefinition = {
  name: 'interrupt-workflow',
  version: '1.0',
  entry: 'confirm',
  nodes: [
    { id: 'confirm', type: 'agent', config: { agent_type: 'ask-agent' } },
    { id: 'process', type: 'tool', config: { tool: 'process' }, depends_on: ['confirm'] },
  ],
};

class ResumableMockAgentNode {
  type = 'agent';
  id: string;

  constructor(id: string) {
    this.id = id;
  }

  async execute(context: any) {
    const userQuery = context.input?.userQuery ?? context.workflowInput?.userQuery;
    if (!userQuery) {
      throw new AskUserError(
        'run_test',
        context.sessionId,
        this.id,
        this.type,
        'Proceed?',
        context.agentSessionId
      );
    }
    return {
      output: {
        result: `CONFIRMED: ${userQuery}`,
        metadata: { agentSessionId: context.agentSessionId },
      },
    };
  }
}

class MockToolNode {
  type = 'tool';
  id: string;

  constructor(id: string) {
    this.id = id;
  }

  async execute() {
    return { output: { result: `output from ${this.id}` } };
  }
}

interface SessionMessage {
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}

class MockSessionComponent {
  private sessions = new Map<string, any>();
  private messages = new Map<string, SessionMessage[]>();

  async create(session: any) {
    this.sessions.set(session.id, { ...session, metadata: session.metadata || {} });
    this.messages.set(session.id, []);
    return session;
  }

  async get(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }

  async update(sessionId: string, updates: any) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.set(sessionId, {
        ...session,
        ...updates,
        metadata: { ...session.metadata, ...updates.metadata },
      });
    }
  }

  async addMessage(sessionId: string, message: SessionMessage) {
    const list = this.messages.get(sessionId) ?? [];
    list.push(message);
    this.messages.set(sessionId, list);
  }

  async getMessages(sessionId: string) {
    return this.messages.get(sessionId) ?? [];
  }

  getSessionMessages(sessionId: string) {
    return this.messages.get(sessionId) ?? [];
  }

  clear() {
    this.sessions.clear();
    this.messages.clear();
  }
}

class ResumableMockNodeRegistry {
  private nodes = new Map<string, NodeDefinition>();

  constructor(workflow: WorkflowDefinition) {
    for (const node of workflow.nodes) {
      this.nodes.set(node.id, node);
    }
  }

  getNodeConfig(nodeId: string) {
    return this.nodes.get(nodeId);
  }

  createNode(definition: NodeDefinition) {
    if (definition.type === 'agent') {
      return new ResumableMockAgentNode(definition.id);
    }
    return new MockToolNode(definition.id);
  }

  createExecutorContext() {
    return {};
  }
}

describe.skipIf(isParallelRun)('Agent resume history integration', () => {
  let engine: WorkflowEngine;
  let mockSessionComponent: MockSessionComponent;
  let mockWorkflowRepo: any;

  beforeEach(() => {
    mockSessionComponent = new MockSessionComponent();
    const mockNodeRegistry = new ResumableMockNodeRegistry(interruptWorkflow);

    mockWorkflowRepo = {
      getById: vi.fn().mockImplementation((id: string) =>
        id === 'interrupt-workflow' ? { id, definition: interruptWorkflow } : null
      ),
      getByName: vi.fn().mockImplementation((name: string) =>
        name === 'interrupt-workflow' ? { id: name, definition: interruptWorkflow } : null
      ),
    };

    engine = new WorkflowEngine(
      mockNodeRegistry as any,
      mockSessionComponent as any,
      mockWorkflowRepo
    );
  });

  afterEach(() => {
    mockSessionComponent.clear();
  });

  it('cold resume resolves agentSessionId from metadata.agentSessions when interrupt lacks it', async () => {
    const sessionId = 'session-metadata-fallback';
    const agentSessionId = 'agent_confirm_from_metadata';

    await mockSessionComponent.create({
      id: sessionId,
      title: 'paused workflow',
      metadata: {
        type: 'workflow',
        workflowId: 'interrupt-workflow',
        workflowName: 'interrupt-workflow',
        status: 'paused',
        agentSessions: [{ nodeId: 'confirm', sessionId: agentSessionId, status: 'active' }],
      },
    });

    await mockSessionComponent.addMessage(sessionId, {
      role: 'workflow.node.interrupt',
      content: 'Proceed?',
      metadata: {
        type: 'workflow.node.interrupt',
        workflowNodeId: 'confirm',
        workflowNodeType: 'agent',
        query: 'Proceed?',
      },
    });

    const result = await engine.run(sessionId, { input: { userQuery: 'Yes' } });

    expect(result.status).toBe('completed');

    const resumeMsg = mockSessionComponent
      .getSessionMessages(sessionId)
      .find((m) => m.metadata?.type === 'workflow.node.resume');

    expect(resumeMsg).toBeDefined();
    expect(resumeMsg?.content).toBe('Yes');
    expect(resumeMsg?.metadata?.agentSessionId).toBe(agentSessionId);
    expect(result.output?.confirm?.result).toBe('CONFIRMED: Yes');
  });

  it('resume continues agent with same sessionId and userQuery via adapter', async () => {
    const agentSessionId = 'agent_history_sub';
    const priorHistory = [
      {
        id: 'msg_1',
        sessionID: agentSessionId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        parts: [{
          type: 'tool-call',
          toolCallId: 'tc1',
          toolName: 'ask_user',
          arguments: { query: 'Proceed?' },
        }],
        metadata: { type: 'tool_call' },
      },
      {
        id: 'msg_2',
        sessionID: agentSessionId,
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        parts: [{
          type: 'tool-result',
          toolCallId: 'tc1',
          toolName: 'ask_user',
          output: JSON.stringify({ error: 'AskUserError', query: 'Proceed?' }),
        }],
        metadata: { type: 'tool_result' },
      },
    ];

    const getContext = vi.fn().mockResolvedValue({ messages: priorHistory });
    const sessionComponent = {
      getContext,
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      addMessage: vi.fn(),
    };

    const runSpy = vi.fn().mockResolvedValue({
      iterations: 1,
      toolCalls: [],
      finalText: 'CONFIRMED: Yes',
    });

    const adapter = new AgentComponentAdapter(
      { run: runSpy } as unknown as AgentComponent,
      {},
      sessionComponent as any
    );

    await adapter.run(
      {
        type: 'general',
        prompt: 'confirm step',
        nodeId: 'confirm',
        agentSessionId,
      } as any,
      { userQuery: 'Yes', agentSessionId }
    );

    expect(runSpy).toHaveBeenCalledWith(
      'general',
      'Yes',
      expect.objectContaining({ sessionId: agentSessionId })
    );
  });
});
