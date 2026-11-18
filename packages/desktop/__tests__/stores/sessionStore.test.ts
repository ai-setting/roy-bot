/**
 * @fileoverview Tests for Session Store
 * 
 * Tests session state management using Zustand store
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sessionStore } from '../../src/stores/sessionStore';
import { SessionAdapter } from '../../src/core/SessionAdapter';

// Store reference to singleton for cleanup
let adapterInstance: SessionAdapter;

describe('SessionStore', () => {
  beforeEach(() => {
    // Get adapter instance and clear it
    adapterInstance = sessionStore.getState().getAdapter();
    
    // Reset adapter state
    const allSessions = adapterInstance.getAllSessions();
    for (const session of allSessions) {
      adapterInstance.deleteSession(session.id);
    }
    
    // Reset store state
    sessionStore.setState({
      messages: [],
      isStreaming: false,
      activeSessionId: null,
      sessions: [],
    });
  });

  describe('initial state', () => {
    it('should have empty messages array after reset', () => {
      const { messages } = sessionStore.getState();
      expect(messages).toEqual([]);
    });

    it('should not be streaming initially', () => {
      const { isStreaming } = sessionStore.getState();
      expect(isStreaming).toBe(false);
    });

    it('should have no active session initially', () => {
      const { activeSessionId } = sessionStore.getState();
      expect(activeSessionId).toBeNull();
    });
  });

  describe('createSession', () => {
    it('should create a new session with default title', () => {
      const session = sessionStore.getState().createSession();
      expect(session).toBeDefined();
      expect(session.title).toBeDefined();
      expect(session.id).toBeDefined();
    });

    it('should create a new session with custom title', () => {
      const session = sessionStore.getState().createSession('My Session');
      expect(session.title).toBe('My Session');
    });

    it('should set new session as active', () => {
      const session = sessionStore.getState().createSession('New Session');
      const { activeSessionId } = sessionStore.getState();
      expect(activeSessionId).toBe(session.id);
    });

    it('should add session to sessions list', () => {
      sessionStore.getState().createSession('Session 1');
      sessionStore.getState().createSession('Session 2');
      const { sessions } = sessionStore.getState();
      expect(sessions.length).toBe(2);
    });
  });

  describe('setActiveSession', () => {
    it('should set active session', () => {
      const session1 = sessionStore.getState().createSession('Session 1');
      const session2 = sessionStore.getState().createSession('Session 2');
      
      sessionStore.getState().setActiveSession(session1.id);
      expect(sessionStore.getState().activeSessionId).toBe(session1.id);
      
      sessionStore.getState().setActiveSession(session2.id);
      expect(sessionStore.getState().activeSessionId).toBe(session2.id);
    });

    it('should return true for valid session', () => {
      const session = sessionStore.getState().createSession('Test');
      const result = sessionStore.getState().setActiveSession(session.id);
      expect(result).toBe(true);
    });

    it('should return false for invalid session', () => {
      const result = sessionStore.getState().setActiveSession('invalid-id');
      expect(result).toBe(false);
    });
  });

  describe('addMessage', () => {
    it('should add a user message', () => {
      sessionStore.getState().createSession('Test');
      const message = sessionStore.getState().addMessage('user', 'Hello world');
      
      expect(message).toBeDefined();
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello world');
    });

    it('should add an assistant message', () => {
      sessionStore.getState().createSession('Test');
      const message = sessionStore.getState().addMessage('assistant', 'Hi there!');
      
      expect(message.role).toBe('assistant');
      expect(message.content).toBe('Hi there!');
    });

    it('should add metadata to message', () => {
      sessionStore.getState().createSession('Test');
      const message = sessionStore.getState().addMessage('user', 'Test', { type: 'test' });
      
      expect(message.metadata).toBeDefined();
      expect(message.metadata?.type).toBe('test');
    });

    it('should add multiple messages', () => {
      sessionStore.getState().createSession('Test');
      sessionStore.getState().addMessage('user', 'Hello');
      sessionStore.getState().addMessage('assistant', 'Hi!');
      
      const { messages } = sessionStore.getState();
      expect(messages.length).toBe(2);
    });
  });

  describe('setStreaming', () => {
    it('should set streaming state to true', () => {
      sessionStore.getState().setStreaming(true);
      expect(sessionStore.getState().isStreaming).toBe(true);
    });

    it('should set streaming state to false', () => {
      sessionStore.getState().setStreaming(true);
      sessionStore.getState().setStreaming(false);
      expect(sessionStore.getState().isStreaming).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', () => {
      const session1 = sessionStore.getState().createSession('Session 1');
      sessionStore.getState().createSession('Session 2');
      
      sessionStore.getState().deleteSession(session1.id);
      
      const { sessions } = sessionStore.getState();
      expect(sessions.length).toBe(1);
    });

    it('should switch active session when deleting current', () => {
      const session1 = sessionStore.getState().createSession('Session 1');
      sessionStore.getState().createSession('Session 2');
      
      sessionStore.getState().setActiveSession(session1.id);
      sessionStore.getState().deleteSession(session1.id);
      
      // Should switch to remaining session
      const { activeSessionId } = sessionStore.getState();
      expect(activeSessionId).not.toBe(session1.id);
    });
  });

  describe('getAdapter', () => {
    it('should return adapter instance', () => {
      const adapter = sessionStore.getState().getAdapter();
      expect(adapter).toBeDefined();
      expect(typeof adapter.createSession).toBe('function');
      expect(typeof adapter.addMessage).toBe('function');
    });
  });

  describe('store API', () => {
    it('should expose state and actions', () => {
      const state = sessionStore.getState();
      
      // State properties
      expect(state).toHaveProperty('messages');
      expect(state).toHaveProperty('isStreaming');
      expect(state).toHaveProperty('activeSessionId');
      expect(state).toHaveProperty('sessions');
      
      // Actions
      expect(state).toHaveProperty('init');
      expect(state).toHaveProperty('addMessage');
      expect(state).toHaveProperty('setStreaming');
      expect(state).toHaveProperty('createSession');
      expect(state).toHaveProperty('setActiveSession');
      expect(state).toHaveProperty('deleteSession');
      expect(state).toHaveProperty('getAdapter');
      
      // Verify they are functions
      expect(typeof state.init).toBe('function');
      expect(typeof state.addMessage).toBe('function');
      expect(typeof state.setStreaming).toBe('function');
      expect(typeof state.createSession).toBe('function');
      expect(typeof state.setActiveSession).toBe('function');
      expect(typeof state.deleteSession).toBe('function');
      expect(typeof state.getAdapter).toBe('function');
    });
  });
});
