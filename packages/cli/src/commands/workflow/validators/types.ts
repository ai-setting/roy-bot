/**
 * @fileoverview Workflow validation types
 */

/**
 * Validation error types
 */
export enum ValidationErrorType {
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  INVALID_FIELD_TYPE = 'INVALID_FIELD_TYPE',
  INVALID_NODE_TYPE = 'INVALID_NODE_TYPE',
  INVALID_REFERENCE = 'INVALID_REFERENCE',
  CIRCULAR_DEPENDENCY = 'CIRCULAR_DEPENDENCY',
  EMPTY_NODES = 'EMPTY_NODES',
  DUPLICATE_NODE_ID = 'DUPLICATE_NODE_ID',
  INVALID_TEMPLATE_REFERENCE = 'INVALID_TEMPLATE_REFERENCE',
  UNDEFINED_INPUT_REFERENCE = 'UNDEFINED_INPUT_REFERENCE',
  MISSING_REQUIRED_INPUT = 'MISSING_REQUIRED_INPUT',
}

/**
 * Validation error detail
 */
export interface ValidationError {
  /** Error identifier for programmatic handling */
  type: ValidationErrorType;
  /** Human-readable error description */
  description: string;
  /** Expected value or format */
  expected: string;
  /** Actual value encountered */
  actual: string;
  /** Suggested fix */
  fix: string;
  /** Node ID if error is node-specific */
  nodeId?: string;
  /** Template reference if error is template-related (e.g., "{{nodes.step-one.output}}") */
  template?: string;
  /** Referenced node ID if the template references a non-existent node */
  referencedNodeId?: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** List of validation errors */
  errors: ValidationError[];
  /** Validated workflow name */
  workflowName?: string;
  /** Number of nodes validated */
  nodeCount?: number;
}

/**
 * Raw node definition from YAML (before strict typing)
 */
export interface RawNodeDefinition {
  id?: string;
  type?: string;
  name?: string;
  config?: Record<string, unknown>;
  depends_on?: string[];
  condition?: string;
  timeout?: unknown;
  retry?: unknown;
}

/**
 * Raw workflow definition from YAML
 */
export interface RawWorkflowDefinition {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  nodes?: RawNodeDefinition[];
  config?: unknown;
  inputs?: RawWorkflowInput[];
}

/**
 * Raw workflow input definition
 */
export interface RawWorkflowInput {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
}
