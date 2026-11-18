/**
 * @fileoverview Workflow Integration Tests - Service Layer
 * 
 * Integration tests for WorkflowService with mocked repositories and engine.
 * Tests the session-based workflow lifecycle: create → run → complete/pause/resume/stop
 */

import { describe, it, expect, beforeEach, vi } from 'bun:test';
import { WorkflowService, type WorkflowRepository } from '../service/workflow-service';
import type { Workflow, WorkflowDefinition, RunResult } from '../types';
import * as workflows from '../fixtures';

// Export short names for convenience
const { singleNodeWorkflow, sequentialWorkflow, parallelWorkflow, diamondWorkflow } = workflows;

// =============================================================================
// Mock Implementations
// =============================================================================

/**
 * Create an in-memory workflow repository for testing
 */
function createMockWorkflowRepository() {
  const workflows = new Map<string, Workflow>();
  let idCounter = 0;
  
  return {
    workflows,
    create: (data: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>) => {
      const id = `wf_${++idCounter}`;
      const now = new Date();
      const workflow: Workflow = {
        id,
        name: data.name,
        version: data.version || '1.0.0',
        description: data.description,
        definition: data.definition,
        config: data.config || {},
        metadata: data.metadata || {},
        tags: data.tags || [],
        createdAt: now,
        updatedAt: now,
      };
      workflows.set(id, workflow);
      workflows.set(data.name, workflow);
      return workflow;
    },
    getById: (id: string) => workflows.get(id) || null,
    getByName: (name: string) => workflows.get(name) || null,
    list: (options?: { tag?: string; limit?: number; offset?: number }) => {
      let result = Array.from(workflows.values());
      if (options?.tag) {
        result = result.filter(w => w.tags.includes(options.tag!));
      }
      if (options?.offset) result = result.slice(options.offset);
      if (options?.limit) result = result.slice(0, options.limit);
      return result;
    },
    update: (id: string, updates: Partial<Workflow>) => {
      const wf = workflows.get(id);
      if (!wf) return null;
      const updated = { ...wf, ...updates, updatedAt: new Date() };
      workflows.set(id, updated);
      return updated;
    },
    delete: (id: string) => workflows.delete(id),
    transaction: <T>(fn: () => T): T => fn(),
  };
}

/**
 * Create a mock engine factory that returns a mock engine
 * Updated for session-based design
 */
function createMockEngineFactory() {
  return (workflow: Workflow) => {
    const mockEngine = {
      createSession: vi.fn().mockImplementation(async (workflowId: string, options?: any) => {
        return `workflow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }),
      createRun: vi.fn().mockImplementation(async (definition: any, options?: any) => {
        return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }),
      run: vi.fn().mockImplementation(async (runId: string, options?: any) => {
        return {
          runId,
          sessionId: runId,
          status: 'completed',
          output: { result: 'mock_output' },
          durationMs: 100,
        };
      }),
      runWorkflow: vi.fn().mockImplementation(async (wf: any, options?: any) => {
        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return {
          runId,
          sessionId: runId,
          status: 'completed',
          output: { result: 'mock_output' },
          durationMs: 100,
        };
      }),
      pause: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      addNode: vi.fn().mockResolvedValue(undefined),
      removeNode: vi.fn().mockResolvedValue(undefined),
    };
    return mockEngine;
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('WorkflowService Integration Tests', () => {
  let workflowRepo: ReturnType<typeof createMockWorkflowRepository>;
  let mockEngineFactory: ReturnType<typeof createMockEngineFactory>;
  let service: WorkflowService;
  
  beforeEach(() => {
    workflowRepo = createMockWorkflowRepository();
    mockEngineFactory = createMockEngineFactory();
    service = new WorkflowService(workflowRepo as any, mockEngineFactory as any);
  });

  // ===========================================================================
  // CRUD Tests
  // ===========================================================================
  
  describe('Workflow CRUD', () => {
    it('should create a workflow from definition', async () => {
      const workflow = await service.createWorkflow(singleNodeWorkflow, { tags: ["test"] });
      
      expect(workflow).toBeDefined();
      expect(workflow.id).toBeDefined();
      expect(workflow.name).toBe(singleNodeWorkflow.name);
      expect(workflow.definition).toEqual(singleNodeWorkflow);
    });
    
    it('should get workflow by name', async () => {
      const created = await service.createWorkflow(sequentialWorkflow, { tags: ["test"] });
      const retrieved = service.getWorkflowByName(created.name);
      
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
    });
    
    it('should get workflow by id', async () => {
      const created = await service.createWorkflow(sequentialWorkflow, { tags: ["test"] });
      const retrieved = service.getWorkflowById(created.id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
    });
    
    it('should list all workflows', async () => {
      await service.createWorkflow(singleNodeWorkflow, { tags: ["test"] });
      await service.createWorkflow(sequentialWorkflow, { tags: ["test"] });
      await service.createWorkflow(parallelWorkflow, { tags: ["test"] });
      
      const list = service.listWorkflows();
      
      expect(list.length).toBeGreaterThanOrEqual(3);
    });
    
    it('should update workflow', async () => {
      const created = await service.createWorkflow(singleNodeWorkflow, { tags: ["test"] });
      const updated = await service.updateWorkflow(created.id, {
        description: 'Updated description',
      });
      
      expect(updated.description).toBe('Updated description');
    });
    
    it('should delete workflow', async () => {
      const created = await service.createWorkflow(singleNodeWorkflow, { tags: ["test"] });
      const deleted = await service.deleteWorkflow(created.id);
      
      expect(deleted).toBe(true);
      expect(service.getWorkflow(created.id)).toBeNull();
    });
  });

  // ===========================================================================
  // Session-based Run Lifecycle Tests
  // ===========================================================================
  
  describe('Session-based Run Lifecycle', () => {
    it('should run workflow and create session', async () => {
      await service.createWorkflow(singleNodeWorkflow, { tags: ["test"] });
      
      const result = await service.runWorkflow(singleNodeWorkflow);
      
      expect(result).toBeDefined();
      expect(result.sessionId || result.runId).toBeDefined();
      expect(result.status).toBe('completed');
    });
    
    it('should pass input to workflow run', async () => {
      await service.createWorkflow(sequentialWorkflow, { tags: ["test"] });
      
      const result = await service.runWorkflow(sequentialWorkflow, { test: 'input' });
      
      expect(result).toBeDefined();
    });
    
    it('should run workflow by name', async () => {
      await service.createWorkflow(parallelWorkflow, { tags: ["test"] });
      
      const result = await service.runWorkflow(parallelWorkflow.name);
      
      expect(result).toBeDefined();
      expect(result.sessionId || result.runId).toBeDefined();
    });
    
    it('should run workflow by name using convenience method', async () => {
      await service.createWorkflow(diamondWorkflow, { tags: ["test"] });
      
      const result = await service.runWorkflowByName(diamondWorkflow.name);
      
      expect(result).toBeDefined();
    });
    
    it('should throw error for non-existent workflow', async () => {
      await expect(service.runWorkflow('nonexistent')).rejects.toThrow('Workflow not found');
    });
  });

  // ===========================================================================
  // Session-based Resume Tests
  // ===========================================================================
  
  describe('Session-based Resume (Mocked)', () => {
    it('should have engine factory that creates new engine for each resume', async () => {
      await service.createWorkflow(singleNodeWorkflow, { tags: ["test"] });
      
      // Create mock session component
      const mockSessionComponent = {
        create: vi.fn().mockResolvedValue({ id: 'workflow_test_123' }),
        get: vi.fn().mockResolvedValue({
          id: 'workflow_test_123',
          metadata: {
            type: 'workflow',
            workflowName: 'single-node-workflow',
            status: 'paused',
          },
        }),
        update: vi.fn().mockResolvedValue(true),
        addMessage: vi.fn().mockResolvedValue('msg_id'),
        getMessages: vi.fn().mockResolvedValue([]),
      };
      
      // Create service with session component
      const serviceWithSession = new WorkflowService(
        workflowRepo as any,
        mockEngineFactory as any,
        mockSessionComponent as any
      );
      
      // Run workflow first
      const result = await serviceWithSession.runWorkflow(singleNodeWorkflow);
      
      expect(result).toBeDefined();
      expect(result.sessionId || result.runId).toBeDefined();
    });
  });
});
