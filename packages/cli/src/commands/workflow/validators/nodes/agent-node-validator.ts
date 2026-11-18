/**
 * @fileoverview Agent node validator
 */

import { BaseNodeValidator } from '../node-validator';
import { ValidationErrorType } from '../types';
import type { RawNodeDefinition, ValidationError } from '../types';

export class AgentNodeValidator extends BaseNodeValidator {
  readonly nodeType = 'agent';
  
  protected getRequiredFields(): string[] {
    return ['agent_type', 'prompt'];
  }
  
  protected validateTypeSpecific(node: RawNodeDefinition): ValidationError[] {
    const errors: ValidationError[] = [];
    
    const agentType = node.config?.agent_type;
    if (agentType !== undefined && typeof agentType !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "agent_type" has invalid type',
        expected: 'agent_type must be a string (e.g., "general", "research")',
        actual: `typeof agent_type is "${typeof agentType}"`,
        fix: `Change agent_type value to a string: agent_type: "${String(agentType)}"`,
        nodeId: node.id,
      });
    }
    
    const prompt = node.config?.prompt;
    if (prompt !== undefined && typeof prompt !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "prompt" has invalid type',
        expected: 'prompt must be a string',
        actual: `typeof prompt is "${typeof prompt}"`,
        fix: `Change prompt value to a string`,
        nodeId: node.id,
      });
    }
    
    // Check options if present
    const options = node.config?.options;
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "options" has invalid type',
        expected: 'options must be an object',
        actual: Array.isArray(options) ? 'array' : typeof options,
        fix: 'Change options to an object: options: { timeout: 60000 }',
        nodeId: node.id,
      });
    }
    
    return errors;
  }
}
