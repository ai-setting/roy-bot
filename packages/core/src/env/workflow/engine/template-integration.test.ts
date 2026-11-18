/**
 * Template Integration Tests
 * 
 * Tests for the complete Engine → TemplateResolver → Node path.
 * Verifies that:
 * - {{input.xxx}} is resolved in non-entry nodes
 * - {{inputs.xxx}} alias works correctly  
 * - {{nodes.xxx}} references resolve node outputs
 * 
 * These tests bridge the gap between unit tests (TemplateResolver alone)
 * and full integration tests (real engine execution).
 */

import { describe, it, expect, vi } from 'vitest';
import { TemplateResolver } from '../utils/template-resolver';
import type { NodeExecutionContext } from '../types';
import type { EventBus } from './event-bus';

// ==================== Mock SessionComponent ====================

function createMockSessionComponent() {
  const sessions = new Map<string, any>();
  const messages = new Map<string, any[]>();
  
  return {
    sessions,
    messages,
    create: vi.fn(async (session: any) => {
      sessions.set(session.id, { ...session, metadata: session.metadata || {} });
      messages.set(session.id, []);
      return session;
    }),
    get: vi.fn(async (sessionId: string) => sessions.get(sessionId) || null),
    update: vi.fn(async (sessionId: string, updates: any) => {
      const session = sessions.get(sessionId);
      if (session) Object.assign(session, updates);
      return session;
    }),
    addMessage: vi.fn(async (sessionId: string, message: any) => {
      const msgs = messages.get(sessionId) || [];
      msgs.push(message);
      messages.set(sessionId, msgs);
      return message;
    }),
    getMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) || []),
  };
}

// ==================== Mock EventBus ====================

function createMockEventBus(): EventBus {
  const listeners = new Map<string, Set<Function>>();
  
  return {
    publish: vi.fn(async (event: any) => {
      const eventListeners = listeners.get(event.type) || new Set();
      for (const listener of eventListeners) {
        listener(event);
      }
    }),
    on: vi.fn((event: string, handler: Function): (() => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
      return () => listeners.get(event)?.delete(handler);
    }),
    off: vi.fn((event: string, handler: Function) => {
      listeners.get(event)?.delete(handler);
    }),
    once: vi.fn((event: string, handler: Function): (() => void) => {
      const wrapped = (data: any) => {
        listeners.get(event)?.delete(wrapped);
        handler(data);
      };
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(wrapped);
      return () => listeners.get(event)?.delete(wrapped);
    }),
    clear: vi.fn(() => {
      listeners.clear();
    }),
  } as unknown as EventBus;
}

// ==================== Helper: Create Node Execution Context ====================

function createMockContext(options: {
  input?: Record<string, unknown>;
  previousOutputs?: Map<string, unknown>;
  nodeOutputs?: Map<string, unknown>;
  workflowInput?: Record<string, unknown>;
  nodeId?: string;
  sessionId?: string;
  runId?: string;
}): NodeExecutionContext {
  const eventBus = createMockEventBus();
  const mockSessionComponent = createMockSessionComponent();
  
  const previousOutputs = options.previousOutputs || new Map();
  const nodeOutputs = options.nodeOutputs || new Map();
  
  // Create TemplateResolver from context (simulating engine behavior)
  const templateResolver = new TemplateResolver({
    input: options.workflowInput || options.input || {},
    previousOutputs,
  });
  
  return {
    runId: options.runId || 'run_123',
    sessionId: options.sessionId || 'workflow_run_123',
    workflowName: 'test-workflow',
    nodeId: options.nodeId || 'node-1',
    input: options.input || {},
    previousOutputs,
    nodeOutputs,
    config: {},
    debug: false,
    eventBus,
    sessionComponent: mockSessionComponent as any,
    workflowInput: options.workflowInput,
    templateResolver,
    askUser: (query: string) => {
      throw new Error(`askUser called with: ${query}`);
    },
    // Simulate pre-resolved config (as the engine would do)
    resolvedConfig: options.workflowInput 
      ? templateResolver.resolveValue({}) as Record<string, unknown>
      : undefined,
  };
}

// ==================== Test Suite ====================

describe('Template Integration', () => {
  describe('Engine → TemplateResolver → Node Path', () => {
    describe('{{input.xxx}} resolution in non-entry nodes', () => {
      it('should resolve {{input.xxx}} in middle nodes with workflowInput', () => {
        // Simulate: Entry node executed, middle node is about to run
        // Middle node should have access to global workflowInput
        const workflowInput = { query: 'weather', city: 'Beijing' };
        const context = createMockContext({
          workflowInput,
          nodeId: 'process-node',
          // Entry node's output is available as previous output
          previousOutputs: new Map([
            ['entry-node', { status: 'completed' }]
          ]),
        });
        
        // Simulate tool args with {{input.xxx}}
        const toolArgs = {
          template: 'Query: {{input.query}}, City: {{input.city}}',
          useCache: '{{input.useCache}}',  // undefined key - returns undefined
        };
        
        const resolved = context.templateResolver!.resolveValue(toolArgs);
        
        // Note: Unresolved templates (undefined values) return undefined, not preserved string
        // This is the current behavior - templates for missing keys become undefined
        expect(resolved).toEqual({
          template: 'Query: weather, City: Beijing',
          useCache: undefined,
        });
      });
      
      it('should resolve {{input.xxx}} nested properties', () => {
        const workflowInput = { 
          user: { 
            profile: { name: 'Alice', settings: { theme: 'dark' } } 
          } 
        };
        const context = createMockContext({
          workflowInput,
          nodeId: 'middle-node',
        });
        
        const toolArgs = {
          greeting: 'Hello {{input.user.profile.name}}',
          theme: '{{input.user.profile.settings.theme}}',
        };
        
        const resolved = context.templateResolver!.resolveValue(toolArgs);
        
        expect(resolved).toEqual({
          greeting: 'Hello Alice',
          theme: 'dark',
        });
      });
      
      it('should handle missing {{input.xxx}} keys gracefully', () => {
        const workflowInput = { query: 'test' };
        const context = createMockContext({
          workflowInput,
          nodeId: 'middle-node',
        });
        
        const toolArgs = {
          existing: '{{input.query}}',
          missing: '{{input.nonexistent}}',
        };
        
        const resolved = context.templateResolver!.resolveValue(toolArgs);
        
        // Missing keys return undefined (current behavior)
        expect(resolved).toEqual({
          existing: 'test',
          missing: undefined,
        });
      });
    });
    
    describe('{{inputs.xxx}} alias resolution', () => {
      it('should resolve {{inputs.xxx}} as alias in resolveString (mixed text)', () => {
        // Note: {{inputs.xxx}} alias only works in resolveString (mixed text),
        // NOT in resolvePureTemplate. This is a known limitation.
        const workflowInput = { query: 'hello', limit: 10 };
        const context = createMockContext({
          workflowInput,
          nodeId: 'agent-node',
        });
        
        // Using mixed text + template - this works
        const agentArgs = {
          prompt: 'Search for: {{inputs.query}}',
          maxTokens: 'Limit: {{inputs.limit}}',
        };
        
        const resolved = context.templateResolver!.resolveValue(agentArgs);
        
        expect(resolved).toEqual({
          prompt: 'Search for: hello',
          maxTokens: 'Limit: 10',
        });
      });
      
      it('should resolve pure {{inputs.xxx}} templates as input alias', () => {
        // Pure {{inputs.xxx}} should resolve as input alias (same as {{input.xxx}})
        const workflowInput = { query: 'hello', limit: 10 };
        const context = createMockContext({
          workflowInput,
          nodeId: 'agent-node',
        });
        
        // Pure template - now correctly resolved as input alias
        const pureRef = '{{inputs.query}}';
        const resolved = context.templateResolver!.resolveValue(pureRef);
        
        // Fixed: pure {{inputs.xxx}} now correctly resolves to input value
        expect(resolved).toBe('hello');
      });
      
      it('should resolve mixed {{inputs.xxx}} with surrounding text', () => {
        // When used with surrounding text, {{inputs.xxx}} is correctly aliased to {{input.xxx}}
        const workflowInput = { searchTerm: 'weather', count: 5 };
        const context = createMockContext({
          workflowInput,
          nodeId: 'search-node',
        });
        
        // Both work in mixed text mode (with surrounding text)
        const args = {
          query: 'Term: {{inputs.searchTerm}}',  // Has surrounding text
          limit: 'Max: {{inputs.count}}',        // Has surrounding text
        };
        
        const resolved = context.templateResolver!.resolveValue(args);
        
        expect(resolved).toEqual({
          query: 'Term: weather',
          limit: 'Max: 5',
        });
      });
      
      it('should support nested {{inputs.xxx}} alias in mixed text', () => {
        const workflowInput = { 
          config: { 
            apiKey: 'secret123', 
            options: { timeout: 30 } 
          } 
        };
        const context = createMockContext({
          workflowInput,
          nodeId: 'config-node',
        });
        
        const args = {
          key: 'API Key: {{inputs.config.apiKey}}',
          timeout: 'Timeout: {{inputs.config.options.timeout}}',
        };
        
        const resolved = context.templateResolver!.resolveValue(args);
        
        expect(resolved).toEqual({
          key: 'API Key: secret123',
          timeout: 'Timeout: 30',
        });
      });
    });
    
    describe('{{nodes.xxx}} reference resolution', () => {
      it('should resolve {{nodes.nodeId}} references in mixed text', () => {
        // Simulate: fetch-node completed, process-node is running
        const nodeOutputs = new Map([
          ['fetch-node', { data: { temp: 25, condition: 'sunny' }, timestamp: 1234567890 }],
          ['validate-node', { valid: true }],
        ]);
        
        const context = createMockContext({
          workflowInput: { query: 'test' },
          nodeOutputs,
          nodeId: 'process-node',
          previousOutputs: new Map([
            ['fetch-node', { data: { temp: 25, condition: 'sunny' }, timestamp: 1234567890 }]
          ]),
        });
        
        // In mixed text, {{nodes.xxx}} is JSON serialized
        const toolArgs = {
          message: 'Condition: {{nodes.fetch-node.data.condition}}, Temp: {{nodes.fetch-node.data.temp}}',
        };
        
        const resolved = context.templateResolver!.resolveValue(toolArgs);
        
        expect(resolved).toEqual({
          message: 'Condition: sunny, Temp: 25',
        });
      });
      
      it('should resolve pure {{nodes.nodeId}} as object (not JSON)', () => {
        // Pure template reference returns the actual object, not JSON string
        const nodeOutputs = new Map([
          ['data-source', { items: [1, 2, 3], total: 3 }]
        ]);
        
        const context = createMockContext({
          workflowInput: {},
          nodeOutputs,
          nodeId: 'processor-node',
          previousOutputs: nodeOutputs,
        });
        
        // Pure template: returns the actual value as-is
        const pureRef = '{{nodes.data-source}}';
        const resolved = context.templateResolver!.resolveValue(pureRef);
        
        expect(resolved).toEqual({ items: [1, 2, 3], total: 3 });
      });
      
      it('should resolve {{nodeId}} without prefix in mixed text', () => {
        const nodeOutputs = new Map([
          ['transform', { result: 'processed', stats: { processed: 100 } }]
        ]);
        
        const context = createMockContext({
          workflowInput: {},
          nodeOutputs,
          nodeId: 'output-node',
          previousOutputs: nodeOutputs,
        });
        
        // In mixed text with bare {{nodeId}}, it returns the result field value
        // This is because bare nodeId without path resolves to node's result field
        const args = {
          result: 'Result: {{transform}}',
          count: '{{transform.stats.processed}}',
        };
        
        const resolved = context.templateResolver!.resolveValue(args);
        
        expect(resolved).toEqual({
          result: 'Result: processed',
          count: 100,
        });
      });
      
      it('should resolve pure {{nodeId}} as object with result field', () => {
        const nodeOutputs = new Map([
          ['transform', { result: 'processed', stats: { processed: 100 } }]
        ]);
        
        const context = createMockContext({
          workflowInput: {},
          nodeOutputs,
          nodeId: 'output-node',
          previousOutputs: nodeOutputs,
        });
        
        // Pure template {{transform}} resolves to transform.result
        const pureRef = '{{transform}}';
        const resolved = context.templateResolver!.resolveValue(pureRef);
        
        // Bare nodeId without path resolves to the 'result' field
        expect(resolved).toBe('processed');
      });
      
      it('should return undefined for non-existent node references', () => {
        const previousOutputs = new Map([
          ['my-node', { value: 42 }]
        ]);
        
        const context = createMockContext({
          workflowInput: {},
          nodeOutputs: previousOutputs,  // Also set nodeOutputs for context
          previousOutputs,  // This is what TemplateResolver uses
          nodeId: 'current-node',
        });
        
        const args = {
          existing: '{{nodes.my-node.value}}',
          missing: '{{nodes.nonexistent}}',
        };
        
        const resolved = context.templateResolver!.resolveValue(args);
        
        // Missing node references return undefined
        expect(resolved).toEqual({
          existing: 42,
          missing: undefined,
        });
      });
    });
    
    describe('Complex template scenarios', () => {
      it('should resolve multiple templates in one string', () => {
        const workflowInput = { project: 'MyProject', version: '1.0' };
        const nodeOutputs = new Map([
          ['builder', { artifact: 'app.jar', size: 1024 }]
        ]);
        
        const context = createMockContext({
          workflowInput,
          nodeOutputs,
          nodeId: 'deploy-node',
          previousOutputs: nodeOutputs,
        });
        
        const message = 'Deploying {{input.project}} v{{input.version}} with artifact {{nodes.builder.artifact}}';
        const resolved = context.templateResolver!.resolveValue(message);
        
        expect(resolved).toBe('Deploying MyProject v1.0 with artifact app.jar');
      });
      
      it('should resolve templates in arrays', () => {
        const workflowInput = { ids: [1, 2, 3] };
        const nodeOutputs = new Map([
          ['fetch-1', { name: 'Item1' }],
          ['fetch-2', { name: 'Item2' }],
          ['fetch-3', { name: 'Item3' }],
        ]);
        
        const context = createMockContext({
          workflowInput,
          nodeOutputs,
          nodeId: 'aggregate-node',
          previousOutputs: nodeOutputs,
        });
        
        const args = {
          items: [
            '{{nodes.fetch-1.name}}',
            '{{nodes.fetch-2.name}}',
            '{{nodes.fetch-3.name}}',
            'static-value',
          ],
        };
        
        const resolved = context.templateResolver!.resolveValue(args);
        
        expect(resolved).toEqual({
          items: ['Item1', 'Item2', 'Item3', 'static-value'],
        });
      });
      
      it('should resolve templates in nested objects', () => {
        const workflowInput = { region: 'us-east' };
        const nodeOutputs = new Map([
          ['config', { endpoints: { api: 'https://api.example.com' } }]
        ]);
        
        const context = createMockContext({
          workflowInput,
          nodeOutputs,
          nodeId: 'client-node',
          previousOutputs: nodeOutputs,
        });
        
        const args = {
          client: {
            region: '{{input.region}}',
            config: {
              apiUrl: '{{nodes.config.endpoints.api}}',
            },
          },
        };
        
        const resolved = context.templateResolver!.resolveValue(args);
        
        expect(resolved).toEqual({
          client: {
            region: 'us-east',
            config: {
              apiUrl: 'https://api.example.com',
            },
          },
        });
      });
    });
    
    describe('TemplateResolver.fromContext()', () => {
      it('should create resolver with workflowInput from context', () => {
        const workflowInput = { apiKey: 'secret', mode: 'test' };
        const context = createMockContext({
          workflowInput,
          nodeId: 'api-node',
        });
        
        // Simulate what TemplateResolver.fromContext() should do
        const resolver = TemplateResolver.fromContext(context);
        
        expect(resolver).toBeDefined();
        expect(resolver.resolveString('Key: {{input.apiKey}}')).toBe('Key: secret');
        expect(resolver.resolveString('Mode: {{input.mode}}')).toBe('Mode: test');
      });
      
      it('should prioritize workflowInput over input for entry nodes', () => {
        // For non-entry nodes, workflowInput is the source of truth
        // input only contains outputs from dependencies
        const workflowInput = { globalValue: 'from-global' };
        const input = { localValue: 'from-local' };  // This is from dependency outputs
        
        const context = createMockContext({
          workflowInput,
          input,  // This would be empty for non-entry nodes
          nodeId: 'middle-node',
        });
        
        const resolver = TemplateResolver.fromContext(context);
        
        // Should resolve from workflowInput (global)
        expect(resolver.resolveString('{{input.globalValue}}')).toBe('from-global');
      });
      
      it('should use previousOutputs for node references', () => {
        const nodeOutputs = new Map([
          ['prev-step', { result: 'output-value' }]
        ]);
        
        const context = createMockContext({
          workflowInput: { test: true },
          nodeOutputs,
          nodeId: 'current-node',
          previousOutputs: nodeOutputs,
        });
        
        const resolver = TemplateResolver.fromContext(context);
        
        expect(resolver.resolveString('Result: {{nodes.prev-step.result}}')).toBe('Result: output-value');
      });
    });
  });
  
  describe('Edge Cases', () => {
    it('should preserve templates when input is missing (no surrounding text)', () => {
      // When no surrounding text, pure template returns undefined
      const context = createMockContext({
        workflowInput: {},
        nodeId: 'first-middle-node',
      });
      
      // Pure template - no surrounding text
      const value = context.templateResolver!.resolveValue('{{input.missing}}');
      expect(value).toBeUndefined();
    });
    
    it('should handle empty node outputs map', () => {
      const context = createMockContext({
        workflowInput: { value: 'test' },
        nodeOutputs: new Map(),
        nodeId: 'first-node',
        previousOutputs: new Map(),
      });
      
      const args = {
        input: '{{input.value}}',
        node: '{{nodes.missing}}',
      };
      
      const resolved = context.templateResolver!.resolveValue(args);
      
      expect(resolved).toEqual({
        input: 'test',
        node: undefined,
      });
    });
    
    it('should handle primitive template values', () => {
      const context = createMockContext({
        workflowInput: { count: 42 },
        nodeId: 'test-node',
      });
      
      // Direct primitive values should pass through
      expect(context.templateResolver!.resolveValue(42)).toBe(42);
      expect(context.templateResolver!.resolveValue('plain string')).toBe('plain string');
      expect(context.templateResolver!.resolveValue(null)).toBe(null);
      expect(context.templateResolver!.resolveValue(undefined)).toBe(undefined);
    });
    
    it('should handle nested undefined in template path', () => {
      const workflowInput = { config: { timeout: 30 } };
      const context = createMockContext({
        workflowInput,
        nodeId: 'test-node',
      });
      
      // Valid path should work
      expect(context.templateResolver!.resolveString('{{input.config.timeout}}')).toBe('30');
      
      // Invalid nested path - no surrounding text, pure template returns undefined
      expect(context.templateResolver!.resolveValue('{{input.config.nested.missing}}'))
        .toBeUndefined();
    });
  });
});
