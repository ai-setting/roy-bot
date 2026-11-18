import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SkillNode } from './skill-node';
import type { NodeDefinition, NodeExecutionContext } from '../types';
import type { EventBus } from '../engine/event-bus';

// Mock EventBus
const mockEventBus = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
} as Partial<EventBus> as EventBus;

// Mock SkillRegistry
const mockRegistry = {
  getSkill: vi.fn(),
  hasSkill: vi.fn(),
} as any;

// Mock Skill
const mockSkill = {
  name: 'test-skill',
  invoke: vi.fn(),
};

describe('SkillNode', () => {
  let skillNode: SkillNode;
  let nodeDefinition: NodeDefinition;
  let executionContext: NodeExecutionContext;
  // Keep reference to previousOutputs for mock template resolver
  let previousOutputsMap: Map<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Initialize previousOutputsMap first so mockResolveValue can access it
    previousOutputsMap = new Map();
    
    nodeDefinition = {
      id: 'node-1',
      type: 'skill',
      name: 'Test Skill Node',
      config: {
        skill: 'test-skill',
        input: { message: 'hello' },
      },
    };

    // Create mock templateResolver that uses previousOutputsMap
    const mockResolveValue = (input: unknown): unknown => {
      // Handle objects - recursively resolve each property
      if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
        const resolved: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
          resolved[key] = mockResolveValue(value);
        }
        return resolved;
      }
      
      if (typeof input !== 'string') return input;
      
      // Simple template resolution for testing
      return input.replace(/\{\{([^}]+)\}\}/g, (match: string, path: string): string => {
        const trimmed = path.trim();
        
        // Handle {{nodes.xxx}} - get from previousOutputs
        if (trimmed.startsWith('nodes.')) {
          const rest = trimmed.slice(6);
          const segments = rest.split('.');
          const nodeId = segments[0];
          const restPath = segments.slice(1).join('.');
          const nodeOutput = previousOutputsMap.get(nodeId);
          if (nodeOutput && restPath) {
            const keys = restPath.split('.');
            let value: unknown = nodeOutput;
            for (const k of keys) {
              if (value && typeof value === 'object') {
                value = (value as Record<string, unknown>)[k];
              } else {
                return match;
              }
            }
            return value !== undefined ? String(value) : match;
          } else if (nodeOutput) {
            return String(nodeOutput);
          }
        }
        
        // Handle bare nodeId without prefix (backward compatibility)
        const segments = trimmed.split('.');
        const nodeId = segments[0];
        const restPath = segments.slice(1).join('.');
        const nodeOutput = previousOutputsMap.get(nodeId);
        if (nodeOutput) {
          if (restPath) {
            const keys = restPath.split('.');
            let value: unknown = nodeOutput;
            for (const k of keys) {
              if (value && typeof value === 'object') {
                value = (value as Record<string, unknown>)[k];
              } else {
                return match;
              }
            }
            return value !== undefined ? String(value) : match;
          }
          return String(nodeOutput);
        }
        
        return match;
      });
    };

    executionContext = {
      runId: 'run-1',
      workflowName: 'test-workflow',
      nodeId: 'node-1',
      input: {},
      previousOutputs: previousOutputsMap,
      config: nodeDefinition.config,
      debug: false,
      eventBus: mockEventBus,
      sessionId: 'session-1',
      nodeOutputs: new Map(),
      askUser: () => { throw new Error('askUser not implemented'); },
      templateResolver: { resolveValue: mockResolveValue } as any,
    } as unknown as NodeExecutionContext;

    mockRegistry.getSkill = vi.fn().mockReturnValue(mockSkill);
    mockRegistry.hasSkill = vi.fn().mockReturnValue(true);
    mockSkill.invoke = vi.fn().mockResolvedValue({ result: 'success' });
  });

  describe('constructor', () => {
    it('should create a SkillNode with correct type', () => {
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      expect(skillNode.type).toBe('skill');
      expect(skillNode.id).toBe('node-1');
    });
  });

  describe('execute', () => {
    it('should invoke skill successfully', async () => {
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      const result = await skillNode.execute(executionContext);
      
      expect(result.output).toEqual({ result: 'success' });
      expect(result.error).toBeUndefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockRegistry.getSkill).toHaveBeenCalledWith('test-skill');
      expect(mockSkill.invoke).toHaveBeenCalled();
    });

    it('should return error when skill not found', async () => {
      mockRegistry.getSkill = vi.fn().mockReturnValue(undefined);
      mockRegistry.hasSkill = vi.fn().mockReturnValue(false);
      
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      const result = await skillNode.execute(executionContext);
      
      expect(result.output).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('Skill not found: test-skill');
    });

    it('should pass input to skill', async () => {
      const customInput = { param1: 'value1', param2: 123 };
      nodeDefinition.config.input = customInput;
      
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      await skillNode.execute(executionContext);
      
      expect(mockSkill.invoke).toHaveBeenCalledWith(customInput, expect.any(Object));
    });

    it('should handle skill invocation errors', async () => {
      const error = new Error('Skill invocation failed');
      mockSkill.invoke = vi.fn().mockRejectedValue(error);
      
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      const result = await skillNode.execute(executionContext);
      
      expect(result.output).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('Skill invocation failed');
    });

    it('should resolve template references from previous outputs', async () => {
      // Set up previous outputs
      previousOutputsMap.set('node-0', {
        output: { value: 'from-node-0' }
      });
      
      // Input contains template reference
      nodeDefinition.config.input = {
        message: '{{node-0.output.value}}',
      };
      
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      const result = await skillNode.execute(executionContext);
      
      expect(result.output).toEqual({ result: 'success' });
      expect(mockSkill.invoke).toHaveBeenCalledWith({
        message: 'from-node-0',
      }, expect.any(Object));
    });

    it('should resolve nested template references', async () => {
      previousOutputsMap.set('data-node', {
        nested: {
          deep: {
            value: 'nested-value',
          }
        }
      });
      
      nodeDefinition.config.input = {
        message: '{{data-node.nested.deep.value}}',
      };
      
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      await skillNode.execute(executionContext);
      
      expect(mockSkill.invoke).toHaveBeenCalledWith({
        message: 'nested-value',
      }, expect.any(Object));
    });

    it('should handle unresolved template references gracefully', async () => {
      // Template references non-existent node
      nodeDefinition.config.input = {
        message: '{{non-existent.output.value}}',
      };
      
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      const result = await skillNode.execute(executionContext);
      
      // Should still execute with unresolved template
      expect(mockSkill.invoke).toHaveBeenCalledWith({
        message: '{{non-existent.output.value}}',
      }, expect.any(Object));
    });

    it('should record execution duration', async () => {
      mockSkill.invoke = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { result: 'success' };
      });
      
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      const result = await skillNode.execute(executionContext);
      
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should use skill name from config.skill', async () => {
      nodeDefinition.config.skill = 'custom-skill';
      
      const customSkill = {
        name: 'custom-skill',
        invoke: vi.fn().mockResolvedValue({ result: 'custom' }),
      };
      mockRegistry.getSkill = vi.fn().mockReturnValue(customSkill);
      
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      const result = await skillNode.execute(executionContext);
      
      expect(mockRegistry.getSkill).toHaveBeenCalledWith('custom-skill');
      expect(result.output).toEqual({ result: 'custom' });
    });

    it('should throw error when skill name is missing', async () => {
      nodeDefinition.config.skill = undefined;
      
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      const result = await skillNode.execute(executionContext);
      
      expect(result.output).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('Skill name is required');
    });

    it('should pass context with runId, workflowName, nodeId, debug, sessionId', async () => {
      skillNode = new SkillNode(nodeDefinition, mockRegistry);
      
      await skillNode.execute(executionContext);
      
      expect(mockSkill.invoke).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          runId: 'run-1',
          workflowName: 'test-workflow',
          nodeId: 'node-1',
          debug: false,
          sessionId: 'session-1',
        })
      );
    });
  });
});
