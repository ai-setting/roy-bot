/**
 * @fileoverview SQLite Session Store
 * 
 * SQLite-based implementation of SessionStore with checkpoint support.
 * 
 * 根据运行环境自动选择 SQLite 实现：
 * - Bun 运行时：使用 bun:sqlite
 * - Node.js/Electron：使用 better-sqlite3
 */

import { join } from "path";
import { randomUUID } from "crypto";
// 【Task #2748 §5.5】parts JSON canonicalize → 跨 SQLite 读写 byte-stable
import { canonicalizeParts } from "../../llm/llm-cache";
import type {
  Session,
  CreateSessionOptions,
  UpdateSessionOptions,
  ListSessionsOptions,
  SessionMessage,
  SessionCheckpoint,
  GetMessagesOptions,
  SessionCheckpointsMeta,
  SessionMetadata,
  SearchMessagesOptions,
  MessageMatch,
} from "../types";
import type { SessionStore } from "../session-store";
import { BaseSessionStore } from "../session-store";

import { SessionMessageConverter } from "../session-message-converter";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("session:storage:sqlite");

// ============================================================================
// SQLite Runtime Detection
// ============================================================================

/**
 * 获取 SQLite 数据库类
 *
 * 根据运行时环境选择正确的实现：
 * - Bun 运行时：使用 bun:sqlite（命名导出）
 * - Node.js 22.5+：使用 node:sqlite（内置，无需原生编译）
 * - 旧版 Node.js/Electron：使用 better-sqlite3（默认导出，需要原生编译）
 *
 * ⚠️ Task #5592 CV 返工：`node:sqlite` 优先于 `better-sqlite3`。
 * 此前只有 bun:sqlite / better-sqlite3 两分支（#4619 只改了
 * task/storage/sqlite-task-store.ts，session 侧漏掉）—— better-sqlite3
 * 移入 optionalDependencies 后，全新 Node 环境（无编译产物）走到这里
 * 直接 "Could not locate the bindings file"。
 *
 * `node:sqlite`（Node 22.5+，Node 24 stable）是 node 内置的，
 * `prepare(sql).all() / .get() / .run()` 与 better-sqlite3 同形，
 * createCompatibleDatabase 的 shim 无需改动即可工作。
 */
function getDatabaseClass(): new (path: string) => any {
  // @ts-ignore - Bun global
  if (typeof Bun !== 'undefined') {
    // Bun 运行时使用 bun:sqlite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return Database;
  }

  // Task #5592: 纯 node 优先用内置的 node:sqlite（无原生依赖）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    if (typeof DatabaseSync === "function") {
      return DatabaseSync;
    }
  } catch {
    // node < 22.5 没有 node:sqlite —— 落到 better-sqlite3。
  }

  // 旧版 Node.js/Electron 使用 better-sqlite3
  return require("better-sqlite3");
}

/**
 * 创建兼容的 Database 实例
 * 
 * bun:sqlite 和 better-sqlite3 的 API 略有不同：
 * - bun:sqlite 有 db.run() 方法
 * - better-sqlite3 没有 db.run()，需要用 db.exec() 或 db.prepare().run()
 * 
 * 此函数确保两种实现都有 run() 方法
 */
/**
 * Local copy of the SQLITE_BUSY detection logic. The shared helper in
 * `session-component.ts` cannot be imported here without creating a
 * circular dependency (this module is imported by `session-component.ts`).
 *
 * Mirrors `isBusyError` in session-component.ts: prefer structured
 * error.code, fall back to a bun:sqlite message regex that requires
 * the canonical "SQLiteError: " prefix so user-facing errors cannot
 * accidentally trigger retry.
 */
function isSqliteBusyError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { code?: string; errno?: number; message?: string };
  if (typeof e.code === "string" && /^SQLITE_(BUSY|LOCKED)$/i.test(e.code)) return true;
  if (typeof e.errno === "number" && (e.errno === 5 || e.errno === 6)) return true;
  const msg = e.message ?? "";
  return /SQLiteError:\s+(database is locked|database table is locked)/i.test(msg);
}

function createCompatibleDatabase(path: string): any {
  const Database = getDatabaseClass();
  const db = new Database(path);
  
  // 如果 better-sqlite3，添加 run() 兼容方法
  if (typeof db.run !== 'function') {
    db.run = function(sql: string, ...params: any[]) {
      if (params.length > 0) {
        return this.prepare(sql).run(...params);
      } else {
        return this.exec(sql);
      }
    };
  }
  
  return db;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a unique session ID using crypto UUID
 */
function generateSessionId(): string {
  return `session_${randomUUID()}`;
}

/**
 * Generate a unique message ID using crypto UUID
 */
function generateMessageId(): string {
  return `msg_${randomUUID()}`;
}

/**
 * Get default data directory for session storage
 */
function getDefaultDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".local", "share");
}

/**
 * Get default database path for session storage
 */
function getDefaultSessionDbPath(): string {
  return join(getDefaultDataDir(), "roy-bot", "sessions.db");
}

// ============================================================================
// SQLiteSessionStore
// ============================================================================

/**
 * SQLite-based Session Store with checkpoint support
 * 
 * Provides persistent storage for sessions and messages using SQLite.
 * Follows the same interface as MemorySessionStore but persists to disk.
 */
export class SQLiteSessionStore extends BaseSessionStore {
  private db: any = null;
  private dbPath: string;
  private initialized = false;

  // In-memory cache for performance
  private sessionsCache = new Map<string, Session>();
  private messagesCache = new Map<string, SessionMessage[]>();
  private checkpointsCache = new Map<string, SessionCheckpoint[]>();
  private messageConverter = new SessionMessageConverter();

  constructor(dbPath?: string) {
    super();
    this.dbPath = dbPath || getDefaultSessionDbPath();
  }

  // ========================================================================
  // Initialization
  // ========================================================================

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // 使用运行时检测获取兼容的 SQLite 实现
    // 确保 bun:sqlite 和 better-sqlite3 都有 run() 方法

    // 确保目录存在
    if (this.dbPath !== ":memory:") {
      const fs = require("fs");
      const path = require("path");
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = createCompatibleDatabase(this.dbPath);

    // ============================================================
    // PRAGMAs — survive concurrent writers (Layer 1 of sessions.db fix)
    //
    // Root cause of session_19c1122f message-loss bug: with default
    // `journal_mode=delete` and `busy_timeout=0`, any concurrent writer
    // (other process or same-process async race) immediately throws
    // SQLITE_BUSY. Combined with no retry at the caller, every contended
    // write silently returned `undefined` and produced orphan messages.
    //
    // - journal_mode=WAL: readers and writers don't block each other.
    //   WAL also tolerates same-process concurrent transactions because
    //   SQLite serializes them internally with a busy-writer mutex
    //   gated by busy_timeout.
    // - busy_timeout=5000: wait up to 5 seconds for the lock before
    //   throwing SQLITE_BUSY. The 8-minute incident window had lock
    //   durations well under 5s — this single change absorbs it.
    // - synchronous=NORMAL: pairs with WAL for crash-safe + faster
    //   than FULL (which fsyncs every commit).
    //
    // bun:sqlite does NOT expose `db.pragma()`, so we use `db.run("PRAGMA …")`
    // (works for both bun:sqlite and better-sqlite3 via the
    // `createCompatibleDatabase()` shim's injected `run()` method).
    // Matches the existing pattern in `log-trace/span-storage.ts:129-133`.
    //
    // Code Review note: PRAGMA journal_mode is not sticky on every backing
    // store — on read-only mounts, network filesystems, or :memory: the
    // engine may reject WAL. We re-read each PRAGMA after setting so the
    // failure mode (silent fallback to delete) is observable in logs.
    // ============================================================
    this.applyPragma("PRAGMA journal_mode = WAL");
    this.applyPragma("PRAGMA busy_timeout = 5000");
    this.applyPragma("PRAGMA synchronous = NORMAL");
    // Auto-checkpoint every 1000 pages (~4MB on default page size).
    // Without this the WAL file can grow unbounded under heavy load.
    // 1000 is SQLite's default; setting it explicitly so the choice is
    // visible (and future-tunable in one place).
    this.applyPragma("PRAGMA wal_autocheckpoint = 1000");

    // 创建表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        directory TEXT NOT NULL,
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0,
        metadata TEXT,
        -- Task #5403: alias/linkedTo 能力已废弃。列保留只为兼容已有库，
        -- 新代码不读不写（见 types.ts Session.linkedTo 注释）。
        linked_to TEXT
      )
    `);

    // Task #5403: alias 废弃 ⇒ 不再需要 ensureLinkedToColumn / idx_session_linked_to。
    // 列仍保留在 CREATE TABLE 里（旧库已有该列），新库建表也带上以保持结构一致。

    this.db.run(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        parts TEXT,
        is_archived INTEGER DEFAULT 0,
        archived_at INTEGER,
        checkpoint_id TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_message_checkpoint ON message(checkpoint_id)");

    this.initialized = true;
  }

  // ========================================================================
  // Session CRUD
  // ========================================================================

  async create(options: CreateSessionOptions): Promise<Session> {
    await this.initialize();

    const now = Date.now();
    // Resolve parentSessionId from new canonical field, falling back to
    // legacy parentID alias. Both end up as the same value on the Session
    // and are persisted via the single parent_id column.
    // Issue #6: normalize empty/whitespace strings to null.
    const rawParent =
      options.parentSessionId !== undefined
        ? options.parentSessionId
        : options.parentID ?? null;
    const parentSessionId =
      typeof rawParent === "string" && rawParent.trim().length > 0
        ? rawParent
        : null;
    const session: Session = {
      id: options.id ?? generateSessionId(),  // Use custom ID if provided
      title: options.title ?? "Session",
      directory: options.directory ?? "/tmp",
      // Keep parentID alias in sync for backward compatibility
      parentID: parentSessionId ?? undefined,
      parentSessionId,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      metadata: {
        ...options.metadata,
        messageCount: 0,
        checkpoints: { checkpoints: [] },
      } as SessionMetadata,
    };

    // Check for duplicate ID (in case)
    const existing = this.db.prepare("SELECT id FROM session WHERE id = ?").get(session.id);
    if (existing) {
      throw new Error(`Session with ID '${session.id}' already exists`);
    }

    // Insert into database
    const stmt = this.db.prepare(`
      INSERT INTO session (id, title, directory, parent_id, created_at, updated_at, message_count, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.title,
      session.directory,
      session.parentID || null,
      session.createdAt,
      session.updatedAt,
      session.messageCount,
      JSON.stringify(session.metadata)
    );

    // Update cache
    this.sessionsCache.set(session.id, session);
    this.messagesCache.set(session.id, []);
    this.checkpointsCache.set(session.id, []);

    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    await this.initialize();

    // Check cache first
    const cached = this.sessionsCache.get(id);
    if (cached) return cached;

    // Query from database
    const row = this.db.prepare("SELECT * FROM session WHERE id = ?").get(id);
    if (!row) return undefined;

    const session = this.rowToSession(row);
    this.sessionsCache.set(session.id, session);
    return session;
  }

  async list(options?: ListSessionsOptions): Promise<Session[]> {
    await this.initialize();

    let sql = "SELECT * FROM session";
    const params: any[] = [];
    const conditions: string[] = [];

    // Filter by metadata
    //
    // ★ Task #5390（P0，用户 14:12 明令批准一并修复）：**不能**对参数做
    //   `JSON.stringify(value)`。
    //
    //   原实现：
    //     conditions.push(`json_extract(metadata, '$.${key}') = ?`);
    //     params.push(JSON.stringify(value));   // ← 字符串被二次 stringify
    //
    //   `json_extract` 返回的是**原始类型**（`oc_xxx` 字符串 / `42` 数字 /
    //   `1` 布尔），而 `JSON.stringify` 会把它们变成带引号/带类型的 JSON 文本：
    //     - string `"oc_xxx"` → 参数 `"\"oc_xxx\""` ⇒ 永不匹配
    //     - number `42`       → 参数 `"42"` ⇒ SQLite 里 `42 = '42'` 为 false
    //   于是 `filter.metadata.chatId` **恒返回空**。
    //
    //   MemorySessionStore 同款过滤用的是 `s.metadata?.[key] !== value`
    //   （原始类型比较），所以**只有 SQLite 后端坏** —— 两个后端行为不一致，
    //   这也是该缺陷能长期潜伏的原因。
    //
    //   生产影响：`event-handler.ts:2375` 的 `ensureChatSession` 用
    //   `list({filter:{metadata:{chatId,type:"lark-chat"}}})` 判「群会话是否已
    //   存在」→ 恒空 → `create({id: chatId})` 撞主键 → catch → `get()` 兜底。
    //   结果仍正确，但**每个群事件抛一次异常**（噪音 + 多余 insert 尝试）。
    //
    //   修法：
    //   - **原始类型**（string / number / boolean）：直接绑原始值，SQLite 原生
    //     比较即正确；布尔归一化 1/0 与 JSON1 的存储表示对齐。
    //   - **复合类型**（object / array）：走 `json()` 规范化两侧再比 ——
    //       `json(json_extract(metadata,'$.k')) = json(?)`
    //     直接绑数组会让驱动把它当多参数展开而抛
    //     `expected 1 values, received N`，属于必须避开的硬失败。
    //
    //   ⚠️ 已知限制：SQLite 的 `json()` **不会对 key 排序**
    //     （实测 `json('{"b":2,"a":1}')` → `{"b":2,"a":1}`），所以 key 顺序
    //     不同的等价对象仍不命中。做到顺序无关需 json_tree 逐 key 比较，
    //     成本远高于收益 —— 全仓唯一生产调用是 `{chatId, type}`（纯字符串）。
    if (options?.filter?.metadata) {
      for (const [key, value] of Object.entries(options.filter.metadata)) {
        const isScalar =
          value === null ||
          value === undefined ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean";
        if (isScalar && value !== undefined) {
          conditions.push(`json_extract(metadata, '$.${key}') = ?`);
          // 布尔在 JSON1 里存为 1/0，直接绑 JS boolean 部分驱动会绑成字符串，
          // 显式归一化保证三个平台（number/string/boolean）都一致。
          params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
        } else {
          // 复合类型（object / array）—— 两侧同过 json() 规范化后按文本比较
          conditions.push(`json(json_extract(metadata, '$.${key}')) = json(?)`);
          params.push(value === undefined ? null : JSON.stringify(value));
        }
      }
    }

    // Filter by time range
    if (options?.filter?.startTime) {
      conditions.push("created_at >= ?");
      params.push(options.filter.startTime);
    }
    if (options?.filter?.endTime) {
      conditions.push("created_at <= ?");
      params.push(options.filter.endTime);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    // Sort
    const sortField = options?.sort?.field ?? "updatedAt";
    const sortOrder = options?.sort?.order ?? "desc";
    const orderColumn = sortField === "title" ? "title" 
      : sortField === "createdAt" ? "created_at" 
      : "updated_at";
    sql += ` ORDER BY ${orderColumn} ${sortOrder.toUpperCase()}`;

    // Paginate
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;
    sql += " LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row: any) => this.rowToSession(row));
  }

  async getCount(): Promise<number> {
    await this.initialize();
    const result = this.db.prepare("SELECT COUNT(*) as count FROM session").get() as {
      count: number;
    };
    return result.count;
  }

  async update(id: string, updates: UpdateSessionOptions): Promise<boolean> {
    await this.initialize();

    const session = await this.get(id);
    if (!session) return false;

    // Update fields
    if (updates.title !== undefined) {
      session.title = updates.title;
    }
    if (updates.metadata !== undefined) {
      session.metadata = { ...session.metadata, ...updates.metadata } as SessionMetadata;
    }
    session.updatedAt = Date.now();

    // Update database
    const stmt = this.db.prepare(`
      UPDATE session 
      SET title = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      session.title,
      JSON.stringify(session.metadata),
      session.updatedAt,
      id
    );

    // Update cache
    this.sessionsCache.set(id, session);
    return true;
  }

  async delete(id: string): Promise<boolean> {
    await this.initialize();

    const session = await this.get(id);
    if (!session) return false;

    // Delete from database (messages will cascade)
    this.db.prepare("DELETE FROM session WHERE id = ?").run(id);

    // Clean up cache
    this.sessionsCache.delete(id);
    this.messagesCache.delete(id);
    this.checkpointsCache.delete(id);

    return true;
  }

  // ========================================================================
  // Messages
  // ========================================================================

  async addMessage(
    sessionId: string,
    message: { role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }
  ): Promise<string> {
    await this.initialize();

    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const now = Date.now();
    const msg: SessionMessage = {
      id: generateMessageId(),
      sessionID: sessionId,
      role: message.role as SessionMessage["role"],
      content: message.content,
      timestamp: now,
      parts: message.parts as SessionMessage["parts"],
      metadata: message.metadata as SessionMessage["metadata"],
    };

    // Insert into database
    const stmt = this.db.prepare(`
      INSERT INTO message (id, session_id, role, content, timestamp, parts, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id,
      msg.sessionID,
      msg.role,
      msg.content,
      msg.timestamp,
      // 【Task #2748 §5.5】parts key 排序 + 递归处理 tool-call args → cache-stable
      msg.parts ? canonicalizeParts(msg.parts) : null,
      msg.metadata ? JSON.stringify(msg.metadata) : null
    );

    // Update message count
    const countResult = this.db.prepare(
      "SELECT COUNT(*) as count FROM message WHERE session_id = ? AND is_archived = 0"
    ).get(sessionId);
    session.messageCount = countResult?.count || 0;
    session.updatedAt = now;
    
    // Update metadata with messageCount
    session.metadata = {
      ...session.metadata,
      messageCount: session.messageCount
    } as SessionMetadata;
    
    this.db.prepare(`
      UPDATE session SET message_count = ?, metadata = ?, updated_at = ? WHERE id = ?
    `).run(session.messageCount, JSON.stringify(session.metadata), session.updatedAt, sessionId);

    // Update cache
    const messages = this.messagesCache.get(sessionId) ?? [];
    messages.push(msg);
    this.messagesCache.set(sessionId, messages);
    this.sessionsCache.set(sessionId, session);

    return msg.id;
  }

  /**
   * Layer 3: batch insert messages in a single transaction.
   *
   * The previous per-message path issued N×2 statements (INSERT message +
   * UPDATE session), each grabbing the write lock independently. Under
   * React-driven async fan-out, that lock amplification turned short
   * contentions into full SQLITE_BUSY storms.
   *
   * This path:
   *  1. Validates the session exists (cheap, indexed SELECT)
   *  2. Opens a single transaction (BEGIN)
   *  3. Inserts all N rows in one batch (parameterized prepared stmt)
   *  4. Recomputes messageCount ONCE via COUNT(*) and issues ONE session
   *     UPDATE
   *  5. Commits (or ROLLBACK on any error — preserves atomicity)
   *
   * Errors (FK violation, etc.) propagate to the caller; the txn is
   * rolled back so the DB stays consistent. Empty input is a no-op.
   */
  async addMessages(
    sessionId: string,
    messages: Array<{ role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }>
  ): Promise<string[]> {
    if (messages.length === 0) {
      return [];
    }

    // Layer 2 retry at the batch level. SQLiteSessionStore.addMessages
    // is the hot path for `recordSessionMessages`; if the txn throws
    // SQLITE_BUSY the entire React-iteration's worth of messages would
    // be silently dropped (Code Review Important #1). Wrap the whole
    // thing in a small retry loop with the same backoff schedule as
    // the per-message path.
    //
    // We do NOT retry on arbitrary errors — schema / FK violations
    // won't be fixed by waiting, and retrying them would mask real
    // bugs from the caller.
    const BATCH_BACKOFFS_MS = [50, 100, 200] as const;
    let lastError: unknown = undefined;
    for (let attempt = 0; attempt <= BATCH_BACKOFFS_MS.length; attempt++) {
      try {
        return await this.addMessagesOnce(sessionId, messages);
      } catch (err) {
        if (!isSqliteBusyError(err) || attempt === BATCH_BACKOFFS_MS.length) {
          // Defensive cache invalidation on any failure: if the txn
          // partially committed before the rollback (shouldn't happen,
          // but defense in depth), drop the cached state so the next
          // read goes back to the DB.
          this.messagesCache.delete(sessionId);
          this.sessionsCache.delete(sessionId);
          lastError = err;
          if (!isSqliteBusyError(err)) throw err;
          break;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, BATCH_BACKOFFS_MS[attempt])
        );
      }
    }
    throw lastError;
  }

  /**
   * Single-attempt body of `addMessages`, extracted so the retry loop
   * can call it without a recursion hazard.
   */
  private async addMessagesOnce(
    sessionId: string,
    messages: Array<{ role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }>
  ): Promise<string[]> {
    await this.initialize();

    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const now = Date.now();
    const ids: string[] = [];

    const insertStmt = this.db.prepare(`
      INSERT INTO message (id, session_id, role, content, timestamp, parts, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const sessionUpdateStmt = this.db.prepare(`
      UPDATE session SET message_count = ?, metadata = ?, updated_at = ? WHERE id = ?
    `);

    this.db.run("BEGIN");
    try {
      for (const message of messages) {
        const id = generateMessageId();
        ids.push(id);
        insertStmt.run(
          id,
          sessionId,
          message.role,
          message.content,
          now,
          // 【Task #2748 §5.5】parts canonicalize
          message.parts ? canonicalizeParts(message.parts) : null,
          message.metadata ? JSON.stringify(message.metadata) : null
        );
      }

      const countResult = this.db.prepare(
        "SELECT COUNT(*) as count FROM message WHERE session_id = ? AND is_archived = 0"
      ).get(sessionId);
      const newCount = (countResult as { count: number } | undefined)?.count ?? 0;

      session.messageCount = newCount;
      session.updatedAt = now;
      session.metadata = {
        ...(session.metadata ?? {}),
        messageCount: newCount,
      } as SessionMetadata;

      sessionUpdateStmt.run(
        newCount,
        JSON.stringify(session.metadata),
        now,
        sessionId
      );

      this.db.run("COMMIT");
    } catch (err) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        // best-effort — original error is more interesting
      }
      throw err;
    }

    // Cache update: post-commit, so a thrown cache write cannot leave
    // the cache richer than the DB. If the cache write throws, drop
    // the cached entries so the next read rehydrates from disk.
    try {
      const cached = this.messagesCache.get(sessionId) ?? [];
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        cached.push({
          id: ids[i],
          sessionID: sessionId,
          role: message.role as SessionMessage["role"],
          content: message.content,
          timestamp: now,
          parts: message.parts as SessionMessage["parts"],
          metadata: message.metadata as SessionMessage["metadata"],
        });
      }
      this.messagesCache.set(sessionId, cached);
      this.sessionsCache.set(sessionId, session);
    } catch (cacheErr) {
      logger.warn(`[SQLiteSessionStore] cache update failed after commit; invalidating: ${cacheErr}`);
      this.messagesCache.delete(sessionId);
      this.sessionsCache.delete(sessionId);
    }

    return ids;
  }

  async updateMessage(
    sessionId: string,
    messageId: string,
    updates: { metadata?: Record<string, unknown>; parts?: unknown[]; content?: string }
  ): Promise<boolean> {
    await this.initialize();

    const row = this.db.prepare(
      'SELECT id FROM message WHERE id = ? AND session_id = ?'
    ).get(messageId, sessionId) as { id: string } | undefined;

    if (!row) {
      return false;
    }

    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) {
      sets.push('content = ?');
      values.push(updates.content);
    }
    if (updates.parts !== undefined) {
      sets.push('parts = ?');
      // 【Task #2748 §5.5】parts canonicalize
      values.push(canonicalizeParts(updates.parts));
    }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata));
    }

    if (sets.length === 0) {
      return true;
    }

    values.push(messageId, sessionId);
    this.db.prepare(
      `UPDATE message SET ${sets.join(', ')} WHERE id = ? AND session_id = ?`
    ).run(...values);

    const messages = this.messagesCache.get(sessionId) ?? [];
    const index = messages.findIndex((m) => m.id === messageId);
    if (index >= 0) {
      messages[index] = {
        ...messages[index],
        ...(updates.content !== undefined ? { content: updates.content } : {}),
        ...(updates.metadata !== undefined
          ? { metadata: updates.metadata as SessionMessage['metadata'] }
          : {}),
        ...(updates.parts !== undefined
          ? { parts: updates.parts as SessionMessage['parts'] }
          : {}),
      };
      this.messagesCache.set(sessionId, messages);
    }

    return true;
  }

  async getMessages(
    sessionId: string,
    offset = 0,
    limit = 50,
    options?: GetMessagesOptions
  ): Promise<SessionMessage[]> {
    await this.initialize();

    let sql = "SELECT * FROM message WHERE session_id = ?";
    let countSql = "SELECT COUNT(*) as count FROM message WHERE session_id = ?";
    const params: any[] = [sessionId];
    const countParams: any[] = [sessionId];

    // Filter by archived status
    if (!options?.includeArchived) {
      sql += " AND is_archived = 0";
      countSql += " AND is_archived = 0";
    }

    // Handle fromCheckpointId
    if (options?.fromCheckpointId) {
      sql += " AND timestamp >= (SELECT MIN(timestamp) FROM message WHERE session_id = ? AND json_extract(metadata, '$.checkpointId') = ?)";
      params.push(sessionId, options.fromCheckpointId);
    }

    // Handle negative offset: count total messages first, then calculate actual offset
    // offset = -1, limit = 50: latest 50 messages → offset = total - limit
    // offset = -2, limit = 50: 2nd latest 50 messages → offset = total - 2*limit
    let actualOffset = offset;
    if (offset < 0) {
      const totalResult = this.db.prepare(countSql).get(...countParams);
      const total = totalResult?.count || 0;
      actualOffset = Math.max(0, total + offset * limit);
    }

    // Sort
    if (options?.reverse) {
      sql += " ORDER BY timestamp DESC";
    } else {
      sql += " ORDER BY timestamp ASC";
    }

    // Paginate
    sql += " LIMIT ? OFFSET ?";
    params.push(limit, actualOffset);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row: any) => this.rowToMessage(row));
  }

  /**
   * Run a PRAGMA and log if the engine reports a different value than
   * requested. Read-only PRAGMAs (`journal_mode`, `busy_timeout`,
   * `synchronous`, `wal_autocheckpoint`) all return the *current* value
   * as the first row, so a single `prepare().get()` is enough.
   */
  private applyPragma(pragmaSql: string): void {
    this.db.run(pragmaSql);
    // `prepare().get()` works on both bun:sqlite and better-sqlite3.
    const readback = this.db.prepare(pragmaSql.split("=")[0].trim()).get() as Record<string, unknown> | undefined;
    const key = Object.keys(readback ?? {})[0];
    const actual = key ? readback![key] : undefined;
    logger.info(`[SQLiteSessionStore] Applied ${pragmaSql} → ${actual}`);
  }

  async getMessageCount(sessionId: string, includeArchived = false): Promise<number> {
    await this.initialize();

    let sql = "SELECT COUNT(*) as count FROM message WHERE session_id = ?";
    if (!includeArchived) {
      sql += " AND is_archived = 0";
    }
    
    const result = this.db.prepare(sql).get(sessionId);
    return result?.count || 0;
  }

  async getMessageIndexes(sessionId: string, role: string): Promise<number[]> {
    await this.initialize();

    // Use ROW_NUMBER() to get the offset index based on timestamp ASC order
    // This ensures the index matches what getMessages returns with default ordering
    const sql = `
      SELECT idx FROM (
        SELECT 
          ROW_NUMBER() OVER (ORDER BY timestamp ASC) - 1 as idx,
          role
        FROM message 
        WHERE session_id = ? AND is_archived = 0
      ) ranked
      WHERE role = ?
    `;
    
    const rows = this.db.prepare(sql).all(sessionId, role) as { idx: number }[];
    return rows.map(row => row.idx);
  }

  // ========================================================================
  // Checkpoint Management
  // ========================================================================

  async saveCheckpoint(sessionId: string, checkpoint: SessionCheckpoint): Promise<void> {
    await this.initialize();

    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Save to checkpoints cache
    const cps = this.checkpointsCache.get(sessionId) ?? [];
    cps.push(checkpoint);
    this.checkpointsCache.set(sessionId, cps);

    // Update session metadata
    const meta = session.metadata as Record<string, unknown> || {};
    const checkpointsMeta: SessionCheckpointsMeta = (meta.checkpoints as SessionCheckpointsMeta) || { checkpoints: [] };
    checkpointsMeta.checkpoints.push({
      id: checkpoint.id,
      messageIndex: checkpoint.messageIndex,
      title: checkpoint.title,
      createdAt: checkpoint.createdAt,
      type: checkpoint.type,
    });
    checkpointsMeta.latestCheckpointId = checkpoint.id;
    
    meta.checkpoints = checkpointsMeta;
    
    // Store checkpoint details separately
    if (!meta.checkpointDetails) {
      meta.checkpointDetails = {};
    }
    (meta.checkpointDetails as Record<string, SessionCheckpoint>)[checkpoint.id] = checkpoint;
    
    session.metadata = meta as SessionMetadata;
    session.updatedAt = Date.now();

    // Update database
    const stmt = this.db.prepare(`
      UPDATE session SET metadata = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(JSON.stringify(session.metadata), session.updatedAt, sessionId);

    // Update cache
    this.sessionsCache.set(sessionId, session);
  }

  async getCheckpoints(sessionId: string): Promise<SessionCheckpoint[]> {
    await this.initialize();

    const session = await this.get(sessionId);
    if (!session) return [];

    const meta = session.metadata as Record<string, unknown>;
    const checkpointDetails = meta?.checkpointDetails as Record<string, SessionCheckpoint>;
    if (!checkpointDetails) return [];

    return Object.values(checkpointDetails);
  }

  /**
   * 按 id 覆盖写回一组 checkpoint 明细（Task #4933 存量格式迁移用）。
   *
   * 只改 `metadata.checkpointDetails`，不动 `metadata.checkpoints` 索引
   * （id / title / messageIndex / createdAt 都是不变的元数据）。
   * 返回是否有任何变更被写入。
   */
  async replaceCheckpointDetails(
    sessionId: string,
    checkpoints: SessionCheckpoint[]
  ): Promise<boolean> {
    await this.initialize();

    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const meta = (session.metadata as Record<string, unknown>) || {};
    const details =
      (meta.checkpointDetails as Record<string, SessionCheckpoint>) || {};

    for (const cp of checkpoints) {
      details[cp.id] = cp;
    }
    meta.checkpointDetails = details;

    session.metadata = meta as SessionMetadata;
    session.updatedAt = Date.now();

    this.db
      .prepare("UPDATE session SET metadata = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(session.metadata), session.updatedAt, sessionId);

    // checkpoint 明细变了，缓存里的 checkpointsCache 一并刷新（保持一致性）
    this.checkpointsCache.set(sessionId, Object.values(details));
    this.sessionsCache.set(sessionId, session);

    logger.info(
      `[SQLiteSessionStore] replaceCheckpointDetails: wrote ${checkpoints.length} checkpoint(s) for ${sessionId}`
    );
    return true;
  }

  async getCheckpoint(sessionId: string, checkpointId: string): Promise<SessionCheckpoint | undefined> {
    await this.initialize();

    const checkpoints = await this.getCheckpoints(sessionId);
    return checkpoints.find((cp) => cp.id === checkpointId);
  }

  async deleteCheckpoint(sessionId: string, checkpointId: string): Promise<boolean> {
    await this.initialize();

    const session = await this.get(sessionId);
    if (!session) return false;

    const checkpoints = this.checkpointsCache.get(sessionId) ?? [];
    const index = checkpoints.findIndex((cp) => cp.id === checkpointId);
    if (index === -1) return false;

    // Remove checkpoint
    checkpoints.splice(index, 1);
    this.checkpointsCache.set(sessionId, checkpoints);

    // Restore archived messages
    this.db.prepare(`
      UPDATE message SET is_archived = 0, archived_at = NULL, checkpoint_id = NULL
      WHERE session_id = ? AND checkpoint_id = ?
    `).run(sessionId, checkpointId);

    // Update session metadata
    const meta = session.metadata as Record<string, unknown> || {};
    const checkpointsMeta: SessionCheckpointsMeta = (meta.checkpoints as SessionCheckpointsMeta) || { checkpoints: [] };
    checkpointsMeta.checkpoints = checkpointsMeta.checkpoints.filter((cp) => cp.id !== checkpointId);
    checkpointsMeta.latestCheckpointId = checkpoints[checkpoints.length - 1]?.id;
    
    if (meta.checkpointDetails) {
      delete (meta.checkpointDetails as Record<string, SessionCheckpoint>)[checkpointId];
    }
    
    session.metadata = meta as SessionMetadata;

    // Update message count
    const countResult = this.db.prepare(
      "SELECT COUNT(*) as count FROM message WHERE session_id = ? AND is_archived = 0"
    ).get(sessionId);
    session.messageCount = countResult?.count || 0;
    session.updatedAt = Date.now();

    // Update database
    this.db.prepare(`
      UPDATE session SET metadata = ?, message_count = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(session.metadata), session.messageCount, session.updatedAt, sessionId);

    // Update cache
    this.sessionsCache.set(sessionId, session);

    return true;
  }

  async archiveMessages(sessionId: string, checkpointId: string, beforeIndex: number): Promise<number> {
    await this.initialize();

    const session = await this.get(sessionId);
    if (!session) return 0;

    const now = Date.now();

    // Archive messages before the index
    const result = this.db.prepare(`
      UPDATE message 
      SET is_archived = 1, archived_at = ?, checkpoint_id = ?
      WHERE session_id = ? AND id IN (
        SELECT id FROM message WHERE session_id = ? AND is_archived = 0
        ORDER BY timestamp ASC LIMIT ?
      )
    `).run(now, checkpointId, sessionId, sessionId, beforeIndex);

    // Update message count
    const countResult = this.db.prepare(
      "SELECT COUNT(*) as count FROM message WHERE session_id = ? AND is_archived = 0"
    ).get(sessionId);
    session.messageCount = countResult?.count || 0;
    session.updatedAt = now;

    // Update database
    this.db.prepare(`
      UPDATE session SET message_count = ?, updated_at = ? WHERE id = ?
    `).run(session.messageCount, session.updatedAt, sessionId);

    // Update cache
    this.sessionsCache.set(sessionId, session);
    this.messagesCache.delete(sessionId); // Clear message cache

    return result.changes;
  }

  async getActiveMessages(sessionId: string, offset = 0, limit = 50): Promise<SessionMessage[]> {
    return this.getMessages(sessionId, offset, limit, { includeArchived: false });
  }

  // ========================================================================
  // Search [new]
  // ========================================================================

  async searchMessages(options: SearchMessagesOptions): Promise<MessageMatch[]> {
    await this.initialize();
    
    const matches: MessageMatch[] = [];
    const {
      query,
      sessionId,
      limit = 10,
      beforeTime,
      afterTime,
      includeArchived = false,
    } = options;

    // Build SQL query
    let sql = "SELECT * FROM message WHERE 1=1";
    const params: any[] = [];

    // Filter by session
    if (sessionId) {
      sql += " AND session_id = ?";
      params.push(sessionId);
    }

    // Filter by archived status
    if (!includeArchived) {
      sql += " AND is_archived = 0";
    }

    // Filter by time
    if (beforeTime) {
      sql += " AND timestamp <= ?";
      params.push(beforeTime);
    }
    if (afterTime) {
      sql += " AND timestamp >= ?";
      params.push(afterTime);
    }

    // Order by timestamp
    sql += " ORDER BY timestamp DESC";

    // Limit
    sql += " LIMIT ?";
    params.push(limit * 10); // Get more than limit to filter by query

    const rows = this.db.prepare(sql).all(...params);

    // Parse query for simple text matching
    const queryTerms = this.parseQuery(query);
    const lowerQuery = query.toLowerCase();

    // Filter and match messages
    for (const row of rows) {
      const content = (row.content as string).toLowerCase();
      
      // Check if content matches query
      let matchesQuery = true;
      
      // Check excluded terms
      for (const term of queryTerms.excluded) {
        if (content.includes(term.toLowerCase())) {
          matchesQuery = false;
          break;
        }
      }

      // Check required terms
      if (matchesQuery && queryTerms.required.length > 0) {
        for (const term of queryTerms.required) {
          if (!content.includes(term.toLowerCase())) {
            matchesQuery = false;
            break;
          }
        }
      }

      // Simple fallback: check if query string appears in content
      if (!matchesQuery && lowerQuery && content.includes(lowerQuery)) {
        matchesQuery = true;
      }

      if (matchesQuery) {
        matches.push({
          messageId: row.id,
          sessionId: row.session_id,
          role: row.role as MessageMatch["role"],
          content: row.content,
          timestamp: row.timestamp,
        });

        if (matches.length >= limit) break;
      }
    }

    return matches;
  }

  /**
   * Parse simple query into terms
   */
  private parseQuery(query: string): { required: string[]; excluded: string[] } {
    // Remove quoted phrases (simplified)
    const terms = query.split(/\s+/).filter((t) => !t.startsWith('"') && !t.endsWith('"'));
    
    const required: string[] = [];
    const excluded: string[] = [];
    
    for (const term of terms) {
      if (term.startsWith("-") || term.toUpperCase().startsWith("NOT ")) {
        excluded.push(term.replace(/^-|^NOT /i, ""));
      } else {
        required.push(term);
      }
    }
    
    return { required, excluded };
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.sessionsCache.clear();
    this.messagesCache.clear();
    this.checkpointsCache.clear();
    this.initialized = false;
  }

  // ========================================================================
  // Row Conversions
  // ========================================================================

  private rowToSession(row: any): Session {
    // Issue #6: defend against empty/whitespace strings leaking into parent_id
    // (e.g. legacy writes or buggy producers). Normalize to null.
    const rawParent = row.parent_id;
    const parentId =
      typeof rawParent === "string" && rawParent.trim().length > 0
        ? rawParent
        : null;
    return {
      id: row.id,
      title: row.title,
      directory: row.directory,
      // Keep parentID alias in sync with canonical parentSessionId
      parentID: parentId ?? undefined,
      parentSessionId: parentId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private rowToMessage(row: any): SessionMessage {
    // Parse the raw message from database
    const rawMessage: Partial<SessionMessage> = {
      id: row.id,
      sessionID: row.session_id,
      role: row.role as SessionMessage["role"],
      content: row.content,
      timestamp: row.timestamp,
      parts: row.parts ? JSON.parse(row.parts) : undefined,
      isArchived: row.is_archived === 1,
      archivedAt: row.archived_at || undefined,
      checkpointId: row.checkpoint_id || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
    
    // Apply migration for backward compatibility with old format
    return this.messageConverter.migrateMessage(rawMessage);
  }
}

// Export helper functions
export { getDefaultSessionDbPath, getDefaultDataDir };
