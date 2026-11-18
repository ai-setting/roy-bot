/**
 * @fileoverview Session Store - Zustand store for session management
 * 
 * Manages session messages and streaming state using SessionAdapter.
 * Provides reactive state for the desktop UI.
 */

import { create } from 'zustand';
import { SessionAdapter, type Session, type SessionMessage } from '../core/SessionAdapter';

// ============================================================================
// Types
// ============================================================================

/**
 * Role type for session messages
 */
export type Role = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Session state interface
 */
interface SessionState {
  /** List of messages in the active session */
  messages: SessionMessage[];
  /** Whether a response is currently streaming */
  isStreaming: boolean;
  /** ID of the active session */
  activeSessionId: string | null;
  /** All sessions */
  sessions: Session[];
}

/**
 * Session actions interface
 */
interface SessionActions {
  /** Initialize the store */
  init: () => void;
  /** Add a message to the active session */
  addMessage: (role: Role, content: string, metadata?: Record<string, unknown>) => SessionMessage | undefined;
  /** Set streaming state */
  setStreaming: (streaming: boolean) => void;
  /** Create a new session */
  createSession: (title?: string) => Session;
  /** Set the active session */
  setActiveSession: (sessionId: string) => boolean;
  /** Delete a session */
  deleteSession: (sessionId: string) => boolean;
  /** Get the session adapter */
  getAdapter: () => SessionAdapter;
}

// Type for the adapter
type SessionAdapterType = SessionAdapter;

/**
 * Combined session store type
 */
export type SessionStore = SessionState & SessionActions;

// ============================================================================
// Store Implementation
// ============================================================================

/**
 * Create the session store
 */
const store = create<SessionStore>((set, get) => {
  // Create adapter instance
  const adapter = new SessionAdapter();

  return {
    // Initial state
    messages: adapter.getMessages(),
    isStreaming: false,
    activeSessionId: adapter.getCurrentSessionId(),
    sessions: adapter.getAllSessions(),

    // Actions
    /**
     * Initialize the store.
     */
    init: () => {
      set({
        messages: adapter.getMessages(),
        activeSessionId: adapter.getCurrentSessionId(),
        sessions: adapter.getAllSessions(),
      });
    },

    /**
     * Add a message to the active session.
     */
    addMessage: (role: Role, content: string, metadata?: Record<string, unknown>) => {
      const message = adapter.addMessage(role, content, metadata);
      set({
        messages: adapter.getMessages(),
        sessions: adapter.getAllSessions(),
      });
      return message;
    },

    /**
     * Set streaming state.
     */
    setStreaming: (streaming: boolean) => {
      set({ isStreaming: streaming });
    },

    /**
     * Create a new session.
     */
    createSession: (title?: string) => {
      const session = adapter.createSession(title);
      set({
        activeSessionId: adapter.getCurrentSessionId(),
        sessions: adapter.getAllSessions(),
        messages: adapter.getMessages(),
      });
      return session;
    },

    /**
     * Set the active session.
     */
    setActiveSession: (sessionId: string) => {
      const success = adapter.switchSession(sessionId);
      if (success) {
        set({
          activeSessionId: adapter.getCurrentSessionId(),
          messages: adapter.getMessages(),
        });
      }
      return success;
    },

    /**
     * Delete a session.
     */
    deleteSession: (sessionId: string) => {
      const success = adapter.deleteSession(sessionId);
      if (success) {
        set({
          activeSessionId: adapter.getCurrentSessionId(),
          sessions: adapter.getAllSessions(),
          messages: adapter.getMessages(),
        });
      }
      return success;
    },

    /**
     * Get the session adapter instance.
     */
    getAdapter: () => adapter,
  };
});

// Export as hook for React components
export const useSessionStore = store;

// Also export as plain store for non-React usage
export const sessionStore = store;
