import type { Node, NodeDefinition, NodeExecutionContext, NodeExecutionResult } from '../types';

/**
 * WorkflowRunner interface for running sub-workflows
 */
export interface WorkflowRunner {
  /**
   * Run a workflow by name
   * @param workflowName - Name of the workflow to run
   * @param input - Optional input to pass to the workflow
   * @returns Promise resolving to the workflow run result
   */
  run(workflowName: string, input?: any): Promise<WorkflowRunResult>;
  
  /**
   * Get the status of a workflow run
   * @param runId - The run ID to check
   * @returns Promise resolving to the run result or null if not found
   */
  getRun(runId: string): Promise<WorkflowRunResult | null>;
}

/**
 * Result from a workflow run
 */
export interface WorkflowRunResult {
  /** Unique run ID */
  runId: string;
  /** Final status of the run */
  status: 'completed' | 'failed' | 'stopped';
  /** Output from the workflow (if completed) */
  output?: any;
  /** Error message (if failed or stopped) */
  error?: string;
}

/**
 * WorkflowNode configuration
 */
export interface WorkflowNodeConfig {
  /** Name of the workflow to invoke */
  workflow_name: string;
  /** Input to pass to the sub-workflow (supports template strings) */
  input?: Record<string, unknown>;
  /** Whether to wait for completion (default: true) */
  wait_complete?: boolean;
}

/**
 * WorkflowNode executes a nested workflow as a node.
 * 
 * This allows one workflow to invoke another workflow as a single node,
 * enabling workflow composition and reusability.
 * 
 * Features:
 * - Pass input to sub-workflow (with template resolution)
 * - Wait for completion or fire-and-forget
 * - Handle sub-workflow errors
 * - Track execution duration
 */
export class WorkflowNode implements Node {
  readonly type = 'workflow';
  readonly id: string;
  
  constructor(
    private definition: NodeDefinition,
    private workflowRunner: WorkflowRunner
  ) {
    this.id = definition.id;
  }
  
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const startTime = Date.now();
    
    try {
      // Use pre-resolved config from context if available (avoids duplicate resolution)
      // Falls back to raw config for backward compatibility
      const config = (context.resolvedConfig ?? this.definition.config ?? {}) as unknown as WorkflowNodeConfig;
      
      // 1. Get workflow name from config
      const workflowName = config.workflow_name;
      
      if (!workflowName) {
        throw new Error('workflow_name is required in config. Please specify config.workflow_name in the node definition.');
      }
      
      // 2. Resolve input template (may reference previous outputs)
      // Note: Since config is pre-resolved, no need to resolve input templates again
      // Support both Map (previousOutputs) and Record (nodeOutputs) formats
      const previousOutputs = context.previousOutputs ?? this.convertToMap((context.nodeOutputs ?? {}) as any);
      const resolvedInput = this.resolveInput(
        config.input ?? {},
        previousOutputs
      );
      
      // 3. Run sub-workflow via workflowRunner
      const result = await this.workflowRunner.run(workflowName, resolvedInput);
      
      // 4. Determine success based on status
      const success = result.status === 'completed';
      
      // 5. Return result
      return {
        success,
        output: result.output,
        error: success ? undefined : result.error,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        output: undefined,
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
      };
    }
  }
  
  /**
   * Convert Record<string, NodeExecutionResult> to Map<string, any>
   * for compatibility with resolvePath that expects Map format.
   * 
   * In the Record format, the value is NodeExecutionResult (with output field).
   * In the Map format, the value is the raw output directly.
   */
  private convertToMap(nodeOutputs: Record<string, NodeExecutionResult>): Map<string, any> {
    const map = new Map<string, any>();
    for (const [nodeId, result] of Object.entries(nodeOutputs)) {
      // Store the entire result for access to both output and success
      map.set(nodeId, result.output);
    }
    return map;
  }
  
  /**
   * Resolve input template references.
   * Templates are in the format {{nodeId.output.path}}
   * 
   * @param input - The input object that may contain template strings
   * @param previousOutputs - Map of previous node outputs (value is raw output)
   * @returns The input with template references resolved
   */
  private resolveInput(
    input: Record<string, unknown>,
    previousOutputs: Map<string, any>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(input)) {
      resolved[key] = this.resolveValue(value, previousOutputs);
    }
    
    return resolved;
  }
  
  /**
   * Resolve a value that may contain template references.
   */
  private resolveValue(value: unknown, previousOutputs: Map<string, any>): unknown {
    if (typeof value === 'string') {
      return this.resolveStringTemplate(value, previousOutputs);
    }
    
    if (Array.isArray(value)) {
      return value.map(item => this.resolveValue(item, previousOutputs));
    }
    
    if (value !== null && typeof value === 'object') {
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        resolved[k] = this.resolveValue(v, previousOutputs);
      }
      return resolved;
    }
    
    // Return primitive values as-is
    return value;
  }
  
  /**
   * Resolve template references in a single string.
   * Supports format: {{nodeId.output.path}}
   */
  private resolveStringTemplate(
    template: string,
    previousOutputs: Map<string, any>
  ): string {
    // Match template patterns like {{nodeId}} or {{nodeId.output.value}}
    const templatePattern = /\{\{([^}]+)\}\}/g;
    
    return template.replace(templatePattern, (match, path) => {
      const trimmedPath = path.trim();
      
      // Try to resolve the path from previous outputs
      const value = this.resolvePath(trimmedPath, previousOutputs);
      
      if (value !== undefined) {
        return this.stringifyValue(value, match);
      }
      
      // If not found, return the original template string
      return match;
    });
  }
  
  /**
   * Resolve a dot-notation path from previous outputs.
   * First segment is the node ID, rest is the path within that node's output.
   */
  private resolvePath(
    path: string,
    previousOutputs: Map<string, any>
  ): unknown {
    const segments = path.split('.');
    
    if (segments.length === 0) {
      return undefined;
    }
    
    const nodeId = segments[0];
    let nodeOutput = previousOutputs.get(nodeId);
    
    if (nodeOutput === undefined) {
      return undefined;
    }
    
    // Extract from wrapper formats (DecoratorNode: {success, output} and AgentNode: {result, metadata})
    nodeOutput = this.extractFromWrapper(nodeOutput);
    
    // If no path beyond node ID, return the extracted value
    if (segments.length === 1) {
      return nodeOutput;
    }
    
    // Navigate the path within the node's output
    // Skip first segment if it's a wrapper property since extractFromWrapper already extracted it
    let current: any = nodeOutput;
    let startIndex = 1;
    if (segments.length > 1 && 
        (segments[1] === 'output' || segments[1] === 'result' || segments[1] === 'metadata')) {
      startIndex = 2;
    }
    
    for (let i = startIndex; i < segments.length; i++) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[segments[i]];
    }
    
    return current;
  }

  /**
   * Extract the actual output value from wrapper formats.
   * 
   * Handles:
   * - AgentNode format: { result, metadata } -> returns result
   * - DecoratorNode format: { success, output, ... } -> returns output
   * - Other formats: returns value as-is
   * 
   * @param value - The value to extract from
   * @returns The extracted value
   */
  private extractFromWrapper(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    
    if (typeof value !== 'object') {
      return value;
    }
    
    // Check for AgentNode wrapper: { result, metadata }
    // This is the signature of AgentNode output
    if ('result' in value && 'metadata' in value) {
      return (value as { result: unknown }).result;
    }
    
    // Check for DecoratorNode wrapper: { success, output, ... }
    // This has 'output' but NOT 'result' (that's AgentNode's signature)
    if ('output' in value) {
      return (value as { output: unknown }).output;
    }
    
    return value;
  }

  /**
   * Convert a value to string for template replacement.
   * - If value is undefined, return the original template
   * - If value is a string, return it directly
   * - If value is null, return 'null'
   * - If value is an object or array, serialize to JSON
   * 
   * @param value - The value to stringify
   * @param originalTemplate - The original template string (returned if value is undefined)
   * @returns String representation of the value
   */
  private stringifyValue(value: unknown, originalTemplate: string): string {
    if (value === undefined) {
      return originalTemplate;
    }
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'string') {
      return value;
    }
    // For objects and arrays, serialize to JSON
    return JSON.stringify(value);
  }
}
