#!/usr/bin/env bun
/**
 * CLI 开发构建脚本
 * 
 * 特点：
 * 1. 链接 workspace 源码而非打包
 * 2. 生成外部 sourcemap，指向原始 TypeScript 文件
 * 3. 日志输出显示 .ts 源文件路径和行号
 * 
 * 使用：
 *   bun run build:cli:dev:single    # 当前平台
 *   bun run build:cli:dev           # 全平台
 */

import path from "path";
import fs from "fs";
import { cp, mkdir, rm, chmod } from "node:fs/promises";
import { $ } from "bun";
// Task #4278 R8: force `solid-js` to the CLIENT runtime at build time.
// Without this, `packages:"external"` keeps the bare `solid-js` specifier in the
// bundle, and bun resolves it via the `node` export condition → dist/server.js
// (SSR) → the whole Solid TUI is non-reactive. See R8-reactive-blocker.md.
import { solidClientResolvePlugin, scopedSolidTransformPlugin } from "./tui-solid/solid-client-resolve-plugin.ts";

const ROOT = path.resolve(".");
const PKG_ROOT = path.join(ROOT, "packages", "cli");
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8"));

const VERSION = PKG.version || "1.0.0";
const CHANNEL = process.env.CHANNEL || "dev";

const TARGETS = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "win32", arch: "x64" },
];

const binaries: Record<string, string> = {};

// 当前平台
const CURRENT_OS = process.platform;
const CURRENT_ARCH = process.arch;

async function build() {
  console.log(`🏗️  Building roy-bot CLI ${VERSION} (${CHANNEL}) [DEV MODE]`);
  console.log(`   Link workspace source, generate TypeScript sourcemaps`);
  console.log("");

  // 清理当前平台的输出
  const currentOutDir = path.join(PKG_ROOT, "dist", "dev");
  if (fs.existsSync(currentOutDir)) {
    // 使用 fs.rm 替代 shell rm -rf，跨平台兼容
    await rm(currentOutDir, { recursive: true, force: true });
  }

  // 过滤当前平台
  const targets = TARGETS.filter((item) => {
    return item.os === CURRENT_OS && item.arch === CURRENT_ARCH;
  });

  for (const item of targets) {
    const name = [
      "roy-bot",
      item.os === "win32" ? "windows" : item.os,
      item.arch,
    ].join("-");

    console.log(`Building ${name}...`);

    const outDir = path.join(PKG_ROOT, "dist", "dev", "bin");
    // 使用 fs.mkdir 替代 shell mkdir -p，跨平台兼容
    await mkdir(outDir, { recursive: true });

    const outfile =
      item.os === "win32"
        ? path.join(outDir, "roy-bot.exe")
        : path.join(outDir, "roy-bot");

    console.log("  Mode: development (link source + external sourcemap)");

    // 使用 resolveSymlinks 链接 workspace 源码
    // 使用 externalSourcemap 生成指向 .ts 文件的 sourcemap
    const buildResult = await Bun.build({
      conditions: ["import", "module", "default", "development"],
      tsconfig: path.join(PKG_ROOT, "tsconfig.json"),
      entrypoints: [path.join(PKG_ROOT, "src", "bin", "roy-bot.ts")],
      // Task #4278 R8: force solid-js → client runtime, and run the real Solid
      // JSX transform on OUR source only (see plugin docstring). Both halves are
      // required: resolve-only still renders a dead (non-reactive) UI.
      plugins: [
        solidClientResolvePlugin({ rootDir: ROOT }),
        scopedSolidTransformPlugin({
          scopeDirs: ["/packages/cli/src/tui-solid/", "/scripts/tui-solid/", "/scripts/poc-opentui-solid/"],
          resolveFrom: ROOT,
        }),
      ],
      define: {
        ROY_AGENT_VERSION: `"${VERSION}"`,
        ROY_AGENT_CHANNEL: `"${CHANNEL}"`,
      },
      // 关键：链接 workspace 源码
      resolveSymlinks: true,
      outdir: outDir,
      target: "bun",
      minify: false,
      // 关键：生成外部 sourcemap，指向原始 .ts 文件
      sourcemap: "external",
      // 不分割，保持单文件输出
      splitting: false,
      naming: "[name].js",
      // 不打包 workspace 依赖
      packages: "external",
    });

    if (!buildResult.success) {
      console.log(`  ✗ Build failed`);
      for (const log of buildResult.logs) {
        console.log(`    [${log.level}] ${log.message}`);
      }
      continue;
    }

    const outputFile = path.join(outDir, "roy-bot.js");

    if (item.os !== "win32") {
      // 使用 fs.chmod 替代 shell chmod，跨平台兼容
      await chmod(outputFile, 0o755);
    }

    console.log(`  ✓ Built ${outputFile}`);
    console.log(`  ✓ Sourcemap: ${outputFile}.map (points to .ts source files)`);
    binaries[name] = outputFile;
  }

  // 复制到 dist/bin/roy-bot.js
  console.log("");
  console.log("Copying to dist/bin/...");

  const distBinPath = path.join(PKG_ROOT, "dist", "bin");
  // 使用 fs.mkdir 替代 shell mkdir -p，跨平台兼容
  await mkdir(distBinPath, { recursive: true });

  for (const [name, file] of Object.entries(binaries)) {
    const destPath = path.join(distBinPath, "roy-bot.js");
    // 使用 fs.cp() 替代 shell cp 命令，实现跨平台兼容
    await cp(file, destPath, { force: true });

    // 复制 sourcemap
    await cp(`${file}.map`, `${destPath}.map`, { force: true });

    console.log(`  ✓ ${name} → dist/bin/roy-bot.js`);
    console.log(`  ✓ ${name}.map → dist/bin/roy-bot.js.map`);
  }

  // Summary
  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log(`Build complete! ${Object.keys(binaries).length} binaries built.`);
  console.log("");
  console.log("Usage:");
  console.log("  bun run packages/cli/dist/bin/roy-bot.js");
  console.log("  or");
  console.log("  bun run packages/cli/dist/bin/roy-bot.js act 'your query'");
  console.log("");
  console.log("Sourcemap: dist/bin/roy-bot.js.map");
  console.log("  - Debugger will show .ts source files");
  console.log("  - Stack traces will show .ts file:line");
  console.log("═══════════════════════════════════════════");
}

// Run
build().catch(console.error);
