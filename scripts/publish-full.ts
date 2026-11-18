#!/usr/bin/env bun

/**
 * 完整的构建发布脚本
 *
 * 流程：
 * 1. 替换 workspace 依赖为具体版本
 * 2. 构建 SDK 包
 * 3. 构建 standalone 二进制
 * 4. 发布 core（无依赖）
 * 5. 发布 coder（依赖 core，等待传播）
 * 6. 发布 ontology（依赖 core，等待传播）
 * 7. 发布 cli（依赖 core + coder + ontology，等待传播）
 * 8. 发布 standalone（二进制，无需依赖修改）
 * 9. 验证安装测试（集成测试）：预检 npm view → npm install → 集成测试
 * 10. 恢复 workspace 依赖
 *
 * 使用：
 *   bun run scripts/publish-full.ts --dry-run         # 模拟运行
 *   bun run scripts/publish-full.ts --skip-verify     # 跳过验证测试
 *   bun run scripts/publish-full.ts --test-only      # 仅运行验证测试（使用本地构建）
 *   bun run scripts/publish-full.ts --verify-npm     # 仅验证 npmjs 已发布版本
 *   bun run scripts/publish-full.ts --verify-only    # 仅运行验证（不发布）
 *   bun run scripts/publish-full.ts                  # 正式发布
 *
 * 其它开关：
 *   --allow-stale-binaries          允许发布 bin/ 下非本次构建的旧二进制（默认排除，避免 169MB 大包 + 过期代码）
 *   --registry-timeout=<seconds>    standalone 发布后等待 registry 出现的上限（默认 1500s）
 *
 * standalone 发布规则：
 * - bin/ 是跨版本累积目录，只发布「本次构建」的平台（见 publish-full-helpers.ts）
 * - manifest 的 files / os / cpu / bin 会按实际发布的平台动态裁剪
 * - --dry-run 会打印裁剪后的 manifest 与 npm pack 预览，不写 registry
 *
 * 验证策略：
 * - 预检：`npm view @pkg@version version` 检查每个版本是否在 registry 上
 * - 安装：`npm install` 跑完整集成测试
 * - 智能重试：仅对 registry 传播错误（ETARGET/E404/503）重试，指数退避
 * - standalone 独立验证（无依赖，可以独立检查 staged→latest promotion）
 */

import { $ } from "bun";
import { 
  cpSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync
} from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import {
  PLATFORM_BINARIES,
  partitionBinaries,
  buildTrimmedManifest,
  createRestoreGuard,
  currentPlatformTag,
  parseFlagValue,
  parsePlatformList,
  parseRegistryTimeoutSec,
  pruneStaleBinaries,
  restorePrunedBinaries,
  type PlatformBinary,
} from "./publish-full-helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

// ============================================================
// 类型定义
// ============================================================

interface Package {
  name: string;
  dir: string;
  dependencies: string[];
}

interface PublishOptions {
  dryRun: boolean;
  tag: string;
  skipVerify: boolean;
  testOnly: boolean;
  verifyNpm: boolean;
  verifyOnly: boolean;
  /** 允许把 bin/ 下非本次构建的旧二进制一起发布（默认排除，避免包体积爆炸 + 发布过期代码） */
  allowStaleBinaries: boolean;
  /** standalone 发布后等待 registry 出现的上限（秒） */
  registryTimeoutSec: number;
  /** 要构建并发布的 standalone 平台（逗号分隔标签，默认当前平台） */
  platforms: PlatformBinary[];
}

// ============================================================
// 常量配置
// ============================================================

const PACKAGES: Package[] = [
  { 
    name: "@ai-setting/roy-bot-core", 
    dir: "packages/core",
    dependencies: [] 
  },
  { 
    name: "@ai-setting/roy-bot-coder-harness", 
    dir: "packages/coder-harness",
    dependencies: ["@ai-setting/roy-bot-core"]
  },
  {
    name: "@ai-setting/roy-bot-ontology-harness",
    dir: "packages/ontology-harness",
    dependencies: ["@ai-setting/roy-bot-core"]
  },
  { 
    name: "@ai-setting/roy-bot-cli", 
    dir: "packages/cli",
    dependencies: ["@ai-setting/roy-bot-core", "@ai-setting/roy-bot-coder-harness", "@ai-setting/roy-bot-ontology-harness"]
  },
  { 
    name: "@ai-setting/roy-bot-standalone", 
    dir: "packages/roy-bot-standalone",
    dependencies: []
  },
];

const PROPAGATION_WAIT = 15_000;             // 包间传播等待（依赖注册到 CDN）
const STAGED_PROMOTE_WAIT = 30_000;         // npm staged → latest tag promote 等待
const VERIFY_INITIAL_DELAY = 5_000;         // 验证前初始等待（新增）
const VERIFY_RETRY_BASE_MS = 15_000;        // 验证重试基础间隔
const VERIFY_RETRY_MAX_MS = 60_000;         // 验证重试间隔上限（指数退避）
const MAX_VERIFY_RETRIES = 8;               // 验证重试次数（80s → 最长 ~6min）

// standalone tarball 体积大（单平台 ~40MB，多平台 ~170MB），
// npm PUT 返回 202 后后台处理 + CDN 传播可能长达 20 分钟以上，
// 所以单独给它一个更长、带进度输出的等待窗口。
const REGISTRY_POLL_INTERVAL_MS = 20_000;
const DEFAULT_STANDALONE_REGISTRY_TIMEOUT_SEC = 25 * 60;

// 平台二进制清单 / manifest 裁剪逻辑见 publish-full-helpers.ts（纯函数，有单测）
// 由 buildStandalone() 写入：本次构建开始的时间戳（ms）
let standaloneBuildStartedAt = 0;

// ============================================================
// 日志工具
// ============================================================

function log(msg: string, type: "info" | "success" | "warn" | "error" = "info") {
  const prefix = { info: "📋", success: "✅", warn: "⚠️", error: "❌" };
  console.log(`${prefix[type]} ${msg}`);
}

function logSection(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

// ============================================================
// 文件操作
// ============================================================

function getPackageJson(dir: string): any {
  const path = join(rootDir, dir, "package.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

function setPackageJson(dir: string, pkg: any): void {
  const path = join(rootDir, dir, "package.json");
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
}

function backupPackageJson(dir: string): void {
  const src = join(rootDir, dir, "package.json");
  const backup = join(rootDir, dir, "package.json.bak");
  cpSync(src, backup);
  log(`Backed up: ${dir}/package.json`, "info");
}

function restorePackageJson(dir: string): void {
  const src = join(rootDir, dir, "package.json");
  const backup = join(rootDir, dir, "package.json.bak");
  if (existsSync(backup)) {
    cpSync(backup, src);
    rmSync(backup, { force: true });
    log(`Restored: ${dir}/package.json`, "info");
  }
}

function cleanupBackups(): void {
  for (const pkg of PACKAGES) {
    const backup = join(rootDir, pkg.dir, "package.json.bak");
    if (existsSync(backup)) {
      rmSync(backup, { force: true });
    }
  }
}

// ============================================================
// 依赖替换
// ============================================================

function replaceWorkspaceDeps(pkg: any, versions: Map<string, string>): any {
  const updated = JSON.parse(JSON.stringify(pkg));
  
  for (const [depName, version] of versions) {
    if (updated.dependencies && updated.dependencies[depName] === "workspace:*") {
      updated.dependencies[depName] = `^${version}`;
      log(`${pkg.name}: ${depName} "workspace:*" → "^${version}"`, "info");
    }
    if (updated.peerDependencies && updated.peerDependencies[depName] === "workspace:*") {
      updated.peerDependencies[depName] = `^${version}`;
      log(`${pkg.name}: ${depName} (peer) "workspace:*" → "^${version}"`, "info");
    }
  }
  
  return updated;
}

// ============================================================
// NPM 操作
// ============================================================

async function fetchNpmInfo(pkgName: string, version?: string): Promise<any> {
  const encodedName = pkgName.replace("/", "%2f");
  const url = version 
    ? `https://registry.npmjs.org/${encodedName}/${version}`
    : `https://registry.npmjs.org/${encodedName}`;
  try {
    const result = await $`curl -s "${url}"`.text();
    return JSON.parse(result);
  } catch {
    return null;
  }
}

async function checkNpmVersion(pkgName: string, version: string): Promise<boolean> {
  const encodedName = pkgName.replace("/", "%2f");
  const url = `https://registry.npmjs.org/${encodedName}/${version}`;
  try {
    const result = await $`curl -s -o /dev/null -w "%{http_code}" "${url}"`.text();
    return result.trim() === "200";
  } catch {
    return false;
  }
}

async function publishToNpm(dir: string, tag: string): Promise<void> {
  const pkgPath = join(rootDir, dir);
  const pkgJson = getPackageJson(dir);
  const sizeHint = dir.includes("standalone") ? "（standalone 包很大，上传 + npm 后台处理可能要十几分钟）" : "";
  log(`Running: npm publish --access public --tag ${tag} @ ${pkgJson.name}@${pkgJson.version} ${sizeHint}`, "info");
  // 注意：这里不能用 .quiet()，否则 npm 的进度/错误全被吞掉，
  // 看起来就像脚本卡死在上一行日志上。
  const result = await $`cd ${pkgPath} && npm publish --access public --tag ${tag}`.nothrow();
  if (result.exitCode !== 0) {
    console.error(String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim());
    throw new Error(`npm publish 失败 (${pkgJson.name}@${pkgJson.version}), exit ${result.exitCode}`);
  }
}

/**
 * 轮询 registry，直到某个版本出现（带可见进度）。
 * npm 对大 tarball 会先返回 202 再后台处理，期间 registry 上是查不到的。
 */
async function waitForVersionOnRegistry(
  pkgName: string,
  version: string,
  timeoutMs: number,
  label: string
): Promise<boolean> {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    attempt++;
    if (await checkNpmVersion(pkgName, version)) {
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      log(`${label}: ${pkgName}@${version} 已出现在 registry 上（等待 ${secs}s）`, "success");
      return true;
    }
    const waited = Math.round((Date.now() - started) / 1000);
    if (Date.now() - started >= timeoutMs) {
      log(
        `${label}: 等待 ${waited}s 后 ${pkgName}@${version} 仍未出现在 registry 上（上限 ${Math.round(timeoutMs / 1000)}s）`,
        "warn"
      );
      return false;
    }
    log(
      `⏳ ${label}: ${pkgName}@${version} 还没出现（已等 ${waited}s / 上限 ${Math.round(timeoutMs / 1000)}s，第 ${attempt} 次检查）...`,
      "warn"
    );
    await new Promise(r => setTimeout(r, REGISTRY_POLL_INTERVAL_MS));
  }
}

// ============================================================
// 构建
// ============================================================

async function cleanDist(dir: string): Promise<void> {
  const distPath = join(rootDir, dir, "dist");
  if (existsSync(distPath)) {
    rmSync(distPath, { recursive: true, force: true });
  }
}

async function updateWorkspaceDeps(versions: Map<string, string>): Promise<void> {
  logSection("替换 workspace 依赖为具体版本");
  
  const coderPkg = getPackageJson("packages/coder-harness");
  const updatedCoder = replaceWorkspaceDeps(coderPkg, versions);
  setPackageJson("packages/coder-harness", updatedCoder);
  
  const ontologyPkg = getPackageJson("packages/ontology-harness");
  const updatedOntology = replaceWorkspaceDeps(ontologyPkg, versions);
  setPackageJson("packages/ontology-harness", updatedOntology);
  
  const cliPkg = getPackageJson("packages/cli");
  const updatedCli = replaceWorkspaceDeps(cliPkg, versions);
  setPackageJson("packages/cli", updatedCli);
}

async function buildAllSdk(): Promise<void> {
  logSection("构建 SDK 包");
  
  for (const pkg of PACKAGES.slice(0, 4)) {
    await cleanDist(pkg.dir);
  }
  
  log("Running: pnpm run build", "info");
  await $`cd ${rootDir} && pnpm run build`.quiet();
  
  for (const pkg of PACKAGES.slice(0, 4)) {
    const indexPath = join(rootDir, pkg.dir, "dist", "index.js");
    if (!existsSync(indexPath)) {
      throw new Error(`Build failed: ${indexPath} not found`);
    }
    log(`Verified: ${pkg.name}/dist/index.js`, "success");
  }
}

async function buildStandalone(): Promise<void> {
  logSection("构建 Standalone 二进制");
  
  await cleanDist("packages/roy-bot-standalone");
  
  // 记录构建开始时间：publishStandalone 用它区分「本次构建的二进制」和 bin/ 里残留的旧产物
  standaloneBuildStartedAt = Date.now();
  log(`构建开始时间戳: ${new Date(standaloneBuildStartedAt).toISOString()}`, "info");
  
  // 目标平台决定构建命令：全平台要交叉编译（不带 --single）；
  // 单平台用 --single。注意这里必须和 platforms 保持一致，
  // 否则「声称要发 5 个平台、实际只构建当前平台」→ 其余 4 个 mtime 更旧 → 被判 stale 排除。
  // --single 只编译当前平台；只有「恰好只请求当前平台」时才能用它，
  // 否则（多平台 / 请求了非当前平台）必须走全平台交叉编译。
  const onlyCurrentPlatform =
    options.platforms.length === 1 && options.platforms[0].tag === currentPlatformTag();
  log(`目标平台: ${options.platforms.map(p => p.tag).join(", ")}`, "info");
  log(`Running: bun run build:cli:prod${onlyCurrentPlatform ? " --single" : ""}`, "info");
  if (onlyCurrentPlatform) {
    await $`cd ${rootDir} && bun run build:cli:prod --single`.quiet();
  } else {
    await $`cd ${rootDir} && bun run build:cli:prod`.quiet();
  }
  
  const binDir = join(rootDir, "packages", "roy-bot-standalone", "bin");
  if (!existsSync(binDir)) {
    throw new Error(`Standalone bin directory not found: ${binDir}`);
  }
  
  const files = await $`ls -la ${binDir}`.text();
  log(`Binary files:\n${files}`, "success");
}

// ============================================================
// 发布流程
// ============================================================

async function publishCore(options: PublishOptions, versions: Map<string, string>): Promise<void> {
  logSection("发布 Core");
  
  const pkg = PACKAGES[0];
  const pkgJson = getPackageJson(pkg.dir);
  const version = pkgJson.version;
  
  log(`Version: ${version}`, "info");
  
  if (await checkNpmVersion(pkg.name, version)) {
    log(`${pkg.name}@${version} 已存在，跳过发布`, "warn");
    versions.set(pkg.name, version);
    return;
  }
  
  if (options.dryRun) {
    log(`[DRY RUN] Would publish ${pkg.name}@${version}`, "warn");
    versions.set(pkg.name, version);
    return;
  }
  
  await publishToNpm(pkg.dir, options.tag);
  versions.set(pkg.name, version);
  log(`Published: ${pkg.name}@${version}`, "success");
}

async function publishCoder(options: PublishOptions, versions: Map<string, string>): Promise<void> {
  logSection("发布 Coder Harness");
  
  const pkg = PACKAGES[1];
  const pkgJson = getPackageJson(pkg.dir);
  const updatedPkg = replaceWorkspaceDeps(pkgJson, versions);
  setPackageJson(pkg.dir, updatedPkg);
  
  const version = updatedPkg.version;
  log(`Version: ${version}`, "info");
  
  if (await checkNpmVersion(pkg.name, version)) {
    log(`${pkg.name}@${version} 已存在，跳过发布`, "warn");
    versions.set(pkg.name, version);
    restorePackageJson(pkg.dir);
    return;
  }
  
  if (options.dryRun) {
    log(`[DRY RUN] Would publish ${pkg.name}@${version}`, "warn");
    versions.set(pkg.name, version);
    restorePackageJson(pkg.dir);
    return;
  }
  
  log(`等待 core 传播... (${PROPAGATION_WAIT / 1000}s)`, "info");
  await new Promise(r => setTimeout(r, PROPAGATION_WAIT));
  
  await publishToNpm(pkg.dir, options.tag);
  versions.set(pkg.name, version);
  log(`Published: ${pkg.name}@${version}`, "success");
  
  restorePackageJson(pkg.dir);
}

async function publishOntology(options: PublishOptions, versions: Map<string, string>): Promise<void> {
  logSection("发布 Ontology Harness");
  
  const pkg = PACKAGES[2];
  const pkgJson = getPackageJson(pkg.dir);
  const updatedPkg = replaceWorkspaceDeps(pkgJson, versions);
  setPackageJson(pkg.dir, updatedPkg);
  
  const version = updatedPkg.version;
  log(`Version: ${version}`, "info");
  
  if (await checkNpmVersion(pkg.name, version)) {
    log(`${pkg.name}@${version} 已存在，跳过发布`, "warn");
    versions.set(pkg.name, version);
    restorePackageJson(pkg.dir);
    return;
  }
  
  if (options.dryRun) {
    log(`[DRY RUN] Would publish ${pkg.name}@${version}`, "warn");
    versions.set(pkg.name, version);
    restorePackageJson(pkg.dir);
    return;
  }
  
  log(`等待 ontology 传播... (${PROPAGATION_WAIT / 1000}s)`, "info");
  await new Promise(r => setTimeout(r, PROPAGATION_WAIT));
  
  await publishToNpm(pkg.dir, options.tag);
  versions.set(pkg.name, version);
  log(`Published: ${pkg.name}@${version}`, "success");
  
  restorePackageJson(pkg.dir);
}

async function publishCli(options: PublishOptions, versions: Map<string, string>): Promise<void> {
  logSection("发布 CLI SDK");
  
  const pkg = PACKAGES[3];
  const pkgJson = getPackageJson(pkg.dir);
  const updatedPkg = replaceWorkspaceDeps(pkgJson, versions);
  setPackageJson(pkg.dir, updatedPkg);
  
  const version = updatedPkg.version;
  log(`Version: ${version}`, "info");
  
  if (await checkNpmVersion(pkg.name, version)) {
    log(`${pkg.name}@${version} 已存在，跳过发布`, "warn");
    versions.set(pkg.name, version);
    restorePackageJson(pkg.dir);
    return;
  }
  
  if (options.dryRun) {
    log(`[DRY RUN] Would publish ${pkg.name}@${version}`, "warn");
    versions.set(pkg.name, version);
    restorePackageJson(pkg.dir);
    return;
  }
  
  log(`等待 coder 传播... (${PROPAGATION_WAIT / 1000}s)`, "info");
  await new Promise(r => setTimeout(r, PROPAGATION_WAIT));
  
  await publishToNpm(pkg.dir, options.tag);
  versions.set(pkg.name, version);
  log(`Published: ${pkg.name}@${version}`, "success");
  
  restorePackageJson(pkg.dir);
}

/**
 * 验证 standalone 二进制内嵌的版本号是否与 package.json 一致。
 * Task #2687: 防止发布时二进制未重新构建导致版本号不匹配。
 */
async function verifyStandaloneBinaryVersion(expectedVersion: string): Promise<void> {
  const binPath = join(rootDir, "packages", "roy-bot-standalone", "bin", `roy-bot-${process.platform}-${process.arch}`);
  
  if (!existsSync(binPath)) {
    throw new Error(
      `Standalone binary not found: ${binPath}\n` +
      `This means buildStandalone() did not produce the expected binary.\n` +
      `Run 'bun run build:cli:prod --single' manually to diagnose.`
    );
  }
  
  // Bun.build compile 模式会把 package.json 内联进二进制，格式为:
  //   name: "@ai-setting/roy-bot-cli",
  //   version: "x.y.z",
  // 我们搜索紧随 roy-bot-cli name 之后的 version 字段
  const grepResult = await $`strings ${binPath} | grep -A1 '@ai-setting/roy-bot-cli' | grep 'version:' | head -1`.text();
  // 从 "  version: "1.6.41"," 中提取版本号
  const match = grepResult.match(/version:\s*"([0-9]+\.[0-9]+\.[0-9]+)"/);
  const binaryVersion = match ? match[1] : "";
  
  if (!binaryVersion) {
    throw new Error(
      `Could not extract version from binary: ${binPath}\n` +
      `The binary may be corrupted or built with an incompatible toolchain.`
    );
  }
  
  if (binaryVersion !== expectedVersion) {
    throw new Error(
      `Binary version mismatch!\n` +
      `  package.json version: ${expectedVersion}\n` +
      `  binary embedded version: ${binaryVersion}\n` +
      `\n` +
      `This means the binary was NOT rebuilt after the version bump.\n` +
      `The published package would contain a stale binary.\n` +
      `\n` +
      `Fix: Run 'bun run build:cli:prod --single' to rebuild the binary, then retry publish.`
    );
  }
  
  log(`Binary version verified: ${binaryVersion} ✓`, "success");
}

/**
 * 验证 standalone 二进制是否包含最新的 TUI 代码。
 * Task #2687: 防止发布旧 TUI 代码。
 */
async function verifyStandaloneBinaryTui(): Promise<void> {
  const binPath = join(rootDir, "packages", "roy-bot-standalone", "bin", `roy-bot-${process.platform}-${process.arch}`);
  
  if (!existsSync(binPath)) {
    throw new Error(`Standalone binary not found: ${binPath}`);
  }
  
  // Bun.build compile 会保留源文件路径注释，格式如: // packages/cli/src/tui/App.tsx
  const tuiMarkers = [
    "tui/App.tsx",
    "tui/StatusBar.tsx",
    "tui/Markdown.tsx",
    "tui/welcome-card.ts",
  ];
  
  const stringsOutput = await $`strings ${binPath} | grep -E "tui/(App|StatusBar|Markdown|welcome-card)" || true`.text();
  
  const missingMarkers = tuiMarkers.filter(marker => !stringsOutput.includes(marker));
  
  if (missingMarkers.length > 0) {
    throw new Error(
      `Binary is missing new TUI code!\n` +
      `  Missing markers: ${missingMarkers.join(", ")}\n` +
      `\n` +
      `This means the binary was built from old source code without the tui/ directory.\n` +
      `The published package would have the old TUI.\n` +
      `\n` +
      `Fix: Run 'bun run build:cli:prod --single' to rebuild the binary, then retry publish.`
    );
  }
  
  log(`Binary TUI code verified: ${tuiMarkers.length} markers found ✓`, "success");
}

async function publishStandalone(options: PublishOptions, versions: Map<string, string>): Promise<void> {
  logSection("发布 Standalone 二进制");
  
  const pkg = PACKAGES[4];
  const pkgJsonPath = join(rootDir, pkg.dir, "package.json");
  const pkgJson = getPackageJson(pkg.dir);
  
  // standalone 使用自己的版本（不再同步 cli 版本）
  const version = pkgJson.version;
  log(`Version: ${version}`, "info");
  
  if (await checkNpmVersion(pkg.name, version)) {
    log(`${pkg.name}@${version} 已存在，跳过发布`, "warn");
    versions.set(pkg.name, version);
    return;
  }
  
  // Task #2687: 发布前验证二进制版本号和 TUI 代码
  // 防止发布未重新构建的旧二进制
  log("验证二进制版本号...", "info");
  await verifyStandaloneBinaryVersion(version);
  
  log("验证二进制 TUI 代码...", "info");
  await verifyStandaloneBinaryTui();
  
  // ----------------------------------------------------------
  // 只发布「本次构建」出来的平台二进制
  //
  // 背景：bin/ 目录是跨版本累积的（build:cli:prod --single 只写当前平台），
  // 而 package.json 的 files: ["bin/**/*"] 会把目录下所有二进制都打进 tarball。
  // 结果：单平台发布也会产出 170MB+ 的包，且把几个月前的旧二进制发给 mac/win 用户。
  // ----------------------------------------------------------
  const binDir = join(rootDir, pkg.dir, "bin");
  const mtimes: Record<string, number | undefined> = {};
  for (const platform of PLATFORM_BINARIES) {
    const filePath = join(binDir, platform.file);
    mtimes[platform.file] = existsSync(filePath) ? statSync(filePath).mtimeMs : undefined;
  }
  const { fresh, stale } = partitionBinaries(mtimes, standaloneBuildStartedAt);
  
  // requested 里的平台必须有本次构建的产物，否则说明「请求要发但没构建出来」。
  const requestedTags = new Set(options.platforms.map(p => p.tag));
  const freshTags = new Set(fresh.map(p => p.tag));
  const missing = [...requestedTags].filter(t => !freshTags.has(t));
  if (missing.length > 0) {
    throw new Error(
      `下列平台的二进制不是本次构建产生的（缺失或过期）: ${missing.join(", ")}\n` +
        `  本次构建开始时间: ${standaloneBuildStartedAt > 0 ? new Date(standaloneBuildStartedAt).toISOString() : "(未记录)"}\n` +
        `  bin 目录: ${binDir}\n` +
        `  请检查构建命令是否覆盖了这些平台（单平台用 --single，多平台用不带 --single 的交叉编译）。`
    );
  }
  
  const publishPlatforms: PlatformBinary[] = options.allowStaleBinaries
    ? [...fresh, ...stale]
    : fresh;
  
  log(`本次构建的平台: ${fresh.map(f => f.tag).join(", ")}`, "success");
  if (stale.length > 0) {
    if (options.allowStaleBinaries) {
      log(
        `检测到 ${stale.length} 个非本次构建的旧二进制，--allow-stale-binaries 已开启，将一起发布（tarball 会很大）: ${stale.map(s => s.file).join(", ")}`,
        "warn"
      );
    } else {
      log(`检测到 ${stale.length} 个非本次构建的旧二进制，将从本次发布中排除:`, "warn");
      for (const s of stale) {
        log(`   - bin/${s.file}  构建于 ${new Date(mtimes[s.file]!).toISOString()}`, "info");
      }
    }
  }
  
  const originalManifest = readFileSync(pkgJsonPath, "utf-8");
  const trimmedPkg = buildTrimmedManifest(pkgJson, publishPlatforms);
  
  // 旧二进制必须挪出 bin/，否则 files 通配仍会把它打进 tarball
  const holdingDir = join(rootDir, ".publish-test", `stale-binaries-${Date.now()}`);
  let movedFiles: string[] = [];
  
  // 还原必须幂等：finally 与信号中断都会调用
  const restore = () => {
    const errors: string[] = [];

    // 两步各自独立 try：manifest 写失败也必须继续把二进制搬回去（反之亦然）。
    // manifest 优先 —— 它是唯一会污染 git 工作区的改动。
    try {
      writeFileSync(pkgJsonPath, originalManifest);
    } catch (err) {
      errors.push(`manifest 还原失败 (${pkgJsonPath}): ${(err as Error).message}`);
    }

    let leftovers: string[] = [];
    try {
      const result = restorePrunedBinaries(binDir, holdingDir, movedFiles);
      leftovers = result.leftovers;
      movedFiles = [];
    } catch (err) {
      errors.push(`二进制还原失败: ${(err as Error).message}`);
    }

    if (errors.length > 0) {
      log(`还原过程中出现错误，请手动检查:\n  ${errors.join("\n  ")}`, "error");
    }

    if (leftovers.length > 0) {
      log(
        `${holdingDir} 里仍残留 ${leftovers.length} 个文件（很可能是之前被中断的发布留下的）: ${leftovers.join(", ")}`,
        "warn"
      );
      log(`已保留未删除，请人工确认后移回 bin/ 或删除该目录。`, "warn");
    }
  };
  
  // Bun/Node 收到 SIGINT 不会展开调用栈，finally 会被跳过；
  // 而 standalone 的发布 + registry 等待窗口可能长达 20+ 分钟。
  const guard = createRestoreGuard(restore);
  
  try {
    // ---- 从这里开始修改仓库状态 ----
    setPackageJson(pkg.dir, trimmedPkg);
    log(
      `manifest 已裁剪: files=${trimmedPkg.files.length} 项, os=[${trimmedPkg.os.join(",")}], cpu=[${trimmedPkg.cpu.join(",")}]`,
      "info"
    );
    
    if (!options.allowStaleBinaries) {
      movedFiles = pruneStaleBinaries(binDir, stale, holdingDir);
      if (movedFiles.length > 0) {
        log(`已临时移出 ${movedFiles.length} 个旧二进制 → ${holdingDir}`, "info");
      }
    }
    
    if (options.dryRun) {
      log(`[DRY RUN] Would publish ${pkg.name}@${version}（下面是本次会打包的内容）`, "warn");
      const preview = await $`cd ${join(rootDir, pkg.dir)} && npm pack --dry-run`.nothrow();
      console.log(String(preview.stdout ?? "").trim());
      if (preview.exitCode !== 0) console.error(String(preview.stderr ?? "").trim());
      versions.set(pkg.name, version);
      return;
    }
    
    await publishToNpm(pkg.dir, options.tag);
    versions.set(pkg.name, version);
    log(`Published: ${pkg.name}@${version}`, "success");
    
    // npm 对大 tarball 返回 202 后需要后台处理，这里带进度地等它真正可安装
    const appeared = await waitForVersionOnRegistry(
      pkg.name,
      version,
      options.registryTimeoutSec * 1000,
      "registry 传播"
    );
    if (!appeared) {
      // 不抛错：包其实可能已经上传成功，只是 registry 还没传播完。
      // 但必须让用户知道后续 verifyInstall 可能会失败。
      log(
        `⚠️  ${pkg.name}@${version} 未在 ${options.registryTimeoutSec}s 内出现在 registry 上；` +
          `发布结果可能仍在后台处理，稍后可手动确认（npm view ${pkg.name}@${version}）`,
        "warn"
      );
    }
  } finally {
    guard.dispose();
    // runRestore 是幂等的，且内部吞掉异常 —— 保证不会因为还原出错而掩盖原始错误
    guard.runRestore();
  }
}

// ============================================================
// 验证 - npmjs 版本验证
// ============================================================

async function verifyNpmVersions(): Promise<void> {
  logSection("验证 npmjs 已发布版本");
  
  for (const pkg of PACKAGES) {
    const pkgJson = getPackageJson(pkg.dir);
    const localVersion = pkgJson.version;
    
    log(`\n--- ${pkg.name} ---`, "info");
    log(`Local version: ${localVersion}`, "info");
    
    // 检查本地版本是否已发布
    const exists = await checkNpmVersion(pkg.name, localVersion);
    if (exists) {
      log(`✅ npmjs 已有 ${localVersion}`, "success");
    } else {
      log(`⚠️  npmjs 没有 ${localVersion}`, "warn");
    }
    
    // 获取 npmjs 最新版本
    const npmInfo = await fetchNpmInfo(pkg.name);
    if (npmInfo && npmInfo["dist-tags"]) {
      log(`npmjs dist-tags: ${JSON.stringify(npmInfo["dist-tags"])}`, "info");
    }
    if (npmInfo && npmInfo.version) {
      log(`npmjs latest: ${npmInfo["dist-tags"]?.latest || npmInfo.version}`, "info");
    }
  }
}

// ============================================================
// 验证 - 集成测试
// ============================================================

async function verifyInstall(versions: Map<string, string>): Promise<void> {
  logSection("验证安装测试");

  const testDir = join(rootDir, ".publish-test", randomUUID());

  try {
    mkdirSync(testDir, { recursive: true });

    // 创建包含所有 SDK 的测试 package.json
    // 注意：standalone 最后发布且无依赖，使用精确版本避免 registry 传播延迟
    const testPkg = {
      name: "publish-test",
      version: "0.0.0",
      type: "module",
      dependencies: {
        "@ai-setting/roy-bot-core": `^${versions.get("@ai-setting/roy-bot-core")}`,
        "@ai-setting/roy-bot-coder-harness": `^${versions.get("@ai-setting/roy-bot-coder-harness")}`,
        "@ai-setting/roy-bot-ontology-harness": `^${versions.get("@ai-setting/roy-bot-ontology-harness")}`,
        "@ai-setting/roy-bot-cli": `^${versions.get("@ai-setting/roy-bot-cli")}`,
        "@ai-setting/roy-bot-standalone": versions.get("@ai-setting/roy-bot-standalone"),
      },
    };

    writeFileSync(join(testDir, "package.json"), JSON.stringify(testPkg, null, 2));

    // ========================================================
    // Phase 3.1: 预检 — 通过 npm view 快速确认每个版本已发布
    // 比 npm install 快 10x+，能精准发现"staged → latest 延迟"
    // ========================================================
    log("📡 Phase 3.1: 预检 registry（npm view）...", "info");
    const pkgsToCheck = PACKAGES.filter(p => versions.has(p.name));
    const missingVersions = new Map<string, { version: string; missing: string[] }>();

    for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
      const missing: string[] = [];
      for (const pkg of pkgsToCheck) {
        const version = versions.get(pkg.name)!;
        const available = await checkNpmVersion(pkg.name, version);
        if (!available) missing.push(`${pkg.name}@${version}`);
      }

      if (missing.length === 0) {
        log(`✅ 所有版本已在 registry 上 (${pkgsToCheck.length}/${pkgsToCheck.length})`, "success");
        break;
      }

      missingVersions.set(`attempt-${attempt}`, { version: "", missing });

      if (attempt === MAX_VERIFY_RETRIES) {
        throw new Error(
          `❌ 经过 ${MAX_VERIFY_RETRIES} 次重试，以下版本仍不在 registry 上:\n` +
          missing.map(m => `  - ${m}`).join("\n") +
          `\n\n可能原因:\n` +
          `  - npm staged 灰度仍未 promote（npm 内部任务，最多等几分钟）\n` +
          `  - publish 实际上失败了，但脚本没有检测到`
        );
      }

      // 指数退避：15s → 30s → 60s（封顶）
      const backoff = Math.min(
        VERIFY_RETRY_BASE_MS * Math.pow(2, attempt - 1),
        VERIFY_RETRY_MAX_MS
      );
      log(
        `⚠️ Registry 上缺失 ${missing.length} 个版本，` +
        `等待 ${(backoff / 1000).toFixed(0)}s 后重试 ` +
        `(${attempt}/${MAX_VERIFY_RETRIES})...`,
        "warn"
      );
      log(`   缺失: ${missing.join(", ")}`, "info");
      await new Promise(r => setTimeout(r, backoff));
    }

    // ========================================================
    // Phase 3.2: npm install（带智能重试）
    // ========================================================
    log("📦 Phase 3.2: 完整集成测试（npm install + 集成测试）...", "info");

    let installOk = false;
    let lastError: string = "";

    for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
      if (attempt > 1) {
        const backoff = Math.min(
          VERIFY_RETRY_BASE_MS * Math.pow(2, attempt - 1),
          VERIFY_RETRY_MAX_MS
        );
        log(
          `等待 ${(backoff / 1000).toFixed(0)}s 后重试 ` +
          `(${attempt}/${MAX_VERIFY_RETRIES})...`,
          "warn"
        );
        await new Promise(r => setTimeout(r, backoff));
      }

      log(`Running: npm install (attempt ${attempt}/${MAX_VERIFY_RETRIES})`, "info");
      const installResult = await $`cd ${testDir} && npm install --no-audit --no-fund`.nothrow();

      if (installResult.exitCode === 0) {
        installOk = true;
        break;
      }

      lastError = String(installResult.stderr ?? "").trim() || installResult.stdout.toString();

      // 智能错误分类：只对 registry 传播类错误重试
      const isRegistryDelay =
        /ETARGET|E404|HTTP 404|HTTP 503|EAI_AGAIN|ENOTFOUND/i.test(lastError) ||
        /No matching version|could not be found|not found in this registry/i.test(lastError);

      if (!isRegistryDelay) {
        // 非传播延迟错误：直接抛出（避免无意义的重试）
        log(`❌ npm install 失败（非传播错误，立即终止）:`, "error");
        console.error(lastError);
        throw new Error(`npm install 失败（致命错误）: ${lastError.split("\n")[0]}`);
      }

      log(`⚠️ npm install 失败（registry 传播延迟）:`, "warn");
      console.error(lastError.split("\n").slice(0, 5).join("\n"));
    }

    if (!installOk) {
      throw new Error(
        `npm install 失败，已重试 ${MAX_VERIFY_RETRIES} 次\n` +
        `最后一次错误: ${lastError.split("\n")[0]}`
      );
    }
    log("✅ npm install completed", "success");
    
    // 运行集成测试
    logSection("运行集成测试");
    
    const testScript = `
const fs = require('fs');
const path = require('path');

async function testCore() {
  const core = await import('@ai-setting/roy-bot-core');
  console.log('\\n=== @ai-setting/roy-bot-core ===');
  console.log('Exports:', Object.keys(core).slice(0, 10).join(', '));
  
  const keyExports = ['TaskComponent', 'HookManager', 'WorkflowComponent'];
  const found = keyExports.filter(e => core[e]);
  if (found.length > 0) {
    console.log('✅ Key exports found:', found.join(', '));
  } else {
    console.log('⚠️  Key exports not found');
  }
  
  return core;
}

async function testCoderHarness() {
  const coder = await import('@ai-setting/roy-bot-coder-harness');
  console.log('\\n=== @ai-setting/roy-bot-coder-harness ===');
  console.log('Exports:', Object.keys(coder).slice(0, 10).join(', '));
  
  const keyExports = ['LSPClient', 'LSPManager', 'LSPServer'];
  const found = keyExports.filter(e => coder[e]);
  if (found.length > 0) {
    console.log('✅ Key exports found:', found.join(', '));
  } else {
    console.log('⚠️  Key exports not found');
  }
  
  return coder;
}

async function testOntologyHarness() {
  const ontology = await import('@ai-setting/roy-bot-ontology-harness');
  console.log('\\n=== @ai-setting/roy-bot-ontology-harness ===');
  console.log('Exports:', Object.keys(ontology).slice(0, 10).join(', '));
  
  const keyExports = ['TypedMarkdownParser', 'OntologyValidator', 'DomainModel'];
  const found = keyExports.filter(e => ontology[e]);
  if (found.length > 0) {
    console.log('✅ Key exports found:', found.join(', '));
  } else {
    console.log('⚠️  Key exports not found');
  }
  
  return ontology;
}

async function testCli() {
  const cli = await import('@ai-setting/roy-bot-cli');
  console.log('\\n=== @ai-setting/roy-bot-cli ===');
  console.log('Exports:', Object.keys(cli).slice(0, 10).join(', '));
  
  const keyExports = ['ActCommand', 'InteractiveCommand', 'TasksCommand', 'ConfigCommand', 'WorkflowCommand'];
  const found = keyExports.filter(e => cli[e]);
  if (found.length > 0) {
    console.log('✅ Key exports found:', found.join(', '));
  } else {
    console.log('⚠️  Key exports not found');
  }
  
  return cli;
}

async function testStandalone() {
  console.log('\\n=== @ai-setting/roy-bot-standalone ===');
  const standaloneBin = path.join(__dirname, 'node_modules', '@ai-setting/roy-bot-standalone', 'bin');
  
  if (fs.existsSync(standaloneBin)) {
    const files = fs.readdirSync(standaloneBin);
    const binary = files.find(f => f.includes('linux-x64') || f.includes('darwin') || f.includes('windows'));
    if (binary) {
      console.log('✅ Binary found:', binary);
    } else {
      console.log('⚠️  No binary found');
    }
  } else {
    console.log('⚠️  Standalone bin directory not found');
  }
}

async function main() {
  console.log('========================================');
  console.log('       SDK Integration Test            ');
  console.log('========================================');
  
  try {
    await testCore();
    await testCoderHarness();
    await testOntologyHarness();
    await testCli();
    await testStandalone();
    
    console.log('\\n========================================');
    console.log('✅ All SDKs loaded successfully!');
    console.log('========================================');
  } catch (error) {
    console.error('\\n❌ Integration test failed:', error);
    process.exit(1);
  }
}

main();
`;
    
    writeFileSync(join(testDir, "test.cjs"), testScript);
    const result = await $`cd ${testDir} && node test.cjs`.text();
    console.log(result);
    
    // 验证 standalone 二进制版本
    logSection("验证 Standalone 二进制");
    const standaloneBin = join(testDir, "node_modules", "@ai-setting/roy-bot-standalone", "bin");
    if (existsSync(standaloneBin)) {
      const files = await $`ls ${standaloneBin}`.text();
      log(`Binary files:\n${files}`, "success");
    }
    
    log("✅ 验证测试通过!", "success");
    
  } finally {
    rmSync(testDir, { recursive: true, force: true });
    log(`Cleaned test directory`, "info");
  }
}

// ============================================================
// 验证 - 本地构建测试（test-only 模式）
// ============================================================

async function verifyLocalBuild(): Promise<void> {
  logSection("验证本地构建");
  
  // 确保本地已构建
  for (const pkg of PACKAGES.slice(0, 4)) {
    const indexPath = join(rootDir, pkg.dir, "dist", "index.js");
    if (!existsSync(indexPath)) {
      log(`本地未构建 ${pkg.name}，先执行构建...`, "warn");
      await buildAllSdk();
      break;
    }
  }
  
  const standaloneBin = join(rootDir, "packages", "roy-bot-standalone", "bin");
  if (!existsSync(standaloneBin)) {
    log("Standalone 未构建，先执行构建...", "warn");
    await buildStandalone();
  }
  
  // 读取本地版本
  const versions = new Map<string, string>();
  for (const pkg of PACKAGES) {
    const pkgJson = getPackageJson(pkg.dir);
    versions.set(pkg.name, pkgJson.version);
    log(`${pkg.name}: ${pkgJson.version}`, "info");
  }
  
  // 检查 npmjs 是否有对应版本
  logSection("检查 npmjs 版本");
  for (const [name, version] of versions) {
    const exists = await checkNpmVersion(name, version);
    log(`${name}@${version}: ${exists ? "✅ 已发布" : "⚠️ 未发布"}`, exists ? "success" : "warn");
  }
  
  // 尝试从 npmjs 安装并测试
  logSection("从 npmjs 安装测试");
  
  const testDir = join(rootDir, ".publish-test", randomUUID());
  try {
    mkdirSync(testDir, { recursive: true });
    
    const testPkg = {
      name: "local-build-test",
      version: "0.0.0",
      type: "module",
      dependencies: {
        "@ai-setting/roy-bot-core": `^${versions.get("@ai-setting/roy-bot-core")}`,
        "@ai-setting/roy-bot-coder-harness": `^${versions.get("@ai-setting/roy-bot-coder-harness")}`,
        "@ai-setting/roy-bot-ontology-harness": `^${versions.get("@ai-setting/roy-bot-ontology-harness")}`,
        "@ai-setting/roy-bot-cli": `^${versions.get("@ai-setting/roy-bot-cli")}`,
        "@ai-setting/roy-bot-standalone": `^${versions.get("@ai-setting/roy-bot-standalone")}`,
      },
    };
    
    writeFileSync(join(testDir, "package.json"), JSON.stringify(testPkg, null, 2));
    
    log("Running: npm install", "info");
    await $`cd ${testDir} && npm install`.quiet();
    
    // 运行测试
    const testScript = `
const fs = require('fs');
const path = require('path');

async function testAll() {
  console.log('Testing SDK imports from npmjs...\\n');
  
  // Test Core
  try {
    const core = await import('@ai-setting/roy-bot-core');
    console.log('✅ Core:', Object.keys(core).slice(0, 5).join(', '));
  } catch (e) {
    console.log('❌ Core failed:', e.message);
  }
  
  // Test Coder
  try {
    const coder = await import('@ai-setting/roy-bot-coder-harness');
    console.log('✅ Coder:', Object.keys(coder).slice(0, 5).join(', '));
  } catch (e) {
    console.log('❌ Coder failed:', e.message);
  }
  
  // Test Ontology
  try {
    const ontology = await import('@ai-setting/roy-bot-ontology-harness');
    console.log('✅ Ontology:', Object.keys(ontology).slice(0, 5).join(', '));
  } catch (e) {
    console.log('❌ Ontology failed:', e.message);
  }
  
  // Test CLI
  try {
    const cli = await import('@ai-setting/roy-bot-cli');
    console.log('✅ CLI:', Object.keys(cli).slice(0, 5).join(', '));
  } catch (e) {
    console.log('❌ CLI failed:', e.message);
  }
  
  // Test Standalone binary
  const binDir = path.join(__dirname, 'node_modules', '@ai-setting/roy-bot-standalone', 'bin');
  if (fs.existsSync(binDir)) {
    const files = fs.readdirSync(binDir);
    const binary = files.find(f => f.includes('linux-x64'));
    if (binary) {
      console.log('✅ Standalone binary:', binary);
    }
  }
}

testAll().catch(console.error);
`;
    
    writeFileSync(join(testDir, "test.cjs"), testScript);
    const result = await $`cd ${testDir} && node test.cjs`.text();
    console.log(result);
    
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

// ============================================================
// 主流程
// ============================================================

async function main(options: PublishOptions): Promise<void> {
  const startTime = Date.now();
  
  // 特殊模式：verify-npm
  if (options.verifyNpm) {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║          验证 npmjs 已发布版本                             ║
╚════════════════════════════════════════════════════════════╝
`);
    await verifyNpmVersions();
    return;
  }

  // 特殊模式：verify-only
  if (options.verifyOnly) {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║          仅验证：检查本地版本是否已发布到 npmjs            ║
╚════════════════════════════════════════════════════════════╝
`);
    const versions = new Map<string, string>();
    for (const pkg of PACKAGES) {
      const pkgJson = getPackageJson(pkg.dir);
      versions.set(pkg.name, pkgJson.version);
    }
    await verifyInstall(versions);
    log("✅ 验证通过！", "success");
    return;
  }

  // 特殊模式：test-only
  if (options.testOnly) {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║          测试模式：验证本地构建                           ║
╚════════════════════════════════════════════════════════════╝
`);
    await verifyLocalBuild();
    return;
  }
  
  console.log(`
╔════════════════════════════════════════════════════════════╗
║          Roy Agent 构建发布脚本                           ║
╚════════════════════════════════════════════════════════════╝
  Mode: ${options.dryRun ? "DRY RUN (模拟)" : "LIVE (正式发布)"}
  Tag: ${options.tag}
`);
  
  // 备份 package.json
  logSection("备份 package.json");
  for (const pkg of PACKAGES) {
    backupPackageJson(pkg.dir);
  }
  
  const versions = new Map<string, string>();
  
  try {
    // Phase 1: 读取版本号 + 替换依赖 + 构建
    logSection("Phase 1: 读取版本 + 替换依赖 + 构建");
    
    // 读取各包版本号（包括 standalone）
    for (const pkg of PACKAGES) {
      const pkgJson = getPackageJson(pkg.dir);
      versions.set(pkg.name, pkgJson.version);
      log(`${pkg.name}: ${pkgJson.version}`, "info");
    }
    
    // standalone 不需要更新 workspace 依赖，只记录版本
    log(`@ai-setting/roy-bot-standalone: ${versions.get("@ai-setting/roy-bot-standalone")} (standalone, 无需依赖替换)`, "info");
    
    // 替换 workspace 依赖
    await updateWorkspaceDeps(versions);
    
    // 构建
    await buildAllSdk();
    await buildStandalone();
    
    // Phase 2: 发布
    logSection("Phase 2: 发布");
    
    await publishCore(options, versions);
    await publishCoder(options, versions);
    await publishOntology(options, versions);
    await publishCli(options, versions);
    await publishStandalone(options, versions);
    
    // Phase 3: 验证
    if (!options.skipVerify && !options.dryRun) {
      // 等待 standalone staged → latest tag promotion
      // npm 对新版本有 staged 灰度机制，PUT 后需要时间自动 promote 到 latest tag
      // （publishStandalone 内部已经带进度地等过一轮，这里再兜一次）
      log(`等待 standalone staged → latest promote... (${STAGED_PROMOTE_WAIT / 1000}s)`, "info");
      await new Promise(r => setTimeout(r, STAGED_PROMOTE_WAIT));
      await verifyInstall(versions);
    } else if (options.dryRun) {
      log("跳过验证 (dry-run 模式)", "warn");
    }
    
    // 完成
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    logSection("发布完成");
    console.log("发布的版本:");
    for (const [name, version] of versions) {
      console.log(`  ${name}@${version}`);
    }
    console.log(`\n总耗时: ${elapsed}s`);
    
    if (options.dryRun) {
      console.log("\n⚠️  DRY RUN - 未实际发布");
    }
    
  } catch (error) {
    log(`发布失败: ${error}`, "error");
    throw error;
    
  } finally {
    // 恢复 package.json
    logSection("恢复 package.json (workspace 依赖)");
    for (const pkg of PACKAGES) {
      restorePackageJson(pkg.dir);
    }
    cleanupBackups();
  }
}

// ============================================================
// CLI 解析
// ============================================================

const args = process.argv.slice(2);

const options: PublishOptions = {
  dryRun: args.includes("--dry-run") || args.includes("-n"),
  tag: parseFlagValue(args, "--tag") ?? "latest",
  skipVerify: args.includes("--skip-verify") || args.includes("--no-verify"),
  testOnly: args.includes("--test-only"),
  verifyNpm: args.includes("--verify-npm"),
  verifyOnly: args.includes("--verify-only"),
  allowStaleBinaries: args.includes("--allow-stale-binaries"),
  // 严格校验：NaN / 0 / 负数 / Infinity 会让轮询永不超时，必须拒绝
  registryTimeoutSec: parseRegistryTimeoutSec(args, DEFAULT_STANDALONE_REGISTRY_TIMEOUT_SEC),
  // 默认只构建/发布当前平台（与原来的 --single 行为一致）
  platforms: parsePlatformList(parseFlagValue(args, "--platforms")),
};

main(options).catch((err) => {
  console.error("\n❌ 发布失败:", err);
  process.exit(1);
});
