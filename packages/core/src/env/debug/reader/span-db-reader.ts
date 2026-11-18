/**
 * @fileoverview Span DB Reader - Read spans from SQLite database
 * 
 * This reader fetches trace data directly from SQLite span storage,
 * which is used for persisting spans in production environments.
 */

import type { TraceEntry, TraceIdInfo, TraceSummary } from '../types';
import type { Span, SpanStorage } from '../../log-trace/types';

// ============================================================================
// SpanDbReader
// ============================================================================

/**
 * Options for SpanDbReader
 */
export interface SpanDbReaderOptions {
  /** Database path (for file-based SQLite) */
  dbPath?: string;
  /** Storage instance to use directly */
  storage?: SpanStorage;
}

/**
 * Span Database Reader
 * 
 * Reads span data from SQLite storage for trace debugging and analysis.
 */
export class SpanDbReader {
  private storage: SpanStorage | null = null;
  private dbPath: string | null = null;
  private sqliteDb: any = null;

  constructor(options?: SpanDbReaderOptions) {
    if (options?.storage) {
      this.storage = options.storage;
    } else if (options?.dbPath) {
      this.dbPath = options.dbPath;
    }
  }

  /**
   * Initialize the reader with storage
   */
  async initialize(): Promise<void> {
    if (this.storage) {
      await this.storage.initialize();
    } else if (this.dbPath) {
      // Lazy load SQLite storage
      await this.initSqliteStorage();
    }
  }

  /**
   * Initialize SQLite storage directly
   */
  private async initSqliteStorage(): Promise<void> {
    try {
      // Dynamic import to avoid hard dependency
      const { SQLiteSpanStorage } = await import('../../log-trace/span-storage');
      this.storage = new SQLiteSpanStorage(this.dbPath!);
      await this.storage.initialize();
    } catch (error) {
      throw new Error(`Failed to initialize SQLite storage: ${error}`);
    }
  }

  /**
   * Get trace entries for a specific traceId
   */
  async getTraceEntries(traceId: string): Promise<TraceEntry[]> {
    if (!this.storage) {
      throw new Error('Storage not initialized. Call initialize() first.');
    }

    const spans = this.storage.findByTraceId(traceId);
    if (spans.length === 0) {
      return [];
    }

    // Convert spans to TraceEntry format
    return this.spansToEntries(spans);
  }

  /**
   * List all trace IDs
   */
  async listTraceIds(limit: number = 20): Promise<TraceSummary> {
    if (!this.storage) {
      throw new Error('Storage not initialized. Call initialize() first.');
    }

    const traceInfos = this.storage.listTraces(limit);
    
    const traceIds: TraceIdInfo[] = traceInfos.map(info => ({
      traceId: info.traceId,
      firstTime: new Date(info.startTime).toISOString(),
      lastTime: info.endTime ? new Date(info.endTime).toISOString() : undefined,
      count: info.spanCount,
    }));

    return {
      traceIds,
      count: traceInfos.length,
    };
  }

  /**
   * Convert spans to TraceEntry format
   * 
   * Now properly extracts spanId and parentSpanId for tree building
   */
  private spansToEntries(spans: Span[]): TraceEntry[] {
    const entries: TraceEntry[] = [];

    // Create entries for each span (enter event)
    for (const span of spans) {
      entries.push({
        traceId: span.traceId,
        timestamp: new Date(span.startTime).toISOString(),
        function: span.name,
        action: 'enter',
        params: this.attributesToParams(span.attributes),
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
      });

      if (span.endTime) {
        entries.push({
          traceId: span.traceId,
          timestamp: new Date(span.endTime).toISOString(),
          function: span.name,
          action: 'quit',
          result: span.result,
          error: span.error,
          durationMs: span.endTime - span.startTime,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
        });
      }
    }

    // Sort by timestamp
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return entries;
  }

  /**
   * Convert span attributes to params format
   */
  private attributesToParams(attributes: Record<string, unknown> | undefined): unknown[] {
    if (!attributes) return [];
    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value,
    }));
  }

  /**
   * Get the underlying storage
   */
  getStorage(): SpanStorage | null {
    return this.storage;
  }

  /**
   * Close the reader and cleanup resources
   */
  close(): void {
    if (this.storage) {
      this.storage.close();
      this.storage = null;
    }
    if (this.sqliteDb) {
      this.sqliteDb.close();
      this.sqliteDb = null;
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a SpanDbReader from a database path
 */
export async function createSpanDbReader(dbPath: string): Promise<SpanDbReader> {
  const reader = new SpanDbReader({ dbPath });
  await reader.initialize();
  return reader;
}

/**
 * Create a SpanDbReader from an existing storage instance
 */
export function createSpanDbReaderFromStorage(storage: SpanStorage): SpanDbReader {
  return new SpanDbReader({ storage });
}
