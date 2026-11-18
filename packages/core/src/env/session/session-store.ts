/**
 * @fileoverview Session Store Interface
 */

import type {
  Session,
  CreateSessionOptions,
  UpdateSessionOptions,
  ListSessionsOptions,
  SessionMessage,
  SessionCheckpoint,       // (new)
  GetMessagesOptions,     // (new)
  SearchMessagesOptions,   // (new)
  MessageMatch,           // (new)
} from "./types";

/**
 * Session Store Interface
 * Defines the contract for session storage implementations
 */
export interface SessionStore {
  // === Session CRUD ===
  
  /**
   * Create a new session
   */
  create(options: CreateSessionOptions): Promise<Session>;

  /**
   * Get a session by ID
   */
  get(id: string): Promise<Session | undefined>;

  /**
   * List sessions with optional filtering
   */
  list(options?: ListSessionsOptions): Promise<Session[]>;

  /**
   * Update a session
   */
  update(id: string, updates: UpdateSessionOptions): Promise<boolean>;

  /**
   * Delete a session
   */
  delete(id: string): Promise<boolean>;

  /**
   * Get total session count (without pagination)
   */
  getCount(): Promise<number>;

  // === Messages ===
  
  /**
   * Add a message to a session
   */
  addMessage(
    sessionId: string,
    message: { role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }
  ): Promise<string>;

  /**
   * Add multiple messages to a session atomically (single transaction).
   *
   * Layer 3 of sessions.db fix: one BEGIN/COMMIT block per call, instead
   * of N×2 separate statements (each `addMessage` does an INSERT plus a
   * UPDATE on `session` for `message_count`). This eliminates the lock-
   * amplification problem that triggered `database is locked` storms in
   * production. If any row fails (e.g. FK violation), the whole batch is
   * rolled back.
   *
   * @returns Array of generated message IDs in input order. Empty array
   *   for an empty input array.
   */
  addMessages(
    sessionId: string,
    messages: Array<{ role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }>
  ): Promise<string[]>;

  /**
   * Update an existing message by id
   */
  updateMessage(
    sessionId: string,
    messageId: string,
    updates: { metadata?: Record<string, unknown>; parts?: unknown[]; content?: string }
  ): Promise<boolean>;

  /**
   * Get messages from a session
   * @param sessionId - Session ID
   * @param offset - Starting index
   * @param limit - Number of messages to return
   * @param options - Additional options (includeArchived, fromCheckpointId, reverse)
   */
  getMessages(
    sessionId: string,
    offset?: number,
    limit?: number,
    options?: GetMessagesOptions
  ): Promise<SessionMessage[]>;

  /**
   * Get message indexes by role
   * @param sessionId - Session ID
   * @param role - Role to filter by
   */
  getMessageIndexes(sessionId: string, role: string): Promise<number[]>;

  /**
   * Get message count for a session
   * @param sessionId - Session ID
   * @param includeArchived - Whether to include archived messages
   */
  getMessageCount(sessionId: string, includeArchived?: boolean): Promise<number>;

  // === Checkpoint Management [new] ===
  
  /**
   * Save a checkpoint to session metadata
   */
  saveCheckpoint(sessionId: string, checkpoint: SessionCheckpoint): Promise<void>;

  /**
   * Get all checkpoints for a session
   */
  getCheckpoints(sessionId: string): Promise<SessionCheckpoint[]>;

  /**
   * Get a specific checkpoint
   */
  getCheckpoint(sessionId: string, checkpointId: string): Promise<SessionCheckpoint | undefined>;

  /**
   * Delete a checkpoint and restore archived messages
   */
  deleteCheckpoint(sessionId: string, checkpointId: string): Promise<boolean>;

  /**
   * Archive messages (mark as archived for compact)
   * @returns Number of messages archived
   */
  archiveMessages(sessionId: string, checkpointId: string, beforeIndex: number): Promise<number>;

  /**
   * Get active (non-archived) messages only
   */
  getActiveMessages(sessionId: string, offset?: number, limit?: number): Promise<SessionMessage[]>;

  // === Lifecycle ===
  
  /**
   * Close and cleanup resources
   */
  close(): Promise<void>;

  // === Search [new] ===
  
  /**
   * Search messages across all sessions
   * 
   * @param options - Search options including query, session filter, time range
   * @returns Array of message matches
   */
  searchMessages(options: SearchMessagesOptions): Promise<MessageMatch[]>;
}

/**
 * Base class for `SessionStore` implementations that do NOT need to
 * override `addMessages`. The default implementation simply loops over
 * `addMessage`, which keeps the per-message retry policy from
 * `SessionComponent` in effect but loses the BEGIN/COMMIT batching
 * optimization. Implementations that want the optimization (such as
 * SQLiteSessionStore) should override `addMessages`.
 *
 * Code Review note: adding `addMessages` as a required interface
 * method would break downstream `SessionStore` implementations at
 * compile time. Providing a default here keeps the contract additive.
 */
export abstract class BaseSessionStore implements SessionStore {
  // All methods except addMessages must be implemented by subclasses.
  abstract create(options: CreateSessionOptions): Promise<Session>;
  abstract get(id: string): Promise<Session | undefined>;
  abstract list(options?: ListSessionsOptions): Promise<Session[]>;
  abstract update(id: string, updates: UpdateSessionOptions): Promise<boolean>;
  abstract delete(id: string): Promise<boolean>;
  abstract getCount(): Promise<number>;
  abstract addMessage(
    sessionId: string,
    message: { role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }
  ): Promise<string>;
  abstract updateMessage(
    sessionId: string,
    messageId: string,
    updates: { metadata?: Record<string, unknown>; parts?: unknown[]; content?: string }
  ): Promise<boolean>;
  abstract getMessages(
    sessionId: string,
    offset?: number,
    limit?: number,
    options?: GetMessagesOptions
  ): Promise<SessionMessage[]>;
  abstract getMessageIndexes(sessionId: string, role: string): Promise<number[]>;
  abstract getMessageCount(sessionId: string, includeArchived?: boolean): Promise<number>;
  abstract saveCheckpoint(sessionId: string, checkpoint: SessionCheckpoint): Promise<void>;
  abstract getCheckpoints(sessionId: string): Promise<SessionCheckpoint[]>;
  abstract getCheckpoint(sessionId: string, checkpointId: string): Promise<SessionCheckpoint | undefined>;
  abstract deleteCheckpoint(sessionId: string, checkpointId: string): Promise<boolean>;
  abstract archiveMessages(sessionId: string, checkpointId: string, beforeIndex: number): Promise<number>;
  abstract getActiveMessages(sessionId: string, offset?: number, limit?: number): Promise<SessionMessage[]>;
  abstract close(): Promise<void>;
  abstract searchMessages(options: SearchMessagesOptions): Promise<MessageMatch[]>;

  /**
   * Default batch implementation: sequential `addMessage` calls.
   *
   * Subclasses are strongly encouraged to override this with a real
   * transaction (see SQLiteSessionStore.addMessages), because:
   *   1. atomicity: a partial failure here will leave the session in an
   *      inconsistent state;
   *   2. contention: N separate transactions mean N separate chances to
   *      hit SQLITE_BUSY, which is exactly the failure mode the Layer 1
   *      + Layer 2 fix tries to prevent.
   */
  async addMessages(
    sessionId: string,
    messages: Array<{ role: string; content: string; parts?: unknown[]; metadata?: Record<string, unknown> }>
  ): Promise<string[]> {
    if (messages.length === 0) return [];
    const ids: string[] = [];
    for (const msg of messages) {
      ids.push(await this.addMessage(sessionId, msg));
    }
    return ids;
  }
}
