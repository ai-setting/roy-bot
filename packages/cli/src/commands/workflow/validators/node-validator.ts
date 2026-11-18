/**
 * @fileoverview Node validator base class and interface
 */

import { ValidationErrorType, type ValidationError, type RawNodeDefinition } from './types';

/**
 * Base interface for node validators
 */
export interface NodeValidator {
  /** Node type this validator handles */
  readonly nodeType: string;
  
  /**
   * Validate a node of this type
   * @param node Raw node definition from YAML
   * @returns List of validation errors (empty if valid)
   */
  validate(node: RawNodeDefinition): ValidationError[];
}

/**
 * Base class for node validators with common utilities
 */
export abstract class BaseNodeValidator implements NodeValidator {
  abstract readonly nodeType: string;
  
  /**
   * Get required field names for this node type
   */
  protected abstract getRequiredFields(): string[];
  
  validate(node: RawNodeDefinition): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // Check node ID
    if (!node.id || typeof node.id !== 'string' || !node.id.trim()) {
      errors.push({
        type: ValidationErrorType.MISSING_REQUIRED_FIELD,
        description: 'Node ID is missing or empty',
        expected: 'id must be a non-empty string',
        actual: String(node.id),
        fix: 'Add an "id" field to the node, e.g., id: "node-1"',
        nodeId: undefined,
      });
    }
    
    // Check required fields
    for (const field of this.getRequiredFields()) {
      const value = node.config?.[field];
      if (value === undefined || value === null || value === '') {
        errors.push({
          type: ValidationErrorType.MISSING_REQUIRED_FIELD,
          description: `Required field "${field}" is missing`,
          expected: `${field} must be a non-empty value`,
          actual: String(value),
          fix: `Add "${field}: <value>" to node config`,
          nodeId: node.id,
        });
      }
    }
    
    // Add type-specific validation
    errors.push(...this.validateTypeSpecific(node));
    
    return errors;
  }
  
  /**
   * Override in subclasses for type-specific validation
   */
  protected validateTypeSpecific(_node: RawNodeDefinition): ValidationError[] {
    return [];
  }
  
  /**
   * Helper: Check field type
   */
  protected checkFieldType(
    node: RawNodeDefinition,
    field: string,
    expectedType: string,
    expectedFormat?: string
  ): ValidationError | null {
    const value = node.config?.[field];
    if (value === undefined || value === null) return null;
    
    let isValid = false;
    switch (expectedType) {
      case 'string':
        isValid = typeof value === 'string';
        break;
      case 'number':
        isValid = typeof value === 'number' && value > 0;
        break;
      case 'boolean':
        isValid = typeof value === 'boolean';
        break;
      case 'object':
        isValid = typeof value === 'object' && value !== null && !Array.isArray(value);
        break;
      case 'array':
        isValid = Array.isArray(value);
        break;
      case 'string|boolean':
        isValid = typeof value === 'string' || typeof value === 'boolean';
        break;
    }
    
    if (!isValid) {
      return {
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: `Field "${field}" has invalid type`,
        expected: expectedFormat || `${expectedType}`,
        actual: typeof value === 'object' ? JSON.stringify(value) : String(value),
        fix: expectedFormat?.includes('non-empty') && typeof value === 'string' && !value.trim()
          ? `Remove quotes or whitespace from ${field} value`
          : `Check ${field} type: expected ${expectedFormat || expectedType}`,
        nodeId: node.id,
      };
    }
    
    return null;
  }
}
