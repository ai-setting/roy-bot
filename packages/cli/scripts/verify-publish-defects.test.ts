/**
 * @fileoverview Publish defect guards for @ai-setting/roy-bot-cli (Task #4957).
 *
 * Guards against the two defects found in the published 1.7.72:
 *
 * Defect 1 — dist imports `@opentui/core` / `@opentui/solid` / `solid-js`
 *   at runtime, but package.json did not declare them →
 *   `npm i -g @ai-setting/roy-bot-cli` then `roy-bot --version` crashed
 *   with ERR_MODULE_NOT_FOUND. (cli.ts statically imports commands/interactive.ts
 *   → those packages are hard runtime deps, not optional.)
 *
 * Defect 2 — the published bundle was built with bunup target `bun`
 *   (`// @bun` pragma + `import.meta.require` shim) while the shebang stayed
 *   `#!/usr/bin/env node` → every DB-backed subcommand under node crashed
 *   with `__require is not a function`. The repo's build pipeline must be
 *   pinned to `target: "node"` in bunup.config.ts so the artifact matches
 *   the node shebang on any machine (1.7.70/71 were node-target; only the
 *   1.7.72 publish drifted).
 *
 * Strategy: these tests read the built artifact in dist/ and the package
 * manifest, so they only enforce invariants AFTER `bun run build`.
 * When dist/ is absent the tests skip (fail-soft) so a clean checkout
 * can still run the unit suite.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const CLI_ROOT = join(import.meta.dir, "..");
const PKG_JSON_PATH = join(CLI_ROOT, "package.json");
const BIN_PATH = join(CLI_ROOT, "dist", "bin", "roy-bot.js");
const INDEX_PATH = join(CLI_ROOT, "dist", "index.js");

function readPkgDeps(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8"));
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
}

/** Bare package names imported by dist code that resolve outside the bundle. */
function extractExternalImports(distSource: string): Set<string> {
  const imports = new Set<string>();
  // import ... from "pkg" / export ... from "pkg"
  const importRe = /(?:^|[;\s}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
  // bare side-effect import: `import "pkg"` followed by ; / , /
  // line end / EOF (review #4957: no `from` clause)
  const sideEffectRe = /(?:^|[;\s}])import\s*["']([^"'./][^"']*)["']\s*(?:[;,]|(?=[\n\r]|$))/g;
  // bare dynamic import("pkg")
  const dynRe = /\bimport\(\s*["']([^"'./][^"']*)["']\s*\)/g;
  // require("pkg") emitted by the bundler
  const reqRe = /(?:__require|requireModule|createRequire\([^)]*\))\(\s*["']([^"'./][^"']*)["']\s*\)/g;

  for (const re of [importRe, sideEffectRe, dynRe, reqRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(distSource)) !== null) {
      const spec = m[1];
      // skip runtime builtins: node:xxx, bun:xxx, and classic node builtins
      if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
      const BUILTINS = new Set([
        "fs", "fs/promises", "path", "os", "url", "util", "crypto",
        "events", "stream", "child_process", "readline", "assert",
        "async_hooks", "net", "http", "https", "zlib", "tty", "process",
        "timers/promises", "string_decoder", "dns", "tls", "buffer",
      ]);
      if (BUILTINS.has(spec)) continue;
      // bare specifier: scoped (@scope/name) or plain (name)
      const parts = spec.split("/");
      const bare = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      imports.add(bare);
    }
  }
  return imports;
}

describe("publish guard: dist runtime imports are declared dependencies", () => {
  const distExists = existsSync(BIN_PATH) && existsSync(INDEX_PATH);

  test("dist artifacts exist (run `bun run build` first)", () => {
    // Guard test itself needs dist; explicit failure keeps CI honest.
    expect(distExists).toBe(true);
  });

  test("every external package imported by dist is declared in package.json", () => {
    if (!distExists) return;
    const deps = readPkgDeps();

    const undeclaredByFile: Record<string, string[]> = {};
    for (const [label, file] of [
      ["dist/bin/roy-bot.js", BIN_PATH],
      ["dist/index.js", INDEX_PATH],
    ] as const) {
      const source = readFileSync(file, "utf8");
      const externals = extractExternalImports(source);
      const missing = [...externals].filter((name) => !(name in deps));
      if (missing.length > 0) undeclaredByFile[label] = missing;
    }

    expect(undeclaredByFile).toEqual({});
  });

  test("regression: @opentui/core, @opentui/solid, solid-js are declared", () => {
    const deps = readPkgDeps();
    for (const name of ["@opentui/core", "@opentui/solid", "solid-js"]) {
      expect(deps[name]).toBeDefined();
    }
  });
});

describe("publish guard: shebang matches build target", () => {
  const distExists = existsSync(BIN_PATH);

  test("bunup.config.ts pins target:'node' (prevents target drift like 1.7.72)", () => {
    const cfg = readFileSync(join(CLI_ROOT, "bunup.config.ts"), "utf8");
    // Strip comments so a mention of target:"node" inside a comment
    // cannot satisfy this assertion (review finding, Task #4957).
    const code = cfg
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
      .join("\n");
    expect(code).toMatch(/target:\s*["']node["']/);
  });

  test("source bin entry declares a node shebang", () => {
    const src = readFileSync(join(CLI_ROOT, "src", "bin", "roy-bot.ts"), "utf8");
    expect(src.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  test("built dist/bin/roy-bot.js: node shebang AND no bun-only pragma/shim", () => {
    if (!distExists) return;
    const src = readFileSync(BIN_PATH, "utf8");

    // Must start with the node shebang (npm global bin shim executes via shebang)
    expect(src.startsWith("#!/usr/bin/env node")).toBe(true);

    // The `// @bun` pragma is emitted ONLY for target:"bun" bundles and makes
    // bun skip transpilation; combined with import.meta.require it is
    // bun-runtime-only. Our artifact must be node-runnable anywhere in
    // the file, not just at the top (review finding, Task #4957).
    expect(src.includes("// @bun")).toBe(false);
    expect(src.includes("import.meta.require")).toBe(false);

    // require() calls from source must be bridged via createRequire (node ESM)
    expect(src.includes("createRequire")).toBe(true);
  });
});
