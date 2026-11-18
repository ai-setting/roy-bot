/**
 * @fileoverview Session Adapter
 * 
 * Simplified session adapter for renderer process.
 * 
 * Note: Actual session management is done in the main process via DesktopEnvironment.
 * This adapter provides a simplified interface for the renderer.
 */

/**
 * Session type
 */
export interface Session {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

/**
 * Session message type
 */
export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * SessionAdapter
 * 
 * Simplified session management for renderer.
 * UI components use this to interact with sessions.
 */
export class SessionAdapter {
  private currentSessionId: string | null = null;
  private sessions: Map<string, Session> = new Map();
  private messages: Map<string, SessionMessage[]> = new Map();

  constructor() {
    // Create initial session
    this.createSession();
  }

  /**
   * Check if adapter is initialized
   */
  isInitialized(): boolean {
    return this.currentSessionId !== null;
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Get current session
   */
  getCurrentSession(): Session | undefined {
    if (!this.currentSessionId) return undefined;
    return this.sessions.get(this.currentSessionId);
  }

  /**
   * Create a new session
   */
  createSession(title?: string): Session {
    const session: Session = {
      id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: title || `Session ${this.sessions.size + 1}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    this.currentSessionId = session.id;

    return session;
  }

  /**
   * Switch to a session
   */
  switchSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.currentSessionId = sessionId;
    return true;
  }

  /**
   * Add a message to current session
   */
  addMessage(role: SessionMessage['role'], content: string, metadata?: Record<string, unknown>): SessionMessage {
    if (!this.currentSessionId) {
      this.createSession();
    }

    const message: SessionMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      sessionId: this.currentSessionId!,
      role,
      content,
      timestamp: Date.now(),
      metadata,
    };

    const messages = this.messages.get(this.currentSessionId!) || [];
    messages.push(message);
    this.messages.set(this.currentSessionId!, messages);

    // Update session timestamp
    const session = this.sessions.get(this.currentSessionId!);
    if (session) {
      session.updatedAt = Date.now();
    }

    return message;
  }

  /**
   * Get messages for current session
   */
  getMessages(): SessionMessage[] {
    if (!this.currentSessionId) return [];
    return this.messages.get(this.currentSessionId) || [];
  }

  /**
   * Get all sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);

    // Switch to another session if current was deleted
    if (this.currentSessionId === sessionId) {
      const remaining = Array.from(this.sessions.keys());
      this.currentSessionId = remaining[0] || null;
    }

    return true;
  }

  /**
   * Update session title
   */
  updateSessionTitle(sessionId: string, title: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.title = title;
    session.updatedAt = Date.now();
    return true;
  }
}

/**
 * Create a new SessionAdapter instance
 */
export function createSessionAdapter(): SessionAdapter {
  return new SessionAdapter();
}
