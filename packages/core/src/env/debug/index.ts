/**
 * @fileoverview Debug Component Index
 * 
 * Export all debug-related types and classes.
 */

// Types
export type {
  TraceEntry,
  TraceTreeNode,
  ParserOptions,
  LogDiscoveryOptions,
  ParsedLogLine,
  TraceIdInfo,
  TraceSummary,
  FormatOptions,
  TraceAction,
  LogLevel,
} from './types';

// Data source types (defined in debug-component.ts)
export type { TraceDataSource, TraceParserOptions } from './debug-component';

// Components
export { DebugComponent } from './debug-component';

// Reader
export { LogReader } from './reader/log-reader';
export { SpanDbReader } from './reader/span-db-reader';

// Parser
export { RegexParser } from './parser/regex-parser';
export { SpanBuilder } from './parser/span-builder';

// Formatters
export { TraceFormatter } from './formatters/trace-formatter';
export { TreeFormatter } from './formatters/tree-formatter';
export { ReplFormatter } from './formatters/repl-formatter';
