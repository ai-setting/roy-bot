#!/usr/bin/env bun
/**
 * 本地安装 roy-bot（不经过 npm）
 *
 * 把本地构建出来的 standalone 二进制直接装到 PATH 上，
 * 用于「先自己用起来 / 发布前自测」，完全不依赖 npm publish。
 *
 * 用法:
 *   bun run install:local                      # 安装当前平台二进制到 ~/.local/bin/roy-bot
 *   bun run install:local -- --prefix /usr/local/bin
 *   bun run install:local -- --build           # 先构建（bun run build:cli:prod --single）再安装
 *   bun run install:local -- --link            # 用软链代替拷贝（开发期改完重建立即生效）
 *   bun run install:local -- --uninstall
 *   bun run install:local -- --dry-run
 *
 * 选项:
 *   --prefix <dir>   安装目录（默认 ~/.local/bin；--system 等价 /usr/local/bin）
 *   --name <name>    安装后的命令名（默认 roy-bot）
 *   --bin <path>     指定要安装的二进制文件（跳过自动查找）
 *   --build          安装前先执行构建
 *   --link           创建软链而不是拷贝
 *   --uninstall      卸载（删除 --prefix/--name）
 *   --dry-run        只打印将要做什么
 *   --force          跳过「二进制可能过期」的检查
 */

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
// Task #4996: 原子替换（tmp + rename），避免覆盖正在被执行的二进制时 ETXTBSY。
import { replaceBinaryAtomically, cleanupStaleTempFiles } from "./atomic-bin-replace.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const STANDALONE_BIN_DIR = join(ROOT, "packages/roy-bot-standalone/bin");
const CLI_ROOT = join(ROOT, "packages/cli");
const CLI_PKG_PATH = join(CLI_ROOT, "package.json");
const CLI_SRC_DIR = join(CLI_ROOT, "src");
const BUILD_SCRIPT = join(ROOT, "scripts/build-cli-prod.ts");

const PLATFORM_TAG = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";

// ============================================================
// 参数解析
// ============================================================

interface Options {
  prefix: string;
  name: string;
  bin?: string;
  build: boolean;
  link: boolean;
  uninstall: boolean;
  dryRun: boolean;
  force: boolean;
  system: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    prefix: "",
    name: "roy-bot",
    build: false,
    link: false,
    uninstall: false,
    dryRun: false,
    force: false,
    system: false,
  };

  const valueOf = (flag: string, i: number): { value: string; consumed: number } => {
    const raw = argv[i];
    // 严格匹配 --flag=value / --flag value，避免 --prefixfoo 被当成 --prefix
    if (raw === flag) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        fail(`${flag} 需要一个值`);
      }
      return { value: next, consumed: 1 };
    }
    return { value: raw.slice(flag.length + 1), consumed: 0 }; // raw 形如 --flag=value
  };

  const matches = (arg: string, flag: string): boolean => arg === flag || arg.startsWith(`${flag}=`);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (matches(arg, "--prefix")) {
      const { value, consumed } = valueOf("--prefix", i);
      opts.prefix = value;
      i += consumed;
    } else if (matches(arg, "--name")) {
      const { value, consumed } = valueOf("--name", i);
      opts.name = value;
      i += consumed;
    } else if (matches(arg, "--bin")) {
      const { value, consumed } = valueOf("--bin", i);
      opts.bin = value;
      i += consumed;
    } else if (arg === "--build") opts.build = true;
    else if (arg === "--link") opts.link = true;
    else if (arg === "--uninstall") opts.uninstall = true;
    else if (arg === "--dry-run" || arg === "-n") opts.dryRun = true;
    else if (arg === "--force" || arg === "-f") opts.force = true;
    else if (arg === "--system") opts.system = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      fail(`未知参数: ${arg}（--help 查看用法）`);
    }
  }

  if (opts.name.includes("/") || opts.name.includes("\\")) {
    fail(`--name 不能包含路径分隔符: ${opts.name}`);
  }

  if (!opts.prefix) {
    opts.prefix = opts.system ? "/usr/local/bin" : join(homedir(), ".local", "bin");
  }
  if (opts.prefix.startsWith("~")) {
    opts.prefix = join(homedir(), opts.prefix.slice(1));
  }
  opts.prefix = resolve(opts.prefix);

  return opts;
}

// ============================================================
// 输出
// ============================================================

function log(msg: string, type: "info" | "ok" | "warn" | "error" = "info") {
  const prefix = { info: "📋", ok: "✅", warn: "⚠️ ", error: "❌" };
  console.log(`${prefix[type]} ${msg}`);
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`
本地安装 roy-bot（不经过 npm）

用法:
  bun run install:local [选项]

选项:
  --prefix <dir>   安装目录（默认 ~/.local/bin）
  --system         等价于 --prefix /usr/local/bin
  --name <name>    安装后的命令名（默认 roy-bot）
  --bin <path>     指定要安装的二进制（默认自动找当前平台构建产物）
  --build          安装前先构建（bun run build:cli:prod --single）
  --link           创建软链而不是拷贝（开发期改完重建立即生效）
  --uninstall      卸载
  --dry-run        只打印将要做什么
  --force          跳过「二进制可能过期」的检查
  -h, --help       帮助
`);
}

// ============================================================
// 工具
// ============================================================

function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (current: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else newest = Math.max(newest, st.mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

function cliVersion(): string {
  try {
    return JSON.parse(readFileSync(CLI_PKG_PATH, "utf-8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function candidateBinaries(): string[] {
  return [
    join(STANDALONE_BIN_DIR, `roy-bot-${PLATFORM_TAG}${EXE_SUFFIX}`),
    join(CLI_ROOT, "dist", PLATFORM_TAG, "bin", `roy-bot${EXE_SUFFIX}`),
  ];
}

async function resolveBinary(opts: Options): Promise<string> {
  if (opts.bin) {
    const bin = resolve(opts.bin);
    if (!existsSync(bin)) fail(`--bin 指定的文件不存在: ${bin}`);
    return bin;
  }

  const candidates = candidateBinaries();
  let existing = candidates.find(c => existsSync(c));

  if (!existing && !opts.build) {
    // 没有产物，用户也没要求构建：dry-run 只打印计划，其它情况直接失败并给出指引，
    // 不做「悄悄帮我构建 40 秒」的隐式行为。
    if (opts.dryRun) {
      log(`[DRY RUN] 没有找到 ${PLATFORM_TAG} 的构建产物，实际执行时会先构建（bun run build:cli:prod --single）`, "warn");
      return candidates[0];
    }
    fail(
      `没有找到 ${PLATFORM_TAG} 的构建产物。\n` +
        `  期望位置: ${candidates.join(" 或 ")}\n` +
        `  加 --build 先构建，或手动执行 'bun run build:cli:prod --single'。`
    );
  }

  if (opts.build) {
    log(`构建 ${PLATFORM_TAG} 二进制（bun run build:cli:prod --single）...`, "info");
    if (opts.dryRun) {
      log(`[DRY RUN] 跳过实际构建`, "warn");
      return existing ?? candidates[0];
    }
    const result = await $`cd ${ROOT} && bun run build:cli:prod --single`.nothrow();
    if (result.exitCode !== 0) {
      fail("构建失败，请先手动执行 `bun run build:cli:prod --single` 排查");
    }
    existing = candidates.find(c => existsSync(c));
    if (!existing) {
      fail(`构建结束但没找到二进制，检查目录: ${STANDALONE_BIN_DIR}`);
    }
  }

  const bin = existing;

  // 过期检查：二进制比源码 / 构建脚本旧 → 提示
  if (!opts.force) {
    const binMtime = statSync(bin).mtimeMs;
    const srcMtime = Math.max(newestMtime(CLI_SRC_DIR), statSync(BUILD_SCRIPT).mtimeMs);
    if (binMtime < srcMtime) {
      const ageMin = ((srcMtime - binMtime) / 60000).toFixed(0);
      log(`二进制比源码旧约 ${ageMin} 分钟，可能是旧代码。加 --build 重新构建，或 --force 忽略。`, "warn");
    }
  }

  return bin;
}

function isOnPath(dir: string): boolean {
  const path = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  return path.split(sep).some(p => resolve(p || "/") === dir);
}

function removeIfExists(target: string) {
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || st.isFile()) rmSync(target, { force: true });
    else fail(`${target} 已存在且不是文件/软链，拒绝删除`);
  } catch {
    // not exists
  }
}

async function selfCheck(target: string) {
  const proc = Bun.spawn([target, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  clearTimeout(timer);

  if (proc.exitCode !== 0) {
    log(`自检失败：${target} --version 退出码 ${proc.exitCode}`, "error");
    return;
  }
  const firstLine = out.split("\n").find(line => line.trim().length > 0) ?? "(无输出)";
  log(`自检通过: ${firstLine}`, "ok");
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = join(opts.prefix, `${opts.name}${EXE_SUFFIX}`);

  if (opts.uninstall) {
    if (!existsSync(target) && !isSymlink(target)) {
      log(`${target} 不存在，无需卸载`, "warn");
      return;
    }
    log(`删除 ${target}`, "info");
    if (!opts.dryRun) rmSync(target, { force: true });
    log("已卸载", "ok");
    return;
  }

  log(`平台: ${PLATFORM_TAG}`, "info");
  log(`安装目标: ${target}${opts.link ? "  (软链)" : ""}`, "info");

  const bin = await resolveBinary(opts);

  if (!existsSync(bin)) {
    // 只可能发生在 --dry-run + 尚未构建的场景（resolveBinary 已打印提示）
    log(`[DRY RUN] 二进制尚不存在: ${bin}`, "warn");
    return;
  }

  const binStat = statSync(bin);
  log(`二进制: ${bin}`, "info");
  log(`大小: ${(binStat.size / 1024 / 1024).toFixed(1)} MB, 版本(package.json): ${cliVersion()}`, "info");

  if (opts.dryRun) {
    log(`[DRY RUN] 将把 ${bin} ${opts.link ? "软链" : "拷贝"} 到 ${target}`, "warn");
    return;
  }

  mkdirSync(opts.prefix, { recursive: true });

  // Task #4996: 清理上次崩溃（SIGKILL / 断电 / OOM）残留的 tmp 文件。
  // replaceBinaryAtomically 只在进程能进 catch 时清 tmp；被强杀时 tmp 会留在
  // ~/.local/bin 里（100MB+ 半成品），每次安装都清一次。
  const staleTemps = await cleanupStaleTempFiles(opts.prefix);
  if (staleTemps.length > 0) {
    log(`已清理 ${staleTemps.length} 个残留临时文件: ${staleTemps.join(", ")}`, "info");
  }

  // 拷贝模式：Task #4996 —— 走「tmp + rename」原子替换。
  // 旧实现是「先 rm 再 copy」：能绕开 ETXTBSY（rm 不受内核 deny-write 限制），
  // 但 rm 与 copy 之间存在窗口，期间目标文件不存在 → 其它进程 exec 会 ENOENT。
  // 原子替换后：目标路径始终存在（要么旧 inode，要么新 inode），无空窗期。
  if (opts.link) {
    // 软链模式：先移除同名文件/软链，再建链（软链不是被执行的 inode，不涉及 ETXTBSY）
    if (existsSync(target) || isSymlink(target)) {
      const sameSource = isSymlink(target) && readlinkSafe(target) === bin;
      if (sameSource) {
        log(`已是指向该二进制的软链，跳过写入: ${target}`, "info");
        await selfCheck(target);
        return;
      }
      log(`覆盖已有文件: ${target}`, "warn");
      removeIfExists(target);
    }
    symlinkSync(bin, target);
  } else {
    if (existsSync(target) || isSymlink(target)) {
      const sameSource = isSymlink(target) && readlinkSafe(target) === bin;
      if (sameSource) {
        log(`已是指向该二进制的软链，跳过写入: ${target}`, "info");
        await selfCheck(target);
        return;
      }
      log(`覆盖已有文件: ${target}`, "warn");
      // 目标存在但不是普通文件/软链（如目录）→ rename 会 EISDIR，明确拒绝
      const st = lstatSync(target);
      if (!st.isSymbolicLink() && !st.isFile()) {
        fail(`${target} 已存在且不是文件/软链，拒绝覆盖`);
      }
    }
    if (process.platform === "win32") {
      // win32 保守保持原 copyFileSync 行为（与 build-cli-prod.ts / build-standalone.ts 一致）：
      // rename 覆盖运行中的 .exe 会 EBUSY，错误语义与旧实现不同。
      // 原 main 版本对所有平台都先 removeIfExists 再 copyFileSync；win32 保留该语义
      // （否则 copyFileSync 会穿过 symlink 写入它指向的文件，而非替换链接本身）。
      removeIfExists(target);
      copyFileSync(bin, target);
    } else {
      await replaceBinaryAtomically(bin, target);
    }
  }

  if (process.platform !== "win32") chmodSync(target, 0o755);

  log(`已安装: ${target}`, "ok");

  if (!isOnPath(opts.prefix)) {
    log(`${opts.prefix} 不在 PATH 中，把下面这行加到 ~/.bashrc / ~/.zshrc：`, "warn");
    console.log(`\n    export PATH="${opts.prefix}:$PATH"\n`);
  }

  await selfCheck(target);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function readlinkSafe(path: string): string | null {
  try {
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

main().catch(err => {
  console.error("\n❌ 安装失败:", err);
  process.exit(1);
});
