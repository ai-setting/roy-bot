/**
 * @fileoverview Workflow Error Types
 * 
 * Defines error classes for workflow template resolution and validation.
 */

import { z } from 'zod';

/**
 * Error context schema for structured error data
 */
export const WorkflowErrorContextSchema = z.record(z.unknown());
export type WorkflowErrorContext = z.infer<typeof WorkflowErrorContextSchema>;

/**
 * Base workflow error class
 */
export class WorkflowError extends Error {
  readonly context: WorkflowErrorContext;

  constructor(message: string, context: WorkflowErrorContext = {}) {
    super(message);
    this.context = context;
    // Set name from constructor name for proper error type identification
    Object.defineProperty(this, 'name', {
      value: this.constructor.name,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    
    // Maintains proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to JSON-serializable object
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      stack: this.stack,
    };
  }
}

/**
 * Error thrown when template resolution fails due to unresolved templates.
 * 
 * This error captures the list of unresolved template strings for debugging
 * and potential user feedback.
 */
export class TemplateUnresolvedError extends WorkflowError {
  /**
   * List of template strings that could not be resolved
   */
  readonly unresolved: string[];

  constructor(message: string, unresolved: string[] = [], context: WorkflowErrorContext = {}) {
    super(message, context);
    this.unresolved = unresolved;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      unresolved: this.unresolved,
    };
  }
}

/**
 * Error thrown when workflow definition validation fails.
 * 
 * This includes validation of node configurations, input schemas,
 * output definitions, and edge connections.
 */
export class WorkflowValidationError extends WorkflowError {
  /**
   * The field or path that failed validation
   */
  readonly field: string;
  
  /**
   * The invalid value that was provided
   */
  readonly invalidValue: unknown;

  constructor(
    message: string, 
    field: string, 
    invalidValue?: unknown
  ) {
    super(message, { field });
    this.field = field;
    this.invalidValue = invalidValue;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      field: this.field,
      invalidValue: this.invalidValue,
    };
  }
}

// ============================================================================
// Factory Methods
// ============================================================================

/**
 * Create a TemplateUnresolvedError for when a referenced node is not found.
 * 
 * @param referencedNodeId - The referenced node ID that was not found
 * @param unresolved - List of template strings referencing the node
 * @returns TemplateUnresolvedError instance
 */
export function nodeNotFound(referencedNodeId: string, unresolved: string[]): TemplateUnresolvedError {
  return new TemplateUnresolvedError(
    `Referenced node not found: ${referencedNodeId}`,
    unresolved,
    { nodeId: referencedNodeId, reason: 'node_not_found' }
  );
}

/**
 * Create a TemplateUnresolvedError for when a path within a node's output is not found.
 * 
 * @param referencedNodeId - The referenced node ID
 * @param path - The path that was not found
 * @param template - The template string that referenced this path
 * @returns TemplateUnresolvedError instance
 */
export function pathNotFound(referencedNodeId: string, path: string, template: string): TemplateUnresolvedError {
  return new TemplateUnresolvedError(
    `Path not found in node ${referencedNodeId}: ${path}`,
    [template],
    { nodeId: referencedNodeId, path, reason: 'path_not_found' }
  );
}

/**
 * Create a TemplateUnresolvedError for an unresolved variable reference.
 * 
 * @param template - The unresolved template string
 * @param path - The path that could not be resolved
 * @returns TemplateUnresolvedError instance
 */
export function unresolvedVariable(template: string, path?: string): TemplateUnresolvedError {
  const context: WorkflowErrorContext = { template, reason: 'unresolved_variable' };
  if (path) {
    context.path = path;
  }
  return new TemplateUnresolvedError(
    `Unresolved variable: ${template}`,
    [template],
    context
  );
}
