/**
 * @fileoverview Skill node validator
 */

import { BaseNodeValidator } from '../node-validator';
import { ValidationErrorType } from '../types';
import type { RawNodeDefinition, ValidationError } from '../types';

export class SkillNodeValidator extends BaseNodeValidator {
  readonly nodeType = 'skill';
  
  protected getRequiredFields(): string[] {
    return ['skill'];
  }
  
  protected validateTypeSpecific(node: RawNodeDefinition): ValidationError[] {
    const errors: ValidationError[] = [];
    
    const skill = node.config?.skill;
    if (skill !== undefined && typeof skill !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "skill" has invalid type',
        expected: 'skill must be a string (e.g., "text-summarizer")',
        actual: `typeof skill is "${typeof skill}"`,
        fix: `Change skill value to a string: skill: "${String(skill)}"`,
        nodeId: node.id,
      });
    }
    
    return errors;
  }
}
