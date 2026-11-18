/**
 * publish-full 的纯逻辑（无副作用，便于单测）
 *
 * 背景：packages/roy-bot-standalone/bin/ 是跨版本累积的目录，
 * 而 package.json 的 files: ["bin/**"] 通配会把目录下所有二进制都打进 tarball。
 * 本地用 `build:cli:prod --single` 只重建当前平台 → 其余平台是几个月前的旧产物，
 * 结果单平台发布也会产出 170MB+ 的包，还把过期二进制发给 mac/win 用户。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface PlatformBinary {
  /** 平台标签，如 linux-x64 */
  tag: string;
  /** bin/ 下的文件名 */
  file: string;
  /** npm os 字段值 */
  os: string;
  /** npm cpu 字段值 */
  cpu: string;
}

export const PLATFORM_BINARIES: PlatformBinary[] = [
  { tag: "linux-x64", file: "roy-bot-linux-x64", os: "linux", cpu: "x64" },
  { tag: "linux-arm64", file: "roy-bot-linux-arm64", os: "linux", cpu: "arm64" },
  { tag: "darwin-x64", file: "roy-bot-darwin-x64", os: "darwin", cpu: "x64" },
  { tag: "darwin-arm64", file: "roy-bot-darwin-arm64", os: "darwin", cpu: "arm64" },
  { tag: "windows-x64", file: "roy-bot-windows-x64.exe", os: "win32", cpu: "x64" },
];

/**
 * mtime 容差（ms）。
 * 文件系统 mtime 粒度可能是 1s，构建开始时间戳与产物落盘时间可能落在同一秒，
 * 严格 `mtime >= buildStartedAt` 会把本次刚构建的二进制误判成 stale。
 */
export const MTIME_TOLERANCE_MS = 2_000;

/** 当前平台对应的平台标签，如 linux-x64 */
export function currentPlatformTag(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

/**
 * 按 mtime 把 bin/ 下的二进制分成「本次构建」和「历史残留」。
 *
 * @param mtimes         file 名 → mtimeMs（不存在的文件用 undefined）
 * @param buildStartedAt 本次构建开始时间戳（ms）；<= 0 表示无法判断，全部视为 fresh
 */
export function partitionBinaries(
  mtimes: Record<string, number | undefined>,
  buildStartedAt: number
): { fresh: PlatformBinary[]; stale: PlatformBinary[] } {
  const fresh: PlatformBinary[] = [];
  const stale: PlatformBinary[] = [];
  const threshold = buildStartedAt > 0 ? buildStartedAt - MTIME_TOLERANCE_MS : 0;

  for (const platform of PLATFORM_BINARIES) {
    const mtime = mtimes[platform.file];
    if (mtime === undefined) continue;
    if (buildStartedAt <= 0 || mtime >= threshold) fresh.push(platform);
    else stale.push(platform);
  }

  return { fresh, stale };
}

/**
 * 解析 `--platforms=linux-x64,darwin-arm64` 这类平台列表。
 * 未提供时返回当前平台，保证「本地单平台构建」的默认行为不变。
 */
export function parsePlatformList(
  raw: string | undefined,
  currentTag: string = currentPlatformTag()
): PlatformBinary[] {
  const tags = (raw ?? currentTag)
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);

  if (tags.length === 0) {
    throw new Error(`--platforms 不能为空（可选值: ${PLATFORM_BINARIES.map(p => p.tag).join(", ")}）`);
  }

  const unknown = tags.filter(t => !PLATFORM_BINARIES.some(p => p.tag === t));
  if (unknown.length > 0) {
    throw new Error(
      `未知的平台标签: ${unknown.join(", ")}\n  可选值: ${PLATFORM_BINARIES.map(p => p.tag).join(", ")}`
    );
  }

  // 去重，保持输入顺序
  return [...new Set(tags)].map(t => PLATFORM_BINARIES.find(p => p.tag === t)!);
}

/**
 * 生成裁剪后的 manifest：files / os / cpu / bin 只保留本次要发布的平台。
 * bin 路径统一带 "./" 前缀（npm 对 bin 字段要求相对路径，避免被自动修正）。
 */
export function buildTrimmedManifest<T extends Record<string, any>>(
  pkgJson: T,
  publishPlatforms: PlatformBinary[]
): T {
  return {
    ...pkgJson,
    files: ["bin/run.js", ...publishPlatforms.map(p => `bin/${p.file}`)],
    os: [...new Set(publishPlatforms.map(p => p.os))],
    cpu: [...new Set(publishPlatforms.map(p => p.cpu))],
    bin: {
      "roy-bot": "./bin/run.js",
      ...Object.fromEntries(publishPlatforms.map(p => [`roy-bot-${p.tag}`, `./bin/${p.file}`])),
    },
  } as T;
}

/**
 * 把不发布的旧二进制临时移出 bin/（否则 files 通配仍会把它们打进 tarball）。
 * 返回实际被移动的文件名，交给 restorePrunedBinaries() 还原。
 *
 * ⚠️ 如果 holdingDir 里已经存在同名文件（上一次运行崩溃留下的滞留文件），
 * 直接覆盖会让滞留文件永久丢失，所以这里抛错并要求人工处理。
 */
export function pruneStaleBinaries(
  binDir: string,
  stale: PlatformBinary[],
  holdingDir: string
): string[] {
  const moved: string[] = [];
  for (const platform of stale) {
    const from = join(binDir, platform.file);
    if (!existsSync(from)) continue;

    const to = join(holdingDir, platform.file);
    if (existsSync(to)) {
      throw new Error(
        `holding 目录里已存在 ${platform.file}（很可能是上一次发布被中断留下的）。\n` +
          `  请先人工确认后把它移回 bin/ 或删除: ${holdingDir}\n` +
          `  拒绝覆盖，避免永久丢失二进制。`
      );
    }

    mkdirSync(holdingDir, { recursive: true });
    renameSync(from, to);
    moved.push(platform.file);
  }
  return moved;
}

export interface RestoreResult {
  /** 本次成功还原回 bin/ 的文件 */
  restored: string[];
  /** holdingDir 里仍然滞留（属于其它运行）的文件，未做删除 */
  leftovers: string[];
}

/**
 * 还原 pruneStaleBinaries() 移走的文件。
 *
 * 安全约束：
 * - 只还原本次记录的 files，绝不触碰其它文件；
 * - 只有 holdingDir 变空时才删除它；
 * - holdingDir 里若有其它运行的滞留文件，**保留**并在 leftovers 里报告
 *   （旧实现无条件 rm -rf，会把上一次中断留下的 100MB 二进制永久删掉）。
 */
export function restorePrunedBinaries(
  binDir: string,
  holdingDir: string,
  files: string[]
): RestoreResult {
  const restored: string[] = [];
  const failures: string[] = [];

  for (const file of files) {
    const from = join(holdingDir, file);
    if (!existsSync(from)) continue;
    try {
      renameSync(from, join(binDir, file));
      restored.push(file);
    } catch (err) {
      failures.push(`${file}: ${(err as Error).message}`);
    }
  }

  const leftovers = existsSync(holdingDir) ? readdirSync(holdingDir) : [];

  if (leftovers.length === 0 && existsSync(holdingDir)) {
    rmSync(holdingDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    throw new Error(
      `还原二进制失败（文件仍在 ${holdingDir}，请手动移回 bin/）:\n  ${failures.join("\n  ")}`
    );
  }

  return { restored, leftovers };
}

/** 注册信号处理所需的最小接口（便于单测注入 fake） */
export interface SignalTarget {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

export interface RestoreGuard {
  /** 幂等执行 restore（重复调用只生效一次），用于 finally */
  runRestore(): void;
  /** 注销信号监听，用于正常结束后收尾 */
  dispose(): void;
}

export const RESTORE_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * 创建「异常/中断时也一定还原」的守卫。
 *
 * 背景（Task #4506 交叉验证 B1）：Bun/Node 收到 SIGINT 不会展开调用栈，
 * `finally` 会**被跳过**。发布窗口长达 ~20 分钟，期间 Ctrl-C 会把仓库留在
 * 「manifest 已被裁剪 + 旧二进制已移出 bin/」的破损状态。
 * 这里注册信号处理，先同步还原再退出。
 */
export function createRestoreGuard(
  restore: () => void,
  target: SignalTarget = process,
  exit: (code: number) => void = code => process.exit(code)
): RestoreGuard {
  let done = false;
  let exiting = false;

  const runRestore = () => {
    if (done) return;
    done = true;
    try {
      restore();
    } catch (err) {
      console.error(`⚠️  还原失败: ${(err as Error).message}`);
    }
  };

  const handler = () => {
    runRestore();
    // 多个信号可能连环到达（连按 Ctrl-C / SIGINT 后跟进 SIGTERM），只退出一次
    if (exiting) return;
    exiting = true;
    exit(130);
  };

  for (const signal of RESTORE_SIGNALS) {
    target.on(signal, handler);
  }

  return {
    runRestore,
    dispose() {
      for (const signal of RESTORE_SIGNALS) {
        target.off(signal, handler);
      }
    },
  };
}

/**
 * 解析 `--flag=value` / `--flag value` 两种形式。
 * 不做前缀匹配（`--tagline` 不会被当成 `--tag`），值里允许包含 `=`。
 */
export function parseFlagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) {
      const next = argv[i + 1];
      return next === undefined || next.startsWith("--") ? undefined : next;
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * 解析并校验 `--registry-timeout=<秒>`。
 *
 * 必须严格拒绝 NaN / 0 / 负数 / Infinity：
 * 旧实现用 Number(raw)，`--registry-timeout=abc` → NaN，
 * 而 `elapsed >= NaN` 恒为 false → 轮询循环**永不超时**（B4）。
 */
export function parseRegistryTimeoutSec(argv: string[], fallback: number): number {
  const raw = parseFlagValue(argv, "--registry-timeout");
  if (raw === undefined) return fallback;

  const invalid = (reason: string): never => {
    throw new Error(
      `--registry-timeout 取值非法（${reason}）: "${raw}"\n` +
        `  需要大于 0 的有限秒数，例如 --registry-timeout=1800`
    );
  };

  if (raw.trim() === "") invalid("空值");
  const sec = Number(raw);
  if (!Number.isFinite(sec)) invalid("不是有限数字");
  if (sec <= 0) invalid("必须大于 0");

  return sec;
}
