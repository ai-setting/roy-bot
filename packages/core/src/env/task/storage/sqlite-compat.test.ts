/**
 * Task #4619 — RED test: `createCompatibleDatabase` must expose a **runtime
 * independent** query API.
 *
 * ## The bug this pins
 *
 * `createCompatibleDatabase` exists to paper over the difference between
 * `bun:sqlite` and `better-sqlite3`:
 *
 * - `bun:sqlite`'s `Database` has `db.run(sql)` and `db.query(sql).all()`
 * - `better-sqlite3` has `db.exec(sql)`, `db.prepare(sql).all()` and **no**
 *   `run()` and **no** `query()`
 *
 * The compat shim added `run()` — but **not** `query()`. Migrations 004
 * (`004_rename_action_to_milestone.ts`) and 005
 * (`005_convert_blob_description_to_text.ts`) call `db.query(...)`, so under
 * **plain node** (where the runtime is `better-sqlite3`) they abort with:
 *
 * ```
 * [WARN] [Migration 004] Failed to run: db.query is not a function
 * [WARN] [Migration 005] Failed to run: db.query is not a function
 * ```
 *
 * The failure is **silent** (it is a `logger.warn` inside a `try/catch`), so
 * the store comes up with the *old* `action_*` column names and every
 * `milestone_*` read then fails.
 *
 * This matters for Task #4619 because the plugin's Claude-side MCP server
 * runs under **plain node** (it is a `.mjs` script with a `#!/usr/bin/env
 * node` shebang), and it is exactly the path that must read/write roy's real
 * task store.
 */

import { describe, expect, test } from "bun:test";
import { createCompatibleDatabase } from "./sqlite-task-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Task #4619: createCompatibleDatabase is runtime independent", () => {
  test("exposes a query() that works on every supported runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "roy-compat-"));
    try {
      const db = createCompatibleDatabase(join(dir, "probe.db"));
      try {
        expect(typeof db.query).toBe("function");
        db.run("CREATE TABLE t (a TEXT)");
        db.run("INSERT INTO t (a) VALUES ('hello')");
        const rows = db.query("SELECT a FROM t").all() as Array<{ a: string }>;
        expect(Array.isArray(rows)).toBe(true);
        expect(rows[0]?.a).toBe("hello");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("query().all() returns [] for an empty table (not undefined)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roy-compat-"));
    try {
      const db = createCompatibleDatabase(join(dir, "probe.db"));
      try {
        db.run("CREATE TABLE t (a TEXT)");
        const rows = db.query("SELECT a FROM t").all();
        expect(rows).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run() with parameters still works (the existing shim must not regress)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roy-compat-"));
    try {
      const db = createCompatibleDatabase(join(dir, "probe.db"));
      try {
        db.run("CREATE TABLE t (a TEXT)");
        db.run("INSERT INTO t (a) VALUES (?)", "x");
        const rows = db.query("SELECT a FROM t WHERE a = ?", "x").all() as Array<{ a: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].a).toBe("x");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
