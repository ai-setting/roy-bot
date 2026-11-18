/**
 * @fileoverview Workflow node validator
 */

import { BaseNodeValidator } from '../node-validator';
import { ValidationErrorType } from '../types';
import type { RawNodeDefinition, ValidationError } from '../types';

export class WorkflowNodeValidator extends BaseNodeValidator {
  readonly nodeType = 'workflow';
  
  protected getRequiredFields(): string[] {
    return ['workflow_name'];
  }
  
  protected validateTypeSpecific(node: RawNodeDefinition): ValidationError[] {
    const errors: ValidationError[] = [];
    
    const workflowName = node.config?.workflow_name;
    if (workflowName !== undefined && typeof workflowName !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "workflow_name" has invalid type',
        expected: 'workflow_name must be a string',
        actual: `typeof workflow_name is "${typeof workflowName}"`,
        fix: `Change workflow_name value to a string: workflow_name: "${String(workflowName)}"`,
        nodeId: node.id,
      });
    }
    
    return errors;
  }
}
