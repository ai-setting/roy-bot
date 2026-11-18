import { describe, it, expect, beforeEach } from "bun:test";
import { TagRepository, type TagInfo } from "./tag-repo";

/**
 * TagRepository Tests
 *
 * Verifies CRUD operations on the workflow_tags table:
 * - createTable (idempotent)
 * - upsertMany (insert new + increment existing)
 * - decrementMany (clamp at 0, never delete row)
 * - list (sorted by usage_count DESC, name ASC)
 * - get (single lookup)
 */

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
    CREATE TABLE IF NOT EXISTS workflows (
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
    CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
    CREATE INDEX IF NOT EXISTS idx_workflows_tags ON workflows(tags);
    CREATE INDEX IF NOT EXISTS idx_workflows_task_id ON workflows(task_id);
  `);
  return db;
}

describe("TagRepository", () => {
  let db: any;
  let repo: TagRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new TagRepository(db);
  });

  describe("createTable (static)", () => {
    it("should create workflow_tags table and indexes (idempotent)", () => {
      // First call should create
      TagRepository.createTable(db);

      // Verify table exists
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_tags'"
        )
        .all();
      expect(tables.length).toBe(1);

      // Verify column schema
      const cols = db.prepare("PRAGMA table_info(workflow_tags)").all() as Array<{
        name: string;
      }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("name");
      expect(colNames).toContain("usage_count");
      expect(colNames).toContain("created_at");
      expect(colNames).toContain("updated_at");

      // Second call should not throw (idempotent)
      expect(() => TagRepository.createTable(db)).not.toThrow();
    });

    it("should create index on usage_count", () => {
      TagRepository.createTable(db);
      const idxs = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workflow_tags_usage'"
        )
        .all();
      expect(idxs.length).toBe(1);
    });
  });

  describe("upsertMany", () => {
    it("should insert new tags with count=1", () => {
      TagRepository.createTable(db);
      repo.upsertMany(["ai", "bounty"]);

      const tags = repo.list();
      expect(tags.length).toBe(2);
      const aiTag = tags.find((t) => t.name === "ai");
      const bountyTag = tags.find((t) => t.name === "bounty");
      expect(aiTag?.usage_count).toBe(1);
      expect(bountyTag?.usage_count).toBe(1);
    });

    it("should increment count when tag already exists", () => {
      TagRepository.createTable(db);
      repo.upsertMany(["ai"]);
      repo.upsertMany(["ai"]);
      repo.upsertMany(["ai"]);

      const tags = repo.list();
      expect(tags.length).toBe(1);
      expect(tags[0]?.usage_count).toBe(3);
    });

    it("should handle mixed new + existing tags in one call", () => {
      TagRepository.createTable(db);
      repo.upsertMany(["ai", "cli"]);
      repo.upsertMany(["ai", "cli", "ml"]);

      const tags = repo.list();
      const counts = Object.fromEntries(tags.map((t) => [t.name, t.usage_count]));
      expect(counts.ai).toBe(2);
      expect(counts.cli).toBe(2);
      expect(counts.ml).toBe(1);
    });

    it("should ignore empty input", () => {
      TagRepository.createTable(db);
      repo.upsertMany([]);
      const tags = repo.list();
      expect(tags.length).toBe(0);
    });
  });

  describe("decrementMany", () => {
    it("should decrement count by 1 for existing tag", () => {
      TagRepository.createTable(db);
      repo.upsertMany(["ai"]);
      repo.upsertMany(["ai"]);
      // usage_count = 2 now

      repo.decrementMany(["ai"]);

      const tag = repo.get("ai");
      expect(tag?.usage_count).toBe(1);
    });

    it("should clamp at 0 (never go negative)", () => {
      TagRepository.createTable(db);
      repo.upsertMany(["ai"]);
      // usage_count = 1

      repo.decrementMany(["ai"]);
      repo.decrementMany(["ai"]); // try to go below 0
      repo.decrementMany(["ai"]);

      const tag = repo.get("ai");
      expect(tag?.usage_count).toBe(0);
    });

    it("should NOT delete row at count=0 (preserve history)", () => {
      TagRepository.createTable(db);
      repo.upsertMany(["ai"]);
      repo.decrementMany(["ai"]);
      repo.decrementMany(["ai"]);

      // Row should still exist
      const tag = repo.get("ai");
      expect(tag).toBeDefined();
      expect(tag?.usage_count).toBe(0);
    });

    it("should ignore non-existent tags silently", () => {
      TagRepository.createTable(db);
      // Should not throw
      expect(() => repo.decrementMany(["never-existed"])).not.toThrow();
    });
  });

  describe("list", () => {
    it("should return empty array when no tags", () => {
      TagRepository.createTable(db);
      const tags = repo.list();
      expect(tags).toEqual([]);
    });

    it("should sort by usage_count DESC, name ASC", () => {
      TagRepository.createTable(db);
      // Create with specific counts
      repo.upsertMany(["popular", "popular", "popular"]); // 3
      repo.upsertMany(["medium", "medium"]); // 2
      repo.upsertMany(["rare"]); // 1
      repo.upsertMany(["alpha"]); // 1
      repo.upsertMany(["zebra"]); // 1

      const tags = repo.list();
      const names = tags.map((t) => t.name);
      // First 3 by count: popular(3), medium(2), then among the 1s: alpha, rare, zebra
      expect(names[0]).toBe("popular");
      expect(names[1]).toBe("medium");
      // The 1s should be alphabetically ordered
      const oneCount = tags.filter((t) => t.usage_count === 1).map((t) => t.name);
      expect(oneCount).toEqual(["alpha", "rare", "zebra"]);
    });

    it("should return TagInfo shape with name + usage_count + timestamps", () => {
      TagRepository.createTable(db);
      repo.upsertMany(["ai"]);

      const tags = repo.list();
      expect(tags.length).toBe(1);
      const tag: TagInfo = tags[0]!;
      expect(tag.name).toBe("ai");
      expect(tag.usage_count).toBe(1);
      // v3: timestamps exposed
      expect(typeof tag.created_at).toBe("string");
      expect(typeof tag.updated_at).toBe("string");
      expect(Object.keys(tag).sort()).toEqual(
        ["created_at", "name", "updated_at", "usage_count"].sort()
      );
    });

    // v3: 排序选项
    describe("v3: sort/limit options", () => {
      beforeEach(() => {
        TagRepository.createTable(db);
        // Seed with varied counts + spaced-out timestamps
        repo.upsertMany(["popular", "popular", "popular"]); // 3
        repo.upsertMany(["medium", "medium"]); // 2
        repo.upsertMany(["alpha"]); // 1
        repo.upsertMany(["zebra"]); // 1
      });

      it("should sort by name ASC when sortBy=name, order=asc", () => {
        const tags = repo.list({ sortBy: "name", order: "asc" });
        const names = tags.map((t) => t.name);
        expect(names).toEqual(["alpha", "medium", "popular", "zebra"]);
      });

      it("should sort by name DESC when sortBy=name, order=desc", () => {
        const tags = repo.list({ sortBy: "name", order: "desc" });
        const names = tags.map((t) => t.name);
        expect(names).toEqual(["zebra", "popular", "medium", "alpha"]);
      });

      it("should sort by usage_count ASC when order=asc", () => {
        const tags = repo.list({ sortBy: "usage_count", order: "asc" });
        const counts = tags.map((t) => t.usage_count);
        // alphabetical tiebreaker on the 1s
        expect(counts).toEqual([1, 1, 2, 3]);
        const oneCount = tags.filter((t) => t.usage_count === 1).map((t) => t.name);
        expect(oneCount).toEqual(["alpha", "zebra"]);
      });

      it("should respect limit option", () => {
        const tags = repo.list({ sortBy: "usage_count", order: "desc", limit: 2 });
        expect(tags.length).toBe(2);
        expect(tags[0]?.name).toBe("popular");
        expect(tags[1]?.name).toBe("medium");
      });

      it("should default to usage_count DESC when no options provided (backward compat)", () => {
        const tags = repo.list();
        const names = tags.map((t) => t.name);
        expect(names[0]).toBe("popular");
        expect(names[1]).toBe("medium");
      });

      it("should not throw on unknown sortBy (fallback to usage_count)", () => {
        const tags = repo.list({ sortBy: "garbage" as any, order: "desc" });
        expect(tags.length).toBe(4);
        expect(tags[0]?.name).toBe("popular");
      });

      it("should return created_at/updated_at fields for sortBy=created_at", () => {
        // Insert with explicit timestamp (simulate creation order)
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO workflow_tags (name, usage_count, created_at, updated_at) VALUES (?, 0, ?, ?)"
        ).run("stale", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
        db.prepare(
          "INSERT INTO workflow_tags (name, usage_count, created_at, updated_at) VALUES (?, 0, ?, ?)"
        ).run("recent", now, now);

        const asc = repo.list({ sortBy: "created_at", order: "asc" });
        const ascNames = asc.map((t) => t.name);
        // stale comes before recent (asc)
        expect(ascNames.indexOf("stale")).toBeLessThan(ascNames.indexOf("recent"));

        const desc = repo.list({ sortBy: "created_at", order: "desc" });
        const descNames = desc.map((t) => t.name);
        expect(descNames.indexOf("recent")).toBeLessThan(descNames.indexOf("stale"));
      });
    });
  });

  describe("get", () => {
    it("should return undefined for non-existent tag", () => {
      TagRepository.createTable(db);
      const tag = repo.get("nope");
      expect(tag).toBeUndefined();
    });

    it("should return {name, usage_count, created_at, updated_at} for existing tag", () => {
      TagRepository.createTable(db);
      repo.upsertMany(["ai", "ai"]);

      const tag = repo.get("ai");
      expect(tag).toBeDefined();
      expect(tag?.name).toBe("ai");
      expect(tag?.usage_count).toBe(2);
      expect(typeof tag?.created_at).toBe("string");
      expect(typeof tag?.updated_at).toBe("string");
    });
  });

  describe("transaction safety", () => {
    it("should support being called inside an explicit transaction", () => {
      TagRepository.createTable(db);
      // bun:sqlite exposes db.transaction(fn) for transaction wrapper
      const tx = db.transaction((names: string[]) => {
        repo.upsertMany(names);
        repo.upsertMany(names);
        return repo.list();
      });
      const result = tx(["ai", "cli"]);
      // Each tag should have count = 2 (one per upsertMany call)
      const counts = Object.fromEntries(result.map((t) => [t.name, t.usage_count]));
      expect(counts.ai).toBe(2);
      expect(counts.cli).toBe(2);
    });
  });
});
