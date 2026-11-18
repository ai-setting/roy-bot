#!/usr/bin/env bun
/**
 * Standalone 包构建脚本
 * 
 * 功能：
 * 1. 构建 CLI 二进制文件并复制到 standalone 包
 * 2. 可选：发布 standalone 到 npmjs
 * 
 * 使用：
 *   bun run scripts/build-standalone.ts              # 仅构建（当前平台）
 *   bun run scripts/build-standalone.ts --all        # 构建全平台
 *   bun run scripts/build-standalone.ts --publish    # 构建并发布
 *   bun run scripts/build-standalone.ts --all --publish  # 全平台构建并发布
 *   bun run scripts/build-standalone.ts --version 1.5.10  # 指定版本
 */

import path from "path";
import fs from "fs";
import { mkdir, chmod, copyFile } from "node:fs/promises";
// Task #4996: 原子替换（tmp + rename），避免覆盖正在被执行的二进制时 ETXTBSY。
import { cleanupStaleTempFiles, replaceBinaryAtomically } from "./atomic-bin-replace.ts";
import { $ } from "bun";
import {
  PLATFORM_BINARIES,
  buildTrimmedManifest,
  createRestoreGuard,
  partitionBinaries,
  pruneStaleBinaries,
  restorePrunedBinaries,
} from "./publish-full-helpers";
import { solidClientResolvePlugin, scopedSolidTransformPlugin } from "./tui-solid/solid-client-resolve-plugin.ts";

const ROOT = path.resolve(".");
const CLI_ROOT = path.join(ROOT, "packages", "cli");
const STANDALONE_ROOT = path.join(ROOT, "packages", "roy-bot-standalone");

// 解析命令行参数
const args = process.argv.slice(2);

// 帮助信息
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
🏗️  Standalone Build Script

用法:
  bun run scripts/build-standalone.ts [选项]

选项:
  --help, -h          显示帮助信息
  --all               构建所有平台 (linux-arm64, linux-x64, darwin-arm64, darwin-x64, windows-x64)
  --publish           构建后发布到 npmjs
  --allow-stale-binaries  允许把 bin/ 下非本次构建的旧二进制一起发布（默认排除，避免 169MB 大包 + 过期代码）
  --version <ver>     指定版本号 (默认使用 standalone package.json 中的版本)

示例:
  # 仅构建当前平台
  bun run scripts/build-standalone.ts

  # 构建所有平台
  bun run scripts/build-standalone.ts --all

  # 构建并发布到 npmjs
  bun run scripts/build-standalone.ts --publish

  # 指定版本并发布
  bun run scripts/build-standalone.ts --version 1.5.11 --publish

npm 脚本:
  pnpm run build:standalone          # 当前平台构建
  pnpm run build:standalone:all     # 全平台构建
  pnpm run build:standalone:publish  # 构建并发布
  pnpm run build:standalone:all:publish  # 全平台构建并发布
`);
  process.exit(0);
}

const PUBLISH_FLAG = args.includes("--publish");
const ALL_FLAG = args.includes("--all");
const ALLOW_STALE_BINARIES = args.includes("--allow-stale-binaries");

// 构建开始时间：用于区分「本次构建」和 bin/ 里残留的历史二进制
const BUILD_STARTED_AT = Date.now();

// 解析版本号参数
const versionIndex = args.indexOf("--version");
const CLI_PKG = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, "package.json"), "utf-8"));
const STANDALONE_PKG = JSON.parse(fs.readFileSync(path.join(STANDALONE_ROOT, "package.json"), "utf-8"));

// CLI 版本优先使用命令行参数，其次使用 standalone package.json 的版本
const DEFAULT_VERSION = STANDALONE_PKG.version || CLI_PKG.version || "1.0.0";
const TARGET_VERSION = versionIndex !== -1 && args[versionIndex + 1] 
  ? args[versionIndex + 1] 
  : DEFAULT_VERSION;

const CHANNEL = process.env.CHANNEL || "prod";

const TARGETS = [
  { os: "linux", arch: "arm64", name: "linux-arm64" },
  { os: "linux", arch: "x64", name: "linux-x64" },
  { os: "darwin", arch: "arm64", name: "darwin-arm64" },
  { os: "darwin", arch: "x64", name: "darwin-x64" },
  { os: "win32", arch: "x64", name: "windows-x64" },
];

const builtBinaries: string[] = [];

async function buildPlatform(target: typeof TARGETS[0]) {
  const { os, arch, name } = target;
  
  console.log(`\n📦 Building roy-bot-${name}...`);
  
  const outDir = path.join(CLI_ROOT, "dist", name, "bin");
  // 使用 fs.mkdir 替代 shell mkdir -p，跨平台兼容
  await mkdir(outDir, { recursive: true });
  
  const outfile = os === "win32"
    ? path.join(outDir, "roy-bot.exe")
    : path.join(outDir, "roy-bot");
  
  const targetTriple = `bun-${os}-${arch}`;
  
  const buildResult = await Bun.build({
    conditions: ["import", "module", "default"],
    plugins: [
      solidClientResolvePlugin({ rootDir: ROOT }),
      scopedSolidTransformPlugin({
        scopeDirs: ["/packages/cli/src/tui-solid/", "/scripts/tui-solid/", "/scripts/poc-opentui-solid/"],
        resolveFrom: ROOT,
      }),
    ],
    tsconfig: path.join(CLI_ROOT, "tsconfig.json"),
    entrypoints: [path.join(CLI_ROOT, "src", "bin", "roy-bot.ts")],
    root: CLI_ROOT,
    compile: {
      target: targetTriple as any,
      outfile,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
    },
    define: {
      ROY_AGENT_VERSION: `"${TARGET_VERSION}"`,
      ROY_AGENT_CHANNEL: `"${CHANNEL}"`,
    },
    sourcemap: "none",
  });
  
  if (!buildResult.success) {
    console.log(`  ✗ Build failed`);
    for (const log of buildResult.logs) {
      console.log(`    [${log.level}] ${log.message}`);
    }
    return false;
  }
  
  if (os !== "win32") {
    // 使用 fs.chmod 替代 shell chmod，跨平台兼容
    await chmod(outfile, 0o755);
  }
  
  // Copy to standalone package
  const standaloneBinDir = path.join(STANDALONE_ROOT, "bin");
  // 使用 fs.mkdir 替代 shell mkdir -p，跨平台兼容
  await mkdir(standaloneBinDir, { recursive: true });

  // Task #4996: 清理上一次构建可能残留的 tmp 文件。
  // standalone 的 package.json 用 bin 目录通配收集文件，npm pack 会把 bin/ 下
  // 所有文件（含点文件）打进 tarball —— 残留的半成品 tmp 会被误发布。
  const staleTemps = await cleanupStaleTempFiles(standaloneBinDir);
  if (staleTemps.length > 0) {
    console.log(`  🧹 Cleaned ${staleTemps.length} stale temp file(s): ${staleTemps.join(", ")}`);
  }
  
  const destFile = os === "win32"
    ? path.join(standaloneBinDir, `roy-bot-${name}.exe`)
    : path.join(standaloneBinDir, `roy-bot-${name}`);
  
  if (os === "win32") {
    // win32 保守保持原 copyFile 行为
    await copyFile(outfile, destFile);
  } else {
    // Task #4996: 原子替换（copyFile → 同目录 tmp → rename）。
    // 直接 copyFile 覆盖「正在被执行」的二进制会报 ETXTBSY (errno -26)——
    // deamon-for-roy 的 daemon 子进程持续执行 standalone bin，热切换链路因此被卡死。
    await replaceBinaryAtomically(outfile, destFile);
  }
  
  console.log(`  ✓ Built and copied to standalone`);
  builtBinaries.push(name);
  
  return true;
}

async function updateStandaloneVersion() {
  // 更新 standalone package.json 的版本
  STANDALONE_PKG.version = TARGET_VERSION;
  await fs.promises.writeFile(
    path.join(STANDALONE_ROOT, "package.json"),
    JSON.stringify(STANDALONE_PKG, null, 2) + "\n",
    "utf-8"
  );
  console.log(`\n📝 Updated standalone version to ${TARGET_VERSION}`);
}

async function publishStandalone() {
  console.log(`\n🚀 Publishing @ai-setting/roy-bot-standalone@${TARGET_VERSION} to npmjs...`);

  // bin/ 是跨版本累积目录，package.json 的 files 通配会把所有二进制都打包。
  // 如果这里直接 npm publish，就会把本次没构建的旧二进制一起发出去（169MB+，且是过期代码）。
  const binDir = path.join(STANDALONE_ROOT, "bin");
  const mtimes: Record<string, number | undefined> = {};
  for (const platform of PLATFORM_BINARIES) {
    const filePath = path.join(binDir, platform.file);
    mtimes[platform.file] = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : undefined;
  }
  const { fresh, stale } = partitionBinaries(mtimes, BUILD_STARTED_AT);

  if (fresh.length === 0) {
    console.log(`\n❌ bin/ 下没有任何本次构建的二进制，拒绝发布过期产物。`);
    return false;
  }

  console.log(`   本次构建: ${fresh.map(f => f.tag).join(", ")}`);
  if (stale.length > 0 && !ALLOW_STALE_BINARIES) {
    console.log(`   ⚠️  检测到 ${stale.length} 个非本次构建的旧二进制，将从本次发布中排除:`);
    for (const s of stale) {
      console.log(`      - bin/${s.file}  构建于 ${new Date(mtimes[s.file]!).toISOString()}`);
    }
  } else if (stale.length > 0) {
    console.log(`   ⚠️  --allow-stale-binaries 已开启，${stale.length} 个旧二进制会一起发布（tarball 会很大）`);
  }

  const publishPlatforms = ALLOW_STALE_BINARIES ? [...fresh, ...stale] : fresh;
  const pkgJsonPath = path.join(STANDALONE_ROOT, "package.json");
  const originalManifest = fs.readFileSync(pkgJsonPath, "utf-8");
  const trimmed = buildTrimmedManifest(STANDALONE_PKG, publishPlatforms);

  const holdingDir = path.join(STANDALONE_ROOT, ".stale-binaries");
  let movedFiles: string[] = [];
  let published = false;

  // 还原动作必须幂等：finally 和信号中断都会调用它。
  const restore = () => {
    const errors: string[] = [];

    // 两步各自独立 try：manifest 写失败也必须继续把二进制搬回去（反之亦然）。
    try {
      fs.writeFileSync(pkgJsonPath, originalManifest, "utf-8");
    } catch (err) {
      errors.push(`manifest 还原失败 (${pkgJsonPath}): ${(err as Error).message}`);
    }

    let leftovers: string[] = [];
    try {
      leftovers = restorePrunedBinaries(binDir, holdingDir, movedFiles).leftovers;
      movedFiles = [];
    } catch (err) {
      errors.push(`二进制还原失败: ${(err as Error).message}`);
    }

    if (errors.length > 0) {
      console.log(`\n❌ 还原过程中出现错误，请手动检查:\n  ${errors.join("\n  ")}`);
    }

    if (leftovers.length > 0) {
      console.log(
        `\n⚠️  ${holdingDir} 里仍残留 ${leftovers.length} 个文件（很可能是之前被中断的发布留下的）:\n` +
          leftovers.map(f => `   - ${f}`).join("\n") +
          `\n   已保留未删除，请人工确认后移回 bin/ 或删除。`
      );
    }
  };

  // Bun/Node 收到 SIGINT 不会展开调用栈，finally 会被跳过；
  // 而发布窗口可能长达十几分钟。这里注册信号处理，先还原再退出。
  const guard = createRestoreGuard(restore);

  try {
    // ---- 从这里开始修改仓库状态 ----
    fs.writeFileSync(pkgJsonPath, JSON.stringify(trimmed, null, 2) + "\n", "utf-8");
    console.log(
      `   manifest 已裁剪: files=${trimmed.files.length} 项, os=[${trimmed.os.join(",")}], cpu=[${trimmed.cpu.join(",")}]`
    );

    if (!ALLOW_STALE_BINARIES) {
      movedFiles = pruneStaleBinaries(binDir, stale, holdingDir);
      if (movedFiles.length > 0) {
        console.log(`   已临时移出 ${movedFiles.length} 个旧二进制 → ${holdingDir}`);
      }
    }

    const result = await $`cd ${STANDALONE_ROOT} && npm publish --access public --registry https://registry.npmjs.org/`.text();
    published = true;
    console.log(`\n✅ Published successfully!`);
    console.log(result);
  } catch (error: any) {
    console.log(`\n❌ Publish failed:`);
    console.log(error.stdout || error.message);
  } finally {
    guard.dispose();
    // runRestore 幂等且内部吞异常，保证不会掩盖原始错误
    guard.runRestore();
    // 只有真正没被信号打断的路径才会走到这里
    if (!published) return false;
  }

  return true;
}

async function verifyVersion() {
  console.log(`\n🔍 Verifying version...`);
  
  // 检查 standalone binary 版本
  const binaryPath = path.join(STANDALONE_ROOT, "bin", `roy-bot-${process.platform}-${process.arch}`);
  const actualBinary = fs.existsSync(binaryPath) ? binaryPath : 
    (fs.existsSync(binaryPath + ".exe") ? binaryPath + ".exe" : null);
  
  if (actualBinary) {
    // 简单验证：检查二进制文件大小（构建后应该有变化）
    const stats = await fs.promises.stat(actualBinary);
    console.log(`  Binary size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  }
  
  console.log(`  Package version: ${TARGET_VERSION}`);
  console.log(`  Expected binary version: ${TARGET_VERSION}`);
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🏗️  Standalone Build Script`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Version:  ${TARGET_VERSION}`);
  console.log(`  Channel:  ${CHANNEL}`);
  console.log(`  Platforms: ${ALL_FLAG ? "all" : "current"}`);
  console.log(`  Publish:   ${PUBLISH_FLAG ? "yes" : "no"}`);
  console.log("───────────────────────────────────────────────────────────────");
  
  // 确定要构建的平台
  const targets = ALL_FLAG 
    ? TARGETS 
    : TARGETS.filter(t => t.os === process.platform && t.arch === process.arch);
  
  if (targets.length === 0) {
    console.log(`\n⚠️  No matching platform found for current system (${process.platform}-${process.arch})`);
    console.log(`    Use --all to build all platforms`);
    process.exit(1);
  }
  
  // 更新版本号
  await updateStandaloneVersion();
  
  // 构建每个平台
  // Task #4278 片7 (R7): make sure all native bindings are resolvable before
  // a cross-compile (bun cannot bundle a statically-imported module that is
  // absent from node_modules).
  if (targets.length > 1) {
    const ready = await ensureOpentuiNativePackages();
    if (!ready) {
      console.log(
        "\n⚠️  Missing @opentui native packages — run:\n" +
          "    bun run scripts/tui-solid/ensure-opentui-native-packages.ts\n",
      );
      process.exit(1);
    }
  }

  console.log(`\n📦 Building ${targets.length} platform(s)...`);
  
  for (const target of targets) {
    await buildPlatform(target);
  }
  
  // 验证
  await verifyVersion();
  
  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`✅ Build complete! ${builtBinaries.length} binary(ies) built.`);
  console.log(`   Platforms: ${builtBinaries.join(", ") || "none"}`);
  console.log("───────────────────────────────────────────────────────────────");
  
  // 发布
  if (PUBLISH_FLAG) {
    console.log("\n🚀 Starting publish...");
    const success = await publishStandalone();
    
    if (!success) {
      console.log("\n❌ Publish failed. Please check the error above.");
      process.exit(1);
    }
  } else {
    console.log("\n💡 To publish, run with --publish flag:");
    console.log(`   bun run scripts/build-standalone.ts --publish`);
  }
  
  console.log("\n═══════════════════════════════════════════════════════════════");
}

// Run
main().catch((err) => {
  console.error("\n❌ Unexpected error:", err);
  process.exit(1);
});
