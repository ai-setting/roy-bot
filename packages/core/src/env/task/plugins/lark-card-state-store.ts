/**
 * @fileoverview LarkCardStateStore — 任务进展卡片消息的**持久化**记录（Task #4536）
 *
 * ## 为什么需要
 *
 * `LarkCliTaskNotifyHook` 原来只把「taskId → messageId」存在内存 `Map` 里：
 *
 * ```typescript
 * private cardMessageIds: Map<number, string> = new Map();
 * ```
 *
 * ⇒ roy-bot 进程一重启，之前发过的卡片**再也无法被 patch**，
 *   变成永远停在「进行中」的孤儿卡片，pin 也一直挂着。
 *
 * ## 设计选型：独立 SQLite 库文件（不写 task.context）
 *
 * | 方案 | 结论 |
 * |------|------|
 * | a) 写 `task.context` | ❌ 写 context 会同步触发 `task:after.update` → 本插件重入（现有 `CARD_START_INFLIGHT_SENTINEL` 就是被这个坑逼出来的）；且 context 会被 `renderTaskInfoLines` 渲染进卡片正文，messageId/chatId 会污染用户可见内容 |
 * | b) 给 `tasks.db` 加表 | ❌ 需要 migration，且插件层拿不到 task store 句柄，耦合更重 |
 *
 * ※ 关于 `task:after.complete` 影响面的准确描述见
 *   `lark-cli-task-notify-plugin.ts` 里 `onAfterUpdate` 的注释（xval round2 NIT-2 更正）。
 * | c) 独立 JSON 文件 | ❌ 无事务、无跨进程锁，并发 hook 会互相覆盖 |
 * | **c') 独立 SQLite 库文件** | ✅ 复用既有 `createCompatibleDatabase`（bun:sqlite / better-sqlite3 双运行时），UPSERT 原子、自带跨进程锁、零 migration |
 *
 * 库文件：`~/.local/share/roy-bot/lark-cards.db`（与 `tasks.db` / `workflows.db` 同目录）
 *
 * ## 记录生命周期
 *
 * ```
 * startTask 成功   → upsert({status: "open",   pinned: true})
 * patch 成功       → upsert/touch（messageId 不变）
 * paused（stop）   → markPaused()  → status="paused"（保留 messageId，resume 可复用）
 * resume           → markReopened()→ status="open"
 * completed/failed/cancelled → markClosed() → status="closed" + closedAt
 * ```
 *
 * ★ 终态**不删除**记录：保留 messageId/chatId 便于事后追溯（用户手动删卡片后
 *   再 patch 会失败，但记录本身仍有诊断价值）。
 */

import { join } from "path";
import { createLogger } from "../../log-trace/logger";
import { createCompatibleDatabase } from "../storage/sqlite-task-store";

const logger = createLogger("lark-cli:card-state");

// ============================================================================
// 类型
// ============================================================================

/**
 * 卡片记录状态
 *
 * - `open`   进行中（卡片 pin 着，可 patch）
 * - `paused` 已暂停（stop）。**保留 messageId**：任务 resume 后继续 patch 同一张卡
 * - `closed` 已终结（completed / failed / cancelled）。记录保留，不再 patch
 */
export type LarkCardRecordStatus = "open" | "paused" | "closed";

/** 一条卡片持久化记录 */
export interface LarkCardState {
  /** 任务 ID（主键） */
  taskId: number;
  /** 飞书 message_id（om_xxx） */
  messageId: string;
  /** 飞书 chat_id（oc_xxx） */
  chatId: string;
  /** lark-cli profile（多 appId 场景） */
  profile?: string;
  /** 当前 pin 状态（true = 置顶中） */
  pinned: boolean;
  /** 记录状态 */
  status: LarkCardRecordStatus;
  /** 首次发卡时间（ms epoch） */
  createdAt: number;
  /** 最后更新时间（ms epoch） */
  updatedAt: number;
  /** 终结时间（ms epoch）；仅 status=closed 有值 */
  closedAt?: number;
  /**
   * ★ Task #5364 返工：该任务卡片实际归属的 **sub-session id**。
   *
   * 用途：进程重启后，`task:after.update` 这类只带 taskId 的事件仍能知道
   * 「该 patch 哪张 **session** 卡」（一个 session 一张卡的前提）。
   * 缺省（旧行 / 非 session 卡）⇒ 走传统 task 卡路径。
   */
  sessionId?: string;
  /**
   * 卡片自持的累积内容（Task #4536 / xval MAJOR 3）
   *
   * ★ 为什么要持久化：`LarkCardPatchNotifier` 的里程碑 / 过程步骤 / 更新计数
   *   只存在内存里。只持久化 messageId 的话，重启后第一次 patch 会用空状态
   *   重建卡片 → 用户看到"暂无里程碑 / 第 1 次更新"，历史进展被静默抹掉。
   *
   * 存 JSON 字符串（不建子表）：内容规模小（每次更新只 append 一条），
   * 读取模式永远是"整张卡一起取出"，不需要按里程碑查询。
   */
  timeline?: string;
}

/** 持久化端口（hook 只依赖这个接口，便于测试注入内存实现） */
export interface LarkCardStateStore {
  /** 写入或覆盖一条记录 */
  upsert(state: LarkCardState): void;
  /** 按 taskId 读取 */
  get(taskId: number): LarkCardState | undefined;
  /** 列出全部记录（诊断用） */
  list(): LarkCardState[];
  /** 更新 pin 状态 */
  markPinned(taskId: number, pinned: boolean): void;
  /** 标记为暂停（保留 messageId） */
  markPaused(taskId: number): void;
  /** 从暂停/终结翻回进行中（resume） */
  markReopened(taskId: number): void;
  /** 标记终结（completed / failed / cancelled） */
  markClosed(taskId: number): void;
  /** 真删除（仅测试/手工清理用） */
  delete(taskId: number): void;
  /** 释放资源 */
  close(): void;
}

// ============================================================================
// 内存实现（测试 / SQLite 不可用时的降级目标）
// ============================================================================

export class MemoryLarkCardStateStore implements LarkCardStateStore {
  private readonly records = new Map<number, LarkCardState>();

  upsert(state: LarkCardState): void {
    this.records.set(state.taskId, { ...state });
  }

  get(taskId: number): LarkCardState | undefined {
    const r = this.records.get(taskId);
    return r ? { ...r } : undefined;
  }

  list(): LarkCardState[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  markPinned(taskId: number, pinned: boolean): void {
    const r = this.records.get(taskId);
    if (!r) return;
    r.pinned = pinned;
    r.updatedAt = Date.now();
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

// ============================================================================
// SQLite 实现
// ============================================================================

interface CardRow {
  task_id: number;
  message_id: string;
  chat_id: string;
  profile: string | null;
  pinned: number;
  status: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  timeline: string | null;
  /** ★ Task #5364 返工（旧库可能无此列 → undefined） */
  session_id?: string | null;
}

function rowToState(row: CardRow): LarkCardState {
  const state: LarkCardState = {
    taskId: row.task_id,
    messageId: row.message_id,
    chatId: row.chat_id,
    pinned: row.pinned === 1,
    status: (row.status as LarkCardRecordStatus) ?? "open",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.profile) state.profile = row.profile;
  if (row.closed_at !== null && row.closed_at !== undefined) {
    state.closedAt = row.closed_at;
  }
  if (row.timeline) state.timeline = row.timeline;
  // ★ Task #5364 返工：session 归属（重启后按 taskId 找回 session 卡用）
  if (row.session_id) state.sessionId = row.session_id;
  return state;
}

export class SqliteLarkCardStateStore implements LarkCardStateStore {
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
    // ★ xval MINOR 5：多进程（roy-bot 主进程 + sub-agent / 多个 ES consumer）
    //   会并发写同一个库。WAL + busy_timeout 让读写不互相饿死；否则 SQLITE_BUSY
    //   会让某次 persistPinned(false) 静默失败 → 记录仍 pinned=true →
    //   resume 时 repinAfterResume 早退 → 卡片永远不再置顶。
    try {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA busy_timeout = 5000");
      this.db.run("PRAGMA synchronous = NORMAL");
    } catch {
      // PRAGMA 不可用时继续（功能不受影响，只是并发鲁棒性略降）
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS lark_card (
        task_id INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        profile TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        timeline TEXT,
        session_id TEXT
      )
    `);
    // 旧库（本次改动之前建的）补列 —— 幂等：列已存在时 SQLite 会报错，忽略即可
    try {
      this.db.run("ALTER TABLE lark_card ADD COLUMN timeline TEXT");
    } catch {
      // 列已存在
    }
    // ★ Task #5364 返工：session_id 列（旧库幂等补列，零迁移风险）
    try {
      this.db.run("ALTER TABLE lark_card ADD COLUMN session_id TEXT");
    } catch {
      // 列已存在
    }
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_lark_card_status ON lark_card(status)"
    );
  }

  upsert(state: LarkCardState): void {
    this.db
      .prepare(
        `INSERT INTO lark_card
          (task_id, message_id, chat_id, profile, pinned, status, created_at, updated_at, closed_at, timeline, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           message_id = excluded.message_id,
           chat_id    = excluded.chat_id,
           profile    = excluded.profile,
           pinned     = excluded.pinned,
           status     = excluded.status,
           updated_at = excluded.updated_at,
           closed_at  = excluded.closed_at,
           timeline   = excluded.timeline,
           session_id = COALESCE(excluded.session_id, lark_card.session_id)`
      )
      .run(
        state.taskId,
        state.messageId,
        state.chatId,
        state.profile ?? null,
        state.pinned ? 1 : 0,
        state.status,
        state.createdAt,
        state.updatedAt,
        state.closedAt ?? null,
        state.timeline ?? null,
        state.sessionId ?? null
      );
  }

  get(taskId: number): LarkCardState | undefined {
    const row = this.db
      .prepare("SELECT * FROM lark_card WHERE task_id = ?")
      .get(taskId) as CardRow | null;
    return row ? rowToState(row) : undefined;
  }

  list(): LarkCardState[] {
    const rows = this.db
      .prepare("SELECT * FROM lark_card ORDER BY task_id ASC")
      .all() as CardRow[];
    return rows.map(rowToState);
  }

  markPinned(taskId: number, pinned: boolean): void {
    this.db
      .prepare("UPDATE lark_card SET pinned = ?, updated_at = ? WHERE task_id = ?")
      .run(pinned ? 1 : 0, Date.now(), taskId);
  }

  markPaused(taskId: number): void {
    this.db
      .prepare("UPDATE lark_card SET status = 'paused', updated_at = ? WHERE task_id = ?")
      .run(Date.now(), taskId);
  }

  markReopened(taskId: number): void {
    this.db
      .prepare(
        "UPDATE lark_card SET status = 'open', closed_at = NULL, updated_at = ? WHERE task_id = ?"
      )
      .run(Date.now(), taskId);
  }

  markClosed(taskId: number): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE lark_card SET status = 'closed', closed_at = ?, updated_at = ? WHERE task_id = ?"
      )
      .run(now, now, taskId);
  }

  delete(taskId: number): void {
    this.db.prepare("DELETE FROM lark_card WHERE task_id = ?").run(taskId);
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

/** 默认库文件路径：`$HOME/.local/share/roy-bot/lark-cards.db` */
export function getDefaultLarkCardDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".local", "share", "roy-bot", "lark-cards.db");
}

/**
 * 创建持久化 store
 *
 * ★ 失败降级：SQLite 打不开（权限 / 磁盘满 / 运行时缺 sqlite）时
 *   **不抛错**，回落内存实现并 warn —— 卡片该发还得发，绝不能因为
 *   持久化层故障让通知路径整体崩掉（诉求 C：健壮性）。
 */
export function createLarkCardStateStore(dbPath?: string): LarkCardStateStore {
  // ★ 测试环境保护（2026-10-25 破坏性自检抓到的真实事故）：
  //   bun test 默认 NODE_ENV=test，且大量既有单测直接 `new LarkCliTaskNotifyHook()`
  //   不注入 store。若这里落默认路径，测试会**污染真实用户库**
  //   （`~/.local/share/roy-bot/lark-cards.db`），并把 taskId 相同（#42）
  //   的真实记录读进单测 → 既有测试大面积误红。
  //   ⇒ 测试环境 + 未显式指定路径时一律返回内存实现（零副作用）。
  const isTestEnv =
    process.env.NODE_ENV === "test" || "BUN_TEST_WORKER_ID" in process.env;
  if (!dbPath && !process.env.ROY_AGENT_LARK_CARD_DB && isTestEnv) {
    return new MemoryLarkCardStateStore();
  }

  const path = dbPath ?? process.env.ROY_AGENT_LARK_CARD_DB ?? getDefaultLarkCardDbPath();
  try {
    return new SqliteLarkCardStateStore(path);
  } catch (err) {
    logger.warn(
      `LarkCardStateStore: sqlite unavailable at ${path} (${(err as Error).message}) ` +
        `→ falling back to in-memory (卡片仍可发，但重启后无法 patch 旧卡)`
    );
    return new MemoryLarkCardStateStore();
  }
}

// ============================================================================
// ★ Task #5364 返工：进程级共享持久层单例
// ============================================================================

/**
 * 为什么需要单例：卡片 action handler 要按 taskId 反查 `session_id`，
 * 而它拿不到 hook 私有实例。每个调用点各 `createLarkCardStateStore()` 会
 * 打开 N 个 SQLite 连接（WAL 下可用但浪费，且测试里会出现连接泄漏）。
 *
 * 与 `createLarkCardStateStore()` 同一套降级语义（打不开 → 内存）。
 */
let sharedStateStore: LarkCardStateStore | undefined;

/** 取进程级共享持久层（首次调用时创建）。 */
export function getSharedLarkCardStateStore(): LarkCardStateStore {
  if (!sharedStateStore) sharedStateStore = createLarkCardStateStore();
  return sharedStateStore;
}

/** 测试钩子：丢弃单例（避免用例间串味 / 连到真实库）。 */
export function __resetSharedLarkCardStateStoreForTest(): void {
  try {
    sharedStateStore?.close?.();
  } catch {
    /* 关闭失败不影响测试 */
  }
  sharedStateStore = undefined;
}

/**
 * 测试钩子：注入指定 store 为共享单例（Task #5608）。
 *
 * 守卫的持久层兜底读 `getSharedLarkCardStateStore()`，
 * 测试需要一个可控的库而不连真实 `~/.local/share/roy-bot/`。
 * 传 `undefined` 等价 reset。
 */
export function __setSharedLarkCardStateStoreForTest(
  store: LarkCardStateStore | undefined,
): void {
  __resetSharedLarkCardStateStoreForTest();
  sharedStateStore = store;
}

// ============================================================================
// ★ Task #5364 返工（CV R3 M3）：**session 卡**持久层（独立表）
// ============================================================================

/**
 * 为什么需要独立表（不能塞进 `lark_card`）
 *
 * `lark_card.task_id INTEGER PRIMARY KEY` 装不下 `session_xxx` 字符串；
 * 而本轮的核心语义是「**一个 session 一张卡**」—— 无 task 的 session 也必须
 * 能重启后找回自己的卡，否则每次都多发一张（用户硬要求被静默破坏）。
 *
 * 表：`lark_session_card`，主键 `session_id`。零迁移风险（新表 IF NOT EXISTS）。
 */
export interface LarkSessionCardRecord {
  sessionId: string;
  messageId: string;
  chatId: string;
  profile?: string;
  createdAt: number;
  updatedAt: number;
}

/** session 卡持久化端口 */
export interface LarkSessionCardStore {
  upsert(rec: LarkSessionCardRecord): void;
  get(sessionId: string): LarkSessionCardRecord | undefined;
  list(): LarkSessionCardRecord[];
  delete(sessionId: string): void;
  close(): void;
}

/** 内存实现（测试 / SQLite 不可用时降级） */
export class MemoryLarkSessionCardStore implements LarkSessionCardStore {
  private readonly records = new Map<string, LarkSessionCardRecord>();
  upsert(rec: LarkSessionCardRecord): void {
    this.records.set(rec.sessionId, { ...rec });
  }
  get(sessionId: string): LarkSessionCardRecord | undefined {
    const r = this.records.get(sessionId);
    return r ? { ...r } : undefined;
  }
  list(): LarkSessionCardRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }
  delete(sessionId: string): void {
    this.records.delete(sessionId);
  }
  close(): void {
    this.records.clear();
  }
}

/** SQLite 实现 */
export class SqliteLarkSessionCardStore implements LarkSessionCardStore {
  private readonly db: any;

  constructor(dbPath: string) {
    this.db = createCompatibleDatabase(dbPath);
    try {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA busy_timeout = 5000");
    } catch {
      /* PRAGMA 不可用不影响功能 */
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS lark_session_card (
        session_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        chat_id    TEXT NOT NULL,
        profile    TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  upsert(rec: LarkSessionCardRecord): void {
    this.db
      .prepare(
        `INSERT INTO lark_session_card
           (session_id, message_id, chat_id, profile, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           message_id = excluded.message_id,
           chat_id    = excluded.chat_id,
           profile    = COALESCE(excluded.profile, lark_session_card.profile),
           updated_at = excluded.updated_at`,
      )
      .run(
        rec.sessionId,
        rec.messageId,
        rec.chatId,
        rec.profile ?? null,
        rec.createdAt,
        rec.updatedAt,
      );
  }

  get(sessionId: string): LarkSessionCardRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM lark_session_card WHERE session_id = ?")
      .get(sessionId) as
      | {
          session_id: string;
          message_id: string;
          chat_id: string;
          profile: string | null;
          created_at: number;
          updated_at: number;
        }
      | null;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      messageId: row.message_id,
      chatId: row.chat_id,
      ...(row.profile ? { profile: row.profile } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): LarkSessionCardRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM lark_session_card ORDER BY updated_at DESC")
      .all() as Array<{
      session_id: string;
      message_id: string;
      chat_id: string;
      profile: string | null;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      messageId: row.message_id,
      chatId: row.chat_id,
      ...(row.profile ? { profile: row.profile } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  delete(sessionId: string): void {
    this.db
      .prepare("DELETE FROM lark_session_card WHERE session_id = ?")
      .run(sessionId);
  }

  close(): void {
    try {
      this.db.close?.();
    } catch {
      /* ignore */
    }
  }
}

/** 创建 session 卡持久层（与 task 卡同一套降级语义） */
export function createLarkSessionCardStore(
  dbPath?: string,
): LarkSessionCardStore {
  const isTestEnv =
    process.env.NODE_ENV === "test" || "BUN_TEST_WORKER_ID" in process.env;
  if (!dbPath && isTestEnv) return new MemoryLarkSessionCardStore();

  const path = dbPath ?? getDefaultLarkCardDbPath();
  try {
    return new SqliteLarkSessionCardStore(path);
  } catch (err) {
    logger.warn(
      `LarkSessionCardStore: sqlite unavailable at ${path} (${(err as Error).message}) ` +
        `→ falling back to in-memory (卡片仍可发，但重启后无法认领旧卡)`,
    );
    return new MemoryLarkSessionCardStore();
  }
}

/** 进程级共享 session 卡持久层 */
let sharedSessionCardStore: LarkSessionCardStore | undefined;

export function getSharedLarkSessionCardStore(): LarkSessionCardStore {
  if (!sharedSessionCardStore) {
    sharedSessionCardStore = createLarkSessionCardStore();
  }
  return sharedSessionCardStore;
}

export function __resetSharedLarkSessionCardStoreForTest(): void {
  try {
    sharedSessionCardStore?.close?.();
  } catch {
    /* ignore */
  }
  sharedSessionCardStore = undefined;
}
