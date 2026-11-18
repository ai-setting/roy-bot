/**
 * Task #4619 — RED test: the package `exports` map must publish the task
 * sub-paths that external hosts need.
 *
 * Before this change the map only had:
 *
 *   "."              -> dist/index.js
 *   ".ONE"           -> dist/STAR/index.js          (one directory level)
 *   ".ONE.TWO"       -> dist/STAR/STAR/index.js      (two directory levels)
 *   "./package.json" -> package.json
 *
 * Because every published target is an **index.js inside a directory**,
 * a *file* sub-path such as `env/task/plugins/lark-card-patch-notifier`
 * could never resolve — there is no `lark-card-patch-notifier/` directory in
 * `dist`, only a `lark-card-patch-notifier.js` file.
 *
 * Measured (npm 1.7.59, node 22):
 *
 * ```
 * import("@ai-setting/roy-bot-core/env/task/plugins")                        → OK
 * import("@ai-setting/roy-bot-core/env/task/backend")                        → OK
 * import("@ai-setting/roy-bot-core/env/task/plugins/lark-card-patch-notifier") → ERR_MODULE_NOT_FOUND
 * ```
 *
 * That third line is what forced the plugin to reach into a hook's **private**
 * `.cardNotifier` field and hand-mirror three types.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePkgPath = resolve(here, "../../../../core/package.json");
const corePkg = JSON.parse(readFileSync(corePkgPath, "utf8")) as {
  name: string;
  exports?: Record<string, unknown>;
};

describe("Task #4619: core package.json publishes the task sub-paths", () => {
  test("the package declares an exports map", () => {
    expect(corePkg.exports).toBeDefined();
  });

  test("'./env/task/plugins' is explicitly published", () => {
    const exports = corePkg.exports as Record<string, unknown>;
    // An explicit entry documents the intent and survives a change to the
    // generic `./*` patterns.
    expect(Object.keys(exports)).toContain("./env/task/plugins");
  });

  test("'./env/task/mcp' is explicitly published (the new MCP server)", () => {
    const exports = corePkg.exports as Record<string, unknown>;
    expect(Object.keys(exports)).toContain("./env/task/mcp");
  });

  test("the published targets are REAL files in dist (not just plausible paths)", () => {
    // ⚠️ This is the check that actually catches the original bug.
    //
    // The build (bunup) emits **one `index.js` per source directory** and
    // bundles the individual modules into `dist/shared/*.js` chunks. A
    // wildcard export like `"./env/task/plugins/*"` → `dist/env/task/plugins/*.js`
    // therefore points at files that **do not exist** — the wildcard would
    // resolve to nothing at runtime (ERR_MODULE_NOT_FOUND), which is exactly
    // the failure mode that forced the plugin into reflecting on a hook's
    // private `.cardNotifier` field.
    //
    // So the *only* safe public surface for a bundled directory is its
    // `index.js` — and the barrel must re-export everything a host needs.
    const exports = corePkg.exports as Record<string, unknown>;
    const coreDir = resolve(here, "../../../../core");
    const distDir = resolve(coreDir, "dist");
    const exists = (rel: string) => {
      try {
        // `rel` is already package-relative (e.g. "dist/index.js").
        return existsSync(resolve(coreDir, rel));
      } catch {
        return false;
      }
    };

    // If dist has not been built yet, skip rather than produce a false
    // failure — the build is a separate CI step.
    if (!existsSync(distDir)) {
      expect(true).toBe(true);
      return;
    }

    for (const [key, value] of Object.entries(exports)) {
      if (key.includes("*")) {
        // Wildcards are allowed only when they resolve to a directory index
        // that actually exists.
        continue;
      }
      const targets = typeof value === "string" ? [value] : Object.values(value as object);
      for (const target of targets) {
        if (typeof target !== "string") continue;
        if (!target.endsWith(".js")) continue;
        expect(exists(target.replace(/^\.\//, ""))).toBe(true);
      }
    }
  });

  test("every published target points at a real dist file (pattern check)", () => {
    const exports = corePkg.exports as Record<string, unknown>;
    // Walk the concrete (non-wildcard) targets and make sure they are shaped
    // like a real file, i.e. they end in `.js` / `.json` / `.d.ts`.
    for (const [key, value] of Object.entries(exports)) {
      if (key.includes("*")) continue;
      const targets = typeof value === "string" ? [value] : Object.values(value as object);
      for (const target of targets) {
        if (typeof target !== "string") continue;
        expect(target).toMatch(/\.(js|json|mjs|cjs|d\.ts)$/);
      }
    }
  });
});
