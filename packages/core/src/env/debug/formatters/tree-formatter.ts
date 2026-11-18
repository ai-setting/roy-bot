/**
 * @fileoverview Tree Formatter
 * 
 * Formats trace call trees for console output with:
 * - ANSI color support
 * - Duration display with percentage
 * - Time bar visualization
 * - Proper indentation
 */

import type { TraceTreeNode } from '../types';

/**
 * ANSI color codes
 */
const Colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

/**
 * Apply color to text
 */
function color(text: string, colorCode: string): string {
  return `${colorCode}${text}${Colors.reset}`;
}

/**
 * Tree drawing characters
 */
const CHARS = {
  VERTICAL: '│',
  VERTICAL_CONNECTOR: '├──',
  LAST_CONNECTOR: '└──',
  SPACE: ' ',
  BAR: '█',
  EMPTY: '░',
  DASH: '─',
};

/**
 * Options for tree formatting
 */
export interface TreeFormatOptions {
  /** Show duration percentage (default: true) */
  showPercent?: boolean;
  /** Show time bar (default: false) */
  showTimeBar?: boolean;
  /** Width of time bar (default: 10) */
  barWidth?: number;
}

/**
 * Formats trace call trees for human-readable output
 */
export class TreeFormatter {
  private options: TreeFormatOptions;

  constructor(options: TreeFormatOptions = {}) {
    this.options = {
      showPercent: true,
      showTimeBar: false, // Default off, use --bar flag to enable
      barWidth: 10,
      ...options,
    };
  }

  /**
   * Color function based on percentage
   */
  private colorByPercent(percent: number): string {
    if (percent >= 80) return Colors.red;
    if (percent >= 50) return Colors.yellow;
    if (percent >= 20) return Colors.cyan;
    return Colors.dim;
  }

  /**
   * Format a single trace tree
   */
  formatTree(node: TraceTreeNode): string {
    const lines: string[] = [];
    const totalDuration = node.durationMs || 0;
    // Use sum of direct children for percentage base (better for virtual root nodes)
    const percentBase = node.children.reduce((sum, c) => sum + (c.durationMs || 0), 0) || totalDuration;
    
    // Root node line
    lines.push(this.formatNode(node, totalDuration, percentBase, '', true, true));
    
    // Process children recursively
    this.formatChildren(node.children, '', lines, totalDuration, percentBase);
    
    return lines.join('\n');
  }

  /**
   * Format a single node
   */
  private formatNode(
    node: TraceTreeNode,
    totalDuration: number,
    percentBase: number,
    prefix: string,
    isLast: boolean,
    isRoot: boolean
  ): string {
    // Tree connector
    const connector = isRoot ? '' : (isLast ? CHARS.LAST_CONNECTOR : CHARS.VERTICAL_CONNECTOR);
    const prefixStr = isRoot ? '' : prefix;
    
    let line = `${prefixStr}${connector} ${node.function}`;
    
    // Duration
    if (node.durationMs !== undefined) {
      line += color(` (${this.formatDuration(node.durationMs)})`, Colors.dim);
    }
    
    // Percentage - skip for:
    // 1. Virtual root nodes (function is '(root)')
    // 2. Actual root of tree (isRoot=true) - root is 100% by definition
    if (this.options.showPercent && percentBase > 0 && node.durationMs !== undefined && 
        node.function !== '(root)' && !isRoot) {
      const percent = Math.round((node.durationMs / percentBase) * 100);
      const percentStr = ` [${percent}%]`;
      line += color(percentStr, this.colorByPercent(percent));
    }
    
    // Time bar - only show for nested spans where totalDuration is meaningful
    if (this.options.showTimeBar && node.durationMs !== undefined && totalDuration > 0 && !isRoot) {
      line += ' ' + this.renderTimeBar(node.durationMs, totalDuration);
    }
    
    return isRoot ? color(line, Colors.bold) : line;
  }

  /**
   * Recursively format children
   */
  private formatChildren(
    children: TraceTreeNode[],
    prefix: string,
    lines: string[],
    totalDuration: number,
    percentBase: number
  ): void {
    children.forEach((child, index) => {
      const isLast = index === children.length - 1;
      const newPrefix = prefix + (isLast ? '    ' : `${CHARS.VERTICAL}   `);
      
      lines.push(this.formatNode(child, totalDuration, percentBase, prefix, isLast, false));
      
      if (child.children.length > 0) {
        this.formatChildren(child.children, newPrefix, lines, totalDuration, percentBase);
      }
    });
  }

  /**
   * Render a time bar showing relative duration
   */
  private renderTimeBar(duration: number, total: number): string {
    const width = this.options.barWidth || 10;
    const filledWidth = Math.round((duration / total) * width);
    const emptyWidth = width - filledWidth;
    
    const bar = CHARS.BAR.repeat(filledWidth) + CHARS.EMPTY.repeat(emptyWidth);
    return color(`[${bar}]`, Colors.dim);
  }

  /**
   * Format duration in human-readable form
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else if (ms < 3600000) { // < 1 hour
      const mins = Math.floor(ms / 60000);
      const secs = Math.round((ms % 60000) / 1000);
      return `${mins}m ${secs}s`;
    } else {
      const hours = Math.floor(ms / 3600000);
      const mins = Math.floor((ms % 3600000) / 60000);
      return `${hours}h ${mins}m`;
    }
  }

  /**
   * Format multiple trace trees
   */
  formatTrees(trees: TraceTreeNode[]): string {
    if (trees.length === 0) {
      return 'No trace trees';
    }
    
    return trees.map(tree => this.formatTree(tree)).join('\n\n');
  }

  /**
   * Output as JSON
   */
  toJSON(trees: TraceTreeNode[]): string {
    return JSON.stringify(trees, null, 2);
  }

  /**
   * Generate a summary table of all spans sorted by duration
   */
  formatSummary(node: TraceTreeNode): string {
    const rows: { func: string; duration: number; percent: number; depth: number }[] = [];
    // For virtual root nodes with multiple children, use the root's own duration
    // which is calculated from children's time span
    const total = node.durationMs || 0;
    
    // Calculate sum of direct children durations for percentage base
    const childrenTotal = node.children.reduce((sum, c) => sum + (c.durationMs || 0), 0);
    const percentBase = total > 0 ? total : childrenTotal;
    
    const collect = (n: TraceTreeNode, depth: number): void => {
      if (n.durationMs !== undefined) {
        rows.push({
          func: n.function,
          duration: n.durationMs,
          percent: percentBase > 0 ? Math.round((n.durationMs / percentBase) * 100) : 0,
          depth,
        });
      }
      n.children.forEach(child => collect(child, depth + 1));
    };
    
    collect(node, 0);
    
    // Sort by duration descending
    rows.sort((a, b) => b.duration - a.duration);
    
    const lines: string[] = [];
    lines.push(color('\n=== Duration Summary ===', Colors.bold));
    lines.push(color('(sorted by time consumption)\n', Colors.dim));
    
    // Table header
    lines.push(color(`  ${'─'.repeat(65)}`, Colors.dim));
    lines.push(color(`  ${'FUNCTION'.padEnd(35)} ${'TIME'.padEnd(12)} %`, Colors.dim));
    lines.push(color(`  ${'─'.repeat(65)}`, Colors.dim));
    
    for (const row of rows) {
      const indent = '  '.repeat(row.depth);
      const funcDisplay = row.depth > 0 ? '└─ '.repeat(row.depth) + row.func : row.func;
      
      const percentStr = String(row.percent).padStart(3) + '%';
      const percentColor = row.percent >= 50 ? Colors.red :
                          row.percent >= 20 ? Colors.yellow :
                          Colors.dim;
      
      lines.push(
        `  ${indent}${funcDisplay.substring(0, 35).padEnd(35)}${this.formatDuration(row.duration).padEnd(12)} ${color(percentStr, percentColor)}`
      );
    }
    
    return lines.join('\n');
  }

  /**
   * Format tree with timeline visualization
   */
  formatTimeline(node: TraceTreeNode): string {
    const lines: string[] = [];
    const totalDuration = node.durationMs || 0;
    
    lines.push(color(`\n=== Timeline: ${node.function} ===`, Colors.bold));
    lines.push(color(`Total: ${this.formatDuration(totalDuration)}\n`, Colors.dim));
    
    // Build timeline
    const timeline = this.buildTimeline(node, totalDuration, 0, 0);
    lines.push(...timeline);
    
    return lines.join('\n');
  }

  /**
   * Build timeline visualization with absolute positioning
   */
  private buildTimeline(
    node: TraceTreeNode,
    totalDuration: number,
    absoluteOffset: number,
    depth: number
  ): string[] {
    const lines: string[] = [];
    const width = 40;
    
    // Calculate position based on absolute offset
    const startPos = Math.round((absoluteOffset / totalDuration) * width);
    const durationWidth = node.durationMs !== undefined 
      ? Math.max(2, Math.round((node.durationMs / totalDuration) * width))
      : 2;
    
    // Build the bar with proper positioning
    const bar = ' '.repeat(Math.max(0, startPos)) + CHARS.BAR.repeat(durationWidth);
    
    // Format line
    const indent = '  '.repeat(depth);
    const funcName = node.function.length > 25 ? '...' + node.function.slice(-22) : node.function;
    const time = node.durationMs !== undefined ? this.formatDuration(node.durationMs) : '-';
    const percent = node.durationMs !== undefined 
      ? ` [${Math.round((node.durationMs / totalDuration) * 100)}%]`
      : '';
    lines.push(`${indent}${funcName.padEnd(25)} ${bar} ${color(time + percent, Colors.dim)}`);
    
    // Process children with absolute offset within this node
    let childOffset = absoluteOffset;
    for (const child of node.children) {
      lines.push(...this.buildTimeline(child, totalDuration, childOffset, depth + 1));
      childOffset += child.durationMs || 0;
    }
    
    return lines;
  }
}
