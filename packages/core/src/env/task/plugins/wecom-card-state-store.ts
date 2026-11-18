/**
 * @fileoverview WecomCardStateStore — 企微任务进展消息的持久化记录（Task #5193）
 *
 * ## 为什么需要（与 lark-cards.db 同因）
 *
 * 企微 wecom-cli **没有** interactive card / 消息更新 API ——
 * 进展卡片是**每次更新发一条新 markdown**。但节流判定、
 * 「无卡片不凭空发卡」守卫、终态收尾都需要知道
 * 「这个 task 是否发过、发到哪个 chat、当前什么状态」。
 *
 * ## 与 lark-card-state-store 的关系
 *
 * 结构对齐（同一套接口语义），但**独立库文件**（wecom-cards.db）：
 * - lark-cards.db 有 messageId（可 patch 同一张卡）
 * - wecom-cards.db 无 messageId 语义（每条都是新消息），
 *   记录 `taskId → chatId / status / timeline / updateCount`
 *
 * ## 记录生命周期
 *
 * ```
 * create 成功 → upsert({status:"open"})
 * update 成功 → touch（updateCount+1，timeline 追加）
 * 节流        → touch timeline（数据不丢，只是不发）
 * completed/failed/cancelled → markClosed()
 * delete      → markClosed()（保留记录便于追溯）
 * ```
 *
 * ★ 终态**不删除**记录：保留 chatId / timeline 便于事后追溯。
 */

import { join } from "path";
import { createLogger } from "../../log-trace/logger";
import { createCompatibleDatabase } from "../storage/sqlite-task-store";

const logger = createLogger("wecom:card-state");

// ============================================================================
// 类型
// ============================================================================

/** 记录状态（与 LarkCardRecordStatus 语义一致） */
export type WecomCardRecordStatus = "open" | "paused" | "closed";

/** 一条企微卡片持久化记录 */
export interface WecomCardState {
  /** 任务 ID（主键） */
  taskId: number;
  /** 企微 chat_id（单聊=userid，群聊=chatid） */
  chatId: string;
  /** 当前 pin 状态（企微无 pin，恒 false；保留字段对齐接口） */
  pinned: boolean;
  /** 记录状态 */
  status: WecomCardRecordStatus;
  /** 首次发卡时间（ms epoch） */
  createdAt: number;
  /** 最后更新时间（ms epoch） */
  updatedAt: number;
  /** 终结时间（ms epoch）；仅 status=closed 有值 */
  closedAt?: number;
  /** 已发送的更新条数（诊断用） */
  updateCount: number;
  /**
   * 累积时间线（JSON 字符串：Milestone[]）
   *
   * ★ 企微每次发新消息都要带**完整历史时间线**（无 patch 能力），
   *   所以时间线必须持久化 —— 重启后第一条 update 也要能渲染
   *   完整历史。
   */
  timeline?: string;
}

/** 持久化端口（hook 只依赖这个接口，便于测试注入内存实现） */
export interface WecomCardStateStore {
  /** 写入或覆盖一条记录 */
  upsert(state: WecomCardState): void;
  /** 按 taskId 读取 */
  get(taskId: number): WecomCardState | undefined;
  /** 列出全部记录（诊断用） */
  list(): WecomCardState[];
  /** 标记为暂停（保留记录） */
  markPaused(taskId: number): void;
  /** 从暂停/终结翻回进行中（resume） */
  markReopened(taskId: number): void;
  /** 标记终结（completed / failed / cancelled / deleted） */
  markClosed(taskId: number): void;
  /** 真删除（仅测试/手工清理用） */
  delete(taskId: number): void;
  /** 释放资源 */
  close(): void;
}

// ============================================================================
// 内存实现（测试 / SQLite 不可用时的降级目标）
// ============================================================================

/**
 * 内存实现（测试 / 降级）
 *
 * ★ 独立导出（`createMemoryWecomCardStore`），测试直接用，
 *   不经过 `createWecomCardStateStore` 的测试环境守卫。
 */
export class MemoryWecomCardStateStore implements WecomCardStateStore {
  private readonly records = new Map<number, WecomCardState>();

  upsert(state: WecomCardState): void {
    this.records.set(state.taskId, { ...state });
  }

  get(taskId: number): WecomCardState | undefined {
    const r = this.records.get(taskId);
    return r ? { ...r } : undefined;
  }

  list(): WecomCardState[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  markPaused(taskId: number): void {
    const r = this.records.get(taskId);
    if (!r) return;
    r.status = "paused";
    r.updatedAt = Date.now();
  }

  markReopened(taskId: number): void {
    const r = this.records.get(taskId);
    if (!r) return;
    r.status = "open";
    delete r.closedAt;
    r.updatedAt = Date.now();
  }

  markClosed(taskId: number): void {
    const r = this.records.get(taskId);
    if (!r) return;
    const now = Date.now();
    r.status = "closed";
    r.closedAt = now;
    r.updatedAt = now;
  }

  delete(taskId: number): void {
    this.records.delete(taskId);
  }

  close(): void {
    this.records.clear();
  }
}

/** 测试工厂：内存 store */
export function createMemoryWecomCardStore(): WecomCardStateStore {
  return new MemoryWecomCardStateStore();
}

// ============================================================================
// SQLite 实现
// ============================================================================

interface CardRow {
  task_id: number;
  chat_id: string;
  pinned: number;
  status: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  update_count: number;
  timeline: string | null;
}

function rowToState(row: CardRow): WecomCardState {
  const state: WecomCardState = {
    taskId: row.task_id,
    chatId: row.chat_id,
    pinned: row.pinned === 1,
    status: (row.status as WecomCardRecordStatus) ?? "open",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updateCount: row.update_count ?? 0,
  };
  if (row.closed_at !== null && row.closed_at !== undefined) {
    state.closedAt = row.closed_at;
  }
  if (row.timeline) state.timeline = row.timeline;
  return state;
}

export class SqliteWecomCardStateStore implements WecomCardStateStore {
  private readonly db: any;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const { mkdirSync } = require("fs");
      const dir = require("path").dirname(dbPath);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // 目录可能已存在
      }
    }

    this.db = createCompatibleDatabase(dbPath);
    // 并发鲁棒性（与 lark-cards.db 同配方）
    try {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA busy_timeout = 5000");
      this.db.run("PRAGMA synchronous = NORMAL");
    } catch {
      // PRAGMA 不可用时继续
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wecom_card (
        task_id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        update_count INTEGER NOT NULL DEFAULT 0,
        timeline TEXT
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wecom_card_status ON wecom_card(status)"
    );
  }

  upsert(state: WecomCardState): void {
    this.db
      .prepare(
        `INSERT INTO wecom_card
          (task_id, chat_id, pinned, status, created_at, updated_at, closed_at, update_count, timeline)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           chat_id     = excluded.chat_id,
           pinned      = excluded.pinned,
           status      = excluded.status,
           updated_at  = excluded.updated_at,
           closed_at   = excluded.closed_at,
           update_count = excluded.update_count,
           timeline    = excluded.timeline`
      )
      .run(
        state.taskId,
        state.chatId,
        state.pinned ? 1 : 0,
        state.status,
        state.createdAt,
        state.updatedAt,
        state.closedAt ?? null,
        state.updateCount,
        state.timeline ?? null
      );
  }

  get(taskId: number): WecomCardState | undefined {
    const row = this.db
      .prepare("SELECT * FROM wecom_card WHERE task_id = ?")
      .get(taskId) as CardRow | null;
    return row ? rowToState(row) : undefined;
  }

  list(): WecomCardState[] {
    const rows = this.db
      .prepare("SELECT * FROM wecom_card ORDER BY task_id ASC")
      .all() as CardRow[];
    return rows.map(rowToState);
  }

  markPaused(taskId: number): void {
    this.db
      .prepare("UPDATE wecom_card SET status = 'paused', updated_at = ? WHERE task_id = ?")
      .run(Date.now(), taskId);
  }

  markReopened(taskId: number): void {
    this.db
      .prepare(
        "UPDATE wecom_card SET status = 'open', closed_at = NULL, updated_at = ? WHERE task_id = ?"
      )
      .run(Date.now(), taskId);
  }

  markClosed(taskId: number): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE wecom_card SET status = 'closed', closed_at = ?, updated_at = ? WHERE task_id = ?"
      )
      .run(now, now, taskId);
  }

  delete(taskId: number): void {
    this.db.prepare("DELETE FROM wecom_card WHERE task_id = ?").run(taskId);
  }

  close(): void {
    try {
      this.db.close?.();
    } catch {
      // close 失败不影响主流程
    }
  }
}

// ============================================================================
// 工厂（失败降级）
// ============================================================================

/** 默认库文件路径：`$HOME/.local/share/roy-bot/wecom-cards.db` */
export function getDefaultWecomCardDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".local", "share", "roy-bot", "wecom-cards.db");
}

/**
 * 创建持久化 store
 *
 * ★ 失败降级：SQLite 打不开时**不抛错**，回落内存实现并 warn ——
 *   卡片该发还得发，绝不能因为持久化层故障让通知路径整体崩掉。
 *
 * ★ 测试环境保护（与 createLarkCardStateStore 同配方）：
 *   bun test 环境 + 未显式指定路径 → 一律返回内存实现（零副作用），
 *   防止测试污染真实用户库。
 */
export function createWecomCardStateStore(dbPath?: string): WecomCardStateStore {
  const isTestEnv =
    process.env.NODE_ENV === "test" || "BUN_TEST_WORKER_ID" in process.env;
  if (!dbPath && !process.env.ROY_AGENT_WECOM_CARD_DB && isTestEnv) {
    return new MemoryWecomCardStateStore();
  }

  const path = dbPath ?? process.env.ROY_AGENT_WECOM_CARD_DB ?? getDefaultWecomCardDbPath();
  try {
    return new SqliteWecomCardStateStore(path);
  } catch (err) {
    logger.warn(
      `WecomCardStateStore: sqlite unavailable at ${path} (${(err as Error).message}) ` +
        `→ falling back to in-memory (卡片仍可发，但重启后时间线丢失)`
    );
    return new MemoryWecomCardStateStore();
  }
}
