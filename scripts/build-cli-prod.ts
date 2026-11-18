#!/usr/bin/env bun
/**
 * CLI 生产构建脚本
 * 
 * 特点：
 * 1. 不链接源码，使用 workspace 依赖（已发布的 npm 包）
 * 2. 使用 bun compile 生成独立可执行文件
 * 3. 生成可分发的二进制安装包
 * 
 * 使用：
 *   bun run build:cli:prod:single    # 当前平台
 *   bun run build:cli:prod            # 全平台
 */

import path from "path";
import fs from "fs";
import { mkdir, chmod, copyFile } from "node:fs/promises";
import { $ } from "bun";
// Task #4278 R8: solid-js → client runtime + scoped Solid JSX transform.
import { solidClientResolvePlugin, scopedSolidTransformPlugin } from "./tui-solid/solid-client-resolve-plugin.ts";
// Task #4996: 原子替换（tmp + rename），避免覆盖正在被执行的二进制时 ETXTBSY。
import { cleanupStaleTempFiles, replaceBinaryAtomically } from "./atomic-bin-replace.ts";

const ROOT = path.resolve(".");
const PKG_ROOT = path.join(ROOT, "packages", "cli");
const STANDALONE_BIN_DIR = path.join(ROOT, "packages", "roy-bot-standalone", "bin");
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8"));

const VERSION = PKG.version || "1.0.0";
const CHANNEL = process.env.CHANNEL || "prod";

const SINGLE_FLAG = process.argv.includes("--single");
const TARGETS = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "win32", arch: "x64" },
];

const binaries: Record<string, string> = {};

async function build() {
  console.log(`🏗️  Building roy-bot CLI ${VERSION} (${CHANNEL}) [PROD MODE]`);
  console.log(`   Standalone executable with bundled dependencies`);
  console.log("");

  // 过滤当前平台（如果 --single）
  const targets = SINGLE_FLAG
    ? TARGETS.filter((item) => {
        return item.os === process.platform && item.arch === process.arch;
      })
    : TARGETS;

  // Task #4996: 清理上一次构建可能残留的 tmp 文件。
  // standalone 的 package.json 用 bin 目录通配收集文件，npm pack 会把 bin/ 下
  // 所有文件（含点文件）打进 tarball —— 残留的半成品 tmp 会被误发布。
  const staleTemps = await cleanupStaleTempFiles(STANDALONE_BIN_DIR);
  if (staleTemps.length > 0) {
    console.log(`  🧹 Cleaned ${staleTemps.length} stale temp file(s): ${staleTemps.join(", ")}`);
  }

  for (const item of targets) {
    const name = [
      "roy-bot",
      item.os === "win32" ? "windows" : item.os,
      item.arch,
    ].filter(Boolean).join("-");

    console.log(`Building ${name}...`);

    const outDir = path.join(PKG_ROOT, "dist", name, "bin");
    // 使用 fs.mkdir 替代 shell mkdir -p，跨平台兼容
    await mkdir(outDir, { recursive: true });

    const outfile =
      item.os === "win32"
        ? path.join(outDir, "roy-bot.exe")
        : path.join(outDir, "roy-bot");

    const targetTriple = name.replace("roy-bot", "bun") as any;

    console.log("  Mode: production (standalone executable)");

    // 使用 compile 生成独立可执行文件
    const buildResult = await Bun.build({
      conditions: ["import", "module", "default"],
      plugins: [
        solidClientResolvePlugin({ rootDir: ROOT }),
        scopedSolidTransformPlugin({
          scopeDirs: ["/packages/cli/src/tui-solid/", "/scripts/tui-solid/", "/scripts/poc-opentui-solid/"],
          resolveFrom: ROOT,
        }),
      ],
      tsconfig: path.join(PKG_ROOT, "tsconfig.json"),
      entrypoints: [path.join(PKG_ROOT, "src", "bin", "roy-bot.ts")],
      root: PKG_ROOT,
      compile: {
        target: targetTriple,
        outfile,
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: true,
        autoloadPackageJson: true,
      },
      define: {
        ROY_AGENT_VERSION: `"${VERSION}"`,
        ROY_AGENT_CHANNEL: `"${CHANNEL}"`,
      },
      sourcemap: "none",
    });

    if (!buildResult.success) {
      console.log(`  ✗ Build failed`);
      for (const log of buildResult.logs) {
        console.log(`    [${log.level}] ${log.message}`);
      }
      continue;
    }

    if (item.os !== "win32") {
      // 使用 fs.chmod 替代 shell chmod，跨平台兼容
      await chmod(outfile, 0o755);
    }

    console.log(`  ✓ Built ${outfile} (standalone executable)`);
    binaries[name] = outfile;

    // Copy to standalone package
    const standaloneBin = path.join(STANDALONE_BIN_DIR, `roy-bot-${name.replace("roy-bot-", "")}`);
    if (item.os === "win32") {
      // 使用 fs.copyFile 替代 fs.promises.copyFile
      await copyFile(outfile, standaloneBin + ".exe");
      console.log(`  → Copied to standalone: ${standaloneBin}.exe`);
    } else {
      // Task #4996: 原子替换（copyFile → 同目录 tmp → rename）。
      // 直接 copyFile 覆盖「正在被执行」的二进制会报 ETXTBSY (errno -26)——
      // deamon-for-roy 的 daemon 子进程持续执行 standalone bin，热切换链路因此被卡死。
      // rename 不受 ETXTBSY 限制：运行中的进程继续用旧 inode，新 spawn 拿新文件。
      await replaceBinaryAtomically(outfile, standaloneBin);
      console.log(`  → Copied to standalone: ${standaloneBin}`);
    }
  }

  // Summary
  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log(`Build complete! ${Object.keys(binaries).length} binaries built.`);
  console.log("");
  for (const [name, file] of Object.entries(binaries)) {
    console.log(`  ${name}: ${file}`);
  }
  console.log("═══════════════════════════════════════════");
}

// Run
build().catch(console.error);
