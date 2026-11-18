/**
 * @fileoverview SpanDbReader Test
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SpanDbReader } from './span-db-reader';
import { SQLiteSpanStorage } from '../../log-trace/span-storage';
import type { Span } from '../../log-trace/types';
import { SpanKind, SpanStatus } from '../../log-trace/types';
import * as fs from 'fs';
import * as path from 'path';

// Test data
const testSpan1: Span = {
  traceId: 'trace_test_001',
  spanId: 'span_1',
  name: 'testFunction',
  kind: SpanKind.INTERNAL,
  status: SpanStatus.OK,
  startTime: Date.now() - 1000,
  endTime: Date.now(),
  attributes: { arg1: 'value1', arg2: 123 },
  children: [],
};

const testSpan2: Span = {
  traceId: 'trace_test_002',
  spanId: 'span_2',
  name: 'anotherFunction',
  kind: SpanKind.INTERNAL,
  status: SpanStatus.OK,
  startTime: Date.now() - 500,
  endTime: Date.now() - 100,
  attributes: {},
  children: [],
};

describe('SpanDbReader', () => {
  let storage: SQLiteSpanStorage;
  let reader: SpanDbReader;
  let tempDbPath: string;

  beforeAll(async () => {
    // 清除环境变量中的 trace context，避免继承外部上下文
    delete process.env['TRACEPARENT'];
    delete process.env['TRACE_ID'];
    delete process.env['LOG_TRACE_REQUEST_ID'];
    
    // Create temporary database file
    tempDbPath = `/tmp/test_span_db_${Date.now()}.sqlite`;
    storage = new SQLiteSpanStorage(tempDbPath);
    await storage.initialize();

    // Insert test data
    storage.save(testSpan1);
    storage.save(testSpan2);

    // Create reader with storage
    reader = new SpanDbReader({ storage });
  });

  afterAll(() => {
    reader.close();
    storage.close();
    // Cleanup temp file
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  test('should list trace IDs', async () => {
    const summary = await reader.listTraceIds(10);

    expect(summary.count).toBeGreaterThanOrEqual(2);
    expect(summary.traceIds.length).toBeGreaterThanOrEqual(2);

    const traceIds = summary.traceIds.map(t => t.traceId);
    expect(traceIds).toContain('trace_test_001');
    expect(traceIds).toContain('trace_test_002');
  });

  test('should get trace entries by traceId', async () => {
    const entries = await reader.getTraceEntries('trace_test_001');

    expect(entries.length).toBeGreaterThanOrEqual(2); // enter and quit
    expect(entries[0].traceId).toBe('trace_test_001');
    expect(entries[0].function).toBe('testFunction');
    expect(entries[0].action).toBe('enter');
  });

  test('should return empty array for non-existent trace', async () => {
    const entries = await reader.getTraceEntries('non_existent_trace');
    expect(entries).toHaveLength(0);
  });

  test('should limit trace list', async () => {
    const summary = await reader.listTraceIds(1);
    expect(summary.traceIds.length).toBeLessThanOrEqual(1);
  });
});

describe('SpanDbReader with dbPath', () => {
  test('should initialize from dbPath', async () => {
    const tempPath = `/tmp/test_span_db_${Date.now()}.sqlite`;
    const reader = new SpanDbReader({ dbPath: tempPath });
    
    await reader.initialize();
    
    expect(reader.getStorage()).toBeTruthy();
    
    reader.close();
    
    // Cleanup
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  });
});
