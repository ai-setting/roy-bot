/**
 * Workflow Search Tool Tests (v2)
 */

import { describe, it, expect, beforeEach } from 'bun:test';

function getDatabaseClass(): new (path: string) => any {
  // @ts-ignore
  if (typeof Bun !== 'undefined') {
    // @ts-ignore
    const { Database } = require("bun:sqlite");
    return Database;
  } else {
    return require("better-sqlite3");
  }
}

function createCompatibleDatabase(path: string): any {
  const Database = getDatabaseClass();
  const db = new Database(path);
  if (typeof db.run !== 'function') {
    db.run = function(sql: string, ...params: any[]) {
      if (params.length > 0) return this.prepare(sql).run(...params);
      return this.exec(sql);
    };
  }
  return db;
}

function createTestDatabase() {
  const db = createCompatibleDatabase(":memory:");
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL DEFAULT '1.0',
      description TEXT,
      definition TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      task_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE workflow_tags (
      name TEXT PRIMARY KEY,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

const sampleDefinition = (name: string, description?: string): any => ({
  name,
  version: '1.0',
  description: description ?? `Workflow ${name}`,
  nodes: [{ id: 'node1', type: 'tool', config: { tool: 'test-tool' } }],
});

describe('WorkflowSearchTool', () => {
  let createWorkflowSearchTool: any;
  let WorkflowService: any;
  let WorkflowRepository: any;
  let TagRepository: any;
  let service: any;
  let tool: any;

  beforeEach(async () => {
    if (!createWorkflowSearchTool) {
      const mod = await import('./workflow-search-tool');
      createWorkflowSearchTool = mod.createWorkflowSearchTool;
      WorkflowService = (await import('../service/workflow-service')).WorkflowService;
      WorkflowRepository = (await import('../storage/workflow-repo')).WorkflowRepository;
      TagRepository = (await import('../storage/tag-repo')).TagRepository;
    }
    const db = createTestDatabase();
    const workflowRepo = new WorkflowRepository(db);
    const tagRepo = new TagRepository(db);
    service = new WorkflowService(workflowRepo, () => ({} as any), undefined, tagRepo);
    tool = createWorkflowSearchTool(service);
  });

  it('should fail when neither keyword nor tags provided', async () => {
    const result = await tool.execute({}, {} as any);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/keyword.*tags/);
  });

  it('should search by single tag and return available_tags', async () => {
    await service.createWorkflow(sampleDefinition('a', 'AI chatbot'), { tags: ['ai'] });
    await service.createWorkflow(sampleDefinition('b', 'CLI tool'), { tags: ['cli'] });

    const result = await tool.execute({ tags: ['ai'] }, {} as any);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.workflows).toHaveLength(1);
    expect(parsed.workflows[0].name).toBe('a');
    expect(parsed.available_tags).toEqual([
      { name: 'ai', count: 1 },
      { name: 'cli', count: 1 },
    ]);
  });

  it('should filter by multiple tags (AND)', async () => {
    await service.createWorkflow(sampleDefinition('ai-eval'), { tags: ['ai', 'eval'] });
    await service.createWorkflow(sampleDefinition('ai-bot'), { tags: ['ai'] });
    await service.createWorkflow(sampleDefinition('cli-tool'), { tags: ['cli'] });

    const result = await tool.execute({ tags: ['ai', 'eval'] }, {} as any);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.workflows).toHaveLength(1);
    expect(parsed.workflows[0].name).toBe('ai-eval');
  });

  it('should search by keyword in name/description', async () => {
    await service.createWorkflow(sampleDefinition('a', 'AI evaluation pipeline'), { tags: ['ai'] });
    await service.createWorkflow(sampleDefinition('cli-bot'), { tags: ['cli'] });

    const result = await tool.execute({ keyword: 'ai' }, {} as any);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.workflows.length).toBeGreaterThanOrEqual(1);
    expect(parsed.keyword).toBe('ai');
  });

  it('should combine keyword + tag filter (AND)', async () => {
    await service.createWorkflow(sampleDefinition('ai-eval', 'AI evaluation'), { tags: ['ai', 'eval'] });
    await service.createWorkflow(sampleDefinition('ai-bot', 'AI chatbot'), { tags: ['ai'] });

    const result = await tool.execute({ keyword: 'ai', tags: ['eval'] }, {} as any);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.workflows).toHaveLength(1);
    expect(parsed.workflows[0].name).toBe('ai-eval');
  });
});