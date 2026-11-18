/**
 * @fileoverview SessionComponent Custom ID Tests
 * 
 * Tests for SessionComponent.create() supporting custom session ID
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { SessionComponent, AddMessageLockExhaustedError } from './session-component';
import { MemorySessionStore } from './storage/memory';
import type { CreateSessionOptions, Session } from './types';
import type { SessionStore } from './session-store';

describe('SessionComponent.create with custom ID', () => {
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

  describe('custom session ID', () => {
    it('should accept custom session ID in options', async () => {
      const customId = 'workflow_test123';
      
      const options: CreateSessionOptions = {
        id: customId,
        title: 'Test Session',
        metadata: { type: 'workflow', workflowName: 'test' },
      };

      const session = await component.create(options);
      
      expect(session.id).toBe(customId);
      expect(session.title).toBe('Test Session');
    });

    it('should generate ID if not provided', async () => {
      const options: CreateSessionOptions = {
        title: 'Test Session',
      };

      const session = await component.create(options);
      
      expect(session.id).toBeTruthy();
      expect(typeof session.id).toBe('string');
    });

    it('should preserve workflow-style session ID', async () => {
      const timestamp = Date.now();
      const sessionId = `workflow_${timestamp}_1_abc`;
      
      const options: CreateSessionOptions = {
        id: sessionId,
        title: 'Workflow Session',
      };

      const session = await component.create(options);
      
      expect(session.id).toBe(sessionId);
      expect(session.id.startsWith('workflow_')).toBe(true);
    });

    it('should create workflow session with correct metadata', async () => {
      const sessionId = 'workflow_test_workflow1';
      
      const options: CreateSessionOptions = {
        id: sessionId,
        title: 'Workflow: test-workflow',
        metadata: {
          type: 'workflow',
          workflowName: 'test-workflow',
          workflowId: 'wf-123',
          status: 'running',
        },
      };

      const session = await component.create(options);
      
      expect(session.id).toBe(sessionId);
      expect((session.metadata as any).type).toBe('workflow');
      expect((session.metadata as any).workflowName).toBe('test-workflow');
      expect((session.metadata as any).status).toBe('running');
    });

    it('should allow custom ID with parent session', async () => {
      // First create parent session
      const parentSession = await component.create({
        title: 'Parent Session',
      });

      // Create child session with custom ID
      const childOptions: CreateSessionOptions = {
        id: `workflow_child_${Date.now()}`,
        title: 'Child Workflow',
        parentID: parentSession.id,
      };

      const childSession = await component.create(childOptions);
      
      expect(childSession.parentID).toBe(parentSession.id);
      expect(childSession.id.startsWith('workflow_child_')).toBe(true);
    });
  });

  describe('duplicate ID handling', () => {
    it('should throw error if custom ID already exists', async () => {
      const customId = 'workflow_duplicate_test';
      
      // Create first session with custom ID
      await component.create({
        id: customId,
        title: 'First Session',
      });

      // Try to create second session with same ID
      try {
        await component.create({
          id: customId,
          title: 'Second Session',
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('already exists');
      }
    });
  });
});

// ============================================================================
// Retry on SQLITE_BUSY (Layer 2)
// ============================================================================

/**
 * Build a SessionStore mock that lets each test control how `addMessage`
 * behaves (succeed / throw busy N times / throw non-busy). Mirrors the
 * minimal surface area SessionComponent.addMessage() touches.
 */
function makeFlakyStore(realStore: SessionStore): SessionStore & {
  __flakyAddMessage: ReturnType<typeof mock>;
} {
  const flakyAddMessage = mock(async () => 'msg_dummy_id');
  return Object.assign(realStore, {
    __flakyAddMessage: flakyAddMessage,
    addMessage: flakyAddMessage as any,
  }) as any;
}

describe('SessionComponent.addMessage — SQLITE_BUSY retry (Layer 2)', () => {
  let component: SessionComponent;
  let realStore: MemorySessionStore;
  let flakyStore: ReturnType<typeof makeFlakyStore>;
  let sessionId: string;

  beforeEach(async () => {
    realStore = new MemorySessionStore();
    flakyStore = makeFlakyStore(realStore);
    const s = await realStore.create({ title: 'retry-target', directory: '/tmp' });
    sessionId = s.id;

    component = new SessionComponent();
    (component as any).store = flakyStore;
    (component as any).hooksConfig = {};
  });

  it('retries on SQLITE_BUSY and succeeds on the 3rd attempt', async () => {
    let calls = 0;
    flakyStore.__flakyAddMessage.mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        const e: any = new Error('database is locked');
        e.code = 'SQLITE_BUSY';
        throw e;
      }
      return 'msg_recovered';
    });

    const result = await component.addMessage(sessionId, {
      role: 'user',
      content: 'flaky',
    });

    expect(result).toBe('msg_recovered');
    expect(calls).toBe(3);
  });

  it('throws AddMessageLockExhaustedError after exhausting 3 retries on persistent SQLITE_BUSY', async () => {
    let calls = 0;
    flakyStore.__flakyAddMessage.mockImplementation(async () => {
      calls++;
      const e: any = new Error('database is locked');
      e.code = 'SQLITE_BUSY';
      throw e;
    });

    // Code Review feedback: callers should be able to distinguish
    // "lock exhausted after retries" from "validation rejected on
    // first attempt". The retry helper now throws a typed marker
    // instead of returning `undefined` in this case.
    let thrown: unknown;
    try {
      await component.addMessage(sessionId, { role: 'user', content: 'always-locked' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AddMessageLockExhaustedError);
    expect(calls).toBe(3); // exactly 3 attempts, no more
  });

  it('does NOT retry on non-busy errors (e.g. validation)', async () => {
    let calls = 0;
    flakyStore.__flakyAddMessage.mockImplementation(async () => {
      calls++;
      throw new Error('Some other failure: constraint X violated');
    });

    const result = await component.addMessage(sessionId, {
      role: 'user',
      content: 'other-failure',
    });

    expect(result).toBeUndefined();
    expect(calls).toBe(1); // gave up immediately
  });

  it('detects SQLITE_BUSY from bun:sqlite-style message "SQLiteError: database is locked"', async () => {
    // Code Review feedback: the previous case-insensitive substring
    // matcher over-matched user-facing errors that happened to quote
    // the phrase "database is locked". The new detector requires the
    // canonical bun:sqlite prefix (`SQLiteError: `) before treating
    // a message-only error as retriable.
    let calls = 0;
    flakyStore.__flakyAddMessage.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        // bun:sqlite surfaces SQLITE_BUSY as a plain Error without
        // setting `.code`. The message carries the canonical prefix.
        throw new Error('SQLiteError: database is locked');
      }
      return 'msg_recovered_via_message';
    });

    const result = await component.addMessage(sessionId, {
      role: 'user',
      content: 'msg-only-busy',
    });

    expect(result).toBe('msg_recovered_via_message');
    expect(calls).toBe(2);
  });

  it('does NOT retry when "database is locked" appears WITHOUT the SQLiteError prefix', async () => {
    // Code Review feedback: previous substring matcher would retry on
    // any error whose message happened to contain "database is locked"
    // — including user-facing validation errors quoting a column name.
    // The new matcher requires the canonical `SQLiteError:` prefix.
    let calls = 0;
    flakyStore.__flakyAddMessage.mockImplementation(async () => {
      calls++;
      throw new Error('Validation: "database is locked" column not found in row 42');
    });

    const result = await component.addMessage(sessionId, {
      role: 'user',
      content: 'validation-failure',
    });

    expect(result).toBeUndefined();
    expect(calls).toBe(1); // no retry — non-busy error
  });
});
