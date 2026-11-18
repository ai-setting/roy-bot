/**
 * @fileoverview Publish defect guard: third-party deps must NOT be inlined
 * into the cli bundle (Task #5592).
 *
 * Defect — the published 1.7.91 `dist/bin/roy-bot.js` inlined six CJS
 * third-party packages:
 *
 *   jsonc-parser@3.3.1, better-sqlite3@11.10.0, bindings@1.5.0,
 *   file-uri-to-path@1.0.0, yaml@2.9.0, xdg-basedir@5.1.0
 *
 * Two distinct failure modes came out of that:
 *
 *   1. jsonc-parser is a UMD package. Its factory body calls
 *      `require("./impl/format")`, and once the UMD wrapper is inlined into
 *      `dist/bin/`, that relative require resolves against `dist/bin/` — not
 *      against `node_modules/jsonc-parser/lib/umd/`. A fresh
 *      `npm i @ai-setting/roy-bot-cli` then died on
 *      `Error: Cannot find module './impl/format'` before printing --version.
 *
 *   2. `bindings@1.5.0` bakes `__filename` into the bundle, so the artifact
 *      carried the publisher's absolute path
 *      (`~/.../node_modules/.bun/bindings@1.5.0/...`) — works on the
 *      build machine, breaks (or silently misloads) anywhere else.
 *
 * Root cause — `packages/cli/src/tui-solid/app-config-io.ts` reached across
 * the package boundary with a RELATIVE import:
 *
 *   import { guardConfigWrite } from "../../../core/src/config/index";
 *
 * bunup's `packages: "external"` only externalises BARE specifiers that
 * appear in package.json deps/devDeps/peerDeps (see
 * node_modules/bunup/dist/shared/bunup-yf5cw3mx.js:116-133). A relative
 * path always gets inlined, dragging core/config's third-party CJS closure
 * (jsonc-parser, better-sqlite3, yaml, xdg-basedir) into the ESM bundle.
 *
 * Guards in this file:
 *   A. Source level — cli `src/` must not import across package boundaries
 *      via relative paths (`../core/src`, `../coder-harness/src`, ...).
 *   B. Artifact level — the built bundle must contain no `node_modules/.bun/`
 *      inline markers and no hardcoded absolute build-machine paths.
 *   C. Artifact level — no inlined UMD factory shims (`require_main()` style
 *      wrappers that end up calling `require("./impl/...")`).
 *   D. Dependency level — every bare specifier the cli `src/` imports must be
 *      declared in package.json (no accidental reliance on hoisted
 *      transitive deps).
 *
 * These tests read the built artifact, so they only enforce invariants AFTER
 * `bun run build`. When dist/ is absent the artifact checks skip (fail-soft)
 * so a clean checkout can still run the unit suite; the source + dependency
 * checks never skip.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CLI_ROOT = join(import.meta.dir, "..");
const PKG_JSON_PATH = join(CLI_ROOT, "package.json");
const SRC_DIR = join(CLI_ROOT, "src");
const BIN_PATH = join(CLI_ROOT, "dist", "bin", "roy-bot.js");
const INDEX_PATH = join(CLI_ROOT, "dist", "index.js");

/** Recursively collect non-test source files under `dir`. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collectSources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      if (/\.(test|spec)\./.test(entry.name)) continue;
      if (/\.runner\./.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/** Join the module header of every multi-line import with its `from` clause. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // Bare `import x from "spec"` / `export ... from "spec"`.
  // The `[^;"'=]*?` body forbids quotes / semicolons / `=` between the keyword
  // and `from`, so ordinary code such as
  //   `export const x: CommandModule<object, Opts> = { command: "reorder <from> <to>" }`
  // cannot be mistaken for an import clause (Task #5592 false positive).
  const inline = /(?:^|[;\s}])(?:import|export)\s[^;"'=]*?from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(source)) !== null) specs.push(m[1]);
  // Side-effect import
  const sideEffect = /(?:^|[;\s}])import\s*["']([^"']+)["']/g;
  while ((m = sideEffect.exec(source)) !== null) specs.push(m[1]);
  // Dynamic import
  const dynamic = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamic.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

/** Strip block + line comments so prose mentioning a forbidden specifier
 *  (e.g. the explanatory comment above the fixed import) is not scanned. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ---------------------------------------------------------------
// A. Source level: no cross-package relative imports
// ---------------------------------------------------------------
describe("publish guard: cli src must not import across package boundaries", () => {
  test("no `../core/src`, `../coder-harness/src` or `../ontology-harness/src` relative imports", () => {
    const offenders: string[] = [];
    for (const file of collectSources(SRC_DIR)) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const spec of importSpecifiers(source)) {
        if (!spec.startsWith(".")) continue;
        // Resolve the relative spec's hop count: only paths that climb out of
        // packages/cli/src (three or more `../`) can reach a sibling package.
        const climbs = spec.match(/^(\.\.\/)+/)?.[0].length ?? 0;
        const hops = climbs / 3;
        const escapesCliPackage = hops >= 3;
        if (!escapesCliPackage) continue;
        if (/(^|\/)(core|coder-harness|ontology-harness|desktop)\/src\//.test(spec)) {
          offenders.push(`${file.replace(CLI_ROOT + "/", "")} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("app-config-io.ts imports guardConfigWrite via the package specifier", () => {
    const file = join(SRC_DIR, "tui-solid", "app-config-io.ts");
    const source = stripComments(readFileSync(file, "utf8"));
    expect(source).toContain('from "@ai-setting/roy-bot-core/config"');
    expect(source).not.toContain('"../../../core/src/config/index"');
  });
});

// ---------------------------------------------------------------
// D. Dependency level: every bare import in src is declared
// ---------------------------------------------------------------
describe("publish guard: cli src bare imports are declared in package.json", () => {
  const NODE_BUILTINS = new Set([
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
    "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
    "module", "net", "os", "path", "perf_hooks", "process", "punycode",
    "querystring", "readline", "readline/promises", "repl", "stream",
    "string_decoder", "sys", "timers", "timers/promises", "tls", "trace_events",
    "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
  ]);

  test("no undeclared third-party bare import in cli src", () => {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8"));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);

    const offenders: string[] = [];
    // 包自引用（`@ai-setting/roy-bot-cli` 指向本包自己）不需要在
    // dependencies 里，Node 的 self-reference 由 package.json 的 name 提供。
    const selfName = pkg.name;
    for (const file of collectSources(SRC_DIR)) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const spec of importSpecifiers(source)) {
        if (spec.startsWith(".")) continue;
        if (spec === selfName || spec.startsWith(selfName + "/")) continue;
        if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
        if (spec.includes("${")) continue; // template-literal specifier, not a real import
        const bare = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        if (NODE_BUILTINS.has(bare)) continue;
        if (bare === "bun") continue;
        if (!declared.has(bare)) {
          offenders.push(`${file.replace(CLI_ROOT + "/", "")} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("regression: jsonc-parser / yaml / zod are declared (cli imports them directly)", () => {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8"));
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    };
    for (const name of ["jsonc-parser", "yaml", "zod"]) {
      expect(deps[name]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------
// B / C. Artifact level: no inlined third-party code
// ---------------------------------------------------------------
describe("publish guard: built bundle must not inline third-party packages", () => {
  const distExists = existsSync(BIN_PATH) && existsSync(INDEX_PATH);

  // fail-soft（与文件头承诺一致）：dist 缺失时跳过产物级断言，
  // 让干净 checkout 也能跑单测；产物存在性由发布流程（publish-full
  // 的 buildAllSdk 验证 dist/index.js 存在）兜底，不在这里硬断言。
  test("dist build outputs exist (fail-soft: skip artifact checks when absent)", () => {
    // no-op probe — artifact tests below self-skip via `if (!distExists) return`
  });

  test("no `node_modules/.bun/` inline markers in either artifact", () => {
    if (!distExists) return;
    const byFile: Record<string, number> = {};
    for (const [label, file] of [
      ["dist/bin/roy-bot.js", BIN_PATH],
      ["dist/index.js", INDEX_PATH],
    ] as const) {
      const source = readFileSync(file, "utf8");
      const count = (source.match(/node_modules\/\.bun\//g) ?? []).length;
      if (count > 0) byFile[label] = count;
    }
    expect(byFile).toEqual({});
  });

  test("no hardcoded absolute build-machine paths in either artifact", () => {
    if (!distExists) return;
    const byFile: Record<string, string[]> = {};
    for (const [label, file] of [
      ["dist/bin/roy-bot.js", BIN_PATH],
      ["dist/index.js", INDEX_PATH],
    ] as const) {
      const source = readFileSync(file, "utf8");
      const hits = source.match(/["']\/(?:home|Users)\/[^"'\n]{5,}["']/g) ?? [];
      if (hits.length > 0) byFile[label] = hits.slice(0, 5);
    }
    expect(byFile).toEqual({});
  });

  test("no inlined UMD/CJS factory wrappers for third-party deps", () => {
    if (!distExists) return;
    const source = readFileSync(BIN_PATH, "utf8");
    // An inlined UMD package always leaves a source-comment marker pointing at
    // the dependency's real path, plus a `__commonJS` wrapper around it.
    expect(source).not.toMatch(/\/\/ \.\.\/\.\.\/node_modules\/\.bun\/[^/]+\//);
    // jsonc-parser's UMD body requires its siblings relative to itself; if the
    // wrapper got inlined those requires survive into the artifact verbatim and
    // resolve against dist/bin/ at runtime → MODULE_NOT_FOUND.
    expect(source).not.toContain('require2("./impl/format")');
    expect(source).not.toContain('require("./impl/format")');
  });

  test("jsonc-parser / better-sqlite3 stay runtime requires, not inlined code", () => {
    if (!distExists) return;
    const source = readFileSync(BIN_PATH, "utf8");
    // better-sqlite3 must be reached through the createRequire bridge
    // (`__require("better-sqlite3")`), never as a statically inlined module.
    expect(source).not.toMatch(
      /\/\/ \.\.\/\.\.\/node_modules\/\.bun\/better-sqlite3@\d+\.\d+\.\d+\//
    );
    // And no `bindings@<ver>` path baked in (that's the __filename leak).
    expect(source).not.toMatch(/bindings@\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------
// E. Native deps must not be hard dependencies (Task #5592, defect 2)
// ---------------------------------------------------------------
//
// Defect — `better-sqlite3` was declared in core's `dependencies`. It has no
// prebuilt binary for node 24, so `npm install @ai-setting/roy-bot-cli` on a
// slim image without python3/make/g++ ran `node-gyp rebuild` and failed the
// WHOLE install (npm rolls back atomically — the package never landed).
//
// better-sqlite3 is only a FALLBACK for node < 22.5: span-storage.ts prefers
// `bun:sqlite` (Bun) then `node:sqlite` (node >= 22.5, built in, no native
// build). Declaring it as `optionalDependencies` makes npm skip it when the
// native build fails, while node >= 22.5 keeps working via node:sqlite.
//
// Experimental proof (node:24-bookworm-slim, no build toolchain):
//   dependencies       → INSTALL_EXIT=1, rollback, no package on disk
//   optionalDependencies → INSTALL_EXIT=0, better-sqlite3 silently skipped,
//                          `require("node:sqlite")` OK
describe("publish guard: native sqlite fallback must stay optional", () => {
  test("core declares better-sqlite3 in optionalDependencies, not dependencies", () => {
    const corePkg = JSON.parse(
      readFileSync(join(CLI_ROOT, "..", "core", "package.json"), "utf8")
    );
    expect(corePkg.dependencies?.["better-sqlite3"]).toBeUndefined();
    expect(corePkg.optionalDependencies?.["better-sqlite3"]).toBeDefined();
  });

  // Task #5592 CV 返工：断言覆盖**所有** better-sqlite3 引用点，
  // 不只 span-storage —— #4619 只改了 task 侧，session/workflow/
  // event-store 全部漏掉，better-sqlite3 移 optional 后全新 Node
  // 环境 sessions list / act / workflow list 全崩。
  const SQLITE_RUNTIME_FILES = [
    "env/log-trace/span-storage.ts",
    "env/session/storage/sqlite.ts",
    "env/session/__bench__/replay-compact.ts",
    "env/task/storage/sqlite-task-store.ts",
    "env/workflow/storage/sqlite.ts",
    "env/event-source/event-store.ts",
  ] as const;

  test("every better-sqlite3 consumer prefers node:sqlite first (all storage files)", () => {
    const offenders: string[] = [];
    for (const rel of SQLITE_RUNTIME_FILES) {
      const src = readFileSync(join(CLI_ROOT, "..", "core", "src", rel), "utf8");
      const nodeSqliteAt = src.indexOf('require("node:sqlite")');
      const betterSqliteAt = src.indexOf('require("better-sqlite3")');
      if (nodeSqliteAt < 0 || betterSqliteAt < 0 || nodeSqliteAt > betterSqliteAt) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("span-storage prefers built-in sqlite before falling back to better-sqlite3", () => {
    const src = readFileSync(
      join(CLI_ROOT, "..", "core", "src", "env", "log-trace", "span-storage.ts"),
      "utf8"
    );
    const nodeSqliteAt = src.indexOf('require("node:sqlite")');
    const betterSqliteAt = src.indexOf('require("better-sqlite3")');
    expect(nodeSqliteAt).toBeGreaterThan(-1);
    expect(betterSqliteAt).toBeGreaterThan(-1);
    // node:sqlite must be attempted BEFORE better-sqlite3
    expect(nodeSqliteAt).toBeLessThan(betterSqliteAt);
  });
});
