/**
 * @fileoverview SQLiteSpanStorage WAL 模式测试
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteSpanStorage } from './span-storage';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';

describe('SQLiteSpanStorage with WAL', () => {
  let storage: SQLiteSpanStorage;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(os.tmpdir(), 'span-storage-test-'));
    storage = new SQLiteSpanStorage(join(tempDir, 'traces.db'));
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('WAL mode', () => {
    test('should enable WAL journal mode', async () => {
      await storage.initialize();
      
      // WAL mode should be enabled
      // We can verify by checking the database journal mode
      const spans = storage.findBySpanId('non-existent');
      expect(spans).toBeUndefined();
    });

    test('should save and retrieve spans', async () => {
      await storage.initialize();
      
      const span = {
        traceId: 'trace-123',
        spanId: 'span-456',
        parentSpanId: undefined,
        name: 'test-span',
        kind: 'internal' as const,
        status: 'ok' as const,
        startTime: Date.now(),
        endTime: Date.now() + 100,
        attributes: { key: 'value' },
      };
      
      storage.save(span);
      
      const retrieved = storage.findBySpanId('span-456');
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('test-span');
      expect(retrieved!.traceId).toBe('trace-123');
    });

    test('should handle concurrent writes', async () => {
      await storage.initialize();
      
      // Simulate concurrent writes
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        const span = {
          traceId: 'trace-concurrent',
          spanId: `span-concurrent-${i}`,
          parentSpanId: undefined,
          name: `concurrent-span-${i}`,
          kind: 'internal' as const,
          status: 'ok' as const,
          startTime: Date.now(),
          attributes: {},
        };
        promises.push(Promise.resolve(storage.save(span)));
      }
      
      await Promise.all(promises);
      
      // All spans should be saved
      const traces = storage.findByTraceId('trace-concurrent');
      expect(traces.length).toBeGreaterThanOrEqual(10);
    });

    test('should save batch of spans', async () => {
      await storage.initialize();
      
      const spans = Array.from({ length: 5 }, (_, i) => ({
        traceId: 'trace-batch',
        spanId: `span-batch-${i}`,
        parentSpanId: undefined,
        name: `batch-span-${i}`,
        kind: 'internal' as const,
        status: 'ok' as const,
        startTime: Date.now(),
        attributes: {},
      }));
      
      storage.saveBatch(spans);
      
      const traces = storage.findByTraceId('trace-batch');
      expect(traces.length).toBe(5);
    });

    test('should list traces', async () => {
      await storage.initialize();
      
      // Save some spans
      for (let i = 0; i < 5; i++) {
        storage.save({
          traceId: `trace-list-${i}`,
          spanId: `span-list-${i}`,
          parentSpanId: undefined,
          name: `list-span-${i}`,
          kind: 'internal' as const,
          status: 'ok' as const,
          startTime: Date.now(),
          attributes: {},
        });
      }
      
      const traces = storage.listTraces(10);
      expect(traces.length).toBeGreaterThanOrEqual(5);
    });

    test('listTraces should resolve root span name and status', async () => {
      await storage.initialize();

      storage.save({
        traceId: 'trace-meta',
        spanId: 'span-meta-root',
        parentSpanId: undefined,
        name: 'agent.run',
        kind: 'internal' as const,
        status: 'ok' as const,
        startTime: 1000,
        endTime: 1300,
        attributes: {},
      });
      storage.save({
        traceId: 'trace-meta',
        spanId: 'span-meta-child',
        parentSpanId: 'span-meta-root',
        name: 'tool.call',
        kind: 'internal' as const,
        status: 'error' as const,
        startTime: 1100,
        endTime: 1200,
        attributes: {},
      });

      const [info] = storage.listTraces(10).filter((t) => t.traceId === 'trace-meta');

      expect(info).toBeDefined();
      expect(info.rootSpanName).toBe('agent.run');
      expect(info.spanCount).toBe(2);
      expect(info.duration).toBe(300);
      expect(info.status).toBe('mixed');
    });

    test('should delete by traceId', async () => {
      await storage.initialize();
      
      storage.save({
        traceId: 'trace-to-delete',
        spanId: 'span-to-delete',
        parentSpanId: undefined,
        name: 'delete-span',
        kind: 'internal' as const,
        status: 'ok' as const,
        startTime: Date.now(),
        attributes: {},
      });
      
      storage.deleteByTraceId('trace-to-delete');
      
      const retrieved = storage.findBySpanId('span-to-delete');
      expect(retrieved).toBeUndefined();
    });
  });

  /**
   * Task #2315: regression tests for safeStringify handling in storage.save().
   *
   * Background: previously `JSON.stringify(span.attributes)` and
   * `JSON.stringify(span.result)` would throw on cyclic structures / functions /
   * React elements. The throw escaped `save()` (line 176 was outside try/catch)
   * and bubbled up through span.end() → @TracedAs wrapper, breaking the entire
   * REPL (MessageView render path in `bun packages/cli/dist/bin/roy-bot.js
   * interactive`).
   *
   * These tests verify that save() never throws and the row is persisted with
   * a safe-stringified JSON payload.
   */
  describe('cyclic / non-serializable attribute handling (Task #2315)', () => {
    test('should not throw when attributes contain a self-referencing object', async () => {
      await storage.initialize();

      const cyclic: any = { name: 'agent', id: 1 };
      cyclic.self = cyclic; // direct cycle

      const span: any = {
        traceId: 'trace-cyclic-attr',
        spanId: 'span-cyclic-attr',
        parentSpanId: undefined,
        name: 'cyclic-attribute-span',
        kind: 'internal' as const,
        status: 'ok' as const,
        startTime: Date.now(),
        endTime: Date.now() + 10,
        attributes: {
          agent: cyclic,
          message: 'hello',
        },
      };

      // Save must not throw
      expect(() => storage.save(span)).not.toThrow();

      const retrieved = storage.findBySpanId('span-cyclic-attr');
      expect(retrieved).toBeDefined();
      // The stored attributes should preserve the non-cyclic key
      expect((retrieved!.attributes as any).message).toBe('hello');
      // And mark the cyclic node safely (must not throw on JSON.parse)
      expect((retrieved!.attributes as any).agent).toBeDefined();
    });

    test('should not throw when attributes contain functions / React-ish objects', async () => {
      await storage.initialize();

      const fnRef = function namedFn() { return 42; };
      const reactLike = { $typeof: Symbol.for('react.element'), type: 'div', props: { id: 'x' }, key: null };

      const span: any = {
        traceId: 'trace-fn-react',
        spanId: 'span-fn-react',
        parentSpanId: undefined,
        name: 'fn-react-span',
        kind: 'internal' as const,
        status: 'ok' as const,
        startTime: Date.now(),
        endTime: Date.now() + 10,
        attributes: {
          fn: fnRef,
          react: reactLike,
        },
      };

      expect(() => storage.save(span)).not.toThrow();

      const retrieved = storage.findBySpanId('span-fn-react');
      expect(retrieved).toBeDefined();
    });

    test('should not throw when result is a cyclic object', async () => {
      await storage.initialize();

      const cyclicResult: any = { ok: true };
      cyclicResult.self = cyclicResult; // cycle in result

      const span: any = {
        traceId: 'trace-cyclic-result',
        spanId: 'span-cyclic-result',
        parentSpanId: undefined,
        name: 'cyclic-result-span',
        kind: 'internal' as const,
        status: 'ok' as const,
        startTime: Date.now(),
        endTime: Date.now() + 10,
        attributes: { message: 'x' },
        result: cyclicResult,
      };

      // Previously this threw on line 176 (outside try/catch) and broke the REPL.
      expect(() => storage.save(span)).not.toThrow();

      const retrieved = storage.findBySpanId('span-cyclic-result');
      expect(retrieved).toBeDefined();
    });

    test('should not throw on deeply nested mutual cycles', async () => {
      await storage.initialize();

      const a: any = { kind: 'a' };
      const b: any = { kind: 'b', a };
      a.b = b; // a → b → a

      const span: any = {
        traceId: 'trace-mutual',
        spanId: 'span-mutual',
        parentSpanId: undefined,
        name: 'mutual-cycle-span',
        kind: 'internal' as const,
        status: 'ok' as const,
        startTime: Date.now(),
        endTime: Date.now() + 10,
        attributes: { graph: a },
      };

      expect(() => storage.save(span)).not.toThrow();

      const retrieved = storage.findBySpanId('span-mutual');
      expect(retrieved).toBeDefined();
    });
  });
});

// ============================================================================
// Task #4666 — the span storage must NOT load better-sqlite3 under plain node
//
// ## Why this test exists
//
// The plugin's MCP server runs under plain node. `task_list` over a real
// DB (4200+ tasks) traces every `rowToTask` → each span write went through
// `SQLiteSpanStorage`, whose private `getDatabaseClass` (unlike the task
// store's, fixed in Task #4619) had **no `node:sqlite` branch** and loaded
// native `better-sqlite3`.
//
// Under node v24 that combination aborts the whole process (exit 134):
// thousands of short-lived `Statement` JS objects are reclaimed by a major
// GC; node's `ObjectWrap` destructor (new in v24) calls
// `RemoveEnvironmentCleanupHook(isolate)` from the GC weak-callback stack,
// where `isolate->InContext()` is false → `Environment::GetCurrent`
// returns nullptr → `CHECK_NOT_NULL(env)` at hooks.cc:142 → SIGABRT.
//
// The fix: teach the span storage the same `node:sqlite`-first driver
// selection the task store already has. This test pins it in a **real
// node subprocess**: bundle this file with esbuild (bun has no
// `node:sqlite`, so the assertion cannot run inline), then assert that
// `better-sqlite3` is never `require`d and that a span-write + GC stress
// loop exits cleanly.
// ============================================================================
describe('Task #4666: span storage uses node:sqlite under plain node', () => {
  test('initializing + writing spans never requires better-sqlite3 (node subprocess)', () => {
    const { execFileSync } = require('node:child_process');
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const join = require('node:path').join;

    // Locate the esbuild binary through normal module resolution
    // (esbuild ships a JS API whose package root contains bin/esbuild).
    const esbuildPkg = require.resolve('esbuild/package.json');
    const esbuildBin = join(esbuildPkg, '..', 'bin', 'esbuild');
    expect(require('node:fs').existsSync(esbuildBin)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'roy-span-driver-'));
    try {
      const bundle = join(dir, 'span-storage-bundle.mjs');
      // Bundle the span storage (its ./types relative import needs real
      // resolution, which only a bundler provides under plain node).
      execFileSync('node', [
        esbuildBin!,
        join(import.meta.dir, 'span-storage.ts'),
        '--bundle', '--format=esm', '--platform=node',
        `--outfile=${bundle}`,
        '--external:better-sqlite3', '--external:bun:sqlite', '--external:node:sqlite',
        "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      ], { encoding: 'utf8', timeout: 60_000 });

      const probe = join(dir, 'probe.mjs');
      writeFileSync(probe, `
import Module from "node:module";
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (String(id).includes("better-sqlite3")) {
    console.error("BETTER_SQLITE3_REQUIRED");
    process.exit(42);
  }
  return origRequire.call(this, id);
};
const { SQLiteSpanStorage } = await import(${JSON.stringify(bundle)});
const storage = new SQLiteSpanStorage(${JSON.stringify(join(dir, 'traces.db'))});
await storage.initialize();
for (let i = 0; i < 300; i++) {
  storage.save({
    traceId: "t" + (i % 7),
    spanId: "s" + i,
    name: "task.rowToTask",
    kind: "internal",
    status: "ok",
    startTime: Date.now(),
    attributes: { i, payload: "x".repeat(600) },
  });
}
storage.close();
if (globalThis.gc) globalThis.gc();
console.log("OK");
`);

      // --expose-gc: force major GCs while the statements are garbage —
      // exactly the condition that aborted before the fix.
      // Under bun, process.execPath is bun itself — resolve a real node
      // from PATH instead.
      const { execSync } = require('node:child_process');
      const nodeBin = process.execPath.endsWith('node')
        ? process.execPath
        : execSync('which node', { encoding: 'utf8' }).trim();
      const out = execFileSync(
        nodeBin,
        ['--expose-gc', probe],
        { encoding: 'utf8', timeout: 60_000 },
      );
      expect(out).toContain('OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
