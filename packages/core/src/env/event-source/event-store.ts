/**
 * EventStore — ESPlugin v2 Phase 1（Task #4042）
 *
 * 持久化 trigger event，让 ES plugin 能：
 *   1. emitTriggerEvent(payload) → 返回 triggerEventId 并落库
 *   2. getEventById(id) → 主 agent 处理 notify event 时反查 ES info（chatId / messageId / senderId）
 *   3. getRecentEvents(esType, senderId, limit) → 多轮对话上下文
 *
 * 设计目标：
 *   - 同步 API（better-sqlite3 / bun:sqlite 都是同步的，wrap 成 async 给上层调用方便）
 *   - 单库 / 单表 / 1 索引（开销最小）
 *   - 跑 bun:test < 10ms p95（warm）
 *
 * 向后兼容：
 *   - 不引入运行时依赖（沿用 core 现有的 sqlite 兼容层，与 span-storage 同源）
 *   - 不修改现有任何 schema
 */

import { randomUUID } from "node:crypto";
import { TracedAs } from "../log-trace/decorator";

// ============================================================================
// SQLite Runtime Detection（沿用 span-storage.ts 的兼容方案）
// ============================================================================

type DbRunResult = { changes?: number; lastInsertRowid?: number | bigint };

interface CompatibleDatabase {
  prepare(sql: string): {
    run: (...params: unknown[]) => DbRunResult;
    get: (...params: unknown[]) => any;
    all: (...params: unknown[]) => any[];
  };
  exec: (sql: string) => void;
  close: () => void;
}

function getDatabaseClass(): new (path: string) => any {
  // @ts-ignore - Bun global
  if (typeof Bun !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return Database;
  }

  // Task #5592 CV 返工：node:sqlite（Node 22.5+ 内置）优先于
  // better-sqlite3 —— better-sqlite3 已移入 optionalDependencies，
  // 全新 Node 环境无编译产物时必须走 node:sqlite（#4619 同款修法）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    if (typeof DatabaseSync === "function") {
      return DatabaseSync;
    }
  } catch {
    // node < 22.5 没有 node:sqlite —— 落到 better-sqlite3。
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("better-sqlite3");
}

function createCompatibleDatabase(path: string): CompatibleDatabase {
  const Database = getDatabaseClass();
  const db = new Database(path);
  if (typeof db.run !== "function") {
    db.run = function (sql: string, ...params: unknown[]) {
      if (params.length > 0) {
        return this.prepare(sql).run(...params);
      } else {
        return this.exec(sql);
      }
    };
  }
  return db as CompatibleDatabase;
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Trigger event 元数据（来自 ES 原始 event）。
 *
 * 故意写得比 EventMetadata 更宽：因为不同 ES（lark / bounty-im / timer / cron）
 * 元数据形状不同，store 不做形状校验，仅做 round-trip。
 */
export interface TriggerEventMetadata {
  /** 事件类型（im.message.receive_v1 / cron.tick / ...）*/
  eventType?: string;
  /** 发送方 app ID（lark 用）*/
  appId?: string;
  /** 渠道 chat ID（lark / bounty-im 用）*/
  chatId?: string;
  /** 渠道类型（p2p / group / channel）*/
  chatType?: string;
  /** 原始消息 ID（lark 用，im +messages-reply 关联回原 user query）*/
  messageId?: string;
  /** 消息类型（text / image / ...）*/
  messageType?: string;
  /** 发送方 user ID（lark open_id / bounty user_id）*/
  senderId?: string;
  /** 租户 key（多租户场景）*/
  tenantKey?: string;
  /** 其他 ES-specific 元数据 */
  [key: string]: unknown;
}

/**
 * Trigger event 输入（emitTriggerEvent 调用方传）
 */
export interface TriggerEventInput {
  /** 发送方 ID（必填，用于 getRecentEvents 查询）*/
  senderId: string;
  /** 提取出的文本内容（用于上层 LLM prompt）*/
  text?: string;
  /** 元数据（chatId / messageId / ...）*/
  metadata: TriggerEventMetadata;
  /** ES 原始 event 对象（可选，留档用）*/
  rawEvent?: unknown;
}

/**
 * 持久化后的 event（getEventById / getRecentEvents 返回）
 */
export interface PersistedEvent {
  eventId: string;
  esType: string;
  senderId: string;
  text: string | null;
  /** JSON 反序列化后的元数据 */
  metadata: TriggerEventMetadata;
  /** 原始 event 对象（JSON 反序列化）*/
  rawEvent: unknown;
  createdAt: number;
}

/**
 * EventStore 接口
 */
export interface EventStore {
  insertTriggerEvent(input: TriggerEventInput, esType: string): Promise<string>;
  getEventById(eventId: string): Promise<PersistedEvent | null>;
  getRecentEvents(esType: string, senderId: string, limit: number): Promise<PersistedEvent[]>;
}

/**
 * EventStore 配置
 */
export interface EventStoreOptions {
  /** SQLite 数据库路径（必填）*/
  dbPath: string;
}

// ============================================================================
// EventStore 实现
// ============================================================================

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_store (
  event_id   TEXT PRIMARY KEY,
  es_type    TEXT NOT NULL,
  sender_id  TEXT NOT NULL,
  text       TEXT,
  metadata   TEXT NOT NULL,
  raw_event  TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_es_sender_time
  ON event_store (es_type, sender_id, created_at DESC);
`;

/**
 * 默认 EventStore 实现（SQLite）
 */
export class EventStoreImpl implements EventStore {
  private readonly db: CompatibleDatabase;
  private readonly insertStmt: ReturnType<CompatibleDatabase["prepare"]>;
  private readonly getByIdStmt: ReturnType<CompatibleDatabase["prepare"]>;
  private readonly recentStmt: ReturnType<CompatibleDatabase["prepare"]>;

  constructor(options: EventStoreOptions) {
    this.db = createCompatibleDatabase(options.dbPath);
    // 性能 / 并发 pragma（与 span-storage.ts 同源策略）：
    //   - WAL：读不阻塞写，多个 event-source / delegate_task 并发访问友好
    //   - synchronous=NORMAL：WAL 下足够安全，避免每次 INSERT 都 fsync 导致
    //     insertTriggerEvent p95 抖动（perf 测试要求 <10ms）
    //   - busy_timeout：并发写入时等待而非直接 SQLITE_BUSY
    try {
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA synchronous=NORMAL");
      this.db.exec("PRAGMA busy_timeout=5000");
    } catch {
      // 部分 driver / 只读场景不支持 pragma，忽略（保持可用）
    }
    // bun:sqlite 不支持一次跑多语句，需要拆开
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS event_store (
         event_id   TEXT PRIMARY KEY,
         es_type    TEXT NOT NULL,
         sender_id  TEXT NOT NULL,
         text       TEXT,
         metadata   TEXT NOT NULL,
         raw_event  TEXT,
         created_at INTEGER NOT NULL
       );`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_es_sender_time
         ON event_store (es_type, sender_id, created_at DESC);`,
    );
    // prepared
    this.insertStmt = this.db.prepare(
      `INSERT INTO event_store (event_id, es_type, sender_id, text, metadata, raw_event, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByIdStmt = this.db.prepare(
      `SELECT event_id, es_type, sender_id, text, metadata, raw_event, created_at
         FROM event_store WHERE event_id = ?`,
    );
    this.recentStmt = this.db.prepare(
      `SELECT event_id, es_type, sender_id, text, metadata, raw_event, created_at
         FROM event_store
        WHERE es_type = ? AND sender_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    );
  }

  @TracedAs("event_store.insert_trigger", { recordParams: true, recordResult: true })
  async insertTriggerEvent(input: TriggerEventInput, esType: string): Promise<string> {
    const eventId = `evt_${Date.now()}_${randomUUID()}`;
    const createdAt = Date.now();
    const metadataJson = JSON.stringify(input.metadata ?? {});
    const rawEventJson = input.rawEvent === undefined ? null : safeStringify(input.rawEvent);

    this.insertStmt.run(
      eventId,
      esType,
      input.senderId,
      input.text ?? null,
      metadataJson,
      rawEventJson,
      createdAt,
    );

    return eventId;
  }

  @TracedAs("event_store.query_by_id", { recordParams: true, recordResult: false })
  async getEventById(eventId: string): Promise<PersistedEvent | null> {
    const row = this.getByIdStmt.get(eventId);
    if (!row) return null;
    return rowToPersistedEvent(row);
  }

  async getRecentEvents(
    esType: string,
    senderId: string,
    limit: number,
  ): Promise<PersistedEvent[]> {
    const rows = this.recentStmt.all(esType, senderId, limit);
    return rows.map((r) => rowToPersistedEvent(r));
  }

  /**
   * 关闭数据库（测试 / graceful shutdown 用）
   */
  close(): void {
    this.db.close();
  }
}

// ============================================================================
// 内部 helper
// ============================================================================

function rowToPersistedEvent(row: any): PersistedEvent {
  let metadata: TriggerEventMetadata;
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }

  let rawEvent: unknown;
  if (row.raw_event) {
    try {
      rawEvent = JSON.parse(row.raw_event);
    } catch {
      rawEvent = null;
    }
  } else {
    rawEvent = null;
  }

  return {
    eventId: row.event_id,
    esType: row.es_type,
    senderId: row.sender_id,
    text: row.text ?? null,
    metadata,
    rawEvent,
    createdAt: typeof row.created_at === "bigint" ? Number(row.created_at) : row.created_at,
  };
}

/**
 * 安全 JSON.stringify（避免 rawEvent 里有循环引用 / Function 炸）
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === "function") return "[Function]";
      if (value === undefined) return "[undefined]";
      if (value === null) return null;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      if (typeof value === "bigint") return value.toString();
      return value;
    });
  } catch {
    return "{}";
  }
}

// re-export SCHEMA_SQL 给将来 migrations 用
export { SCHEMA_SQL as EVENT_STORE_SCHEMA_SQL };

// ============================================================================
// 进程内 EventStore 单例（shared singleton）
// ============================================================================
//
// ESPlugin v2 生产链路里，两个位置需要访问同一个 EventStore：
//   1. 生产端：LarkCliInstance.handleEvent 落库原始 trigger event（emitTriggerEvent）
//   2. 消费端：delegate_task 校验 triggerEventId + EventHandler 反查 trigger event
//
// 但 core 不能反向依赖 cli（cli 的 getOrCreateEventStore 在 cli 层），
// 所以这里放一个 core 级共享单例；cli 的 event-handler-wiring 创建 store 时
// 调 setSharedEventStore(store) 把它注册进来，delegate-tool 通过
// getSharedEventStore() 拿到同一个实例。
//
// 未注册时（单测 / 非 CLI 场景）getSharedEventStore() 返回 null，
// 调用方自行降级（向后兼容）。
let sharedEventStore: EventStore | null = null;

/** 注册进程内共享 EventStore（cli wiring / 测试用） */
export function setSharedEventStore(store: EventStore | null): void {
  sharedEventStore = store;
}

/** 获取进程内共享 EventStore（未注册返回 null） */
export function getSharedEventStore(): EventStore | null {
  return sharedEventStore;
}

/** 清空共享单例（仅测试用） */
export function resetSharedEventStore(): void {
  sharedEventStore = null;
}