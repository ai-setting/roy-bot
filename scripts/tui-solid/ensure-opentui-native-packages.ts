#!/usr/bin/env bun
/**
 * ensure-opentui-native-packages.ts — Task #4278 片7 (R7)
 *
 * `@opentui/core` selects its Zig native binding with a **static** import of
 * every platform package:
 *
 *   if (process.platform === "linux" && process.arch === "arm64")
 *     return (await import("@opentui/core-linux-arm64")).default;
 *   …8 variants
 *
 * npm/bun only install the *current* platform's optionalDependency, so a
 * **cross-compile** (`build-standalone.ts --all`) fails with
 * `Could not resolve: "@opentui/core-linux-arm64"` — the bundler must be able
 * to resolve every statically-referenced specifier, even though only one is
 * reachable at runtime.
 *
 * This script fetches the missing `@opentui/core-*` packages from the npm
 * registry and unpacks them directly into `node_modules/@opentui/`. Extracting
 * (rather than `bun add`) sidesteps npm's os/cpu gating, which refuses to
 * install a linux-arm64 payload on a linux-x64 host.
 *
 * Idempotent: already-present packages are skipped. Run before
 * `build:standalone:all` whenever a cross-platform binary is needed.
 *
 * Usage:
 *   bun run scripts/tui-solid/ensure-opentui-native-packages.ts
 *   bun run scripts/tui-solid/ensure-opentui-native-packages.ts --check
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const ROOT = path.resolve(".");
const OPENTUI_DIR = path.join(ROOT, "node_modules", "@opentui");

/** Every native binding `@opentui/core` imports statically. */
const PACKAGES = [
  "core-linux-x64",
  "core-linux-arm64",
  "core-linux-x64-musl",
  "core-linux-arm64-musl",
  "core-darwin-x64",
  "core-darwin-arm64",
  "core-win32-x64",
  "core-win32-arm64",
];

const checkOnly = process.argv.includes("--check");

/** Version pinned by the installed @opentui/core's optionalDependencies. */
async function coreVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(path.join(ROOT, "node_modules", "@opentui", "core", "package.json"), "utf8"),
  ) as { optionalDependencies?: Record<string, string> };
  return pkg.optionalDependencies?.["@opentui/core-linux-x64"] ?? "0.6.6";
}

function installed(name: string): boolean {
  return existsSync(path.join(OPENTUI_DIR, name, "package.json"));
}

async function unpack(name: string, version: string): Promise<boolean> {
  const work = path.join(tmpdir(), `opentui-native-${name}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const pack = Bun.spawnSync({
      cmd: ["npm", "pack", `@opentui/${name}@${version}`],
      cwd: work,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pack.exitCode !== 0) {
      console.error(`  ✗ npm pack ${name} failed: ${pack.stderr.toString().slice(0, 200)}`);
      return false;
    }
    const tgz = (await readdir(work)).find((f) => f.endsWith(".tgz"));
    if (!tgz) {
      console.error(`  ✗ no tarball produced for ${name}`);
      return false;
    }
    const extract = Bun.spawnSync({
      cmd: ["tar", "-xzf", path.join(work, tgz), "-C", work],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (extract.exitCode !== 0) {
      console.error(`  ✗ tar extract ${name} failed`);
      return false;
    }
    const dest = path.join(OPENTUI_DIR, name);
    mkdirSync(dest, { recursive: true });
    await cp(path.join(work, "package"), dest, { recursive: true });
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Ensure every native package is present. Returns true when the environment is
 * ready for a cross-compile. Safe to call from build scripts.
 */
export async function ensureOpentuiNativePackages(): Promise<boolean> {
  const version = await coreVersion();
  const missing = PACKAGES.filter((n) => !installed(n));
  if (missing.length === 0) return true;
  console.log(`[opentui-native] fetching ${missing.length} missing: ${missing.join(", ")}`);
  let failed = 0;
  for (const name of missing) {
    const ok = await unpack(name, version);
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) failed += 1;
  }
  return failed === 0;
}

// Only run the CLI flow when executed directly (not when imported).
if (import.meta.main) {
const version = await coreVersion();
console.log(`[opentui-native] @opentui/core native bindings @ ${version}`);

const missing = PACKAGES.filter((n) => !installed(n));
if (checkOnly) {
  if (missing.length === 0) {
    console.log("  ✅ all 8 native packages present");
    process.exit(0);
  }
  console.log(`  ❌ missing (${missing.length}): ${missing.join(", ")}`);
  console.log("  → run without --check to fetch them");
  process.exit(1);
}

if (missing.length === 0) {
  console.log("  ✅ all 8 native packages already present — nothing to do");
  process.exit(0);
}

console.log(`  fetching ${missing.length} missing: ${missing.join(", ")}`);
let failed = 0;
for (const name of missing) {
  const ok = await unpack(name, version);
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.error(`[opentui-native] ${failed} package(s) failed — cross-compile will not work`);
  process.exit(1);
}
console.log("[opentui-native] ✅ all native packages present — safe to build --all");
}
