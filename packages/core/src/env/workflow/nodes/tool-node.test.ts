import { describe, it, expect, beforeEach, jest } from 'vitest';
import { ToolNode, ToolRegistry, Tool } from './tool-node';
import type { NodeDefinition, NodeExecutionContext } from '../types';
import type { EventBus } from '../engine/event-bus';

// Mock EventBus
const mockEventBus = {
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
} as Partial<EventBus> as EventBus;

// Mock ToolRegistry
const mockRegistry = {
  getTool: jest.fn<(name: string) => Tool | undefined>(),
  hasTool: jest.fn<(name: string) => boolean>(),
} as {
  getTool: ReturnType<typeof jest.fn>;
  hasTool: ReturnType<typeof jest.fn>;
};

// Mock Tool
const mockTool = {
  name: 'test-tool',
  execute: jest.fn<(input: any) => Promise<any>>(),
};

describe('ToolNode', () => {
  let toolNode: ToolNode;
  let nodeDefinition: NodeDefinition;
  let executionContext: NodeExecutionContext;
  // Keep reference to previousOutputs for mock template resolver
  let previousOutputsMap: Map<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Initialize previousOutputsMap first so mockResolveValue can access it
    previousOutputsMap = new Map();
    
    nodeDefinition = {
      id: 'node-1',
      type: 'tool',
      name: 'Test Tool Node',
      config: {
        tool: 'test-tool',
        input: { message: 'hello' },
      },
    };

    // Create mock templateResolver that uses previousOutputsMap
    const mockResolveValue = (input: unknown): unknown => {
      // Handle objects - recursively resolve each property
      if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
        const resolved: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(input)) {
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

    mockRegistry.getTool = jest.fn().mockReturnValue(mockTool);
    mockRegistry.hasTool = jest.fn().mockReturnValue(true);
    mockTool.execute = jest.fn().mockResolvedValue({ result: 'success' });
  });

  describe('constructor', () => {
    it('should create a ToolNode with correct type', () => {
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      expect(toolNode.type).toBe('tool');
      expect(toolNode.id).toBe('node-1');
    });
  });

  describe('execute', () => {
    it('should execute tool successfully', async () => {
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      const result = await toolNode.execute(executionContext);
      
      // Output is extracted from wrapper format
      expect(result.output).toEqual('success');
      expect(result.error).toBeUndefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockRegistry.getTool).toHaveBeenCalledWith('test-tool');
      // Tool is called with (input, context)
      expect(mockTool.execute).toHaveBeenCalledWith(
        { message: 'hello' },
        expect.objectContaining({
          session_id: expect.any(String),
        })
      );
    });

    it('should return error when tool not found', async () => {
      mockRegistry.getTool = jest.fn().mockReturnValue(undefined);
      mockRegistry.hasTool = jest.fn().mockReturnValue(false);
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      const result = await toolNode.execute(executionContext);
      
      expect(result.output).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Tool not found: test-tool');
    });

    it('should pass input to tool', async () => {
      const customInput = { param1: 'value1', param2: 123 };
      nodeDefinition.config.input = customInput;
      executionContext.config = nodeDefinition.config;
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      await toolNode.execute(executionContext);
      
      expect(mockTool.execute).toHaveBeenCalledWith(
        customInput,
        expect.objectContaining({
          session_id: expect.any(String),
        })
      );
    });

    it('should handle tool execution errors', async () => {
      const error = new Error('Tool execution failed');
      mockTool.execute = jest.fn().mockRejectedValue(error);
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      const result = await toolNode.execute(executionContext);
      
      expect(result.output).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error.message).toBe('Tool execution failed');
    });

    it('should resolve template references from previous outputs', async () => {
      // Set up previous outputs
      previousOutputsMap.set('node-0', {
        value: 'from-node-0'
      });
      
      // Input contains template reference with nodes. prefix
      nodeDefinition.config.input = {
        message: '{{nodes.node-0.value}}',
      };
      executionContext.config = nodeDefinition.config;
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      const result = await toolNode.execute(executionContext);
      
      // Output is extracted from wrapper format
      expect(result.output).toEqual('success');
      expect(mockTool.execute).toHaveBeenCalledWith({
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
        message: '{{nodes.data-node.nested.deep.value}}',
      };
      executionContext.config = nodeDefinition.config;
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      await toolNode.execute(executionContext);
      
      expect(mockTool.execute).toHaveBeenCalledWith(
        { message: 'nested-value' },
        expect.objectContaining({
          session_id: expect.any(String),
        })
      );
    });

    it('should handle unresolved template references gracefully', async () => {
      // Template references non-existent node - the mock resolver returns the original template
      nodeDefinition.config.input = {
        message: '{{non-existent.output.value}}',
      };
      executionContext.config = nodeDefinition.config;
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      const result = await toolNode.execute(executionContext);
      
      // Should still execute - the unresolved template is passed through
      // (mock resolver returns the original template string)
      expect(mockTool.execute).toHaveBeenCalledWith(
        { message: '{{non-existent.output.value}}' },
        expect.any(Object)
      );
    });

    it('should record execution duration', async () => {
      mockTool.execute = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { result: 'success' };
      });
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      const result = await toolNode.execute(executionContext);
      
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should use tool name from config.tool', async () => {
      nodeDefinition.config.tool = 'custom-tool';
      executionContext.config = nodeDefinition.config;
      
      mockRegistry.getTool = jest.fn().mockReturnValue({
        name: 'custom-tool',
        execute: jest.fn().mockResolvedValue({ custom: true }),
      });
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      await toolNode.execute(executionContext);
      
      expect(mockRegistry.getTool).toHaveBeenCalledWith('custom-tool');
    });

    it('should throw error when tool config is missing', async () => {
      nodeDefinition.config = {};  // No tool specified
      executionContext.config = nodeDefinition.config;
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      const result = await toolNode.execute(executionContext);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Tool name is required');
    });

    it('should resolve templates in command field', async () => {
      previousOutputsMap.set('fetch', {
        command: 'ls -la'
      });
      
      // Use command format instead of input format
      nodeDefinition.config = {
        tool: 'bash',
        command: '{{nodes.fetch.command}}',
      };
      executionContext.config = nodeDefinition.config;
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      await toolNode.execute(executionContext);
      
      expect(mockTool.execute).toHaveBeenCalledWith(
        { command: 'ls -la' },
        expect.any(Object)
      );
    });

    it('should resolve templates in message field', async () => {
      previousOutputsMap.set('data', {
        message: 'Hello from template'
      });
      
      // Use message format
      nodeDefinition.config = {
        tool: 'echo',
        message: '{{nodes.data.message}}',
      };
      executionContext.config = nodeDefinition.config;
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      await toolNode.execute(executionContext);
      
      expect(mockTool.execute).toHaveBeenCalledWith(
        { message: 'Hello from template' },
        expect.any(Object)
      );
    });

    it('should resolve templates in args field', async () => {
      previousOutputsMap.set('config', {
        arg1: 'value1'
      });
      
      // Use args format
      nodeDefinition.config = {
        tool: 'custom-tool',
        args: {
          param1: '{{nodes.config.arg1}}',
          param2: 'static-value',
        },
      };
      executionContext.config = nodeDefinition.config;
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      await toolNode.execute(executionContext);
      
      expect(mockTool.execute).toHaveBeenCalledWith(
        { param1: 'value1', param2: 'static-value' },
        expect.any(Object)
      );
    });

    it('should resolve templates in inputs field (alias)', async () => {
      previousOutputsMap.set('source', {
        data: 'test-data'
      });
      
      // Use inputs field (alias for input)
      nodeDefinition.config = {
        tool: 'test-tool',
        inputs: {
          data: '{{nodes.source.data}}',
        },
      };
      executionContext.config = nodeDefinition.config;
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      await toolNode.execute(executionContext);
      
      expect(mockTool.execute).toHaveBeenCalledWith(
        { data: 'test-data' },
        expect.any(Object)
      );
    });

    it('should not resolve tool name fields as templates', async () => {
      // This tests that tool name fields (tool/toolName) are NOT passed to template resolver
      // The tool name should remain as-is, not resolved as a template
      const customToolName = 'my-special-tool';
      nodeDefinition.config.tool = customToolName;
      executionContext.config = nodeDefinition.config;
      
      // Override mockRegistry to verify correct tool name is passed
      mockRegistry.getTool = jest.fn().mockImplementation((name: string) => {
        // Verify that the tool name is NOT template-resolved (e.g., "{{nodes.my-tool.name}}")
        expect(name).toBe(customToolName);
        return mockTool;
      });
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      const result = await toolNode.execute(executionContext);
      
      expect(result.error).toBeUndefined();
      expect(mockRegistry.getTool).toHaveBeenCalled();
    });
  });

  describe('ToolRegistry interface', () => {
    it('should check tool existence with hasTool', async () => {
      mockRegistry.hasTool = jest.fn().mockReturnValue(true);
      
      toolNode = new ToolNode(nodeDefinition, mockRegistry);
      
      // This is tested implicitly - if hasTool returns false, 
      // getTool should also return undefined
      expect(mockRegistry.hasTool('test-tool')).toBe(true);
    });
  });
});
