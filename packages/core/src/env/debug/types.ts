/**
 * @fileoverview Debug Component Types
 * 
 * Type definitions for trace parsing, formatting, and debugging utilities.
 */

// ============================================================================
// Core Trace Types
// ============================================================================

/**
 * Trace action type
 */
export type TraceAction = 'enter' | 'quit' | 'error';

/**
 * Log level type
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Trace entry representing a single log line with trace info
 */
export interface TraceEntry {
  /** Unique request/trace identifier */
  traceId: string;
  /** Timestamp of the entry (ISO format) */
  timestamp: string;
  /** Function/method name */
  function: string;
  /** Action type: enter, quit, or error */
  action: TraceAction;
  /** Parameters (for enter action) */
  params?: unknown[];
  /** Result (for quit action) */
  result?: unknown;
  /** Error message (for error action) */
  error?: string;
  /** Calculated duration in milliseconds (for quit action) */
  durationMs?: number;
  /** Span ID (for SQLite spans) */
  spanId?: string;
  /** Parent span ID (for SQLite spans) */
  parentSpanId?: string;
}

/**
 * Call tree node for hierarchical trace visualization
 */
export interface TraceTreeNode {
  /** Unique request/trace identifier */
  traceId: string;
  /** Function/method name */
  function: string;
  /** Start timestamp */
  startTime: string;
  /** End timestamp (for completed nodes) */
  endTime?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Child nodes */
  children: TraceTreeNode[];
  /** Original trace entry (optional for programmatically created nodes) */
  entry?: TraceEntry;
  /** Span ID (for SQLite spans) */
  spanId?: string;
  /** Parent span ID (for SQLite spans) */
  parentSpanId?: string;
}

// ============================================================================
// Parser Types
// ============================================================================

/**
 * Options for parsing logs
 */
export interface ParserOptions {
  /** Log file path to read */
  logFile?: string;
  /** Filter by trace ID */
  traceId?: string;
  /** Filter by function name (supports partial match) */
  function?: string;
  /** Start time filter (ISO format or relative like "1h") */
  since?: string;
  /** End time filter (ISO format) */
  until?: string;
  /** Log level filter */
  level?: LogLevel;
}

/**
 * Options for log discovery
 */
export interface LogDiscoveryOptions {
  /** Log directory to search */
  logDir?: string;
  /** File pattern to match */
  pattern?: string;
}

/**
 * Parsed log line with extracted fields
 */
export interface ParsedLogLine {
  /** Original log line */
  raw: string;
  /** Timestamp extracted from log */
  timestamp: string;
  /** Log level (INFO, DEBUG, WARN, ERROR) */
  level: string;
  /** Source file/location */
  source: string;
  /** Category (traced:...) */
  category: string;
  /** Action symbol (>>> or <<< or !!!) */
  action: string;
  /** Method/function name */
  method: string;
  /** Action type (enter, quit, error) */
  actionType: TraceAction;
  /** Raw arguments string */
  rawArgs: string;
  /** Request ID extracted from log (if present) */
  requestId: string | null;
}

// ============================================================================
// Info Types
// ============================================================================

/**
 * Trace ID information summary
 */
export interface TraceIdInfo {
  /** Trace ID */
  traceId: string;
  /** First occurrence timestamp */
  firstTime: string;
  /** Last occurrence timestamp */
  lastTime?: string;
  /** Number of entries for this trace */
  count: number;
}

// ============================================================================
// Formatter Types
// ============================================================================

/**
 * Output format options
 */
export interface FormatOptions {
  /** Use pretty printing */
  pretty?: boolean;
  /** Maximum depth for recursive objects */
  maxDepth?: number;
  /** Include raw data */
  includeRaw?: boolean;
}

/**
 * Trace summary for list output
 */
export interface TraceSummary {
  /** List of trace ID info */
  traceIds: TraceIdInfo[];
  /** Total count */
  count: number;
}
