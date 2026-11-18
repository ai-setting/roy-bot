/**
 * @fileoverview Decorator node validator
 */

import { BaseNodeValidator } from '../node-validator';
import { ValidationErrorType } from '../types';
import type { RawNodeDefinition, ValidationError } from '../types';

export class DecoratorNodeValidator extends BaseNodeValidator {
  readonly nodeType = 'decorator';
  
  protected getRequiredFields(): string[] {
    return ['_methodName', '_instance'];
  }
  
  protected validateTypeSpecific(node: RawNodeDefinition): ValidationError[] {
    const errors: ValidationError[] = [];
    
    const methodName = node.config?._methodName;
    if (methodName !== undefined && typeof methodName !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "_methodName" has invalid type',
        expected: '_methodName must be a string',
        actual: typeof methodName,
        fix: `Change _methodName value to a string: _methodName: "${String(methodName)}"`,
        nodeId: node.id,
      });
    }
    
    const instance = node.config?._instance;
    if (instance !== undefined && typeof instance !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "_instance" has invalid type',
        expected: '_instance must be a string (template reference)',
        actual: typeof instance,
        fix: 'Change _instance to a template string: _instance: "{{input.instance}}"',
        nodeId: node.id,
      });
    }
    
    return errors;
  }
}
