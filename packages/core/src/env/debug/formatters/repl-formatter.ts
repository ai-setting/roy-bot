/**
 * @fileoverview REPL Formatter for Interactive Debugging
 * 
 * Provides an interactive REPL interface for debugging with:
 * - Command parsing
 * - Output formatting
 * - Help text generation
 */

import type { TraceEntry, TraceTreeNode, TraceIdInfo } from '../types';

export interface ReplContext {
  traceId?: string;
  function?: string;
  limit?: number;
}

export interface ParsedCommand {
  command: string;
  args: Record<string, string>;
}

/**
 * Formats output for REPL interface and provides command parsing
 */
export class ReplFormatter {
  private context: ReplContext = {};
  private history: string[] = [];

  /**
   * Get welcome message for REPL
   */
  getWelcomeMessage(): string {
    return `========================================
  Debug REPL - Interactive Debugger
========================================

Commands:
  list [limit]     - List trace IDs
  trace [options]  - Show trace details
  tree [options]   - Show call tree
  help             - Show this help
  exit             - Exit REPL

Examples:
  list 10
  trace --func llm.invoke
  tree --trace trace-001

========================================
`;
  }

  /**
   * Format prompt with current context
   */
  formatPrompt(context?: Partial<ReplContext>): string {
    const ctx = { ...this.context, ...context };
    let prompt = 'debug';
    
    if (ctx.traceId) {
      prompt += `:${ctx.traceId}`;
    } else if (ctx.function) {
      prompt += `:${ctx.function}`;
    }
    
    return `${prompt}> `;
  }

  /**
   * Get help text
   */
  getHelpText(): string {
    return `
Available Commands:
==================
list [n]              - List recent trace IDs (default: 10)
trace [options]       - Show trace details
  --func <name>       - Filter by function name
  --trace <id>        - Show specific trace
  --pretty            - Pretty print output
  --limit <n>         - Limit results
tree [options]        - Show call tree
  --func <name>       - Show tree for function
  --trace <id>        - Show tree for trace
clear                 - Clear screen
help                  - Show this help
exit                  - Exit REPL
`;
  }

  /**
   * Format command result
   */
  formatCommandResult(command: string, data: unknown): string {
    switch (command) {
      case 'list':
        return this.formatListResult(data as { traceIds: TraceIdInfo[]; count: number });
      case 'trace':
        return this.formatTraceResult(data as TraceEntry[]);
      case 'tree':
        return this.formatTreeResult(data as TraceTreeNode[]);
      default:
        return `Unknown command: ${command}`;
    }
  }

  /**
   * Format list command result
   */
  private formatListResult(data: { traceIds: TraceIdInfo[]; count: number }): string {
    const { traceIds, count } = data;
    
    if (traceIds.length === 0) {
      return 'No traces found.';
    }
    
    let output = '\n';
    output += '  TraceId            First Time              Count\n';
    output += '  ' + '-'.repeat(70) + '\n';
    
    for (const trace of traceIds) {
      const time = trace.firstTime.replace('T', ' ').substring(0, 19);
      output += `  ${trace.traceId.padEnd(18)} ${time.padEnd(22)} ${trace.count}\n`;
    }
    
    output += `\n  Total: ${count} traces\n`;
    return output;
  }

  /**
   * Format trace command result
   */
  private formatTraceResult(entries: TraceEntry[]): string {
    if (entries.length === 0) {
      return 'No traces found.';
    }
    
    let output = '';
    let currentTraceId: string | null = null;
    
    for (const entry of entries) {
      if (entry.traceId !== currentTraceId) {
        currentTraceId = entry.traceId;
        output += `\n=== Trace: ${entry.traceId} ===\n\n`;
      }
      
      if (entry.action === 'enter') {
        output += `>>> ${entry.function} enter:`;
        if (entry.params) {
          output += '\n' + this.formatJsonCompact(entry.params);
        }
        output += '\n';
      } else if (entry.action === 'quit') {
        output += `<<< ${entry.function} quit`;
        if (entry.durationMs !== undefined) {
          output += ` (${entry.durationMs}ms)`;
        }
        if (entry.result) {
          output += ':\n' + this.formatJsonCompact(entry.result);
        }
        output += '\n';
      } else if (entry.action === 'error') {
        output += `!!! ${entry.function} error: ${entry.error}\n`;
      }
    }
    
    return output;
  }

  /**
   * Format tree command result
   */
  private formatTreeResult(trees: TraceTreeNode[]): string {
    if (trees.length === 0) {
      return 'No trees found.';
    }
    
    let output = '';
    
    for (const tree of trees) {
      output += this.formatTreeNode(tree, '');
    }
    
    return output;
  }

  /**
   * Format a single tree node recursively
   */
  private formatTreeNode(node: TraceTreeNode, prefix: string): string {
    const duration = node.durationMs !== undefined ? ` (${node.durationMs}ms)` : '';
    let output = `${prefix}${node.function}${duration}\n`;
    
    const childPrefix = prefix + '  ';
    for (let i = 0; i < node.children.length; i++) {
      const isLast = i === node.children.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      output += this.formatTreeNode(node.children[i], childPrefix + connector);
    }
    
    return output;
  }

  /**
   * Format JSON in compact form
   */
  private formatJsonCompact(data: unknown, indent: number = 2): string {
    const spaces = '  '.repeat(indent);
    
    if (data === null || data === undefined) {
      return `${spaces}null\n`;
    }
    
    if (typeof data === 'string') {
      // Handle long strings
      if (data.length > 200) {
        return `${spaces}"${data.substring(0, 200)}..."\n`;
      }
      return `${spaces}"${data}"\n`;
    }
    
    if (typeof data === 'number' || typeof data === 'boolean') {
      return `${spaces}${data}\n`;
    }
    
    if (Array.isArray(data)) {
      if (data.length === 0) return `${spaces}[]\n`;
      
      let output = `${spaces}[\n`;
      for (const item of data) {
        output += this.formatJsonCompact(item, indent + 1);
      }
      output += `${spaces}]\n`;
      return output;
    }
    
    if (typeof data === 'object') {
      const entries = Object.entries(data as Record<string, unknown>);
      if (entries.length === 0) return `${spaces}{}\n`;
      
      let output = `${spaces}{\n`;
      for (const [key, val] of entries) {
        output += `${spaces}  ${key}: ${JSON.stringify(val).substring(0, 50)}`;
        if (JSON.stringify(val).length > 50) {
          output += '...';
        }
        output += '\n';
      }
      output += `${spaces}}\n`;
      return output;
    }
    
    return `${spaces}${String(data)}\n`;
  }

  /**
   * Parse command string
   */
  parseCommand(input: string): ParsedCommand {
    const trimmed = input.trim();
    
    if (!trimmed) {
      return { command: 'help', args: {} };
    }
    
    // Handle exit commands
    if (['exit', 'quit', 'q'].includes(trimmed.toLowerCase())) {
      return { command: 'exit', args: {} };
    }
    
    // Handle clear
    if (trimmed.toLowerCase() === 'clear') {
      return { command: 'clear', args: {} };
    }
    
    // Handle help
    if (['help', '?', 'h'].includes(trimmed.toLowerCase())) {
      return { command: 'help', args: {} };
    }
    
    // Parse command and args
    const parts = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    
    if (parts.length === 0) {
      return { command: 'help', args: {} };
    }
    
    const command = parts[0]?.toLowerCase() ?? '';
    const args: Record<string, string> = {};
    
    // Parse named arguments
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      
      if (part.startsWith('--')) {
        const key = part.substring(2);
        const next = parts[i + 1];
        if (next && !next.startsWith('--')) {
          args[key] = next;
          i++;
        } else {
          args[key] = 'true';
        }
      } else if (part.startsWith('-')) {
        const key = part.substring(1);
        const next = parts[i + 1];
        if (next && !next.startsWith('-')) {
          args[key] = next;
          i++;
        } else {
          args[key] = 'true';
        }
      } else {
        // Positional arguments
        if (command === 'list' && !args.limit) {
          args.limit = part;
        } else if (command === 'trace' && !args.func) {
          args.func = part;
        } else if (command === 'tree' && !args.func) {
          args.func = part;
        }
      }
    }
    
    return { command, args };
  }

  /**
   * Update context
   */
  setContext(context: Partial<ReplContext>): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Get current context
   */
  getContext(): ReplContext {
    return { ...this.context };
  }

  /**
   * Add to history
   */
  addToHistory(command: string): void {
    if (command.trim() && this.history[this.history.length - 1] !== command) {
      this.history.push(command);
    }
  }

  /**
   * Get history
   */
  getHistory(): string[] {
    return [...this.history];
  }
}
