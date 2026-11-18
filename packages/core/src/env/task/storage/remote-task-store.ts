/**
 * @fileoverview RemoteTaskStore — 把 `TaskStore` 做成一个 HTTP 客户端
 *
 * Task #5440（方案 v3 §4.2 / M2）。roy-bot 的 task 存储除了本地 SQLite，
 * 还可以指向常驻的 **task-service**（`~/work/codework/personal/roy_world/roy-task-service`）。
 *
 * ## 契约
 *
 * - 服务端 `POST /store/<method>`：`TaskStore` 方法 **1:1 映射**，body 为
 *   `{ "args": [...] }`（多参方法按位置透传），响应体就是方法的返回值。
 * - 鉴权：`Authorization: Bearer <token>`。
 * - 幂等：**写方法**带 `Idempotency-Key`。同一逻辑调用重试时**复用同一个 key**
 *   （服务端重放缓存，避免重试造成重复写入）；不同调用必须用不同 key。
 * - 握手：首次调用前 `GET /version` 校验 `protocol.major`，不匹配即明确报错
 *   （不静默降级 —— 方案 §1.3 非目标：**无本地 fallback**）。
 *
 * ## 故障语义（方案 §5.3）
 *
 * | 情况 | 处理 |
 * |---|---|
 * | 401 | `RemoteAuthError`，**不重试**（token 错，重试无用） |
 * | 409 IDEMPOTENCY_CONFLICT | `RemoteIdempotencyConflictError`，**不重试** |
 * | 400 VALIDATION | 明确报错（payload 错） |
 * | 404 METHOD_NOT_FOUND | `RemoteProtocolError`（服务端版本过旧） |
 * | 503 BUSY | sqlite 单连接 batch 事务占用 → 有界重试，超限 `RemoteBatchBusyError` |
 * | 5xx / 超时 / 网络错 | 有界重试（写方法靠幂等 key 保证重放安全） |
 *
 * 所有错误信息都带 endpoint 与排障指引，绝不悄悄退回本地库。
 */

import { createLogger } from "../../log-trace/logger";
import type { TaskStore } from "./sqlite-task-store";
import type { ListTagsOptions, SearchTagsOptions } from "../tag-service";
import type {
  CreateOperationOptions,
  CreateTaskOptions,
  ListOperationsOptions,
  ListTasksOptions,
  SearchTasksOptions,
  Task,
  TaskListResult,
  TaskOperation,
  TaskTag,
  UpdateTaskOptions,
} from "../types";

// ============================================================================
// Errors
// ============================================================================

/** 远端 task-service 的基础错误（带 endpoint，便于排障）。 */
export class RemoteTaskStoreError extends Error {
  constructor(message: string, readonly endpoint: string, readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bearer token 缺失/失效（401）。**不重试**。 */
export class RemoteAuthError extends RemoteTaskStoreError {}

/** 幂等 key 被不同 payload 复用（409 IDEMPOTENCY_CONFLICT）。**不重试**。 */
export class RemoteIdempotencyConflictError extends RemoteTaskStoreError {}

/**
 * sqlite 后端的 batch 事务独占单连接，期间普通请求被拒（503 BUSY）。
 *
 * 重试后仍失败才抛这个 —— 调用方可以据此选择「稍后再试」还是报错。
 */
export class RemoteBatchBusyError extends RemoteTaskStoreError {}

/** 协议不兼容（major 版本不一致 / 服务端不认识该方法）。**不重试**。 */
export class RemoteProtocolError extends RemoteTaskStoreError {}

// ============================================================================
// 方法分类（与服务端 WRITE_METHODS 保持一致）
// ============================================================================

/** 写方法：带 Idempotency-Key；重试安全（服务端幂等表）。 */
const WRITE_METHODS = new Set<string>([
  "createTask", "updateTask", "deleteTask",
  "createOperation", "updateOperation", "deleteOperation",
  "createTag", "deleteTag",
  "addTagsToTask", "removeTagsFromTask", "updateTaskTags",
]);

/**
 * 服务端 `TASK_STORE_METHODS` 白名单的**本地副本**。
 *
 * 用途：握手时对齐协议面（服务端白名单变化 = 协议变化），以及让
 * `RemoteTaskStore` 的方法集有单一可断言的来源（测试可对照）。
 * ⚠️ 与 roy-task-service `packages/backend/src/types.ts` 的
 * `TASK_STORE_METHODS` 必须保持一致。
 */
export const REMOTE_TASK_STORE_METHODS = [
  "createTask", "getTask", "updateTask", "deleteTask", "listTasks",
  "getTaskIdBySessionId", "getTaskIdsBySessionId",
  "createOperation", "getOperation", "updateOperation", "deleteOperation",
  "listOperations", "listOperationsFresh", "invalidateOperationsCache",
  "createTag", "getTag", "getTagByName", "listTags", "searchTags", "deleteTag",
  "addTagsToTask", "removeTagsFromTask", "getTagsForTask", "getTaskIdsByTags", "updateTaskTags",
  "searchTasksByKeywords", "findSimilarTasksByKeywords", "getTaskTree", "getChildTasks",
  "findSimilarTasks", "searchTasks", "findTasksByContextValue",
] as const;

/** 本 client 支持的协议 major（与服务端 `PROTOCOL_VERSION.major` 对齐）。 */
export const REMOTE_PROTOCOL_MAJOR = 1;

/**
 * 裁掉参数数组**尾部**的 `null` / `undefined`。
 *
 * 为什么只裁尾部：位置参数中间的空位有语义（`updateTask(7, null)` 的 null 是
 * 「要改的那个值」），只有尾部才是「调用方没传」的表达。裁掉后服务端才会
 * 用它自己的默认参数。
 *
 * ⚠️ 不能按 falsy 裁：`limit: 0` / `offset: 0` / `""` 都是调用方的显式意图。
 */
export function trimTrailingNullish(args: unknown[]): unknown[] {
  let end = args.length;
  while (end > 0) {
    const v = args[end - 1];
    if (v === null || v === undefined) end -= 1;
    else break;
  }
  return end === args.length ? args : args.slice(0, end);
}

// ============================================================================
// Options
// ============================================================================

/** 只用到 warning/debug 两档（避免把整个 logger 类型泄漏到公开 API）。 */
export interface RemoteLogger {
  warn?(message: string): void;
  debug?(message: string): void;
}

const defaultLog = createLogger("task-remote") as RemoteLogger;

export interface RemoteTaskStoreOptions {
  /** service 地址，如 `http://127.0.0.1:7820`（末尾斜杠可有可无）。 */
  endpoint: string;
  /** Bearer token；service 未配置 token 时留空。 */
  authToken?: string;
  /** 单请求超时（毫秒），默认 5000。 */
  timeoutMs?: number;
  /** 可重试失败的最大**重试**次数（不含首次），默认 3。 */
  maxRetries?: number;
  /** 重试退避基数（毫秒），第 n 次重试等 `base * 2^n`，默认 200。 */
  retryBaseDelayMs?: number;
  /** 注入 fetch（测试/自定义传输）。 */
  fetchImpl?: typeof fetch;
  /** 注入 logger（默认用 core logger）。 */
  log?: RemoteLogger;
}

export interface RemoteTaskStoreStats {
  /** /version 握手次数（正常为 1；重连后可增加）。 */
  handshakes: number;
  /** 累计请求数（含重试）。 */
  requests: number;
  /** 累计重试次数。 */
  retries: number;
}

// ============================================================================
// RemoteTaskStore
// ============================================================================

export class RemoteTaskStore implements TaskStore {
  private readonly endpoint: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: RemoteLogger;

  private readonly stats: RemoteTaskStoreStats = { handshakes: 0, requests: 0, retries: 0 };
  private handshake?: Promise<void>;
  private closed = false;

  constructor(options: RemoteTaskStoreOptions) {
    if (!options?.endpoint) {
      throw new Error("[RemoteTaskStore] endpoint is required (task.storage.endpoint)");
    }
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 200;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.log = options.log ?? defaultLog;
  }

  /** 诊断用统计（联调/健康检查）。 */
  getStats(): Readonly<RemoteTaskStoreStats> {
    return { ...this.stats };
  }

  // ==========================================================================
  // 传输核心
  // ==========================================================================

  private ensureOpen(): void {
    if (this.closed) {
      throw new RemoteTaskStoreError(
        `RemoteTaskStore is closed (endpoint=${this.endpoint})`,
        this.endpoint,
      );
    }
  }

  /** `/version` 握手（只做一次；失败则下次调用重试）。 */
  private async ensureHandshake(): Promise<void> {
    if (!this.handshake) {
      this.handshake = this.doHandshake().catch((e) => {
        // 握手失败**不缓存**：service 可能稍后才起来。
        this.handshake = undefined;
        throw e;
      });
    }
    return this.handshake;
  }

  private async doHandshake(): Promise<void> {
    this.ensureOpen();
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${this.endpoint}/version`, { method: "GET" });
    } catch (e) {
      throw new RemoteTaskStoreError(
        `Cannot reach task-service at ${this.endpoint} (/version): ` +
          `${e instanceof Error ? e.message : String(e)}. ` +
          `Start it (systemctl --user start roy-task-service) or set task.storage.endpoint correctly. ` +
          `No local fallback is performed by design.`,
        this.endpoint,
        e,
      );
    }
    if (!res.ok) {
      throw new RemoteProtocolError(
        `task-service /version returned HTTP ${res.status} (endpoint=${this.endpoint})`,
        this.endpoint,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      protocol?: { major?: number; minor?: number };
    };
    const major = body?.protocol?.major;
    if (typeof major !== "number") {
      throw new RemoteProtocolError(
        `task-service /version response has no protocol.major (endpoint=${this.endpoint})`,
        this.endpoint,
      );
    }
    if (major !== REMOTE_PROTOCOL_MAJOR) {
      throw new RemoteProtocolError(
        `Protocol mismatch: client speaks store-major ${REMOTE_PROTOCOL_MAJOR}, ` +
          `task-service speaks ${major} (endpoint=${this.endpoint}). Upgrade one side.`,
        this.endpoint,
      );
    }
    this.stats.handshakes += 1;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 分类：该错误值得重试吗？ */
  private isRetryableStatus(status: number): boolean {
    return status === 503 || status === 502 || status === 504 || status >= 500;
  }

  /**
   * 一次逻辑调用 = 一次 `POST /store/<method>`，内含**有界重试**。
   *
   * @param method TaskStore 方法名
   * @param args   按位置透传的实参
   */
  private async call<T>(method: string, rawArgs: unknown[]): Promise<T> {
    this.ensureOpen();
    await this.ensureHandshake();

    // ★ CV MAJOR-1 — 裁掉**尾随**的 undefined/null，让服务端的默认参数生效。
    //
    // `TaskStore` 用 `?` 声明可选参数（选项对象 / limit / depth / tags …），
    // 而 service 侧是**默认参数**（`depth: number = -1`、`options: X = {}`）。
    // 两者语义不同：省略会触发默认值，`null` 不会。第一版把省略写成 `null`
    // 透传，造成两类静默错误：
    //   - `getTaskTree(id, null)` → `depth !== -1 && 0 >= null` → 返回 []（丢子树）
    //   - `searchTasks("q", null)` → SQL `LIMIT null` → 500
    // 因此这里统一裁剪：只裁**尾部**的 null/undefined，中间位置不动（显式
    // 传的 null 在中间位置是调用方意图，例如 `updateTask(id, { owner: null })`）。
    const args = trimTrailingNullish(rawArgs);

    const idempotencyKey = WRITE_METHODS.has(method)
      ? `${method}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      : undefined;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        this.stats.retries += 1;
        const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1);
        this.log.debug?.(
          `[RemoteTaskStore] retry ${attempt}/${this.maxRetries} ${method} in ${backoff}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

      this.stats.requests += 1;
      let res: Response;
      try {
        res = await this.fetchWithTimeout(`${this.endpoint}/store/${method}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ args }),
        });
      } catch (e) {
        // 网络错 / 超时（AbortError）→ 可重试
        lastError = e;
        if (attempt === this.maxRetries) {
          throw new RemoteTaskStoreError(
            `task-service request failed: ${method} (endpoint=${this.endpoint}) after ` +
              `${attempt + 1} attempts: ${e instanceof Error ? e.message : String(e)}. ` +
              `No local fallback is performed by design.`,
            this.endpoint,
            e,
          );
        }
        continue;
      }

      if (res.ok) {
        const text = await res.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch (e) {
          throw new RemoteTaskStoreError(
            `task-service returned non-JSON for ${method} (endpoint=${this.endpoint})`,
            this.endpoint,
            e,
          );
        }
      }

      const body = (await res.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      const code = body?.error?.code ?? "";
      const detail = body?.error?.message ?? `HTTP ${res.status}`;

      if (res.status === 401) {
        throw new RemoteAuthError(
          `task-service rejected the request (401 ${code}): ${detail}. ` +
            `Check task.storage.authToken against the service's TASK_AUTH_TOKEN ` +
            `(endpoint=${this.endpoint}).`,
          this.endpoint,
        );
      }
      if (res.status === 409 && code === "IDEMPOTENCY_CONFLICT") {
        throw new RemoteIdempotencyConflictError(
          `task-service idempotency conflict for ${method}: ${detail} (endpoint=${this.endpoint})`,
          this.endpoint,
        );
      }
      if (res.status === 404 && code === "METHOD_NOT_FOUND") {
        throw new RemoteProtocolError(
          `task-service does not implement ${method}() — service is older than this client ` +
            `(endpoint=${this.endpoint}). deploy a newer task-service.`,
          this.endpoint,
        );
      }
      if (res.status === 400) {
        throw new RemoteTaskStoreError(
          `task-service rejected ${method} payload (400 ${code}): ${detail} (endpoint=${this.endpoint})`,
          this.endpoint,
        );
      }
      if (res.status === 503 && code === "BUSY") {
        lastError = new RemoteBatchBusyError(
          `sqlite backend busy for ${method}: a batch transaction holds the single shared ` +
            `connection; retried ${this.maxRetries} times without success (endpoint=${this.endpoint}). ` +
            `Retry after the batch completes.`,
          this.endpoint,
        );
        if (attempt === this.maxRetries) throw lastError;
        continue;
      }

      if (this.isRetryableStatus(res.status)) {
        lastError = new RemoteTaskStoreError(
          `task-service error for ${method} (HTTP ${res.status} ${code}): ${detail} ` +
            `(endpoint=${this.endpoint})`,
          this.endpoint,
        );
        if (attempt === this.maxRetries) throw lastError;
        continue;
      }

      // 其余 4xx：参数/语义错误，重试无用
      throw new RemoteTaskStoreError(
        `task-service rejected ${method} (HTTP ${res.status} ${code}): ${detail} ` +
          `(endpoint=${this.endpoint})`,
        this.endpoint,
      );
    }

    // 理论上不可达（每个分支都已 throw 或 continue）
    throw new RemoteTaskStoreError(
      `task-service call ${method} exhausted retries (endpoint=${this.endpoint}): ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
      this.endpoint,
      lastError,
    );
  }

  // ==========================================================================
  // Task CRUD
  // ==========================================================================

  createTask(options: CreateTaskOptions): Promise<Task> {
    return this.call<Task>("createTask", [options]);
  }

  async getTask(id: number): Promise<Task | undefined> {
    const task = await this.call<Task | null>("getTask", [id]);
    // 服务端 `Response.json(undefined ?? null)` → null；统一净化为 undefined
    return task ?? undefined;
  }

  async updateTask(id: number, options: UpdateTaskOptions): Promise<Task | undefined> {
    const task = await this.call<Task | null>("updateTask", [id, options]);
    return task ?? undefined;
  }

  deleteTask(id: number): Promise<boolean> {
    return this.call<boolean>("deleteTask", [id]);
  }

  listTasks(options?: ListTasksOptions): Promise<TaskListResult> {
    return this.call<TaskListResult>("listTasks", [options]);
  }

  async getTaskIdBySessionId(sessionId: string): Promise<number | undefined> {
    const id = await this.call<number | null>("getTaskIdBySessionId", [sessionId]);
    return id ?? undefined;
  }

  getTaskIdsBySessionId(sessionId: string): Promise<number[]> {
    return this.call<number[]>("getTaskIdsBySessionId", [sessionId]);
  }

  // ==========================================================================
  // Operation CRUD
  // ==========================================================================

  createOperation(options: CreateOperationOptions): Promise<TaskOperation> {
    return this.call<TaskOperation>("createOperation", [options]);
  }

  async getOperation(id: number): Promise<TaskOperation | undefined> {
    const op = await this.call<TaskOperation | null>("getOperation", [id]);
    return op ?? undefined;
  }

  async updateOperation(
    id: number,
    updates: Parameters<TaskStore["updateOperation"]>[1],
  ): Promise<TaskOperation | undefined> {
    const op = await this.call<TaskOperation | null>("updateOperation", [id, updates]);
    return op ?? undefined;
  }

  deleteOperation(id: number): Promise<boolean> {
    return this.call<boolean>("deleteOperation", [id]);
  }

  listOperations(options: ListOperationsOptions): Promise<TaskOperation[]> {
    return this.call<TaskOperation[]>("listOperations", [options]);
  }

  /** optional — 绕过缓存直读（跨进程写入可见）。 */
  listOperationsFresh(options: ListOperationsOptions): Promise<TaskOperation[]> {
    return this.call<TaskOperation[]>("listOperationsFresh", [options]);
  }

  /**
   * optional — 失效 operations 缓存。
   *
   * 接口签名是**同步 void**，而远端失效必然是一次网络调用：这里
   * fire-and-forget（不阻塞调用方，失败仅 WARN）。服务端缓存只在 service
   * 进程内，失效语义"尽力而为"即可 —— 真正需要新鲜数据时用
   * `listOperationsFresh`。
   */
  invalidateOperationsCache(taskId: number): void {
    void this.call<null>("invalidateOperationsCache", [taskId]).catch((e: unknown) => {
      this.log.warn?.(
        `[RemoteTaskStore] invalidateOperationsCache(${taskId}) failed: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  // ==========================================================================
  // Tag CRUD
  // ==========================================================================

  createTag(name: string): Promise<TaskTag> {
    return this.call<TaskTag>("createTag", [name]);
  }

  async getTag(id: number): Promise<TaskTag | undefined> {
    const tag = await this.call<TaskTag | null>("getTag", [id]);
    return tag ?? undefined;
  }

  async getTagByName(name: string): Promise<TaskTag | undefined> {
    const tag = await this.call<TaskTag | null>("getTagByName", [name]);
    return tag ?? undefined;
  }

  listTags(options?: ListTagsOptions): Promise<TaskTag[]> {
    return this.call<TaskTag[]>("listTags", [options]);
  }

  searchTags(options: SearchTagsOptions): Promise<TaskTag[]> {
    return this.call<TaskTag[]>("searchTags", [options]);
  }

  deleteTag(id: number): Promise<boolean> {
    return this.call<boolean>("deleteTag", [id]);
  }

  // ==========================================================================
  // Tag ↔ Task
  // ==========================================================================

  async addTagsToTask(taskId: number, tagIds: number[]): Promise<void> {
    await this.call<null>("addTagsToTask", [taskId, tagIds]);
  }

  async removeTagsFromTask(taskId: number, tagIds: number[]): Promise<void> {
    await this.call<null>("removeTagsFromTask", [taskId, tagIds]);
  }

  getTagsForTask(taskId: number): Promise<TaskTag[]> {
    return this.call<TaskTag[]>("getTagsForTask", [taskId]);
  }

  getTaskIdsByTags(tagNames: string[]): Promise<number[]> {
    return this.call<number[]>("getTaskIdsByTags", [tagNames]);
  }

  async updateTaskTags(taskId: number, tagNames: string[]): Promise<void> {
    await this.call<null>("updateTaskTags", [taskId, tagNames]);
  }

  // ==========================================================================
  // 检索能力
  // ==========================================================================

  searchTasksByKeywords(
    keywords: string[],
    options?: SearchTasksOptions,
  ): Promise<TaskListResult> {
    return this.call<TaskListResult>("searchTasksByKeywords", [keywords, options]);
  }

  findSimilarTasksByKeywords(
    keywords: string[],
    options?: { limit?: number; excludeTaskId?: number },
  ): Promise<Task[]> {
    return this.call<Task[]>("findSimilarTasksByKeywords", [keywords, options]);
  }

  getTaskTree(taskId: number, depth?: number): Promise<Task[]> {
    return this.call<Task[]>("getTaskTree", [taskId, depth]);
  }

  getChildTasks(taskId: number, options?: ListTasksOptions): Promise<TaskListResult> {
    return this.call<TaskListResult>("getChildTasks", [taskId, options]);
  }

  findSimilarTasks(taskId: number, limit?: number): Promise<Task[]> {
    return this.call<Task[]>("findSimilarTasks", [taskId, limit]);
  }

  searchTasks(query: string, limit?: number): Promise<Task[]> {
    return this.call<Task[]>("searchTasks", [query, limit]);
  }

  findTasksByContextValue(value: string, limit?: number): Promise<Task[]> {
    return this.call<Task[]>("findTasksByContextValue", [value, limit]);
  }

  // ==========================================================================
  // 生命周期
  // ==========================================================================

  /**
   * 关闭 client（幂等）。
   *
   * 与本地 store 不同：**没有连接需要释放**，只是把实例标记为已关闭，
   * 后续调用立即报错（避免组件被 dispose 后仍有请求飞出去）。
   */
  close(): void {
    this.closed = true;
  }
}

/** 便捷工厂（与 `createSQLiteTaskPort` 对称）。 */
export function createRemoteTaskStore(options: RemoteTaskStoreOptions): RemoteTaskStore {
  return new RemoteTaskStore(options);
}
