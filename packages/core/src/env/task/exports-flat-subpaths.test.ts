/**
 * Task #4624 — every core sub-path that a downstream host imports as a
 * **file** must resolve under plain node.
 *
 * Background (measured, npm 1.7.61 + node 24):
 *
 * ```
 * import("@ai-setting/roy-bot-core/env/task/plugins")   → OK   (dist/env/task/plugins/index.js)
 * import("@ai-setting/roy-bot-core/env/error-reply")    → ERR_MODULE_NOT_FOUND
 *                                                          (dist/env/error-reply/index.js)
 * ```
 *
 * Root cause: `bunup.config.ts` only lists `src/**\/index.ts` as entries, so a
 * source **file** (`src/env/error-reply.ts`) never gets a `dist/...js`
 * counterpart. The `exports` map then falls through to the `./*./*`
 * wildcard, which maps `env/error-reply` → `dist/env/error-reply/index.js` —
 * a path that does not exist. Node's exports arrays do **not** fall back to a
 * later candidate when the first one throws `ERR_MODULE_NOT_FOUND`, so adding
 * `"./*": ["./dist/STAR/index.js", "./dist/STAR.js"]` does NOT fix it
 * (measured — Node throws on the first candidate instead of trying the next).
 *
 * The fix is therefore two-part and this test guards both halves:
 *   1. `bunup.config.ts` builds the flat sources into real `dist/...js` files.
 *   2. `package.json#exports` declares an explicit entry per flat sub-path
 *      pointing at `./dist/<path>.js` (+ the matching `.d.ts` for types).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coreDir = resolve(here, "../../..");
const corePkg = JSON.parse(readFileSync(resolve(coreDir, "package.json"), "utf8")) as {
  name: string;
  exports?: Record<string, unknown>;
};
const bunupConfig = readFileSync(resolve(coreDir, "bunup.config.ts"), "utf8");
const distDir = resolve(coreDir, "dist");
const distBuilt = existsSync(distDir);

/** Source **files** (not directories) reached by hosts via deep imports. */
const FLAT_SUBPATHS = [
  "env/error-reply",
  "env/lark-mention-utils",
  "env/tool/types",
  "env/event-source/event-store",
  "env/event-source/cli-command-handler",
  "env/event-source/event-source-handlers",
  "env/event-source/idempotency-key",
  "env/task/delegate/delegate-tool",
  "env/log-trace/logger",
  "env/agent/agent-component",
  "env/task/plugins/lark-card-patch-notifier",
  "test-utils/child-process-mock",
] as const;

/** Sub-paths the published CLI 1.7.59 imports by name — the hard acceptance. */
const LEGACY_CLI_FLAT_SUBPATHS = [
  "env/error-reply",
  "env/lark-mention-utils",
  "env/log-trace/logger",
] as const;

describe("Task #4624: flat (file) core sub-paths are published", () => {
  test("the list still describes real source files", () => {
    for (const sub of FLAT_SUBPATHS) {
      expect(existsSync(resolve(coreDir, "src", `${sub}.ts`))).toBe(true);
    }
  });

  test("bunup builds every flat sub-path into dist/<sub>.js", () => {
    for (const sub of FLAT_SUBPATHS) {
      // The entry list is the only thing that makes bunup emit a file target.
      expect(bunupConfig).toContain(`"src/${sub}.ts"`);
    }
  });

  test("every flat sub-path has an explicit exports entry → ./dist/<sub>.js", () => {
    const exportsMap = corePkg.exports as Record<string, unknown>;
    for (const sub of FLAT_SUBPATHS) {
      const entry = exportsMap[`./${sub}`] as Record<string, string> | undefined;
      expect(entry).toBeDefined();
      expect(entry?.import).toBe(`./dist/${sub}.js`);
      expect(entry?.types).toBe(`./dist/${sub}.d.ts`);
    }
  });

  test("the entries the published CLI 1.7.59 needs are all present", () => {
    const exportsMap = corePkg.exports as Record<string, unknown>;
    for (const sub of LEGACY_CLI_FLAT_SUBPATHS) {
      expect(Object.keys(exportsMap)).toContain(`./${sub}`);
    }
  });

  test("published flat targets are REAL files in dist", () => {
    if (!distBuilt) {
      // The build is a separate step; do not fake a pass, just be explicit.
      expect(distBuilt).toBe(false);
      return;
    }
    for (const sub of FLAT_SUBPATHS) {
      expect(existsSync(resolve(distDir, `${sub}.js`))).toBe(true);
      expect(existsSync(resolve(distDir, `${sub}.d.ts`))).toBe(true);
    }
  });

  test("plain node can import every flat sub-path (self-reference)", () => {
    if (!distBuilt) return;
    const specifiers = FLAT_SUBPATHS.map((s) => `${corePkg.name}/${s}`);
    const script = `
      const specs = ${JSON.stringify(specifiers)};
      const failed = [];
      for (const s of specs) {
        try { await import(s); } catch (e) { failed.push(s + " :: " + e.code + " " + e.message); }
      }
      if (failed.length) { console.error(failed.join("\\n")); process.exit(1); }
      console.log("ok:" + specs.length);
    `;
    // Use the real `node` binary (bun runs this test, so `process.execPath`
    // is bun and would not exercise Node's exports resolution).
    const out = execFileSync("node", ["--input-type=module", "-e", script], {
      cwd: coreDir,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(out.trim()).toBe(`ok:${specifiers.length}`);
  }, 180_000);
});
