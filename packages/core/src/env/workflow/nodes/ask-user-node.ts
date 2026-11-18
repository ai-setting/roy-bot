/**
 * @fileoverview AskUserNode - Node for requesting user input
 * 
 * This node is used for simple pause/resume scenarios where a workflow
 * needs user input without going through an Agent.
 */

import type { Node, NodeExecutionResult } from '../types';
import type { NodeDefinition } from '../types';
import { AskUserError, createNodeInterruptEvent } from '../types/workflow-hil';
import type { NodeInterruptEvent } from '../types/workflow-hil';

// ==================== Types ====================

/**
 * AskUserNode Configuration
 */
export interface AskUserNodeConfig {
  /** Question to ask the user */
  query?: string;
  /** Optional choices for the user */
  options?: string[];
  /** If true, user must explicitly confirm */
  required_confirm?: boolean;
}

// ==================== AskUserNode Class ====================

/**
 * AskUserNode - Standalone node for user input requests
 * 
 * This node pauses the workflow and waits for user response.
 * Used for simple human-in-loop scenarios without an Agent.
 * 
 * @example
 * ```yaml
 * nodes:
 *   - id: confirm_step
 *     type: ask_user
 *     config:
 *       query: "Do you want to proceed?"
 *       options:
 *         - "Yes"
 *         - "No"
 *         - "Cancel"
 * ```
 */
export class AskUserNode implements Node {
  readonly type = 'ask_user';
  readonly id: string;
  
  constructor(
    private definition: NodeDefinition,
  ) {
    this.id = definition.id;
  }
  
  /**
   * Execute the AskUserNode
   * 
   * Publishes a node.interrupt event and throws AskUserError to pause workflow.
   * 
   * @param context - Node execution context with optional resolvedConfig
   * @throws AskUserError - Always throws to pause workflow
   */
  async execute(context: {
    runId: string;
    sessionId: string;
    eventBus: {
      publish(event: NodeInterruptEvent): Promise<void>;
    };
    nodeOutputs: Map<string, unknown>;
    resolvedConfig?: Record<string, unknown>;
  }): Promise<NodeExecutionResult> {
    // Use pre-resolved config from context if available
    // Falls back to raw config for backward compatibility
    const config = (context.resolvedConfig ?? this.definition.config ?? {}) as AskUserNodeConfig;
    const query = config.query || '确认继续吗？';
    const options = config.options;
    
    // Build query with options if provided
    const fullQuery = options 
      ? `${query} (选项: ${options.join(', ')})`
      : query;
    
    // Publish node.interrupt event
    await context.eventBus.publish(
      createNodeInterruptEvent(
        context.runId,
        this.id,
        this.type,
        fullQuery
      )
    );
    
    // Throw AskUserError to pause workflow
    throw new AskUserError(
      context.runId,
      context.sessionId,
      this.id,
      this.type,
      query
    );
  }
  
  /**
   * Validate node configuration
   */
  validateConfig(_config: Record<string, unknown>): boolean {
    // query is optional, has default value
    return true;
  }
}
