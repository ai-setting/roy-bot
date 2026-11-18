/**
 * @fileoverview Debug Component
 * 
 * Provides debugging capabilities for roy-bot applications by parsing
 * trace logs and presenting formatted output.
 */

import { BaseComponent, type ComponentConfig } from '../component';
import { LogReader } from './reader/log-reader';
import { SpanDbReader } from './reader/span-db-reader';
import { RegexParser } from './parser/regex-parser';
import { SpanBuilder } from './parser/span-builder';
import { TraceFormatter, TreeFormatter } from './formatters';
import type { 
  ParserOptions, 
  TraceEntry, 
  TraceTreeNode, 
  TraceIdInfo,
  TraceSummary,
  FormatOptions
} from './types';

/**
 * Data source type for trace retrieval
 */
export type TraceDataSource = 'log' | 'sqlite';

/**
 * Extended parser options with data source support
 */
export interface TraceParserOptions extends ParserOptions {
  /** Data source type: 'log' (default) or 'sqlite' */
  source?: TraceDataSource;
  /** SQLite database path (required when source is 'sqlite') */
  dbPath?: string;
}

/**
 * DebugComponent configuration options
 */
export interface DebugComponentOptions {
  /** Log directory path */
  logDir?: string;
  /** Default log file */
  defaultLogFile?: string;
}

/**
 * Debug Component for trace analysis and debugging
 */
export class DebugComponent extends BaseComponent {
  name = 'debug';
  version = '1.0.0';

  private reader: LogReader;
  private spanDbReader: SpanDbReader | null = null;
  private parser: RegexParser;
  private spanBuilder: SpanBuilder;
  private traceFormatter: TraceFormatter;
  private treeFormatter: TreeFormatter;
  private options: DebugComponentOptions;

  constructor(options?: DebugComponentOptions) {
    super();
    this.options = options || {};
    this.reader = new LogReader({ logDir: this.options.logDir });
    this.parser = new RegexParser();
    this.spanBuilder = new SpanBuilder();
    this.traceFormatter = new TraceFormatter();
    this.treeFormatter = new TreeFormatter();
  }

  /**
   * Initialize the span database reader
   */
  async initSpanDbReader(dbPath?: string): Promise<void> {
    if (!this.spanDbReader) {
      this.spanDbReader = new SpanDbReader({ dbPath });
      await this.spanDbReader.initialize();
    }
  }

  /**
   * Get the span database reader
   */
  getSpanDbReader(): SpanDbReader | null {
    return this.spanDbReader;
  }

  // =========================================================================
  // Live Trace Methods (from Tracer storage)
  // =========================================================================

  /**
   * Get trace by ID from live Tracer storage
   * 
   * This method retrieves traces directly from the Tracer's span storage,
   * which includes spans from the current session that may not yet be persisted
   * to log files.
   */
  async getLiveTrace(traceId: string): Promise<any | null> {
    try {
      // Import OTel TracerProvider utilities dynamically to avoid circular dependencies
      const { getTracerProvider } = await import('../log-trace/opentelemetry/tracer-provider');
      const provider = getTracerProvider();
      
      if (!provider.isInitialized()) {
        await provider.initialize();
      }

      // Get storage directly from provider
      const storage = provider.getStorage();
      
      // Get all spans for this trace
      const spans = storage.findByTraceId(traceId);
      
      if (spans.length === 0) {
        return null;
      }

      // Flatten spans for call tree building
      const flattenSpans = (spanList: any[]): any[] => {
        const result: any[] = [];
        for (const span of spanList) {
          result.push({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            function: span.name,
            action: 'enter' as const,
            timestamp: new Date(span.startTime).toISOString(),
            params: Object.entries(span.attributes || {}).map(([k, v]: [string, any]) => ({ key: k, value: v })),
          });
          if (span.children && span.children.length > 0) {
            result.push(...flattenSpans(span.children));
          }
        }
        return result;
      };

      // Convert tree structure to flat entries for TraceEntry
      const flatSpans = flattenSpans(spans);
      const tree = this.spanBuilder.buildCallTree(flatSpans);

      // Get root spans (spans without parentSpanId in original list)
      const rootSpans = spans.filter((s: any) => !s.parentSpanId);

      return {
        traceId,
        spans,
        callTree: tree,
        spanCount: flatSpans.length,
        rootSpans,
      };
    } catch (error) {
      console.error('Failed to get trace from live storage:', error);
      return null;
    }
  }

  /**
   * List all available traces from live Tracer storage
   */
  async listLiveTraces(limit: number = 20): Promise<any> {
    try {
      // Import OTel TracerProvider utilities dynamically to avoid circular dependencies
      const { getTracerProvider } = await import('../log-trace/opentelemetry/tracer-provider');
      const provider = getTracerProvider();
      
      if (!provider.isInitialized()) {
        await provider.initialize();
      }

      // Get storage directly from provider
      const storage = provider.getStorage();
      const traces = storage.listTraces(limit);
      
      return {
        traces,
        count: traces.length,
      };
    } catch (error) {
      console.error('Failed to list live traces:', error);
      return { traces: [], count: 0 };
    }
  }

  /**
   * Format a live trace for display
   */
  async formatLiveTrace(traceId: string): Promise<string> {
    try {
      // Import OTel TracerProvider utilities dynamically to avoid circular dependencies
      const { getTracerProvider } = await import('../log-trace/opentelemetry/tracer-provider');
      const provider = getTracerProvider();
      
      if (!provider.isInitialized()) {
        await provider.initialize();
      }

      // Get storage directly from provider
      const storage = provider.getStorage();
      const spans = storage.findByTraceId(traceId);
      
      if (spans.length === 0) {
        return `No trace found for traceId: ${traceId}`;
      }

      // Flatten spans for formatting
      const flattenSpans = (spanList: any[]): any[] => {
        const result: any[] = [];
        for (const span of spanList) {
          result.push({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            function: span.name,
            action: 'enter' as const,
            timestamp: new Date(span.startTime).toISOString(),
            params: Object.entries(span.attributes || {}).map(([k, v]: [string, any]) => ({ key: k, value: v })),
          });
          if (span.children && span.children.length > 0) {
            result.push(...flattenSpans(span.children));
          }
        }
        return result;
      };

      const flatSpans = flattenSpans(spans);
      const tree = this.spanBuilder.buildCallTree(flatSpans);

      // Handle null case (no valid tree structure)
      if (!tree) {
        return 'No trace structure found';
      }

      // Use treeFormatter to format the call tree
      return this.treeFormatter.formatTree(tree);
    } catch (error) {
      return `Failed to format trace: ${error}`;
    }
  }

  /**
   * Initialize the component
   */
  async init(config?: ComponentConfig): Promise<void> {
    await super.init(config);
    this.setStatus('running');
  }

  /**
   * Stop the component
   */
  async stop(): Promise<void> {
    this.setStatus('stopping');
    // Cleanup if needed
    this.setStatus('stopped');
  }

  /**
   * Get traces matching the options
   */
  async getTraces(options?: TraceParserOptions): Promise<TraceEntry[]> {
    // Use SQLite data source if specified
    if (options?.source === 'sqlite') {
      return this.getTracesFromSqlite(options);
    }

    // Default: use log file
    const logFile = options?.logFile || this.reader.getLogPath();
    
    // Read and filter log lines
    const lines: string[] = [];
    for await (const line of this.reader.readLines(logFile, options)) {
      // Filter by function name if specified
      if (options?.function && !line.includes(options.function)) {
        continue;
      }
      // Filter by traceId if specified
      if (options?.traceId && !line.includes(`requestId=${options.traceId}`)) {
        continue;
      }
      // Only include trace lines
      if (this.parser.isTraceLine(line)) {
        lines.push(line);
      }
    }

    // Parse lines
    const parsedLines = this.parser.parseLines(lines);

    // Build trace entries
    const entries = this.spanBuilder.buildTraceEntries(parsedLines);

    // Filter by function name at entry level
    let filteredEntries = entries;
    if (options?.function) {
      filteredEntries = entries.filter(e => 
        e.function.includes(options.function!)
      );
    }

    // Pair enter/quit and calculate duration
    const paired = this.spanBuilder.pairEnterQuit(filteredEntries);
    
    // Build flat list with duration info
    const result: TraceEntry[] = [];
    for (const span of paired) {
      result.push({
        ...span.enter,
        durationMs: span.durationMs,
      });
      if (span.quit) {
        result.push({
          ...span.quit,
          durationMs: span.durationMs,
        });
      }
    }

    return result;
  }

  /**
   * Get traces from SQLite database
   */
  private async getTracesFromSqlite(options?: TraceParserOptions): Promise<TraceEntry[]> {
    if (!options?.traceId) {
      return [];
    }

    await this.initSpanDbReader(options.dbPath);
    const reader = this.getSpanDbReader();
    
    if (!reader) {
      throw new Error('Failed to initialize span database reader');
    }

    const entries = await reader.getTraceEntries(options.traceId);

    // Filter by function name if specified
    if (options?.function) {
      return entries.filter(e => e.function.includes(options.function!));
    }

    return entries;
  }

  /**
   * List available trace IDs
   */
  async listTraceIds(options?: TraceParserOptions & { limit?: number }): Promise<TraceSummary> {
    // Use SQLite data source if specified
    if (options?.source === 'sqlite') {
      return this.listTraceIdsFromSqlite(options);
    }

    // Default: use log file
    const logFile = options?.logFile || this.reader.getLogPath();
    const limit = options?.limit || 20;

    // Map to store trace info
    const traceMap = new Map<string, { firstTime: string; lastTime: string; count: number }>();

    // Read all trace lines
    for await (const line of this.reader.readLines(logFile, options)) {
      if (!this.parser.isTraceLine(line)) continue;

      const parsed = this.parser.parseLogLine(line);
      if (!parsed) continue;

      // Extract traceId or generate virtual one
      const traceId = this.parser.extractTraceId(line) || 
        this.spanBuilder.generateVirtualTraceId(parsed.method, parsed.timestamp);

      const existing = traceMap.get(traceId);
      if (existing) {
        existing.lastTime = parsed.timestamp;
        existing.count++;
      } else {
        traceMap.set(traceId, {
          firstTime: parsed.timestamp,
          lastTime: parsed.timestamp,
          count: 1,
        });
      }
    }

    // Convert to array and sort by first time (most recent first)
    const traceIds: TraceIdInfo[] = [];
    for (const [traceId, info] of traceMap.entries()) {
      traceIds.push({
        traceId,
        firstTime: info.firstTime,
        lastTime: info.lastTime,
        count: info.count,
      });
    }

    traceIds.sort((a, b) => b.firstTime.localeCompare(a.firstTime));

    return {
      traceIds: traceIds.slice(0, limit),
      count: traceIds.length,
    };
  }

  /**
   * List trace IDs from SQLite database
   */
  private async listTraceIdsFromSqlite(options?: TraceParserOptions & { limit?: number }): Promise<TraceSummary> {
    const limit = options?.limit || 20;

    await this.initSpanDbReader(options?.dbPath);
    const reader = this.getSpanDbReader();
    
    if (!reader) {
      throw new Error('Failed to initialize span database reader');
    }

    return reader.listTraceIds(limit);
  }

  /**
   * Get call tree for a specific trace
   */
  async getCallTree(options?: TraceParserOptions): Promise<TraceTreeNode | null> {
    if (!options?.traceId) {
      return null;
    }

    // Get all traces for this traceId
    const traces = await this.getTraces({
      ...options,
      traceId: options.traceId,
    });

    if (traces.length === 0) {
      return null;
    }

    return this.spanBuilder.buildCallTree(traces);
  }

  /**
   * Get the log reader instance
   */
  getReader(): LogReader {
    return this.reader;
  }

  /**
   * Get the parser instance
   */
  getParser(): RegexParser {
    return this.parser;
  }

  /**
   * Get the span builder instance
   */
  getSpanBuilder(): SpanBuilder {
    return this.spanBuilder;
  }

  /**
   * Get the trace formatter instance
   */
  getTraceFormatter(): TraceFormatter {
    return this.traceFormatter;
  }

  /**
   * Get the tree formatter instance
   */
  getTreeFormatter(): TreeFormatter {
    return this.treeFormatter;
  }

  // =========================================================================
  // Formatting Methods
  // =========================================================================

  /**
   * Format traces for display
   */
  formatTraces(entries: TraceEntry[], options?: FormatOptions): string {
    return this.traceFormatter.formatEntries(entries, options);
  }

  /**
   * Format a single trace entry
   */
  formatTraceEntry(entry: TraceEntry, options?: FormatOptions): string {
    return this.traceFormatter.formatEntry(entry, options);
  }

  /**
   * Format traces as JSON
   */
  tracesToJSON(entries: TraceEntry[]): string {
    return this.traceFormatter.toJSON(entries);
  }

  /**
   * Format traces as summary
   */
  tracesToSummary(entries: TraceEntry[]): string {
    return this.traceFormatter.toSummary(entries);
  }

  /**
   * Format call tree for display
   */
  formatTree(node: TraceTreeNode): string {
    return this.treeFormatter.formatTree(node);
  }

  /**
   * Format multiple call trees
   */
  formatTrees(trees: TraceTreeNode[]): string {
    return this.treeFormatter.formatTrees(trees);
  }

  /**
   * Format trees as JSON
   */
  treesToJSON(trees: TraceTreeNode[]): string {
    return this.treeFormatter.toJSON(trees);
  }

  /**
   * Format tree summary (sorted by duration)
   */
  formatTreeSummary(node: TraceTreeNode): string {
    return this.treeFormatter.formatSummary(node);
  }

  /**
   * Format tree with timeline visualization
   */
  formatTreeTimeline(node: TraceTreeNode): string {
    return this.treeFormatter.formatTimeline(node);
  }
}
