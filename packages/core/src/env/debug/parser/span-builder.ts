/**
 * @fileoverview Span Builder
 * 
 * Builds TraceEntry objects from parsed log lines and constructs call trees.
 */

import type { ParsedLogLine, TraceEntry, TraceTreeNode } from '../types';
import { RegexParser } from './regex-parser';

/**
 * Paired enter/quit entries
 */
interface PairedSpan {
  enter: TraceEntry;
  quit: TraceEntry;
  durationMs: number;
}

/**
 * Span Builder for constructing trace entries and call trees
 */
export class SpanBuilder {
  private parser: RegexParser;

  constructor() {
    this.parser = new RegexParser();
  }

  /**
   * Build trace entries from parsed log lines
   */
  buildTraceEntries(lines: ParsedLogLine[]): TraceEntry[] {
    const entries: TraceEntry[] = [];

    for (const line of lines) {
      const entry = this.buildTraceEntry(line);
      if (entry) {
        entries.push(entry);
      }
    }

    // Sort by timestamp
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return entries;
  }

  /**
   * Build a single trace entry from a parsed log line
   */
  private buildTraceEntry(line: ParsedLogLine): TraceEntry | null {
    // Use requestId from parsed line if available, otherwise extract from raw line
    const traceId = line.requestId || this.extractTraceId(line.raw);

    const entry: TraceEntry = {
      // Use traceId if available, otherwise generate a virtual one based on function and timestamp
      traceId: traceId || this.generateVirtualTraceId(line.method, line.timestamp),
      timestamp: line.timestamp,
      function: line.method,
      action: line.actionType,
    };

    // Parse args based on action type
    switch (line.actionType) {
      case 'enter':
        entry.params = this.parser.parseArgs(line.rawArgs) as unknown[] | undefined;
        break;
      case 'quit':
        entry.result = this.parser.parseArgs(line.rawArgs);
        break;
      case 'error':
        entry.error = line.rawArgs;
        break;
    }

    return entry;
  }

  /**
   * Generate a virtual trace ID when no real traceId is present
   * Uses function name and timestamp to create a pseudo-traceId
   */
  generateVirtualTraceId(functionName: string, timestamp: string): string {
    // Create a hash-like ID from function name and timestamp
    const base = `${functionName}:${timestamp}`;
    let hash = 0;
    for (let i = 0; i < base.length; i++) {
      const char = base.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `vtrace_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Extract trace ID from log line
   */
  private extractTraceId(line: string): string | null {
    return this.parser.extractTraceId(line);
  }

  /**
   * Calculate duration between enter and quit entries
   */
  calculateDuration(enter: TraceEntry, quit: TraceEntry): number {
    try {
      const enterTime = new Date(enter.timestamp).getTime();
      const quitTime = new Date(quit.timestamp).getTime();

      if (isNaN(enterTime) || isNaN(quitTime)) {
        return 0;
      }

      return quitTime - enterTime;
    } catch {
      return 0;
    }
  }

  /**
   * Pair enter and quit entries
   */
  pairEnterQuit(entries: TraceEntry[]): PairedSpan[] {
    const paired: PairedSpan[] = [];
    const enterStack: TraceEntry[] = [];

    for (const entry of entries) {
      if (entry.action === 'enter') {
        enterStack.push(entry);
      } else if (entry.action === 'quit' && enterStack.length > 0) {
        // Match with the most recent unmatched enter
        const enter = enterStack.pop()!;
        const duration = this.calculateDuration(enter, entry);

        paired.push({
          enter,
          quit: entry,
          durationMs: duration,
        });
      }
    }

    return paired;
  }

  /**
   * Build a call tree from trace entries using call stack tracking
   * 
   * Enhanced to support both:
   * 1. Traditional enter/quit pair-based tree building (from log files)
   * 2. Parent-child hierarchy-based tree building (from SQLite spans)
   */
  buildCallTree(entries: TraceEntry[]): TraceTreeNode | null {
    if (entries.length === 0) {
      return null;
    }

    // Check if entries contain parent-child info (from SQLite spans)
    // Entries from SQLite have spanId/parentSpanId as direct properties
    const hasSpanHierarchy = entries.some(e => 
      e.spanId !== undefined || e.parentSpanId !== undefined
    );

    if (hasSpanHierarchy) {
      return this.buildCallTreeFromHierarchy(entries);
    }

    // Fall back to traditional enter/quit pairing
    return this.buildCallTreeFromPairs(entries);
  }

  /**
   * Build call tree from parent-child span hierarchy (for SQLite spans)
   */
  buildCallTreeFromHierarchy(entries: TraceEntry[]): TraceTreeNode | null {
    // Build a map of spanId -> node
    const nodeMap = new Map<string, TraceTreeNode>();
    const rootNodes: TraceTreeNode[] = [];
    const addedToRoots = new Set<string>();

    // Create nodes from entries - only process 'enter' entries for the tree
    const enterEntries = entries.filter(e => e.action === 'enter');
    
    for (const entry of enterEntries) {
      const spanId = entry.spanId;
      const parentSpanId = entry.parentSpanId;

      // Skip if already processed
      if (spanId && nodeMap.has(spanId)) {
        continue;
      }

      // Create node
      const node: TraceTreeNode = {
        traceId: entry.traceId,
        function: entry.function,
        startTime: entry.timestamp,
        // Find corresponding quit entry for duration
        endTime: undefined,
        durationMs: entry.durationMs,
        children: [],
        entry,
        spanId,
        parentSpanId,
      };

      if (spanId) {
        nodeMap.set(spanId, node);
      }
      
      // Track as root candidate if no parent or parent not in same trace
      if (!parentSpanId || !nodeMap.has(parentSpanId)) {
        rootNodes.push(node);
        if (spanId) addedToRoots.add(spanId);
      }
    }

    // Find quit entries and update endTime/duration
    const quitEntries = entries.filter(e => e.action === 'quit');
    for (const quit of quitEntries) {
      if (quit.spanId) {
        const node = nodeMap.get(quit.spanId);
        if (node) {
          node.endTime = quit.timestamp;
          node.durationMs = quit.durationMs || (node.endTime && node.startTime 
            ? new Date(node.endTime).getTime() - new Date(node.startTime).getTime()
            : undefined);
        }
      }
    }

    // Build parent-child relationships
    // Only connect to parent if it belongs to the same trace
    for (const node of nodeMap.values()) {
      if (node.parentSpanId && nodeMap.has(node.parentSpanId)) {
        const parent = nodeMap.get(node.parentSpanId)!;
        // Only add as child if parent is in the same trace
        if (parent.traceId === node.traceId) {
          parent.children.push(node);
          // Remove from roots if it was added there
          rootNodes.splice(rootNodes.indexOf(node), 1);
        }
      }
    }

    // If no explicit roots, try to find from entries without parentSpanId
    if (rootNodes.length === 0) {
      for (const entry of enterEntries) {
        if (!entry.parentSpanId) {
          const spanId = entry.spanId;
          if (spanId && nodeMap.has(spanId) && !addedToRoots.has(spanId)) {
            rootNodes.push(nodeMap.get(spanId)!);
          }
        }
      }
    }

    // Sort roots by start time
    rootNodes.sort((a, b) => a.startTime.localeCompare(b.startTime));

    // Merge multiple root nodes into a single tree if needed
    if (rootNodes.length === 0) {
      return null;
    }

    if (rootNodes.length === 1) {
      return rootNodes[0];
    }

    // Create a virtual root node if multiple roots exist
    const allStartTimes = rootNodes.map(n => new Date(n.startTime).getTime());
    const allEndTimes = rootNodes.map(n => n.endTime ? new Date(n.endTime).getTime() : 0).filter(t => t > 0);
    
    return {
      traceId: entries[0]?.traceId || 'merged',
      function: '(root)',
      children: rootNodes,
      startTime: new Date(Math.min(...allStartTimes)).toISOString(),
      endTime: allEndTimes.length > 0 
        ? new Date(Math.max(...allEndTimes)).toISOString() 
        : undefined,
      durationMs: allEndTimes.length > 0 && allStartTimes.length > 0
        ? Math.max(...allEndTimes) - Math.min(...allStartTimes)
        : undefined,
    };
  }

  /**
   * Build call tree from traditional enter/quit pairs (for log files)
   */
  buildCallTreeFromPairs(entries: TraceEntry[]): TraceTreeNode | null {
    // Sort entries by timestamp to ensure correct call stack order
    const sortedEntries = [...entries].sort((a, b) => 
      a.timestamp.localeCompare(b.timestamp)
    );

    // Pair enter/quit entries first
    const paired = this.pairEnterQuit(sortedEntries);

    if (paired.length === 0) {
      return null;
    }

    // Build tree using call stack simulation
    const stack: { node: TraceTreeNode; paired: PairedSpan }[] = [];
    let root: TraceTreeNode | null = null;

    // Process sorted entries sequentially to track call depth
    for (const entry of sortedEntries) {
      if (entry.action === 'enter') {
        // Find the paired quit for this enter
        const span = paired.find(p => p.enter === entry);
        if (!span) continue;

        const node = this.buildNodeFromPaired(span);

        if (stack.length === 0) {
          // This is the root
          root = node;
        } else {
          // Add to current parent's children
          stack[stack.length - 1].node.children.push(node);
        }

        stack.push({ node, paired: span });
      } else if (entry.action === 'quit' && stack.length > 0) {
        // Pop the stack - the function is returning
        stack.pop();
      }
    }

    return root;
  }

  /**
   * Build a tree node from a paired span
   */
  private buildNodeFromPaired(span: PairedSpan): TraceTreeNode {
    return {
      traceId: span.enter.traceId,
      function: span.enter.function,
      startTime: span.enter.timestamp,
      endTime: span.quit.timestamp,
      durationMs: span.durationMs,
      children: [],
      entry: span.enter,
    };
  }

  /**
   * Merge entries from multiple functions into a single call tree
   */
  buildMergedTree(entriesByFunction: Map<string, TraceEntry[]>): TraceTreeNode | null {
    // Get all entries across functions, sorted by timestamp
    const allEntries: TraceEntry[] = [];
    
    for (const entries of entriesByFunction.values()) {
      allEntries.push(...entries);
    }

    allEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return this.buildCallTree(allEntries);
  }

  /**
   * Get duration summary for entries
   */
  getDurationSummary(entries: TraceEntry[]): Map<string, { count: number; totalMs: number; avgMs: number }> {
    const summary = new Map<string, { count: number; totalMs: number; avgMs: number }>();
    const paired = this.pairEnterQuit(entries);

    for (const span of paired) {
      const func = span.enter.function;
      const existing = summary.get(func) || { count: 0, totalMs: 0, avgMs: 0 };
      
      existing.count++;
      existing.totalMs += span.durationMs;
      existing.avgMs = Math.round(existing.totalMs / existing.count);

      summary.set(func, existing);
    }

    return summary;
  }
}
