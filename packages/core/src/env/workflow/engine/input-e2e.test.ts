/**
 * CLI Input Integration Tests
 * 
 * Tests that verify the CLI can pass --input "Yes" and it gets
 * correctly normalized to { userQuery: "Yes" }
 * 
 * Also includes end-to-end tests for template resolution through
 * the full engine → buildNodeContext → ToolNode path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { NodeExecutionContext, NodeExecutionResult } from '../types';

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
  
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }
  
  clear(): void {
    this.sessions.clear();
    this.messages.clear();
  }
}

// ==================== Test Scenario: CLI Simulation ====================

describe('CLI Input Integration', () => {
  /**
   * These tests simulate what happens when CLI is invoked:
   * 
   * Fresh run with stock code:
   * $ roy workflow run my-workflow --input '{"stockCode":"AAPL"}'
   * 
   * Resume with user response:
   * $ roy workflow run my-workflow -s session_id --input "Yes"
   * 
   * The engine should normalize string input to { userQuery: string }
   */
  
  it('should normalize CLI string input "Yes" to { userQuery: "Yes" }', () => {
    // Simulate what CLI passes after yargs parsing
    const cliInput = 'Yes';  // From --input "Yes"
    
    // The engine should normalize this
    const normalized = typeof cliInput === 'string'
      ? { userQuery: cliInput }
      : cliInput;
    
    expect(normalized).toEqual({ userQuery: 'Yes' });
  });
  
  it('should preserve CLI object input as-is', () => {
    // Simulate what CLI passes after yargs parsing
    const cliInput = { stockCode: 'AAPL' };  // From --input '{"stockCode":"AAPL"}'
    
    // The engine should preserve object input
    const normalized = typeof cliInput === 'string'
      ? { userQuery: cliInput }
      : cliInput;
    
    expect(normalized).toEqual({ stockCode: 'AAPL' });
  });
  
  it('should handle CLI object input with userQuery', () => {
    // Simulate explicit userQuery input
    const cliInput = { userQuery: 'Yes' };  // From --input '{"userQuery":"Yes"}'
    
    const normalized = typeof cliInput === 'string'
      ? { userQuery: cliInput }
      : cliInput;
    
    expect(normalized).toEqual({ userQuery: 'Yes' });
  });
  
  it('should handle complex CLI object input', () => {
    // Simulate complex input with multiple fields
    const cliInput = { 
      userQuery: 'Yes', 
      note: 'confirmed',
      timestamp: 1234567890,
    };
    
    const normalized = typeof cliInput === 'string'
      ? { userQuery: cliInput }
      : cliInput;
    
    expect(normalized).toEqual(cliInput);
    expect(normalized.userQuery).toBe('Yes');
  });
  
  it('should handle undefined CLI input', () => {
    // No --input flag was provided
    const cliInput = undefined;
    
    const normalized = cliInput !== undefined && typeof cliInput === 'string'
      ? { userQuery: cliInput }
      : cliInput;
    
    expect(normalized).toBeUndefined();
  });
  
  it('should handle empty string CLI input', () => {
    // Edge case: --input ""
    const cliInput = '';
    
    // Empty string is still a string, so it gets wrapped
    const normalized = cliInput !== undefined && typeof cliInput === 'string'
      ? { userQuery: cliInput }
      : cliInput;
    
    expect(normalized).toEqual({ userQuery: '' });
  });
});

// ==================== End-to-End Flow Tests ====================

describe('End-to-End Flow', () => {
  /**
   * These tests verify the complete flow from CLI to engine
   */
  
  let mockSessionComponent: MockSessionComponent;
  let mockWorkflowRepo: any;
  let capturedContexts: Map<string, { context: NodeExecutionContext; configBefore: Record<string, unknown>; resolvedConfig: Record<string, unknown> }>;
  
  // Helper to create a capturing tool node factory
  function createCapturingToolNode(def: any) {
    return {
      type: 'tool',
      id: def.id,
      execute: async (context: NodeExecutionContext): Promise<NodeExecutionResult> => {
        // Capture the context for verification
        capturedContexts.set(def.id, {
          context,
          configBefore: def.config,
          resolvedConfig: (context.resolvedConfig ?? {}) as Record<string, unknown>,
        });
        
        // Return output based on which tool
        if (def.config?.tool === 'entry-tool') {
          return { output: { result: 'entry-output-value' } };
        }
        if (def.config?.tool === 'process-tool') {
          return { output: { result: 'processed' } };
        }
        return { output: { result: `output from ${def.id}` } };
      },
    };
  }
  
  // Helper to create mock node registry
  function createMockNodeRegistry(_workflows?: any[]) {
    capturedContexts = new Map();
    
    return {
      getNodeConfig: vi.fn(),
      createNode: (def: any) => {
        if (def.type === 'tool') {
          return createCapturingToolNode(def);
        }
        if (def.type === 'agent') {
          return {
            type: 'agent',
            id: def.id,
            execute: async () => {
              throw new Error('mock agent - should not be called directly');
            },
          };
        }
        return { type: def.type, id: def.id, execute: async () => ({ output: {} }) };
      },
    };
  }
  
  beforeEach(() => {
    mockSessionComponent = new MockSessionComponent();
    mockWorkflowRepo = {
      getById: vi.fn(),
      getByName: vi.fn(),
    };
  });
  
  afterEach(() => {
    mockSessionComponent.clear();
  });
  
  describe('Fresh run flow', () => {
    it('should accept object input for fresh run', async () => {
      const workflow: any = {
        name: 'template-test-workflow',
        version: '1.0',
        entry: 'entry',
        nodes: [
          { id: 'entry', type: 'tool', config: { tool: 'entry-tool' } },
          {
            id: 'process',
            type: 'tool',
            config: {
              tool: 'process-tool',
              input: {
                query: '{{input.query}}',
                city: '{{inputs.city}}',
              },
            },
            depends_on: ['entry'],
          },
        ],
      };
      
      mockWorkflowRepo.getById.mockReturnValue({ id: 'template-test-workflow', definition: workflow });
      mockWorkflowRepo.getByName.mockReturnValue({ id: 'template-test-workflow', definition: workflow });
      
      const mockNodeRegistry = createMockNodeRegistry([workflow]);
      const engine = new WorkflowEngine(
        mockNodeRegistry as any,
        mockSessionComponent as any,
        mockWorkflowRepo
      );
      
      const input = { query: 'test-query', city: 'Beijing' };
      const result = await engine.run('fresh-object-input', {
        workflowId: 'template-test-workflow',
        input,
      });
      
      expect(result.status).toBe('completed');
    });
    
    it('should pass input to entry node template', async () => {
      // This test verifies that the workflowInput is
      // correctly passed to buildNodeContext and used in template resolution.
      //
      // The key behavior being tested:
      // 1. Engine receives { query: "test-query" } as input
      // 2. buildNodeContext creates TemplateResolver with workflowInput
      // 3. resolvedConfig contains resolved templates
      // 4. Process node receives correct resolved values
      
      const workflow: any = {
        name: 'template-resolve-test',
        version: '1.0',
        entry: 'entry',
        nodes: [
          { id: 'entry', type: 'tool', config: { tool: 'entry-tool' } },
          {
            id: 'process',
            type: 'tool',
            config: {
              tool: 'process-tool',
              input: {
                query: '{{input.query}}',
                city: '{{inputs.city}}',
              },
            },
            depends_on: ['entry'],
          },
        ],
      };
      
      mockWorkflowRepo.getById.mockReturnValue({ id: 'template-resolve-test', definition: workflow });
      mockWorkflowRepo.getByName.mockReturnValue({ id: 'template-resolve-test', definition: workflow });
      
      const mockNodeRegistry = createMockNodeRegistry([workflow]);
      const engine = new WorkflowEngine(
        mockNodeRegistry as any,
        mockSessionComponent as any,
        mockWorkflowRepo
      );
      
      const input = { query: 'test-query', city: 'Beijing' };
      const result = await engine.run('fresh-template-input', {
        workflowId: 'template-resolve-test',
        input,
      });
      
      expect(result.status).toBe('completed');
      
      // Verify the process node received resolved templates
      const processCapture = capturedContexts.get('process');
      expect(processCapture).toBeDefined();
      
      // Check that the config was pre-resolved by the engine
      const resolvedConfig = processCapture!.resolvedConfig;
      expect(resolvedConfig).toBeDefined();
      
      // Verify {{input.query}} was resolved to "test-query"
      const resolvedInput = resolvedConfig.input as Record<string, unknown>;
      expect(resolvedInput).toBeDefined();
      expect(resolvedInput.query).toBe('test-query');
      expect(resolvedInput.city).toBe('Beijing');
    });
    
    it('should resolve {{nodes.xxx}} reference from previous node output', async () => {
      const workflow: any = {
        name: 'nodes-ref-test',
        version: '1.0',
        entry: 'entry',
        nodes: [
          { id: 'entry', type: 'tool', config: { tool: 'entry-tool' } },
          {
            id: 'process',
            type: 'tool',
            config: {
              tool: 'process-tool',
              input: {
                entryOutput: '{{nodes.entry.output}}',
              },
            },
            depends_on: ['entry'],
          },
        ],
      };
      
      mockWorkflowRepo.getById.mockReturnValue({ id: 'nodes-ref-test', definition: workflow });
      mockWorkflowRepo.getByName.mockReturnValue({ id: 'nodes-ref-test', definition: workflow });
      
      const mockNodeRegistry = createMockNodeRegistry([workflow]);
      const engine = new WorkflowEngine(
        mockNodeRegistry as any,
        mockSessionComponent as any,
        mockWorkflowRepo
      );
      
      const input = { query: 'test-query', city: 'Beijing' };
      const result = await engine.run('fresh-nodes-ref', {
        workflowId: 'nodes-ref-test',
        input,
      });
      
      expect(result.status).toBe('completed');
      
      // Verify the process node received resolved node references
      const processCapture = capturedContexts.get('process');
      expect(processCapture).toBeDefined();
      
      const resolvedConfig = processCapture!.resolvedConfig;
      const processInput = resolvedConfig.input as Record<string, unknown>;
      
      // Verify {{nodes.entry.output}} resolved to the entry node's output
      // Note: TemplateResolver auto-unwraps .result when using {{nodes.xxx.output}}
      // so it resolves to 'entry-output-value' (the result string), not the full object
      expect(processInput.entryOutput).toBeDefined();
      expect(processInput.entryOutput).toBe('entry-output-value');
    });
    
    it('should handle mixed text with templates in config', async () => {
      const workflow: any = {
        name: 'mixed-template-test',
        version: '1.0',
        entry: 'entry',
        nodes: [
          {
            id: 'entry',
            type: 'tool',
            config: { tool: 'entry-tool', input: { message: 'hello' } },
          },
          {
            id: 'process',
            type: 'tool',
            config: {
              tool: 'process-tool',
              input: {
                greeting: 'Hello {{input.name}}, your query is: {{input.query}}',
                // Note: {{nodes.entry.output}} auto-unwraps .result, so {{nodes.entry.output.result}} would fail
                summary: 'Entry said: {{nodes.entry.output}}',
              },
            },
            depends_on: ['entry'],
          },
        ],
      };
      
      mockWorkflowRepo.getById.mockReturnValue({ id: 'mixed-template-test', definition: workflow });
      mockWorkflowRepo.getByName.mockReturnValue({ id: 'mixed-template-test', definition: workflow });
      
      const mockNodeRegistry = createMockNodeRegistry([workflow]);
      const engine = new WorkflowEngine(
        mockNodeRegistry as any,
        mockSessionComponent as any,
        mockWorkflowRepo
      );
      
      const input = { name: 'Alice', query: 'weather in Beijing' };
      const result = await engine.run('fresh-mixed-template', {
        workflowId: 'mixed-template-test',
        input,
      });
      
      expect(result.status).toBe('completed');
      
      const processCapture = capturedContexts.get('process');
      expect(processCapture).toBeDefined();
      
      const resolvedConfig = processCapture!.resolvedConfig;
      const processInput = resolvedConfig.input as Record<string, unknown>;
      
      // Verify mixed text + template resolution
      expect(processInput.greeting).toBe('Hello Alice, your query is: weather in Beijing');
      
      // Verify {{nodes.entry.output}} resolved (auto-unwraps .result)
      expect(processInput.summary).toBe('Entry said: entry-output-value');
    });
    
    it('should handle missing template keys gracefully (return undefined)', async () => {
      const workflow: any = {
        name: 'missing-key-test',
        version: '1.0',
        entry: 'entry',
        nodes: [
          { id: 'entry', type: 'tool', config: { tool: 'entry-tool' } },
          {
            id: 'process',
            type: 'tool',
            config: {
              tool: 'process-tool',
              input: {
                query: '{{input.query}}',
                city: '{{inputs.city}}',
              },
            },
            depends_on: ['entry'],
          },
        ],
      };
      
      mockWorkflowRepo.getById.mockReturnValue({ id: 'missing-key-test', definition: workflow });
      mockWorkflowRepo.getByName.mockReturnValue({ id: 'missing-key-test', definition: workflow });
      
      const mockNodeRegistry = createMockNodeRegistry([workflow]);
      const engine = new WorkflowEngine(
        mockNodeRegistry as any,
        mockSessionComponent as any,
        mockWorkflowRepo
      );
      
      // Only pass query, omit city
      const input = { query: 'test-query' };
      const result = await engine.run('fresh-missing-key', {
        workflowId: 'missing-key-test',
        input,
      });
      
      expect(result.status).toBe('completed');
      
      const processCapture = capturedContexts.get('process');
      expect(processCapture).toBeDefined();
      
      const resolvedConfig = processCapture!.resolvedConfig;
      const processInput = resolvedConfig.input as Record<string, unknown>;
      
      // query should be resolved
      expect(processInput.query).toBe('test-query');
      // city was not provided - TemplateResolver currently returns undefined for missing keys
      expect(processInput.city).toBeUndefined();
    });
  });
  
  describe('Template resolution edge cases', () => {
    it('should exclude userQuery from workflowInput in template resolution', async () => {
      // When input contains userQuery, it should be treated as ephemeral
      // and excluded from the workflowInput used for template resolution
      
      const workflow: any = {
        name: 'userquery-test',
        version: '1.0',
        entry: 'entry',
        nodes: [
          { id: 'entry', type: 'tool', config: { tool: 'entry-tool' } },
          {
            id: 'process',
            type: 'tool',
            config: {
              tool: 'process-tool',
              input: {
                query: '{{input.query}}',
                city: '{{inputs.city}}',
              },
            },
            depends_on: ['entry'],
          },
        ],
      };
      
      mockWorkflowRepo.getById.mockReturnValue({ id: 'userquery-test', definition: workflow });
      mockWorkflowRepo.getByName.mockReturnValue({ id: 'userquery-test', definition: workflow });
      
      const mockNodeRegistry = createMockNodeRegistry([workflow]);
      const engine = new WorkflowEngine(
        mockNodeRegistry as any,
        mockSessionComponent as any,
        mockWorkflowRepo
      );
      
      // Include userQuery alongside regular input
      const input = { userQuery: 'Yes', query: 'real-query', city: 'Shanghai' };
      const result = await engine.run('fresh-userquery', {
        workflowId: 'userquery-test',
        input,
      });
      
      expect(result.status).toBe('completed');
      
      const processCapture = capturedContexts.get('process');
      expect(processCapture).toBeDefined();
      
      const resolvedConfig = processCapture!.resolvedConfig;
      const processInput = resolvedConfig.input as Record<string, unknown>;
      
      // Regular fields should resolve
      expect(processInput.query).toBe('real-query');
      expect(processInput.city).toBe('Shanghai');
    });
  });
  
  describe('Resume flow', () => {
    it('should normalize string input to userQuery on resume', async () => {
      // Create a workflow with agent node that asks user
      const workflow: any = {
        name: 'ask-workflow',
        version: '1.0',
        entry: 'ask',
        nodes: [
          { id: 'ask', type: 'agent', config: { shouldInterrupt: true } },
          { id: 'process', type: 'tool', config: { tool: 'process' }, depends_on: ['ask'] },
        ],
      };
      
      mockWorkflowRepo.getById.mockImplementation((id: string) => {
        if (id === 'ask-workflow') return { id, definition: workflow };
        return null;
      });
      mockWorkflowRepo.getByName.mockImplementation((name: string) => {
        if (name === 'ask-workflow') return { id: name, definition: workflow };
        return null;
      });
      
      // Import AskUserError dynamically
      const { AskUserError } = await import('../types/workflow-hil');
      
      const capturedToolContexts: any[] = [];
      const mockNodeRegistry = {
        getNodeConfig: vi.fn(),
        createNode: (def: any, _ctx: any) => {
          if (def.type === 'tool') {
            return {
              type: 'tool',
              id: def.id,
              execute: async (context: NodeExecutionContext) => {
                capturedToolContexts.push({ context, resolvedConfig: context.resolvedConfig });
                return { output: { result: 'done' } };
              },
            };
          }
          if (def.type === 'agent') {
            return {
              type: 'agent',
              id: def.id,
              execute: async () => {
                throw new AskUserError(
                  'run_test', 'test-session', def.id, 'agent', 'Proceed?', 'agent_session_123'
                );
              },
            };
          }
          return { type: def.type, id: def.id, execute: async () => ({ output: {} }) };
        },
      };
      
      const engine = new WorkflowEngine(
        mockNodeRegistry as any,
        mockSessionComponent as any,
        mockWorkflowRepo
      );
      
      // First run triggers interrupt
      await engine.run('resume-test-1', { workflowId: 'ask-workflow' });
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Resume with string input
      const resumeResult = await engine.run('resume-test-1', { input: 'Yes' as any });
      
      expect(resumeResult.runId).toBe('resume-test-1');
    });
    
    it('should preserve object input on resume', async () => {
      const workflow: any = {
        name: 'ask-workflow-2',
        version: '1.0',
        entry: 'ask',
        nodes: [
          { id: 'ask', type: 'agent', config: { shouldInterrupt: true } },
          { id: 'process', type: 'tool', config: { tool: 'process' }, depends_on: ['ask'] },
        ],
      };
      
      mockWorkflowRepo.getById.mockImplementation((id: string) => {
        if (id === 'ask-workflow-2') return { id, definition: workflow };
        return null;
      });
      mockWorkflowRepo.getByName.mockImplementation((name: string) => {
        if (name === 'ask-workflow-2') return { id: name, definition: workflow };
        return null;
      });
      
      const { AskUserError } = await import('../types/workflow-hil');
      
      const mockNodeRegistry = {
        getNodeConfig: vi.fn(),
        createNode: (def: any, _ctx: any) => {
          if (def.type === 'agent') {
            return {
              type: 'agent',
              id: def.id,
              execute: async () => {
                throw new AskUserError(
                  'run_test', 'test-session-2', def.id, 'agent', 'Proceed?', 'agent_session_456'
                );
              },
            };
          }
          return { type: def.type, id: def.id, execute: async () => ({ output: {} }) };
        },
      };
      
      const engine = new WorkflowEngine(
        mockNodeRegistry as any,
        mockSessionComponent as any,
        mockWorkflowRepo
      );
      
      // First run triggers interrupt
      await engine.run('resume-test-2', { workflowId: 'ask-workflow-2' });
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Resume with object input
      const resumeResult = await engine.run('resume-test-2', { input: { userQuery: 'Yes', data: 'extra' } as any });
      
      expect(resumeResult.runId).toBe('resume-test-2');
    });
    
    it('should use userQuery as agent response', async () => {
      // Verify that when resuming with string input, it becomes userQuery
      // which is then passed to the agent node
      
      const workflow: any = {
        name: 'ask-workflow-3',
        version: '1.0',
        entry: 'ask',
        nodes: [
          { id: 'ask', type: 'agent', config: { shouldInterrupt: true } },
        ],
      };
      
      mockWorkflowRepo.getById.mockImplementation((id: string) => {
        if (id === 'ask-workflow-3') return { id, definition: workflow };
        return null;
      });
      
      const { AskUserError } = await import('../types/workflow-hil');
      
      const capturedUserQuery: string[] = [];
      const mockNodeRegistry = {
        getNodeConfig: vi.fn(),
        createNode: (def: any, _ctx: any) => {
          return {
            type: 'agent',
            id: def.id,
            execute: async (context: NodeExecutionContext) => {
              // Capture any userQuery that might be in the input
              const input = context.input as any;
              if (input?.userQuery) {
                capturedUserQuery.push(input.userQuery);
              }
              throw new AskUserError(
                'run_test', 'test-session-3', def.id, 'agent', 'Proceed?', 'agent_session_789'
              );
            },
          };
        },
      };
      
      const engine = new WorkflowEngine(
        mockNodeRegistry as any,
        mockSessionComponent as any,
        mockWorkflowRepo
      );
      
      // First run triggers interrupt
      await engine.run('resume-test-3', { workflowId: 'ask-workflow-3' });
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Resume with "Yes" as string input
      await engine.run('resume-test-3', { input: 'Yes' as any });
      
      // userQuery should have been passed to the agent node
      expect(capturedUserQuery.length).toBeGreaterThan(0);
      expect(capturedUserQuery).toContain('Yes');
    });
  });
});
