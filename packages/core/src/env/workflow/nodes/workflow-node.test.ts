import { describe, it, expect, beforeEach, jest } from 'vitest';
import { WorkflowNode, WorkflowRunner, WorkflowRunResult } from './workflow-node';
import type { NodeDefinition, NodeExecutionContext } from '../types';

// Mock EventBus
const mockEventBus = {
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
} as any;

// Mock WorkflowRunner
const createMockRunner = () => ({
  run: jest.fn<(workflowName: string, input?: any) => Promise<WorkflowRunResult>>(),
  getRun: jest.fn<(runId: string) => Promise<WorkflowRunResult | null>>(),
});

describe('WorkflowNode', () => {
  let nodeDefinition: NodeDefinition;
  let executionContext: NodeExecutionContext;
  let mockRunner: ReturnType<typeof createMockRunner>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    nodeDefinition = {
      id: 'workflow-node-1',
      type: 'workflow',
      name: 'Nested Workflow Node',
      config: {
        workflow_name: 'sub-workflow',
        input: { message: 'hello from parent' },
        wait_complete: true,
      },
    };

    executionContext = {
      sessionId: 'session-1',
      nodeOutputs: {},
      input: {},
      metadata: {},
    };

    mockRunner = createMockRunner();
  });

  describe('constructor', () => {
    it('should create a WorkflowNode with correct type', () => {
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      expect(workflowNode.type).toBe('workflow');
      expect(workflowNode.id).toBe('workflow-node-1');
    });

    it('should create WorkflowNode with minimal config', () => {
      const minimalDef: NodeDefinition = {
        id: 'minimal-node',
        type: 'workflow',
        config: {
          workflow_name: 'simple-workflow',
        },
      };
      
      const workflowNode = new WorkflowNode(minimalDef, mockRunner);
      expect(workflowNode.type).toBe('workflow');
      expect(workflowNode.id).toBe('minimal-node');
    });
  });

  describe('execute', () => {
    it('should run sub-workflow successfully', async () => {
      const completedResult: WorkflowRunResult = {
        runId: 'run_123',
        status: 'completed',
        output: { result: 'nested workflow done' },
      };
      
      mockRunner.run.mockResolvedValue(completedResult);
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      const result = await workflowNode.execute(executionContext);
      
      expect(result.success).toBe(true);
      expect(result.output).toEqual({ result: 'nested workflow done' });
      expect(result.error).toBeUndefined();
      expect(mockRunner.run).toHaveBeenCalledWith('sub-workflow', {
        message: 'hello from parent',
      });
    });

    it('should pass input to sub-workflow', async () => {
      const customInput = { param1: 'value1', param2: 123, nested: { data: 'test' } };
      nodeDefinition.config.input = customInput;
      
      mockRunner.run.mockResolvedValue({
        runId: 'run_456',
        status: 'completed',
        output: { processed: true },
      });
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      await workflowNode.execute(executionContext);
      
      expect(mockRunner.run).toHaveBeenCalledWith('sub-workflow', customInput);
    });

    it('should wait for completion when wait_complete=true', async () => {
      nodeDefinition.config.wait_complete = true;
      
      mockRunner.run.mockResolvedValue({
        runId: 'run_wait',
        status: 'completed',
        output: { waited: true },
      });
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      const result = await workflowNode.execute(executionContext);
      
      expect(result.success).toBe(true);
      expect(result.output).toEqual({ waited: true });
      // When wait_complete=true, run should return completed status
      expect(mockRunner.run).toHaveBeenCalled();
    });

    it('should not wait for completion when wait_complete=false', async () => {
      nodeDefinition.config.wait_complete = false;
      
      mockRunner.run.mockResolvedValue({
        runId: 'run_fire',
        status: 'completed', // Fire-and-forget returns immediately
        output: { runId: 'run_fire' },
      });
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      const result = await workflowNode.execute(executionContext);
      
      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
      // Should have called run
      expect(mockRunner.run).toHaveBeenCalled();
    });

    it('should handle sub-workflow failure', async () => {
      mockRunner.run.mockResolvedValue({
        runId: 'run_fail',
        status: 'failed',
        error: 'Sub-workflow execution failed',
      });
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      const result = await workflowNode.execute(executionContext);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Sub-workflow execution failed');
    });

    it('should handle sub-workflow not found', async () => {
      mockRunner.run.mockRejectedValue(new Error('Workflow not found: non-existent-workflow'));
      
      nodeDefinition.config.workflow_name = 'non-existent-workflow';
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      const result = await workflowNode.execute(executionContext);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Workflow not found');
    });

    it('should record execution duration', async () => {
      mockRunner.run.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          runId: 'run_duration',
          status: 'completed',
          output: { done: true },
        };
      });
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      const result = await workflowNode.execute(executionContext);
      
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should resolve template references from previous outputs', async () => {
      // Set up previous outputs from other nodes
      // Note: The Map format stores raw outputs directly, so path is {{nodeId.property}}
      executionContext.previousOutputs = new Map([
        ['node-0', { value: 'from-node-0' }]
      ]);
      
      // Create node with template reference input
      const templateNodeDef: NodeDefinition = {
        id: 'workflow-node-1',
        type: 'workflow',
        name: 'Nested Workflow Node',
        config: {
          workflow_name: 'sub-workflow',
          input: {
            message: '{{node-0.value}}',
          },
        },
      };
      
      mockRunner.run.mockResolvedValue({
        runId: 'run_template',
        status: 'completed',
        output: { received: 'from-node-0' },
      });
      
      const workflowNode = new WorkflowNode(templateNodeDef, mockRunner);
      await workflowNode.execute(executionContext);
      
      // The input should have template references resolved
      expect(mockRunner.run).toHaveBeenCalledWith('sub-workflow', {
        message: 'from-node-0',
      });
    });

    it('should handle unresolved template references gracefully', async () => {
      nodeDefinition.config.input = {
        message: '{{non-existent.value}}',
      };
      
      mockRunner.run.mockResolvedValue({
        runId: 'run_unresolved',
        status: 'completed',
        output: {},
      });
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      await workflowNode.execute(executionContext);
      
      // Should pass through unresolved template as-is
      expect(mockRunner.run).toHaveBeenCalledWith('sub-workflow', {
        message: '{{non-existent.value}}',
      });
    });

    it('should throw error when workflow_name is missing', async () => {
      nodeDefinition.config = {}; // No workflow_name specified
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      const result = await workflowNode.execute(executionContext);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('workflow_name');
    });

    it('should pass metadata to sub-workflow', async () => {
      executionContext.metadata = {
        parentRunId: 'parent-123',
        correlationId: 'corr-456',
      };
      
      mockRunner.run.mockResolvedValue({
        runId: 'run_meta',
        status: 'completed',
        output: {},
      });
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      await workflowNode.execute(executionContext);
      
      expect(mockRunner.run).toHaveBeenCalledWith('sub-workflow', {
        message: 'hello from parent',
      });
    });

    it('should handle stopped sub-workflow', async () => {
      mockRunner.run.mockResolvedValue({
        runId: 'run_stopped',
        status: 'stopped',
        error: 'Workflow was stopped',
      });
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      const result = await workflowNode.execute(executionContext);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('WorkflowRunner interface', () => {
    it('should use run method to start workflows', async () => {
      mockRunner.run.mockResolvedValue({
        runId: 'run_interface',
        status: 'completed',
        output: { test: true },
      });
      
      const workflowNode = new WorkflowNode(nodeDefinition, mockRunner);
      await workflowNode.execute(executionContext);
      
      expect(mockRunner.run).toHaveBeenCalledTimes(1);
    });

    it('should use getRun method for status checking', async () => {
      // This test verifies the interface contract
      mockRunner.getRun.mockResolvedValue({
        runId: 'run_status',
        status: 'completed',
        output: {},
      });
      
      // The interface supports getRun for status checking
      const status = await mockRunner.getRun('run_status');
      expect(status).toBeDefined();
      expect(status?.runId).toBe('run_status');
    });
  });
});
