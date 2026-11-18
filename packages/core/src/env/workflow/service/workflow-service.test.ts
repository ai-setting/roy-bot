/**
 * WorkflowService Tests - Session-based Design
 */

import { describe, it, expect, beforeEach, vi } from 'bun:test';
import { WorkflowService } from './workflow-service';
import { MockWorkflowRepository, MockWorkflowEngine } from '../storage/mock-repositories';
import type { WorkflowDefinition, Workflow } from '../types';

describe('WorkflowService', () => {
  let workflowRepo: MockWorkflowRepository;
  let mockEngine: MockWorkflowEngine;
  let service: WorkflowService;
  
  const sampleDefinition: WorkflowDefinition = {
    name: 'test-workflow',
    version: '1.0',
    description: 'A test workflow',
    nodes: [
      {
        id: 'node1',
        type: 'tool',
        config: { tool: 'test-tool' },
      },
      {
        id: 'node2',
        type: 'tool',
        config: { tool: 'test-tool-2' },
        depends_on: ['node1'],
      },
    ],
  };
  
  beforeEach(() => {
    workflowRepo = new MockWorkflowRepository();
    mockEngine = new MockWorkflowEngine();
    
    // Create engine factory that returns the mock engine
    const engineFactory = (workflow: Workflow) => {
      mockEngine.setWorkflowName(workflow.name);
      return mockEngine as any;
    };
    
    service = new WorkflowService(
      workflowRepo,
      engineFactory
    );
  });

  // ==================== Workflow CRUD Tests ====================
  
  describe('createWorkflow', () => {
    it('should create a workflow from definition', async () => {
      const workflow = await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      expect(workflow).toBeDefined();
      expect(workflow.name).toBe('test-workflow');
      expect(workflow.version).toBe('1.0');
      expect(workflow.definition).toEqual(sampleDefinition);
      expect(workflow.id).toBeDefined();
    });
    
    it('should create workflow with tags from options', async () => {
      const workflow = await service.createWorkflow(sampleDefinition, {
        tags: ['test', 'example'],
      });
      
      expect(workflow.tags).toEqual(['test', 'example']);
    });
    
    it('should create workflow with metadata from options', async () => {
      const workflow = await service.createWorkflow(sampleDefinition, {
        tags: ['meta-test'],
        metadata: { author: 'tester' },
      });

      expect(workflow.metadata.author).toBe('tester');
    });
    
    it('should throw error if workflow with same name exists', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      await expect(service.createWorkflow(sampleDefinition, { tags: ["test"] })).rejects.toThrow(
        'Workflow already exists'
      );
    });
    
    it('should allow creating workflow with force option to overwrite', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      const updatedDef = { ...sampleDefinition, description: 'Updated' };
      const workflow = await service.createWorkflow(updatedDef, { force: true, tags: ['updated'] });
      
      expect(workflow.description).toBe('Updated');
    });

    // ==================== Tag Validation Tests (1-3 tags required) ====================

    it('should throw error when no tags provided', async () => {
      await expect(service.createWorkflow(sampleDefinition)).rejects.toThrow(
        /at least 1 tag/i
      );
    });

    it('should throw error when tags array is empty', async () => {
      await expect(
        service.createWorkflow(sampleDefinition, { tags: [] })
      ).rejects.toThrow(/at least 1 tag/i);
    });

    it('should throw error when more than 3 tags provided', async () => {
      await expect(
        service.createWorkflow(sampleDefinition, { tags: ['a', 'b', 'c', 'd'] })
      ).rejects.toThrow(/at most 3 tags/i);
    });

    it('should accept exactly 1 tag', async () => {
      const workflow = await service.createWorkflow(sampleDefinition, {
        tags: ['solo'],
      });

      expect(workflow.tags).toEqual(['solo']);
    });

    it('should accept exactly 3 tags', async () => {
      const workflow = await service.createWorkflow(sampleDefinition, {
        tags: ['one', 'two', 'three'],
      });

      expect(workflow.tags).toEqual(['one', 'two', 'three']);
    });

    it('should accept tags from definition.metadata.tags', async () => {
      const defWithMetaTags: WorkflowDefinition = {
        ...sampleDefinition,
        metadata: { tags: ['from-meta'] },
      };
      const workflow = await service.createWorkflow(defWithMetaTags);

      expect(workflow.tags).toEqual(['from-meta']);
    });

    it('should prioritize options.tags over definition.metadata.tags', async () => {
      const defWithMetaTags: WorkflowDefinition = {
        ...sampleDefinition,
        metadata: { tags: ['from-meta'] },
      };
      const workflow = await service.createWorkflow(defWithMetaTags, {
        tags: ['from-options'],
      });

      expect(workflow.tags).toEqual(['from-options']);
    });

    it('should throw error when definition.metadata.tags exceeds 3', async () => {
      const defWithMetaTags: WorkflowDefinition = {
        ...sampleDefinition,
        metadata: { tags: ['a', 'b', 'c', 'd'] },
      };

      await expect(service.createWorkflow(defWithMetaTags)).rejects.toThrow(
        /at most 3 tags/i
      );
    });
  });

  // ==================== Task #2926: sanitizer wired into persistence ====================

  describe('Task #2926 — sanitize shell bugs at write time', () => {
    const buggyDefinition: WorkflowDefinition = {
      name: 'buggy-wf',
      version: '2.4.0',
      description: 'Has python3-c and bare $RANDOM bugs',
      nodes: [
        {
          id: 'get-jwt',
          type: 'tool',
          config: {
            tool: 'bash',
            inputs: {
              command: [
                'set -u',
                'STATE="roys-$(date +%s)-$RANDOM"',
                'PAYLOAD=$(python3 -c "; import json, sys; print(json.dumps({\\"k\\":1}))")',
              ].join('\n'),
            },
          },
        },
      ],
    };

    it('createWorkflow sanitizes definition before persisting', async () => {
      const wf = await service.createWorkflow(buggyDefinition, { tags: ['sanitize'] });
      const cmd = (wf.definition.nodes[0].config as any).inputs.command;
      expect(cmd).toContain('${RANDOM:-0}');
      expect(cmd).not.toContain('python3 -c ";');
      expect(cmd).toContain('python3 -c "import json, sys;');
    });

    it('createWorkflow force-overwrite also sanitizes', async () => {
      await service.createWorkflow(buggyDefinition, { tags: ['sanitize'] });
      const wf = await service.createWorkflow(buggyDefinition, {
        force: true,
        tags: ['sanitize'],
      });
      const cmd = (wf.definition.nodes[0].config as any).inputs.command;
      expect(cmd).toContain('${RANDOM:-0}');
      expect(cmd).not.toContain('python3 -c ";');
    });

    it('updateWorkflow sanitizes the new definition', async () => {
      await service.createWorkflow(buggyDefinition, { tags: ['sanitize'] });
      const wf = await service.updateWorkflow('buggy-wf', {
        definition: buggyDefinition,
      });
      const cmd = (wf.definition.nodes[0].config as any).inputs.command;
      expect(cmd).toContain('${RANDOM:-0}');
      expect(cmd).not.toContain('python3 -c ";');
    });

    it('does not mutate the input definition (immutability through service)', async () => {
      const before = JSON.stringify(buggyDefinition);
      await service.createWorkflow(buggyDefinition, { tags: ['sanitize'] });
      expect(JSON.stringify(buggyDefinition)).toBe(before);
    });
  });

  describe('getWorkflow', () => {
    it('should get workflow by id', async () => {
      const created = await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      const workflow = service.getWorkflow(created.id);
      
      expect(workflow).toBeDefined();
      expect(workflow?.name).toBe('test-workflow');
    });
    
    it('should get workflow by name', () => {
      service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      const workflow = service.getWorkflow('test-workflow');
      
      expect(workflow).toBeDefined();
      expect(workflow?.id).toBeDefined();
    });
    
    it('should return null if workflow not found', () => {
      const workflow = service.getWorkflow('nonexistent');
      
      expect(workflow).toBeNull();
    });
  });

  describe('listWorkflows', () => {
    it('should list all workflows', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      await service.createWorkflow({
        ...sampleDefinition,
        name: 'workflow2',
      }, { tags: ['test'] });

      const workflows = service.listWorkflows();

      expect(workflows.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter workflows by tag', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ['test'] });
      await service.createWorkflow({
        ...sampleDefinition,
        name: 'workflow2',
      }, { tags: ['other'] });

      const workflows = service.listWorkflows({ tag: 'test' });

      expect(workflows.length).toBeGreaterThanOrEqual(1);
      expect(workflows.every(w => w.tags.includes('test'))).toBe(true);
    });

    it('should support pagination with limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await service.createWorkflow({
          ...sampleDefinition,
          name: `workflow${i}`,
        }, { tags: [`tag-${i}`] });
      }
      
      const workflows = service.listWorkflows({ limit: 2, offset: 0 });
      
      expect(workflows.length).toBeLessThanOrEqual(2);
    });
  });

  describe('searchWorkflows', () => {
    beforeEach(async () => {
      // Seed multiple workflows for search tests
      await service.createWorkflow(
        { ...sampleDefinition, name: 'ai-pipeline', description: 'AI training pipeline' },
        { tags: ['ai', 'ml'] }
      );
      await service.createWorkflow(
        { ...sampleDefinition, name: 'data-cleanup', description: 'Data cleanup and validation' },
        { tags: ['data', 'etl'] }
      );
      await service.createWorkflow(
        { ...sampleDefinition, name: 'ai-eval', description: 'AI model evaluation' },
        { tags: ['ai', 'eval'] }
      );
    });

    it('should filter workflows by single tag (exact match)', async () => {
      const results = service.searchWorkflows({ tags: ['ai'] });

      expect(results.length).toBe(2);
      expect(results.every(w => w.tags.includes('ai'))).toBe(true);
    });

    it('should filter workflows by multiple tags (AND filter)', async () => {
      const results = service.searchWorkflows({ tags: ['ai', 'ml'] });

      expect(results.length).toBe(1);
      expect(results[0].name).toBe('ai-pipeline');
    });

    it('should return empty array when no workflow matches all tags', async () => {
      const results = service.searchWorkflows({ tags: ['ai', 'nonexistent'] });

      expect(results.length).toBe(0);
    });

    it('should search by keyword in name', async () => {
      const results = service.searchWorkflows({ keyword: 'pipeline' });

      expect(results.length).toBe(1);
      expect(results[0].name).toBe('ai-pipeline');
    });

    it('should search by keyword in description', async () => {
      const results = service.searchWorkflows({ keyword: 'validation' });

      expect(results.length).toBe(1);
      expect(results[0].name).toBe('data-cleanup');
    });

    it('should combine keyword and tag filter (AND)', async () => {
      const results = service.searchWorkflows({ keyword: 'ai', tags: ['eval'] });

      expect(results.length).toBe(1);
      expect(results[0].name).toBe('ai-eval');
    });

    it('should return all workflows when no filter is provided', async () => {
      const results = service.searchWorkflows({});

      expect(results.length).toBeGreaterThanOrEqual(3);
    });

    it('should support pagination with limit and offset', async () => {
      const first = service.searchWorkflows({ limit: 2, offset: 0 });
      const second = service.searchWorkflows({ limit: 2, offset: 2 });

      expect(first.length).toBe(2);
      expect(second.length).toBeGreaterThanOrEqual(1);
      // The IDs should not overlap
      const firstIds = new Set(first.map(w => w.id));
      const secondIds = new Set(second.map(w => w.id));
      for (const id of secondIds) {
        expect(firstIds.has(id)).toBe(false);
      }
    });
  });

  describe('updateWorkflow', () => {
    it('should update workflow definition', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ['update-test'] });
      
      const updatedDef = {
        ...sampleDefinition,
        nodes: [
          ...sampleDefinition.nodes,
          { id: 'new-node', type: 'tool', config: { tool: 'new-tool' } },
        ],
      };
      
      const workflow = await service.updateWorkflow('test-workflow', {
        definition: updatedDef,
      });
      
      expect(workflow.definition.nodes.length).toBe(3);
    });
    
    it('should update workflow tags', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      const workflow = await service.updateWorkflow('test-workflow', {}, {
        tags: ['updated', 'tags'],
      });
      
      expect(workflow.tags).toEqual(['updated', 'tags']);
    });
    
    it('should throw error if workflow not found', async () => {
      await expect(
        service.updateWorkflow('nonexistent', { definition: sampleDefinition })
      ).rejects.toThrow('Workflow not found');
    });
  });

  describe('deleteWorkflow', () => {
    it('should delete workflow by name', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      const result = await service.deleteWorkflow('test-workflow');
      
      expect(result).toBe(true);
      expect(service.getWorkflow('test-workflow')).toBeNull();
    });
    
    it('should return false if workflow not found', async () => {
      const result = await service.deleteWorkflow('nonexistent');
      
      expect(result).toBe(false);
    });
  });

  // ==================== Workflow Execution Tests (Session-based) ====================
  
  describe('runWorkflow', () => {
    it('should run workflow by definition', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      const result = await service.runWorkflow(sampleDefinition);
      
      expect(result).toBeDefined();
      expect(result.sessionId || result.runId).toBeDefined();
      expect(mockEngine.getCallsByMethod('runWorkflow')).toHaveLength(1);
    });
    
    it('should pass input to workflow run', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      const result = await service.runWorkflow(sampleDefinition, {
        key: 'value',
      });
      
      expect(result).toBeDefined();
      const runCall = mockEngine.getCallsByMethod('runWorkflow')[0];
      expect(runCall.args[1]).toBeDefined();
    });
    
    it('should run workflow by name', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });

      const result = await service.runWorkflow('test-workflow');

      expect(result).toBeDefined();
      expect(result.sessionId || result.runId).toBeDefined();
    });

    // ────────────────────────────────────────────────────────────────────
    // Task #1840: onSessionCreated callback must be forwarded through
    // WorkflowService.runWorkflow() to the engine so the tool layer can
    // capture runId on timeout/error paths.
    // ────────────────────────────────────────────────────────────────────

    it('should forward onSessionCreated option to engine.runWorkflow (Task #1840)', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });

      const cb = () => {};

      await service.runWorkflow(sampleDefinition, undefined, {
        onSessionCreated: cb,
      });

      const runCall = mockEngine.getCallsByMethod('runWorkflow')[0];
      expect(runCall.args[1]).toBeDefined();
      // The callback must reach the engine unchanged (identity check)
      expect(runCall.args[1].onSessionCreated).toBe(cb);
    });
  });

  describe('runWorkflowByName', () => {
    it('should run workflow by name and return result', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });
      
      const result = await service.runWorkflowByName('test-workflow', { test: 'input' });
      
      expect(result).toBeDefined();
      expect(result.sessionId || result.runId).toBeDefined();
      expect(mockEngine.getLastCall()?.method).toBe('runWorkflow');
    });
    
    it('should throw error if workflow not found', async () => {
      await expect(
        service.runWorkflowByName('nonexistent')
      ).rejects.toThrow('Workflow not found');
    });
  });

  // ==================== Session-based Lifecycle Tests ====================

  describe('Session-based Resume', () => {
    it('should have engine factory that creates new engine for each resume', async () => {
      await service.createWorkflow(sampleDefinition, { tags: ["test"] });

      // Create a mock session component
      const mockSessionComponent = {
        create: vi.fn().mockResolvedValue({ id: 'workflow_test_123' }),
        get: vi.fn().mockResolvedValue({
          id: 'workflow_test_123',
          metadata: {
            type: 'workflow',
            workflowName: 'test-workflow',
            status: 'paused',
          },
        }),
        update: vi.fn().mockResolvedValue(true),
        addMessage: vi.fn().mockResolvedValue('msg_id'),
        getMessages: vi.fn().mockResolvedValue([]),
      };

      // Create service with session component
      const engineFactory = (workflow: Workflow) => {
        mockEngine.setWorkflowName(workflow.name);
        return mockEngine as any;
      };

      const serviceWithSession = new WorkflowService(
        workflowRepo,
        engineFactory,
        mockSessionComponent
      );

      // Run workflow first
      const result = await serviceWithSession.runWorkflow('test-workflow');

      // Verify engine was created
      expect(mockEngine.getCallsByMethod('runWorkflow')).toHaveLength(1);
    });
  });

  // ==================== Task #1829: resumeSession public API ====================

  describe('resumeSession', () => {
    let serviceWithSession: WorkflowService;
    let mockSessionComponent: any;
    let factoryCalls: Workflow[];

    beforeEach(async () => {
      // Reset additional mocks
      factoryCalls = [];
      mockSessionComponent = {
        create: vi.fn().mockResolvedValue({ id: 'workflow_test_123' }),
        get: vi.fn().mockResolvedValue({
          id: 'workflow_test_123',
          metadata: {
            type: 'workflow',
            workflowName: 'test-workflow',
            status: 'paused',
          },
        }),
        update: vi.fn().mockResolvedValue(true),
        addMessage: vi.fn().mockResolvedValue('msg_id'),
        getMessages: vi.fn().mockResolvedValue([]),
      };

      const engineFactory = (workflow: Workflow) => {
        factoryCalls.push(workflow);
        mockEngine.setWorkflowName(workflow.name);
        return mockEngine as any;
      };

      serviceWithSession = new WorkflowService(
        workflowRepo,
        engineFactory,
        mockSessionComponent,
      );

      await serviceWithSession.createWorkflow(sampleDefinition, { tags: ["test"] });
      mockEngine.clearCalls(); // clear createWorkflow side-effects
    });

    it('should resume workflow from existing session id', async () => {
      // The mock engine.run() returns { runId, status: 'completed' } by default
      const result = await serviceWithSession.resumeSession('workflow_test_123');

      expect(result.status).toBe('completed');
      expect(result.runId).toBe('workflow_test_123');
      expect(mockSessionComponent.get).toHaveBeenCalledWith('workflow_test_123');
      // Engine factory should have been invoked to construct engine for resume
      expect(factoryCalls.length).toBeGreaterThan(0);
      // Engine.run should have been called with sessionId
      const runCalls = mockEngine.getCallsByMethod('run');
      expect(runCalls.length).toBeGreaterThan(0);
      expect(runCalls[0].args[0]).toBe('workflow_test_123');
    });

    it('should throw when session not found', async () => {
      mockSessionComponent.get.mockResolvedValue(null);

      await expect(
        serviceWithSession.resumeSession('workflow_nonexistent')
      ).rejects.toThrow('Session not found: workflow_nonexistent');
    });

    it('should throw when session is not a workflow session', async () => {
      mockSessionComponent.get.mockResolvedValue({
        id: 'agent_session_xxx',
        metadata: { type: 'agent', workflowName: 'foo' }, // wrong type
      });

      await expect(
        serviceWithSession.resumeSession('agent_session_xxx')
      ).rejects.toThrow('Session is not a workflow session: agent_session_xxx');
    });

    it('should throw when workflow not registered', async () => {
      mockSessionComponent.get.mockResolvedValue({
        id: 'workflow_unknown',
        metadata: {
          type: 'workflow',
          workflowName: 'unknown-workflow',
          status: 'paused',
        },
      });

      await expect(
        serviceWithSession.resumeSession('workflow_unknown')
      ).rejects.toThrow('Workflow not found: unknown-workflow');
    });

    it('should forward input as userResponse option for ask_user resume path', async () => {
      mockSessionComponent.get.mockResolvedValue({
        id: 'workflow_test_123',
        metadata: {
          type: 'workflow',
          workflowName: 'test-workflow',
          status: 'paused',
        },
      });
      mockEngine.clearCalls();

      await serviceWithSession.resumeSession('workflow_test_123', {
        input: { userResponse: 'yes' },
      });

      const runCalls = mockEngine.getCallsByMethod('run');
      expect(runCalls.length).toBeGreaterThan(0);
      expect(runCalls[0].args[0]).toBe('workflow_test_123');
      expect((runCalls[0].args[1] as any)?.input).toEqual({ userResponse: 'yes' });
    });
  });
});
