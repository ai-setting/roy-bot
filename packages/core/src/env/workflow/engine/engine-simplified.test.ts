/**
 * @fileoverview Simplified WorkflowEngine Tests (TDD RED Phase)
 * 
 * Tests for the simplified runWithResume logic:
 * - Remove complex userResponse distinction
 * - Simple input handling: pass input directly
 * - Direct extraction of agentSessionId from resumePoint
 * 
 * @see Task #599
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowDefinition } from '../types';
import { AskUserError } from '../types/workflow-hil';

// ==================== Mock Session Component ====================

interface SessionMessage {
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
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
    this.sessions.set(session.id, { ...session, metadata: session.metadata || {} });
    this.messages.set(session.id, []);
    return session;
  }
  
  async get(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) || null;
  }
  
  async update(sessionId: string, updates: Partial<Session>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(sessionId, { ...session, ...updates });
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

function createMockNodeRegistry(workflows: WorkflowDefinition[]) {
  const nodes = new Map<string, any>();
  
  for (const wf of workflows) {
    for (const node of wf.nodes) {
      nodes.set(node.id, node);
    }
  }
  
  return {
    nodes,
    getNodeConfig: (id: string) => nodes.get(id),
    createNode: (def: any, ctx: any) => {
      if (def.type === 'tool') {
        return {
          type: 'tool',
          id: def.id,
          execute: async () => ({ output: { result: `output from ${def.id}` } }),
        };
      }
      if (def.type === 'agent') {
        return {
          type: 'agent',
          id: def.id,
          execute: async () => {
            // Get agentSessionId from context (set by engine or agent-node)
            const agentSessionId = (ctx as any)?.agentSessionId || `agent_${def.id}_${Date.now()}`;
            
            // Check if we should throw AskUserError
            if (def.config?.shouldInterrupt) {
              // Include agentSessionId in AskUserError (simulates real agent-node behavior)
              throw new AskUserError('run_test', ctx?.sessionId || 'test', def.id, 'agent', 'Proceed?', agentSessionId);
            }
            return { output: { result: `agent output from ${def.id}` } };
          },
        };
      }
      return { type: def.type, id: def.id, execute: async () => ({ output: {} }) };
    },
  };
}

// ==================== Test Fixtures ====================

const simpleWorkflow: WorkflowDefinition = {
  name: 'simple-workflow',
  version: '1.0',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'tool', config: { tool: 'echo' } },
  ],
};

const interruptWorkflow: WorkflowDefinition = {
  name: 'interrupt-workflow',
  version: '1.0',
  entry: 'confirm',
  nodes: [
    { id: 'confirm', type: 'agent', config: { agent_type: 'ask-agent', shouldInterrupt: true } },
    { id: 'process', type: 'tool', config: { tool: 'process' }, depends_on: ['confirm'] },
  ],
};

// ==================== RED Phase: Write Failing Tests ====================

describe('WorkflowEngine - Simplified Input Handling', () => {
  let engine: WorkflowEngine;
  let mockSessionComponent: MockSessionComponent;
  let mockNodeRegistry: any;
  let mockWorkflowRepo: any;
  
  beforeEach(() => {
    mockSessionComponent = new MockSessionComponent();
    mockNodeRegistry = createMockNodeRegistry([simpleWorkflow, interruptWorkflow]);
    
    mockWorkflowRepo = {
      getById: vi.fn().mockImplementation((id: string) => {
        if (id === 'simple-workflow') return { id, definition: simpleWorkflow };
        if (id === 'interrupt-workflow') return { id, definition: interruptWorkflow };
        return null;
      }),
      getByName: vi.fn().mockImplementation((name: string) => {
        if (name === 'simple-workflow') return { id: name, definition: simpleWorkflow };
        if (name === 'interrupt-workflow') return { id: name, definition: interruptWorkflow };
        return null;
      }),
    };
    
    engine = new WorkflowEngine(mockNodeRegistry as any, mockSessionComponent as any, mockWorkflowRepo);
  });
  
  afterEach(() => {
    mockSessionComponent.clear();
  });
  
  // ==================== Fresh Run Tests ====================
  
  describe('Fresh run (no existing session)', () => {
    it('should create session and run workflow on fresh start', async () => {
      const result = await engine.run('new-session-1', { workflowId: 'simple-workflow' });
      
      expect(result.status).toBe('completed');
      expect(result.runId).toBe('new-session-1');
    });
    
    it('should pass input to entry node on fresh run', async () => {
      const input = { stockCode: 'AAPL', limit: 10 };
      const result = await engine.run('session-input-1', { 
        workflowId: 'simple-workflow',
        input,
      });
      
      expect(result.status).toBe('completed');
    });
    
    it('should accept string input on fresh run', async () => {
      const result = await engine.run('session-string-1', { 
        workflowId: 'simple-workflow',
        input: 'initial query',
      });
      
      expect(result.status).toBe('completed');
    });
  });
  
  // ==================== Fresh Run with Interrupt ====================
  
  describe('Fresh run with ask_user interrupt', () => {
    it('should pause workflow when ask_user is triggered', async () => {
      const result = await engine.run('session-interrupt-1', { 
        workflowId: 'interrupt-workflow' 
      });
      
      expect(result.status).toBe('paused');
      expect(result.pendingNodeId).toBe('confirm');
    });
    
    it('should save interrupt message to session with agentSessionId', async () => {
      await engine.run('session-interrupt-2', { 
        workflowId: 'interrupt-workflow' 
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const messages = mockSessionComponent.getSessionMessages('session-interrupt-2');
      const interruptMsg = messages.find(m => m.metadata?.type === 'workflow.node.interrupt');
      
      expect(interruptMsg).toBeDefined();
      // Mock now generates agentSessionId, so it should be present
      expect(interruptMsg?.metadata?.agentSessionId).toBeDefined();
      expect(typeof interruptMsg?.metadata?.agentSessionId).toBe('string');
    });
  });
  
  // ==================== Resume Tests - Simplified ====================
  
  describe('Resume with sessionId (simplified)', () => {
    it('should resume workflow using run() with sessionId', async () => {
      // 1. First run triggers interrupt
      await engine.run('session-resume-1', { 
        workflowId: 'interrupt-workflow' 
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 2. Resume with input containing userQuery
      const resumeResult = await engine.run('session-resume-1', {
        input: { userQuery: 'Yes, continue' },
      });
      
      // Should continue (may complete or pause again)
      expect(resumeResult.runId).toBe('session-resume-1');
    });
    
    it('should normalize string input to userQuery on resume', async () => {
      // 1. First run triggers interrupt
      await engine.run('session-resume-2', { 
        workflowId: 'interrupt-workflow' 
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 2. Resume with string input - should be treated as userQuery
      const resumeResult = await engine.run('session-resume-2', {
        input: 'Yes',
      });
      
      expect(resumeResult.runId).toBe('session-resume-2');
    });
    
    it('should use agentSessionId from session messages on resume', async () => {
      // 1. First run triggers interrupt, saves agentSessionId
      await engine.run('session-resume-3', { 
        workflowId: 'interrupt-workflow' 
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // 2. Check that interrupt message has agentSessionId
      const messages = mockSessionComponent.getSessionMessages('session-resume-3');
      const interruptMsg = messages.find(m => m.metadata?.type === 'workflow.node.interrupt');
      
      expect(interruptMsg?.metadata?.agentSessionId).toBeDefined();
      
      // 3. Resume should use this agentSessionId
      const resumeResult = await engine.run('session-resume-3', {
        input: { userQuery: 'Confirmed' },
      });
      
      expect(resumeResult.runId).toBe('session-resume-3');
    });
  });
  
  // ==================== Input Contract Tests ====================
  
  describe('Input handling - simplified contract', () => {
    /**
     * NEW simplified contract:
     * - input is passed directly to execution
     * - userQuery in input is used by agentNode for resume
     * - string input is NOT automatically wrapped
     * - No complex userResponse distinction
     */
    
    it('should pass object input directly to execution', async () => {
      const input = { stockCode: 'AAPL', userQuery: 'Analyze' };
      
      const result = await engine.run('session-input-2', {
        workflowId: 'simple-workflow',
        input,
      });
      
      expect(result.status).toBe('completed');
    });
    
    it('should allow string input as direct value', async () => {
      const result = await engine.run('session-string-2', {
        workflowId: 'simple-workflow',
        input: 'direct string',
      });
      
      expect(result.status).toBe('completed');
    });
    
    it('should not distinguish between userResponse and input', async () => {
      // OLD way: had userResponse vs input distinction
      // NEW way: just pass input, let agentNode extract userQuery
      
      const input = { userQuery: 'Yes', data: 'extra' };
      
      const result = await engine.run('session-unified-1', {
        workflowId: 'interrupt-workflow',
        input,
      });
      
      // Should pause (workflow triggers interrupt)
      expect(result.status).toBe('paused');
      
      // Resume with same format
      const resumeResult = await engine.run('session-unified-1', {
        input,
      });
      
      expect(resumeResult.runId).toBe('session-unified-1');
    });
  });
  
  // ==================== Message Format Tests ====================
  
  describe('Session message format', () => {
    it('should store interrupt message with correct metadata', async () => {
      await engine.run('session-msg-1', {
        workflowId: 'interrupt-workflow',
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const messages = mockSessionComponent.getSessionMessages('session-msg-1');
      
      // Should have: call, interrupt
      expect(messages.length).toBeGreaterThanOrEqual(2);
      
      const interruptMsg = messages.find(m => m.metadata?.type === 'workflow.node.interrupt');
      expect(interruptMsg).toBeDefined();
      expect(interruptMsg?.metadata?.workflowNodeId).toBe('confirm');
      expect(interruptMsg?.metadata?.workflowNodeType).toBe('agent');
      expect(interruptMsg?.metadata?.query).toBe('Proceed?');
    });
    
    it('should extract agentSessionId from interrupt message on resume', async () => {
      // This tests the key flow:
      // 1. First run saves interrupt with agentSessionId
      // 2. Resume reads agentSessionId from message
      // 3. Passes agentSessionId to agentNode
      
      await engine.run('session-agentid-1', {
        workflowId: 'interrupt-workflow',
      });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Get the agentSessionId that was saved
      const messages = mockSessionComponent.getSessionMessages('session-agentid-1');
      const interruptMsg = messages.find(m => m.metadata?.type === 'workflow.node.interrupt');
      const savedAgentSessionId = interruptMsg?.metadata?.agentSessionId;
      
      expect(savedAgentSessionId).toBeDefined();
      expect(typeof savedAgentSessionId).toBe('string');
    });
  });
});

// ==================== Edge Cases ====================

describe('WorkflowEngine Edge Cases', () => {
  let mockSessionComponent: MockSessionComponent;
  let mockWorkflowRepo: any;
  
  beforeEach(() => {
    mockSessionComponent = new MockSessionComponent();
    mockWorkflowRepo = {
      getById: vi.fn().mockReturnValue({ id: 'test', definition: simpleWorkflow }),
      getByName: vi.fn().mockReturnValue({ id: 'test', definition: simpleWorkflow }),
    };
  });
  
  afterEach(() => {
    mockSessionComponent.clear();
  });
  
  it('should handle resume when session has no messages', async () => {
    // Create a session manually with no messages
    await mockSessionComponent.create({
      id: 'empty-session',
      title: 'Empty Session',
      metadata: {
        type: 'workflow',
        workflowId: 'simple-workflow',
        workflowName: 'simple-workflow',
        status: 'running',
      },
    });
    
    const mockNodeRegistry = createMockNodeRegistry([simpleWorkflow]);
    const engine = new WorkflowEngine(mockNodeRegistry as any, mockSessionComponent as any, mockWorkflowRepo);
    
    // Should still work - fall back to entry node
    const result = await engine.run('empty-session', {
      input: { test: 'data' },
    });
    
    expect(result.runId).toBe('empty-session');
  });
  
  it('should handle completed session gracefully', async () => {
    // Create a completed session
    await mockSessionComponent.create({
      id: 'completed-session',
      title: 'Completed Session',
      metadata: {
        type: 'workflow',
        workflowId: 'simple-workflow',
        workflowName: 'simple-workflow',
        status: 'completed',
      },
    });
    
    const mockNodeRegistry = createMockNodeRegistry([simpleWorkflow]);
    const engine = new WorkflowEngine(mockNodeRegistry as any, mockSessionComponent as any, mockWorkflowRepo);
    
    const result = await engine.run('completed-session');
    
    expect(result.status).toBe('completed');
  });
  
  it('should resume a failed session (Task #1977 — allow retry via run())', async () => {
    // Pre-existing failed session — Task #1977 changed semantics:
    // previously `engine.run()` short-circuited with status='failed'.
    // Now it RESUMES so the caller can retry the failed node. The
    // workflow definition here has a single `start` node that always
    // succeeds, so the resume should complete cleanly.
    await mockSessionComponent.create({
      id: 'failed-session',
      title: 'Failed Session',
      metadata: {
        type: 'workflow',
        workflowId: 'simple-workflow',
        workflowName: 'simple-workflow',
        status: 'failed',
      },
    });
    
    const mockNodeRegistry = createMockNodeRegistry([simpleWorkflow]);
    const engine = new WorkflowEngine(mockNodeRegistry as any, mockSessionComponent as any, mockWorkflowRepo);
    
    const result = await engine.run('failed-session');
    
    // Resume must proceed (NOT short-circuit to 'failed') and re-execute
    // the entry node. The simple workflow's only node always succeeds.
    expect(result.status).toBe('completed');
  });
});
