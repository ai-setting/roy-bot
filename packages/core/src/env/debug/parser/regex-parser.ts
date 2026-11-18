/**
 * @fileoverview Regex Parser for Log Lines
 * 
 * Parses log files with trace format:
 * [TRACE] >>> {method} enter: {args}
 * [TRACE] <<< {method} quit: {result}
 * [TRACE] !!! {method} error: {error}
 */

import type { ParsedLogLine, LogLevel, TraceAction } from '../types';

/**
 * Regex pattern for parsing trace log lines
 * 
 * Format: {Timestamp} [{Level}] [{Source}][{Category}] [TRACE] {Action} {Method} [{requestId}] {actionName} {ActionType}: {Args}
 * Examples:
 *   >>> processRequest enter: (user query)
 *   >>> llm.invoke [requestId=req_abc] enter: ["hello"]
 *   <<< llm.invoke [requestId=req_abc] quit: {"ok":true}
 * 
 * The requestId can appear in either:
 * 1. Category field: [source][requestId=req_123]
 * 2. After method name: [requestId=req_abc]
 */
const TRACE_LINE_REGEX = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+\[(\w+)\]\s+\[([^\]]*)\]\[([^\]]*)\]\s+\[TRACE\]\s+(>>>|<<<|!!!)\s+(.+?)(?:\s+\[requestId=([^\]]+)\])?\s+(enter|quit|error):\s+(.*)$/;

/**
 * Extract requestId from category field (e.g., "[source][requestId=req_123]" -> "req_123")
 */
const REQUEST_ID_IN_CATEGORY_REGEX = /\[requestId=([^\]]+)\]/;

/**
 * Regex Parser for trace log lines
 */
export class RegexParser {
  /**
   * Parse a single log line
   */
  parseLogLine(line: string): ParsedLogLine | null {
    const trimmedLine = line.trim();
    
    if (!trimmedLine) {
      return null;
    }

    const match = trimmedLine.match(TRACE_LINE_REGEX);
    
    if (!match) {
      return null;
    }

    const [, timestamp, level, source, category, action, method, requestId, actionType, rawArgs] = match;

    return {
      raw: trimmedLine,
      timestamp: timestamp.replace(' ', 'T'), // Normalize to ISO format
      level,
      source,
      category,
      action,
      method,
      actionType: actionType as TraceAction,
      rawArgs,
      requestId: requestId || null, // Store requestId if present
    };
  }

  /**
   * Parse arguments from raw args string
   */
  parseArgs(raw: string): unknown | unknown[] | null {
    if (!raw || !raw.trim()) {
      return null;
    }

    const trimmed = raw.trim();

    // Try parsing as JSON
    try {
      const parsed = JSON.parse(trimmed);
      
      // If it's an array, return as-is
      if (Array.isArray(parsed)) {
        return parsed;
      }
      
      // If it's an object, return as-is
      return parsed;
    } catch {
      // Not valid JSON, return as string
      return trimmed;
    }
  }

  /**
   * Check if a line is a trace line
   */
  isTraceLine(line: string): boolean {
    return line.includes('[TRACE]') && 
           (line.includes('>>>') || line.includes('<<<') || line.includes('!!!'));
  }

  /**
   * Filter lines by log level
   */
  filterByLevel(lines: string[], level?: LogLevel): string[] {
    if (!level) {
      return lines;
    }

    const levelPattern = `[${level.toUpperCase()}]`;
    
    return lines.filter(line => {
      // First check if it's a trace line
      if (!this.isTraceLine(line)) {
        return false;
      }
      // Then check level
      return line.includes(levelPattern);
    });
  }

  /**
   * Filter lines by function name
   */
  filterByFunction(lines: string[], functionName?: string): string[] {
    if (!functionName) {
      return lines;
    }

    return lines.filter(line => {
      // Check if the function name appears in the trace line
      return line.includes(functionName);
    });
  }

  /**
   * Extract trace ID from log line
   * Checks for requestId in two places:
   * 1. Category field: [source][requestId=req_123]
   * 2. After method name: [requestId=req_abc]
   */
  extractTraceId(line: string): string | null {
    // First try: look for requestId in category field
    const categoryMatch = line.match(REQUEST_ID_IN_CATEGORY_REGEX);
    if (categoryMatch) {
      return categoryMatch[1];
    }
    
    // Second try: use main regex to extract requestId after method name
    const match = line.match(TRACE_LINE_REGEX);
    if (match && match[7]) {
      return match[7];
    }
    
    return null;
  }

  /**
   * Extract trace IDs from multiple lines
   */
  extractTraceIds(lines: string[]): Map<string, string[]> {
    const traceIdMap = new Map<string, string[]>();

    for (const line of lines) {
      if (!this.isTraceLine(line)) continue;

      const traceId = this.extractTraceId(line);
      const parsed = this.parseLogLine(line);
      
      if (traceId && parsed) {
        const existing = traceIdMap.get(traceId) || [];
        existing.push(line);
        traceIdMap.set(traceId, existing);
      }
    }

    return traceIdMap;
  }

  /**
   * Parse multiple lines
   */
  parseLines(lines: string[]): ParsedLogLine[] {
    const results: ParsedLogLine[] = [];

    for (const line of lines) {
      const parsed = this.parseLogLine(line);
      if (parsed) {
        results.push(parsed);
      }
    }

    return results;
  }
}
