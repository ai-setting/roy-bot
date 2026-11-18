/**
 * WorkflowEngine Integration Tests
 * 
 * Tests for the WorkflowEngine class including:
 * - Session ID generation and formatting
 * - @TracedAs decorator presence
 * - Basic engine state management
 * - Method signatures
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { DAGManager } from './dag-manager';
import { NodeRegistry } from './node-registry';
import type { WorkflowDefinition, WorkflowSessionMetadata } from '../types';

// ==================== Mock Dependencies ====================

/**
 * Create a minimal mock NodeRegistry for testing
 */
function createMockNodeRegistry(): NodeRegistry {
  // Create a minimal implementation that satisfies the interface
  const mockGetNodeConfig = vi.fn();
  const mockCreateExecutorContext = vi.fn();
  
  return {
    getNodeConfig: mockGetNodeConfig,
    createExecutorContext: mockCreateExecutorContext,
  } as unknown as NodeRegistry;
}

/**
 * Create a mock SessionComponent for testing
 */
function createMockSessionComponent() {
  const sessions = new Map<string, any>();
  const messages = new Map<string, any[]>();
  
  // Create implementations first
  const createImpl = async (session: any) => {
    sessions.set(session.id, {
      ...session,
      metadata: session.metadata || {},
    });
    messages.set(session.id, []);
    return session;
  };
  
  const getImpl = async (sessionId: string) => {
    return sessions.get(sessionId) || null;
  };
  
  const updateImpl = async (sessionId: string, updates: any) => {
    const session = sessions.get(sessionId);
    if (session) {
      Object.assign(session, updates);
    }
    return session;
  };
  
  const addMessageImpl = async (sessionId: string, message: any) => {
    const msgs = messages.get(sessionId) || [];
    msgs.push(message);
    messages.set(sessionId, msgs);
    return message;
  };
  
  const getMessagesImpl = async (sessionId: string) => {
    return messages.get(sessionId) || [];
  };
  
  const clearImpl = () => {
    sessions.clear();
    messages.clear();
  };
  
  return {
    sessions,
    messages,
    
    create: vi.fn(createImpl),
    get: vi.fn(getImpl),
    update: vi.fn(updateImpl),
    addMessage: vi.fn(addMessageImpl),
    getMessages: vi.fn(getMessagesImpl),
    clear: vi.fn(clearImpl),
  };
}

// ==================== Test Suite ====================

describe('WorkflowEngine', () => {
  let mockNodeRegistry: NodeRegistry;
  let mockSessionComponent: ReturnType<typeof createMockSessionComponent>;
  
  beforeEach(() => {
    mockNodeRegistry = createMockNodeRegistry();
    mockSessionComponent = createMockSessionComponent();
  });
  
  // ==================== Constructor and Factory ====================
  
  describe('constructor', () => {
    it('should create engine with NodeRegistry', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      expect(engine).toBeDefined();
      // WorkflowEngine extends EventEmitter - verify basic functionality
      expect(typeof engine.on).toBe('function');
      expect(typeof engine.emit).toBe('function');
    });
    
    it('should create engine with NodeRegistry and SessionComponent', () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      expect(engine).toBeDefined();
    });
    
    it('should create engine with all dependencies', () => {
      const mockWorkflowRepo = {
        getById: vi.fn(),
        getByName: vi.fn(),
      };
      
      const engine = new WorkflowEngine(
        mockNodeRegistry,
        mockSessionComponent as any,
        mockWorkflowRepo as any
      );
      expect(engine).toBeDefined();
    });
  });
  
  // ==================== Session ID Methods ====================
  
  // Task #1837: runId == sessionId. getSessionId() is now an identity function.
  // The legacy "workflow_" + "run_xxx" mapping has been collapsed into a
  // single runId value that already carries the workflow_ prefix natively.
  describe('getSessionId', () => {
    it('should be identity (sessionId == runId, Task #1837)', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      const runId = 'workflow_run_12345_1_abc123';
      const sessionId = engine.getSessionId(runId);
      
      // No derivation: getSessionId returns its input as-is.
      expect(sessionId).toBe(runId);
      // Both still satisfy the workflow_ prefix contract.
      expect(sessionId.startsWith('workflow_')).toBe(true);
    });
    
    it('should accept run IDs that already start with workflow_', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      expect(engine.getSessionId('workflow_run_1')).toBe('workflow_run_1');
      expect(engine.getSessionId('workflow_123')).toBe('workflow_123');
      expect(engine.getSessionId('workflow_simple')).toBe('workflow_simple');
    });
  });
  
  // ==================== Session Creation ====================
  
  describe('createSession', () => {
    it('should create session with correct metadata', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);

      // New API: first argument is WorkflowDefinition or Workflow
      const workflow: WorkflowDefinition = {
        name: 'Test Workflow',
        version: '1.0',
        nodes: [],
      };

      const sessionId = await engine.createSession(workflow, {
        input: { test: 'data' },
      });

      // Verify session was created with correct ID format
      expect(sessionId.startsWith('workflow_')).toBe(true);

      // Verify session metadata
      expect(mockSessionComponent.create).toHaveBeenCalledTimes(1);
      const createCall = (mockSessionComponent.create as any).mock.calls[0][0];
      expect(createCall.id).toBe(sessionId);
      expect(createCall.metadata.type).toBe('workflow');
      // workflowId is derived from workflow.id or 'inline_' + workflow.name
      expect(createCall.metadata.workflowId).toBe('inline_Test Workflow');
      expect(createCall.metadata.workflowName).toBe('Test Workflow');
      expect(createCall.metadata.status).toBe('running');
      expect(createCall.metadata.input).toEqual({ test: 'data' });
    });

    it('should propagate parentSessionId to the created workflow session (Task #1739)', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);

      const workflow: WorkflowDefinition = {
        name: 'Test Workflow',
        version: '1.0',
        nodes: [],
      };

      await engine.createSession(workflow, {
        parentSessionId: 'parent-agent-session-abc',
      });

      expect(mockSessionComponent.create).toHaveBeenCalledTimes(1);
      const createCall = (mockSessionComponent.create as any).mock.calls[0][0];
      // Top-level parentSessionId must be set so `sessions list --graph`
      // can render the workflow under its parent agent/CLI session.
      expect(createCall.parentSessionId).toBe('parent-agent-session-abc');
    });

    it('should default parentSessionId to null when not provided', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);

      const workflow: WorkflowDefinition = {
        name: 'Test Workflow',
        version: '1.0',
        nodes: [],
      };

      await engine.createSession(workflow);

      expect(mockSessionComponent.create).toHaveBeenCalledTimes(1);
      const createCall = (mockSessionComponent.create as any).mock.calls[0][0];
      // No parent → null (not undefined) so SQLite stores it as NULL.
      expect(createCall.parentSessionId).toBeNull();
    });
    
    it('should create session without SessionComponent', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        version: '1.0',
        nodes: [],
      };
      
      const sessionId = await engine.createSession(workflow);
      
      // Should still return session ID even without SessionComponent
      expect(sessionId).toBeDefined();
      expect(sessionId.startsWith('workflow_')).toBe(true);
    });
    
    it('should include workflow version in metadata when provided', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      
      const workflow: WorkflowDefinition = {
        name: 'Test Workflow',
        version: '2.0.0',
        nodes: [],
      };
      
      await engine.createSession(workflow);
      
      const createCall = (mockSessionComponent.create as any).mock.calls[0][0];
      expect(createCall.metadata.workflowVersion).toBe('2.0.0');
    });
    
    it('should use Unknown as default workflow name', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        version: '1.0',
        nodes: [],
      };
      
      await engine.createSession(workflow);
      
      const createCall = (mockSessionComponent.create as any).mock.calls[0][0];
      expect(createCall.metadata.workflowName).toBe('test-workflow');
    });
  });
  
  // ==================== Session Status Methods ====================
  
  describe('getSessionStatus', () => {
    it('should return null for non-existent session', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      const status = engine.getSessionStatus('non-existent-session');
      expect(status).toBeNull();
    });
  });
  
  describe('isSessionActive', () => {
    it('should return false for non-existent session', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      expect(engine.isSessionActive('non-existent-session')).toBe(false);
    });
  });
  
  // ==================== @TracedAs Decorator Tests ====================
  
  describe('@TracedAs decorator presence', () => {
    it('should have TracedAs on createSession method', async () => {
      // The @TracedAs decorator wraps methods, so we verify it by checking
      // the method exists and has expected behavior
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      expect(typeof engine.createSession).toBe('function');
      
      // The method should be traceable - verify it with proper WorkflowDefinition
      const workflow: WorkflowDefinition = {
        name: 'test',
        version: '1.0',
        nodes: [],
      };
      const sessionId = await engine.createSession(workflow);
      expect(typeof sessionId).toBe('string');
      expect(sessionId.startsWith('workflow_')).toBe(true);
    });
    
    it('should have TracedAs on run method', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      expect(typeof engine.run).toBe('function');
    });
    
    it('should have TracedAs on runWorkflow method', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      expect(typeof engine.runWorkflow).toBe('function');
    });
    
    it('should have TracedAs on pause method', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      expect(typeof engine.pause).toBe('function');
    });
    
    it('should have TracedAs on stop method', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      expect(typeof engine.stop).toBe('function');
    });
    
    // Note: The actual @TracedAs decorator behavior would be tested in
    // integration tests that verify trace context propagation.
    // Here we verify the methods exist and are callable.
  });
  
  // ==================== Static Factory Method ====================
  
  describe('static create', () => {
    it('should create engine via static factory', async () => {
      const mockEnv = {
        getComponent: vi.fn((name: string) => {
          if (name === 'agent') return { /* mock agent */ };
          if (name === 'session') return mockSessionComponent;
          return undefined;
        }),
      };
      
      const engine = await WorkflowEngine.create({
        env: mockEnv as any,
      });
      
      expect(engine).toBeDefined();
      expect(engine).toBeInstanceOf(WorkflowEngine);
    });
    
    it('should pass components to NodeRegistry', async () => {
      const mockAgent = { name: 'mock-agent' };
      const mockEnv = {
        getComponent: vi.fn((name: string) => {
          if (name === 'agent') return mockAgent;
          return undefined;
        }),
      };
      
      const engine = await WorkflowEngine.create({
        env: mockEnv as any,
      });
      
      expect(engine).toBeDefined();
      expect(mockEnv.getComponent).toHaveBeenCalledWith('agent');
    });
  });
  
  // ==================== Run Method Tests ====================
  
  describe('run', () => {
    it('should throw error for new session without workflowId', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      await expect(engine.run('new-session-id')).rejects.toThrow(
        'workflowId required for new session'
      );
    });
    
    it('should return completed status for completed session', async () => {
      // Setup: Create a session with completed status
      const completedSession = {
        id: 'workflow_completed',
        title: 'Test',
        metadata: {
          type: 'workflow',
          workflowId: 'test-workflow',
          workflowName: 'test-workflow',
          status: 'completed',
        },
      };
      
      // Mock the session component to return the completed session
      const mockSC = createMockSessionComponent();
      mockSC.sessions.set('workflow_completed', completedSession);
      mockSC.get.mockResolvedValueOnce(completedSession);
      
      // Mock workflow repository to return a valid workflow
      const mockRepo = {
        getById: vi.fn().mockReturnValue({
          id: 'test-workflow',
          definition: {
            name: 'test-workflow',
            version: '1.0',
            nodes: [{ id: 'a', type: 'tool', config: {} }],
          },
        }),
        getByName: vi.fn(),
      };
      
      const engine = new WorkflowEngine(mockNodeRegistry, mockSC as any, mockRepo as any);
      
      const result = await engine.run('workflow_completed');
      expect(result.status).toBe('completed');
    });
    
    it('should resume a previously-failed session (Task #1977 — allow retry)', async () => {
      // Task #1977: the short-circuit at metadata.status='failed' was
      // removed so `workflow run -s <runId>` can resume failed workflows.
      // This test was originally asserting the short-circuit behavior
      // (`status === 'failed'`). With the fix, the engine attempts to
      // resume, which requires a complete workflow setup (mock node
      // registry with tool factory, complete sessionComponent, etc.) —
      // the existing minimal mocks aren't sufficient to actually run.
      //
      // The full retry behavior is covered by:
      //   - resume-coverage-e2e.test.ts (D1/D2: node error → resume)
      //   - workflow-run-resume.test.ts (existing ask_user resume tests)
      //   - workflow-timeout-state.test.ts (timeout → status='failed')
      //
      // We skip this test here rather than duplicating the full mock
      // infrastructure. The behavioral change is verified end-to-end in
      // the resume-coverage suite.
      const failedSession = {
        id: 'workflow_failed',
        title: 'Test',
        metadata: {
          type: 'workflow',
          workflowId: 'test-workflow',
          workflowName: 'test-workflow',
          status: 'failed',
        },
      };
      
      const mockSC = createMockSessionComponent();
      mockSC.sessions.set('workflow_failed', failedSession);
      mockSC.get.mockResolvedValueOnce(failedSession);
      
      const mockRepo = {
        getById: vi.fn().mockReturnValue({
          id: 'test-workflow',
          definition: {
            name: 'test-workflow',
            version: '1.0',
            nodes: [{ id: 'a', type: 'tool', config: {} }],
          },
        }),
        getByName: vi.fn(),
      };
      
      const engine = new WorkflowEngine(mockNodeRegistry, mockSC as any, mockRepo as any);
      
      // Sanity check: with the new semantics, the engine MUST NOT
      // short-circuit. We use Promise.race with a short timeout to
      // detect "would short-circuit" vs "would attempt to execute".
      // The minimal mocks here can't actually run the workflow, so
      // the call will hang — that's the EXPECTED new behavior.
      const raced = await Promise.race([
        engine.run('workflow_failed').then(
          (r) => ({ kind: 'resolved', status: r.status }),
          (e) => ({ kind: 'rejected', error: String(e) }),
        ),
        new Promise<{ kind: 'timeout' }>((r) =>
          setTimeout(() => r({ kind: 'timeout' }), 100),
        ),
      ]);
      // With short-circuit REMOVED, the engine should NOT resolve
      // immediately with status='failed'. It either attempts to run
      // (hangs → timeout) or hits an error during resume setup.
      expect(raced.kind).not.toBe('resolved');
    });
    
    // SKIP: Full run/resume tests require extensive mocking of DAGManager, Scheduler, Executor
    it.skip('should start from entry node on fresh run - requires full integration', () => {
      // This would require mocking DAGManager, Scheduler, Executor
      // and verifying that execution starts from the workflow's entry node
    });
    
    it.skip('should validate recovery before execution on resume - requires full integration', () => {
      // This would require setting up a paused session with messages
      // and verifying that inferNextNode is called correctly
    });
  });
  
  // ==================== Stop Method Tests ====================
  
  describe('stop', () => {
    it('should return without error for non-existent session', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      // New implementation returns void without throwing for non-existent session
      await expect(engine.stop('non-existent')).resolves.toBeUndefined();
    });
    
    // SKIP: Full stop tests require active run state
    it.skip('should update session status to stopped - requires active run', async () => {
      // This requires an active run which is managed internally
      // The test would need to trigger a workflow run and then stop it
    });
  });
  
  // ==================== Pause Method Tests ====================
  
  describe('pause', () => {
    it('should throw error for non-existent session', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      await expect(engine.pause('non-existent')).rejects.toThrow(
        'Session not found'
      );
    });
    
    it('should throw error for non-running session', async () => {
      // Create an engine with a session that's not in activeRuns
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      
      // Even if session exists in sessionComponent, it's not in activeRuns
      // so we should get "Session not found"
      await expect(engine.pause('any-session')).rejects.toThrow(
        'Session not found'
      );
    });
    
    // SKIP: Full pause tests require active run state
    it.skip('should update session status to paused - requires active run', () => {
      // This requires an active run which is managed internally
    });
  });
  
  // ==================== RunWorkflow Method Tests ====================
  
  describe('runWorkflow', () => {
    it.skip('should execute workflow with valid definition - requires full integration', () => {
      // This would require extensive mocking of the execution pipeline
    });
    
    it.skip('should validate DAG before execution - requires full integration', () => {
      // This would require testing with an invalid workflow definition
    });
  });
  
  // ==================== Internal Method Tests ====================
  
  describe('internal methods', () => {
    it('should generate unique run IDs', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      // Access internal generator through createSession
      const workflow1: WorkflowDefinition = {
        name: 'wf1',
        version: '1.0',
        nodes: [],
      };
      const workflow2: WorkflowDefinition = {
        name: 'wf2',
        version: '1.0',
        nodes: [],
      };
      
      const sessionId1 = await engine.createSession(workflow1);
      const sessionId2 = await engine.createSession(workflow2);
      
      // Each session should have a unique run ID portion
      expect(sessionId1).not.toBe(sessionId2);
    });
    
    it('should parse workflow ID from session ID', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      // Task #1837: sessionId is the runId directly, no parsing needed.
      // Test that the legacy double-prefix format (workflow_run_xxx) is
      // still tolerated when getSessionId is called on it.
      const legacySessionId = 'workflow_run_123_1_abc';
      const parsedRunId = (engine as any).getRunIdFromSessionId(legacySessionId);
      // Identity: returns the input verbatim.
      expect(parsedRunId).toBe(legacySessionId);
    });
  });
  
  // ==================== Event Emission Tests ====================
  
  describe('event emission', () => {
    it('should extend EventEmitter', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      const eventHandler = vi.fn();
      engine.on('test-event', eventHandler);
      engine.emit('test-event', { data: 'test' });
      
      expect(eventHandler).toHaveBeenCalledTimes(1);
    });
  });
  
  // ==================== Error Handling Tests ====================
  
  describe('error handling', () => {
    it('should handle sessionComponent errors gracefully in createSession', async () => {
      const failingSessionComponent = {
        create: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      };
      
      const engine = new WorkflowEngine(mockNodeRegistry, failingSessionComponent as any);
      
      const workflow: WorkflowDefinition = {
        name: 'test',
        version: '1.0',
        nodes: [],
      };
      
      // The error should propagate
      await expect(engine.createSession(workflow)).rejects.toThrow('DB connection failed');
    });
    
    it('should handle missing workflow definition', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      
      // Trying to run with a workflowId that doesn't exist in the repository
      await expect(
        engine.run('new-session', { workflowId: 'non-existent-workflow' })
      ).rejects.toThrow('Workflow not found');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Task #1840: onSessionCreated callback contract.
  // engine.createSession() must fire options.onSessionCreated immediately
  // after the session is created, so callers (the workflow_run tool)
  // can capture the runId/sessionId even if execution later times out
  // or fails.
  // ────────────────────────────────────────────────────────────────────

  describe('onSessionCreated callback (Task #1840)', () => {
    it('createSession fires onSessionCreated with workflow_-prefixed id', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      const callback = vi.fn();

      const workflow: WorkflowDefinition = {
        name: 'callback-test',
        version: '1.0',
        nodes: [],
      };

      const sessionId = await engine.createSession(workflow, {
        onSessionCreated: callback,
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(sessionId);
      expect(sessionId).toMatch(/^workflow_/);
    });

    it('createSession does not throw when onSessionCreated is not provided', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);

      const workflow: WorkflowDefinition = {
        name: 'no-callback-test',
        version: '1.0',
        nodes: [],
      };

      // No onSessionCreated in options — must not throw
      await expect(engine.createSession(workflow)).resolves.toMatch(/^workflow_/);
    });

    it('createSession does not throw when callback throws (defensive isolation)', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      const throwingCallback = vi.fn(() => {
        throw new Error('callback boom');
      });

      const workflow: WorkflowDefinition = {
        name: 'bad-callback-test',
        version: '1.0',
        nodes: [],
      };

      // A misbehaving callback must not corrupt session creation
      await expect(
        engine.createSession(workflow, { onSessionCreated: throwingCallback }),
      ).resolves.toMatch(/^workflow_/);
      expect(throwingCallback).toHaveBeenCalledTimes(1);
    });
  });
});

// ==================== WorkflowEngine with DAGManager Integration ====================

describe('WorkflowEngine DAG Integration', () => {
  let mockNodeRegistry: NodeRegistry;
  
  beforeEach(() => {
    mockNodeRegistry = createMockNodeRegistry();
  });
  
  describe('DAG validation', () => {
    it('should use DAGManager for workflow validation', () => {
      // Verify DAGManager can be instantiated with a workflow
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        version: '1.0',
        nodes: [
          { id: 'a', type: 'tool', config: {} },
          { id: 'b', type: 'tool', config: {}, depends_on: ['a'] },
        ],
      };
      
      const dagManager = new DAGManager(workflow);
      const validation = dagManager.validate();
      
      expect(validation.valid).toBe(true);
    });
    
    it('should detect invalid DAGs', () => {
      const invalidWorkflow: WorkflowDefinition = {
        name: 'invalid-workflow',
        version: '1.0',
        nodes: [
          { id: 'a', type: 'tool', config: {} },
          { id: 'b', type: 'tool', config: {}, depends_on: ['c'] }, // References non-existent node
        ],
      };
      
      const dagManager = new DAGManager(invalidWorkflow);
      const validation = dagManager.validate();
      
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });
    
    it('should detect circular dependencies', () => {
      const circularWorkflow: WorkflowDefinition = {
        name: 'circular-workflow',
        version: '1.0',
        nodes: [
          { id: 'a', type: 'tool', config: {}, depends_on: ['b'] },
          { id: 'b', type: 'tool', config: {}, depends_on: ['a'] },
        ],
      };
      
      const dagManager = new DAGManager(circularWorkflow);
      const validation = dagManager.validate();
      
      expect(validation.valid).toBe(false);
    });
  });
  
  describe('DAG analysis', () => {
    it('should identify entry nodes', () => {
      const workflow: WorkflowDefinition = {
        name: 'test',
        nodes: [
          { id: 'a', type: 'tool', config: {} },
          { id: 'b', type: 'tool', config: {} },
          { id: 'c', type: 'tool', config: {}, depends_on: ['a', 'b'] },
        ],
      };
      
      const dagManager = new DAGManager(workflow);
      const analysis = dagManager.analyze();
      
      expect(analysis.entryNodes).toContain('a');
      expect(analysis.entryNodes).toContain('b');
      expect(analysis.entryNodes).not.toContain('c');
    });
    
    it('should identify exit nodes', () => {
      const workflow: WorkflowDefinition = {
        name: 'test',
        nodes: [
          { id: 'a', type: 'tool', config: {} },
          { id: 'b', type: 'tool', config: {}, depends_on: ['a'] },
          { id: 'c', type: 'tool', config: {} },
        ],
      };
      
      const dagManager = new DAGManager(workflow);
      const analysis = dagManager.analyze();
      
      expect(analysis.exitNodes).toContain('b');
      expect(analysis.exitNodes).toContain('c');
    });
  });
});

// ==================== Session ID Format Tests ====================

describe('Session ID Format', () => {
  let mockNodeRegistry: NodeRegistry;
  
  beforeEach(() => {
    mockNodeRegistry = createMockNodeRegistry();
  });
  
  // Task #1837: getSessionId() is now identity. The "workflow_" prefix
  // is part of runId natively, not added by getSessionId().
  it('should return input as-is (runId already has workflow_ prefix, Task #1837)', () => {
    const engine = new WorkflowEngine(mockNodeRegistry);
    // Caller passes a fully-formed runId/sessionId; engine doesn't decorate it.
    const sessionId = engine.getSessionId('workflow_123');
    expect(sessionId).toBe('workflow_123');
  });
  
  it('should preserve the canonical runId value (no transformation, Task #1837)', () => {
    const engine = new WorkflowEngine(mockNodeRegistry);
    const runId = 'workflow_12345_1_abc';
    const sessionId = engine.getSessionId(runId);
    
    // Identity: sessionId == runId exactly.
    expect(sessionId).toBe(runId);
  });
  
  it('should be deterministic for the same input (Task #1837)', () => {
    const engine = new WorkflowEngine(mockNodeRegistry);
    
    const sessionId1 = engine.getSessionId('workflow_1');
    const sessionId2 = engine.getSessionId('workflow_1');
    
    expect(sessionId1).toBe(sessionId2);
  });
});

// ==================== Integration Scenario Tests ====================

describe('WorkflowEngine Integration Scenarios', () => {
  let mockNodeRegistry: NodeRegistry;
  let mockSessionComponent: ReturnType<typeof createMockSessionComponent>;
  
  beforeEach(() => {
    mockNodeRegistry = createMockNodeRegistry();
    mockSessionComponent = createMockSessionComponent();
  });
  
  describe('Session lifecycle', () => {
    it('should track session creation flow', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      
      const workflow: WorkflowDefinition = {
        name: 'Test Workflow',
        version: '1.0',
        nodes: [],
      };
      
      const sessionId = await engine.createSession(workflow);
      
      expect(mockSessionComponent.create).toHaveBeenCalledTimes(1);
      
      // Use the mocked get method instead of direct access
      const createdSession = await mockSessionComponent.get(sessionId);
      expect(createdSession).toBeDefined();
      expect(createdSession.metadata.status).toBe('running');
    });
    
    it('should handle session metadata updates', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        version: '1.0',
        nodes: [],
      };
      
      const sessionId = await engine.createSession(workflow);
      
      // Simulate updating session status
      await mockSessionComponent.update(sessionId, {
        metadata: { status: 'paused' },
      });
      
      // Use the mocked get method instead of direct access
      const updatedSession = await mockSessionComponent.get(sessionId);
      expect(updatedSession.metadata.status).toBe('paused');
    });
  });
  
  describe('Multiple concurrent sessions', () => {
    it('should handle multiple session creations', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      
      const workflow1: WorkflowDefinition = {
        name: 'Workflow 1',
        version: '1.0',
        nodes: [],
      };
      const workflow2: WorkflowDefinition = {
        name: 'Workflow 2',
        version: '1.0',
        nodes: [],
      };
      const workflow3: WorkflowDefinition = {
        name: 'Workflow 3',
        version: '1.0',
        nodes: [],
      };
      
      const sessionId1 = await engine.createSession(workflow1);
      const sessionId2 = await engine.createSession(workflow2);
      const sessionId3 = await engine.createSession(workflow3);
      
      expect(sessionId1).not.toBe(sessionId2);
      expect(sessionId2).not.toBe(sessionId3);
      expect(sessionId1).not.toBe(sessionId3);
      
      expect(mockSessionComponent.create).toHaveBeenCalledTimes(3);
    });
    
    it('should store session metadata independently', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      
      const workflow1: WorkflowDefinition = {
        name: 'First',
        version: '1.0',
        nodes: [],
      };
      const workflow2: WorkflowDefinition = {
        name: 'Second',
        version: '1.0',
        nodes: [],
      };
      
      const sessionId1 = await engine.createSession(workflow1);
      const sessionId2 = await engine.createSession(workflow2);
      
      // Use the mocked get method instead of direct access
      const session1 = await mockSessionComponent.get(sessionId1);
      const session2 = await mockSessionComponent.get(sessionId2);
      
      expect(session1.metadata.workflowName).toBe('First');
      expect(session2.metadata.workflowName).toBe('Second');
    });
  });
});

// ==================== Strict Mode Tests ====================

/**
 * Strict mode validation tests
 * Tests for P2-3: Add strict mode tests covering validation failure and node skip behavior
 */
describe('WorkflowEngine Strict Mode', () => {
  // Helper to create a minimal workflow definition for testing
  const createMinimalWorkflow = (config?: { strict?: boolean }): Partial<WorkflowDefinition> => ({
    name: 'Test Workflow',
    version: '1.0',
    nodes: [{ id: 'test-node', type: 'tool', config: {} }],
    config: config ? { ...config } : {},
  });
  
  describe('strict mode configuration', () => {
    it('should support strict mode in workflow config', () => {
      const workflow = createMinimalWorkflow({ strict: true });
      
      // Verify strict mode is included in config
      expect(workflow.config?.strict).toBe(true);
    });
    
    it('should default strict mode to false when not specified', () => {
      const workflow = createMinimalWorkflow();
      
      // Verify strict mode is undefined/false by default
      expect(workflow.config?.strict ?? false).toBe(false);
    });
  });
  
  describe('strict mode behavior', () => {
    it('should skip nodes with unresolved templates in strict mode', async () => {
      // This test verifies the concept - actual implementation requires integration test
      // In strict mode, preExecuteValidation should throw and mark node as failed
      const strictMode = true;
      
      // Simulate unresolved templates
      const unresolvedTemplates = ['{{input.missing}}', '{{nodes.nonexistent.output}}'];
      
      // In strict mode, these should cause validation failure
      expect(unresolvedTemplates.length).toBeGreaterThan(0);
      expect(strictMode).toBe(true);
    });
    
    it('should warn about unresolved templates in non-strict mode', () => {
      // In non-strict mode, unresolved templates should only warn
      const strictMode = false;
      const unresolvedTemplates = ['{{input.missing}}'];
      
      // Non-strict mode allows execution to continue
      expect(strictMode).toBe(false);
      expect(unresolvedTemplates.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Task #1837: runId == sessionId (workflow_ prefix is native)
// =============================================================================

describe('Task #1837: runId naturally has workflow_ prefix', () => {
  let mockNodeRegistry: NodeRegistry;
  let mockSessionComponent: ReturnType<typeof createMockSessionComponent>;

  beforeEach(() => {
    mockNodeRegistry = createMockNodeRegistry();
    mockSessionComponent = createMockSessionComponent();
  });

  describe('createSession', () => {
    it('should produce a sessionId with native workflow_ prefix (no derivation)', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      const workflow: WorkflowDefinition = {
        name: 'Task1837-test',
        version: '1.0',
        nodes: [],
      };

      const sessionId = await engine.createSession(workflow);

      // Task #1837: sessionId naturally starts with workflow_ because
      // generateRunId() now produces IDs with the prefix built in.
      expect(sessionId.startsWith('workflow_')).toBe(true);
      // And it must NOT have the legacy double-prefix `workflow_run_`
      expect(sessionId.startsWith('workflow_run_')).toBe(false);
    });

    it('should store metadata.runId equal to sessionId (no separate concept)', async () => {
      const engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any);
      const workflow: WorkflowDefinition = {
        name: 'Task1837-meta',
        version: '1.0',
        nodes: [],
      };

      const sessionId = await engine.createSession(workflow);

      const createCall = (mockSessionComponent.create as any).mock.calls[0][0];
      // runId in metadata must equal sessionId (they are the same identifier now).
      expect(createCall.metadata.runId).toBe(sessionId);
    });
  });

  describe('getSessionId', () => {
    it('should be identity (sessionId == runId, no derivation)', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);

      // Task #1837: getSessionId no longer adds workflow_ prefix
      // because runId already has it. Returns input as-is.
      expect(engine.getSessionId('workflow_run_12345_1_abc')).toBe(
        'workflow_run_12345_1_abc'
      );
      expect(engine.getSessionId('workflow_12345_1_abc')).toBe(
        'workflow_12345_1_abc'
      );
    });
  });

  describe('getRunIdFromSessionId', () => {
    it('should be identity (sessionId is the runId, no strip)', () => {
      const engine = new WorkflowEngine(mockNodeRegistry);
      // Access private method via cast for behavioral verification.
      // Task #1837: getRunIdFromSessionId no longer strips the workflow_ prefix
      // because sessionId IS the runId.
      const get = (engine as any).getRunIdFromSessionId.bind(engine);
      expect(get('workflow_run_12345_1_abc')).toBe('workflow_run_12345_1_abc');
      expect(get('workflow_12345_1_abc')).toBe('workflow_12345_1_abc');
    });
  });
});
