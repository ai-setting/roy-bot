import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { randomUUID } from 'crypto';
import type { Workflow, WorkflowDefinition } from '../types';
import { migrateEmptyTagsToDefault } from './workflow-repo';

/**
 * WorkflowRepository Tests
 * 
 * Tests CRUD operations for workflows in SQLite.
 * 
 * 根据运行环境自动选择 SQLite 实现：
 * - Bun 运行时：使用 bun:sqlite
 * - Node.js/Electron：使用 better-sqlite3
 */

// ============================================================================
// SQLite Runtime Detection
// ============================================================================

function getDatabaseClass(): new (path: string) => any {
  // @ts-ignore - Bun global
  if (typeof Bun !== 'undefined') {
    // Bun 运行时使用 bun:sqlite
    const { Database } = require("bun:sqlite");
    return Database;
  } else {
    // Node.js/Electron 使用 better-sqlite3
    return require("better-sqlite3");
  }
}

/**
 * 创建兼容的 Database 实例
 * 
 * bun:sqlite 和 better-sqlite3 的 API 略有不同：
 * - bun:sqlite 有 db.run() 方法
 * - better-sqlite3 没有 db.run()，需要用 db.exec() 或 db.prepare().run()
 * 
 * 此函数确保两种实现都有 run() 方法
 */
function createCompatibleDatabase(path: string): any {
  const Database = getDatabaseClass();
  const db = new Database(path);
  
  // 如果 better-sqlite3，添加 run() 兼容方法
  if (typeof db.run !== 'function') {
    db.run = function(sql: string, ...params: any[]) {
      if (params.length > 0) {
        return this.prepare(sql).run(...params);
      } else {
        return this.exec(sql);
      }
    };
  }
  
  return db;
}

// Helper to create in-memory database
function createTestDatabase() {
  const db = createCompatibleDatabase(":memory:");
  
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0',
      description TEXT,
      definition TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      task_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_tags ON workflows(tags)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_task_id ON workflows(task_id)`);
  
  return db;
}

interface WorkflowRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  definition: string;
  config: string;
  metadata: string;
  tags: string;
  task_id: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Row to Workflow conversion helper
 */
function rowToWorkflow(row: WorkflowRow): Workflow {
  const metadata = JSON.parse(row.metadata);
  // Merge task_id from column into metadata
  if (row.task_id !== null) {
    metadata.taskId = row.task_id;
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description || undefined,
    definition: JSON.parse(row.definition),
    config: JSON.parse(row.config),
    metadata,
    tags: JSON.parse(row.tags),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

describe('WorkflowRepository', () => {
  let db: any;
  
  beforeEach(() => {
    db = createTestDatabase();
  });
  
  describe('create', () => {
    it('should create a new workflow', () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'TestWorkflow',
        version: '1.0',
        description: 'A test workflow',
        nodes: [
          { id: 'node1', type: 'llm' }
        ],
      };
      
      const stmt = db.prepare(`
        INSERT INTO workflows (id, name, version, description, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        id,
        definition.name,
        definition.version,
        definition.description || null,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow;
      const workflow = rowToWorkflow(row);
      
      expect(workflow.id).toBe(id);
      expect(workflow.name).toBe('TestWorkflow');
      expect(workflow.version).toBe('1.0');
      expect(workflow.definition.nodes).toHaveLength(1);
    });
    
    it('should set timestamps correctly', () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'TestWorkflow',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow;
      
      expect(row.created_at).toBe(now);
      expect(row.updated_at).toBe(now);
    });
  });
  
  describe('getById', () => {
    it('should retrieve a workflow by id', () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'TestWorkflow',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | undefined;
      expect(row).toBeDefined();
      
      const workflow = rowToWorkflow(row!);
      expect(workflow.id).toBe(id);
      expect(workflow.name).toBe('TestWorkflow');
    });
    
    it('should return undefined for non-existent id', () => {
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get('non-existent') as WorkflowRow | null | undefined;
      expect(row).toBeNull();
    });
  });
  
  describe('getByName', () => {
    it('should retrieve a workflow by name', () => {
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'MyWorkflow',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      const row = db.prepare("SELECT * FROM workflows WHERE name = ? ORDER BY updated_at DESC LIMIT 1").get('MyWorkflow') as WorkflowRow | undefined;
      expect(row).toBeDefined();
      
      const workflow = rowToWorkflow(row!);
      expect(workflow.name).toBe('MyWorkflow');
    });
    
    it('should return latest version when multiple versions exist', () => {
      const now = new Date().toISOString();
      const definition1: WorkflowDefinition = {
        name: 'MultiVersion',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      const definition2: WorkflowDefinition = {
        name: 'MultiVersion',
        version: '2.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      // Insert version 1.0
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        definition1.name,
        definition1.version,
        JSON.stringify(definition1),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      // Insert version 2.0 (updated later)
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        definition2.name,
        definition2.version,
        JSON.stringify(definition2),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        new Date(Date.now() + 1000).toISOString() // Updated later
      );
      
      const row = db.prepare("SELECT * FROM workflows WHERE name = ? ORDER BY updated_at DESC LIMIT 1").get('MultiVersion') as WorkflowRow | undefined;
      expect(row).toBeDefined();
      
      const workflow = rowToWorkflow(row!);
      expect(workflow.version).toBe('2.0');
    });
  });
  
  describe('list', () => {
    it('should list all workflows', () => {
      const now = new Date().toISOString();
      
      // Create multiple workflows
      for (let i = 0; i < 3; i++) {
        const definition: WorkflowDefinition = {
          name: `Workflow${i}`,
          version: '1.0',
          nodes: [{ id: 'node1', type: 'llm' }],
        };
        
        db.prepare(`
          INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          definition.name,
          definition.version,
          JSON.stringify(definition),
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify([]),
          now,
          now
        );
      }
      
      const rows = db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC").all() as WorkflowRow[];
      expect(rows).toHaveLength(3);
    });
    
    it('should support pagination', () => {
      const now = new Date().toISOString();
      
      // Create 5 workflows
      for (let i = 0; i < 5; i++) {
        const definition: WorkflowDefinition = {
          name: `Workflow${i}`,
          version: '1.0',
          nodes: [{ id: 'node1', type: 'llm' }],
        };
        
        db.prepare(`
          INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          definition.name,
          definition.version,
          JSON.stringify(definition),
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify([]),
          now,
          now
        );
      }
      
      const rows = db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC LIMIT 2 OFFSET 1").all() as WorkflowRow[];
      expect(rows).toHaveLength(2);
    });
    
    it('should filter by tags', () => {
      const now = new Date().toISOString();
      
      // Create workflow with tag
      const definition: WorkflowDefinition = {
        name: 'TaggedWorkflow',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify(['test', 'workflow']),
        now,
        now
      );
      
      // Query using LIKE for tag search (stored as JSON array)
      const rows = db.prepare("SELECT * FROM workflows WHERE tags LIKE ?").all('%test%') as WorkflowRow[];
      expect(rows).toHaveLength(1);
      expect(rowToWorkflow(rows[0]).tags).toContain('test');
    });
  });
  
  describe('update', () => {
    it('should update a workflow', () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'Original',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      // Update the workflow
      const updatedNow = new Date().toISOString();
      const updatedDefinition: WorkflowDefinition = {
        ...definition,
        name: 'Updated',
      };
      
      db.prepare(`
        UPDATE workflows 
        SET name = ?, definition = ?, updated_at = ?
        WHERE id = ?
      `).run(
        updatedDefinition.name,
        JSON.stringify(updatedDefinition),
        updatedNow,
        id
      );
      
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow;
      const workflow = rowToWorkflow(row);
      
      expect(workflow.name).toBe('Updated');
      expect(workflow.updatedAt).toEqual(new Date(updatedNow));
    });
    
    it('should update only specific fields', () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'TestWorkflow',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      // Update only tags
      db.prepare(`
        UPDATE workflows 
        SET tags = ?, updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(['new-tag']),
        new Date().toISOString(),
        id
      );
      
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow;
      const workflow = rowToWorkflow(row);
      
      expect(workflow.name).toBe('TestWorkflow'); // Unchanged
      expect(workflow.tags).toContain('new-tag');
    });
  });
  
  describe('delete', () => {
    it('should delete a workflow', () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'ToDelete',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      // Delete the workflow
      db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
      
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
      expect(row).toBeNull();
    });
    
    it('should not affect other workflows when deleting one', () => {
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'Test',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      const id1 = randomUUID();
      const id2 = randomUUID();
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id1, definition.name, definition.version, JSON.stringify(definition), JSON.stringify({}), JSON.stringify({}), JSON.stringify([]), now, now);
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id2, definition.name, definition.version, JSON.stringify(definition), JSON.stringify({}), JSON.stringify({}), JSON.stringify([]), now, now);
      
      // Delete one
      db.prepare("DELETE FROM workflows WHERE id = ?").run(id1);
      
      const rows = db.prepare("SELECT * FROM workflows").all();
      expect(rows).toHaveLength(1);
      expect((rows[0] as WorkflowRow).id).toBe(id2);
    });
  });
  
  describe('exists', () => {
    it('should return true for existing workflow', () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'Exists',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      const count = db.prepare("SELECT COUNT(*) as count FROM workflows WHERE id = ?").get(id) as { count: number };
      expect(count.count).toBeGreaterThan(0);
    });
    
    it('should return false for non-existing workflow', () => {
      const count = db.prepare("SELECT COUNT(*) as count FROM workflows WHERE id = ?").get('non-existent') as { count: number };
      expect(count.count).toBe(0);
    });
  });
  
  describe('list() with taskId filter', () => {
    it('should filter workflows by taskId', () => {
      const now = new Date().toISOString();
      
      // Create workflows with different taskIds
      const definition: WorkflowDefinition = {
        name: 'Workflow1',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      // Insert with task_id = 1
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, task_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        1,
        now,
        now
      );
      
      // Insert with task_id = 2
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, task_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        'Workflow2',
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        2,
        now,
        now
      );
      
      // Query with task_id = 1
      const rows = db.prepare("SELECT * FROM workflows WHERE task_id = ?").all(1) as WorkflowRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Workflow1');
    });
  });
  
  describe('list() with search', () => {
    it('should search in description', () => {
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'Workflow1',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      // Create workflow with CI description
      db.prepare(`
        INSERT INTO workflows (id, name, version, description, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        definition.name,
        definition.version,
        'CI pipeline workflow',
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      // Create workflow with Data description
      db.prepare(`
        INSERT INTO workflows (id, name, version, description, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        'Workflow2',
        definition.version,
        'Data processing workflow',
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify([]),
        now,
        now
      );
      
      // Search in-memory for CI
      const allRows = db.prepare("SELECT * FROM workflows").all() as WorkflowRow[];
      const workflows = allRows.map(rowToWorkflow);
      const ciWorkflows = workflows.filter(w => w.description?.toLowerCase().includes('ci'));
      
      expect(ciWorkflows).toHaveLength(1);
      expect(ciWorkflows[0].description).toContain('CI');
    });
    
    it('should search in tags', () => {
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'TaggedWorkflow',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify(['ci', 'deploy']),
        now,
        now
      );
      
      // Search in-memory for 'ci' tag
      const allRows = db.prepare("SELECT * FROM workflows").all() as WorkflowRow[];
      const workflows = allRows.map(rowToWorkflow);
      const ciWorkflows = workflows.filter(w => w.tags.some(tag => tag.toLowerCase().includes('ci')));
      
      expect(ciWorkflows).toHaveLength(1);
      expect(ciWorkflows[0].tags).toContain('ci');
    });
  });
  
  describe('list() with combined filters', () => {
    it('should combine taskId + tag + search', () => {
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'Workflow1',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      
      // Create workflow 1: taskId=1, tag=ci, description=Build
      db.prepare(`
        INSERT INTO workflows (id, name, version, description, definition, config, metadata, tags, task_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        definition.name,
        definition.version,
        'Build workflow',
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify(['ci']),
        1,
        now,
        now
      );
      
      // Create workflow 2: taskId=1, tag=ci, description=Deploy
      db.prepare(`
        INSERT INTO workflows (id, name, version, description, definition, config, metadata, tags, task_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        'Workflow2',
        definition.version,
        'Deploy workflow',
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify(['ci']),
        1,
        now,
        now
      );
      
      // Create workflow 3: taskId=2, tag=ci, description=Test
      db.prepare(`
        INSERT INTO workflows (id, name, version, description, definition, config, metadata, tags, task_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        'Workflow3',
        definition.version,
        'Test workflow',
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify(['ci']),
        2,
        now,
        now
      );
      
      // Query: taskId=1 AND tag=ci AND search=build
      let rows = db.prepare("SELECT * FROM workflows WHERE task_id = ?").all(1) as WorkflowRow[];
      let workflows = rows.map(rowToWorkflow);
      
      // Filter by tag
      workflows = workflows.filter(w => w.tags.includes('ci'));
      
      // Filter by search
      workflows = workflows.filter(w => w.description?.toLowerCase().includes('build'));
      
      expect(workflows).toHaveLength(1);
      expect(workflows[0].metadata.taskId).toBe(1);
      expect(workflows[0].tags).toContain('ci');
      expect(workflows[0].description).toContain('Build');
    });
  });

  // ============================================================================
  // v4: countAll - 拿过滤后的真实总数（不应用 limit/offset）
  // ============================================================================
  describe('countAll', () => {
    it('should return total count of all workflows when no options provided', () => {
      const now = new Date().toISOString();
      for (let i = 0; i < 5; i++) {
        const definition: WorkflowDefinition = {
          name: `Workflow${i}`,
          version: '1.0',
          nodes: [{ id: 'node1', type: 'llm' }],
        };
        db.prepare(`
          INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          definition.name,
          definition.version,
          JSON.stringify(definition),
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify(['ai']),
          now,
          now
        );
      }

      const repo = new (require('./workflow-repo').WorkflowRepository)(db);
      expect(repo.countAll()).toBe(5);
    });

    it('should return filtered count when tag option is provided', () => {
      const now = new Date().toISOString();
      // 3 个带 'ci-cd' tag
      for (let i = 0; i < 3; i++) {
        const definition: WorkflowDefinition = {
          name: `CiCdWorkflow${i}`,
          version: '1.0',
          nodes: [{ id: 'node1', type: 'llm' }],
        };
        db.prepare(`
          INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          definition.name,
          definition.version,
          JSON.stringify(definition),
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify(['ci-cd', 'build-publish']),
          now,
          now
        );
      }
      // 2 个不带 ci-cd
      for (let i = 0; i < 2; i++) {
        const definition: WorkflowDefinition = {
          name: `OtherWorkflow${i}`,
          version: '1.0',
          nodes: [{ id: 'node1', type: 'llm' }],
        };
        db.prepare(`
          INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          definition.name,
          definition.version,
          JSON.stringify(definition),
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify(['test']),
          now,
          now
        );
      }

      const repo = new (require('./workflow-repo').WorkflowRepository)(db);
      expect(repo.countAll({ tag: 'ci-cd' })).toBe(3);
      expect(repo.countAll({ tag: 'test' })).toBe(2);
      expect(repo.countAll()).toBe(5);
    });

    it('should return filtered count when taskId option is provided', () => {
      const now = new Date().toISOString();
      // 2 个 task_id=42
      for (let i = 0; i < 2; i++) {
        const definition: WorkflowDefinition = {
          name: `TaskFlow${i}`,
          version: '1.0',
          nodes: [{ id: 'node1', type: 'llm' }],
        };
        db.prepare(`
          INSERT INTO workflows (id, name, version, definition, config, metadata, tags, task_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          definition.name,
          definition.version,
          JSON.stringify(definition),
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify(['ai']),
          42,
          now,
          now
        );
      }
      // 3 个无 task_id
      for (let i = 0; i < 3; i++) {
        const definition: WorkflowDefinition = {
          name: `UnboundFlow${i}`,
          version: '1.0',
          nodes: [{ id: 'node1', type: 'llm' }],
        };
        db.prepare(`
          INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          definition.name,
          definition.version,
          JSON.stringify(definition),
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify(['ai']),
          now,
          now
        );
      }

      const repo = new (require('./workflow-repo').WorkflowRepository)(db);
      expect(repo.countAll({ taskId: 42 })).toBe(2);
      expect(repo.countAll({ taskId: 999 })).toBe(0);
      expect(repo.countAll()).toBe(5);
    });

    it('should return 0 when no workflows match the filter', () => {
      const now = new Date().toISOString();
      const definition: WorkflowDefinition = {
        name: 'SoloWorkflow',
        version: '1.0',
        nodes: [{ id: 'node1', type: 'llm' }],
      };
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        definition.name,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify(['ai']),
        now,
        now
      );

      const repo = new (require('./workflow-repo').WorkflowRepository)(db);
      expect(repo.countAll({ tag: 'nonexistent' })).toBe(0);
    });

    it('should NOT apply limit/offset (returns full filtered total)', () => {
      const now = new Date().toISOString();
      for (let i = 0; i < 10; i++) {
        const definition: WorkflowDefinition = {
          name: `Flow${i}`,
          version: '1.0',
          nodes: [{ id: 'node1', type: 'llm' }],
        };
        db.prepare(`
          INSERT INTO workflows (id, name, version, definition, config, metadata, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          definition.name,
          definition.version,
          JSON.stringify(definition),
          JSON.stringify({}),
          JSON.stringify({}),
          JSON.stringify(['ci-cd']),
          now,
          now
        );
      }

      const repo = new (require('./workflow-repo').WorkflowRepository)(db);
      // 即使给 limit=2，也应该返回 10
      expect(repo.countAll({ tag: 'ci-cd', limit: 2, offset: 5 })).toBe(10);
    });
  });
});

// ============================================================================
// Migration: empty tags → ["default"]
// ============================================================================

describe('migrateEmptyTagsToDefault', () => {
  let db: any;
  let originalNow: () => string;
  let fixedNow: string;

  beforeEach(() => {
    db = createTestDatabase();
    fixedNow = '2026-01-01T00:00:00.000Z';
    originalNow = Date.prototype.toISOString;
    // Pin time so updated_at assertions are deterministic
    Date.prototype.toISOString = function () {
      return fixedNow;
    };
  });

  afterEach(() => {
    Date.prototype.toISOString = originalNow;
  });

  function insertWorkflow(id: string, tagsJson: string): void {
    const definition: WorkflowDefinition = {
      name: `wf-${id}`,
      version: '1.0',
      nodes: [{ id: 'n1', type: 'llm' }],
    };
    db.prepare(`
      INSERT INTO workflows (id, name, version, description, definition, config, metadata, tags, task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      definition.name,
      definition.version,
      null,
      JSON.stringify(definition),
      JSON.stringify({}),
      JSON.stringify({}),
      tagsJson,
      null,
      fixedNow,
      fixedNow
    );
  }

  function getTagsJson(id: string): string {
    const row = db.prepare('SELECT tags FROM workflows WHERE id = ?').get(id) as { tags: string };
    return row.tags;
  }

  it('Test 1: returns N and updates rows whose tags="[]" or "" empty string to ["default"]', () => {
    // Arrange: 3 empty rows + 2 already-tagged rows (must remain untouched)
    insertWorkflow('a-1', '[]');
    insertWorkflow('a-2', '[]');
    insertWorkflow('a-3', '');
    insertWorkflow('b-1', '["ci"]');
    insertWorkflow('b-2', '["ai","bounty"]');

    // Act
    const migrated = migrateEmptyTagsToDefault(db);

    // Assert: return value
    expect(migrated).toBe(3);

    // Assert: empty rows are now ["default"]
    expect(getTagsJson('a-1')).toBe('["default"]');
    expect(getTagsJson('a-2')).toBe('["default"]');
    expect(getTagsJson('a-3')).toBe('["default"]');

    // Assert: pre-tagged rows are NOT touched
    expect(getTagsJson('b-1')).toBe('["ci"]');
    expect(getTagsJson('b-2')).toBe('["ai","bounty"]');
  });

  it('Test 2: returns 0 when no rows need migration (nothing to update)', () => {
    // Arrange: only pre-tagged rows
    insertWorkflow('c-1', '["ai"]');
    insertWorkflow('c-2', '["bounty","cli"]');

    // Act
    const migrated = migrateEmptyTagsToDefault(db);

    // Assert
    expect(migrated).toBe(0);
    expect(getTagsJson('c-1')).toBe('["ai"]');
    expect(getTagsJson('c-2')).toBe('["bounty","cli"]');
  });

  it('Test 3: idempotent — running twice does NOT double-update', () => {
    // Arrange: 4 empty rows
    insertWorkflow('d-1', '[]');
    insertWorkflow('d-2', '[]');
    insertWorkflow('d-3', '');
    insertWorkflow('d-4', '[]');

    // Act: first migration
    const first = migrateEmptyTagsToDefault(db);
    // Act: second migration (no rows should match)
    const second = migrateEmptyTagsToDefault(db);

    // Assert: first reports 4, second reports 0
    expect(first).toBe(4);
    expect(second).toBe(0);

    // All rows still ["default"] (not ["default","default"] or anything else)
    expect(getTagsJson('d-1')).toBe('["default"]');
    expect(getTagsJson('d-2')).toBe('["default"]');
    expect(getTagsJson('d-3')).toBe('["default"]');
    expect(getTagsJson('d-4')).toBe('["default"]');
  });
});

// ============================================================================
// rowToWorkflow corruption safety (sibling-risk of Task #4036)
// ============================================================================
//
// 历史背景：Bug 修复 Task #4033 — 任务 [HTML 样式重构] v33 → v34 的 tags 字段
// 被存成 CSV 字符串导致裸 `JSON.parse` 抛错，整个 `tasks list` 命令挂掉。
// Task #4036 修复了 task-store。
//
// workflow-repo.ts:50-66 的 `rowToWorkflow` 一次性有 4 处裸 JSON.parse
// (metadata / definition / config / tags)，同样没有任何错误处理。
//
// 策略（按字段语义分流）：
//   - definition / metadata：业务关键，损坏时**抛错**（让上层知道数据坏了，
//     宁可在 ReportError 路径上挂掉也别返回 silent-corrupt 数据）
//   - config / tags：辅助字段，**graceful fallback**（config → {}，tags 复用
//     sqlite-task-store 的 parseTagsSafely 模式）
//
// 错误信息要明确指出是哪个字段 + 哪一行 row，方便排查。

import { rowToWorkflow as exportedRowToWorkflow } from './workflow-repo';
import type { WorkflowRow as ExportedWorkflowRow } from './workflow-repo';

function makeRow(overrides: Partial<ExportedWorkflowRow>): ExportedWorkflowRow {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'test-id',
    name: 'TestWorkflow',
    version: '1.0',
    description: null,
    definition: JSON.stringify({
      name: 'TestWorkflow',
      version: '1.0',
      nodes: [{ id: 'n1', type: 'llm' }],
    }),
    config: JSON.stringify({}),
    metadata: JSON.stringify({}),
    tags: JSON.stringify([]),
    task_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('rowToWorkflow corruption safety', () => {
  describe('happy path: all fields valid JSON', () => {
    it('should parse a fully valid row without modification', () => {
      const row = makeRow({
        tags: JSON.stringify(['ai', 'bounty']),
        metadata: JSON.stringify({ taskId: 42 }),
      });
      const wf = exportedRowToWorkflow(row);
      expect(wf.tags).toEqual(['ai', 'bounty']);
      expect(wf.metadata.taskId).toBe(42);
      expect(wf.definition.nodes).toHaveLength(1);
      expect(wf.config).toEqual({});
    });

    it('should merge task_id column into metadata', () => {
      const row = makeRow({
        task_id: 100,
        metadata: JSON.stringify({ foo: 'bar' }),
      });
      const wf = exportedRowToWorkflow(row);
      expect(wf.metadata).toEqual({ foo: 'bar', taskId: 100 });
    });
  });

  describe('definition / metadata: business-critical, throw on corruption', () => {
    it('should throw when metadata is corrupt JSON (e.g. CSV string)', () => {
      const row = makeRow({ metadata: 'author: alice, status: draft' });
      expect(() => exportedRowToWorkflow(row)).toThrow(/metadata/i);
    });

    it('should throw when definition is corrupt JSON', () => {
      const row = makeRow({ definition: 'name: TestWorkflow\nnodes: bad-json' });
      expect(() => exportedRowToWorkflow(row)).toThrow(/definition/i);
    });

    it('error message should include the row name to aid debugging', () => {
      const row = makeRow({ name: 'MyImportantWorkflow', metadata: 'not-json' });
      expect(() => exportedRowToWorkflow(row)).toThrow(/MyImportantWorkflow/);
    });

    it('error message should include the row id to aid debugging', () => {
      const row = makeRow({ id: 'wf-abc-123', metadata: 'not-json' });
      expect(() => exportedRowToWorkflow(row)).toThrow(/wf-abc-123/);
    });
  });

  describe('config / tags: auxiliary, graceful fallback', () => {
    it('should fallback config to {} when config is corrupt JSON', () => {
      const row = makeRow({ config: 'host: localhost, port: 5432' });
      const wf = exportedRowToWorkflow(row);
      expect(wf.config).toEqual({});
    });

    it('should fallback config to {} when config is empty string', () => {
      const row = makeRow({ config: '' });
      const wf = exportedRowToWorkflow(row);
      expect(wf.config).toEqual({});
    });

    it('should fallback tags to single-element [str] when tags is corrupt CSV-like string (same pattern as parseTagsSafely)', () => {
      // Mirrors Bug #4033: 'html-styling, css-refactor, v34, feishu, slides'
      const row = makeRow({ tags: 'html-styling, css-refactor, v34, feishu, slides' });
      const wf = exportedRowToWorkflow(row);
      expect(wf.tags).toEqual(['html-styling, css-refactor, v34, feishu, slides']);
    });

    it('should fallback tags to [] when tags is empty string', () => {
      const row = makeRow({ tags: '' });
      const wf = exportedRowToWorkflow(row);
      expect(wf.tags).toEqual([]);
    });

    it('should accept a single JSON string in tags as a single-element array (parseTagsSafely parity)', () => {
      // SQLite stores array, but legacy single-string from manual edit
      const row = makeRow({ tags: '"single-tag"' });
      const wf = exportedRowToWorkflow(row);
      expect(wf.tags).toEqual(['single-tag']);
    });
  });

  describe('combined: definition valid, metadata corrupt + tags corrupt — throw loud', () => {
    it('should throw on corrupt metadata even if definition+config are valid', () => {
      const row = makeRow({
        metadata: 'corrupt',
        tags: 'also-corrupt', // graceful fallback expected
      });
      expect(() => exportedRowToWorkflow(row)).toThrow(/metadata/i);
    });
  });
});
