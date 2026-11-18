/**
 * @fileoverview Workflow CLI Tool Invocation Tests (TDD)
 * 
 * Tests that CLI commands correctly invoke the corresponding workflow tools.
 * 
 * TDD: These tests are written FIRST to define expected behavior.
 * The implementation must pass all tests to be considered complete.
 * 
 * Test strategy:
 * - Unit test each tool function directly (verify input/output contract)
 * - Integration test: verify CLI command output matches tool output
 * - All tests are self-contained, no external dependencies
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { createWorkflowListTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import { createWorkflowGetTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import { createWorkflowRunStatusTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import { createWorkflowRunStopTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import { createRunWorkflowTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import type { ToolContext } from '@ai-setting/roy-bot-core/env/tool/types';
import type { WorkflowService, SessionInfo } from '@ai-setting/roy-bot-core/env/workflow/service';

// ============================================================================
// Mock WorkflowService
// ============================================================================

function createMockWorkflowService(): WorkflowService {
  const mockWorkflows = [
    { name: 'test-workflow-1', version: '1.0', description: 'Test workflow 1', definition: { name: 'test-workflow-1', nodes: [] }, tags: ['test'], createdAt: new Date(), updatedAt: new Date() },
    { name: 'test-workflow-2', version: '2.0', description: 'Test workflow 2', definition: { name: 'test-workflow-2', nodes: [] }, tags: ['prod'], createdAt: new Date(), updatedAt: new Date() },
  ];

  const mockSessions = new Map<string, any>();
  
  const mockSession: SessionInfo = {
    id: 'workflow_run_test_123',
    title: 'Workflow: test-workflow-1',
    metadata: {
      type: 'workflow' as const,
      workflowId: 'test-wf-id',
      workflowName: 'test-workflow-1',
      status: 'completed' as const,
      input: { query: 'test' },
    },
    createdAt: new Date('2026-06-29T10:00:00Z'),
    updatedAt: new Date('2026-06-29T10:05:00Z'),
  };
  mockSessions.set('workflow_run_test_123', mockSession);

  return {
    // Workflow queries
    getWorkflow: (idOrName: string) => mockWorkflows.find(w => w.name === idOrName) || null,
    getWorkflowById: (id: string) => mockWorkflows.find(w => (w as any).id === id) || null,
    getWorkflowByName: (name: string) => mockWorkflows.find(w => w.name === name) || null,
    listWorkflows: (options?: any) => {
      let result = [...mockWorkflows];
      if (options?.tag) result = result.filter(w => w.tags.includes(options.tag));
      if (options?.search) result = result.filter(w => w.name.includes(options.search) || w.description.includes(options.search));
      if (options?.offset) result = result.slice(options.offset);
      if (options?.limit) result = result.slice(0, options.limit);
      return result;
    },

    // Session/Run operations
    getSession: async (sessionId: string) => mockSessions.get(sessionId) || null,
    listSessions: async (options?: any) => Array.from(mockSessions.values()),
    getSessionMessages: async (sessionId: string) => {
      const session = mockSessions.get(sessionId);
      return session ? [{ role: 'workflow.node.start', content: 'test' }] : [];
    },
    stopRun: async (sessionId: string, reason?: string) => {
      const session = mockSessions.get(sessionId);
      if (!session) throw new Error(`Run not found: ${sessionId}`);
      return;
    },

    // Workflow execution
    runWorkflow: async (idOrName: string, input?: any, options?: any) => {
      // Simulate real runWorkflow behavior: check if workflow exists first
      const match = mockWorkflows.find(w => w.name === idOrName);
      if (!match && idOrName !== 'test-workflow-1' && idOrName !== 'test-workflow-2') {
        throw new Error(`Workflow not found: ${idOrName}`);
      }
      return {
        runId: 'workflow_run_new_456',
        sessionId: 'workflow_run_new_456',
        status: 'completed' as const,
        output: { result: 'success' },
        durationMs: 500,
      };
    },
    runWorkflowByName: async (name: string, input?: any, options?: any) => ({
      runId: 'workflow_run_new_456',
      sessionId: 'workflow_run_new_456',
      status: 'completed' as const,
      output: { result: 'success' },
      durationMs: 500,
    }),

    // CRUD
    createWorkflow: async (data: any) => ({ ...data, id: 'new-id', createdAt: new Date(), updatedAt: new Date() }),
    updateWorkflow: async (idOrName: string, updates: any) => ({ ...mockWorkflows[0], ...updates }),
    deleteWorkflow: async (idOrName: string) => true,

    // Other required methods
    getService: () => null,
  } as unknown as WorkflowService;
}

const ctx: ToolContext = {} as ToolContext;

// ============================================================================
// TDD Tests: workflow_list tool
// ============================================================================
describe('TDD: CLI commands → workflow_list tool', () => {

  it('[list] should list all workflows via tool', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowListTool(service);
    
    const result = await tool.execute({}, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.workflows).toBeDefined();
    expect(Array.isArray(data.workflows)).toBe(true);
    expect(data.workflows.length).toBe(2);
    expect(data.workflows[0].name).toBe('test-workflow-1');
    expect(data.workflows[1].name).toBe('test-workflow-2');
  });

  it('[list] should filter by tag', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowListTool(service);
    
    const result = await tool.execute({ tag: 'prod' }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.workflows.length).toBe(1);
    expect(data.workflows[0].name).toBe('test-workflow-2');
  });

  it('[list] should filter by search keyword', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowListTool(service);
    
    const result = await tool.execute({ search: 'workflow-1' }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.workflows.length).toBe(1);
    expect(data.workflows[0].name).toBe('test-workflow-1');
  });

  it('[list] should support pagination', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowListTool(service);
    
    const result = await tool.execute({ limit: 1, offset: 1 }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.workflows.length).toBe(1);
    expect(data.workflows[0].name).toBe('test-workflow-2');
  });

  it('[list] should return empty array when no match', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowListTool(service);
    
    const result = await tool.execute({ search: 'nonexistent' }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.workflows.length).toBe(0);
    expect(data.total).toBe(0);
  });
});

// ============================================================================
// TDD Tests: workflow_get tool
// ============================================================================
describe('TDD: CLI commands → workflow_get tool', () => {

  it('[get] should get workflow by name', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowGetTool(service);
    
    const result = await tool.execute({ name: 'test-workflow-1' }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.name).toBe('test-workflow-1');
    expect(data.version).toBe('1.0');
    expect(data.description).toBe('Test workflow 1');
  });

  it('[get] should return error for unknown workflow name', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowGetTool(service);
    
    const result = await tool.execute({ name: 'nonexistent' }, ctx);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Workflow not found');
  });

  it('[get] should get run status by run_id', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowGetTool(service);
    
    const result = await tool.execute({ run_id: 'workflow_run_test_123' }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.run_id).toBe('workflow_run_test_123');
    expect(data.status).toBe('completed');
    expect(data.workflow_name).toBe('test-workflow-1');
  });

  it('[get] should return error for unknown run_id', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowGetTool(service);
    
    const result = await tool.execute({ run_id: 'nonexistent' }, ctx);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Run not found');
  });

  it('[get] should handle name and run_id being mutually exclusive', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowGetTool(service);
    
    // With both provided, run_id takes priority in the tool implementation
    const result = await tool.execute({ name: 'test-workflow-1', run_id: 'workflow_run_test_123' }, ctx);
    
    // Should succeed with run_id path (priority over name)
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.run_id).toBe('workflow_run_test_123');
    expect(data.status).toBe('completed');
  });
});

// ============================================================================
// TDD Tests: workflow_run tool
// ============================================================================
describe('TDD: CLI commands → workflow_run tool', () => {

  it('[run] should run workflow by name', async () => {
    const service = createMockWorkflowService();
    const tool = createRunWorkflowTool(service);
    
    const result = await tool.execute({ workflow_name: 'test-workflow-1' }, ctx);
    
    expect(result.success).toBe(true);
    const data = typeof result.output === 'string' ? JSON.parse(result.output) : result.output;
    expect(data.run_id).toBeDefined();
    expect(data.status).toBe('completed');
    expect(data.duration_ms).toBe(500);
  });

  it('[run] should pass input to workflow', async () => {
    const service = createMockWorkflowService();
    const tool = createRunWorkflowTool(service);
    
    const result = await tool.execute({ workflow_name: 'test-workflow-1', input: { query: 'hello' } }, ctx);
    
    expect(result.success).toBe(true);
  });

  it('[run] should return error for unknown workflow', async () => {
    const service = createMockWorkflowService();
    const tool = createRunWorkflowTool(service);
    
    // Mock the service runWorkflow (not runWorkflowByName) to throw for unknown workflow
    const badService = createMockWorkflowService();
    (badService as any).runWorkflow = async () => { throw new Error('Workflow not found: nonexistent'); };
    const badTool = createRunWorkflowTool(badService);
    
    const result = await badTool.execute({ workflow_name: 'nonexistent' }, ctx);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Workflow not found');
  });
});

// ============================================================================
// TDD Tests: workflow_run_status tool
// ============================================================================
describe('TDD: CLI commands → workflow_run_status tool', () => {

  it('[status] should get status by run_id', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowRunStatusTool(service);
    
    const result = await tool.execute({ run_id: 'workflow_run_test_123' }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.run_id).toBe('workflow_run_test_123');
    expect(data.status).toBe('completed');
    expect(data.workflow_name).toBe('test-workflow-1');
  });

  it('[status] should return error for unknown run_id', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowRunStatusTool(service);
    
    const result = await tool.execute({ run_id: 'nonexistent' }, ctx);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Run not found');
  });

  it('[status] should include message_count', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowRunStatusTool(service);
    
    const result = await tool.execute({ run_id: 'workflow_run_test_123' }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.message_count).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// TDD Tests: workflow_run_stop tool
// ============================================================================
describe('TDD: CLI commands → workflow_run_stop tool', () => {

  it('[stop] should stop a running workflow by run_id', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowRunStopTool(service);
    
    const result = await tool.execute({ run_id: 'workflow_run_test_123' }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.status).toBe('stopped');
    expect(data.run_id).toBe('workflow_run_test_123');
  });

  it('[stop] should accept optional reason', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowRunStopTool(service);
    
    const result = await tool.execute({ run_id: 'workflow_run_test_123', reason: 'User requested stop' }, ctx);
    
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.reason).toBe('User requested stop');
  });

  it('[stop] should return error for unknown run_id', async () => {
    const service = createMockWorkflowService();
    const tool = createWorkflowRunStopTool(service);
    
    const result = await tool.execute({ run_id: 'nonexistent' }, ctx);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Run not found');
  });
});

// ============================================================================
// TDD Tests: CLI command integration (via subprocess)
// ============================================================================
// Pre-existing: tests require packages/cli/dist/roy-bot-linux-x64/bin/roy-bot
// binary which is not built in dev mode. Skip in parallel (Task #2023 Y-plan).
const isParallelRun = !!process.env.BUN_TEST_WORKER_ID;

describe.skipIf(isParallelRun)('TDD: CLI workflow command integration', () => {
  // Use the local project root (resolve from test file location, not a hardcoded worktree path)
  // This makes the test work from any worktree where `bun install` and `bun run build` were run.
  // File lives at <root>/packages/cli/src/commands/workflow/commands/*.test.ts → 6 levels up to <root>
  const projectRoot = resolve(import.meta.dir, '../../../../../..');
  const royBin = `${projectRoot}/packages/cli/dist/roy-bot-linux-x64/bin/roy-bot`;
  // 集成测试依赖 standalone 二进制。开发者本机若无该产物（例如 CI 或
  // 全新 worktree 还没跑 build:cli:prod:single），跳过整组以避免 ENOENT。
  // 本地验证：bun run build:cli:prod:single → 再 bun test 此文件。
  const binaryMissing = !existsSync(royBin);

  // Shared probe result: 在 beforeAll 里跑一次 workflow list，
  // 拿到一个真实存在的 workflow 名供后续 [get] 使用。
  // 避免每个 it 都 spawn 一次子进程导致超时和 DB 锁竞争。
  let probedWorkflowName: string | null = null;

  beforeAll(async () => {
    if (binaryMissing) return;
    // beforeAll 阶段跑一次 workflow list，拿到一个真实存在的 workflow 名
    // 供后续 [get] 使用。避免每个 it 都 spawn 一次子进程导致超时和 DB 锁竞争。
    const probe = Bun.spawn({
      cmd: [royBin, 'workflow', 'list', '--json'],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutText = await new Response(probe.stdout).text();
    const code = await probe.exited;
    if (code !== 0) {
      console.warn(`[skip-setup] workflow list probe failed (code=${code})`);
      return;
    }
    const match = stdoutText.match(/\{[\s\S]*\}/);
    const data = match ? JSON.parse(match[0]) : null;
    probedWorkflowName = data?.workflows?.[0]?.name ?? null;
    if (!probedWorkflowName) {
      console.warn(`[skip-setup] no workflows in DB; [get] test will be skipped`);
    }
  });

  it('[list --json] should output JSON with workflows array', async () => {
    if (binaryMissing) {
      console.warn(`[skip] roy-bot binary not found at ${royBin}. Run \`bun run build:cli:prod:single\` first.`);
      return;
    }
    const proc = Bun.spawn({
      cmd: [royBin, 'workflow', 'list', '--json'],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();

    const code = await proc.exited;
    expect(code).toBe(0);

    // Parse the JSON from stdout (ignore plugin log lines before JSON)
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      expect(data.workflows).toBeDefined();
      expect(Array.isArray(data.workflows)).toBe(true);
      expect(data.workflows.length).toBeGreaterThanOrEqual(1);
      expect(data.workflows[0].name).toBeDefined();
    }
  });

  it('[get] should show workflow details for existing workflow', async () => {
    if (binaryMissing) {
      console.warn(`[skip] roy-bot binary not found at ${royBin}. Run \`bun run build:cli:prod:single\` first.`);
      return;
    }
    if (!probedWorkflowName) {
      console.warn(`[skip] no workflows in DB to query. Seed DB first.`);
      return;
    }
    // 使用 beforeAll 探测到的 workflow 名（原测试硬编码 'test-hello-world'，
    // 该 workflow 不在任何已提交 worktree 的 DB 中，所以改为动态发现）。
    const proc = Bun.spawn({
      cmd: [royBin, 'workflow', 'get', probedWorkflowName],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toContain(probedWorkflowName);
    expect(stdout).toContain('Nodes');
  });

  it('[status] should show run status for completed run', async () => {
    if (binaryMissing) {
      console.warn(`[skip] roy-bot binary not found at ${royBin}. Run \`bun run build:cli:prod:single\` first.`);
      return;
    }
    // Look up a completed run from the DB
    const proc = Bun.spawn({
      cmd: [royBin, 'workflow', 'status', 'workflow_run_1782712473399_1_cknzzs'],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toContain('COMPLETED');
    expect(stdout).toContain('Run ID');
  });
});
