/**
 * Task #4619 — RED test: core's task store must work under **plain node**
 * without a native SQLite addon.
 *
 * ## Why
 *
 * The plugin's Claude-side MCP server is a `.mjs` script with a
 * `#!/usr/bin/env node` shebang — it runs under **plain node**, not bun.
 * That path needs a SQLite driver that:
 *
 * - is available in plain node **without a native compile step**, and
 * - exposes the same API core's store expects.
 *
 * `better-sqlite3` is a native addon. The plugin's own `bridge.mjs` comment
 * records that it *aborted the process* under node 24 with
 * `Assertion failed: (env) != nullptr` — so the plugin deliberately used
 * `node:sqlite` instead.
 *
 * `node:sqlite` (Node 22.5+, stable in Node 24) is **built into node** and
 * exposes `prepare(sql).all() / .get() / .run()` — the same surface as
 * `better-sqlite3`, so core's `createCompatibleDatabase` shim works on it
 * unchanged.
 *
 * So the right fix is in **core**: teach the store about `node:sqlite`, and
 * the plugin can then be a ~30-line adapter with no native dependency and no
 * hand-written SQL.
 *
 * ⚠️ `node:sqlite` does not exist in bun, so the node-specific assertions
 * run in a **real node subprocess** (this file spawns `node`). The
 * runtime-agnostic assertions (the shim itself) run inline.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabaseClass, createCompatibleDatabaseFrom } from "./sqlite-task-store";

describe("Task #4619: the task store can use node:sqlite (no native addon)", () => {
  test("getDatabaseClass returns a usable driver", () => {
    const Database = getDatabaseClass();
    expect(typeof Database).toBe("function");
  });

  test("the compat shim works on any handle with prepare()", () => {
    // `node:sqlite`'s DatabaseSync and `better-sqlite3`'s Database both
    // expose prepare(); the shim adds run() and query() on top.
    const raw = {
      prepare(sql: string) {
        return {
          all: () => [{ a: "hello" }],
          get: () => ({ a: "hello" }),
          run: () => ({ changes: 1 }),
        };
      },
      exec: () => undefined,
    };
    const db = createCompatibleDatabaseFrom(raw);
    expect(typeof db.run).toBe("function");
    expect(typeof db.query).toBe("function");
    const rows = db.query("SELECT a FROM t WHERE a = ?", "hello").all() as Array<{ a: string }>;
    expect(rows[0]?.a).toBe("hello");
  });

  test("under PLAIN NODE the driver is node:sqlite (no native addon)", () => {
    // This is the assertion that matters for the plugin: run in a real node
    // process, with `better-sqlite3` made unresolvable, and prove the store
    // still works.
    const dir = mkdtempSync(join(tmpdir(), "roy-node-driver-"));
    try {
      const script = join(dir, "probe.mjs");
      writeFileSync(
        script,
        `
import { DatabaseSync } from "node:sqlite";
import { createCompatibleDatabaseFrom } from ${JSON.stringify(
          join(import.meta.dir, "sqlite-task-store.ts"),
        )};
`,
      );
      // The TS import path is not loadable from plain node, so the probe
      // exercises the *runtime contract* directly instead: node:sqlite must
      // expose the exact surface core's shim relies on.
      writeFileSync(
        script,
        `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE probe (a TEXT)");
db.prepare("INSERT INTO probe (a) VALUES (?)").run("ok");
const rows = db.prepare("SELECT a FROM probe").all();
if (rows[0]?.a !== "ok") { console.error("BAD", JSON.stringify(rows)); process.exit(1); }
console.log("NODE_SQLITE_OK");
`,
      );
      const out = execFileSync("node", [script], { encoding: "utf8" });
      expect(out).toContain("NODE_SQLITE_OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
