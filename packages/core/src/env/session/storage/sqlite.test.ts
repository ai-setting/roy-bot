/**
 * @fileoverview SQLiteSessionStore tests — TDD for sessions.db concurrent-write fix
 *
 * Bug: session_19c1122f lost messages because `PRAGMA busy_timeout = 0` and
 * `journal_mode = delete`. Under contention, `addMessage` threw
 * `SQLITE_BUSY` and callers had no retry.
 *
 * These tests verify the 4-layer fix:
 * 1. PRAGMA initialization (WAL + busy_timeout + synchronous=NORMAL)
 * 2. `addMessage` survives concurrent writers (no dropped messages)
 * 3. `addMessages` batch is atomic (single BEGIN/COMMIT/ROLLBACK)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteSessionStore } from './sqlite';
import type { SessionStore } from '../session-store';

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'sqlite-session-test-'));
}

/**
 * Read a PRAGMA value. Returns string for journal_mode (e.g. 'wal') or number
 * for busy_timeout (ms).
 *
 * - bun:sqlite: `db.prepare("PRAGMA foo").get()` returns `{foo: value}`
 * - better-sqlite3: `db.prepare("PRAGMA foo").get()` returns `{'foo': value}`
 */
function readPragma(store: SQLiteSessionStore, name: 'journal_mode' | 'busy_timeout' | 'synchronous'): any {
  const db = (store as any).db;
  const row = db.prepare(`PRAGMA ${name}`).get();
  // Try both possible column names
  return row[name] ?? row[name.toUpperCase()] ?? row[Object.keys(row)[0]];
}

async function createSessionWithStore(store: SessionStore): Promise<string> {
  const session = await store.create({ title: 'T', directory: '/tmp' });
  return session.id;
}

// ============================================================================
// Layer 1: PRAGMA initialization
// ============================================================================

describe('SQLiteSessionStore — PRAGMA initialization (Layer 1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets journal_mode to WAL on a file-based DB', async () => {
    const dbPath = join(tmpDir, 'wal.db');
    const store = new SQLiteSessionStore(dbPath);
    await store.create({ title: 'warmup', directory: '/tmp' }); // forces initialize()

    const journalMode = readPragma(store, 'journal_mode');
    expect(journalMode).toBe('wal');
  });

  it('sets busy_timeout to 5000ms on a file-based DB', async () => {
    const dbPath = join(tmpDir, 'busy.db');
    const store = new SQLiteSessionStore(dbPath);
    await store.create({ title: 'warmup', directory: '/tmp' });

    const timeout = readPragma(store, 'busy_timeout');
    expect(Number(timeout)).toBe(5000);
  });

  it('sets synchronous to NORMAL on a file-based DB', async () => {
    const dbPath = join(tmpDir, 'sync.db');
    const store = new SQLiteSessionStore(dbPath);
    await store.create({ title: 'warmup', directory: '/tmp' });

    const sync = readPragma(store, 'synchronous');
    // 0=OFF, 1=NORMAL, 2=FULL (per SQLite docs)
    expect(Number(sync)).toBe(1);
  });
});

// ============================================================================
// Layer 2 + 3: Concurrent addMessage + batch addMessages
// ============================================================================

describe('SQLiteSessionStore — concurrent addMessage (Layer 2: WAL+busy_timeout holds under contention)', () => {
  let tmpDir: string;
  let store: SQLiteSessionStore;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'concurrent.db');
    store = new SQLiteSessionStore(dbPath);
    sessionId = await createSessionWithStore(store);
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('20 parallel addMessage calls all succeed — no message drops', async () => {
    const N = 20;
    const promises: Promise<string>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        store.addMessage(sessionId, {
          role: 'user',
          content: `parallel msg ${i}`,
        })
      );
    }

    const ids = await Promise.all(promises);

    // 20 distinct IDs returned
    expect(ids).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);

    // All 20 rows persisted (no duplicates, no drops)
    const messages = await store.getMessages(sessionId, 0, 100);
    expect(messages).toHaveLength(N);

    // session.messageCount tracks the rows
    const session = await store.get(sessionId);
    expect(session?.messageCount).toBe(N);
  });
});

// ============================================================================
// Layer 3: addMessages batch transaction (atomicity)
// ============================================================================

describe('SQLiteSessionStore — addMessages batch transaction (Layer 3)', () => {
  let tmpDir: string;
  let store: SQLiteSessionStore;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    const dbPath = join(tmpDir, 'batch.db');
    store = new SQLiteSessionStore(dbPath);
    sessionId = await createSessionWithStore(store);
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a batch of messages and returns IDs in order', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      content: `batch msg ${i}`,
    }));

    const ids = await store.addMessages(sessionId, messages);

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);

    const stored = await store.getMessages(sessionId, 0, 100);
    expect(stored).toHaveLength(5);

    const session = await store.get(sessionId);
    expect(session?.messageCount).toBe(5);
  });

  it('rolls back the entire batch when one row violates a constraint', async () => {
    // Sanity: addMessages must exist (so the test exercises the new API, not
    // a synchronous "undefined method" error that try/catch hides).
    expect(typeof (store as any).addMessages).toBe('function');

    // Pre-condition: add a real message first so we can verify the
    // original session is untouched by the failed batch.
    const preMsgId = await store.addMessage(sessionId, {
      role: 'user',
      content: 'pre-existing',
    });
    expect(preMsgId).toBeTruthy();

    // Trip a constraint failure by referencing a bogus sessionId for the
    // whole batch. addMessages must throw, and the original session must
    // remain untouched. We don't pin the exact error string — the impl
    // either pre-checks session existence ("Session not found") or lets
    // the FK fire ("FOREIGN KEY constraint failed"); both are acceptable
    // — the contract is "throw + no partial commit on the real session".
    const bogusSessionId = 'session_does_not_exist_for_batch_rollback';
    const goodMessages = [
      { role: 'user' as const, content: 'good-1' },
      { role: 'user' as const, content: 'good-2' },
    ];

    let threw = false;
    try {
      await store.addMessages(bogusSessionId, goodMessages);
    } catch (_err) {
      threw = true;
    }
    expect(threw).toBe(true);

    // Original session unchanged: still has only the pre-existing message.
    const after = await store.getMessages(sessionId, 0, 100);
    expect(after).toHaveLength(1);
    expect(after[0].content).toBe('pre-existing');
    const session = await store.get(sessionId);
    expect(session?.messageCount).toBe(1);
  });

  it('handles empty batch as a no-op (returns empty array)', async () => {
    const ids = await store.addMessages(sessionId, []);
    expect(ids).toEqual([]);
  });
});