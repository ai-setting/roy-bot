/**
 * @fileoverview Cleanup stale plugin copies (Task #2948)
 *
 * ## Bug 根因
 *
 * `roy-bot install --global` 写 `~/.roy-bot/plugins.json` 声明版本，但 plugin
 * host（roy-bot standalone Bun binary）的 cwd-up Node 模块解析会先找到
 * `~/node_modules/<pkg>/` 里的 stale 副本（v2.5.8），永远不会落到
 * npm-global 的新版本（v2.5.11）。
 *
 * 之前 Task #2899 删了 install --global 的 cp 逻辑（cp 到 `~/.roy-bot/node_modules/`），
 * Task #2903 加了 `cleanupStaleCpCopy` 清理 `~/.roy-bot/node_modules/<pkg>/`，
 * 但**都没清理 `~/node_modules/<pkg>/`** — 这是 plugin host 真正会
 * 加载的 stale 副本路径。
 *
 * ## 修复
 *
 * `cleanupStalePluginCopies()` 在 install --global 成功后被调用。它扫描所有
 * 可能的 stale 副本路径，对每个副本做版本对比：
 *   - local < global → 删除（带 /tmp backup）
 *   - local >= global → 保留（用户可能有 dev build）
 *   - local 不存在 → no-op
 *   - corrupted package.json → 当作 stale 处理（删除）
 *
 * Best-effort：任何失败只 log warn，不抛异常。
 */

import { existsSync, readFileSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { homedir as nodeHomedir, tmpdir as nodeTmpdir } from "node:os";

// ============================================================================
// Types
// ============================================================================

/** 跳过某条路径的原因 */
export type CleanupSkipReason =
  | "no-local-copy" // 路径根本不存在
  | "local-equal-or-newer" // 本地版本 >= global 版本（用户可能 dev build）
  | "cleanup-failed" // rmSync / backup 失败（best-effort 仍继续）
  | "no-global-version"; // caller 没传 globalVersion（防御性）

/** 一次清理的结果 */
export interface CleanupResult {
  /** 被清理的路径 */
  cleaned: string[];
  /** 被跳过的路径 + 原因 */
  skipped: Array<{ path: string; reason: CleanupSkipReason }>;
  /** 被备份的副本路径 */
  backups: Array<{ originalPath: string; backupPath: string }>;
}

/** cleanupStalePluginCopies 的入参 */
export interface CleanupOptions {
  /** npm-global 上的版本（权威源） */
  globalVersion: string;
  /** 覆盖 homedir（测试用） */
  homedir?: string;
  /**
   * 要扫描的 local node_modules 路径列表。默认：
   *   - <homedir>/node_modules/         （cwd-up 解析落点，Bun / Node 标准）
   *   - <homedir>/.roy-bot/node_modules/  （Task #2899 之前的 cp 副本）
   */
  localNodeModulesPaths?: string[];
  /** backup 目标目录，默认 /tmp */
  backupDir?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 清理所有 stale plugin 副本（cwd-up 解析落点 + 历史 cp 副本）。
 *
 * 扫描传入的每个 `localNodeModulesPaths` 路径，查找 `<path>/<packageName>/package.json`：
 *   - local 不存在 → skip (no-local-copy)
 *   - local.version >= globalVersion → skip (local-equal-or-newer)
 *   - local.version < globalVersion OR corrupted → backup + rm
 *
 * Best-effort：rmSync 失败时不抛，catch + log + 加进 skipped。
 *
 * @param packageName 完整 npm 包名（如 `@ai-setting/roy-plugin-task-show`），必须已 strip 过 `@version` 后缀
 * @param options cleanup 选项
 * @returns CleanupResult 包含 cleaned / skipped / backups
 */
export function cleanupStalePluginCopies(
  packageName: string,
  options: CleanupOptions
): CleanupResult {
  const HOME = options.homedir ?? nodeHomedir();
  const paths = options.localNodeModulesPaths ?? [
    join(HOME, "node_modules"), // cwd-up 解析落点（Bun / Node 标准行为）
    join(HOME, ".roy-bot", "node_modules"), // Task #2899 之前的 cp 副本路径
  ];
  const backupRoot = options.backupDir ?? nodeTmpdir();

  const result: CleanupResult = {
    cleaned: [],
    skipped: [],
    backups: [],
  };

  if (!options.globalVersion) {
    // 防御性：caller 没传 globalVersion，全部 skip
    for (const p of paths) {
      const candidate = join(p, packageName);
      result.skipped.push({ path: candidate, reason: "no-global-version" });
    }
    return result;
  }

  for (const nmPath of paths) {
    const localPkgDir = join(nmPath, packageName);
    const localPkgJson = join(localPkgDir, "package.json");

    if (!existsSync(localPkgJson)) {
      result.skipped.push({ path: localPkgDir, reason: "no-local-copy" });
      continue;
    }

    // 读取版本
    let localVersion: string | null = null;
    try {
      const pkg = JSON.parse(readFileSync(localPkgJson, "utf-8"));
      localVersion = typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      // corrupted JSON → 当作 stale 处理（强制删除）
      localVersion = null;
    }

    // 决定是否清理
    const shouldClean = localVersion === null || compareVersions(localVersion, options.globalVersion) < 0;

    if (!shouldClean) {
      result.skipped.push({ path: localPkgDir, reason: "local-equal-or-newer" });
      continue;
    }

    // backup + rm（best-effort）
    let backupPath: string | null = null;
    try {
      // 包名只允许 [a-zA-Z0-9._/-] — 把 `@` 替换成空，避免 backup 目录出现前导 `-`，
      // 保留 `/` 以反映 scope 结构
      const safeName = packageName.replace(/@/g, "").replace(/[^a-zA-Z0-9._/-]/g, "-");
      const safeLocalVersion = (localVersion ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "-");
      const timestamp = Date.now();
      backupPath = join(backupRoot, `${safeName}-${safeLocalVersion}-backup-${timestamp}`);
      cpSync(localPkgDir, backupPath, { recursive: true });
      result.backups.push({ originalPath: localPkgDir, backupPath });
    } catch (err) {
      // backup 失败 → log warn 但继续 rm（best-effort；用户回滚靠 npm reinstall 即可）
      backupPath = null;
      console.warn(`⚠️  Failed to backup stale copy at '${localPkgDir}': ${err}`);
    }

    try {
      rmSync(localPkgDir, { recursive: true, force: true });
      result.cleaned.push(localPkgDir);
    } catch (err) {
      // rm 失败 → 跳过 + log warn
      console.warn(`⚠️  Failed to remove stale copy at '${localPkgDir}': ${err}`);
      result.skipped.push({ path: localPkgDir, reason: "cleanup-failed" });
      // 同时把 backup 撤掉（如果 backup 成功但 rm 失败，保留 backup 给用户回滚）
      if (backupPath) {
        // backup 留着；log 一下方便用户回滚
        console.warn(`   ↪ Backup preserved at '${backupPath}' for manual recovery`);
      }
    }
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Semver 比较（仅 major.minor.patch 三段足够）。
 *
 *   compareVersions("1.0.0", "1.0.5") → -1
 *   compareVersions("1.0.5", "1.0.5") →  0
 *   compareVersions("2.0.0", "1.0.5") → +1
 *
 * 不实现完整 semver 规范（pre-release tags / build metadata 等）— 对插件版本
 * 三段数字足够；任何解析失败走 Number.isNaN 防御。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10));
  const pb = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    const diff = na - nb;
    if (diff !== 0) return diff;
  }
  return 0;
}
