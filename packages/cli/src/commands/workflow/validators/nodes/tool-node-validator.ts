/**
 * @fileoverview Tool node validator
 */

import { BaseNodeValidator } from '../node-validator';
import { ValidationErrorType } from '../types';
import type { RawNodeDefinition, ValidationError } from '../types';

export class ToolNodeValidator extends BaseNodeValidator {
  readonly nodeType = 'tool';
  
  protected getRequiredFields(): string[] {
    return ['tool'];
  }
  
  protected validateTypeSpecific(node: RawNodeDefinition): import('../types').ValidationError[] {
    const errors: import('../types').ValidationError[] = [];
    
    const tool = node.config?.tool;
    
    // Check tool is string
    if (tool !== undefined && typeof tool !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "tool" has invalid type',
        expected: 'tool must be a string (e.g., "bash", "read-file")',
        actual: `typeof tool is "${typeof tool}"`,
        fix: `Change tool value to a string: tool: "${String(tool)}"`,
        nodeId: node.id,
      });
    }
    
    // Check timeout if present
    const timeoutError = this.checkFieldType(node, 'timeout', 'number', 'positive number (milliseconds)');
    if (timeoutError) {
      errors.push(timeoutError);
    }
    
    // Check input if present
    const input = node.config?.input;
    if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "input" has invalid type',
        expected: 'input must be an object (key-value pairs)',
        actual: Array.isArray(input) ? 'array' : typeof input,
        fix: 'Change input to an object: input: { key: "value" }',
        nodeId: node.id,
      });
    }
    
    return errors;
  }
}
