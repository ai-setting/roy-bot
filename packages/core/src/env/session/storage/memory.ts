/**
 * @fileoverview Memory Session Store
 * 
 * In-memory implementation of SessionStore with checkpoint support
 */

import type {
  Session,
  CreateSessionOptions,
  UpdateSessionOptions,
  ListSessionsOptions,
  SessionMessage,
  SessionCheckpoint,
  GetMessagesOptions,
  SessionCheckpointsMeta,
  SearchMessagesOptions,
  MessageMatch,
} from "../types";
import type { SessionStore } from "../session-store";
import { BaseSessionStore } from "../session-store";

import { SessionMessageConverter } from "../session-message-converter";
import { randomUUID } from "crypto";

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
 * Memory-based Session Store with checkpoint support
 */
export interface MemorySessionStoreOptions {
  /** Maximum retained messages per session; oldest messages are discarded. */
  maxMessagesPerSession?: number;
  /** Maximum retained checkpoints per session; oldest checkpoints are discarded. */
  maxCheckpointsPerSession?: number;
  /**
   * Task #2539 — 精细化裁剪开关。
   * 默认 true（向后兼容）：保留所有 message 直到 maxMessagesPerSession 触发。
   * 设为 false 后，saveCheckpoint / endSessionCleanup 会按 checkpoint 对齐裁剪
   * messages（保留「最新 checkpoint 之后」的消息，旧 checkpoint 之前的消息直接释放）；
   * 同时将 checkpoint 数组裁剪到仅保留最新 1 个（覆盖 maxCheckpointsPerSession）。
   */
  keepAllMessagesUntilCompaction?: boolean;
}

export interface MemorySessionStoreEndCleanupOptions {
  /**
   * Task #2539 — 终态清理时是否按 checkpoint 对齐裁剪 messages。
   * 不传则使用 store 的默认 keepAllMessagesUntilCompaction。
   */
  keepAllMessagesUntilCompaction?: boolean;
  /**
   * Task #2539 — 终态清理时保留多少个最新 checkpoint（默认 1）。
   * 设为 0 等同于 "完全丢弃所有 checkpoint"（不推荐，会丢失所有 checkpoint context）。
   */
  keepLatestCheckpoints?: number;
}

export class MemorySessionStore extends BaseSessionStore {
  private readonly maxMessagesPerSession: number;
  private readonly maxCheckpointsPerSession: number;
  /**
   * Task #2539 — 默认值缓存，避免每次 endSessionCleanup 都访问 options。
   */
  private readonly defaultKeepAllMessagesUntilCompaction: boolean;
  private sessions = new Map<string, Session>();
  private messages = new Map<string, SessionMessage[]>();
  private checkpoints = new Map<string, SessionCheckpoint[]>();
  private messageConverter = new SessionMessageConverter();

  constructor(options: MemorySessionStoreOptions = {}) {
    super();
    this.maxMessagesPerSession = options.maxMessagesPerSession ?? 10_000;
    this.maxCheckpointsPerSession = options.maxCheckpointsPerSession ?? 1_000;
    this.defaultKeepAllMessagesUntilCompaction =
      options.keepAllMessagesUntilCompaction ?? true;
  }

  private trimMessages(messages: SessionMessage[]): void {
    if (messages.length > this.maxMessagesPerSession) {
      messages.splice(0, messages.length - this.maxMessagesPerSession);
    }
  }

  // ========================================================================
  // Session CRUD
  // ========================================================================

  async create(options: CreateSessionOptions): Promise<Session> {
    const now = Date.now();
    // Resolve parentSessionId from new canonical field, falling back to
    // legacy parentID alias. Both end up as the same value on the Session.
    // Issue #6: normalize empty/whitespace strings to null so they don't leak
    // into the graph layout as a "real" parent reference.
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
      },
    };

    // Check for duplicate ID
    if (this.sessions.has(session.id)) {
      throw new Error(`Session with ID '${session.id}' already exists`);
    }

    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    this.checkpoints.set(session.id, []);

    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async list(options?: ListSessionsOptions): Promise<Session[]> {
    let sessions = Array.from(this.sessions.values());

    // Filter by metadata
    if (options?.filter?.metadata) {
      sessions = sessions.filter((s) => {
        for (const [key, value] of Object.entries(options.filter!.metadata!)) {
          if (s.metadata?.[key] !== value) return false;
        }
        return true;
      });
    }

    // Filter by time range
    if (options?.filter?.startTime) {
      sessions = sessions.filter((s) => s.createdAt >= options.filter!.startTime!);
    }
    if (options?.filter?.endTime) {
      sessions = sessions.filter((s) => s.createdAt <= options.filter!.endTime!);
    }


    // Sort
    const sortField = options?.sort?.field ?? "updatedAt";
    const sortOrder = options?.sort?.order ?? "desc";
    sessions.sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;

      if (sortField === "title") {
        aVal = a.title;
        bVal = b.title;
      } else if (sortField === "createdAt") {
        aVal = a.createdAt;
        bVal = b.createdAt;
      } else {
        aVal = a.updatedAt;
        bVal = b.updatedAt;
      }

      if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
      if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

    // Paginate
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;
    return sessions.slice(offset, offset + limit);
  }

  async update(id: string, updates: UpdateSessionOptions): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (updates.title !== undefined) {
      session.title = updates.title;
    }
    if (updates.metadata !== undefined) {
      session.metadata = { ...session.metadata, ...updates.metadata };
    }
    session.updatedAt = Date.now();

    return true;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.sessions.delete(id);
    if (deleted) {
      this.messages.delete(id);
      this.checkpoints.delete(id);
      this.messageTruncOffsets.delete(id);
    }
    return deleted;
  }

  async getCount(): Promise<number> {
    return this.sessions.size;
  }

  // ========================================================================
  // Messages
  // ========================================================================

  async addMessage(
    sessionId: string,
    message: { role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Create raw message
    const rawMessage: Partial<SessionMessage> = {
      sessionID: sessionId,
      role: message.role as SessionMessage["role"],
      content: message.content,
      parts: message.parts as SessionMessage["parts"],
      metadata: message.metadata as SessionMessage["metadata"],
    };

    // Apply migration to ensure new format (backward compatibility)
    const msg = this.messageConverter.migrateMessage(rawMessage);
    msg.id = generateMessageId();
    msg.timestamp = Date.now();

    const sessionMessages = this.messages.get(sessionId) ?? [];
    sessionMessages.push(msg);
    this.trimMessages(sessionMessages);
    this.messages.set(sessionId, sessionMessages);

    // Update message count (non-archived only)
    session.messageCount = sessionMessages.filter((m) => !m.isArchived).length;
    
    // Update metadata with messageCount
    session.metadata = {
      ...session.metadata,
      messageCount: session.messageCount
    };
    
    session.updatedAt = Date.now();

    return msg.id;
  }

  /**
   * Layer 3 (MemorySessionStore): batch version. Memory has no real
   * "transaction" — we just append all rows and update the count once.
   */
  async addMessages(
    sessionId: string,
    messages: Array<{ role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }>
  ): Promise<string[]> {
    if (messages.length === 0) {
      return [];
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const sessionMessages = this.messages.get(sessionId) ?? [];
    const ids: string[] = [];
    const now = Date.now();

    for (const message of messages) {
      const rawMessage: Partial<SessionMessage> = {
        sessionID: sessionId,
        role: message.role as SessionMessage["role"],
        content: message.content,
        parts: message.parts as SessionMessage["parts"],
        metadata: message.metadata as SessionMessage["metadata"],
      };
      const msg = this.messageConverter.migrateMessage(rawMessage);
      msg.id = generateMessageId();
      msg.timestamp = now;
      sessionMessages.push(msg);
      ids.push(msg.id);
    }

    this.trimMessages(sessionMessages);
    this.messages.set(sessionId, sessionMessages);

    // Update message count + metadata ONCE for the whole batch.
    session.messageCount = sessionMessages.filter((m) => !m.isArchived).length;
    session.metadata = {
      ...session.metadata,
      messageCount: session.messageCount,
    };
    session.updatedAt = now;

    return ids;
  }

  async updateMessage(
    sessionId: string,
    messageId: string,
    updates: { metadata?: Record<string, unknown>; parts?: unknown[]; content?: string }
  ): Promise<boolean> {
    const sessionMessages = this.messages.get(sessionId);
    if (!sessionMessages) {
      return false;
    }

    const index = sessionMessages.findIndex((m) => m.id === messageId);
    if (index < 0) {
      return false;
    }

    const current = sessionMessages[index];
    sessionMessages[index] = {
      ...current,
      ...(updates.content !== undefined ? { content: updates.content } : {}),
      ...(updates.metadata !== undefined
        ? { metadata: updates.metadata as SessionMessage['metadata'] }
        : {}),
      ...(updates.parts !== undefined
        ? { parts: updates.parts as SessionMessage['parts'] }
        : {}),
    };

    const session = this.sessions.get(sessionId);
    if (session) {
      session.updatedAt = Date.now();
    }

    return true;
  }

  async getMessages(
    sessionId: string,
    offset = 0,
    limit = 50,
    options?: GetMessagesOptions
  ): Promise<SessionMessage[]> {
    let messages = this.messages.get(sessionId) ?? [];

    // Handle archived messages
    if (!options?.includeArchived) {
      messages = messages.filter((m) => !m.isArchived);
    }

    // Handle fromCheckpointId
    if (options?.fromCheckpointId) {
      const checkpoint = await this.getCheckpoint(sessionId, options.fromCheckpointId);
      if (checkpoint) {
        const checkpointIndex = messages.findIndex(
          (m) => m.metadata?.checkpointId === options.fromCheckpointId
        );
        if (checkpointIndex >= 0) {
          messages = messages.slice(checkpointIndex);
        }
      }
    }

    // Handle negative offset: count total messages first, then calculate actual offset
    // offset = -1, limit = 50: latest 50 messages → offset = total - limit
    // offset = -2, limit = 50: 2nd latest 50 messages → offset = total - 2*limit
    let actualOffset = offset;
    if (offset < 0) {
      const total = messages.length;
      actualOffset = Math.max(0, total + offset * limit);
    }

    // Handle reverse
    if (options?.reverse) {
      messages = messages.reverse();
    }

    return messages.slice(actualOffset, actualOffset + limit);
  }

  async getMessageCount(sessionId: string, includeArchived = false): Promise<number> {
    const messages = this.messages.get(sessionId) ?? [];
    if (includeArchived) {
      return messages.length;
    }
    return messages.filter((m) => !m.isArchived).length;
  }

  async getMessageIndexes(sessionId: string, role: string): Promise<number[]> {
    const messages = this.messages.get(sessionId) ?? [];
    const indexes: number[] = [];
    
    // Return index based on timestamp ASC order (same as getMessages default)
    messages
      .filter(m => !m.isArchived)
      .forEach((msg, filteredIdx) => {
        if (msg.role === role) {
          indexes.push(filteredIdx);
        }
      });
    
    return indexes;
  }

  // ========================================================================
  // Checkpoint Management
  // ========================================================================

  async saveCheckpoint(sessionId: string, checkpoint: SessionCheckpoint): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Save to checkpoints map
    const cps = this.checkpoints.get(sessionId) ?? [];
    cps.push(checkpoint);

    // Task #2539 — checkpoint-aligned 裁剪逻辑：
    // 1) 始终按 maxCheckpointsPerSession 上限裁旧 checkpoint（保留最新 N）
    // 2) keepAllMessagesUntilCompaction=false 时激进：只保留最新 1 个 checkpoint，
    //    同时裁掉「最新 checkpoint 之前的 message」（已被 checkpoint 压缩）。
    let droppedCheckpoints: SessionCheckpoint[] = [];
    if (cps.length > this.maxCheckpointsPerSession) {
      droppedCheckpoints = cps.splice(0, cps.length - this.maxCheckpointsPerSession);
    }
    if (!this.defaultKeepAllMessagesUntilCompaction && cps.length > 1) {
      // 激进模式：保留最新 1 个（cps 已 push 过新 checkpoint → 末尾）
      droppedCheckpoints = droppedCheckpoints.concat(
        cps.splice(0, cps.length - 1),
      );
    }
    this.checkpoints.set(sessionId, cps);

    // Update session metadata
    const meta = session.metadata as Record<string, unknown> || {};
    const checkpointsMeta: SessionCheckpointsMeta = (meta.checkpoints as SessionCheckpointsMeta) || { checkpoints: [] };
    // 同步追加新 checkpoint
    checkpointsMeta.checkpoints.push({
      id: checkpoint.id,
      messageIndex: checkpoint.messageIndex,
      title: checkpoint.title,
      createdAt: checkpoint.createdAt,
      type: checkpoint.type,
    });
    // 从 metadata 中清理被丢弃的 checkpoint 引用
    if (droppedCheckpoints.length > 0) {
      const droppedIds = new Set(droppedCheckpoints.map((c) => c.id));
      checkpointsMeta.checkpoints = checkpointsMeta.checkpoints.filter(
        (c) => !droppedIds.has(c.id),
      );
      if (meta.checkpointDetails) {
        for (const id of droppedIds) {
          delete (meta.checkpointDetails as Record<string, SessionCheckpoint>)[id];
        }
      }
    }
    checkpointsMeta.latestCheckpointId = cps[cps.length - 1]?.id ?? checkpoint.id;
    meta.checkpoints = checkpointsMeta;

    // Store checkpoint details separately
    if (!meta.checkpointDetails) {
      meta.checkpointDetails = {};
    }
    (meta.checkpointDetails as Record<string, SessionCheckpoint>)[checkpoint.id] = checkpoint;

    session.metadata = meta as Session["metadata"];

    // 激进模式：裁掉「最新 checkpoint 之前」的 message（messageIndex 之前的消息已被压缩）
    if (!this.defaultKeepAllMessagesUntilCompaction && cps.length > 0) {
      const latest = cps[cps.length - 1];
      this.truncateMessagesBeforeIndex(sessionId, latest.messageIndex);
      // message count / metadata 同步
      const sessionMessages = this.messages.get(sessionId) ?? [];
      session.messageCount = sessionMessages.filter((m) => !m.isArchived).length;
      session.metadata = {
        ...session.metadata,
        messageCount: session.messageCount,
      };
    }

    session.updatedAt = Date.now();
  }

  /**
   * Task #2539 — 累积裁剪偏移量（per-session）。
   * checkpoint 的 messageIndex 是相对「初始 push 顺序」的索引；当 messages 被多次裁剪后，
   * 后续的 checkpoint 仍以原始 messageIndex 调用 truncateMessagesBeforeIndex。
   * 用 truncOffsets 把原始索引换算到当前数组中的位置，裁完后更新偏移 + 同步 cps messageIndex。
   */
  private readonly messageTruncOffsets = new Map<string, number>();

  /**
   * Task #2539 — 裁掉「原始位置 < originalBeforeIndex」的 message（保留之后所有 message）。
   * 与 archiveMessages 不同：archiveMessages 只置 isArchived 标记；本方法直接 splice 释放对象。
   * originalBeforeIndex 是相对于「该 session 初始 message 顺序」的索引（与 checkpoint.messageIndex 同语义）。
   * 多次调用累加裁剪（不会重复裁已被裁掉的部分）。
   */
  private truncateMessagesBeforeIndex(sessionId: string, originalBeforeIndex: number): void {
    const sessionMessages = this.messages.get(sessionId);
    if (!sessionMessages || sessionMessages.length === 0) return;
    const offset = this.messageTruncOffsets.get(sessionId) ?? 0;
    // 换算到当前数组中的位置
    const adjustedIndex = originalBeforeIndex - offset;
    if (adjustedIndex <= 0) {
      // 已被之前的裁剪消化掉，no-op（幂等）
      return;
    }
    if (adjustedIndex >= sessionMessages.length) {
      // 越界：原始 beforeIndex 超出实际 message 数（理论上不会发生，因为消息只增不减；
      // 保守起见保留全部）
      return;
    }
    sessionMessages.splice(0, adjustedIndex);
    this.messageTruncOffsets.set(sessionId, offset + adjustedIndex);
    this.messages.set(sessionId, sessionMessages);

    // 同步调整剩余 cps 的 messageIndex（保持 checkpoint 语义：相对「初始 push 顺序」）
    const cps = this.checkpoints.get(sessionId);
    if (cps) {
      for (const cp of cps) {
        cp.messageIndex = Math.max(0, cp.messageIndex - adjustedIndex);
      }
    }
    // 同步调整 metadata.checkpoints 列表与 checkpointDetails
    const session = this.sessions.get(sessionId);
    if (session) {
      const meta = session.metadata as Record<string, unknown> | undefined;
      if (meta) {
        const checkpointsMeta = meta.checkpoints as
          | SessionCheckpointsMeta
          | undefined;
        if (checkpointsMeta?.checkpoints) {
          for (const cm of checkpointsMeta.checkpoints) {
            cm.messageIndex = Math.max(0, cm.messageIndex - adjustedIndex);
          }
        }
        if (meta.checkpointDetails) {
          const details = meta.checkpointDetails as Record<
            string,
            SessionCheckpoint
          >;
          for (const id in details) {
            details[id].messageIndex = Math.max(
              0,
              details[id].messageIndex - adjustedIndex,
            );
          }
        }
      }
    }
  }

  /**
   * Task #2539 — sub session 终态（success / error / cancel / timeout）触发时调用。
   * 默认保留最近 1 个 checkpoint + 其后消息；其它 checkpoint 及其前 message 全部释放。
   *
   * 设计目标（避免纯 splice 硬截断）：
   * - keepAllMessagesUntilCompaction=true（默认）→ 保留所有 message，裁旧 checkpoint 至 maxCheckpointsPerSession
   * - keepAllMessagesUntilCompaction=false → 仅保留最新 1 个 checkpoint + 其后 message
   * - keepLatestCheckpoints 控制保留多少个最新 checkpoint（默认 1）
   *
   * 幂等：重复调用 endSessionCleanup(sessionId) 结果稳定。
   * 不存在的 sessionId：no-op，不报错。
   */
  async endSessionCleanup(
    sessionId: string,
    opts: MemorySessionStoreEndCleanupOptions = {},
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return; // 不存在的 sessionId：幂等 no-op
    }
    const keepAllMessages = opts.keepAllMessagesUntilCompaction ?? this.defaultKeepAllMessagesUntilCompaction;
    const keepLatest = Math.max(0, opts.keepLatestCheckpoints ?? 1);

    // 1) 裁 checkpoint 至 keepLatest（激进模式下硬约束）
    const cps = this.checkpoints.get(sessionId) ?? [];
    let droppedCheckpoints: SessionCheckpoint[] = [];
    const targetCheckpointCap = keepAllMessages
      ? this.maxCheckpointsPerSession
      : keepLatest;
    if (cps.length > targetCheckpointCap) {
      droppedCheckpoints = cps.splice(0, cps.length - targetCheckpointCap);
    }
    this.checkpoints.set(sessionId, cps);

    // 清理 metadata 中被丢弃 checkpoint 的引用
    if (droppedCheckpoints.length > 0) {
      const meta = session.metadata as Record<string, unknown>;
      const droppedIds = new Set(droppedCheckpoints.map((c) => c.id));
      const checkpointsMeta = (meta.checkpoints as SessionCheckpointsMeta | undefined) ?? {
        checkpoints: [],
      };
      checkpointsMeta.checkpoints = checkpointsMeta.checkpoints.filter(
        (c) => !droppedIds.has(c.id),
      );
      checkpointsMeta.latestCheckpointId = cps[cps.length - 1]?.id;
      meta.checkpoints = checkpointsMeta;
      if (meta.checkpointDetails) {
        for (const id of droppedIds) {
          delete (meta.checkpointDetails as Record<string, SessionCheckpoint>)[id];
        }
      }
      session.metadata = meta as Session["metadata"];
    }

    // 2) 激进模式：裁掉「最新 checkpoint 之前」的 message
    if (!keepAllMessages && cps.length > 0) {
      const latest = cps[cps.length - 1];
      this.truncateMessagesBeforeIndex(sessionId, latest.messageIndex);
      const sessionMessages = this.messages.get(sessionId) ?? [];
      session.messageCount = sessionMessages.filter((m) => !m.isArchived).length;
      session.metadata = {
        ...session.metadata,
        messageCount: session.messageCount,
      };
    }

    session.updatedAt = Date.now();
  }

  async getCheckpoints(sessionId: string): Promise<SessionCheckpoint[]> {
    return this.checkpoints.get(sessionId) ?? [];
  }

  async getCheckpoint(sessionId: string, checkpointId: string): Promise<SessionCheckpoint | undefined> {
    const cps = this.checkpoints.get(sessionId) ?? [];
    return cps.find((cp) => cp.id === checkpointId);
  }

  async deleteCheckpoint(sessionId: string, checkpointId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const cps = this.checkpoints.get(sessionId) ?? [];
    const index = cps.findIndex((cp) => cp.id === checkpointId);
    if (index === -1) return false;

    // Remove checkpoint
    cps.splice(index, 1);
    this.checkpoints.set(sessionId, cps);

    // Restore archived messages
    const messages = this.messages.get(sessionId) ?? [];
    for (const msg of messages) {
      if (msg.checkpointId === checkpointId) {
        msg.isArchived = false;
        msg.archivedAt = undefined;
        msg.checkpointId = undefined;
      }
    }

    // Update session metadata
    const meta = session.metadata as Record<string, unknown> || {};
    const checkpointsMeta: SessionCheckpointsMeta = (meta.checkpoints as SessionCheckpointsMeta) || { checkpoints: [] };
    checkpointsMeta.checkpoints = checkpointsMeta.checkpoints.filter((cp) => cp.id !== checkpointId);
    checkpointsMeta.latestCheckpointId = cps[cps.length - 1]?.id;
    
    if (meta.checkpointDetails) {
      delete (meta.checkpointDetails as Record<string, SessionCheckpoint>)[checkpointId];
    }
    
    session.metadata = meta as Session["metadata"];
    session.messageCount = messages.filter((m) => !m.isArchived).length;
    session.updatedAt = Date.now();

    return true;
  }

  async archiveMessages(sessionId: string, checkpointId: string, beforeIndex: number): Promise<number> {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;

    const messages = this.messages.get(sessionId) ?? [];
    let archivedCount = 0;

    for (let i = 0; i < beforeIndex; i++) {
      if (!messages[i].isArchived) {
        messages[i].isArchived = true;
        messages[i].archivedAt = Date.now();
        messages[i].checkpointId = checkpointId;
        archivedCount++;
      }
    }

    // Update session message count (non-archived only)
    session.messageCount = messages.filter((m) => !m.isArchived).length;
    session.updatedAt = Date.now();

    return archivedCount;
  }

  async getActiveMessages(sessionId: string, offset = 0, limit = 50): Promise<SessionMessage[]> {
    const messages = this.messages.get(sessionId) ?? [];
    const activeMessages = messages.filter((m) => !m.isArchived);
    return activeMessages.slice(offset, offset + limit);
  }

  // ========================================================================
  // Search [new]
  // ========================================================================

  async searchMessages(options: SearchMessagesOptions): Promise<MessageMatch[]> {
    const matches: MessageMatch[] = [];
    const {
      query,
      sessionId,
      limit = 10,
      beforeTime,
      afterTime,
      includeArchived = false,
    } = options;

    // Determine which sessions to search
    let sessionsToSearch: Session[];
    if (sessionId) {
      const session = await this.get(sessionId);
      sessionsToSearch = session ? [session] : [];
    } else {
      sessionsToSearch = Array.from(this.sessions.values());
    }

    // Parse query for simple text matching
    const queryTerms = this.parseQuery(query);

    // Search through each session's messages
    for (const session of sessionsToSearch) {
      // Time constraint on session
      if (beforeTime && session.updatedAt > beforeTime) continue;
      if (afterTime && session.updatedAt < afterTime) continue;

      let messages = this.messages.get(session.id) ?? [];
      
      // Filter archived messages if needed
      if (!includeArchived) {
        messages = messages.filter((m) => !m.isArchived);
      }

      // Search through messages
      for (const msg of messages) {
        // Time constraint on message
        if (beforeTime && msg.timestamp > beforeTime) continue;
        if (afterTime && msg.timestamp < afterTime) continue;

        // Simple text search
        const content = msg.content.toLowerCase();
        let matchesQuery = true;

        for (const term of queryTerms.required) {
          if (!content.includes(term.toLowerCase())) {
            matchesQuery = false;
            break;
          }
        }

        for (const term of queryTerms.excluded) {
          if (content.includes(term.toLowerCase())) {
            matchesQuery = false;
            break;
          }
        }

        if (matchesQuery) {
          matches.push({
            messageId: msg.id,
            sessionId: session.id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
          });

          if (matches.length >= limit) {
            return matches;
          }
        }
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
      if (term.startsWith("-") || term.startsWith("NOT ")) {
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
    this.sessions.clear();
    this.messages.clear();
    this.checkpoints.clear();
    this.messageTruncOffsets.clear();
  }
}
