/**
 * @fileoverview MergeNode - Workflow merge/join node
 * 
 * A merge node waits for all dependencies to complete and collects their outputs.
 * 
 * Input can contain template strings like {{nodeId.output.path}} that will be
 * resolved from previousOutputs.
 */

import type { Node, NodeDefinition, NodeExecutionContext, NodeExecutionResult } from '../types';
import { getFromMapWithNormalization } from '../utils/node-id-utils';

/**
 * MergeNode collects outputs from all dependent nodes and optionally merges them.
 * 
 * The merge strategy can be:
 * - "collect": Collect all outputs into an array
 * - "first": Return the first completed output
 * - "last": Return the last completed output
 * - "merge": Deep merge all outputs into a single object
 * 
 * Usage in workflow:
 * ```yaml
 * nodes:
 *   - id: final
 *     type: merge
 *     config:
 *       strategy: collect
 *     depends_on:
 *       - log-workflow-complete
 * ```
 */
export class MergeNode implements Node {
  readonly type = 'merge';
  readonly id: string;
  
  constructor(
    private definition: NodeDefinition,
  ) {
    this.id = definition.id;
  }
  
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const startTime = Date.now();
    
    try {
      // Get merge strategy from config (default: collect)
      const strategy = (this.definition.config?.strategy as string) || 'collect';
      
      // Get dependency outputs
      const deps = this.definition.depends_on || [];
      const outputs: Record<string, unknown> = {};
      
      for (const depId of deps) {
        // 尝试规范化匹配（hyphen <-> underscore）
        const output = getFromMapWithNormalization(context.previousOutputs, depId);
        if (output !== undefined) {
          outputs[depId] = output;
        }
      }
      
      // Apply merge strategy
      let result: unknown;
      
      switch (strategy) {
        case 'collect':
          // Return all outputs as a map
          result = outputs;
          break;
          
        case 'first':
          // Return the first output
          const firstKey = Object.keys(outputs)[0];
          result = firstKey ? outputs[firstKey] : undefined;
          break;
          
        case 'last':
          // Return the last output
          const lastKey = Object.keys(outputs).pop();
          result = lastKey ? outputs[lastKey] : undefined;
          break;
          
        case 'merge':
          // Deep merge all outputs
          result = this.deepMerge(Object.values(outputs));
          break;
          
        default:
          result = outputs;
      }
      
      return {
        output: {
          strategy,
          results: result,
          count: Object.keys(outputs).length,
        },
        error: undefined,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        output: undefined,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs: Date.now() - startTime,
      };
    }
  }
  
  /**
   * Deep merge multiple objects into a single object.
   */
  private deepMerge(objects: unknown[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    
    for (const obj of objects) {
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
          if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) &&
              value && typeof value === 'object' && !Array.isArray(value)) {
            // Recursively merge nested objects
            result[key] = this.deepMerge([result[key], value]);
          } else {
            result[key] = value;
          }
        }
      }
    }
    
    return result;
  }
}
