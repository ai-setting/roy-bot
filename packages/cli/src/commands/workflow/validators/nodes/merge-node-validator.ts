/**
 * @fileoverview Merge node validator
 */

import { BaseNodeValidator } from '../node-validator';
import { ValidationErrorType } from '../types';
import type { RawNodeDefinition, ValidationError } from '../types';

export class MergeNodeValidator extends BaseNodeValidator {
  readonly nodeType = 'merge';
  
  protected getRequiredFields(): string[] {
    // No required fields, but depends_on should be validated externally
    return [];
  }
  
  protected validateTypeSpecific(node: RawNodeDefinition): ValidationError[] {
    const errors: ValidationError[] = [];
    
    const strategy = node.config?.strategy;
    if (strategy !== undefined) {
      const validStrategies = ['collect', 'first', 'last', 'merge'];
      if (typeof strategy === 'string' && !validStrategies.includes(strategy)) {
        errors.push({
          type: ValidationErrorType.INVALID_FIELD_TYPE,
          description: 'Field "strategy" has invalid value',
          expected: `strategy must be one of: ${validStrategies.join(', ')}`,
          actual: String(strategy),
          fix: `Change strategy to one of: ${validStrategies.join(', ')}`,
          nodeId: node.id,
        });
      } else if (typeof strategy !== 'string') {
        errors.push({
          type: ValidationErrorType.INVALID_FIELD_TYPE,
          description: 'Field "strategy" has invalid type',
          expected: 'strategy must be a string',
          actual: typeof strategy,
          fix: 'Change strategy to a string value',
          nodeId: node.id,
        });
      }
    }
    
    return errors;
  }
}
