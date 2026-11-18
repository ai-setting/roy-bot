/**
 * @fileoverview Condition node validator
 */

import { BaseNodeValidator } from '../node-validator';
import { ValidationErrorType } from '../types';
import type { RawNodeDefinition, ValidationError } from '../types';

export class ConditionNodeValidator extends BaseNodeValidator {
  readonly nodeType = 'condition';
  
  protected getRequiredFields(): string[] {
    // No required fields for condition node
    return [];
  }
  
  protected validateTypeSpecific(node: RawNodeDefinition): ValidationError[] {
    const errors: ValidationError[] = [];
    
    const condition = node.config?.condition;
    if (condition !== undefined && typeof condition !== 'string' && typeof condition !== 'boolean') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "condition" has invalid type',
        expected: 'condition must be a string or boolean',
        actual: typeof condition,
        fix: 'Change condition to a string (template) or boolean value',
        nodeId: node.id,
      });
    }
    
    return errors;
  }
}
