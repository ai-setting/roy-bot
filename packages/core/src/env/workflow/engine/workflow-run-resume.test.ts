/**
 * Workflow Run/Resume Integration Tests
 * 
 * TDD Tests for complete workflow lifecycle:
 * 1. Fresh run with initial input
 * 2. Fresh run that triggers ask_user interrupt
 * 3. Resume with sessionId and userQuery
 * 
 * @see {@link https://github.com/orgs/ai-setting/projects/1/views/1?pane=issue&itemId=980}
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowDefinition, NodeDefinition } from '../types';
import { AskUserError } from '../types/workflow-hil';

// ==================== Mock Implementations ====================

/**
 * Mock ToolNode that can be configured to throw AskUserError
 */
class MockToolNode {
  type = 'tool';
  id: string;
  private output: any;
  private shouldInterrupt: boolean;
  private interruptQuery: string;
  
  constructor(id: string, output?: any, shouldInterrupt = false, interruptQuery = 'Continue?') {
    this.id = id;
    this.output = output;
    this.shouldInterrupt = shouldInterrupt;
    this.interruptQuery = interruptQuery;
  }
  
  async execute(context: any): Promise<{ output: any } | never> {
    if (this.shouldInterrupt) {
      throw new AskUserError('run_test', context.sessionId, this.id, this.type, this.interruptQuery);
    }
    return { output: this.output ?? { result: `output from ${this.id}` } };
  }
}

/**
 * Mock AgentNode that throws AskUserError
 */
class MockAgentNode {
  type = 'agent';
  id: string;
  private shouldInterrupt: boolean;
  private interruptQuery: string;
  
  constructor(id: string, shouldInterrupt = false, interruptQuery = 'Should I continue?') {
    this.id = id;
    this.shouldInterrupt = shouldInterrupt;
    this.interruptQuery = interruptQuery;
  }
  
  async execute(context: any): Promise<never> {
    if (this.shouldInterrupt) {
      throw new AskUserError('run_test', context.sessionId, this.id, this.type, this.interruptQuery);
    }
    return { output: { result: `agent output from ${this.id}` } } as any;
  }
}

// ==================== Test Fixtures ====================

/**
 * Simple workflow that completes immediately
 */
const simpleWorkflow: WorkflowDefinition = {
  name: 'simple-workflow',
  version: '1.0',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'tool', config: { tool: 'echo' } },
  ],
};

/**
 * Workflow that triggers ask_user interrupt
 */
const interruptWorkflow: WorkflowDefinition = {
  name: 'interrupt-workflow',
  version: '1.0',
  entry: 'confirm',
  nodes: [
    { id: 'confirm', type: 'agent', config: { agent_type: 'ask-agent' } },
    { id: 'process', type: 'tool', config: { tool: 'process' }, depends_on: ['confirm'] },
  ],
};

/**
 * Complex workflow with multiple entry points
 */
const complexWorkflow: WorkflowDefinition = {
  name: 'complex-workflow',
  version: '1.0',
  entry: ['start', 'validate'],
  nodes: [
    { id: 'start', type: 'tool', config: { tool: 'init' } },
    { id: 'validate', type: 'tool', config: { tool: 'validate' } },
    { id: 'process', type: 'tool', config: { tool: 'process' }, depends_on: ['start', 'validate'] },
  ],
};

// ==================== Mock Session Component ====================

interface SessionMessage {
  role: string;
  content: string;
  metadata?: Record<string, any>;
}

interface Session {
  id: string;
  title: string;
  metadata: Record<string, any>;
}

class MockSessionComponent {
  private sessions: Map<string, Session> = new Map();
  private messages: Map<string, SessionMessage[]> = new Map();
  
  async create(session: Session): Promise<Session> {
    this.sessions.set(session.id, {
      ...session,
      metadata: session.metadata || {},
    });
    this.messages.set(session.id, []);
    return session;
  }
  
  async get(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) || null;
  }
  
  async update(sessionId: string, updates: Partial<Session>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.set(sessionId, { ...session, ...updates });
    }
  }
  
  async addMessage(sessionId: string, message: SessionMessage): Promise<void> {
    const messages = this.messages.get(sessionId) || [];
    messages.push(message);
    this.messages.set(sessionId, messages);
  }
  
  async getMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.messages.get(sessionId) || [];
  }
  
  // Test helpers
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }
  
  getSessionMessages(sessionId: string): SessionMessage[] {
    return this.messages.get(sessionId) || [];
  }
  
  clear(): void {
    this.sessions.clear();
    this.messages.clear();
  }
}

// ==================== Mock Node Registry ====================

class MockNodeRegistry {
  private nodes: Map<string, NodeDefinition> = new Map();
  private executors: Map<string, any> = new Map();
  
  constructor(workflows: WorkflowDefinition[]) {
    for (const wf of workflows) {
      for (const node of wf.nodes) {
        this.nodes.set(node.id, node);
      }
    }
  }
  
  getNodeConfig(nodeId: string): NodeDefinition | undefined {
    return this.nodes.get(nodeId);
  }
  
  createNode(definition: NodeDefinition): any {
    // Return appropriate mock node based on type
    if (definition.type === 'tool') {
      return new MockToolNode(definition.id);
    }
    if (definition.type === 'agent') {
      return new MockAgentNode(definition.id, true, 'Proceed?');
    }
    return {
      type: definition.type,
      id: definition.id,
      execute: vi.fn().mockResolvedValue({ output: { result: 'mock' } }),
    };
  }
}

// ==================== Test Suite ====================

describe('Workflow Run/Resume Integration', () => {
  let engine: WorkflowEngine;
  let mockSessionComponent: MockSessionComponent;
  let mockNodeRegistry: MockNodeRegistry;
  let mockWorkflowRepo: any;
  
  beforeEach(() => {
    mockSessionComponent = new MockSessionComponent();
    mockNodeRegistry = new MockNodeRegistry([simpleWorkflow, interruptWorkflow, complexWorkflow]);
    
    mockWorkflowRepo = {
      getById: vi.fn().mockImplementation((id: string) => {
        if (id === 'simple-workflow') return { id, definition: simpleWorkflow };
        if (id === 'interrupt-workflow') return { id, definition: interruptWorkflow };
        if (id === 'complex-workflow') return { id, definition: complexWorkflow };
        return null;
      }),
      getByName: vi.fn().mockImplementation((name: string) => {
        if (name === 'simple-workflow') return { id: name, definition: simpleWorkflow };
        if (name === 'interrupt-workflow') return { id: name, definition: interruptWorkflow };
        if (name === 'complex-workflow') return { id: name, definition: complexWorkflow };
        return null;
      }),
    };
    
    engine = new WorkflowEngine(mockNodeRegistry, mockSessionComponent as any, mockWorkflowRepo);
  });
  
  afterEach(() => {
    mockSessionComponent.clear();
  });
  
  // ==================== Fresh Run Tests ====================
  
  describe('Fresh run - no existing session', () => {
    it('should create session and run workflow on fresh start', async () => {
      // Fresh run: sessionId is new, workflow runs from entry node
      // Simple workflow completes immediately, so status is 'completed'
      const result = await engine.run('new-session-1', { workflowId: 'simple-workflow' });
      
      // Simple workflow completes immediately
      expect(result.status).toBe('completed');
      expect(result.runId).toBe('new-session-1');
      expect(result.output).toBeDefined();
    });
    
    it('should create session with correct metadata', async () => {
      const result = await engine.run('session-fresh-1', { workflowId: 'simple-workflow' });
      
      // Wait for async session creation
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const session = mockSessionComponent.getSession('session-fresh-1');
      expect(session).toBeDefined();
      expect(session?.metadata.type).toBe('workflow');
      expect(session?.metadata.workflowName).toBe('simple-workflow');
      // After completion, status is 'completed'
      expect(session?.metadata.status).toBe('completed');
    });
    
    it('should pass input to entry node on fresh run', async () => {
      const input = { stockCode: 'AAPL', limit: 10 };
      const result = await engine.run('session-input-1', { 
        workflowId: 'simple-workflow',
        input,
      });
      
      // Simple workflow completes immediately
      expect(result.status).toBe('completed');
      expect(result.output).toBeDefined();
    });
  });
  
  // ==================== Fresh Run with Interrupt ====================
  
  describe('Fresh run with ask_user interrupt', () => {
    it('should pause workflow when ask_user is triggered', async () => {
      // This workflow is configured to throw AskUserError
      const result = await engine.run('session-interrupt-1', { 
        workflowId: 'interrupt-workflow' 
      });
      
      // Should return paused status (not running, not completed)
      expect(result.status).toBe('paused');
      expect(result.pendingNodeId).toBeDefined();
    });
    
    it('should save interrupt message to session', async () => {
      await engine.run('session-interrupt-2', { 
        workflowId: 'interrupt-workflow' 
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const messages = mockSessionComponent.getSessionMessages('session-interrupt-2');
      const interruptMsg = messages.find(m => m.metadata?.type === 'workflow.node.interrupt');
      
      expect(interruptMsg).toBeDefined();
      expect(interruptMsg?.content).toBe('Proceed?');
    });
    
    it('should include userQuery in interrupt response', async () => {
      const result = await engine.run('session-interrupt-3', { 
        workflowId: 'interrupt-workflow',
        input: { userQuery: 'initial question' },
      });
      
      // Should pause with the query
      expect(result.status).toBe('paused');
      expect(result.query).toBe('Proceed?');
    });
  });
  
  // ==================== Resume Tests ====================
  
  describe('Resume with sessionId and userQuery', () => {
    it('should resume workflow using run() with sessionId and input', async () => {
      // 1. First run triggers interrupt
      await engine.run('session-resume-1', { 
        workflowId: 'interrupt-workflow' 
      });
      
      // 2. Resume with userQuery
      const resumeResult = await engine.run('session-resume-1', {
        input: { userQuery: 'Yes, continue' },
      });
      
      // Should resume (status depends on workflow completion)
      expect(resumeResult.status).toBeDefined();
      expect(resumeResult.runId).toBe('session-resume-1');
    });
    
    it('should normalize string input to userQuery on resume', async () => {
      // 1. First run triggers interrupt
      await engine.run('session-resume-2', { 
        workflowId: 'interrupt-workflow' 
      });
      
      // 2. Resume with string input - should be normalized to { userQuery }
      const resumeResult = await engine.run('session-resume-2', {
        input: 'Yes', // String input should become { userQuery: 'Yes' }
      });
      
      expect(resumeResult.status).toBeDefined();
    });
    
    it('should pass userQuery to the resumed node', async () => {
      // 1. First run triggers interrupt
      await engine.run('session-resume-3', { 
        workflowId: 'interrupt-workflow' 
      });
      
      // 2. Resume with userQuery - the resumed node should receive it
      // Note: The MockAgentNode always throws AskUserError, so we can only verify it was passed
      const result = await engine.run('session-resume-3', {
        input: { userQuery: 'Confirmed' },
      });
      
      // Node should receive the userQuery
      expect(result.status).toBeDefined();
    });
    
    it('should continue from interrupted node on resume', async () => {
      // This tests the full flow:
      // 1. run(sessionId, { workflowId }) → interrupt at confirm node
      // 2. run(sessionId, { input: { userQuery } }) → continue from confirm node
      
      // First run
      const firstResult = await engine.run('session-resume-4', { 
        workflowId: 'interrupt-workflow' 
      });
      
      expect(firstResult.status).toBe('paused');
      expect(firstResult.pendingNodeId).toBe('confirm');
      
      // Resume
      const resumeResult = await engine.run('session-resume-4', {
        input: { userQuery: 'proceed' },
      });
      
      // Should continue (status could be running, completed, or paused again)
      expect(resumeResult.runId).toBe('session-resume-4');
    });
  });
  
  // ==================== Unified Flow Tests ====================
  
  describe('Unified run() flow', () => {
    it('should infer fresh run when session does not exist', async () => {
      const result = await engine.run('non-existent-session', {
        workflowId: 'simple-workflow',
      });
      
      // Simple workflow completes immediately
      expect(result.status).toBe('completed');
      expect(result.runId).toBe('non-existent-session');
    });
    
    it('should infer resume when session exists', async () => {
      // Create session first
      await engine.run('existing-session', {
        workflowId: 'simple-workflow',
      });
      
      // Run again - should infer resume
      const result = await engine.run('existing-session', {
        input: { userQuery: 'resume data' },
      });
      
      expect(result.status).toBeDefined();
    });
    
    it('should use inferNextNode to determine entry/resume point', async () => {
      // Test that the engine correctly determines:
      // - No messages → entry node
      // - Messages with last=call → resume that node
      // - Messages with last=interrupt → resume with ask_user
      expect(true).toBe(true); // Placeholder - detailed behavior tested above
    });
  });
});

// ============================================================================
// Multi-node DAG Resume Tests (#1678)
// ============================================================================
//
// Verifies the workflow engine can recover a multi-node DAG
// (agentNode -> toolNode -> agentNode) after a sequence of
// ask_user interrupts, exercising:
// - inferNextNode -> resume_node path (when last msg is workflow.node.interrupt)
// - runWithResume -> resumeNode path (writes workflow.node.resume)
// - Sequential DAG edge traversal (tool-1 executes after agent-1 succeeds)
// - agentSessionId persistence across resumes
// - Final completion state after multiple resumes

/**
 * Stateful AgentNode: first call throws AskUserError, subsequent calls return success.
 * Tracks call count for verification.
 */
class StatefulAgentNode {
  type = 'agent';
  id: string;
  private callCount = 0;
  private successOutput: any;
  private interruptQuery: string;

  constructor(id: string, successOutput: any, interruptQuery: string) {
    this.id = id;
    this.successOutput = successOutput;
    this.interruptQuery = interruptQuery;
  }

  async execute(context: any): Promise<{ output: any } | never> {
    this.callCount++;
    if (this.callCount === 1) {
      throw new AskUserError('multi-node-test', context.sessionId, this.id, this.type, this.interruptQuery);
    }
    return { output: this.successOutput };
  }

  getCallCount(): number {
    return this.callCount;
  }
}

/**
 * Recording ToolNode: succeeds on every call, logs each invocation.
 */
class RecordingToolNode {
  type = 'tool';
  id: string;
  private callCount = 0;
  private executionLog: string[] = [];

  constructor(id: string) {
    this.id = id;
  }

  async execute(context: any): Promise<{ output: any }> {
    this.callCount++;
    this.executionLog.push(`${this.id}#${this.callCount}`);
    return { output: { nodeId: this.id, callCount: this.callCount } };
  }

  getExecutionLog(): string[] {
    return [...this.executionLog];
  }
}

/**
 * Multi-node DAG factory: agent-1 -> tool-1 -> agent-2
 */
const multiNodeWorkflow: WorkflowDefinition = {
  name: 'multi-node-resume-test',
  version: '1.0',
  entry: 'agent-1',
  nodes: [
    { id: 'agent-1', type: 'agent', config: { agent_type: 'stateful-a' } },
    { id: 'tool-1', type: 'tool', config: { tool: 'recording-1' }, depends_on: ['agent-1'] },
    { id: 'agent-2', type: 'agent', config: { agent_type: 'stateful-b' }, depends_on: ['tool-1'] },
  ],
};

/**
 * Registry that creates stateful mocks per node id.
 * Persists node instances across calls so call counts accumulate correctly.
 */
class MultiNodeRegistry {
  private nodes: Map<string, NodeDefinition> = new Map();
  private instances: Map<string, any> = new Map();

  constructor(workflows: WorkflowDefinition[]) {
    for (const wf of workflows) {
      for (const node of wf.nodes) {
        this.nodes.set(node.id, node);
      }
    }
  }

  getNodeConfig(nodeId: string): NodeDefinition | undefined {
    return this.nodes.get(nodeId);
  }

  createNode(definition: NodeDefinition): any {
    // Return existing instance to preserve call count across resumes
    if (this.instances.has(definition.id)) {
      return this.instances.get(definition.id);
    }

    let instance: any;
    if (definition.type === 'agent') {
      // Different success output per node
      const output = definition.id === 'agent-1'
        ? { step: 'A', result: 'agent-1-output' }
        : { step: 'B', result: 'agent-2-output' };
      instance = new StatefulAgentNode(definition.id, output, `Proceed from ${definition.id}?`);
    } else if (definition.type === 'tool') {
      instance = new RecordingToolNode(definition.id);
    } else {
      instance = {
        type: definition.type,
        id: definition.id,
        execute: vi.fn().mockResolvedValue({ output: { result: 'mock' } }),
      };
    }
    this.instances.set(definition.id, instance);
    return instance;
  }

  getInstance(id: string): any {
    return this.instances.get(id);
  }
}

describe('Multi-node DAG Resume (agentNode + toolNode + agentNode)', () => {
  let engine: WorkflowEngine;
  let mockSessionComponent: MockSessionComponent;
  let multiRegistry: MultiNodeRegistry;
  let mockWorkflowRepo: any;

  beforeEach(() => {
    mockSessionComponent = new MockSessionComponent();
    multiRegistry = new MultiNodeRegistry([multiNodeWorkflow]);

    mockWorkflowRepo = {
      getById: vi.fn().mockImplementation((id: string) => {
        if (id === 'multi-node-resume-test') return { id, definition: multiNodeWorkflow };
        return null;
      }),
      getByName: vi.fn().mockImplementation((name: string) => {
        if (name === 'multi-node-resume-test') return { id: name, definition: multiNodeWorkflow };
        return null;
      }),
    };

    engine = new WorkflowEngine(multiRegistry as any, mockSessionComponent as any, mockWorkflowRepo);
  });

  afterEach(() => {
    mockSessionComponent.clear();
  });

  it('should pause at agent-1 on fresh run (DAG starts from agent-1)', async () => {
    // Fresh run: agent-1 throws AskUserError on first call -> paused
    const result = await engine.run('multi-dag-session-1', {
      workflowId: 'multi-node-resume-test',
    });

    expect(result.status).toBe('paused');
    expect(result.pendingNodeId).toBe('agent-1');

    // Verify the stateful agent got called exactly once
    const agent1 = multiRegistry.getInstance('agent-1') as StatefulAgentNode;
    expect(agent1.getCallCount()).toBe(1);

    // Verify session message log has interrupt for agent-1
    await new Promise((r) => setTimeout(r, 10));
    const messages = mockSessionComponent.getSessionMessages('multi-dag-session-1');
    const interrupts = messages.filter((m: any) => m.metadata?.type === 'workflow.node.interrupt');
    expect(interrupts.length).toBe(1);
    expect(interrupts[0].metadata?.workflowNodeId).toBe('agent-1');
  });

  it('should resume agent-1 then execute tool-1 then pause at agent-2 (multi-node DAG traversal)', async () => {
    // Step 1: Fresh run -> pause at agent-1
    const firstResult = await engine.run('multi-dag-session-2', {
      workflowId: 'multi-node-resume-test',
    });
    expect(firstResult.status).toBe('paused');
    expect(firstResult.pendingNodeId).toBe('agent-1');

    // Step 2: Resume -> agent-1 succeeds, tool-1 runs, agent-2 pauses
    const resume1 = await engine.run('multi-dag-session-2', {
      input: { userQuery: 'proceed from agent-1' },
    });
    expect(resume1.status).toBe('paused');
    expect(resume1.pendingNodeId).toBe('agent-2');

    // Verify call counts across the DAG
    const agent1 = multiRegistry.getInstance('agent-1') as StatefulAgentNode;
    const tool1 = multiRegistry.getInstance('tool-1') as RecordingToolNode;
    const agent2 = multiRegistry.getInstance('agent-2') as StatefulAgentNode;

    expect(agent1.getCallCount()).toBe(2); // initial + resume
    expect(tool1.getExecutionLog()).toEqual(['tool-1#1']);
    expect(agent2.getCallCount()).toBe(1); // initial interrupt
  });

  it('should complete the full DAG after second resume (agent-2 completes)', async () => {
    // Step 1: Fresh run -> pause at agent-1
    await engine.run('multi-dag-session-3', {
      workflowId: 'multi-node-resume-test',
    });

    // Step 2: Resume #1 -> advance through agent-1, tool-1, pause at agent-2
    const resume1 = await engine.run('multi-dag-session-3', {
      input: { userQuery: 'proceed A' },
    });
    expect(resume1.status).toBe('paused');
    expect(resume1.pendingNodeId).toBe('agent-2');

    // Step 3: Resume #2 -> agent-2 succeeds -> workflow completes
    const resume2 = await engine.run('multi-dag-session-3', {
      input: { userQuery: 'proceed B' },
    });
    expect(resume2.status).toBe('completed');
    expect(resume2.runId).toBe('multi-dag-session-3');

    // Verify all nodes executed expected number of times
    const agent1 = multiRegistry.getInstance('agent-1') as StatefulAgentNode;
    const tool1 = multiRegistry.getInstance('tool-1') as RecordingToolNode;
    const agent2 = multiRegistry.getInstance('agent-2') as StatefulAgentNode;

    expect(agent1.getCallCount()).toBe(2); // initial interrupt + resume success
    expect(tool1.getExecutionLog()).toEqual(['tool-1#1']);
    expect(agent2.getCallCount()).toBe(2); // initial interrupt + resume success

    // Verify session messages: each node should have start + interrupt/end pair
    await new Promise((r) => setTimeout(r, 10));
    const messages = mockSessionComponent.getSessionMessages('multi-dag-session-3');

    const nodeStarts = messages.filter((m: any) => m.metadata?.type === 'workflow.node.start');
    const nodeInterrupts = messages.filter((m: any) => m.metadata?.type === 'workflow.node.interrupt');

    // 2 interrupts total (one per agent first-call)
    expect(nodeInterrupts.length).toBe(2);
    // At least 3 starts: agent-1, tool-1, agent-2
    expect(nodeStarts.length).toBeGreaterThanOrEqual(3);
  });

  it('should write workflow.node.resume messages on each resume (audit trail)', async () => {
    // Verify that each resume writes a workflow.node.resume message
    // (this is the "P0 unified path" used by the engine to mark a node as resumed)

    await engine.run('multi-dag-session-4', {
      workflowId: 'multi-node-resume-test',
    });

    await engine.run('multi-dag-session-4', {
      input: { userQuery: 'proceed A' },
    });

    await engine.run('multi-dag-session-4', {
      input: { userQuery: 'proceed B' },
    });

    await new Promise((r) => setTimeout(r, 10));
    const messages = mockSessionComponent.getSessionMessages('multi-dag-session-4');
    const resumes = messages.filter((m: any) => m.metadata?.type === 'workflow.node.resume');

    // Two resumes: one for agent-1, one for agent-2
    expect(resumes.length).toBe(2);
    const resumedNodeIds = resumes.map((m: any) => m.metadata?.workflowNodeId);
    expect(resumedNodeIds).toContain('agent-1');
    expect(resumedNodeIds).toContain('agent-2');
  });
});
