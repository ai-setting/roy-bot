#!/usr/bin/env bun
/**
 * RED test (Task #2499): after `bun run build` in @ai-setting/roy-bot-cli,
 * `dist/bin/roy-bot.js` MUST have the executable bit set, otherwise
 * `posix_spawn` fails with EACCES and downstream consumers
 * (e.g. roy-plugin-task-show) cannot load the task tree.
 *
 * Strategy: rebuild then immediately strip the bit. Re-run the build
 * script (which never fails fast on cache) and assert the postbuild
 * hook re-applies 0755.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { statSync, existsSync, chmodSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "dist", "bin", "roy-bot.js");

function isExecutable(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const st = statSync(filePath);
  return (st.mode & 0o111) !== 0;
}

describe("cli build — bin executable bit", () => {
  const originalMode = existsSync(BIN) ? statSync(BIN).mode : null;

  afterAll(() => {
    if (originalMode !== null && existsSync(BIN)) {
      chmodSync(BIN, originalMode);
    }
  });

  test("postbuild hook sets executable bit on shebang bin entry", () => {
    // Strip the bit so we can prove the postbuild re-applies it.
    if (existsSync(BIN)) chmodSync(BIN, 0o644);
    expect(isExecutable(BIN)).toBe(false);

    const r = spawnSync("bun", ["run", "postbuild"], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) {
      console.error("[postbuild] stdout:", r.stdout);
      console.error("[postbuild] stderr:", r.stderr);
    }
    expect(r.status).toBe(0);
    expect(isExecutable(BIN)).toBe(true);

    // shebang sanity
    const fd = openSync(BIN, "r");
    const buf = Buffer.alloc(20);
    readSync(fd, buf, 0, 20, 0);
    closeSync(fd);
    expect(buf.toString("utf8").startsWith("#!")).toBe(true);
  });

  test("postbuild is idempotent (no changes on second run)", () => {
    expect(isExecutable(BIN)).toBe(true);
    const r = spawnSync("bun", ["run", "postbuild"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(isExecutable(BIN)).toBe(true);
  });

  test("real-world EACCES repro: plugin can spawn the CLI with non-zero exit", () => {
    // We only assert "not failing with EACCES" — the binary may error
    // later for unrelated reasons (e.g. missing node_modules in a
    // worktree), but it MUST at least be invokable.
    if (existsSync(BIN)) chmodSync(BIN, 0o644);
    const r1 = spawnSync("bun", ["run", "postbuild"], { cwd: ROOT, encoding: "utf8" });
    expect(r1.status).toBe(0);
    expect(isExecutable(BIN)).toBe(true);
    // Try execve directly. If the bit is missing, OS returns EACCES
    // and the spawn fails with ENOENT-style error or shell "Permission
    // denied". We accept any non-EACCES exit (the binary may still
    // bail later for module-not-found reasons).
    const r2 = spawnSync(BIN, ["--version"], {
      encoding: "utf8",
      shell: false,
    });
    // Pass an absent CLI arg like --bogus to make the binary exit
    // fast with a known non-zero code; we only care that execve
    // succeeded (no EACCES).
    if (r2.error) {
      // "spawn EACCES" surfaces here.
      expect(String(r2.error)).not.toContain("EACCES");
    }
  });
});