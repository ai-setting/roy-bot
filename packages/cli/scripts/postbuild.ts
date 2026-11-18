#!/usr/bin/env bun
/**
 * postbuild hook for @ai-setting/roy-bot-cli.
 *
 * bunup does not preserve the executable bit on emitted `bin/*` entries,
 * so consumers (and `npm install -g`) end up with a `roy-bot.js` that
 * has mode 0644. Spawning it then fails with EACCES.
 *
 * This script walks `dist/bin/`, sets 0755 on every entry, and logs the
 * mode change. It also runs chmod 0644 on non-executable siblings
 * (e.g. `dist/bin/*.json`) so the package layout stays uniform.
 *
 * Idempotent: safe to run repeatedly. Exit code 0 unless chmod itself
 * throws (which would only happen on a permissions/FS error).
 */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BIN_DIR = join(import.meta.dir, "..", "dist", "bin");

if (!existsSync(BIN_DIR)) {
  console.error(`[postbuild] ${BIN_DIR} does not exist — did bunup run?`);
  process.exit(1);
}

let touched = 0;
for (const name of readdirSync(BIN_DIR)) {
  const full = join(BIN_DIR, name);
  const st = statSync(full);
  if (!st.isFile()) continue;
  // Heuristic: any file with a shebang or `.js` extension gets +x.
  // Other files (no shebang, no JS) stay 0644 to avoid accidentally
  // marking config / data blobs as executable.
  const isJsOrShebang = name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs");
  let shouldBeExec = isJsOrShebang;
  if (!shouldBeExec) {
    try {
      const fd = require("node:fs").openSync(full, "r");
      const buf = Buffer.alloc(2);
      require("node:fs").readSync(fd, buf, 0, 2, 0);
      require("node:fs").closeSync(fd);
      if (buf[0] === 0x23 /* '#' */ && buf[1] === 0x21 /* '!' */) shouldBeExec = true;
    } catch {
      /* ignore — leave as non-executable */
    }
  }
  if (shouldBeExec) {
    const want = 0o755;
    if ((st.mode & 0o777) !== want) {
      chmodSync(full, want);
      touched++;
      console.log(`[postbuild] chmod 0755 ${full}`);
    }
  }
}

console.log(`[postbuild] ok — ${touched} file(s) marked executable`);