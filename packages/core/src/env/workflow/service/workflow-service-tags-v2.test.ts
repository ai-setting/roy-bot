/**
 * WorkflowService Tags Integration Tests (v2)
 *
 * 覆盖 v2 核心：
 * - createWorkflow 调用 tagRepository.upsertMany
 * - deleteWorkflow 调用 tagRepository.decrementMany
 * - listWorkflowsWithTags() 返回 { workflows, available_tags, total }
 * - searchWorkflowsWithTags() 返回 { workflows, available_tags, total, keyword, tags }
 * - available_tags 按 usage_count DESC, name ASC 排序
 * - 事务边界（force update / tag upsert 失败时回滚）
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
    CREATE INDEX idx_workflows_name ON workflows(name);

    CREATE TABLE workflow_tags (
      name TEXT PRIMARY KEY,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_workflow_tags_usage ON workflow_tags(usage_count DESC);
  `);

  return db;
}

const sampleDefinition = (name: string): any => ({
  name,
  version: '1.0',
  description: `Workflow ${name}`,
  nodes: [{ id: 'node1', type: 'tool', config: { tool: 'test-tool' } }],
});

describe('WorkflowService Tags Integration (v2)', () => {
  let WorkflowService: any;
  let WorkflowRepository: any;
  let TagRepository: any;
  let db: any;
  let workflowRepo: any;
  let tagRepo: any;
  let service: any;

  beforeEach(async () => {
    if (!WorkflowService) {
      WorkflowService = (await import('./workflow-service')).WorkflowService;
      WorkflowRepository = (await import('../storage/workflow-repo')).WorkflowRepository;
      TagRepository = (await import('../storage/tag-repo')).TagRepository;
    }
    db = createTestDatabase();
    workflowRepo = new WorkflowRepository(db);
    tagRepo = new TagRepository(db);
    service = new WorkflowService(workflowRepo, () => ({} as any), undefined, tagRepo);
  });

  describe('createWorkflow + tag table maintenance', () => {
    it('should upsert tag when creating a new workflow', async () => {
      await service.createWorkflow(sampleDefinition('ai-flow'), { tags: ['ai'] });

      expect(tagRepo.get('ai')).toMatchObject({ name: 'ai', usage_count: 1 });
    });

    it('should accumulate usage_count across multiple workflows', async () => {
      await service.createWorkflow(sampleDefinition('w1'), { tags: ['ai', 'ml'] });
      await service.createWorkflow(sampleDefinition('w2'), { tags: ['ai'] });
      await service.createWorkflow(sampleDefinition('w3'), { tags: ['ai', 'eval'] });

      expect(tagRepo.get('ai').usage_count).toBe(3);
      expect(tagRepo.get('ml').usage_count).toBe(1);
      expect(tagRepo.get('eval').usage_count).toBe(1);
    });

    it('should not throw when tagRepository is not injected', async () => {
      const bareService = new WorkflowService(workflowRepo, () => ({} as any));
      const wf = await bareService.createWorkflow(sampleDefinition('x'), { tags: ['ai'] });
      expect(wf).toBeDefined();
    });
  });

  describe('deleteWorkflow + tag table maintenance', () => {
    it('should decrement usage_count when deleting a workflow', async () => {
      const w1 = await service.createWorkflow(sampleDefinition('w1'), { tags: ['ai', 'ml'] });
      await service.createWorkflow(sampleDefinition('w2'), { tags: ['ai'] });
      expect(tagRepo.get('ai').usage_count).toBe(2);
      expect(tagRepo.get('ml').usage_count).toBe(1);

      await service.deleteWorkflow(w1.id);

      expect(tagRepo.get('ai').usage_count).toBe(1);
      expect(tagRepo.get('ml').usage_count).toBe(0);
    });

    it('should return false when deleting a non-existent workflow', async () => {
      const result = await service.deleteWorkflow('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('listWorkflowsWithTags', () => {
    it('should return workflows + available_tags sorted by count DESC', async () => {
      await service.createWorkflow(sampleDefinition('a'), { tags: ['ai', 'ml'] });
      await service.createWorkflow(sampleDefinition('b'), { tags: ['ai'] });
      await service.createWorkflow(sampleDefinition('c'), { tags: ['cli'] });

      const result = await service.listWorkflowsWithTags();

      expect(result.workflows).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.available_tags).toEqual([
        { name: 'ai', count: 2 },
        { name: 'cli', count: 1 },
        { name: 'ml', count: 1 },
      ]);
    });

    it('should return empty available_tags when no workflows exist', async () => {
      const result = await service.listWorkflowsWithTags();

      expect(result.workflows).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.available_tags).toEqual([]);
    });
  });

  describe('searchWorkflowsWithTags', () => {
    it('should return workflows matching keyword + tags + available_tags', async () => {
      await service.createWorkflow(
        { ...sampleDefinition('ai-eval'), description: 'AI evaluation pipeline' },
        { tags: ['ai', 'eval'] }
      );
      await service.createWorkflow(
        { ...sampleDefinition('ai-bot'), description: 'AI chatbot' },
        { tags: ['ai'] }
      );
      await service.createWorkflow(
        { ...sampleDefinition('cli-tool'), description: 'CLI helper' },
        { tags: ['cli'] }
      );

      const result = await service.searchWorkflowsWithTags({
        keyword: 'ai',
        tags: ['ai'],
      });

      expect(result.workflows.map((w: any) => w.name).sort()).toEqual(['ai-bot', 'ai-eval']);
      expect(result.total).toBe(2);
      expect(result.keyword).toBe('ai');
      expect(result.tags).toEqual(['ai']);
      expect(result.available_tags).toEqual([
        { name: 'ai', count: 2 },
        { name: 'cli', count: 1 },
        { name: 'eval', count: 1 },
      ]);
    });

    it('should support empty filter and return all workflows', async () => {
      await service.createWorkflow(sampleDefinition('a'), { tags: ['ai'] });
      await service.createWorkflow(sampleDefinition('b'), { tags: ['cli'] });

      const result = await service.searchWorkflowsWithTags({});

      expect(result.workflows).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.available_tags).toHaveLength(2);
    });
  });

  describe('transactional safety', () => {
    it('should roll back workflow insert if tag upsert fails', async () => {
      const failingTagRepo = {
        upsertMany: () => { throw new Error('simulated DB failure'); },
        decrementMany: () => {},
        list: () => [],
        get: () => undefined,
      };
      const failingService = new WorkflowService(workflowRepo, () => ({} as any), undefined, failingTagRepo);

      let threw = false;
      try {
        await failingService.createWorkflow(sampleDefinition('w1'), { tags: ['ai'] });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      expect(workflowRepo.list()).toEqual([]);
    });
  });

  describe('backward compatibility', () => {
    it('should not break existing listWorkflows (Workflow[] return type)', async () => {
      await service.createWorkflow(sampleDefinition('a'), { tags: ['ai'] });
      const list = service.listWorkflows();
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(1);
    });

    it('should not break existing searchWorkflows (Workflow[] return type)', async () => {
      await service.createWorkflow(sampleDefinition('a'), { tags: ['ai'] });
      const results = service.searchWorkflows({ keyword: 'a' });
      expect(Array.isArray(results)).toBe(true);
    });
  });
});