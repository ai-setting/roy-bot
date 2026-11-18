/**
 * Workflow Add Tool Tests (v2)
 *
 * 覆盖 workflow_add tool 的校验逻辑：
 * - tags 缺失 / 超过 3 / 含空串 → 错误
 * - 1-3 tags 成功 + 自动 upsert tag 表
 * - 返回 available_tags
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

const sampleDefinition = (name: string): any => ({
  name,
  version: '1.0',
  description: 'Test workflow',
  nodes: [{ id: 'node1', type: 'tool', config: { tool: 'test-tool' } }],
});

describe('WorkflowAddTool', () => {
  let createWorkflowAddTool: any;
  let WorkflowService: any;
  let WorkflowRepository: any;
  let TagRepository: any;
  let db: any;
  let service: any;
  let tool: any;

  beforeEach(async () => {
    if (!createWorkflowAddTool) {
      const mod = await import('./workflow-add-tool');
      createWorkflowAddTool = mod.createWorkflowAddTool;
      WorkflowService = (await import('../service/workflow-service')).WorkflowService;
      WorkflowRepository = (await import('../storage/workflow-repo')).WorkflowRepository;
      TagRepository = (await import('../storage/tag-repo')).TagRepository;
    }
    db = createTestDatabase();
    const workflowRepo = new WorkflowRepository(db);
    const tagRepo = new TagRepository(db);
    service = new WorkflowService(workflowRepo, () => ({} as any), undefined, tagRepo);
    tool = createWorkflowAddTool(service);
  });

  // ============== 校验失败路径 ==============

  describe('validation failures', () => {
    it('should fail when tags is missing', async () => {
      const result = await tool.execute(
        { name: 'w1', definition: sampleDefinition('w1') },
        {} as any
      );
      expect(result.success).toBe(false);
      // Zod schema 拦截：tags 是 required
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/tags|Required|invalid_type/i);
    });

    it('should fail when tags array is empty', async () => {
      const result = await tool.execute(
        { name: 'w1', definition: sampleDefinition('w1'), tags: [] },
        {} as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/at least 1 tag/i);
    });

    it('should fail when more than 3 tags provided', async () => {
      const result = await tool.execute(
        { name: 'w1', definition: sampleDefinition('w1'), tags: ['a', 'b', 'c', 'd'] },
        {} as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/at most 3 tags/i);
    });

    it('should fail when a tag is empty string', async () => {
      const result = await tool.execute(
        { name: 'w1', definition: sampleDefinition('w1'), tags: ['ai', ''] },
        {} as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/empty/i);
    });

    it('should fail when definition, definition_yaml, and name are all missing', async () => {
      const result = await tool.execute(
        { tags: ['ai'] },
        {} as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/definition|name|required/i);
    });
  });

  // ============== 成功路径 ==============

  describe('success paths', () => {
    it('should create workflow with 1 tag and return available_tags', async () => {
      const result = await tool.execute(
        { name: 'w1', definition: sampleDefinition('w1'), tags: ['ai'] },
        {} as any
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.workflow.name).toBe('w1');
      expect(parsed.workflow.tags).toEqual(['ai']);
      expect(parsed.available_tags).toEqual([{ name: 'ai', count: 1 }]);
    });

    it('should create workflow with 3 tags and accumulate counts', async () => {
      await tool.execute(
        { name: 'w1', definition: sampleDefinition('w1'), tags: ['ai', 'ml', 'eval'] },
        {} as any
      );
      const result = await tool.execute(
        { name: 'w2', definition: sampleDefinition('w2'), tags: ['ai', 'cli'] },
        {} as any
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      // ai=2, cli=1, eval=1, ml=1
      const tagsByName = Object.fromEntries(parsed.available_tags.map((t: any) => [t.name, t.count]));
      expect(tagsByName).toEqual({ ai: 2, cli: 1, eval: 1, ml: 1 });
    });

    it('should accept definition_yaml and parse it', async () => {
      const yaml = `
name: w1
version: 1.0
description: from yaml
nodes:
  - id: n1
    type: tool
    config:
      tool: t
`;
      const result = await tool.execute(
        { name: 'w1', definition_yaml: yaml, tags: ['yaml'] },
        {} as any
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.workflow.tags).toEqual(['yaml']);
    });
  });

  // ============== DAG validation (v3, follow-up of #1511) ==============

  describe('DAG validation (refuses to create invalid workflows)', () => {
    it('should return success=false when definition has duplicate node IDs (and not pollute DB)', async () => {
      const result = await tool.execute(
        {
          name: 'invalid-dup',
          definition: {
            name: 'invalid-dup',
            version: '1.0',
            nodes: [
              { id: 'a', type: 'tool', config: { tool: 't' } },
              { id: 'a', type: 'tool', config: { tool: 't' } },
            ],
          },
          tags: ['ai'],
        },
        {} as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/[Dd]uplicate/);
    });

    it('should return success=false when definition references a non-existent node dep (and not pollute DB)', async () => {
      const result = await tool.execute(
        {
          name: 'invalid-missing-dep',
          definition: {
            name: 'invalid-missing-dep',
            version: '1.0',
            nodes: [
              { id: 'a', type: 'tool', config: { tool: 't' }, depends_on: ['ghost'] },
            ],
          },
          tags: ['ai'],
        },
        {} as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/[Gg]host|non-existent/);
    });

    it('should accept a valid 2-node linear workflow (positive control)', async () => {
      const result = await tool.execute(
        {
          name: 'valid-linear',
          definition: {
            name: 'valid-linear',
            version: '1.0',
            nodes: [
              { id: 'first', type: 'tool', config: { tool: 't' } },
              { id: 'second', type: 'tool', config: { tool: 't' }, depends_on: ['first'] },
            ],
          },
          tags: ['ai'],
        },
        {} as any
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.workflow.name).toBe('valid-linear');
    });
  });
});