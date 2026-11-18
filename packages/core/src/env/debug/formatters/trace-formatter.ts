/**
 * @fileoverview Trace Formatter
 * 
 * Formats trace entries for console output with support for:
 * - Pretty printing with indentation
 * - Multi-line content handling
 * - JSON output
 * - Depth-limited nested object display
 */

import type { TraceEntry, FormatOptions } from '../types';

/**
 * Formats trace entries for human-readable output
 */
export class TraceFormatter {
  /**
   * Format a single trace entry
   */
  formatEntry(entry: TraceEntry, options: FormatOptions = {}): string {
    const { pretty = false } = options;
    const actionSymbol = entry.action === 'enter' ? '>>>' : 
                         entry.action === 'error' ? '!!!' : '<<<';
    
    let output = `${actionSymbol} ${entry.function} ${entry.action}`;
    
    if (entry.action === 'enter' && entry.params) {
      output += '\n' + this.formatData(entry.params, options);
    } else if (entry.action === 'quit') {
      if (entry.durationMs !== undefined) {
        output += ` (${entry.durationMs}ms)`;
      }
      if (entry.result) {
        output += '\n' + this.formatData(entry.result, options);
      }
    } else if (entry.action === 'error' && entry.error) {
      output += `: ${entry.error}`;
    }
    
    // Handle multi-line content by indenting continuation lines
    if (pretty) {
      output = this.indentMultilineContent(output);
    }
    
    return output;
  }
  
  /**
   * Indent all lines after the first one
   */
  private indentMultilineContent(text: string, indent: string = '  '): string {
    const lines = text.split('\n');
    if (lines.length <= 1) return text;
    
    return lines.map((line, i) => i === 0 ? line : `${indent}${line}`).join('\n');
  }

  /**
   * Format multiple trace entries
   */
  formatEntries(entries: TraceEntry[], options: FormatOptions = {}): string {
    if (entries.length === 0) {
      return 'No trace entries';
    }
    
    const formatted = entries.map(entry => this.formatEntry(entry, options));
    
    // Use separator only for pretty mode, otherwise join without separator
    if (options.pretty) {
      return formatted.join('\n' + '-'.repeat(80) + '\n');
    }
    
    return formatted.join('\n');
  }

  /**
   * Format data with proper indentation for multi-line content
   */
  private formatData(data: unknown, options: FormatOptions = {}): string {
    const { pretty = false, maxDepth = 10 } = options;
    
    if (pretty) {
      return this.formatPretty(data, 0, maxDepth);
    }
    
    // Compact JSON - no newlines
    return JSON.stringify(data);
  }

  /**
   * Format data with pretty printing and indentation
   */
  private formatPretty(data: unknown, indent: number = 0, maxDepth: number): string {
    const baseIndent = '  '.repeat(indent);
    const nextIndent = '  '.repeat(indent + 1);
    
    if (data === null || data === undefined) {
      return String(data);
    }
    
    if (typeof data === 'string') {
      // Handle multi-line strings - indent each line
      if (data.includes('\n')) {
        return data.split('\n').map((line, i) => 
          i === 0 ? line : `${nextIndent}${line}`
        ).join('\n');
      }
      return data;
    }
    
    if (typeof data === 'number' || typeof data === 'boolean') {
      return String(data);
    }
    
    if (Array.isArray(data)) {
      if (data.length === 0) return '[]';
      
      const items = data.map(item => {
        const formatted = this.formatPretty(item, indent + 1, maxDepth);
        // Indent each line of the formatted item
        return formatted.split('\n').map(line => `  ${line}`).join('\n');
      });
      
      return '[\n' + items.join(',\n') + '\n' + baseIndent + ']';
    }
    
    if (typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const keys = Object.keys(obj);
      
      if (keys.length === 0) return '{}';
      
      if (indent >= maxDepth) {
        return '{...}';
      }
      
      const entries = keys.map(key => {
        const value = obj[key];
        let formatted: string;
        
        if (typeof value === 'object' && value !== null) {
          formatted = this.formatPretty(value, indent + 1, maxDepth);
        } else if (typeof value === 'string' && value.includes('\n')) {
          // Handle multi-line string values - indent each line
          formatted = value.split('\n').map((line, i) => 
            i === 0 ? line : `${nextIndent}${line}`
          ).join('\n');
        } else {
          formatted = JSON.stringify(value);
        }
        
        // Indent all lines of the formatted value
        return `  ${key}: ` + formatted.split('\n').map((line, i) => 
          i === 0 ? line : nextIndent + line
        ).join('\n');
      });
      
      return '{\n' + entries.join(',\n') + '\n' + baseIndent + '}';
    }
    
    return JSON.stringify(data);
  }

  /**
   * Output as JSON
   */
  toJSON(entries: TraceEntry[]): string {
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Generate a summary of trace entries
   */
  toSummary(entries: TraceEntry[]): string {
    if (entries.length === 0) {
      return 'No trace entries';
    }
    
    const functions = new Set(entries.map(e => e.function));
    const actions = entries.reduce((acc, e) => {
      acc[e.action] = (acc[e.action] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    let summary = `Trace Summary (${entries.length} entries)\n`;
    summary += `Functions: ${[...functions].join(', ')}\n`;
    summary += `Actions: ${Object.entries(actions).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    
    return summary;
  }
}
