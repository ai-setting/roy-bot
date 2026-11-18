/**
 * @fileoverview SessionComponent extractRecentMessages Tests
 * 
 * Tests for the extractRecentMessages method
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionComponent } from './session-component';
import { MemorySessionStore } from './storage/memory';
import type { SessionMessage } from './types';

describe('SessionComponent.extractRecentMessages', () => {
  let component: SessionComponent;
  let store: MemorySessionStore;

  beforeEach(async () => {
    // Create component with memory store
    component = new SessionComponent();
    store = new MemorySessionStore();
    
    // Inject mock dependencies
    (component as any).store = store;
    (component as any).hooksConfig = {};
  });

  // Helper to create test messages
  function createMessage(
    id: string,
    role: 'user' | 'assistant',
    content: string,
    parts?: any[]
  ): SessionMessage {
    return {
      id,
      sessionID: 'test-session',
      role,
      content,
      timestamp: Date.now(),
      parts,
      metadata: {},
    };
  }

  describe('basic extraction', () => {
    it('should extract 2 turns by default', async () => {
      const messages: SessionMessage[] = [
        createMessage('1', 'user', 'First question'),
        createMessage('2', 'assistant', 'First answer'),
        createMessage('3', 'user', 'Second question'),
        createMessage('4', 'assistant', 'Second answer'),
        createMessage('5', 'user', 'Third question'),
        createMessage('6', 'assistant', 'Third answer'),
      ];

      // Access private method via any cast
      const result = (component as any).extractRecentMessages(messages);

      expect(result.length).toBe(4); // 2 turns = user + assistant pairs
      expect(result[0]).toEqual({ role: 'user', content: 'Second question' });
      expect(result[1]).toEqual({ role: 'assistant', content: 'Second answer' });
      expect(result[2]).toEqual({ role: 'user', content: 'Third question' });
      expect(result[3]).toEqual({ role: 'assistant', content: 'Third answer' });
    });

    it('should extract 1 turn when specified', async () => {
      const messages: SessionMessage[] = [
        createMessage('1', 'user', 'First question'),
        createMessage('2', 'assistant', 'First answer'),
        createMessage('3', 'user', 'Second question'),
        createMessage('4', 'assistant', 'Second answer'),
      ];

      const result = (component as any).extractRecentMessages(messages, 1);

      expect(result.length).toBe(2); // 1 turn = user + assistant
      expect(result[0]).toEqual({ role: 'user', content: 'Second question' });
      expect(result[1]).toEqual({ role: 'assistant', content: 'Second answer' });
    });

    it('should extract 3 turns when specified', async () => {
      const messages: SessionMessage[] = [
        createMessage('1', 'user', 'First question'),
        createMessage('2', 'assistant', 'First answer'),
        createMessage('3', 'user', 'Second question'),
        createMessage('4', 'assistant', 'Second answer'),
        createMessage('5', 'user', 'Third question'),
        createMessage('6', 'assistant', 'Third answer'),
      ];

      const result = (component as any).extractRecentMessages(messages, 3);

      expect(result.length).toBe(6); // 3 turns
    });
  });

  describe('skip tool calls and results', () => {
    it('should skip assistant messages with tool-call parts', async () => {
      const messages: SessionMessage[] = [
        createMessage('1', 'user', 'Run a command'),
        createMessage('2', 'assistant', 'I will run the command', [
          { type: 'tool-call', toolName: 'bash' }
        ]),
        createMessage('3', 'user', 'Second question'),
        createMessage('4', 'assistant', 'Second answer'),
      ];

      const result = (component as any).extractRecentMessages(messages, 1);

      // Should skip the tool-call message and find next user+assistant pair
      expect(result.length).toBe(2);
      expect(result[0]).toEqual({ role: 'user', content: 'Second question' });
      expect(result[1]).toEqual({ role: 'assistant', content: 'Second answer' });
    });

    it('should skip assistant messages with tool-result parts', async () => {
      const messages: SessionMessage[] = [
        createMessage('1', 'user', 'Run a command'),
        createMessage('2', 'assistant', 'Command completed', [
          { type: 'tool-result', toolName: 'bash' }
        ]),
        createMessage('3', 'user', 'Second question'),
        createMessage('4', 'assistant', 'Second answer'),
      ];

      const result = (component as any).extractRecentMessages(messages, 1);

      expect(result.length).toBe(2);
      expect(result[0]).toEqual({ role: 'user', content: 'Second question' });
      expect(result[1]).toEqual({ role: 'assistant', content: 'Second answer' });
    });

    it('should include assistant messages without tool parts', async () => {
      const messages: SessionMessage[] = [
        createMessage('1', 'user', 'Hello'),
        createMessage('2', 'assistant', 'Hi there!'), // No tool parts
        createMessage('3', 'user', 'How are you?'),
        createMessage('4', 'assistant', 'I am fine!'),
      ];

      const result = (component as any).extractRecentMessages(messages, 1);

      expect(result.length).toBe(2);
      expect(result[1]).toEqual({ role: 'assistant', content: 'I am fine!' });
    });
  });

  describe('skip checkpoint messages', () => {
    it('should skip checkpoint messages when extracting', async () => {
      const messages: SessionMessage[] = [
        createMessage('1', 'user', 'First question'),
        createMessage('2', 'assistant', 'First answer'),
        createMessage('3', 'user', '', undefined), // Will be checkpoint
        createMessage('3', 'user', 'Second question'),
        createMessage('4', 'assistant', 'Second answer'),
      ];
      // Mark checkpoint
      messages[2].metadata = { isCheckpoint: true };

      const result = (component as any).extractRecentMessages(messages, 1);

      expect(result.length).toBe(2);
      expect(result[0]).toEqual({ role: 'user', content: 'Second question' });
    });
  });

  describe('edge cases', () => {
    it('should fall back to raw tail when no clean text turns found (agentic session)', async () => {
      // ★ 2026-10-16：契约变更。原实现只收「无 tool part 的 assistant 纯文本」，
      //   agentic 会话里取不到就返回 [] —— 三条事故 trace 的 recentMessages 全是 []，
      //   「保留最近上下文」的安全网形同虚设。现在必须退化为保留最近 N 条原始消息。
      const messages: SessionMessage[] = [
        createMessage('1', 'assistant', 'I started first', [
          { type: 'tool-call', toolName: 'bash' }
        ]),
      ];

      const result = (component as any).extractRecentMessages(messages, 1);

      expect(result.length).toBe(1);
      expect(result[0].content).toBe('I started first');
    });

    it('should handle empty messages array', async () => {
      const messages: SessionMessage[] = [];

      const result = (component as any).extractRecentMessages(messages);

      expect(result.length).toBe(0);
    });

    it('should fall back to raw tail for user-only messages too', async () => {
      // ★ 2026-10-16：契约变更，同上一例 —— 宁可给一点上下文，也不要 []。
      const messages: SessionMessage[] = [
        createMessage('1', 'user', 'Hello'),
      ];

      const result = (component as any).extractRecentMessages(messages, 1);

      expect(result.length).toBe(1);
      expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('should handle messages with only empty content', async () => {
      const messages: SessionMessage[] = [
        createMessage('1', 'user', ''),
        createMessage('2', 'assistant', '  '),
      ];

      const result = (component as any).extractRecentMessages(messages, 1);

      // Empty content is filtered out
      expect(result.length).toBe(0);
    });
  });
});
