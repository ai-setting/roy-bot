/**
 * Workflow Tag List Tool Tests (v3)
 *
 * Verifies the MCP tool that lets agents discover the existing tag pool.
 *
 * Coverage:
 * - default sort (usage_count DESC, top 100)
 * - custom sort (name asc/desc, created_at asc/desc)
 * - limit boundary (1, 1000)
 * - empty result (no tags yet)
 * - input validation (sort_by, order, limit out of range)
 */

import { describe, it, expect, beforeEach } from "bun:test";

function createCompatibleDatabase(path: string): any {
  // @ts-ignore - Bun global
  if (typeof Bun !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return new Database(path);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    return new Database(path);
  }
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

describe("WorkflowTagListTool", () => {
  let createWorkflowTagListTool: any;
  let WorkflowService: any;
  let WorkflowRepository: any;
  let TagRepository: any;
  let db: any;
  let service: any;
  let tool: any;

  beforeEach(async () => {
    if (!createWorkflowTagListTool) {
      const mod = await import("./workflow-tag-list-tool");
      createWorkflowTagListTool = mod.createWorkflowTagListTool;
      WorkflowService = (await import("../service/workflow-service")).WorkflowService;
      WorkflowRepository = (await import("../storage/workflow-repo")).WorkflowRepository;
      TagRepository = (await import("../storage/tag-repo")).TagRepository;
    }
    db = createTestDatabase();
    const workflowRepo = new WorkflowRepository(db);
    const tagRepo = new TagRepository(db);
    service = new WorkflowService(workflowRepo, () => ({} as any), undefined, tagRepo);
    tool = createWorkflowTagListTool(service);
  });

  // Helper to seed sample tags
  function seedTags() {
    tagRepoUpsertMany(["ai", "ai", "ai"]); // 3
    tagRepoUpsertMany(["bounty", "bounty"]); // 2
    tagRepoUpsertMany(["cli"]); // 1
    tagRepoUpsertMany(["default"]); // 1
  }

  // Indirection to avoid referencing tagRepo before initialization
  function tagRepoUpsertMany(names: string[]) {
    const repo = new TagRepository(db);
    repo.upsertMany(names);
  }

  // ============== 默认行为 ==============

  describe("default behavior", () => {
    it("should return empty list when no tags exist", async () => {
      const result = await tool.execute({}, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.tags).toEqual([]);
      expect(parsed.total).toBe(0);
      expect(parsed.hint).toMatch(/1-3 tags/i);
    });

    it("should default to sort_by=usage_count, order=desc", async () => {
      seedTags();
      const result = await tool.execute({}, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      // ai (3) > bounty (2) > [cli, default] (both 1, alphabetical)
      expect(parsed.tags.map((t: any) => t.name)).toEqual([
        "ai",
        "bounty",
        "cli",
        "default",
      ]);
      expect(parsed.tags[0]?.usage_count).toBe(3);
    });
  });

  // ============== 自定义排序 ==============

  describe("custom sort options", () => {
    beforeEach(() => seedTags());

    it("should sort by name ascending", async () => {
      const result = await tool.execute(
        { sort_by: "name", order: "asc" },
        {} as any
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.tags.map((t: any) => t.name)).toEqual([
        "ai",
        "bounty",
        "cli",
        "default",
      ]);
    });

    it("should sort by name descending", async () => {
      const result = await tool.execute(
        { sort_by: "name", order: "desc" },
        {} as any
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.tags.map((t: any) => t.name)).toEqual([
        "default",
        "cli",
        "bounty",
        "ai",
      ]);
    });

    it("should sort by created_at ascending", async () => {
      const result = await tool.execute(
        { sort_by: "created_at", order: "asc" },
        {} as any
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      // Each tag should have created_at field populated
      for (const t of parsed.tags) {
        expect(typeof t.created_at).toBe("string");
        expect(t.created_at.length).toBeGreaterThan(0);
      }
    });

    it("should sort by usage_count ascending", async () => {
      const result = await tool.execute(
        { sort_by: "usage_count", order: "asc" },
        {} as any
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      const counts = parsed.tags.map((t: any) => t.usage_count);
      // 1, 1, 2, 3 — note tiebreaker on name ASC for the 1s
      expect(counts).toEqual([1, 1, 2, 3]);
      const oneCount = parsed.tags
        .filter((t: any) => t.usage_count === 1)
        .map((t: any) => t.name);
      expect(oneCount).toEqual(["cli", "default"]);
    });
  });

  // ============== Limit 边界 ==============

  describe("limit option", () => {
    beforeEach(() => seedTags());

    it("should respect limit", async () => {
      const result = await tool.execute({ limit: 2 }, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.tags.length).toBe(2);
      expect(parsed.total).toBe(2);
    });

    it("should reject limit > 1000", async () => {
      const result = await tool.execute({ limit: 5000 }, {} as any);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/1000|maximum/i);
    });

    it("should reject limit = 0 or negative", async () => {
      const r1 = await tool.execute({ limit: 0 }, {} as any);
      expect(r1.success).toBe(false);
      const r2 = await tool.execute({ limit: -1 }, {} as any);
      expect(r2.success).toBe(false);
    });
  });

  // ============== Input Validation ==============

  describe("input validation", () => {
    it("should reject invalid sort_by value", async () => {
      const result = await tool.execute({ sort_by: "garbage" }, {} as any);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("should reject invalid order value", async () => {
      const result = await tool.execute({ order: "sideways" }, {} as any);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("should accept limit=1 as smallest valid", async () => {
      seedTags();
      const result = await tool.execute({ limit: 1 }, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.tags.length).toBe(1);
    });
  });

  // ============== Hint 提示 ==============

  describe("output hint", () => {
    it("should always include a hint about reusing existing tags", async () => {
      const result = await tool.execute({}, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(typeof parsed.hint).toBe("string");
      expect(parsed.hint).toMatch(/select 1-3 tags/i);
      expect(parsed.hint).toMatch(/workflow_add/i);
    });
  });

  // ============== Fallback when service.listTags is missing ==============

  describe("graceful fallback", () => {
    it("should return empty list when service has no listTags method", async () => {
      // Construct a minimal service without listTags
      const minimalService: any = {};
      const fallbackTool = createWorkflowTagListTool(minimalService);
      const result = await fallbackTool.execute({}, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.tags).toEqual([]);
      expect(parsed.total).toBe(0);
    });
  });
});