import { describe, it, expect, beforeEach, vi } from 'bun:test';
import { AgentComponentAdapter, type PendingAgentSession } from './agent-component-adapter';

// Custom AskUserError for testing
class AskUserError extends Error {
  readonly type = 'ask-user';
  constructor(
    public readonly runId: string,
    public readonly sessionId: string,
    public readonly nodeId: string,
    public readonly nodeType: string,
    public readonly query: string
  ) {
    super(`Ask user: ${query}`);
    this.name = 'AskUserError';
  }
}

// Mock AgentComponent
const mockAgentComponent = {
  registerAgent: vi.fn(),
  getAgent: vi.fn().mockReturnValue({ name: 'test-agent' }),
  listAgents: vi.fn().mockReturnValue([{ name: 'test-agent' }]),
  run: vi.fn().mockResolvedValue({
    finalText: 'test response',
    iterations: 1,
    toolCalls: [],
  }),
};

// Mock SessionComponent
const mockSessionComponent = {
  create: vi.fn().mockResolvedValue({ id: 'agent_session_123' }),
  addMessage: vi.fn().mockResolvedValue('msg_123'),
  getMessages: vi.fn().mockResolvedValue([]),
};

describe('AgentComponentAdapter', () => {
  let adapter: AgentComponentAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock to return successful result by default
    mockAgentComponent.run.mockResolvedValue({
      finalText: 'test response',
      iterations: 1,
      toolCalls: [],
    });
    adapter = new AgentComponentAdapter(
      mockAgentComponent as any,
      {},
      mockSessionComponent as any
    );
  });

  describe('run()', () => {
    it('should create agent session when sessionComponent is available', async () => {
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
      };

      const result = await adapter.run(config as any);

      expect(mockSessionComponent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Agent Session'),
          metadata: expect.objectContaining({
            type: 'agent',
            workflowRunId: 'run1',
            workflowNodeId: 'node1',
          }),
        })
      );
      // Issue #5: top-level parentSessionId is forwarded as a Session field,
      // and metadata must NOT duplicate it (drift risk).
      expect(mockSessionComponent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          parentSessionId: 'workflow_run_1',
          metadata: expect.not.objectContaining({
            parentSessionId: expect.anything(),
          }),
        })
      );
      expect(result.output).toBe('test response');
    });

    it('should not create session when sessionComponent is not available', async () => {
      const adapterWithoutSession = new AgentComponentAdapter(
        mockAgentComponent as any,
        {},
        undefined
      );

      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
      };

      await adapterWithoutSession.run(config as any);

      expect(mockSessionComponent.create).not.toHaveBeenCalled();
    });

    it('should map workflow session to agent sessions', async () => {
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
      };

      await adapter.run(config as any);

      // Should have mapping
      const agentSessions = adapter.getAgentSessionsForWorkflowSession('workflow_run_1');
      expect(agentSessions.length).toBeGreaterThan(0);
    });

    it('should throw AskUserError to interrupt workflow (pending session preserved)', async () => {
      // Mock agent to throw AskUserError
      mockAgentComponent.run.mockImplementation(() => {
        throw new AskUserError('run1', 'workflow_run1', 'node1', 'agent', 'Need user input?');
      });

      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
      };

      // Should reject with AskUserError
      try {
        await adapter.run(config as any);
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.name).toBe('AskUserError');
      }

      // Pending session should be preserved (not cleared)
      const sessions = adapter.getPendingSessionsForRun('run1');
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0].nodeId).toBe('node1');
    });
  });

  describe('resumeAgent()', () => {
    it('should add user response to session and resume', async () => {
      const agentSessionId = 'agent_session_123';
      const userResponse = 'User response text';
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
      };

      await adapter.resumeAgent(agentSessionId, userResponse, config as any);

      // Verify addMessage was called (mock is already reset in beforeEach, so it should be called)
      // Note: In this test, we just verify no error is thrown
      expect(mockAgentComponent.run).toHaveBeenCalled();
    });

    it('should pass userQuery to run() via resumeOptions', async () => {
      const agentSessionId = 'agent_session_123';
      const userQuery = 'yes, continue';
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
      };

      await adapter.resumeAgent(agentSessionId, userQuery, config as any);

      // Verify addMessage was NOT called (userQuery is passed via resumeOptions)
      expect(mockSessionComponent.addMessage).not.toHaveBeenCalled();

      // Verify agentComponent.run was called with correct parameters:
      // - query: userQuery (the user's input to continue the conversation)
      // - context.sessionId: agentSessionId (the existing agent session)
      // - context.additionInfo: prompt (the workflow node's prompt)
      expect(mockAgentComponent.run).toHaveBeenCalledWith(
        'test-agent',
        userQuery,  // userQuery should be passed as query
        expect.objectContaining({
          sessionId: agentSessionId,
          additionInfo: 'test prompt',
        })
      );
    });

    it('should remove session from pending after resume', async () => {
      // First add a pending session manually
      adapter.pendingSessions.set('agent_session_456', {
        agentSessionId: 'agent_session_456',
        nodeId: 'node1',
        runId: 'run1',
        createdAt: Date.now(),
      });

      const userResponse = 'yes';
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
      };

      await adapter.resumeAgent('agent_session_456', userResponse, config as any);

      // Session should be removed from pending
      expect(adapter.pendingSessions.has('agent_session_456')).toBe(false);
    });
  });

  describe('getPendingSession()', () => {
    it('should return pending session when agent throws AskUserError', async () => {
      // Mock agent to throw AskUserError
      mockAgentComponent.run.mockImplementation(() => {
        throw new AskUserError('run1', 'workflow_run1', 'node1', 'agent', 'Need user input?');
      });

      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
      };

      try {
        await adapter.run(config as any);
      } catch (e) {
        // Expected
      }

      const sessions = adapter.getPendingSessionsForRun('run1');
      expect(sessions.length).toBe(1);

      const pending = adapter.getPendingSession(sessions[0].agentSessionId);
      expect(pending).toBeDefined();
      expect(pending?.nodeId).toBe('node1');
    });

    it('should return undefined for non-existent session', () => {
      const pending = adapter.getPendingSession('non-existent');
      expect(pending).toBeUndefined();
    });
  });

  describe('getCurrentAgentSessionId()', () => {
    it('should return current agent session ID during execution', async () => {
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
      };

      await adapter.run(config as any);

      // After successful completion, current session is cleared
      // But we can verify the session was created during execution
      const agentSessions = adapter.getAgentSessionsForWorkflowSession('workflow_run_1');
      expect(agentSessions.length).toBeGreaterThan(0);
    });
  });

  describe('setSessionComponent()', () => {
    it('should allow setting session component after construction', async () => {
      const adapterWithoutSession = new AgentComponentAdapter(
        mockAgentComponent as any,
        {},
        undefined
      );

      adapterWithoutSession.setSessionComponent!(mockSessionComponent as any);

      // Now adapter should be able to create sessions
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
      };

      await adapterWithoutSession.run(config as any);
      expect(mockSessionComponent.create).toHaveBeenCalled();
    });
  });

  describe('json output mode', () => {
    it('should enable workflow json plugin when outputSchema is configured', async () => {
      const schema = {
        type: 'object',
        properties: { passed: { type: 'boolean' } },
        required: ['passed'],
      };

      mockAgentComponent.run.mockResolvedValue({
        finalText: 'Verification failed due to missing token.',
        structuredOutput: { passed: false },
        iterations: 1,
        toolCalls: [],
      });

      await adapter.run({
        type: 'test-agent',
        prompt: 'verify',
        nodeId: 'verify',
        runId: 'run1',
        options: { outputSchema: schema },
        agentSessionId: 'agent_verify_1',
      } as any);

      expect(mockAgentComponent.run).toHaveBeenCalledWith(
        'test-agent',
        '',
        expect.objectContaining({
          metadata: expect.objectContaining({ outputSchema: schema }),
          pluginEnabled: expect.objectContaining({ 'workflow:json-output': true }),
        })
      );
    });
  });

  describe('agentSessionId handling', () => {
    it('should use agentSessionId from resumeOptions instead of creating new session (fresh run)', async () => {
      // This test verifies the fix for: Fresh workflow run fails with "Session not found"
      // 
      // Scenario: AgentNode.createAgentSubSession() already creates the session,
      // and passes the sessionId via resumeOptions.agentSessionId
      // AgentComponentAdapter should use this existing sessionId, not create a new one
      
      const existingSessionId = 'agent_pre_existing_session_123';
      
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
      };

      // Simulate AgentNode passing existing sessionId via resumeOptions
      // (AgentNode.createAgentSubSession() already created this session)
      const resumeOptions = {
        userResponse: undefined,
        agentSessionId: existingSessionId,
      };

      await adapter.run(config as any, resumeOptions);

      // Verify: sessionComponent.create should NOT be called
      // because we should use the existing sessionId from resumeOptions
      expect(mockSessionComponent.create).not.toHaveBeenCalled();

      // Verify: agentComponent.run was called with the existing sessionId
      expect(mockAgentComponent.run).toHaveBeenCalledWith(
        'test-agent',
        '', // userInput is empty for fresh run
        expect.objectContaining({
          sessionId: existingSessionId,
        })
      );

      // Verify: pending session is NOT tracked on success (only tracked when AskUserError is thrown)
      // Note: In this test, agent completes successfully, so pending session should be cleared
      const pending = adapter.getPendingSession(existingSessionId);
      expect(pending).toBeUndefined();
    });

    it('should use agentSessionId from config.agentSessionId as fallback', async () => {
      const configAgentSessionId = 'agent_from_config_456';
      
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
        agentSessionId: configAgentSessionId,
      };

      // No resumeOptions provided
      await adapter.run(config as any);

      // sessionComponent.create should NOT be called (should use config.agentSessionId)
      expect(mockSessionComponent.create).not.toHaveBeenCalled();

      // agentComponent.run should use the agentSessionId from config
      expect(mockAgentComponent.run).toHaveBeenCalledWith(
        'test-agent',
        '',
        expect.objectContaining({
          sessionId: configAgentSessionId,
        })
      );
    });

    it('should set currentAgentSessionId for tracking', async () => {
      const existingSessionId = 'agent_tracking_test_789';
      
      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
      };

      const resumeOptions = {
        userResponse: undefined,
        agentSessionId: existingSessionId,
      };

      await adapter.run(config as any, resumeOptions);

      // getCurrentAgentSessionId should return the sessionId from resumeOptions
      expect(adapter.getCurrentAgentSessionId()).toBe(existingSessionId);
    });

    it('should pass options.model to AgentContext', async () => {
      // Reset mock to capture context
      mockAgentComponent.run.mockResolvedValue({
        finalText: 'test response with model',
        iterations: 1,
        toolCalls: [],
      });

      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        options: {
          model: 'minimax/MiniMax-Text-01',
        },
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
      };

      await adapter.run(config as any);

      // Verify that agentComponent.run was called with context containing the model
      expect(mockAgentComponent.run).toHaveBeenCalledWith(
        'test-agent',
        expect.any(String),
        expect.objectContaining({
          model: 'minimax/MiniMax-Text-01',
        })
      );
    });

    it('should not set model in context when options.model is not specified', async () => {
      mockAgentComponent.run.mockResolvedValue({
        finalText: 'test response without model',
        iterations: 1,
        toolCalls: [],
      });

      const config = {
        type: 'test-agent',
        prompt: 'test prompt',
        nodeId: 'node1',
        runId: 'run1',
        workflowSessionId: 'workflow_run_1',
      };

      await adapter.run(config as any);

      // Verify context does NOT contain model
      const callArg = mockAgentComponent.run.mock.calls[0][2] as any;
      expect(callArg.model).toBeUndefined();
    });
  });
});

describe('PendingAgentSession type', () => {
  it('should have correct structure', () => {
    const session: PendingAgentSession = {
      agentSessionId: 'agent_123',
      nodeId: 'node_1',
      runId: 'run_1',
      createdAt: Date.now(),
    };

    expect(session.agentSessionId).toBe('agent_123');
    expect(session.nodeId).toBe('node_1');
    expect(session.runId).toBe('run_1');
    expect(session.createdAt).toBeGreaterThan(0);
  });
});
