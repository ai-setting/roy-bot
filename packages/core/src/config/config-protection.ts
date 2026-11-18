/**
 * Config protection utilities — ~/.roy-bot 配置事故系统性防护（Task #5194）
 *
 * 背景：2026-11-07/11-08 连续三起 ~/.roy-bot 配置被覆盖/重置事故
 * （测试覆盖 ×2、daily-summary 副本手动覆盖 ×1）。路径级守卫
 * （Task #5181 测试隔离）已封死测试写路径，但内容级覆盖
 * （合法写入者写坏内容）无法靠路径守卫防住。
 *
 * 三道护栏：
 *   1. snapshotConfigDir  — 写前快照，保留最近 N=10 份，可回滚
 *   2. appendAuditLog     — 写入审计（谁/何时/什么），排查不再考古
 *   3. checkSourceCountDrop — 源数骤降 >30% 检测（fail-safe 拒绝覆盖）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";

/** 需要快照保护的关键配置文件 */
export const PROTECTED_CONFIG_FILES = [
  "config.jsonc",
  "auth.json",
  "event-sources.json",
  "wecom-credentials.json",
] as const;

/** 快照保留数量 */
export const SNAPSHOT_KEEP = 10;

/** 快照目录名 */
const SNAPSHOTS_DIRNAME = "snapshots";

/** 审计日志文件名 */
const AUDIT_LOG_FILENAME = "audit.log";

/** 快照目录下文件名（记录快照时间） */
const SNAP_META_FILENAME = ".snapshot-meta.json";

/** 快照目录权限（凭据快照不得比原件更宽松，opencodego review MINOR-5） */
const SNAPSHOT_DIR_MODE = 0o700;
/** 快照内文件权限 */
const SNAPSHOT_FILE_MODE = 0o600;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 文件名安全的时间戳（如 2026-11-08T21-37-13-512Z） */
export function snapshotTimestamp(d: Date = new Date()): string {
  return (
    d.getUTCFullYear() +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    "T" +
    pad2(d.getUTCHours()) +
    "-" +
    pad2(d.getUTCMinutes()) +
    "-" +
    pad2(d.getUTCSeconds()) +
    "-" +
    String(d.getUTCMilliseconds()).padStart(3, "0") +
    "Z"
  );
}

function snapshotsDir(configDir: string): string {
  return join(configDir, SNAPSHOTS_DIRNAME);
}

/**
 * 对 configDir 下的关键配置文件做一次快照。
 *
 * - 只快照存在的文件（缺失跳过，不报错）
 * - configDir 不存在时返回 null（不抛错）
 * - 快照后清理最旧快照，保留最近 SNAPSHOT_KEEP 份
 *
 * @returns 快照目录路径；configDir 不存在时返回 null
 */
export function snapshotConfigDir(configDir: string, now: Date = new Date()): string | null {
  if (!existsSync(configDir)) return null;

  const snapRoot = snapshotsDir(configDir);
  mkdirSync(snapRoot, { recursive: true });

  const ts = snapshotTimestamp(now);
  const snapDir = join(snapRoot, ts);
  mkdirSync(snapDir, { recursive: true, mode: SNAPSHOT_DIR_MODE });
  // mkdirSync mode 仅在新建时生效；已存在目录强制收紧
  try {
    chmodSync(snapDir, SNAPSHOT_DIR_MODE);
  } catch {
    // 权限收紧失败不阻断快照
  }

  for (const file of PROTECTED_CONFIG_FILES) {
    const src = join(configDir, file);
    if (!existsSync(src)) continue;
    try {
      writeFileSync(join(snapDir, file), readFileSync(src), { mode: SNAPSHOT_FILE_MODE });
    } catch {
      // 单文件快照失败不阻断整体（如权限问题），尽力而为
    }
  }

  // meta：记录快照时刻与来源目录，便于回滚时确认
  writeFileSync(
    join(snapDir, SNAP_META_FILENAME),
    JSON.stringify({ ts: now.toISOString(), source: configDir, pid: process.pid }),
  );

  pruneSnapshots(snapRoot, SNAPSHOT_KEEP);
  return snapDir;
}

/** 列出现有快照目录（按时间戳名排序，旧→新） */
export function listSnapshots(configDir: string): string[] {
  const root = snapshotsDir(configDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => !n.startsWith("."))
    .sort()
    .map((n) => join(root, n));
}

/** 清理最旧快照，保留最近 keep 份 */
function pruneSnapshots(snapRoot: string, keep: number): void {
  const all = readdirSync(snapRoot)
    .filter((n) => !n.startsWith("."))
    .sort();
  const excess = all.length - keep;
  for (let i = 0; i < excess; i++) {
    try {
      rmSync(join(snapRoot, all[i]), { recursive: true, force: true });
    } catch {
      // 清理失败不阻断
    }
  }
}

/** 单条审计记录 */
export interface AuditEntry {
  /** ISO 时间戳 */
  ts: string;
  /** 写入进程 pid */
  pid: number;
  /** 被写文件名 */
  file: string;
  /** 动作（如 save / pre-save-snapshot / drop-blocked） */
  action: string;
  /** 补充信息 */
  detail?: string;
}

/**
 * 追加一条审计记录到 <configDir>/audit.log（每行一个 JSON）。
 * 失败静默（审计绝不能反过来弄坏配置写入主流程）。
 */
export function appendAuditLog(configDir: string, entry: Omit<AuditEntry, "ts" | "pid">): void {
  try {
    const full: AuditEntry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      ...entry,
    };
    appendFileSync(join(configDir, AUDIT_LOG_FILENAME), JSON.stringify(full) + "\n");
  } catch {
    // 审计失败不阻断主流程
  }
}

/** 读取审计日志（解析失败的行跳过） */
export function readAuditLog(configDir: string): AuditEntry[] {
  const p = join(configDir, AUDIT_LOG_FILENAME);
  if (!existsSync(p)) return [];
  const out: AuditEntry[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 跳过损坏行
    }
  }
  return out;
}

/** 源数骤降检查结果 */
export interface SourceDropCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * 源数骤降检测（Task #5188 P1 建议）。
 *
 * 规则：previousCount 合法（>0）且 newCount 下降超过 30% ⇒ 拒绝。
 * previousCount <= 0（无盘上配置/读取失败）时放行。
 *
 * @param previousCount 磁盘上现有源数
 * @param newCount 本次要写入的源数
 */
export function checkSourceCountDrop(previousCount: number, newCount: number): SourceDropCheck {
  if (previousCount <= 0) return { allowed: true };
  if (newCount >= previousCount) return { allowed: true };
  const dropRatio = (previousCount - newCount) / previousCount;
  if (dropRatio > 0.3) {
    return {
      allowed: false,
      reason: `source count drop ${(dropRatio * 100).toFixed(0)}% (${previousCount} -> ${newCount}) exceeds 30% threshold; refusing to overwrite (ROY_AGENT_ES_FORCE_SAVE=1 to override)`,
    };
  }
  return { allowed: true };
}

/**
 * 读取磁盘上 event-sources.json 的源数；文件缺失/损坏返回 -1。
 */
export function readSourceCountFromDisk(configPath: string): number {
  try {
    if (!existsSync(configPath)) return -1;
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!cfg || !Array.isArray(cfg.sources)) return -1;
    return cfg.sources.length;
  } catch {
    return -1;
  }
}

/** utimes helper for tests (exported so tests need no require hack) */
export function setTimestamps(p: string, d: Date): void {
  utimesSync(p, d, d);
}

/**
 * 通用护栏写入包装（Task #5194 opencodego review MAJOR-1）。
 *
 * 背景：护栏原先只接 event-sources.json 一个写入口，
 * config.jsonc / auth.json 的写入路径（fallback-model-command、
 * cli app-config-io）零接线 ⇒ 事故 1/2 的主要目标文件裸奔。
 *
 * 语义：写前快照（可回滚）→ 执行 writeFn → 写后审计。
 * - writeFn 抛错 ⇒ 返回 false 并记 write-failed 审计（错误原样上抛由调用方决定）
 * - 快照/审计失败不阻断写入主流程（护栏绝不能弄坏配置写入）
 *
 * @param configDir 配置目录（如 ~/.roy-bot）
 * @param file 被写文件名（如 config.jsonc）
 * @param writeFn 实际写入动作（同步）
 * @returns true=写入成功；false=写入抛错
 */
export function guardConfigWrite(
  configDir: string,
  file: string,
  writeFn: () => void
): boolean {
  // 写前快照（旧内容可回滚）
  try {
    const snapDir = snapshotConfigDir(configDir);
    if (snapDir) {
      appendAuditLog(configDir, {
        file,
        action: "pre-save-snapshot",
        detail: `snapshot=${snapDir}`,
      });
    }
  } catch {
    // 快照失败不阻断写入
  }

  try {
    writeFn();
  } catch (err) {
    appendAuditLog(configDir, {
      file,
      action: "write-failed",
      detail: (err as Error)?.message ?? String(err),
    });
    return false;
  }

  appendAuditLog(configDir, { file, action: "save" });
  return true;
}
