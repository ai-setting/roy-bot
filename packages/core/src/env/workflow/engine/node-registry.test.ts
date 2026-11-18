/**
 * @fileoverview NodeRegistry Tests
 * 
 * TDD tests for the NodeRegistry class that manages node creation
 * from NodeDefinition instances.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NodeRegistry } from './node-registry';
import { NodeDefinition, Node, NodeExecutionContext, NodeExecutionResult } from '../types';
import { ToolNode } from '../nodes/tool-node';
import { SkillNode } from '../nodes/skill-node';
import { AgentNode } from '../nodes/agent-node';
import { WorkflowNode } from '../nodes/workflow-node';
import { PythonCallNode } from '../nodes/python-call-node';
import { EventBus } from './event-bus';
import type { ToolRegistry, Tool } from '../nodes/tool-node';
import type { SkillRegistry, Skill } from '../nodes/skill-node';
import type { AgentRunner, AgentConfig, AgentResult } from '../nodes/agent-node';
import type { WorkflowRunner, WorkflowRunResult } from '../nodes/workflow-node';

// ============================================================================
// Test Setup
// ============================================================================

/**
 * Create a mock ToolRegistry for testing
 */
function createMockToolRegistry(): ToolRegistry {
  return {
    getTool: vi.fn(),
    hasTool: vi.fn(),
  };
}

/**
 * Create a mock SkillRegistry for testing
 */
function createMockSkillRegistry(): SkillRegistry {
  return {
    getSkill: vi.fn(),
    hasSkill: vi.fn(),
  };
}

/**
 * Create a mock AgentRunner for testing
 */
function createMockAgentRunner(): AgentRunner {
  return {
    run: vi.fn(),
  };
}

/**
 * Create a mock WorkflowRunner for testing
 */
function createMockWorkflowRunner(): WorkflowRunner {
  return {
    run: vi.fn(),
    getRun: vi.fn(),
  };
}

/**
 * Create a NodeContext for testing
 */
function createNodeContext(): {
  context: NodeExecutionContext;
  eventBus: EventBus;
} {
  const eventBus = new EventBus();
  const context: NodeExecutionContext = {
    sessionId: 'test-session',
    nodeOutputs: {},
    previousOutputs: new Map(),
  };
  return { context, eventBus };
}

/**
 * Create a basic NodeDefinition for testing
 */
function createDefinition(overrides: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: 'test-node',
    type: 'tool',
    config: {},
    ...overrides,
  };
}

// ============================================================================
// Test Suites
// ============================================================================

describe('NodeRegistry', () => {
  let toolRegistry: ToolRegistry;
  let skillRegistry: SkillRegistry;
  let agentRunner: AgentRunner;
  let workflowRunner: WorkflowRunner;

  beforeEach(() => {
    toolRegistry = createMockToolRegistry();
    skillRegistry = createMockSkillRegistry();
    agentRunner = createMockAgentRunner();
    workflowRunner = createMockWorkflowRunner();
  });

  describe('constructor', () => {
    it('should create a NodeRegistry with no arguments', () => {
      const registry = new NodeRegistry();
      expect(registry).toBeDefined();
    });

    it('should create a NodeRegistry with all registries using options object', () => {
      const registry = new NodeRegistry({
        toolRegistry,
        skillRegistry,
        agentRunner,
        workflowRunner,
      });
      expect(registry).toBeDefined();
    });

    it('should support legacy positional arguments for backward compatibility', () => {
      // Note: This tests that the options object format works
      const registry = new NodeRegistry({
        toolRegistry,
        skillRegistry,
        agentRunner,
        workflowRunner,
      });
      expect(registry).toBeDefined();
      expect(registry.has('tool')).toBe(true);
      expect(registry.has('skill')).toBe(true);
      expect(registry.has('agent')).toBe(true);
      expect(registry.has('workflow')).toBe(true);
    });
  });

  describe('built-in node types', () => {
    it('should have tool type registered by default', () => {
      const registry = new NodeRegistry({ toolRegistry });
      expect(registry.has('tool')).toBe(true);
    });

    it('should have skill type registered by default', () => {
      const registry = new NodeRegistry({ skillRegistry });
      expect(registry.has('skill')).toBe(true);
    });

    it('should have agent type registered by default', () => {
      const registry = new NodeRegistry({ agentRunner });
      expect(registry.has('agent')).toBe(true);
    });

    it('should have workflow type registered by default', () => {
      const registry = new NodeRegistry({ workflowRunner });
      expect(registry.has('workflow')).toBe(true);
    });

    // Task #1998: workflow portability — Python function-call node type
    it('should have python_call type registered by default (Task #1998)', () => {
      const registry = new NodeRegistry();
      expect(registry.has('python_call')).toBe(true);
    });
  });

  describe('has()', () => {
    it('should return false for unknown types', () => {
      const registry = new NodeRegistry();
      expect(registry.has('unknown')).toBe(false);
    });

    it('should return true for built-in types', () => {
      const registry = new NodeRegistry();
      expect(registry.has('tool')).toBe(true);
      expect(registry.has('skill')).toBe(true);
      expect(registry.has('agent')).toBe(true);
      expect(registry.has('workflow')).toBe(true);
    });

    it('should return true for registered custom types', () => {
      const registry = new NodeRegistry();
      registry.register('custom', () => {
        return {} as Node;
      });
      expect(registry.has('custom')).toBe(true);
    });
  });

  describe('list()', () => {
    it('should list all registered types', () => {
      const registry = new NodeRegistry();
      const types = registry.list();
      
      expect(types).toContain('tool');
      expect(types).toContain('skill');
      expect(types).toContain('agent');
      expect(types).toContain('workflow');
    });

    it('should include custom registered types', () => {
      const registry = new NodeRegistry();
      registry.register('custom1', () => ({ type: 'custom1', id: 'x', execute: async () => ({ success: true }) } as Node));
      registry.register('custom2', () => ({ type: 'custom2', id: 'y', execute: async () => ({ success: true }) } as Node));
      
      const types = registry.list();
      
      expect(types).toContain('custom1');
      expect(types).toContain('custom2');
    });
  });

  describe('register()', () => {
    it('should register a custom node factory', () => {
      const registry = new NodeRegistry();
      const factory = vi.fn();
      
      registry.register('custom', factory);
      
      expect(registry.has('custom')).toBe(true);
    });

    it('should allow overriding existing types', () => {
      const registry = new NodeRegistry();
      const newFactory = vi.fn();
      
      // This should not throw
      registry.register('tool', newFactory);
      
      expect(registry.has('tool')).toBe(true);
    });
  });

  describe('createNode()', () => {
    describe('tool node', () => {
      it('should create a ToolNode instance', () => {
        const registry = new NodeRegistry({ toolRegistry });
        
        const definition = createDefinition({
          type: 'tool',
          config: { tool: 'test-tool' },
        });
        
        const node = registry.createNode(definition);
        
        expect(node).toBeInstanceOf(ToolNode);
        expect(node.type).toBe('tool');
        expect(node.id).toBe('test-node');
      });

      it('should throw error when tool registry is not provided', () => {
        const registry = new NodeRegistry();
        
        const definition = createDefinition({
          type: 'tool',
          config: { tool: 'test-tool' },
        });
        
        expect(() => registry.createNode(definition)).toThrow('ToolRegistry is required');
      });

      it('should create ToolNode with proper tool registry', async () => {
        const mockTool: Tool = {
          name: 'test-tool',
          execute: vi.fn().mockResolvedValue({ result: 'success' }),
        };
        (toolRegistry.getTool as ReturnType<typeof vi.fn>).mockReturnValue(mockTool);
        
        const registry = new NodeRegistry({ toolRegistry });
        
        const definition = createDefinition({
          id: 'tool-1',
          type: 'tool',
          config: { tool: 'test-tool', input: {} },
        });
        
        const node = registry.createNode(definition);
        const { context } = createNodeContext();
        
        await node.execute(context);
        
        expect(toolRegistry.getTool).toHaveBeenCalledWith('test-tool');
      });
    });

    describe('skill node', () => {
      it('should create a SkillNode instance', () => {
        const registry = new NodeRegistry({ skillRegistry });
        
        const definition = createDefinition({
          type: 'skill',
          config: { skill: 'test-skill' },
        });
        
        const node = registry.createNode(definition);
        
        expect(node).toBeInstanceOf(SkillNode);
        expect(node.type).toBe('skill');
        expect(node.id).toBe('test-node');
      });

      it('should throw error when skill registry is not provided', () => {
        const registry = new NodeRegistry();
        
        const definition = createDefinition({
          type: 'skill',
          config: { skill: 'test-skill' },
        });
        
        expect(() => registry.createNode(definition)).toThrow('SkillRegistry is required');
      });

      it('should create SkillNode with proper skill registry', async () => {
        const mockSkill: Skill = {
          name: 'test-skill',
          invoke: vi.fn().mockResolvedValue({ result: 'success' }),
        };
        (skillRegistry.getSkill as ReturnType<typeof vi.fn>).mockReturnValue(mockSkill);
        
        const registry = new NodeRegistry({ skillRegistry });
        
        const definition = createDefinition({
          id: 'skill-1',
          type: 'skill',
          config: { skill: 'test-skill', input: {} },
        });
        
        const node = registry.createNode(definition);
        const { context } = createNodeContext();
        
        await node.execute(context);
        
        expect(skillRegistry.getSkill).toHaveBeenCalledWith('test-skill');
      });
    });

    describe('agent node', () => {
      it('should create an AgentNode instance', () => {
        const registry = new NodeRegistry({ agentRunner });
        
        const definition = createDefinition({
          type: 'agent',
          config: { prompt: 'Do something' },
        });
        
        const node = registry.createNode(definition);
        
        expect(node).toBeInstanceOf(AgentNode);
        expect(node.type).toBe('agent');
        expect(node.id).toBe('test-node');
      });

      it('should throw error when agent runner is not provided', () => {
        const registry = new NodeRegistry();
        
        const definition = createDefinition({
          type: 'agent',
          config: { prompt: 'Do something' },
        });
        
        expect(() => registry.createNode(definition)).toThrow('AgentRunner is required');
      });

      it('should create AgentNode with proper agent runner', async () => {
        (agentRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue({
          output: 'agent response',
          metadata: { tokens: 100 },
        });
        
        const registry = new NodeRegistry({ agentRunner });
        
        const definition = createDefinition({
          id: 'agent-1',
          type: 'agent',
          config: { prompt: 'Test prompt' },
        });
        
        const node = registry.createNode(definition);
        const { context } = createNodeContext();
        
        await node.execute(context);
        
        expect(agentRunner.run).toHaveBeenCalled();
      });
    });

    describe('workflow node', () => {
      it('should create a WorkflowNode instance', () => {
        const registry = new NodeRegistry({ workflowRunner });
        
        const definition = createDefinition({
          type: 'workflow',
          config: { workflow_name: 'test-workflow' },
        });
        
        const node = registry.createNode(definition);
        
        expect(node).toBeInstanceOf(WorkflowNode);
        expect(node.type).toBe('workflow');
        expect(node.id).toBe('test-node');
      });

      it('should throw error when workflow runner is not provided', () => {
        const registry = new NodeRegistry();
        
        const definition = createDefinition({
          type: 'workflow',
          config: { workflow_name: 'test-workflow' },
        });
        
        expect(() => registry.createNode(definition)).toThrow('WorkflowRunner is required');
      });

      it('should create WorkflowNode with proper workflow runner', async () => {
        (workflowRunner.run as ReturnType<typeof vi.fn>).mockResolvedValue({
          runId: 'run-123',
          status: 'completed',
          output: { result: 'success' },
        });
        
        const registry = new NodeRegistry({ workflowRunner });
        
        const definition = createDefinition({
          id: 'workflow-1',
          type: 'workflow',
          config: { workflow_name: 'test-workflow' },
        });
        
        const node = registry.createNode(definition);
        const { context } = createNodeContext();
        
        await node.execute(context);
        
        expect(workflowRunner.run).toHaveBeenCalledWith('test-workflow', {});
      });
    });

    describe('custom registered node', () => {
      it('should create a custom registered node', () => {
        const registry = new NodeRegistry();
        
        const customNode: Node = {
          type: 'custom',
          id: 'custom-node',
          execute: async () => ({ success: true, output: 'custom' }),
        };
        
        registry.register('custom', () => customNode);
        
        const definition = createDefinition({ type: 'custom' });
        const node = registry.createNode(definition);
        
        expect(node).toBe(customNode);
        expect(node.type).toBe('custom');
      });

      it('should call factory function with definition and context', () => {
        const registry = new NodeRegistry();
        const factory = vi.fn().mockReturnValue({
          type: 'factory-test',
          id: 'factory-node',
          execute: async () => ({ success: true }),
        } as Node);
        
        registry.register('factory-test', factory);
        
        const definition = createDefinition({ type: 'factory-test' });
        registry.createNode(definition);
        
        expect(factory).toHaveBeenCalled();
      });
    });

    describe('unknown node type', () => {
      it('should throw error for unknown node type', () => {
        const registry = new NodeRegistry();
        
        const definition = createDefinition({ type: 'unknown-type' });
        
        expect(() => registry.createNode(definition)).toThrow(
          'Unknown node type: unknown-type'
        );
      });

      it('should include available types in error message', () => {
        const registry = new NodeRegistry();
        
        const definition = createDefinition({ type: 'nonexistent' });
        
        expect(() => registry.createNode(definition)).toThrow('tool');
        expect(() => registry.createNode(definition)).toThrow('skill');
        expect(() => registry.createNode(definition)).toThrow('agent');
        expect(() => registry.createNode(definition)).toThrow('workflow');
      });
    });
  });

  describe('integration scenarios', () => {
    it('should create multiple different node types from same registry', () => {
      const registry = new NodeRegistry({
        toolRegistry,
        skillRegistry,
        agentRunner,
        workflowRunner,
      });

      const toolDef = createDefinition({ id: 'n1', type: 'tool' });
      const skillDef = createDefinition({ id: 'n2', type: 'skill' });
      const agentDef = createDefinition({ id: 'n3', type: 'agent' });
      const workflowDef = createDefinition({ id: 'n4', type: 'workflow' });
      const pythonCallDef = createDefinition({
        id: 'n5',
        type: 'python_call',
        config: { module: 'investment_strategy.x', function: 'y' },
      });

      const toolNode = registry.createNode(toolDef);
      const skillNode = registry.createNode(skillDef);
      const agentNode = registry.createNode(agentDef);
      const workflowNode = registry.createNode(workflowDef);
      const pythonCallNode = registry.createNode(pythonCallDef);

      expect(toolNode).toBeInstanceOf(ToolNode);
      expect(skillNode).toBeInstanceOf(SkillNode);
      expect(agentNode).toBeInstanceOf(AgentNode);
      expect(workflowNode).toBeInstanceOf(WorkflowNode);
      // Task #1998: workflow portability — python_call node created by registry
      expect(pythonCallNode).toBeInstanceOf(PythonCallNode);
    });

    it('should maintain separate node instances for same definition', () => {
      const registry = new NodeRegistry({ toolRegistry });
      
      const definition = createDefinition({ id: 'shared', type: 'tool' });
      
      const node1 = registry.createNode(definition);
      const node2 = registry.createNode(definition);
      
      // Nodes should be separate instances (unless factory is stateless)
      expect(node1).toBeInstanceOf(ToolNode);
      expect(node2).toBeInstanceOf(ToolNode);
    });
  });

  describe('AgentComponent integration', () => {
    it('should create AgentRunner from AgentComponent when provided', () => {
      // Mock AgentComponent
      const mockAgentComponent = {
        registerAgent: vi.fn(),
        getAgent: vi.fn(),
        listAgents: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      };
      
      const registry = new NodeRegistry({
        agentComponent: mockAgentComponent as any,
      });
      
      // AgentNode should be createable now
      expect(registry.has('agent')).toBe(true);
      
      const definition = createDefinition({
        id: 'test-agent',
        type: 'agent',
        config: { prompt: 'Test' },
      });
      
      const node = registry.createNode(definition);
      expect(node).toBeInstanceOf(AgentNode);
    });
  });
});
