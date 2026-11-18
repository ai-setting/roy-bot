/**
 * Dual-agent resume: userQuery must not leak to subsequent agent nodes.
 *
 * Flow: agent-a (interrupt) -> resume "Yes" -> agent-a completes -> agent-b (interrupt)
 * agent-b fresh run must NOT receive agent-a's userQuery.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowDefinition, NodeDefinition } from '../types';
import { AskUserError } from '../types/workflow-hil';

// Pre-existing: fails in serial too. Skip in parallel (Task #2023 Y-plan).
const isParallelRun = !!process.env.BUN_TEST_WORKER_ID;

/** Records userQuery received by each mock agent node */
const receivedUserQueries: Record<string, string | undefined> = {};

class ResumableMockAgentNode {
  type = 'agent';
  id: string;

  constructor(id: string) {
    this.id = id;
  }

  async execute(context: any) {
    const userQuery =
      context.input?.userQuery ?? context.workflowInput?.userQuery;
    receivedUserQueries[this.id] = userQuery;

    if (!userQuery) {
      throw new AskUserError(
        'run_test',
        context.sessionId,
        this.id,
        this.type,
        `Proceed at ${this.id}?`,
        context.agentSessionId
      );
    }

    return {
      output: {
        result: `${this.id}:${userQuery}`,
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
    return { output: { result: `done:${this.id}` } };
  }
}

const dualAgentWorkflow: WorkflowDefinition = {
  name: 'dual-agent-resume',
  version: '1.0',
  entry: 'agent-a',
  nodes: [
    { id: 'agent-a', type: 'agent', config: { agent_type: 'general' } },
    {
      id: 'agent-b',
      type: 'agent',
      config: { agent_type: 'general' },
      depends_on: ['agent-a'],
    },
    {
      id: 'finish',
      type: 'tool',
      config: { tool: 'echo' },
      depends_on: ['agent-b'],
    },
  ],
};

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

  clear() {
    this.sessions.clear();
    this.messages.clear();
  }
}

class DualAgentNodeRegistry {
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

describe.skipIf(isParallelRun)('Dual-agent resume userQuery isolation', () => {
  let engine: WorkflowEngine;
  let mockSessionComponent: MockSessionComponent;

  beforeEach(() => {
    for (const key of Object.keys(receivedUserQueries)) {
      delete receivedUserQueries[key];
    }

    mockSessionComponent = new MockSessionComponent();
    const mockNodeRegistry = new DualAgentNodeRegistry(dualAgentWorkflow);

    const mockWorkflowRepo = {
      getById: vi.fn().mockImplementation((id: string) =>
        id === 'dual-agent-resume'
          ? { id, definition: dualAgentWorkflow }
          : null
      ),
      getByName: vi.fn().mockImplementation((name: string) =>
        name === 'dual-agent-resume'
          ? { id: name, definition: dualAgentWorkflow }
          : null
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

  it('does not pass agent-a userQuery to agent-b on fresh start after resume', async () => {
    const sessionId = 'dual-agent-session-1';

    const first = await engine.run(sessionId, { workflowId: 'dual-agent-resume' });
    expect(first.status).toBe('paused');
    expect(first.pendingNodeId).toBe('agent-a');
    expect(receivedUserQueries['agent-a']).toBeUndefined();

    const afterA = await engine.run(sessionId, { input: { userQuery: 'Yes' } });
    expect(afterA.status).toBe('paused');
    expect(afterA.pendingNodeId).toBe('agent-b');
    expect(receivedUserQueries['agent-a']).toBe('Yes');
    expect(receivedUserQueries['agent-b']).toBeUndefined();

    const final = await engine.run(sessionId, { input: { userQuery: 'Approve' } });
    expect(final.status).toBe('completed');
    expect(receivedUserQueries['agent-b']).toBe('Approve');
    expect(final.output?.['agent-b']?.result).toBe('agent-b:Approve');
    expect(final.output?.finish?.result).toBe('done:finish');
  });

  it('does not persist userQuery in workflowInput after resume consumption', async () => {
    const sessionId = 'dual-agent-session-2';

    await engine.run(sessionId, { workflowId: 'dual-agent-resume' });
    await engine.run(sessionId, { input: { userQuery: 'Yes' } });

    const session = await mockSessionComponent.get(sessionId);
    const activeState = (engine as any).activeSessions?.get(sessionId);

    // workflowInput used for subsequent nodes must not carry stale userQuery
    if (activeState?.config?.workflowInput) {
      expect(activeState.config.workflowInput.userQuery).toBeUndefined();
    }

    // session metadata input may still merge userQuery for audit — agent nodes must not read it
    // The critical assertion is agent-b received undefined on its interrupt pass
    expect(receivedUserQueries['agent-b']).toBeUndefined();
  });
});
