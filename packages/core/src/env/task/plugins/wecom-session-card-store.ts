/**
 * @fileoverview WecomSessionCardStore — 企微 **session 卡**的持久化记录（Task #5364）
 *
 * ## 为什么需要（B 方案的核心前提）
 *
 * 用户 2026-11-12 08:34 拍板 **B**：
 *
 * > 「企微改成**只维护一张卡 + 靠按钮触发更新**」
 *
 * 企微协议硬约束（#5203 已取证）：`aibot_respond_update_msg` **必须**在
 * `template_card_event` 回调的 5 秒窗口内、用回调带回的 `req_id` 才能更新卡片。
 * 生命周期事件不是回调、没有 req_id ⇒ **无法主动 patch**。
 *
 * 于是 #5360 的实现退化成「每个生命周期发一张新卡」—— 用户明确否掉（重复卡
 * + 刷屏）。B 方案换一条路：
 *
 * ```
 * 首次 lifecycle 事件 → 发**一张**卡（记住 cardTaskId）
 * 后续 lifecycle 事件 → 只写本 store（不发送）
 * 用户点「刷新」按钮   → 有 req_id 了 → 从本 store 读快照 + 实时活性 → patch 同一张卡
 * ```
 *
 * ⇒ **本 store 是「刷新时能重建整张卡」的唯一数据来源**。缺了它，刷新只能
 * 显示活性，生命周期/标题/操作记录全丢 —— 直接违反用户「原有信息一个不少」。
 *
 * ## 为什么不复用 wecom-card-state-store（task 维度）
 *
 * `wecom_card.task_id INTEGER PRIMARY KEY` 结构上装不下 `session_xxx` 字符串。
 * 硬塞要么改主键类型（旧库迁移风险），要么把 sessionId hash 成数字（不可逆，
 * 刷新时反解不回来）。所以**独立库文件 + 独立表 + 字符串主键**，零迁移风险。
 *
 * 库文件：`~/.local/share/roy-bot/wecom-session-cards.db`
 */

import { join } from "path";
import { createLogger } from "../../log-trace/logger";
import { createCompatibleDatabase } from "../storage/sqlite-task-store";

const logger = createLogger("wecom:session-card-state");

// ============================================================================
// 类型
// ============================================================================

/** session 卡生命周期（与 wecom-card-builder 的 WecomSessionLifecycle 同义） */
export type WecomSessionCardLifecycle =
  | "running"
  | "completed"
  | "timeout"
  | "failed"
  | "stopped";

/** 卡片上的一条执行动态（与 WecomMilestoneLite 结构兼容） */
export interface WecomSessionMilestone {
  title: string;
  timestamp: string;
  description?: string;
}

/** 一条 session 卡持久化记录 */
export interface WecomSessionCardState {
  /** ★ 主键：sub-session id（字符串，非 task 号） */
  sessionId: string;
  /** 企微 chat_id（单聊=userid，群聊=chatid） */
  chatId: string;
  /** 会话类型（更新发送/诊断用） */
  chatType: "single" | "group";
  /** 事件源 ID（WS 实例反查用；刷新端口不依赖它，但诊断需要） */
  sourceId?: string;
  /**
   * ★ 首次发卡时卡片上的 `template_card.task_id`。
   *
   * 刷新帧的 `task_id` **必须**与回调带回的值一致（协议硬约束），
   * 所以这个值必须持久化 —— 否则重启后刷新会因为 task_id 不匹配而失败。
   */
  cardTaskId: string;
  /** 当前生命周期 */
  lifecycle: WecomSessionCardLifecycle;
  /** 会话标题（description / agent 名） */
  title?: string;
  /** 所属 agent（subagentType） */
  agentType?: string;
  /** 开始时间（ISO） */
  startedAt?: string;
  /** 该 session 关联的 roy 任务号（可选增强） */
  associatedTaskId?: number;
  /** 累积执行动态（JSON 字符串：WecomSessionMilestone[]） */
  milestones?: string;
  /** 首次发卡时间（ms epoch） */
  createdAt: number;
  /** 最后更新时间（ms epoch） */
  updatedAt: number;
  /** 终结时间（ms epoch）；仅终态有值 */
  closedAt?: number;
}

/** 持久化端口（sender / 刷新 handler 只依赖这个接口，便于测试注入） */
export interface WecomSessionCardStore {
  /** 写入或覆盖一条记录 */
  upsert(state: WecomSessionCardState): void;
  /** 按 sessionId 读取 */
  get(sessionId: string): WecomSessionCardState | undefined;
  /** 列出全部记录（诊断用） */
  list(): WecomSessionCardState[];
  /** 标记终结（保留 cardTaskId 便于事后追溯） */
  markClosed(sessionId: string): void;
  /** 真删除（仅测试/手工清理用） */
  delete(sessionId: string): void;
  /** 释放资源 */
  close(): void;
}

// ============================================================================
// 内存实现（测试 / SQLite 不可用时的降级目标）
// ============================================================================

/** 内存实现（测试直接用，不经过 createWecomSessionCardStore 的环境守卫） */
export class MemoryWecomSessionCardStore implements WecomSessionCardStore {
  private readonly records = new Map<string, WecomSessionCardState>();

  upsert(state: WecomSessionCardState): void {
    this.records.set(state.sessionId, { ...state });
  }

  get(sessionId: string): WecomSessionCardState | undefined {
    const r = this.records.get(sessionId);
    return r ? { ...r } : undefined;
  }

  list(): WecomSessionCardState[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  markClosed(sessionId: string): void {
    const r = this.records.get(sessionId);
    if (!r) return;
    const now = Date.now();
    r.lifecycle = r.lifecycle === "running" ? "completed" : r.lifecycle;
    r.closedAt = now;
    r.updatedAt = now;
  }

  delete(sessionId: string): void {
    this.records.delete(sessionId);
  }

  close(): void {
    this.records.clear();
  }
}

/** 测试工厂：内存 store */
export function createMemoryWecomSessionCardStore(): WecomSessionCardStore {
  return new MemoryWecomSessionCardStore();
}

// ============================================================================
// SQLite 实现
// ============================================================================

interface SessionCardRow {
  session_id: string;
  chat_id: string;
  chat_type: string;
  source_id: string | null;
  card_task_id: string;
  lifecycle: string;
  title: string | null;
  agent_type: string | null;
  started_at: string | null;
  associated_task_id: number | null;
  milestones: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

function rowToSessionState(row: SessionCardRow): WecomSessionCardState {
  const state: WecomSessionCardState = {
    sessionId: row.session_id,
    chatId: row.chat_id,
    chatType: row.chat_type === "group" ? "group" : "single",
    cardTaskId: row.card_task_id,
    lifecycle: (row.lifecycle as WecomSessionCardLifecycle) ?? "running",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.source_id) state.sourceId = row.source_id;
  if (row.title) state.title = row.title;
  if (row.agent_type) state.agentType = row.agent_type;
  if (row.started_at) state.startedAt = row.started_at;
  if (row.associated_task_id !== null && row.associated_task_id !== undefined) {
    state.associatedTaskId = row.associated_task_id;
  }
  if (row.milestones) state.milestones = row.milestones;
  if (row.closed_at !== null && row.closed_at !== undefined) {
    state.closedAt = row.closed_at;
  }
  return state;
}

export class SqliteWecomSessionCardStore implements WecomSessionCardStore {
  private readonly db: any;

  constructor(dbPath: string) {
    this.db = createCompatibleDatabase(dbPath);
    // 并发鲁棒性（与 lark-cards.db / wecom-cards.db 同配方）
    try {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA busy_timeout = 5000");
      this.db.run("PRAGMA synchronous = NORMAL");
    } catch {
      // PRAGMA 不可用时继续
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wecom_session_card (
        session_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT 'single',
        source_id TEXT,
        card_task_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'running',
        title TEXT,
        agent_type TEXT,
        started_at TEXT,
        associated_task_id INTEGER,
        milestones TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_wecom_session_card_lifecycle " +
        "ON wecom_session_card(lifecycle)",
    );
  }

  upsert(state: WecomSessionCardState): void {
    this.db
      .prepare(
        `INSERT INTO wecom_session_card
          (session_id, chat_id, chat_type, source_id, card_task_id, lifecycle,
           title, agent_type, started_at, associated_task_id, milestones,
           created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           chat_id            = excluded.chat_id,
           chat_type          = excluded.chat_type,
           source_id          = excluded.source_id,
           card_task_id       = excluded.card_task_id,
           lifecycle          = excluded.lifecycle,
           title              = excluded.title,
           agent_type         = excluded.agent_type,
           started_at         = excluded.started_at,
           associated_task_id = excluded.associated_task_id,
           milestones         = excluded.milestones,
           updated_at         = excluded.updated_at,
           closed_at          = excluded.closed_at`,
      )
      .run(
        state.sessionId,
        state.chatId,
        state.chatType,
        state.sourceId ?? null,
        state.cardTaskId,
        state.lifecycle,
        state.title ?? null,
        state.agentType ?? null,
        state.startedAt ?? null,
        state.associatedTaskId ?? null,
        state.milestones ?? null,
        state.createdAt,
        state.updatedAt,
        state.closedAt ?? null,
      );
  }

  get(sessionId: string): WecomSessionCardState | undefined {
    const row = this.db
      .prepare("SELECT * FROM wecom_session_card WHERE session_id = ?")
      .get(sessionId) as SessionCardRow | null;
    return row ? rowToSessionState(row) : undefined;
  }

  list(): WecomSessionCardState[] {
    const rows = this.db
      .prepare("SELECT * FROM wecom_session_card ORDER BY created_at ASC")
      .all() as SessionCardRow[];
    return rows.map(rowToSessionState);
  }

  markClosed(sessionId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE wecom_session_card SET closed_at = ?, updated_at = ? " +
          "WHERE session_id = ?",
      )
      .run(now, now, sessionId);
  }

  delete(sessionId: string): void {
    this.db
      .prepare("DELETE FROM wecom_session_card WHERE session_id = ?")
      .run(sessionId);
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

/** 默认库文件路径：`$HOME/.local/share/roy-bot/wecom-session-cards.db` */
export function getDefaultWecomSessionCardDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".local", "share", "roy-bot", "wecom-session-cards.db");
}

/**
 * 创建持久化 store。
 *
 * ★ 失败降级：SQLite 打不开时**不抛错**，回落内存实现并 warn ——
 *   卡片刷新不能因为持久化层故障整体崩掉（降级后「只发一张卡」语义在
 *   单进程内仍成立，只是重启后可能重发一张）。
 *
 * ★ 测试环境保护（与 createWecomCardStateStore 同配方）：
 *   bun test 环境 + 未显式指定路径 → 一律返回内存实现（零副作用），
 *   防止测试污染真实用户库。
 */
export function createWecomSessionCardStore(
  dbPath?: string,
): WecomSessionCardStore {
  const isTestEnv =
    process.env.NODE_ENV === "test" || "BUN_TEST_WORKER_ID" in process.env;
  if (!dbPath && !process.env.ROY_AGENT_WECOM_SESSION_CARD_DB && isTestEnv) {
    return new MemoryWecomSessionCardStore();
  }

  const path =
    dbPath ??
    process.env.ROY_AGENT_WECOM_SESSION_CARD_DB ??
    getDefaultWecomSessionCardDbPath();
  try {
    return new SqliteWecomSessionCardStore(path);
  } catch (err) {
    logger.warn(
      `WecomSessionCardStore: sqlite unavailable at ${path} ` +
        `(${(err as Error).message}) —— 降级为内存实现`,
    );
    return new MemoryWecomSessionCardStore();
  }
}
// ============================================================================
// 进程级共享单例（★ Task #5364 关键）
// ============================================================================

/**
 * 进程内共享 store 单例。
 *
 * ## 为什么必须共享同一实例（这条是整个 B 方案的接线命门）
 *
 * 写入方与读取方在**两个不同模块**：
 * - 写入：`event-handler-wiring.ts` 里的企微 session 卡 sender（生命周期事件）
 * - 读取：`wecom-cli-handler.ts` 里的 `loadSessionCardState`（用户点刷新）
 *
 * 如果两边各 `createWecomSessionCardStore()` 一次，就是**两个不同的 store**：
 * sender 把 lifecycle=completed 写进第 1 个，刷新从第 2 个读 ⇒ 什么都读不到
 * ⇒ 卡片永远停在「运行中」，而且 `get()` 返回 undefined 还会让 sender 误判
 * 「没发过卡」→ 重发第二张卡（同时违背 B 方案的两条要求）。
 *
 * ⇒ 单例放在 core 侧，两侧都调本函数取。
 */
let sharedStore: WecomSessionCardStore | null = null;

/** 取（并在首次调用时创建）进程级共享 session 卡 store。 */
export function getSharedWecomSessionCardStore(): WecomSessionCardStore {
  if (!sharedStore) {
    sharedStore = createWecomSessionCardStore();
  }
  return sharedStore;
}

/**
 * 测试钩子：重置共享单例（关闭旧连接，避免 fd 泄漏 / 跨用例串状态）。
 */
export function __resetSharedWecomSessionCardStoreForTest(): void {
  try {
    sharedStore?.close?.();
  } catch {
    /* ignore */
  }
  sharedStore = null;
}
