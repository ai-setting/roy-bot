/**
 * @fileoverview Span Storage 实现
 * 
 * 提供 SQLiteSpanStorage 一种实现，用于持久化存储 span 数据
 */

import {
  type Span,
  type SpanStorage,
  type TraceInfo,
  SpanKind,
  SpanStatus,
} from "./types";

// 重新导出类型
export type { SpanStorage, TraceInfo } from "./types";

function isSpanStorageDebugEnabled(): boolean {
  return process.env.ROY_TRACE_DEBUG_STORAGE === "1" || process.env.ROY_TRACE_DEBUG === "1";
}

/**
 * Safe JSON.stringify that handles cyclic structures, functions, React elements,
 * Error objects, and other non-serializable values.
 *
 * Why: `agent:before.llm` hooks may pass agent/fiber/context objects that contain
 * self-references or React internals. A naive `JSON.stringify(span.attributes)`
 * or `JSON.stringify(span.result)` throws "cyclic structure" and bubbles up
 * through `storage.save()` → `span.end()` → `@TracedAs` wrapper, breaking the
 * entire REPL (e.g. MessageView render).
 *
 * Behavior:
 * - Cycles: replaced with "[Circular]"
 * - Functions: replaced with "[Function]"
 * - React elements ($typeof): replaced with "[ReactElement]"
 * - Error objects: replaced with "Name: message"
 * - Other unserializable values: best-effort fallback string
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === "function") return "[Function]";
      if (value === undefined) return "[undefined]";
      if (value === null) return null;
      if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
      }
      if (typeof value === "object") {
        // React elements / fibers carry $typeof (Symbol) or .type
        if ("$typeof" in value || ("type" in value && "props" in value && "key" in value)) {
          return "[ReactElement]";
        }
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      // BigInt cannot be JSON-stringified
      if (typeof value === "bigint") return value.toString();
      return value;
    });
  } catch (err) {
    // Last-resort fallback: stringify should never throw on plain inputs,
    // but guard against any unforeseen symbol / accessor behavior.
    return `[Unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

// ============================================================================
// SQLite Runtime Detection
// ============================================================================

/**
 * 获取 SQLite 数据库类
 * 
 * 根据运行时环境选择正确的实现：
 * - Bun 运行时：使用 bun:sqlite（命名导出）
 * - Node.js 22.5+：使用 node:sqlite（内置，无原生依赖）
 * - 旧 Node/Electron：使用 better-sqlite3（默认导出）
 *
 * Task #4666：node:sqlite 优先于 better-sqlite3（与
 * sqlite-task-store.ts 的 getDatabaseClass 对齐）。
 *
 * 为什么这很重要：插件侧 MCP server 跑在纯 node 下，task_list
 * 对真实 DB（4200+ tasks）的每一行 rowToTask 都会写 span。
 * better-sqlite3 的 Statement 是 node::ObjectWrap，而 node v24 的
 * ObjectWrap 析构会调 RemoveEnvironmentCleanupHook —— major GC 的
 * weak-callback 栈上 isolate 不在任何 context 里，`Environment::GetCurrent`
 * 返回 nullptr，hooks.cc:142 的 CHECK_NOT_NULL 直接 abort（exit 134）。
 * node:sqlite 是 node 内置模块，没有这个问题。
 */
function getDatabaseClass(): new (path: string) => any {
  // @ts-ignore - Bun global
  if (typeof Bun !== 'undefined') {
    // Bun 运行时使用 bun:sqlite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return Database;
  }

  // Task #4666: 纯 node 优先用内置的 node:sqlite（无原生依赖）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    if (typeof DatabaseSync === "function") {
      return DatabaseSync;
    }
  } catch {
    // node < 22.5 没有 node:sqlite —— 落到 better-sqlite3。
  }

  // 旧 Node.js/Electron 使用 better-sqlite3（直接是函数）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
function createCompatibleDatabase(path: string): any {
  const Database = getDatabaseClass();
  const db = new Database(path);
  
  // 如果 better-sqlite3，添加 run() 兼容方法
  if (typeof db.run !== 'function') {
    db.run = function(sql: string, ...params: any[]) {
      if (params.length > 0) {
        // 有参数，使用 prepare().run()
        return this.prepare(sql).run(...params);
      } else {
        // 无参数，使用 exec()
        return this.exec(sql);
      }
    };
  }
  
  return db;
}

// ============================================================================
// SQLiteSpanStorage
// ============================================================================

/**
 * SQLite 存储实现
 * 
 * 根据运行时环境使用 bun:sqlite 或 better-sqlite3
 * 
 * 注意：此实现仅支持 SQLite 文件存储，不支持 :memory: 模式
 * WAL 模式默认启用以支持跨进程并发访问
 */
export class SQLiteSpanStorage implements SpanStorage {
  private db: any = null;
  private dbPath: string;
  private initialized = false;

  /**
   * 创建 SQLiteSpanStorage 实例
   * 
   * @param dbPath SQLite 数据库文件路径（必填）
   * @throws Error 如果 dbPath 为空或为 :memory:
   */
  constructor(dbPath: string) {
    // 验证：dbPath 必填，且不能是 :memory:
    if (!dbPath) {
      throw new Error("SQLiteSpanStorage requires a valid dbPath parameter");
    }
    if (dbPath === ":memory:") {
      throw new Error("SQLiteSpanStorage does not support :memory: mode. Use a file path instead.");
    }
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // 使用运行时检测获取兼容的 SQLite 实现
    // 确保 bun:sqlite 和 better-sqlite3 都有 run() 方法

    // 确保目录存在
    const fs = require("fs");
    const path = require("path");
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = createCompatibleDatabase(this.dbPath);
    
    // 启用 WAL 模式以支持更好的并发写入
    // WAL (Write-Ahead Logging) 允许读操作与写操作并发执行
    // WAL 模式支持跨进程访问，是本实现的核心特性
    this.db.run("PRAGMA journal_mode=WAL");
    // 设置 busy_timeout 以处理锁冲突（5秒）
    this.db.run("PRAGMA busy_timeout=5000");
    // 使用 NORMAL 同步模式，平衡性能和数据安全
    this.db.run("PRAGMA synchronous=NORMAL");
    
    // 创建表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS span (
        span_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        attributes TEXT,
        result TEXT,
        error TEXT,
        time_created INTEGER NOT NULL
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_span_trace ON span(trace_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_span_parent ON span(parent_span_id)");

    this.initialized = true;
  }

  save(span: Span): void {
    if (!this.db) {
      if (isSpanStorageDebugEnabled()) {
        console.log(
          `[SpanStorage] save() skipped: db not initialized for span "${span.name}" traceId=${span.traceId}`
        );
      }
      return;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO span 
      (span_id, trace_id, parent_span_id, name, kind, status, start_time, end_time, attributes, result, error, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    // result 处理：如果已经是字符串，直接存储；否则 safe-stringify
    // safeStringify 处理 cyclic / function / React element / Error 等不可序列化值
    const resultValue = span.result !== undefined && span.result !== null
      ? (typeof span.result === "string" ? span.result : safeStringify(span.result))
      : null;
    
    if (isSpanStorageDebugEnabled()) {
      console.log(
        `[SpanStorage] Saving to "${this.dbPath}": name="${span.name}" traceId=${span.traceId} spanId=${span.spanId} status=${span.status}`
      );
    }
    
    try {
      const result = stmt.run(
        span.spanId,
        span.traceId,
        span.parentSpanId || null,
        span.name,
        span.kind,
        span.status,
        span.startTime,
        span.endTime || null,
        safeStringify(span.attributes),
        resultValue,
        span.error || null,
        Date.now()
      );
      if (isSpanStorageDebugEnabled()) {
        console.log(
          `[SpanStorage] Save result: changes=${result?.changes}, lastInsertRowid=${result?.lastInsertRowid}`
        );
      }
    } catch (err) {
      console.error(`[SpanStorage] Save ERROR:`, err);
    }
  }

  saveBatch(spans: Span[]): void {
    for (const span of spans) {
      this.save(span);
    }
  }

  findByTraceId(traceId: string): Span[] {
    if (!this.db) return [];

    const rows = this.db.prepare("SELECT * FROM span WHERE trace_id = ?").all(traceId);
    return this.buildTree(rows.map(this.rowToSpan));
  }

  findBySpanId(spanId: string): Span | undefined {
    if (!this.db) return undefined;

    const row = this.db.prepare("SELECT * FROM span WHERE span_id = ?").get(spanId);
    return row ? this.rowToSpan(row) : undefined;
  }

  listTraces(limit: number = 10): TraceInfo[] {
    if (!this.db) return [];

    const rows = this.db.prepare(`
      SELECT trace_id,
             MIN(start_time) as start_time,
             MAX(end_time) as end_time,
             COUNT(*) as span_count,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
             (SELECT name FROM span s2
                WHERE s2.trace_id = span.trace_id
                ORDER BY (s2.parent_span_id IS NULL OR s2.parent_span_id = '') DESC,
                         s2.start_time ASC
                LIMIT 1) as root_name
      FROM span
      GROUP BY trace_id
      ORDER BY start_time DESC
      LIMIT ?
    `).all(limit);

    return rows.map((row: any) => {
      const spanCount = Number(row.span_count) || 0;
      const errorCount = Number(row.error_count) || 0;
      const endTime = row.end_time ?? undefined;
      const status: TraceInfo["status"] =
        errorCount === 0 ? "ok" : errorCount >= spanCount ? "error" : "mixed";

      return {
        traceId: row.trace_id,
        rootSpanName: row.root_name ?? "unknown",
        startTime: row.start_time,
        endTime,
        duration: endTime !== undefined ? endTime - row.start_time : undefined,
        spanCount,
        status,
      };
    });
  }

  deleteByTraceId(traceId: string): void {
    if (this.db) {
      this.db.prepare("DELETE FROM span WHERE trace_id = ?").run(traceId);
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private rowToSpan(row: any): Span {
    return {
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      name: row.name,
      kind: row.kind as SpanKind,
      status: row.status as SpanStatus,
      startTime: row.start_time,
      endTime: row.end_time,
      attributes: row.attributes ? JSON.parse(row.attributes) : {},
      // result 保持原样存储，不进行额外的 parse
      // 如果原来是对象，会被序列化为字符串存储
      // 如果原来就是字符串（已经是序列化的），也会保持原样
      result: row.result || undefined,
      error: row.error || undefined,
    };
  }

  private buildTree(spans: Span[]): Span[] {
    const spanMap = new Map<string, Span>();
    const roots: Span[] = [];

    for (const span of spans) {
      spanMap.set(span.spanId, { ...span, children: [] });
    }

    for (const span of spanMap.values()) {
      if (span.parentSpanId) {
        const parent = spanMap.get(span.parentSpanId);
        if (parent) {
          parent.children!.push(span);
        } else {
          roots.push(span);
        }
      } else {
        roots.push(span);
      }
    }

    return roots;
  }
}
