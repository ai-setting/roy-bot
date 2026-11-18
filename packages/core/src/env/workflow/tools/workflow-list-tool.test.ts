/**
 * Workflow List Tool Tests (v4)
 *
 * v2 已经把 `total` / `count` / `available_tags` 暴露在输出里，但 `total` 字段
 * 当时被实现为 "已返回数量"（workflows.length），与"过滤后全局总数"的语义不一致。
 * v4 修复：total 应是"过滤后总数"，与 limit/offset 无关。
 *
 * 覆盖：
 * - 默认参数返回所有 workflow，total === workflows.length
 * - `limit=N` 时，total > workflows.length (修复前是相等的，bug)
 * - `offset > 0` 时 total 仍是全局过滤后总数
 * - `tag: "ci-cd"` 过滤时 total = 匹配数
 * - `tags: ["a", "b"]` AND 过滤时 total = 匹配数
 * - `search: "ai"` 时 total = 匹配数
 * - `available_tags` 总是返回
 */

import { describe, it, expect, beforeEach } from "bun:test";

function createCompatibleDatabase(path: string): any {
  // @ts-ignore
  if (typeof Bun !== "undefined") {
    // @ts-ignore
    const { Database } = require("bun:sqlite");
    return new Database(path);
  } else {
    return require("better-sqlite3");
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
    CREATE INDEX idx_workflows_name ON workflows(name);
    CREATE INDEX idx_workflows_tags ON workflows(tags);

    CREATE TABLE workflow_tags (
      name TEXT PRIMARY KEY,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("WorkflowListTool", () => {
  let createWorkflowListTool: any;
  let WorkflowService: any;
  let WorkflowRepository: any;
  let TagRepository: any;
  let db: any;
  let service: any;
  let tool: any;

  beforeEach(async () => {
    if (!createWorkflowListTool) {
      const mod = await import("./workflow-list-tool");
      createWorkflowListTool = mod.createWorkflowListTool;
      WorkflowService = (await import("../service/workflow-service")).WorkflowService;
      WorkflowRepository = (await import("../storage/workflow-repo")).WorkflowRepository;
      TagRepository = (await import("../storage/tag-repo")).TagRepository;
    }
    db = createTestDatabase();
    const workflowRepo = new WorkflowRepository(db);
    const tagRepo = new TagRepository(db);
    service = new WorkflowService(workflowRepo, () => ({} as any), undefined, tagRepo);
    tool = createWorkflowListTool(service);
  });

  // Helper to seed workflows via the service so tags are properly tracked
  async function seedWorkflow(name: string, tags: string[], description = "test") {
    const definition = {
      name,
      version: "1.0",
      description,
      nodes: [{ id: "node1", type: "tool", config: { tool: "test-tool" } }],
    };
    return service.createWorkflow(definition, { tags });
  }

  // ==================== Total 字段正确性 (v4 核心修复) ====================

  describe("total field correctness (v4 bug fix)", () => {
    it("should return total = full count when no limit applied", async () => {
      await seedWorkflow("w1", ["ai"]);
      await seedWorkflow("w2", ["ci-cd"]);
      await seedWorkflow("w3", ["test"]);

      const result = await tool.execute({}, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.workflows).toHaveLength(3);
      expect(parsed.total).toBe(3); // ✅ 修复前也是 3 (workflows.length)
    });

    it("should return total = full count even when limit < total (v4 fix)", async () => {
      // 5 个 workflow
      for (let i = 1; i <= 5; i++) {
        await seedWorkflow(`w${i}`, ["ai"]);
      }

      const result = await tool.execute({ limit: 2 }, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.workflows).toHaveLength(2);  // limit 限制
      expect(parsed.count).toBe(2);
      // 🐛 修复前: total=2 (workflows.length)
      // ✅ 修复后: total=5 (过滤后全局总数)
      expect(parsed.total).toBe(5);
    });

    it("should return total = full count with offset and limit (v4 fix)", async () => {
      for (let i = 1; i <= 5; i++) {
        await seedWorkflow(`w${i}`, ["ai"]);
      }

      const result = await tool.execute({ limit: 2, offset: 2 }, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.workflows).toHaveLength(2);
      // 🐛 修复前: total=2 (workflows.length)
      // ✅ 修复后: total=5 (过滤后全局总数)
      expect(parsed.total).toBe(5);
      expect(parsed.count).toBe(2);
      expect(parsed.limit).toBe(2);
      expect(parsed.offset).toBe(2);
    });

    it("should return total = filtered count when tag filter applied", async () => {
      await seedWorkflow("a", ["ci-cd"]);
      await seedWorkflow("b", ["ci-cd"]);
      await seedWorkflow("c", ["test"]);

      const result = await tool.execute({ tag: "ci-cd" }, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.workflows).toHaveLength(2);
      // 🐛 修复前: total=2 (workflows.length)
      // ✅ 修复后: total=2 (过滤后总数，等于返回数)
      expect(parsed.total).toBe(2);
    });

    it("should return total = filtered count with tag + limit (v4 fix)", async () => {
      for (let i = 1; i <= 4; i++) await seedWorkflow(`c${i}`, ["ci-cd"]);
      await seedWorkflow("o1", ["test"]);

      const result = await tool.execute({ tag: "ci-cd", limit: 2 }, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.workflows).toHaveLength(2);
      // 🐛 修复前: total=2 (workflows.length)
      // ✅ 修复后: total=4 (过滤后全局总数)
      expect(parsed.total).toBe(4);
    });

    it("should return total = AND-filtered count for multi-tags", async () => {
      await seedWorkflow("ab1", ["ai", "build-publish"]);
      await seedWorkflow("ab2", ["ai", "build-publish"]);
      await seedWorkflow("a", ["ai"]);
      await seedWorkflow("b", ["build-publish"]);

      const result = await tool.execute(
        { tags: ["ai", "build-publish"] },
        {} as any
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.workflows).toHaveLength(2);
      expect(parsed.total).toBe(2);
    });

    it("should return total = search-matched count", async () => {
      await seedWorkflow("ai-pipeline", ["test"], "AI evaluation pipeline");
      await seedWorkflow("cli-tool", ["test"], "Command line helper");
      await seedWorkflow("ai-bot", ["test"], "AI chatbot");

      const result = await tool.execute({ search: "ai" }, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      // 修复前 bug 行为: total = workflows.length
      // 修复后: total = 过滤后总数
      // description 含 "AI" 的大小写不影响 (list 内做 case-insensitive)
      expect(parsed.total).toBeGreaterThanOrEqual(2);
    });
  });

  // ==================== available_tags 总是返回 ====================

  describe("available_tags field", () => {
    it("should return available_tags even when no workflows", async () => {
      const result = await tool.execute({}, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.available_tags).toEqual([]);
    });

    it("should return available_tags sorted by usage_count DESC", async () => {
      await seedWorkflow("w1", ["ai", "ci-cd"]);
      await seedWorkflow("w2", ["ai"]);
      await seedWorkflow("w3", ["test"]);

      const result = await tool.execute({}, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.available_tags[0]).toEqual({ name: "ai", count: 2 });
      expect(parsed.available_tags[1]).toEqual({ name: "ci-cd", count: 1 });
    });
  });

  // ==================== 输出结构 ====================

  describe("output structure", () => {
    it("should include count, limit, offset, available_tags, total", async () => {
      await seedWorkflow("w1", ["ai"]);
      const result = await tool.execute({ limit: 10, offset: 0 }, {} as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed).toHaveProperty("workflows");
      expect(parsed).toHaveProperty("count");
      expect(parsed).toHaveProperty("limit");
      expect(parsed).toHaveProperty("offset");
      expect(parsed).toHaveProperty("available_tags");
      expect(parsed).toHaveProperty("total");
    });
  });

  // ==================== JSON shape canonical order (Code Review #1479 follow-up) ====================
  //
  // Mirror of the regression tests added to list-tool.test.ts for task_list.
  // These tests verify the workflow_list tool path (MCP) produces the SAME
  // canonical shape as `workflow list --json` (CLI):
  //
  //   { total, count, truncated, limit, offset, page, available_tags, workflows }
  //
  // The CLI path (buildListWorkflowsJson) was fixed in #1479 but the tool
  // path was left untouched (cross-package change, this PR fixes it).

  describe("JSON shape canonical order (Code Review #1479 follow-up)", () => {
    it("should place `total` as the FIRST key in the raw JSON output (regression test for truncation bug)", async () => {
      // Seed 3 workflows so total > 0
      await seedWorkflow("w1", ["ai"]);
      await seedWorkflow("w2", ["ci-cd"]);
      await seedWorkflow("w3", ["test"]);

      const result = await tool.execute({}, {} as any);
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe("string");

      const raw = result.output as string;

      // The JSON object's literal first key MUST be "total" so that the
      // tail-truncation logic in tool-component.ts cannot strip it.
      // Match either single-line '{"total":' or formatted '{\n  "total":'.
      expect(/^\{\s*"total"\s*:/.test(raw)).toBe(true);

      // Sanity: still parseable JSON with the expected shape
      const data = JSON.parse(raw);
      expect(typeof data.total).toBe("number");
      expect(typeof data.count).toBe("number");
      expect(typeof data.truncated).toBe("boolean");
      expect(Array.isArray(data.workflows)).toBe(true);
    });

    it("should set `truncated: true` when total > count (pagination in effect)", async () => {
      for (let i = 1; i <= 5; i++) {
        await seedWorkflow(`w${i}`, ["ai"]);
      }

      const result = await tool.execute({ limit: 2, offset: 0 }, {} as any);
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);

      // total is the count of all matching rows BEFORE pagination
      expect(data.total).toBeGreaterThan(data.count);
      expect(data.count).toBe(2);
      expect(data.truncated).toBe(true);
    });

    it("should set `truncated: false` when total === count (no pagination truncation)", async () => {
      await seedWorkflow("solo", ["ai"]);

      const result = await tool.execute({ limit: 100, offset: 0 }, {} as any);
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);

      expect(data.total).toBe(data.count);
      expect(data.truncated).toBe(false);
    });

    it("should default `page` to 1 when not provided in args", async () => {
      await seedWorkflow("w1", ["ai"]);
      const result = await tool.execute({ limit: 10, offset: 0 }, {} as any);
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);

      // page is a new optional field — default to 1 when not passed
      expect(data.page).toBe(1);
    });

    it("should pass through `page` when provided in args", async () => {
      await seedWorkflow("w1", ["ai"]);
      const result = await tool.execute({ limit: 10, offset: 20, page: 3 }, {} as any);
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);

      expect(data.page).toBe(3);
    });

    it("Code Review fix #1: page 2 returns DIFFERENT items than page 1 (was previously identical)", async () => {
      // Use a unique tag so we filter to ONLY our seeded workflows.
      const uniqueTag = `fix1-${Date.now()}-${Math.random()}`;
      for (let i = 1; i <= 5; i++) {
        await seedWorkflow(`fix1-wf-${i}`, [uniqueTag]);
      }

      // Page 1
      const r1 = await tool.execute({ page: 1, limit: 2, tag: uniqueTag }, {} as any);
      const d1 = JSON.parse(r1.output as string);

      // Page 2 — the critical test
      const r2 = await tool.execute({ page: 2, limit: 2, tag: uniqueTag }, {} as any);
      const d2 = JSON.parse(r2.output as string);

      // Basic shape
      expect(d1.count).toBe(2);
      expect(d2.count).toBe(2);
      expect(d1.total).toBe(5);
      expect(d2.total).toBe(5);
      expect(d1.truncated).toBe(true);
      expect(d2.truncated).toBe(true);

      // CORE ASSERTION: page 2 items must NOT overlap with page 1 items.
      // (Before the fix, page 2 was identical to page 1 because offset
      // was always 0 — `page` was just echoed in the response.)
      const page1Names = new Set(d1.workflows.map((w: any) => w.name));
      const page2Names = d2.workflows.map((w: any) => w.name);
      for (const n of page2Names) {
        expect(page1Names.has(n)).toBe(false);
      }

      // Coverage: page 1 + page 2 = 4 unique items (out of 5 total).
      const allPageItems = [...page1Names, ...page2Names];
      expect(allPageItems.length).toBe(4);
    });



    it("should emit keys in canonical order [total, count, truncated, limit, offset, page, available_tags, workflows]", async () => {
      // Seed enough workflows so available_tags is non-empty and workflows is non-empty,
      // to ensure the literal key order assertion is meaningful.
      await seedWorkflow("w1", ["ai"]);
      await seedWorkflow("w2", ["ci-cd"]);

      const result = await tool.execute({ limit: 10, offset: 0 }, {} as any);
      expect(result.success).toBe(true);

      const data = JSON.parse(result.output as string);
      const keys = Object.keys(data);

      // Hard contract: tool path JSON shape MUST match CLI canonical order.
      expect(keys).toEqual([
        "total",
        "count",
        "truncated",
        "limit",
        "offset",
        "page",
        "available_tags",
        "workflows",
      ]);
    });
  });
});
