#!/usr/bin/env bun
/**
 * 发布前验收：在本地模拟 `npm install -g` 的完整链路（不需要先 publish）
 *
 * 流程:
 *   1. 按 publish-full 的同一套规则裁剪 manifest（只含本次构建的平台）
 *   2. 在 staging 目录里用硬链接搭出「真正会被发布」的内容，npm pack 打包
 *   3. 检查 tarball 内容 / 体积 / 是否混入了其他平台的旧二进制
 *   4. npm install -g --prefix <临时目录> <tarball>
 *   5. 运行 <临时目录>/bin/roy-bot --version 冒烟测试
 *   6. 清理（--keep 保留现场）
 *
 * ⚠️ 它必须和 publish-full 用同一套裁剪逻辑，否则验证的是「错的产物」：
 * 直接对 bin/ 里累积了 5 个平台的目录 npm pack，永远是 490MB + 永远告警。
 *
 * 用法:
 *   bun run verify:npm-install
 *   bun run verify:npm-install -- --dir packages/roy-bot-standalone
 *   bun run verify:npm-install -- --keep          # 保留临时目录与环境
 *   bun run verify:npm-install -- --pack-only     # 只打包 + 检查内容，不装
 *   bun run verify:npm-install -- --allow-stale-binaries   # 把 bin/ 里旧二进制也一起打（模拟最坏情况）
 *   bun run verify:npm-install -- --build-started-at <ms>  # 指定构建开始时间戳（默认用产物自身 mtime 推断）
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLATFORM_BINARIES,
  buildTrimmedManifest,
  currentPlatformTag,
  parseFlagValue,
  partitionBinaries,
  type PlatformBinary,
} from "./publish-full-helpers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_BASE = join(tmpdir(), "roy-bot-npm-verify");

function log(msg: string, type: "info" | "ok" | "warn" | "error" = "info") {
  const prefix = { info: "📋", ok: "✅", warn: "⚠️ ", error: "❌" };
  console.log(`${prefix[type]} ${msg}`);
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], cwd: string, timeoutMs = 600_000): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

// ============================================================
// 参数
// ============================================================

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const packOnly = argv.includes("--pack-only");
const allowStaleBinaries = argv.includes("--allow-stale-binaries");
const pkgDir = resolve(ROOT, parseFlagValue(argv, "--dir") ?? "packages/roy-bot-standalone");

const PLATFORM_TAG = currentPlatformTag();
const KNOWN_PLATFORMS = PLATFORM_BINARIES.map(p => p.tag);

/**
 * 用硬链接（失败则退回复制）把单个文件放进 staging 目录。
 * 105MB 的二进制每平台一份，拷贝会很慢；硬链接几乎零成本。
 */
function stageFile(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/**
 * 推断「构建开始时间」：用 bin/ 下最新的当前平台二进制 mtime 减去一小段余量。
 * 这样「刚构建完就跑 verify」的场景能正确把当前平台判为 fresh，
 * 而 bin/ 里几个月前的其它平台会被正确判为 stale。
 */
function inferBuildStartedAt(binDir: string): number {
  const current = PLATFORM_BINARIES.find(p => p.tag === PLATFORM_TAG);
  const candidates = [current?.file, "run.js"].filter(Boolean) as string[];

  let newest = 0;
  for (const file of candidates) {
    const full = join(binDir, file);
    if (existsSync(full)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  // 0 表示无法判断 → partitionBinaries 会把所有存在的二进制都当 fresh，
  // 此时下面的告警会给用户明确提示。
  return newest;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  if (!existsSync(join(pkgDir, "package.json"))) {
    fail(`不是合法的包目录: ${pkgDir}`);
  }

  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
  log(`包: ${pkg.name}@${pkg.version}`, "info");
  log(`目录: ${pkgDir}`, "info");
  log(`当前平台: ${PLATFORM_TAG}`, "info");

  const workDir = join(TMP_BASE, `npm-verify-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  log(`临时目录: ${workDir}`, "info");

  // ---------- 1. 按 publish-full 的规则裁剪 manifest，搭 staging ----------
  // 直接对 bin/ 打包会含所有累积的平台二进制（490MB+），验证的就不是真正发布的产物。
  const binDir = join(pkgDir, "bin");
  const buildStartedAt = parseFlagValue(argv, "--build-started-at")
    ? Number(parseFlagValue(argv, "--build-started-at"))
    : inferBuildStartedAt(binDir);

  const mtimes: Record<string, number | undefined> = {};
  for (const platform of PLATFORM_BINARIES) {
    const filePath = join(binDir, platform.file);
    mtimes[platform.file] = existsSync(filePath) ? statSync(filePath).mtimeMs : undefined;
  }
  const { fresh, stale } = partitionBinaries(mtimes, buildStartedAt);

  if (fresh.length === 0) {
    fail(
      `bin/ 下没有可识别的当前构建二进制，无法验证。\n` +
        `  目录: ${binDir}\n` +
        `  先执行 'bun run build:cli:prod --single'，或用 --build-started-at <ms> 指定构建时间戳。`
    );
  }

  const publishPlatforms: PlatformBinary[] = allowStaleBinaries ? [...fresh, ...stale] : fresh;
  log(`要验证发布的平台: ${publishPlatforms.map(p => p.tag).join(", ")}`, "info");
  if (stale.length > 0 && !allowStaleBinaries) {
    log(
      `bin/ 里另有 ${stale.length} 个非本次构建的二进制，已按发布规则排除: ${stale.map(s => s.file).join(", ")}`,
      "warn"
    );
  }

  const stageDir = join(workDir, "stage");
  const stagePkg = join(stageDir, pkg.name.replace(/^@[^/]+\//, ""));
  mkdirSync(stagePkg, { recursive: true });

  // 不能用 files 通配 —— 用裁剪后的 manifest 明确列出要打包的文件
  const trimmed = buildTrimmedManifest(pkg, publishPlatforms);
  writeFileSync(join(stagePkg, "package.json"), JSON.stringify(trimmed, null, 2) + "\n");

  for (const entry of readdirSync(pkgDir)) {
    if (entry === "bin" || entry === "package.json" || entry === "node_modules" || entry === "dist") continue;
    const from = join(pkgDir, entry);
    if (!statSync(from).isFile()) continue;
    stageFile(from, join(stagePkg, entry));
  }
  for (const file of ["run.js", ...publishPlatforms.map(p => p.file)]) {
    const from = join(binDir, file);
    if (!existsSync(from)) {
      fail(`缺少要打包的文件: ${from}`);
    }
    stageFile(from, join(stagePkg, "bin", file));
  }
  log(`staging 目录: ${stagePkg}`, "info");

  // ---------- 2. pack ----------
  log("npm pack ...", "info");
  const pack = await run(["npm", "pack", "--pack-destination", workDir], stagePkg);
  if (pack.exitCode !== 0) {
    console.error(pack.stderr || pack.stdout);
    fail("npm pack 失败");
  }
  const tarballName = pack.stdout
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .pop();
  if (!tarballName) fail(`无法解析 npm pack 输出:\n${pack.stdout}`);
  const tarball = join(workDir, tarballName);

  const sizeMB = statSync(tarball).size / 1024 / 1024;
  log(`tarball: ${tarballName} (${sizeMB.toFixed(1)} MB)`, "info");

  // ---------- 3. 内容检查 ----------
  const listing = await run(["tar", "-tzf", tarball], workDir);
  const entries = listing.stdout.split("\n").filter(Boolean);
  const platformFiles = entries.filter(e => KNOWN_PLATFORMS.some(p => e.includes(`roy-bot-${p}`)));

  log(`tarball 文件数: ${entries.length}`, "info");
  const verboseListing = await run(["tar", "-tvzf", tarball], workDir);
  const sizeByEntry = new Map<string, number>();
  for (const line of verboseListing.stdout.split("\n")) {
    const m = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (m) sizeByEntry.set(m[2], Number(m[1]));
  }
  for (const f of platformFiles) {
    const bytes = sizeByEntry.get(f);
    console.log(`   - ${f}${bytes ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB)` : ""}`);
  }

  const foreign = platformFiles.filter(f => !f.includes(`roy-bot-${PLATFORM_TAG}`));
  const expectedPlatformCount = publishPlatforms.length;
  if (platformFiles.length !== expectedPlatformCount) {
    log(
      `tarball 里平台二进制数量 ${platformFiles.length} 与预期 ${expectedPlatformCount} 不一致`,
      "warn"
    );
  }
  if (foreign.length > 0) {
    if (allowStaleBinaries) {
      log(`tarball 含 ${foreign.length} 个其它平台的二进制（--allow-stale-binaries 已开启，预期行为）`, "warn");
    } else {
      log(`tarball 里混入了其它平台的二进制（不应发生）:`, "error");
      for (const f of foreign) console.log(`   - ${f}`);
    }
  }
  const expectedSize = 120; // MB，单平台 tarball 大致 35~50MB
  if (sizeMB > expectedSize) {
    log(`tarball 体积 ${sizeMB.toFixed(1)} MB 偏大（单平台预期 < ${expectedSize} MB）`, "warn");
  }
  if (platformFiles.some(f => f.includes(`roy-bot-${PLATFORM_TAG}`))) {
    log(`当前平台二进制已包含: roy-bot-${PLATFORM_TAG}`, "ok");
  } else {
    log(`tarball 里没有当前平台的二进制！`, "error");
  }

  if (packOnly) {
    log("--pack-only：跳过安装测试", "warn");
    if (!keep) rmSync(workDir, { recursive: true, force: true });
    return;
  }

  // ---------- 4. npm install -g 到临时 prefix ----------
  const prefix = join(workDir, "prefix");
  mkdirSync(prefix, { recursive: true });
  log(`npm install -g --prefix ${prefix} <tarball> ...`, "info");
  const install = await run(
    ["npm", "install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", tarball],
    workDir
  );
  if (install.exitCode !== 0) {
    console.error(install.stderr || install.stdout);
    log(`现场保留在: ${workDir}`, "warn");
    fail("npm install -g 失败");
  }
  log("npm install -g 完成", "ok");

  // ---------- 5. 检查 bin 与安装产物 ----------
  const installedPkgDir = join(prefix, "lib", "node_modules", pkg.name);
  const installedPkgJsonPath = join(installedPkgDir, "package.json");
  if (existsSync(installedPkgJsonPath)) {
    const installedPkg = JSON.parse(readFileSync(installedPkgJsonPath, "utf-8"));
    const bin = installedPkg.bin;
    if (!bin) {
      log("安装后的 package.json 里没有 bin 字段 → 全局命令链接不会创建！", "error");
    } else {
      log(`bin: ${JSON.stringify(bin)}`, "ok");
    }
  } else {
    log(`未找到安装后的 package.json: ${installedPkgJsonPath}`, "warn");
  }

  const binDirEntries = await run(["ls", "-la", join(prefix, "bin")], workDir);
  console.log(binDirEntries.stdout.trim());

  const command = join(prefix, "bin", process.platform === "win32" ? "roy-bot.cmd" : "roy-bot");
  if (!existsSync(command)) {
    log("全局 bin 链接没有生成，npm install -g 的实际体验会是「命令找不到」", "error");
    log(`现场保留在: ${workDir}`, "warn");
    process.exit(1);
  }

  log(`运行 ${command} --version ...`, "info");
  const check = await run([command, "--version"], workDir, 60_000);
  console.log(check.stdout.trim() || check.stderr.trim());
  if (check.exitCode !== 0) {
    log(`冒烟测试失败，退出码 ${check.exitCode}`, "error");
    log(`现场保留在: ${workDir}`, "warn");
    process.exit(1);
  }
  log("npm 安装链路冒烟测试通过", "ok");

  // ---------- 6. 清理 ----------
  if (keep) {
    log(`--keep：现场保留在 ${workDir}`, "warn");
  } else {
    rmSync(workDir, { recursive: true, force: true });
    log("已清理临时目录", "info");
  }
}

main().catch(err => {
  console.error("\n❌ 验收失败:", err);
  process.exit(1);
});
