/**
 * @fileoverview Session Component
 * 
 * Component for managing session lifecycle
 */

import { BaseComponent, type ComponentConfig } from "../component";
import {
  type SessionConfig,
  type Session,
  type SessionMetadata,
  type CreateSessionOptions,
  type UpdateSessionOptions,
  type ListSessionsOptions,
  type SessionMessage,
  type AddMessageOptions,
  type SessionCheckpoint,           // (new)
  type CompactOptions,             // (new)
  type CompactResult,             // (new)
  type CompactPreview,            // (new)
  type CheckpointAdaptReport,     // Task #4933
  type GetContextOptions,         // (new)
  type GetContextResult,          // (new)
  type SearchMessagesOptions,     // (new)
  type SearchResult,              // (new)
  type MessageMatch,              // (new)
  type ChatTaskBinding,           // Task #4023
  type UpsertChatTaskBindingOptions, // Task #4023
} from "./types";
import {
  buildGroupLinkEventMessage,
  buildGroupSessionMetadata,
  isGroupDisbanded,
  GROUP_LINK_METADATA_KEYS,
} from "./group-session-link";
import type { SessionHookContext } from "../types";
import type { SessionStore } from "./session-store";
import { MemorySessionStore, SQLiteSessionStore } from "./storage";
import { createLogger } from "../log-trace/logger";
import type { ConfigComponent } from "../../config/config-component";
import { envKeyToConfigKey } from "../../config/env-key";
import { TracedAs } from "../log-trace/decorator";
import { messagesParamFilter } from "../log-trace/trace-filters";
import { SESSION_CONFIG_REGISTRATION, SESSION_DEFAULTS } from "./session-config-registration";
import { parseSearchQuery, matchesQuery } from "./search-query-parser";
import path from "path";
import {
  normalizeCheckpointContent,
  buildCheckpointFromText,
  adaptLegacyCheckpoint,
  createCheckpointContent,
} from "./compact-checkpoint-content";

// Re-export for convenience
export type {
  SessionConfig,
  Session,
  SessionMessage,
  CreateSessionOptions,
  UpdateSessionOptions,
  ListSessionsOptions,
  AddMessageOptions,
  SessionCheckpoint,              // (new)
  CompactOptions,                // (new)
  CompactResult,                 // (new)
  CompactPreview,                // (new)
  CheckpointAdaptReport,         // Task #4933
  GetContextOptions,            // (new)
  GetContextResult,             // (new)
  SearchMessagesOptions,         // (new) Search
  SearchResult,                  // (new) Search
  MessageMatch,                  // (new) Search
  ChatTaskBinding,               // Task #4023
  UpsertChatTaskBindingOptions,  // Task #4023
} from "./types";

// Create logger for session component
const logger = createLogger("session");

// ============================================================================
// Compact output handling（C 方案：整段自然语言）
// ============================================================================

// ============================================================================
// Helpers (Layer 2: retry on SQLITE_BUSY)
// ============================================================================

/**
 * Promise-based sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect a `SQLITE_BUSY` / "database is locked" error.
 *
 * Code Review note: prefer the structured `error.code` first (set by
 * better-sqlite3, node-sqlite3, and node:sqlite). Only fall back to
 * substring-matching the message for bun:sqlite, which currently
 * surfaces SQLITE_BUSY as a plain Error whose `.message` starts with
 * "SQLiteError: ..." and contains the canonical phrase.
 *
 * The substring fallback is anchored on leading punctuation so that
 * user-facing errors quoting a column called "database is locked"
 * cannot accidentally trigger retry.
 */
function isBusyError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { code?: string; errno?: number; message?: string };
  if (typeof e.code === "string") {
    // Exact matches only — "BUSY" / "LOCKED" prefixes plus suffix variants.
    if (/^SQLITE_(BUSY|LOCKED)$/i.test(e.code)) return true;
  }
  if (typeof e.errno === "number" && (e.errno === 5 || e.errno === 6)) {
    // 5 = SQLITE_BUSY, 6 = SQLITE_LOCKED (raw SQLite numeric codes).
    return true;
  }
  // bun:sqlite fallback: message usually starts with "SQLiteError: "
  // followed by "database is locked" or "database table is locked".
  const msg = e.message ?? "";
  return /SQLiteError:\s+(database is locked|database table is locked)/i.test(msg);
}

/**
 * Marker error class so callers can distinguish "lock exhausted after
 * retries" from "validation rejected on first attempt". Previously both
 * returned `undefined`, hiding the difference from `recordSessionMessages`
 * and any future operator.
 */
export class AddMessageLockExhaustedError extends Error {
  readonly kind = "lock_exhausted" as const;
  readonly attempts: number;
  readonly cause: unknown;
  constructor(attempts: number, cause: unknown) {
    super(`Failed to add message after ${attempts} attempts: ${String(cause)}`);
    this.name = "AddMessageLockExhaustedError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

// ============================================================================
// SessionComponentOptions (统一配置机制)
// ============================================================================

/**
 * SessionComponent 配置选项（通过 options 传递）
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的 config 对象（最高优先级）
 */
export interface SessionComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "SESSION"） */
  envPrefix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<SessionConfig>;
}

/**
 * Session component hooks configuration
 */
interface SessionComponentHooks {
  "before.session.create"?: import("./types").SessionHook[];
  "after.session.create"?: import("./types").SessionHook[];
  "before.session.get"?: import("./types").SessionHook[];
  "after.session.get"?: import("./types").SessionHook[];
  "before.session.list"?: import("./types").SessionHook[];
  "after.session.list"?: import("./types").SessionHook[];
  "before.session.update"?: import("./types").SessionHook[];
  "after.session.update"?: import("./types").SessionHook[];
  "before.session.delete"?: import("./types").SessionHook[];
  "after.session.delete"?: import("./types").SessionHook[];
}

/**
 * SessionComponent
 * 
 * Manages session lifecycle including:
 * - Session CRUD operations
 * - Message management
 * - Active session tracking
 */
export class SessionComponent extends BaseComponent {
  /**
   * Exponential backoff schedule for SQLITE_BUSY retry. Indexed by
   * attempt number (0-based). Worst-case total wait across 3 attempts:
   * 50 + 100 + 200 = 350 ms, which is well under the 5 s busy_timeout
   * so the next retry always starts before the lock has had time to
   * expire and re-arm.
   */
  private static readonly BACKOFFS_MS: readonly number[] = [50, 100, 200] as const;

  readonly name = "session";
  readonly version = "1.1.0";  // (new)

  private config?: SessionConfig;
  private store?: SessionStore;
  private activeSessionId?: string;
  private hooksConfig: SessionComponentHooks = {};
  
  /** ConfigComponent 用于配置管理 */
  private configComponent?: ConfigComponent;
  
  /** 配置变更 watcher 清理函数 */
  private configWatcher?: () => void;

  constructor() {
    super();
  }

  /**
   * Initialize the component
   * 
   * 配置加载优先级（从高到低）：
   * 1. Object - 直接传入的 config 对象
   * 2. Env - 环境变量（通过 envPrefix 配置前缀）
   * 3. File - 配置文件（通过 configPath 指定）
   */
  async init(config?: ComponentConfig): Promise<void> {
    // 调用基类 init，注入 env
    await super.init(config);

    // 从 options 获取 ConfigComponent
    const options = config?.options as unknown as SessionComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for SessionComponent initialization");
    }

    this.configComponent = options.configComponent;
    await this.registerConfig(options);

    // Initialize store based on config
    const storageConfig = this.config?.storage;
    if (storageConfig?.type === "sqlite") {
      this.store = new SQLiteSessionStore(storageConfig.dbPath);
      logger.info(`[SessionComponent] Using SQLite storage: ${storageConfig.dbPath || "default path"}`);
    } else {
      this.store = new MemorySessionStore();
      logger.info("[SessionComponent] Using memory storage");
    }

    this.setStatus("running");
    logger.info("[SessionComponent] Initialized");
  }

  /**
   * 获取默认 session 数据库路径
   */
  private getDefaultSessionDbPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    return path.join(home, ".local", "share", "roy-bot", "sessions.db");
  }

  /**
   * 注册配置到 ConfigComponent
   * 
   * 配置加载顺序（优先级从低到高）：
   * 1. Defaults - 默认值（最低）
   * 2. FileSource - 从配置文件加载
   * 3. EnvSource - 从环境变量加载
   * 4. config 对象 - 直接传入的配置（最高）
   */
  private async registerConfig(options: SessionComponentOptions): Promise<void> {
    const configComponent = options.configComponent;
    if (!configComponent) return;

    const { configPath, envPrefix, config } = options;
    const prefix = envPrefix !== undefined ? envPrefix : "SESSION";

    // 1. 使用 registerComponent 注册配置结构（keys 和 sources，不含 defaults）
    configComponent.registerComponent(SESSION_CONFIG_REGISTRATION);

    // 2. 注册 FileSource（如果提供了 configPath）
    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        watch: false
      });
    }

    // 3. 注册 EnvSource
    configComponent.registerSource({
      type: "env",
      envPrefix: prefix,
      priority: 20,
      watch: false
    });
    
    // 4. 从 sources 加载配置（FileSource 和 EnvSource）
    await configComponent.load("session");
    
    // 5. 后备方案：直接读取环境变量（确保所有环境变量都被处理）
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, prefix, "session");
      if (!configKey) continue;
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    // 6. 设置默认值（只有当配置不存在时）
    for (const [key, value] of Object.entries(SESSION_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    // 7. 特殊处理 dbPath 动态默认值（优先级高于 SESSION_DEFAULTS）
    if (configComponent.get("session.storage.dbPath") === undefined) {
      await configComponent.set("session.storage.dbPath", this.getDefaultSessionDbPath());
    }

    // 8. 直接配置对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 9. 注册配置热更新监听
    this.registerConfigWatcher(configComponent);

    // 10. 解析最终配置
    this.config = this.buildConfig(configComponent);
  }

  /**
   * 构建最终配置对象
   */
  private buildConfig(configComponent: ConfigComponent): SessionConfig {
    return {
      defaultDirectory: configComponent.get("session.defaultDirectory") as string,
      defaultTitleTemplate: configComponent.get("session.defaultTitleTemplate") as string,
      maxMessages: configComponent.get("session.maxMessages") as number,
      compactionThreshold: configComponent.get("session.compactionThreshold") as number,
      autoCompact: configComponent.get("session.autoCompact") as boolean,
      storage: {
        type: configComponent.get("session.storage.type") as "memory" | "sqlite",
        dbPath: configComponent.get("session.storage.dbPath") as string | undefined,
      },
    };
  }

  /**
   * 将配置对象展平为点号路径
   */
  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "session"
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(
          result,
          this.flattenConfig(value as Record<string, unknown>, fullKey)
        );
      } else {
        result[fullKey] = value;
      }
    }
    return result;
  }

  /**
   * 注册配置热更新监听
   */
  private registerConfigWatcher(configComponent: ConfigComponent): void {
    if (typeof configComponent.watch !== "function") {
      return;
    }
    
    this.configWatcher = configComponent.watch("session.*", (event) => {
      this.onConfigChange(event);
    });
  }

  /**
   * 处理配置变更
   */
  protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    logger.info(`Session config changed: ${event.key}`, {
      oldValue: event.oldValue,
      newValue: event.newValue
    });
  }

  /**
   * Start the component
   */
  async onStart(): Promise<void> {
    logger.info("[SessionComponent] Started");
  }

  /**
   * Stop the component
   */
  async onStop(): Promise<void> {
    // 清理配置 watcher
    this.configWatcher?.();
    this.configWatcher = undefined;
    
    // 清理资源
    await this.store?.close();
    this.store = undefined;
    this.setStatus("stopped");
    logger.info("[SessionComponent] Stopped");
  }

  // ============ Session CRUD ============

  /**
   * Create a new session
   */
  async create(options: CreateSessionOptions = {}): Promise<Session> {
    // Execute before hooks
    await this.executeBeforeHooks("create", { options });

    // Generate title if not provided
    const title = options.title ?? this.generateTitle();

    // Create session
    const session = await this.store!.create({
      ...options,
      title,
    });

    logger.info(`[SessionComponent] Created session: ${session.id}`, { title });

    // Execute after hooks
    await this.executeAfterHooks("create", { session, options });

    return session;
  }

  /**
   * Get a session by ID
   */
  async get(id: string): Promise<Session | undefined> {
    await this.executeBeforeHooks("session.get", { id });

    const session = await this.store?.get(id);

    await this.executeAfterHooks("session.get", { session });

    return session;
  }

  /**
   * Get a session with full context (for Memory Agent)
   */
  async getSession(id: string): Promise<{ sessionId: string; title: string; messages: any[] } | null> {
    const session = await this.get(id);
    if (!session) {
      return null;
    }

    const messages = await this.getMessages(id);
    return {
      sessionId: session.id,
      title: session.title || "Untitled",
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
    };
  }

  /**
   * Search sessions by query (for Memory Agent)
   * 
   * Simple implementation: list all sessions and return them for the agent to filter
   */
  async searchSessions(
    query: string,
    options?: { session_id?: string; limit?: number }
  ): Promise<Array<{ sessionId: string; title: string; preview: string; timestamp: number }>> {
    const limit = options?.limit ?? 20;
    type SearchResult = { sessionId: string; title: string; preview: string; timestamp: number };
    
    // 如果指定了 session_id，只返回该会话
    if (options?.session_id) {
      const session = await this.get(options.session_id);
      if (session) {
        const messages = await this.getMessages(options.session_id);
        const lastMessage = messages[messages.length - 1];
        return [{
          sessionId: session.id,
          title: session.title || "Untitled",
          preview: lastMessage?.content?.substring(0, 200) || "",
          timestamp: session.updatedAt || session.createdAt,
        }];
      }
      return [];
    }

    // 否则列出所有会话
    const sessions = await this.list({ limit });
    
    // 对每个会话获取预览
    const results: SearchResult[] = [];
    for (const session of sessions) {
      if (results.length >= limit) break;
      
      const messages = await this.getMessages(session.id);
      const lastMessage = messages[messages.length - 1];
      const preview = lastMessage?.content?.substring(0, 200) || "";
      
      // 简单过滤：如果 query 不为空，检查标题或预览是否包含 query
      if (query) {
        const lowerQuery = query.toLowerCase();
        const titleMatch = (session.title || "").toLowerCase().includes(lowerQuery);
        const previewMatch = preview.toLowerCase().includes(lowerQuery);
        if (!titleMatch && !previewMatch) {
          continue;
        }
      }
      
      results.push({
        sessionId: session.id,
        title: session.title || "Untitled",
        preview,
        timestamp: session.updatedAt || session.createdAt,
      });
    }
    
    return results;
  }

  /**
   * List all sessions
   */
  async list(options?: ListSessionsOptions): Promise<Session[]> {
    await this.executeBeforeHooks("session.list", { options });

    const sessions = (await this.store?.list(options)) ?? [];

    await this.executeAfterHooks("session.list", { sessions });

    return sessions;
  }

  /**
   * Get total session count
   */
  async getCount(): Promise<number> {
    return (await this.store?.getCount()) ?? 0;
  }

  /**
   * Update a session
   */
  async update(id: string, updates: UpdateSessionOptions): Promise<boolean> {
    await this.executeBeforeHooks("session.update", { id, updates });

    const success = await this.store?.update(id, updates);

    if (success) {
      logger.info(`[SessionComponent] Updated session: ${id}`, { updates });
      await this.executeAfterHooks("session.update", { id, updates });
    }

    return success ?? false;
  }

  /**
   * Delete a session
   */
  async delete(id: string): Promise<boolean> {
    await this.executeBeforeHooks("session.delete", { id });

    const success = await this.store?.delete(id);

    if (success) {
      if (this.activeSessionId === id) {
        this.activeSessionId = undefined;
      }
      logger.info(`[SessionComponent] Deleted session: ${id}`);
      await this.executeAfterHooks("session.delete", { id });
    }

    return success ?? false;
  }

  // ============ Session → 群 关联（Task #5403，取代废弃的 alias）============

  /**
   * ★ Task #5403：**会话 → 群** 反向查询（取代 #5397 的 alias 版）。
   *
   * ## 背景
   *
   * alias / linkedTo 能力已整体废弃（用户 2026-11-12 定稿）。建群后的群
   * session 是**独立 session**，不再共享原会话的消息历史 —— 原因：
   *  1. 群 session 由 default agent 的 system prompt 驱动，原 sub session 由
   *     sub agent 驱动，复用同一份 history 会让 LLM prefix cache 失效；
   *  2. sub agent 的 delegate prompt（如「不要发飞书消息」）会污染群对话。
   *
   * 新方案：建群时向新 session 注入 **1 条 user role 事件**说明「本群由
   * session X 关联建群，需要背景时用 `roy-bot sessions messages X` 按需读取」，
   * 关联关系本身记在 metadata（`linkedFromSessionId` / `groupCreatedAt`）。
   *
   * ## 用途（三处，与 #5397 一致）
   * 1. 重复建群保护（同 session 已有群 ⇒ 返回已有链接，不新建）
   * 2. 卡片显示已有群链接（session 卡渲染 `perTaskChatId`）
   * 3. 解绑时定位要解散哪个群
   *
   * ## 实现
   *
   * 扫 `metadata.linkedFromSessionId === sessionId` 的 session 行，取它的
   * chatId（来自 `metadata.chatId`，群 session 的识别键）。
   *
   * 走 store 的 metadata filter（SQLite 侧是 JSON1 `json_extract`，不扫全表
   * 之外的额外成本；无 schema 变更、无新索引）。
   *
   * **自称命中**：入参本身是群 session 时，它自己就带
   * `linkedFromSessionId`，此时直接返回自身 —— 因为 `list` 用
   * `linkedFromSessionId = sessionId` 过滤，那个群 session 的
   * `linkedFromSessionId` 指向的是**原会话**而不是自己，所以需要额外一次
   * `get(sessionId)` 自身检查（见下方逻辑）。
   */
  async findGroupChatForSession(
    sessionId: string
  ): Promise<{ chatId: string; aliasSessionId?: string } | undefined> {
    if (!this.store) return undefined;

    const pickChatId = (s: Session): string | undefined => {
      const md = (s.metadata ?? {}) as Record<string, unknown>;
      const chatId = typeof md.chatId === "string" ? md.chatId.trim() : "";
      return chatId.length > 0 ? chatId : undefined;
    };

    try {
      // 1) 入参自身是群 session（带 linkedFromSessionId + chatId）⇒ 直接返回自己。
      //    这一步让「在群里点解散」能定位到本群。
      const self = await this.store.get(sessionId);
      if (self) {
        const md = (self.metadata ?? {}) as Record<string, unknown>;
        const selfChatId = pickChatId(self);
        if (
          selfChatId &&
          typeof md.linkedFromSessionId === "string" &&
          !isGroupDisbanded(md)
        ) {
          return { chatId: selfChatId, aliasSessionId: self.id };
        }
      }

      // 2) 反查：哪些 session 是「由 sessionId 关联建群」而来的
      //    已解散（metadata.groupDisbandedAt 非空）的不算 —— 否则卡片永远
      //    显示「解散该群」、下次建群会幂等命中一个死群。
      const groups = await this.store.list({
        filter: { metadata: { linkedFromSessionId: sessionId } },
        limit: 100,
        sort: { field: "createdAt", order: "desc" },
      });
      for (const g of groups) {
        if (isGroupDisbanded(g.metadata as Record<string, unknown> | undefined)) continue;
        const chatId = pickChatId(g);
        if (chatId) return { chatId };
      }
      return undefined;
    } catch (err) {
      logger.warn(
        `[SessionComponent] findGroupChatForSession(${sessionId}) failed: ${String(err)}`
      );
      return undefined;
    }
  }

  /**
   * ★ Task #5403：**关联建群** —— 建群成功后初始化群 session。
   *
   * 取代 #5369/#5397 的 `linkSession(aliasId, target)`。区别是**不共享历史**：
   *
   *  - 群 session 是独立 session（自己持有消息，读写不透明）
   *  - 只注入 **1 条 user role** 事件，说明「本群由 session X 关联建群
   *    而来，需要背景时执行 `roy-bot sessions messages X -n 50` 按需读取」
   *  - 关联关系写进 metadata（`linkedFromSessionId` / `groupCreatedAt`），
   *    供重复建群保护 / 卡片链接 / 解绑使用
   *
   * ## 幂等
   *
   * 若该 chatId 的 session 已存在且已登记 `linkedFromSessionId`，**不重复
   * 注入**（只补齐缺失的 metadata），返回 `injected: false`。这让「重复点
   * 建群」不会在群里堆一串说明消息。
   *
   * ## 失败语义
   *
   * 返回 `{ ok: false, reason }`，不抛。调用方（建群流程）拿到后只 warn ——
   * 群已经建好了，不能因为初始化失败把结果翻成失败。
   *
   * @param chatId 飞书群 chat id（同时是群 session 的 id）
   * @param originSessionId 原 session id（群是由它关联建出来的）
   */
  async attachGroupSession(args: {
    chatId: string;
    originSessionId: string;
    title?: string;
  }): Promise<
    | { ok: true; sessionId: string; injected: boolean }
    | { ok: false; reason: "store_unavailable" | "invalid_args"; error?: string }
  > {
    if (!this.store) return { ok: false, reason: "store_unavailable" };

    const chatId = (args.chatId ?? "").trim();
    const originSessionId = (args.originSessionId ?? "").trim();
    if (!chatId || !originSessionId) {
      return { ok: false, reason: "invalid_args" };
    }

    try {
      const existing = await this.store.get(chatId);
      const alreadyLinked =
        typeof existing?.metadata?.linkedFromSessionId === "string" &&
        (existing.metadata.linkedFromSessionId as string).trim() === originSessionId;

      if (existing) {
        // 行已存在（事件层可能已经建过 chat-keyed session）：
        // 只补 metadata，不重复注入说明消息。
        await this.store.update(chatId, {
          metadata: buildGroupSessionMetadata({
            chatId,
            originSessionId,
            base: (existing.metadata ?? {}) as Record<string, unknown>,
          }),
        });
        if (alreadyLinked) {
          logger.info(
            `[SessionComponent] attachGroupSession: ${chatId} 已关联 ${originSessionId}（幂等命中，不重复注入）`
          );
          return { ok: true, sessionId: chatId, injected: false };
        }
      } else {
        await this.store.create({
          id: chatId,
          title: args.title ?? `Lark Chat ${chatId}`,
          metadata: buildGroupSessionMetadata({ chatId, originSessionId }),
        });
      }

      // 注入唯一一条 user role 事件（不复制历史）
      const event = buildGroupLinkEventMessage({ originSessionId, chatId });
      await this.store.addMessage(chatId, {
        role: event.role,
        content: event.content,
      });

      logger.info(
        `[SessionComponent] attachGroupSession: ${chatId} ← ${originSessionId}（注入 1 条 user 事件）`
      );
      return { ok: true, sessionId: chatId, injected: true };
    } catch (err) {
      logger.warn(
        `[SessionComponent] attachGroupSession(${chatId} ← ${originSessionId}) failed: ${String(err)}`
      );
      return { ok: false, reason: "store_unavailable", error: String(err) };
    }
  }

  /**
   * ★ Task #5403：**解绑关联群** —— 标记 metadata 为已解散。
   *
   * 取代 #5369 的 `unlinkSession(aliasId)`（原语义是把 linkedTo 置 null）。
   * 新语义：群 session 本身是独立会话，解绑只是把「这个群还活着」的标记
   * 打掉 —— 写入 `groupDisbandedAt`，让 `findGroupChatForSession` 不再命中它。
   *
   * 幂等：已经标记过直接返回 ok。
   */
  async detachGroupSession(
    chatId: string
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.store) return { ok: false, reason: "store_unavailable" };
    const id = (chatId ?? "").trim();
    if (!id) return { ok: false, reason: "invalid_args" };

    try {
      const existing = await this.store.get(id);
      if (!existing) return { ok: true }; // 行不在：无需解绑
      if (isGroupDisbanded(existing.metadata as Record<string, unknown> | undefined)) {
        return { ok: true };
      }
      await this.store.update(id, {
        metadata: {
          ...((existing.metadata ?? {}) as Record<string, unknown>),
          [GROUP_LINK_METADATA_KEYS.groupDisbandedAt]: new Date().toISOString(),
        },
      });
      logger.info(`[SessionComponent] detachGroupSession: ${id} 已标记解散`);
      return { ok: true };
    } catch (err) {
      logger.warn(`[SessionComponent] detachGroupSession(${id}) failed: ${String(err)}`);
      return { ok: false, reason: String(err) };
    }
  }

  // ============ Chat-Task Binding (Task #4023) ============

  /**
   * 飞书 chat_id → task_id 反向绑定缓存（LRU + TTL）
   *
   * 为什么不放 store 缓存里？
   * - 群消息事件频率高（每条消息都会查一次），避免每条消息都打 DB。
   * - binding 信息只关心 taskId，不关心整个 session 对象。
   * - TTL 60s 容忍 task 端被外部归档后残留的 stale 数据。
   */
  private chatBindingCache = new Map<
    string,
    { binding: ChatTaskBinding; cachedAt: number }
  >();
  private static readonly CHAT_BINDING_CACHE_TTL_MS = 60_000;
  private static readonly CHAT_BINDING_CACHE_MAX = 1000;

  /**
   * 同 chatId 的 upsert 串行化锁（Task #4023）。
   *
   * upsertChatTaskBinding 是"读-改-写"（先 getChatTaskBinding 再 create/update），
   * 同一 chatId 并发调用时两个请求都可能读到 null → 各自 create → 后写覆盖前写
   * （丢失 taskId / rebindCount）。这里用 per-chatId promise 链把同一 chatId 的
   * upsert 串行化，保证读到的 existing 是最新的。
   */
  private chatBindingLocks = new Map<string, Promise<unknown>>();

  /**
   * 在 chatId 维度串行执行 fn；不同 chatId 互不阻塞。
   */
  private runChatBindingExclusive<T>(
    chatId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev = this.chatBindingLocks.get(chatId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn());
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.chatBindingLocks.set(chatId, tail);
    void tail.then(() => {
      // 只有当本链仍是队尾时才清理，避免误删后来者的链
      if (this.chatBindingLocks.get(chatId) === tail) {
        this.chatBindingLocks.delete(chatId);
      }
    });
    return run;
  }

  /**
   * Upsert 飞书 chat_id → task_id 绑定
   *
   * - 首次：新建 session（id=chatId）并写入 larkChat 元数据
   * - 重复绑定同一 taskId：更新 status / boundAt
   * - 绑定不同 taskId：rebindCount++ 但不覆盖 taskId（防误覆盖丢失数据）
   * - rebind 路径会发 warn 日志，便于诊断
   *
   * @returns 最终写入的 ChatTaskBinding（包含 rebindCount）
   */
  @TracedAs("session.upsertChatTaskBinding", {
    recordParams: false,
    recordResult: false,
    log: true,
    // 把最终写入的绑定关键字段提到 span 顶层属性，便于 `debug trace` 验证
    // chatId→taskId 落库结果与状态迁移（creating/ready/failed）。
    resultFilter: (binding: ChatTaskBinding) => ({
      chatId: binding?.chatId ?? null,
      taskId: binding?.taskId ?? null,
      status: binding?.status ?? null,
      rebindCount: binding?.rebindCount ?? null,
    }),
  })
  async upsertChatTaskBinding(
    opts: UpsertChatTaskBindingOptions
  ): Promise<ChatTaskBinding> {
    // 1. 参数校验
    if (!opts.chatId || typeof opts.chatId !== "string") {
      throw new Error("upsertChatTaskBinding: chatId is required (non-empty string)");
    }
    if (
      typeof opts.taskId !== "number" ||
      !Number.isInteger(opts.taskId) ||
      opts.taskId <= 0
    ) {
      throw new Error(
        `upsertChatTaskBinding: taskId must be a positive integer, got ${JSON.stringify(opts.taskId)}`
      );
    }

    // 2. 同 chatId 串行化，消除 read-modify-write 的 TOCTOU 竞争。
    return this.runChatBindingExclusive(opts.chatId, () =>
      this.upsertChatTaskBindingLocked(opts)
    );
  }

  /**
   * upsertChatTaskBinding 的实际实现（调用方已持有 chatId 锁）。
   */
  private async upsertChatTaskBindingLocked(
    opts: UpsertChatTaskBindingOptions
  ): Promise<ChatTaskBinding> {
    const now = new Date().toISOString();
    const desiredStatus = opts.status ?? "ready";

    // 读已存在的 binding（如果有）
    const existing = await this.getChatTaskBinding(opts.chatId);
    let rebindCount = existing?.rebindCount ?? 0;
    let resolvedTaskId = opts.taskId;

    if (existing && existing.taskId !== opts.taskId) {
      // 不同 taskId：rebind 计数 +1，**不覆盖** taskId（防数据丢失）
      rebindCount += 1;
      resolvedTaskId = existing.taskId;
      logger.warn(
        `[SessionComponent] upsertChatTaskBinding: rebind detected for chatId=${opts.chatId}: ` +
          `existing taskId=${existing.taskId}, requested taskId=${opts.taskId}; ` +
          `keeping existing. rebindCount=${rebindCount}`
      );
    }

    // 3. 组装最终 binding
    const binding: ChatTaskBinding = {
      chatId: opts.chatId,
      taskId: resolvedTaskId,
      profile: opts.profile,
      boundAt: now,
      status: desiredStatus,
      errorMessage: opts.errorMessage ?? null,
      rebindCount,
    };

    // 4. 写 DB（存在则 update，否则 create）
    // 注意：底层 store.update 用 shallow merge ({...session.metadata, ...updates.metadata})，
    // 所以传 { metadata: { larkChat: binding } } 会同时把 messageCount 等其他字段一起覆盖成 undefined，
    // 不可用。我们需要合并现有 metadata 与新 larkChat 子树。
    const session = await this.get(opts.chatId);
    if (session) {
      const mergedMetadata: SessionMetadata = {
        ...(session.metadata ?? {}),
        larkChat: binding,
      };
      await this.update(opts.chatId, { metadata: mergedMetadata });
    } else {
      const newMetadata: SessionMetadata = {
        larkChat: binding,
      };
      await this.create({
        id: opts.chatId,
        title: `lark-chat:${opts.chatId}`,
        directory: ".",
        metadata: newMetadata,
      });
    }

    // 5. 更新缓存（立即生效，避免下次回源读到 stale）
    this.chatBindingCache.set(opts.chatId, {
      binding,
      cachedAt: Date.now(),
    });
    this.evictStaleChatBindingCache();

    logger.info(
      `[SessionComponent] upsertChatTaskBinding: chatId=${opts.chatId} → taskId=${resolvedTaskId} ` +
        `status=${binding.status} rebindCount=${rebindCount}`
    );

    return binding;
  }

  /**
   * 查询 chat_id → task_id 绑定
   *
   * @returns binding 对象；若不存在或 session 元数据不含 larkChat → 返回 null
   */
  @TracedAs("session.getChatTaskBinding", {
    recordParams: false,
    recordResult: false,
    log: false,
    // 读侧诊断：命中与否 + taskId/status，便于验证群消息是否能反查到绑定。
    resultFilter: (binding: ChatTaskBinding | null) => ({
      found: !!binding,
      taskId: binding?.taskId ?? null,
      status: binding?.status ?? null,
    }),
  })
  async getChatTaskBinding(chatId: string): Promise<ChatTaskBinding | null> {
    if (!chatId) return null;

    // 1. 缓存命中
    const cached = this.chatBindingCache.get(chatId);
    if (cached) {
      const age = Date.now() - cached.cachedAt;
      if (age < SessionComponent.CHAT_BINDING_CACHE_TTL_MS) {
        return cached.binding;
      }
      this.chatBindingCache.delete(chatId);
    }

    // 2. 回源 DB
    const session = await this.get(chatId);
    if (!session) {
      return null;
    }
    const binding = session.metadata?.larkChat;
    if (!binding || typeof binding !== "object") {
      return null;
    }

    // 3. 回填缓存
    this.chatBindingCache.set(chatId, {
      binding,
      cachedAt: Date.now(),
    });
    this.evictStaleChatBindingCache();

    return binding;
  }

  /**
   * 清理过期/超容的 chat binding 缓存
   */
  private evictStaleChatBindingCache(): void {
    if (this.chatBindingCache.size <= SessionComponent.CHAT_BINDING_CACHE_MAX) return;
    const now = Date.now();
    for (const [k, v] of this.chatBindingCache) {
      if (now - v.cachedAt >= SessionComponent.CHAT_BINDING_CACHE_TTL_MS) {
        this.chatBindingCache.delete(k);
      }
    }
    // 如果清理后仍超容，删最旧一半（FIFO）
    while (this.chatBindingCache.size > SessionComponent.CHAT_BINDING_CACHE_MAX) {
      const firstKey = this.chatBindingCache.keys().next().value;
      if (!firstKey) break;
      this.chatBindingCache.delete(firstKey);
    }
  }

  // ============ Active Session ============

  /**
   * Get the current active session
   */
  getActiveSession(): Session | undefined {
    if (!this.activeSessionId) return undefined;
    // Synchronous getter, so we need to handle this carefully
    // In a real implementation, we'd cache the active session
    return undefined; // Will be populated by callers who need it
  }

  /**
   * Get the active session ID
   */
  getActiveSessionId(): string | undefined {
    return this.activeSessionId;
  }

  /**
   * Set the active session
   */
  async setActiveSession(id: string): Promise<boolean> {
    const session = await this.store?.get(id);
    if (!session) return false;

    this.activeSessionId = id;
    logger.info(`[SessionComponent] Active session set: ${id}`);
    return true;
  }

  // ============ Messages ============

  /**
   * Add a message to a session.
   *
   * Layer 2 of sessions.db fix: wrap the store call in a 3-attempt retry
   * loop with exponential backoff (50ms, 100ms, 200ms). ONLY retries
   * `SQLITE_BUSY` / `database is locked` errors — any other failure
   * (validation, FK violation, etc.) bubbles up immediately on the
   * first attempt.
   *
   * Why 3 attempts × 50/100/200ms (~350ms total worst case):
   *  - The 2026-07-07 incident had 102 consecutive `database is locked`
   *    errors over 8 minutes (≈ 4.7s average spacing). A 5s busy_timeout
   *    (Layer 1) + 350ms retry window absorbs typical contention.
   *  - Going much higher would risk blocking the React event loop on
   *    a real deadlock (which retry can't fix anyway).
   */
  async addMessage(sessionId: string, message: AddMessageOptions): Promise<string | undefined> {
    // DEBUG: 记录添加消息的调用栈
    const contentPreview = typeof message.content === "string" 
      ? message.content.substring(0, 100) 
      : JSON.stringify(message.content).substring(0, 100);
    logger.info(`[SessionComponent.addMessage] sessionId=${sessionId}, role=${message.role}, content="${contentPreview}"`);

    return this.addMessageWithRetry(sessionId, message);
  }

  /**
   * Retry-wrapped addMessage. Exposed via the public `addMessage` entry
   * point; tests assert behavior through that public method.
   *
   * Behavior contract:
   *  - Success → returns the new message id
   *  - Non-busy error → logs and returns `undefined` (preserves the
   *    pre-retry behavior so callers that already handle `undefined`
   *    keep working)
   *  - Busy error, retries exhausted → throws
   *    `AddMessageLockExhaustedError` so the caller can distinguish
   *    "lock could not be obtained" from "validation failed" and log
   *    at the appropriate severity. (Pre-retry this distinction was
   *    hidden behind a uniform `undefined` return.)
   */
  private async addMessageWithRetry(
    sessionId: string,
    message: AddMessageOptions
  ): Promise<string | undefined> {
    const MAX_ATTEMPTS = SessionComponent.BACKOFFS_MS.length;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const messageId = await this.store?.addMessage(sessionId, message);
        if (attempt > 0) {
          logger.info(`[SessionComponent.addMessage] Recovered after ${attempt + 1} attempts: messageId=${messageId}`);
        } else {
          logger.info(`[SessionComponent.addMessage] Success: messageId=${messageId}`);
        }
        return messageId;
      } catch (error) {
        if (!isBusyError(error)) {
          // Non-busy error: surface immediately, no retry.
          logger.error(`[SessionComponent] Failed to add message (non-busy): ${error}`);
          return undefined;
        }

        const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
        if (isLastAttempt) {
          logger.error(
            `[SessionComponent] Failed to add message after ${MAX_ATTEMPTS} attempts (busy): ${error}`
          );
          throw new AddMessageLockExhaustedError(MAX_ATTEMPTS, error);
        }

        const backoffMs = SessionComponent.BACKOFFS_MS[attempt];
        logger.warn(
          `[SessionComponent] SQLITE_BUSY on attempt ${attempt + 1}/${MAX_ATTEMPTS}, retrying in ${backoffMs}ms: ${error}`
        );
        await sleep(backoffMs);
      }
    }

    // Unreachable — the loop returns on success or throws on final failure.
    return undefined;
  }

  /**
   * Layer 3 wiring: expose `addMessages` so agent-component (recordSessionMessages)
   * can write a batch in one transaction instead of N individual calls.
   *
   * Forwards to the store; if the store throws (e.g. FK violation), the
   * error propagates and the caller's existing try/catch handles it.
   * Retries at the batch level would mask real schema errors, so we
   * deliberately don't add retry here — the per-call `addMessage` retry
   * already covers the contention case.
   */
  async addMessages(
    sessionId: string,
    messages: AddMessageOptions[]
  ): Promise<string[]> {
    if (!this.store) return [];
    if (messages.length === 0) return [];
    return this.store.addMessages(sessionId, messages) ?? [];
  }

  /**
   * Get messages from a session
   */
  async getMessages(sessionId: string, options?: { offset?: number; limit?: number }): Promise<SessionMessage[]> {
    const messages = await this.store?.getMessages(
      sessionId,
      options?.offset,
      options?.limit
    );
    return messages ?? [];
  }

  /**
   * Update an existing message in a session
   */
  async updateMessage(
    sessionId: string,
    messageId: string,
    updates: { metadata?: Record<string, unknown>; parts?: unknown[]; content?: string }
  ): Promise<boolean> {
    try {
      return (await this.store?.updateMessage(sessionId, messageId, updates)) ?? false;
    } catch (error) {
      logger.error(`[SessionComponent] Failed to update message: ${error}`);
      return false;
    }
  }

  /**
   * Get message count for a session
   */
  async getMessageCount(sessionId: string, includeArchived?: boolean): Promise<number> {
    return this.store?.getMessageCount(sessionId, includeArchived) ?? 0;
  }

  /**
   * Get indexes of all messages with the specified role
   * @param sessionId - Session ID
   * @param role - Role to filter by (e.g., "user", "assistant")
   * @returns Array of message indexes (0-indexed, in chronological order)
   */
  async getMessageIndexes(sessionId: string, role: string): Promise<number[]> {
    return this.store?.getMessageIndexes(sessionId, role) ?? [];
  }

  // ============ Hooks ============

  private async executeBeforeHooks(
    operation: string,
    context: Record<string, unknown>
  ): Promise<void> {
    // operation is like "create", so key should be "before.session.create"
    const hookKey = `before.session.${operation}` as keyof SessionComponentHooks;
    const hooks = this.hooksConfig[hookKey] ?? [];
    const hookContext = context as unknown as SessionHookContext;
    
    // Execute registered hooks first
    for (const hook of hooks) {
      if (hook.before) {
        await hook.before(hookContext);
      }
    }

    // Also execute from hooks config if passed in options
    const options = context.options as CreateSessionOptions | undefined;
    if (options?.hooks) {
      // options.hooks has keys like "before.session.create"
      const hookArray = (options.hooks as Record<string, unknown>)[hookKey] as SessionComponentHooks[typeof hookKey] ?? [];
      for (const hook of hookArray) {
        if (hook.before) {
          await hook.before(hookContext);
        }
      }
    }
  }

  private async executeAfterHooks(
    operation: string,
    context: Record<string, unknown>
  ): Promise<void> {
    const hookKey = `after.session.${operation}` as keyof SessionComponentHooks;
    const hooks = this.hooksConfig[hookKey] ?? [];
    const hookContext = context as unknown as SessionHookContext;
    
    // Execute registered hooks first
    for (const hook of hooks) {
      if (hook.after) {
        await hook.after(hookContext);
      }
    }

    // Also execute from hooks config if passed in options
    const options = context.options as CreateSessionOptions | undefined;
    if (options?.hooks) {
      // options.hooks has keys like "after.session.create"
      const hookArray = (options.hooks as Record<string, unknown>)[hookKey] as SessionComponentHooks[typeof hookKey] ?? [];
      for (const hook of hookArray) {
        if (hook.after) {
          await hook.after(hookContext);
        }
      }
    }
  }

  // ============ Helper Methods ============

  private generateTitle(): string {
    const template = this.config?.defaultTitleTemplate ?? "Session - {date}";
    const date = new Date().toISOString().replace("T", " ").substring(0, 19);
    return template.replace("{date}", date);
  }

  // ============ Checkpoint Management [new] ============

  /**
   * 读取压缩专用模型（`session.compactModel`）。
   *
   * ★ Task #4933：两阶段压缩（compact-hint / compact）统一走该模型。
   *   实现方式：读配置后作为 `AgentContext.model`（run option）传入，
   *   run option 在 agent-component.ts:1518
   *   `model: (context?.model) ?? agent.config.model` 处优先级最高，
   *   因此**会覆盖**用户级 `~/.local/share/roy-bot/agents/compact.yaml`
   *   里写死的 model 字段。
   *
   * @returns 模型 id（如 `minimax/MiniMax-M3.1-Flash`），未配置返回 undefined
   */
  private getCompactModel(): string | undefined {
    const model = this.configComponent?.get("session.compactModel");
    return typeof model === "string" && model.trim() ? model.trim() : undefined;
  }

  /**
   * 生成场景化压缩提示 (Compact Hint)
   * 
   * 两阶段自动压缩的第一阶段：使用内置 compact-hint agent 分析
   * 父 session 历史，生成场景化的压缩提示。
   * 
   * compact-hint agent 通过 filterHistory=false 自动读取父 session 的
   * 对话历史，LLM 服务端可缓存 system prompt。
   * 
   * @param sessionId 会话 ID
   * @returns 生成的场景化提示
   */
  @TracedAs("session.generateCompactHint")
  async generateCompactHint(sessionId: string): Promise<string> {
    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 获取消息数量（用于快速检查）
    const latestCheckpoint = this.getLatestCheckpoint(session);
    const startIndex = latestCheckpoint?.messageIndex ?? 0;
    const MAX_SAFE_MESSAGES = Number.MAX_SAFE_INTEGER;
    const messages = await this.store!.getMessages(
      sessionId,
      startIndex,
      MAX_SAFE_MESSAGES,
      { includeArchived: false }
    );

    if (messages.length < 3) {
      logger.warn("[SessionComponent] Not enough messages for hint generation");
      return "";
    }

    // 使用 compact-hint agent 生成提示
    // ★ C 方案（Task #4933 重写）：无工具、无 schema，
    //   agent 直接以纯文本回复 hint 正文。
    const agentComponent = this.env.getComponent("agent") as any;

    const hintRun = await agentComponent.run(
      "compact-hint",
      "Analyze this conversation and generate a compact guidance prompt for checkpoint generation.",
      {
        sessionId,
        persistSession: false,
        // ★ Task #4933：压缩专用模型（run option 覆盖 agent yaml 的 model）
        model: this.getCompactModel(),
      }
    );

    // ★ 2026-10-16（独立 review P1-1）：phase1 失败时**不要**再返回
    //   "[Hint extraction failed]" 哨兵 —— 它非空，会被 compact() 当有效内容接受，
    //   从而绕过「全空则拒绝归档」的守护。返回空串，让调用方走真正的降级/拒绝路径。
    const hint = normalizeCheckpointContent(hintRun?.finalText) ?? "";
    if (!hint) {
      logger.warn(
        "[SessionComponent] Compact hint unavailable (no usable finalText) — returning empty hint",
        { sessionId }
      );
    }

    logger.info("[SessionComponent] Compact hint generated", {
      sessionId,
      hintLength: hint.length,
    });

    return hint;
  }

  /**
   * Compact a session
   * 
   * 1. Get messages from latest checkpoint to current
   * 2. Call Summary Agent to generate checkpoint
   * 3. Save checkpoint and archive messages
   * 
   * 支持 scenarioHint 参数，用于指导不同场景下的压缩重点提取
   */
  @TracedAs("session.compact", { recordParams: true, recordResult: true })
  async compact(sessionId: string, options?: CompactOptions): Promise<CompactResult> {
    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 1. Determine start position
    const latestCheckpoint = this.getLatestCheckpoint(session);
    const startIndex = latestCheckpoint?.messageIndex ?? 0;

    // 2. Get messages to compact
    // Use MAX_SAFE_INTEGER to ensure we get ALL messages (default limit=50 can cause issues)
    const MAX_SAFE_MESSAGES = Number.MAX_SAFE_INTEGER;
    const messages = await this.store!.getMessages(
      sessionId, 
      startIndex, 
      MAX_SAFE_MESSAGES, 
      { includeArchived: false }
    );
    
    if (messages.length < 3) {
      throw new Error("Not enough messages to compact (minimum 3 required)");
    }

    // 3. Extract recent messages for checkpoint context
    // We need the last 2 turns of user query + assistant text response (no tool calls/results)
    const recentMessages = this.extractRecentMessages(messages, 2);

    // 4. Execute before hooks
    await this.executeBeforeHooks("compact", { session, options });

    // 5. 使用内置 compact agent 生成 checkpoint
    //    ★ C 方案（Task #4933 重写）：无工具、无 schema、无固定小节。
    //      agent 直接输出整段自然语言 checkpoint 正文；
    //      phase1 的 hint 作为场景提示注入 query（失败不阻塞）。
    let checkpointText: { title: string; content: string };
    try {
      // hint 注入：作为场景提示传给 compact agent（Phase1 失败时为空串）
      const userQuery = options?.scenarioHint
        ? [
            "Generate a checkpoint from this conversation.",
            "",
            "Scenario hint (focus points from phase 1):",
            options.scenarioHint,
          ].join("\n")
        : "Generate a checkpoint from this conversation.";

      const agentComponent = this.env.getComponent("agent") as any;
      const runResult = await agentComponent.run("compact", userQuery, {
        sessionId,
        persistSession: false,
        // ★ Task #4933：压缩专用模型（run option 覆盖 agent yaml 的 model）
        model: this.getCompactModel(),
      });

      // 降级链：finalText → scenarioHint（compact-hint 产出的会话摘要）
      // normalizeCheckpointContent 守护：非空、非降级哨兵、长度 ≥ 20
      const fromText = buildCheckpointFromText(runResult?.finalText);
      const fromHint = fromText
        ? undefined
        : buildCheckpointFromText(options?.scenarioHint);
      const built = fromText ?? fromHint;

      if (!built) {
        // ★ 2026-10-16：完全没有可用内容时**拒绝归档**。
        //
        // 旧行为：写一个空 checkpoint（"Untitled Checkpoint"）然后照样 archiveMessages
        // —— 生产实测 9 次空 checkpoint / 累计吞掉 4731 条消息 / 单次最多 2710 条
        // （2026-10-14，session oc_xxxxxxxxxxxxxxxx），上下文永久丢失且用户无感知。
        //
        // 现在抛错：compactSessionWithTwoPhases 会捕获并返回 { success:false }，
        // handle_query 随即抛出原始 ContextError（"Context threshold exceeded"），
        // 既不归档、用户也能看到明确失败，而不是静默丢历史。
        //
        // 可达性：phase1（compact-hint）失败时 scenarioHint 为 ""，因此本分支**可被触达**。
        throw new Error(
          `compact agent returned no usable checkpoint output ` +
          `(no usable finalText or scenarioHint); ` +
          `refusing to archive ${messages.length} messages for session ${sessionId}`
        );
      }

      if (fromText) {
        logger.info("[SessionComponent] compact agent produced natural-language checkpoint", {
          sessionId,
          contentLength: built.content.length,
        });
      } else {
        logger.warn(
          `[SessionComponent] compact agent produced no usable text; ` +
          `falling back to scenarioHint for the checkpoint (session=${sessionId})`
        );
      }
      checkpointText = built;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[SessionComponent] Compact agent failed: ${errorMessage}`);
      throw new Error(`Session compaction failed: ${errorMessage}`);
    }

    // 6. Generate checkpoint ID
    const checkpointId = `cp_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

    // 7. Create checkpoint object (include recentMessages for fresh history context)
    //    ★ C 方案：正文是整段自然语言 content，不再有五栏位
    const checkpoint: SessionCheckpoint = {
      id: checkpointId,
      messageIndex: startIndex,
      title: checkpointText.title,
      content: checkpointText.content,
      messageCountBefore: messages.length,
      createdAt: Date.now(),
      type: "compact",
      recentMessages,  // Preserve recent messages for context
    };

    // 8. Save checkpoint
    await this.store!.saveCheckpoint(sessionId, checkpoint);

    // 9. Create and add checkpoint message (BEFORE archiving, so it remains active)
    const checkpointMessage = this.createCheckpointMessage(checkpoint);
    await this.store!.addMessage(sessionId, checkpointMessage);

    // 10. Archive messages (after adding checkpoint message)
    await this.store!.archiveMessages(sessionId, checkpointId, messages.length);

    // 11. Update session
    const updatedSession = await this.get(sessionId);
    const remainingMessageCount = updatedSession?.messageCount ?? 0;
    const checkpointCount = updatedSession?.metadata?.checkpoints?.checkpoints?.length ?? 0;

    logger.info(`[SessionComponent] Compacted session: ${sessionId}`, {
      checkpointId,
      archivedCount: messages.length,
      remainingCount: remainingMessageCount,
      hasScenarioHint: !!options?.scenarioHint,
      recentMessagesCount: recentMessages.length,
    });

    // 13. Execute after hooks
    await this.executeAfterHooks("compact", { session, checkpoint, options });

    return {
      checkpoint,
      deletedMessageCount: messages.length,
      remainingMessageCount,
      checkpointCount,
    };
  }

  /**
   * Extract recent messages from the conversation for checkpoint context
   * 
   * Extracts the last N turns of user query + assistant text response,
   * excluding tool calls and tool results.
   * 
   * @param messages - All messages in the conversation
   * @param turnCount - Number of turns to extract (default: 2)
   * @returns Array of recent messages formatted as { role, content }
   */
  /**
   * 提取最近的若干「用户 → 助手纯文本」轮次，写入 `checkpoint.recentMessages`。
   *
   * ⚠️ 用途澄清（2026-10-16 独立 review P2-2 更正）：
   *   `recentMessages` **不会进入 LLM 上下文**。全仓非测试引用只有
   *   `packages/cli/src/commands/sessions/compact.ts`（CLI 展示 checkpoint），
   *   `createCheckpointMessage()` 也不渲染它。所以它**不是**「压缩后保住最近上下文」
   *   的安全网 —— 此前 commit 里那种说法是过度声称，已更正。
   *   它的价值限于 CLI `sessions compact` 预览 / 审计可读性。
   *
   * ★ 仍然值得修的部分（2026-10-16）：
   *   原实现只接受「assistant 消息**没有任何 tool-call/tool-result part** 且 content 非空」。
   *   但真实 agentic 会话里 assistant 几乎总带 tool part（最后一条正文往往为空），
   *   于是它在生产里**几乎永远返回 []** —— 三条事故 trace 的
   *   `checkpoint.recentMessages` 全是空数组，CLI 里这个字段等于没有。
   *
   *   现在：优先取干净的纯文本轮次（信息密度最高），一轮都没取到时兜底保留最近
   *   若干条原始消息（含 tool 轮次），至少让 CLI 能看到「刚才在干什么」。
   */
  /**
   * ★ 2026-10-22：**只存摘要**（Task #4479）。改造前平均 878KB（最大 12.8MB）
   * —— 入参是完整 messages 数组，返回值是抽出来的消息正文。
   */
  @TracedAs("session.extractRecentMessages", {
    paramFilter: messagesParamFilter,
    recordResult: false,
    logResult: true,
  })
  private extractRecentMessages(
    messages: SessionMessage[], 
    turnCount: number = 2
  ): { role: string; content: string }[] {
    const recentMessages: { role: string; content: string }[] = [];
    let turnsExtracted = 0;
    
    // Iterate from the most recent messages backwards
    // We need to find user + assistant pairs
    let i = messages.length - 1;
    
    while (i >= 0 && turnsExtracted < turnCount) {
      const msg = messages[i];
      
      // Skip checkpoint messages
      if (msg.metadata?.isCheckpoint) {
        i--;
        continue;
      }
      
      // Check if this is a text response (no tool calls/results)
      const hasToolParts = msg.parts?.some(
        p => p.type === 'tool-call' || p.type === 'tool-result'
      );
      
      if (msg.role === 'assistant' && !hasToolParts && msg.content.trim()) {
        // Found an assistant text response
        recentMessages.unshift({
          role: 'assistant',
          content: msg.content,
        });
        
        // Look for the preceding user message
        let j = i - 1;
        while (j >= 0) {
          const prevMsg = messages[j];
          if (prevMsg.metadata?.isCheckpoint) {
            j--;
            continue;
          }
          
          if (prevMsg.role === 'user') {
            recentMessages.unshift({
              role: 'user',
              content: prevMsg.content,
            });
            turnsExtracted++;
            break;
          }
          j--;
        }
        
        i = j;
      } else {
        i--;
      }
    }

    // ★ 兜底：一轮干净文本都没找到（典型 agentic 会话）→ 保留最近 N 条原始消息。
    //   不返回 [] —— 空数组意味着压缩后新上下文完全丢失「最近在干什么」。
    if (recentMessages.length === 0) {
      const FALLBACK_MESSAGE_LIMIT = 6;
      const tail = messages
        .filter((m) => !m.metadata?.isCheckpoint)
        .slice(-FALLBACK_MESSAGE_LIMIT)
        .filter((m) => typeof m.content === "string" && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));

      logger.debug("[SessionComponent] extractRecentMessages fell back to raw tail", {
        turnCount,
        fallbackMessages: tail.length,
      });

      return tail;
    }
    
    logger.debug("[SessionComponent] Extracted recent messages", {
      turnCount,
      messagesExtracted: recentMessages.length,
    });
    
    return recentMessages;
  }

  /**
   * Preview compact operation
   */
  async previewCompact(sessionId: string): Promise<CompactPreview> {
    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const latestCheckpoint = this.getLatestCheckpoint(session);
    const startIndex = latestCheckpoint?.messageIndex ?? 0;
    // Use MAX_SAFE_INTEGER to ensure we get ALL messages (default limit=50 can cause issues)
    const MAX_SAFE_MESSAGES = Number.MAX_SAFE_INTEGER;
    const messages = await this.store!.getMessages(sessionId, startIndex, MAX_SAFE_MESSAGES, { includeArchived: false });

    // Rough estimate: ~4 tokens per character
    const estimatedTokens = messages.reduce((sum, m) => sum + m.content.length * 0.25, 0);

    return {
      messageCountToCompact: messages.length,
      estimatedCheckpointTokens: Math.round(estimatedTokens * 0.1), // Checkpoint is ~10% of original
      wouldTrigger: messages.length >= (this.config?.maxMessages ?? 50),
    };
  }

  /**
   * Get all checkpoints for a session
   *
   * ★ C 方案：旧格式（五栏位）读时适配为新格式（content），
   *   不写回数据库（lazy adapter）。
   */
  async getCheckpoints(sessionId: string): Promise<SessionCheckpoint[]> {
    const checkpoints = await this.store!.getCheckpoints(sessionId);
    return checkpoints.map((cp) => adaptLegacyCheckpoint(cp));
  }

  /**
   * Get a specific checkpoint
   *
   * ★ C 方案：旧格式读时适配（见 getCheckpoints）。
   */
  async getCheckpoint(sessionId: string, checkpointId: string): Promise<SessionCheckpoint | undefined> {
    const cp = await this.store!.getCheckpoint(sessionId, checkpointId);
    return cp ? adaptLegacyCheckpoint(cp) : undefined;
  }

  /**
   * 读取 checkpoint 的**原始存储形态**（不做适配）。
   *
   * 用途：存量 checkpoint 检查脚本 / adaptStoredCheckpoints 内部统计 ——
   * 需要区分「库里到底存的是旧格式还是新格式」。
   */
  async readStoredCheckpointsRaw(sessionId: string): Promise<SessionCheckpoint[]> {
    return await this.store!.getCheckpoints(sessionId);
  }

  /**
   * 存量 checkpoint 适配（C 方案 Task #4933）。
   *
   * 生产库有 555 个旧格式 checkpoint（五栏位，无 content）。默认**读时适配**
   * 已能让新代码无感知；本方法提供**显式迁移**能力（把旧格式写回新格式）。
   *
   * ⚠️ 默认 dry-run（`apply: false`）：只统计 + 抽样，不写数据库。
   * ⚠️ `apply: true` 会重写 session.metadata —— 如果 roy-bot daemon 正在运行
   *    并持有 sessions.db 的内存缓存，外部进程的写入可能被 daemon 的后续
   *    saveCheckpoint 覆盖。建议在 daemon 重启后（或停机时）执行。
   */
  async adaptStoredCheckpoints(
    sessionId: string,
    options?: { apply?: boolean }
  ): Promise<CheckpointAdaptReport> {
    const apply = options?.apply === true;
    const raw = await this.store!.getCheckpoints(sessionId);

    const report: CheckpointAdaptReport = {
      sessionId,
      total: raw.length,
      legacy: 0,
      modern: 0,
      applied: 0,
      samples: [],
    };

    const adapted: SessionCheckpoint[] = [];
    for (const cp of raw) {
      const o = cp as unknown as Record<string, unknown>;
      const hasContent = typeof o.content === "string" && (o.content as string).trim().length > 0;
      if (hasContent) {
        report.modern++;
        adapted.push(cp);
        continue;
      }
      report.legacy++;
      const fixed = adaptLegacyCheckpoint(cp);
      adapted.push(fixed);
      if (report.samples.length < 3) {
        report.samples.push({
          id: cp.id,
          title: cp.title,
          contentLength: fixed.content.length,
          contentPreview: fixed.content.slice(0, 200),
        });
      }
    }

    if (apply && report.legacy > 0) {
      await this.writeCheckpointsBack(sessionId, adapted);
      report.applied = report.legacy;
    }

    logger.info("[SessionComponent] adaptStoredCheckpoints", {
      sessionId,
      total: report.total,
      legacy: report.legacy,
      modern: report.modern,
      applied: report.applied,
      dryRun: !apply,
    });

    return report;
  }

  /**
   * 把一组 checkpoint 整体写回 session.metadata.checkpointDetails。
   *
   * 只做「按 id 覆盖」，不动 checkpoints 索引里的 meta（id/title/createdAt 不变）。
   */
  private async writeCheckpointsBack(
    sessionId: string,
    checkpoints: SessionCheckpoint[]
  ): Promise<void> {
    const store = this.store as unknown as {
      replaceCheckpointDetails?: (
        sessionId: string,
        checkpoints: SessionCheckpoint[]
      ) => Promise<void>;
    };
    if (typeof store.replaceCheckpointDetails !== "function") {
      throw new Error(
        "adaptStoredCheckpoints: current store does not support replaceCheckpointDetails " +
        "(only SQLiteSessionStore does); refusing to write partial data"
      );
    }
    await store.replaceCheckpointDetails(sessionId, checkpoints);
  }

  /**
   * Delete a checkpoint and restore archived messages
   */
  async deleteCheckpoint(sessionId: string, checkpointId: string): Promise<boolean> {
    await this.executeBeforeHooks("deleteCheckpoint", { sessionId, checkpointId });

    const success = await this.store!.deleteCheckpoint(sessionId, checkpointId);

    if (success) {
      logger.info(`[SessionComponent] Deleted checkpoint: ${checkpointId}`);
      await this.executeAfterHooks("deleteCheckpoint", { sessionId, checkpointId });
    }

    return success;
  }

  /**
   * Task #2539 — 终态联动释放 sub session 的内存占用（OOM 修复）。
   *
   * 触发场景：BackgroundTaskManager 检测到 sub session 终态（success / error /
   * cancel / timeout）后调用本方法。
   *
   * 行为：
   * - MemorySessionStore：按 checkpoint 对齐裁剪 messages + 保留最新 1 checkpoint（激进模式）
   *   或仅裁旧 checkpoint（保守模式 keepAllMessagesUntilCompaction=true）
   * - SQLiteSessionStore：no-op（SQLite 不受内存压力影响；保留完整历史便于审计）
   *
   * 幂等：重复调用结果稳定。
   * 不存在的 sessionId：no-op。
   */
  async endSessionCleanup(
    sessionId: string,
    opts?: {
      keepAllMessagesUntilCompaction?: boolean;
      keepLatestCheckpoints?: number;
    },
  ): Promise<void> {
    // 兜底：sqlite 不实现该方法（duck-type 检查）。MemorySessionStore 实现了。
    const store = this.store as any;
    if (typeof store?.endSessionCleanup === "function") {
      await store.endSessionCleanup(sessionId, opts);
    } else {
      logger.debug(
        `[SessionComponent] endSessionCleanup skipped: store type ${this.config?.storage?.type ?? "unknown"} 不实现该方法`,
      );
    }
  }

  /**
   * Get session context
   * 
   * Returns messages starting from the latest checkpoint by default
   */
  async getContext(sessionId: string, options?: GetContextOptions): Promise<GetContextResult> {
    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found`);
    }

    let contextMessages: SessionMessage[] = [];
    let startCheckpoint: SessionCheckpoint | undefined;

    if (options?.fullHistory) {
      // Get ALL messages including archived ones (for full history view)
      const MAX_SAFE_MESSAGES = Number.MAX_SAFE_INTEGER;
      contextMessages = await this.store!.getMessages(sessionId, 0, MAX_SAFE_MESSAGES, {
        includeArchived: true,
      });
    } else {
      // Optimization: Start from latest checkpoint instead of reading all messages
      // This avoids reading archived messages that have been compacted
      const latestCheckpointId = session.metadata?.checkpoints?.latestCheckpointId;
      
      if (latestCheckpointId) {
        // Get checkpoint details to find messageIndex
        // ★ C 方案（Task #4933 review MINOR-2）：必须走 SessionComponent.getCheckpoint()
        //   而非 store 直读 —— 否则旧格式存量 checkpoint 绕过 adaptLegacyCheckpoint，
        //   startCheckpoint.content 会是 undefined（违反必填 string 契约），且泄露旧五栏位。
        //   resume 正是靠 getContext().startCheckpoint 恢复上下文，这条路径必须适配。
        startCheckpoint = await this.getCheckpoint(sessionId, latestCheckpointId);
        if (startCheckpoint) {
          // Read messages from checkpoint position onwards
          const MAX_SAFE_MESSAGES = Number.MAX_SAFE_INTEGER;
          contextMessages = await this.store!.getMessages(
            sessionId,
            startCheckpoint.messageIndex,
            MAX_SAFE_MESSAGES,
            { includeArchived: false }
          );
        }
      }

      // If no checkpoint found, read from beginning (first session)
      if (contextMessages.length === 0) {
        const MAX_SAFE_MESSAGES = Number.MAX_SAFE_INTEGER;
        contextMessages = await this.store!.getMessages(sessionId, 0, MAX_SAFE_MESSAGES, {
          includeArchived: false,
        });
      }
    }

    // Ensure starting from user message boundary (avoids tool_call/tool_result mismatch)
    if (options?.minUserMessages && options.minUserMessages > 0) {
      const userIndexes: number[] = [];
      for (let i = 0; i < contextMessages.length; i++) {
        if (contextMessages[i].role === "user") {
          userIndexes.push(i);
        }
      }
      
      if (userIndexes.length > options.minUserMessages) {
        const targetIndex = userIndexes[userIndexes.length - options.minUserMessages];
        contextMessages = contextMessages.slice(targetIndex);
      }
    }

    // Apply message limit (after minUserMessages processing)
    if (options?.messageLimit) {
      contextMessages = contextMessages.slice(-options.messageLimit);
    }

    // Extract checkpoint info
    // ★ C 方案：旧格式读时适配（checkpointMeta 可能是旧五栏位形态）。
    //   防御：手工添加的 checkpoint 消息可能只有 isCheckpoint 而无 checkpointMeta。
    const checkpoints = contextMessages
      .filter((m) => m.metadata?.isCheckpoint && m.metadata?.checkpointMeta)
      .map((m) => adaptLegacyCheckpoint(m.metadata!.checkpointMeta as SessionCheckpoint));

    // Estimate tokens
    const estimatedTokens = contextMessages.reduce(
      (sum, m) => sum + m.content.length * 0.25,
      0
    );

    return {
      session,
      checkpoints,
      startCheckpoint: startCheckpoint ?? checkpoints[checkpoints.length - 1],
      messages: contextMessages,
      totalMessageCount: contextMessages.length,
      activeMessageCount: contextMessages.filter((m) => !m.isArchived).length,
      archivedMessageCount: contextMessages.filter((m) => m.isArchived).length,
      estimatedTokens: Math.round(estimatedTokens),
    };
  }

  /**
   * Check if session needs compaction
   */
  async shouldCompact(sessionId: string): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session) return false;

    const preview = await this.previewCompact(sessionId);
    return preview.wouldTrigger;
  }

  // ============ Search [new] ============

  /**
   * Search messages across sessions
   * 
   * Searches all messages matching the query, aggregated by session.
   * Supports SQLite FTS5 for fast full-text search.
   */
  async searchMessages(options: SearchMessagesOptions): Promise<SearchResult[]> {
    const {
      query,
      sessionId,
      limit = 10,
      maxResults = 100,
      beforeTime,
      afterTime,
      includeArchived = false,
      includeContext = false,
      contextLines = 2,
    } = options;

    // Delegate to store for actual search
    if (!this.store) {
      return [];
    }

    // Get all sessions or specific session
    let sessions: Session[];
    if (sessionId) {
      const session = await this.get(sessionId);
      sessions = session ? [session] : [];
    } else {
      sessions = await this.list({ limit: 1000 }); // Get all sessions
    }

    const results: SearchResult[] = [];
    let totalMatches = 0;

    for (const session of sessions) {
      // Check time constraints
      if (beforeTime && session.updatedAt > beforeTime) continue;
      if (afterTime && session.updatedAt < afterTime) continue;

      // Search messages in this session
      const messages = await this.store.getMessages(session.id, 0, 1000, { includeArchived });
      
      // Simple text search (case-insensitive, supports AND/OR/NOT)
      const queryTerms = parseSearchQuery(query);
      const matches: MessageMatch[] = [];

      for (const msg of messages) {
        // Time constraints
        if (beforeTime && msg.timestamp > beforeTime) continue;
        if (afterTime && msg.timestamp < afterTime) continue;

        // Check if message matches query
        if (matchesQuery(msg.content, queryTerms)) {
          const match: MessageMatch = {
            messageId: msg.id,
            sessionId: session.id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
          };

          // Add context if requested
          if (includeContext) {
            const msgIndex = messages.indexOf(msg);
            const beforeMsgs = messages.slice(Math.max(0, msgIndex - contextLines), msgIndex);
            const afterMsgs = messages.slice(msgIndex + 1, msgIndex + 1 + contextLines);
            
            match.contextBefore = beforeMsgs.map(m => m.content).join("\n");
            match.contextAfter = afterMsgs.map(m => m.content).join("\n");
          }

          matches.push(match);

          if (matches.length >= limit) break;
        }
      }

      if (matches.length > 0) {
        results.push({
          sessionId: session.id,
          sessionTitle: session.title,
          sessionDirectory: session.directory,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount,
          matches,
        });
        totalMatches += matches.length;

        if (totalMatches >= maxResults) break;
      }
    }

    return results;
  }

  // ============ Private Helper Methods [new] ============

  /**
   * Get latest checkpoint from session
   */
  private getLatestCheckpoint(session: Session): SessionCheckpoint | undefined {
    const latestId = session.metadata?.checkpoints?.latestCheckpointId;
    if (!latestId) return undefined;

    const raw = session.metadata?.checkpointDetails?.[latestId];
    // ★ C 方案：旧格式（五栏位）读时适配为新格式（content），不写回
    return raw ? adaptLegacyCheckpoint(raw) : undefined;
  }

  /**
   * Create checkpoint message (user role)
   * 
   * Generates a markdown-formatted checkpoint summary as a user message,
   * allowing it to appear in the message list and provide context for
   * subsequent LLM calls.
   */
  private createCheckpointMessage(checkpoint: SessionCheckpoint): AddMessageOptions {
    // ★ C 方案（Task #4933 重写）：正文 = # Checkpoint 标题 + 整段自然语言
    //   content + 归档统计。不再伪造五个小节标题。
    //   旧格式存量 checkpoint 由 adaptLegacyCheckpoint 读时合成 content。
    const content = createCheckpointContent(checkpoint);

    return {
      role: "user",
      content,
      parts: [{
        type: "checkpoint" as const,
        checkpointId: checkpoint.id,
        content,
        title: checkpoint.title,
        messageCountBefore: checkpoint.messageCountBefore,
        createdAt: checkpoint.createdAt,
      }],
      metadata: {
        isCheckpoint: true,
        checkpointId: checkpoint.id,
        checkpointMeta: checkpoint,
      },
    };
  }
}
