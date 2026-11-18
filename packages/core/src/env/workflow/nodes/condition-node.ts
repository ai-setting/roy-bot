/**
 * @fileoverview ConditionNode - Workflow condition node
 * 
 * Evaluates a condition and decides whether to proceed or skip.
 * 
 * Input can contain template strings like {{nodeId.output.path}} that will be
 * resolved from previousOutputs via TemplateResolver.
 */

import type { Node, NodeDefinition, NodeExecutionContext, NodeExecutionResult } from '../types';
import { TracedAs } from '../../log-trace/decorator';
import { createLogger } from '../../log-trace/logger';

const logger = createLogger('workflow.condition');

/**
 * ConditionNode evaluates a condition and returns the result.
 * 
 * The condition can be:
 * - A boolean value
 * - A template expression that evaluates to a boolean
 * - A template reference to a previous node's output
 * 
 * Usage in workflow:
 * ```yaml
 * nodes:
 *   - id: check-tests-pass
 *     type: condition
 *     config:
 *       condition: "{{run-unit-tests.success}}"
 *     depends_on:
 *       - run-unit-tests
 * ```
 */
export class ConditionNode implements Node {
  readonly type = 'condition';
  readonly id: string;
  
  constructor(
    private definition: NodeDefinition,
  ) {
    this.id = definition.id;
  }
  
  @TracedAs('workflow.condition.execute')
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const startTime = Date.now();
    
    try {
      // Get condition from config
      // Use pre-resolved config from context if available (avoids duplicate resolution)
      // Falls back to raw config for backward compatibility
      const rawCondition = this.definition.config?.condition;
      
      if (rawCondition === undefined) {
        // No condition specified, default to true (pass through)
        return {
          output: { success: true, condition: true },
          error: undefined,
          durationMs: Date.now() - startTime,
        };
      }
      
      // Resolve the condition value
      // If context.resolvedConfig is provided, use the pre-resolved value
      // Otherwise, resolve it manually using templateResolver
      let conditionConfig: unknown;
      
      if (context.resolvedConfig !== undefined) {
        // Pre-resolved config available - use the resolved condition directly
        conditionConfig = context.resolvedConfig.condition;
      } else {
        // No pre-resolved config - resolve manually
        // Check if condition contains template references that need resolution
        const containsTemplate = typeof rawCondition === 'string' && /\{\{.*\}\}/.test(rawCondition);
        
        if (containsTemplate && !context.templateResolver) {
          // Provide a friendly warning when template references exist but no resolver is available
          logger.warn(
            `[ConditionNode:${this.id}] Condition contains template references "{{...}}" but ` +
            `templateResolver is not available. The condition will be evaluated as-is. ` +
            `To resolve templates, ensure the workflow engine provides a templateResolver.`
          );
          conditionConfig = rawCondition;
        } else if (context.templateResolver) {
          conditionConfig = context.templateResolver.resolveValue(rawCondition);
        } else {
          conditionConfig = rawCondition;
        }
      }
      
      // Evaluate the condition
      const result = this.evaluateCondition(conditionConfig);
      
      return {
        output: { success: result, condition: conditionConfig },
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
   * Evaluate a resolved condition value.
   */
  private evaluateCondition(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true' || value === '1';
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    if (value === null || value === undefined) {
      return false;
    }
    // For objects, check if it has a 'success' property
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if ('success' in obj) {
        return Boolean(obj.success);
      }
      // Non-empty object is truthy
      return Object.keys(obj).length > 0;
    }
    return Boolean(value);
  }
}
