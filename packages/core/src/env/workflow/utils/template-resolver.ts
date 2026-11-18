/**
 * @fileoverview Template Resolver - Unified template resolution for workflow nodes
 * 
 * This module provides a unified template resolution system for workflow nodes.
 * Templates are in the format {{path}} where path can reference:
 * 
 * - Input variables: {{input.key}} or {{input.key.nested}}
 * - Node outputs: {{nodeId}} or {{nodeId.output}} or {{nodeId.output.path}}
 * - With prefix: {{nodes.nodeId}} or {{nodes.nodeId.output.path}}
 * 
 * @example
 * ```typescript
 * const resolver = new TemplateResolver({
 *   input: { query: 'weather' },
 *   previousOutputs: new Map([
 *     ['fetch', { data: { temp: 25, condition: 'sunny' } }]
 *   ])
 * });
 * 
 * resolver.resolve('Weather in {{input.query}}: {{nodes.fetch.data.condition}}');
 * // => 'Weather in weather: sunny'
 * ```
 */

import { TracedAs } from '../../log-trace/decorator';
import { nodeNotFound, pathNotFound, unresolvedVariable } from '../types';
import { getFromMapWithNormalization } from './node-id-utils';
import type { NodeExecutionContext } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Template resolution options
 */
export interface TemplateResolverOptions {
  /** Input passed to the workflow/node */
  input?: Record<string, unknown>;
  /** Map of previous node outputs */
  previousOutputs?: Map<string, unknown>;
}

/**
 * Result of template resolution
 */
export interface ResolvedValue {
  /** Whether the value was resolved */
  resolved: boolean;
  /** The resolved value */
  value: unknown;
}

/**
 * Result of resolveAndValidate operation
 */
export interface ResolveResult {
  /** The resolved value (with templates replaced) */
  resolved: unknown;
  /** List of template strings that could not be resolved */
  unresolved: string[];
}

// ============================================================================
// TemplateResolver Class
// ============================================================================

/**
 * TemplateResolver
 * 
 * Resolves template strings that reference workflow inputs and node outputs.
 */
export class TemplateResolver {
  private input: Record<string, unknown>;
  private previousOutputs: Map<string, unknown>;

  constructor(options: TemplateResolverOptions = {}) {
    this.input = options.input ?? {};
    this.previousOutputs = options.previousOutputs ?? new Map();
  }

  /**
   * Create a TemplateResolver from NodeExecutionContext
   * 
   * @param context - Node execution context
   * @returns TemplateResolver instance
   */
  static fromContext(context: NodeExecutionContext): TemplateResolver {
    return new TemplateResolver({
      // 优先使用 workflowInput（非 entry 节点只有这个）
      // fallback 到 context.input（仅 entry 节点有）
      input: context.workflowInput ?? context.input as Record<string, unknown>,
      previousOutputs: context.previousOutputs,
    });
  }

  /**
   * Resolve template references in an input value.
   * 
   * Handles:
   * - Primitive values (returned as-is)
   * - Objects (recursively resolved)
   * - Arrays (recursively resolved)
   * - Strings (template resolution)
   * 
   * Key behavior for template strings:
   * - If the string is a pure template reference (e.g., "{{nodes.fetch}}"), 
   *   the resolved value is returned as-is (preserving objects/arrays)
   * - If the string contains text + templates (e.g., "Hello {{name}}"),
   *   returns a string with interpolated values
   * 
   * @param input - Input value that may contain template strings
   * @returns Input with template references resolved
   */
  resolveValue(input: unknown): unknown {
    if (input === null || input === undefined) {
      return input;
    }

    if (typeof input === 'string') {
      // Check if this is a pure template reference (no surrounding text)
      const pureTemplate = this.extractPureTemplate(input);
      if (pureTemplate) {
        // Pure template reference - resolve and return value as-is (preserve objects/arrays)
        return this.resolvePureTemplate(pureTemplate);
      }
      // Mixed text + templates - return resolved string
      return this.resolveString(input);
    }

    if (Array.isArray(input)) {
      return input.map(item => this.resolveValue(item));
    }

    if (typeof input === 'object') {
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        resolved[key] = this.resolveValue(value);
      }
      return resolved;
    }

    // Return primitive values as-is
    return input;
  }

  /**
   * Check if a string is a pure template reference (starts with {{ and ends with }})
   * @param str - String to check
   * @returns The template content if pure, null otherwise
   */
  private extractPureTemplate(str: string): string | null {
    const trimmed = str.trim();
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}') && trimmed.length > 4) {
      // Extract content between {{ and }}
      const content = trimmed.slice(2, -2).trim();
      // Check there's no other text (except the template patterns themselves)
      // This ensures we don't treat "Hello {{name}}" as pure template
      if (!content.includes('{{') && !content.includes('}}')) {
        return content;
      }
    }
    return null;
  }

  /**
   * Resolve a pure template reference and return the value as-is.
   * @param templateContent - Content between {{ and }}
   * @returns The resolved value (may be object, array, or primitive)
   */
  private resolvePureTemplate(templateContent: string): unknown {
    // Try to resolve the template
    const value = this.resolveTemplateContent(templateContent);
    return value;
  }

  /**
   * Resolve a path-style template reference and return the value.
   *
   * Task #2283 — added so the engine can read any previous-progress
   * signal (e.g. `{{nodes.tdd-implement.commits[-1]}}`) inside
   * loop_guard checks without having to re-parse the template.
   *
   * Supports:
   *   - `{{input.foo}}` / `{{input.foo.bar}}`
   *   - `{{nodes.X}}` / `{{nodes.X.Y}}` / `{{nodes.X.Y.Z}}`
   *   - Array indexing: `{{nodes.X.list[0]}}`, `{{nodes.X.list[-1]}}`
   *     (-1 means "last element"; -2 means "second to last", etc.)
   *   - `.length` accessor on arrays
   *
   * The `{{` and `}}` wrappers are optional — a bare path string
   * (`nodes.X.Y`) is also accepted.
   *
   * Returns `undefined` if any segment is missing, an array index is
   * out of range, or the input is empty.
   */
  resolvePath(path: string): unknown {
    if (typeof path !== 'string') return undefined;
    const trimmed = path.trim();
    if (trimmed === '') return undefined;

    // Strip {{ }} wrapper if present.
    let inner = trimmed;
    if (inner.startsWith('{{') && inner.endsWith('}}')) {
      inner = inner.slice(2, -2).trim();
    }
    if (inner === '') return undefined;

    return this.resolveTemplateContent(inner);
  }

  /**
   * Tokenize a path string into segments, respecting bracket notation
   * `foo[0]`, `foo[-1]`, and the `.length` accessor.
   *
   * Examples:
   *   "nodes.x.y"        -> ["nodes", "x", "y"]
   *   "nodes.x.list[0]"  -> ["nodes", "x", "list", 0]
   *   "nodes.x.list[-1]" -> ["nodes", "x", "list", -1]
   *   "nodes.x.l.length" -> ["nodes", "x", "l", "length"]
   */
  private tokenizePath(path: string): Array<string | number> {
    const tokens: Array<string | number> = [];
    const re = /([^.\[\]]+)|\[(-?\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(path)) !== null) {
      if (m[1] !== undefined) {
        tokens.push(m[1]);
      } else if (m[2] !== undefined) {
        tokens.push(parseInt(m[2], 10));
      }
    }
    return tokens;
  }

  /**
   * Navigate `tokens` (mix of string keys and integer indices) into
   * `root`, returning the value at the end of the path or undefined.
   *
   * For negative indices, the engine resolves them as offset from the
   * end of the array (-1 = last, -2 = second to last, ...).
   */
  private navigateTokens(root: unknown, tokens: Array<string | number>): unknown {
    let current: unknown = root;
    for (const token of tokens) {
      if (current === null || current === undefined) return undefined;
      if (typeof token === 'number') {
        if (!Array.isArray(current)) return undefined;
        const idx = token < 0 ? current.length + token : token;
        if (idx < 0 || idx >= current.length) return undefined;
        current = current[idx];
      } else {
        if (typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[token];
      }
    }
    return current;
  }

  /**
   * Resolve template content (the part inside {{ }}) and return the value.
   * @param templateContent - The path to resolve (e.g., "input.key", "nodes.fetch.data")
   * @returns The resolved value
   */
  private resolveTemplateContent(templateContent: string): unknown {
    const trimmed = templateContent.trim();

    // Tokenize first so `nodes.x.list[-1]` becomes
    // ['nodes', 'x', 'list', -1] rather than
    // ['nodes', 'x', 'list[-1]'].
    const tokens = this.tokenizePath(trimmed);
    if (tokens.length === 0) return undefined;
    const head = tokens[0];

    // Pattern 1: {{input.key}} or {{input.key.nested}} or {{inputs.key}} (alias)
    if (head === 'input' || head === 'inputs') {
      const rest = tokens.slice(1);
      if (rest.length === 0) return this.input;
      return this.navigateTokens(this.input, rest);
    }

    // Pattern 2: {{nodes.nodeId}} or {{nodes.nodeId.output}} or {{nodes.X.list[-1]}}
    if (head === 'nodes') {
      const rest = tokens.slice(1);
      if (rest.length === 0) return undefined;
      const nodeId = rest[0];
      if (typeof nodeId !== 'string') return undefined;
      const nodeValue = getFromMapWithNormalization(this.previousOutputs, nodeId);
      if (nodeValue === undefined) return undefined;
      const pathTokens = rest.slice(1);
      if (pathTokens.length === 0) return this.unwrapAgentNodeResult(nodeValue);
      // Virtual `.output` prefix: auto-unwrap `result` for convenience when
      // the user writes `{{nodes.entry.output}}` (Task #2156 behavior).
      if (pathTokens[0] === 'output') {
        if (pathTokens.length === 1) {
          return this.unwrapAgentNodeResult(nodeValue);
        }
        // `{{nodes.entry.output.xxx}}` — navigate into the value directly,
        // treating `.output` as a virtual prefix (not a literal key).
        return this.navigateTokens(nodeValue, pathTokens.slice(1));
      }
      return this.navigateTokens(nodeValue, pathTokens);
    }

    // Pattern 3: Bare nodeId (backward compatibility)
    if (typeof head === 'string' && head !== 'nodes') {
      const nodeId = head;
      const nodeValue = getFromMapWithNormalization(this.previousOutputs, nodeId);
      if (nodeValue === undefined) return undefined;
      const pathTokens = tokens.slice(1);
      if (pathTokens.length === 0) return this.unwrapAgentNodeResult(nodeValue);
      return this.navigateTokens(nodeValue, pathTokens);
    }

    return undefined;
  }

  /**
   * Auto-unwrap AgentNode output format `{ result, metadata, ... }` when
   * the caller asked for the bare node (no further path). Preserves the
   * pre-tokenizer behavior where `{{nodeId}}` returns the result field
   * rather than the whole wrapper object.
   *
   * Only unwraps when the value LOOKS like an AgentNode result wrapper
   * (has `result` and not `nodes`); this guards against false positives
   * on plain objects that happen to have a `result` key.
   */
  private unwrapAgentNodeResult(value: unknown): unknown {
    if (
      value &&
      typeof value === 'object' &&
      'result' in value &&
      !('nodes' in value)
    ) {
      return (value as { result: unknown }).result;
    }
    return value;
  }

  /**
   * Resolve a single template string.
   * 
   * Supports patterns:
   * - {{input.key}} - Input variable
   * - {{nodeId}} - Node's entire output
   * - {{nodeId.output}} - Node's output property
   * - {{nodeId.output.path}} - Node's nested output property
   * - {{nodes.nodeId}} - Node's entire output (with prefix)
   * - {{nodes.nodeId.output.path}} - Node's nested property (with prefix)
   * 
   * @param template - Template string to resolve
   * @returns Resolved string
   */
  resolveString(template: string): string {
    if (!template || typeof template !== 'string') {
      return template;
    }

    let resolved = template;

    // Normalize whitespace in template variables: {{ var }} → {{var}}, {{  var  }} → {{var}}
    resolved = resolved.replace(/\{\{\s+/g, '{{');
    resolved = resolved.replace(/\s+\}\}/g, '}}');

    // Support {{inputs.xxx}} as alias for {{input.xxx}} (backward compatibility with AgentNode)
    // This allows existing workflows using {{inputs.city}} to work with the new TemplateResolver
    resolved = resolved.replace(/\{\{inputs\./g, '{{input.');

    // Pattern 1: {{input.key}} or {{input.key.nested}}
    resolved = resolved.replace(/\{\{input\.([^}]+)\}\}/g, (match, path) => {
      const value = this.getNestedValue(this.input, path);
      return this.stringify(value, match);
    });

    // Pattern 2: {{nodes.nodeId}} or {{nodes.nodeId.output.path}}
    // Also handles {{nodes.nodeId.output}} format
    resolved = resolved.replace(/\{\{nodes\.([^}]+)\}\}/g, (match, path) => {
      const value = this.resolveNodePath(path);
      return this.stringify(value, match);
    });

    // Pattern 3: {{nodeId}} or {{nodeId.output}} or {{nodeId.output.path}}
    // This is for backward compatibility with SkillNode's bare nodeId format
    // Only matches if not already matched by nodes. pattern
    // We need to be careful not to match {{input.xxx}} patterns
    // Supports node IDs with alphanumeric, underscore, hyphen characters
    resolved = resolved.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_-]*)(?:\.([^}]+))?\}\}/g, (match, nodeId, path) => {
      // Skip if this looks like an input reference without the prefix
      // This is a heuristic: 'input' as first segment is handled above
      if (nodeId === 'input') {
        return match;
      }
      
      // Skip 'nodes' prefix (already handled above)
      if (nodeId === 'nodes') {
        return match;
      }

      const value = this.resolveNodePath(`${nodeId}${path ? '.' + path : ''}`);
      return this.stringify(value, match);
    });

    return resolved;
  }

  /**
   * Resolve a node output path.
   * 
   * @param path - Path like "nodeId" or "nodeId.output" or "nodeId.output.path"
   * @returns The resolved value or undefined
   */
  private resolveNodePath(path: string): unknown {
    const segments = path.split('.');
    const nodeId = segments[0];
    
    if (!nodeId) {
      return undefined;
    }

    // Get node output from previous outputs
    // Try exact match first, then try normalized versions (hyphen <-> underscore)
    let value = getFromMapWithNormalization(this.previousOutputs, nodeId);
    
    if (value === undefined) {
      return undefined;
    }

    // If no additional path (bare nodeId), handle AgentNode output format
    if (segments.length === 1) {
      // Special handling for AgentNode output format: { result, metadata }
      // If output has this shape, extract the result
      if (value && typeof value === 'object' && 'result' in value && !('nodes' in value)) {
        value = (value as { result: unknown }).result;
      }
      return value;
    }

    // Navigate nested path
    // Special handling for AgentNode output format: { result, metadata }
    // If path starts with 'result', try to extract from wrapper
    const secondSegment = segments[1];
    if (secondSegment === 'result') {
      // Check if current value is an AgentNode-style wrapper
      if (value && typeof value === 'object' && 'result' in value) {
        value = (value as { result: unknown }).result;
        
        if (segments.length === 2) {
          // Path was {{nodeId.result}} - return the result directly
          return value;
        }
        
        // Skip the 'result' segment and continue navigating
        for (let i = 2; i < segments.length; i++) {
          if (value === null || value === undefined) {
            return undefined;
          }
          value = (value as Record<string, unknown>)[segments[i]];
        }
        return value;
      }
    }
    
    // Handle 'output' segment: when path is {{nodes.entry.output}},
    // auto-unwrap .result from the output for convenience (since stored value IS the output).
    // For longer paths like {{nodes.entry.output.xxx}}, navigate normally into the value.
    if (secondSegment === 'output') {
      if (segments.length === 2) {
        // {{nodes.entry.output}} - auto-unwrap .result for convenience
        if (value && typeof value === 'object' && 'result' in value) {
          return (value as { result: unknown }).result;
        }
        return value;
      }
      // {{nodes.entry.output.xxx}} - navigate into the value (no auto-unwrap)
      // Two cases:
      // 1. AgentNode-style: value = { result: ..., metadata: ... } — 'output' is a virtual prefix,
      //    so skip it (start from i=2) and navigate into the raw value directly.
      // 2. ToolNode-style: value = { output: { ... } } — 'output' is a real key in the stored value,
      //    so fall through to standard navigation from i=1.
      if (value && typeof value === 'object' && 'result' in value) {
        // AgentNode-style: 'output' is a virtual prefix, navigate from i=2
        for (let i = 2; i < segments.length; i++) {
          if (value === null || value === undefined) {
            return undefined;
          }
          value = (value as Record<string, unknown>)[segments[i]];
        }
        return value;
      }
      // ToolNode/other: 'output' is a real key — fall through to standard navigation
    }

    // Standard nested path navigation
    for (let i = 1; i < segments.length; i++) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[segments[i]];
    }

    return value;
  }

  /**
   * Get a nested value from an object using dot notation.
   * 
   * @param obj - Object to traverse
   * @param path - Dot-separated path
   * @returns The nested value or undefined
   */
  private getNestedValue(obj: Record<string, unknown> | undefined, path: string): unknown {
    if (!obj || !path) {
      return undefined;
    }

    const segments = path.split('.');
    let current: unknown = obj;

    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    return current;
  }

  /**
   * Convert a value to string for template substitution.
   *
   * Task #2912: when value is undefined, return empty string instead of
   * the original template. Returning the original template caused downstream
   * bash guards (e.g. `[ -n "$SID_COOKIE_RAW" ]`) to evaluate as truthy
   * on the template literal like `{{input.sidCookie}}`, which misrouted
   * workflows into fallback paths when an input field was simply absent.
   * null still returns the sentinel string "null" for backward compatibility.
   */
  private stringify(value: unknown, originalTemplate: string): string {
    if (value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (value === null) {
      return 'null';
    }
    return JSON.stringify(value);
  }

  /**
   * Check if a string contains template references.
   * 
   * @param str - String to check
   * @returns True if the string contains template references
   */
  containsTemplates(str: string): boolean {
    if (typeof str !== 'string') {
      return false;
    }
    return /\{\{[^}]+\}\}/.test(str);
  }

  /**
   * Extract all template references from a string.
   * 
   * @param str - String to extract from
   * @returns Array of template references
   */
  extractTemplates(str: string): string[] {
    if (typeof str !== 'string') {
      return [];
    }
    const matches = str.match(/\{\{[^}]+\}\}/g);
    return matches ?? [];
  }

  /**
   * Resolve and validate input, tracking unresolved templates.
   * 
   * This method resolves all template references in the input and returns
   * both the resolved value and a list of templates that could not be resolved.
   * 
   * @param input - Input value that may contain template strings
   * @returns Object containing resolved value and list of unresolved templates
   */
  @TracedAs('workflow.template.resolveAndValidate', { log: true })
  resolveAndValidate(input: unknown): ResolveResult {
    const unresolved: string[] = [];
    
    const resolved = this.resolveValueWithTracking(input, unresolved);
    
    return { resolved, unresolved };
  }

  /**
   * Internal method to resolve values while tracking unresolved templates.
   */
  private resolveValueWithTracking(input: unknown, unresolved: string[]): unknown {
    if (input === null || input === undefined) {
      return input;
    }

    if (typeof input === 'string') {
      // Check if this is a pure template reference
      const pureTemplate = this.extractPureTemplate(input);
      if (pureTemplate) {
        const value = this.resolvePureTemplate(pureTemplate);
        if (value === undefined) {
          unresolved.push(input);
          // Return the original template string for unresolved pure templates
          return input;
        }
        return value;
      }
      // Mixed text + templates - resolve and track
      return this.resolveStringWithTracking(input, unresolved);
    }

    if (Array.isArray(input)) {
      return input.map(item => this.resolveValueWithTracking(item, unresolved));
    }

    if (typeof input === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        result[key] = this.resolveValueWithTracking(value, unresolved);
      }
      return result;
    }

    return input;
  }

  /**
   * Resolve string templates while tracking unresolved ones.
   */
  private resolveStringWithTracking(str: string, unresolved: string[]): string {
    // Extract all templates first
    const templates = this.extractTemplates(str);
    
    let resolved = str;
    for (const template of templates) {
      // Check if this template can be resolved
      const pureContent = template.slice(2, -2).trim();
      const value = this.resolveTemplateContent(pureContent);
      
      if (value === undefined) {
        unresolved.push(template);
      } else {
        // Replace the template with its resolved value
        const resolvedValue = this.stringify(value, template);
        resolved = resolved.replace(template, resolvedValue);
      }
    }
    
    return resolved;
  }

  /**
   * Resolve templates strictly, throwing on unresolved templates.
   * 
   * This is useful when you want to ensure all templates are resolved
   * before proceeding, and treat any unresolved templates as an error.
   * 
   * Uses factory methods to create meaningful error messages with nodeId and reason.
   * 
   * @param input - Input value that may contain template strings
   * @param nodeId - Optional node ID for better error context
   * @returns The resolved value
   * @throws TemplateUnresolvedError if any templates could not be resolved
   */
  @TracedAs('workflow.template.resolveStrict', { log: true })
  resolveStrict(input: unknown, nodeId?: string): unknown {
    const result = this.resolveAndValidate(input);
    
    if (result.unresolved.length > 0) {
      // Use factory methods to create meaningful error messages
      for (const template of result.unresolved) {
        // Extract path without {{ }}
        const path = template.replace(/^\{\{|\}\}$/g, '');
        
        // Check for input reference: {{input.xxx}} or {{inputs.xxx}}
        if (path.startsWith('input.')) {
          const inputKey = path.slice(6); // "input." is 6 chars
          const value = this.getNestedValue(this.input, inputKey);
          if (value === undefined) {
            throw unresolvedVariable(template, inputKey);
          }
          continue;
        }
        if (path.startsWith('inputs.')) {
          // Alias for input. - same behavior
          const inputKey = path.slice(7); // "inputs." is 7 chars
          const value = this.getNestedValue(this.input, inputKey);
          if (value === undefined) {
            throw unresolvedVariable(template, inputKey);
          }
          continue;
        }
        
        // Check for nodes prefix: {{nodes.nodeId}} or {{nodes.nodeId.path}}
        if (path.startsWith('nodes.')) {
          const afterPrefix = path.slice(6); // "nodes." is 6 chars
          const nodeParts = afterPrefix.split('.');
          const refNodeId = nodeParts[0];
          if (!this.previousOutputs.has(refNodeId)) {
            // Fix P2-2: pass refNodeId (referenced node) not nodeId (execution node)
            throw nodeNotFound(refNodeId, [template]);
          }
          // Check nested path
          if (nodeParts.length > 1) {
            const refPath = nodeParts.slice(1).join('.');
            const nodeValue = this.previousOutputs.get(refNodeId);
            const nestedValue = this.getNestedValue(
              nodeValue as Record<string, unknown>,
              refPath
            );
            if (nestedValue === undefined) {
              // Fix P2-2: pass refNodeId (referenced node) not nodeId (execution node)
              throw pathNotFound(refNodeId, refPath, template);
            }
          }
          continue;
        }
        
        // Check for direct node reference without prefix: {{nodeId}} or {{nodeId.path}}
        if (path.includes('.')) {
          // Has a dot - could be nodeId.path
          const [refNodeId, ...pathParts] = path.split('.');
          if (this.previousOutputs.has(refNodeId)) {
            const refPath = pathParts.join('.');
            const nodeValue = this.previousOutputs.get(refNodeId);
            const nestedValue = this.getNestedValue(
              nodeValue as Record<string, unknown>,
              refPath
            );
            if (nestedValue === undefined) {
              throw pathNotFound(refNodeId, refPath, template);
            }
          } else {
            // Node doesn't exist - use refNodeId (referenced node)
            throw nodeNotFound(refNodeId, [template]);
          }
        } else {
          // Simple template like {{a}} - check if it's a node reference
          if (!this.previousOutputs.has(path)) {
            throw nodeNotFound(path, [template]);
          }
        }
      }
      
      // Fallback: unresolved variable with context (should not reach here)
      throw unresolvedVariable(
        result.unresolved[0],
        result.unresolved.join(', ')
      );
    }
    
    return result.resolved;
  }

  // ============================================================================
  // Condition Evaluation Methods
  // ============================================================================

  /**
   * Evaluate a condition expression and return boolean result
   * Supports operators: ==, !=, >, <, >=, <=, &&, ||, !
   * 
   * @param condition - Condition expression with template references
   * @returns Boolean result of the condition
   * @throws Error if condition cannot be evaluated
   */
  evaluateCondition(condition: string): boolean {
    // First resolve any template references in the condition
    const resolved = this.resolveString(condition);
    
    // Parse and evaluate the condition
    return this.parseCondition(resolved);
  }

  /**
   * Parse and evaluate a condition string
   * Handles operator precedence: ! > && > ||
   */
  private parseCondition(condition: string): boolean {
    // Remove extra whitespace
    const expr = condition.trim();
    
    // Handle boolean literals
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    
    // Handle negation first (highest precedence)
    if (expr.startsWith('!')) {
      return !this.parseCondition(expr.slice(1).trim());
    }
    
    // Handle OR operator (lowest precedence) - split and evaluate
    // We need to find || that is NOT inside quotes
    const orParts = this.splitByOperator(expr, '||');
    if (orParts.length > 1) {
      return orParts.some(p => this.parseCondition(p.trim()));
    }
    
    // Handle AND operator
    const andParts = this.splitByOperator(expr, '&&');
    if (andParts.length > 1) {
      return andParts.every(p => this.parseCondition(p.trim()));
    }
    
    // Handle comparison operators (order matters: >= and <= must come before > and <)
    const comparisonPatterns = [
      { pattern: /^(.+)\s*===\s*(.+)$/, op: '===' },
      { pattern: /^(.+)\s*!==\s*(.+)$/, op: '!==' },
      { pattern: /^(.+)\s*==\s*(.+)$/, op: '==' },
      { pattern: /^(.+)\s*!=\s*(.+)$/, op: '!=' },
      { pattern: /^(.+)\s*>=\s*(.+)$/, op: '>=' },
      { pattern: /^(.+)\s*<=\s*(.+)$/, op: '<=' },
      { pattern: /^(.+)\s*>\s*(.+)$/, op: '>' },
      { pattern: /^(.+)\s*<\s*(.+)$/, op: '<' },
    ];
    
    for (const { pattern, op } of comparisonPatterns) {
      const match = expr.match(pattern);
      if (match) {
        const left = this.evaluateValue(match[1].trim());
        const right = this.evaluateValue(match[2].trim());
        return this.compare(left, right, op);
      }
    }
    
    // Fallback: treat as truthy
    return Boolean(this.evaluateValue(expr));
  }

  /**
   * Split a string by an operator, respecting quoted strings
   */
  private splitByOperator(expr: string, op: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes: string | null = null;
    
    for (let i = 0; i < expr.length; i++) {
      const char = expr[i];
      
      // Handle quotes
      if (char === '"' || char === "'") {
        if (inQuotes === char) {
          inQuotes = null;
        } else if (inQuotes === null) {
          inQuotes = char;
        }
        current += char;
      } else if (inQuotes) {
        current += char;
      } else if (expr.slice(i, i + op.length) === op) {
        parts.push(current);
        current = '';
        i += op.length - 1; // Skip the operator
      } else {
        current += char;
      }
    }
    
    if (current) {
      parts.push(current);
    }
    
    return parts;
  }

  /**
   * Evaluate a value (handles strings, numbers, booleans)
   */
  private evaluateValue(value: string): unknown {
    const v = value.trim();
    
    // Boolean
    if (v === 'true') return true;
    if (v === 'false') return false;
    
    // Number
    if (!isNaN(Number(v))) return Number(v);
    
    // String (remove quotes)
    if ((v.startsWith('"') && v.endsWith('"')) || 
        (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    
    // Already resolved value
    return v;
  }

  /**
   * Compare two values with the given operator
   */
  private compare(left: unknown, right: unknown, op: string): boolean {
    switch (op) {
      case '===': case '==': return left === right;
      case '!==': case '!=': return left !== right;
      case '>': return Number(left) > Number(right);
      case '<': return Number(left) < Number(right);
      case '>=': return Number(left) >= Number(right);
      case '<=': return Number(left) <= Number(right);
      default: return false;
    }
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Resolve template references in input using context.
 * 
 * @param input - Input value with potential templates
 * @param context - Node execution context
 * @returns Resolved input
 */
export function resolveTemplates(
  input: unknown,
  context: NodeExecutionContext
): unknown {
  const resolver = TemplateResolver.fromContext(context);
  return resolver.resolveValue(input);
}

/**
 * Resolve a template string using context.
 * 
 * @param template - Template string
 * @param context - Node execution context
 * @returns Resolved string
 */
export function resolveTemplateString(
  template: string,
  context: NodeExecutionContext
): string {
  const resolver = TemplateResolver.fromContext(context);
  return resolver.resolveString(template);
}
