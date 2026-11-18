/**
 * @fileoverview Node validator factory
 */

import type { NodeValidator } from './node-validator';
import { ToolNodeValidator } from './nodes/tool-node-validator';
import { SkillNodeValidator } from './nodes/skill-node-validator';
import { AgentNodeValidator } from './nodes/agent-node-validator';
import { WorkflowNodeValidator } from './nodes/workflow-node-validator';
import { ConditionNodeValidator } from './nodes/condition-node-validator';
import { MergeNodeValidator } from './nodes/merge-node-validator';
import { DecoratorNodeValidator } from './nodes/decorator-node-validator';
import { PythonCallNodeValidator } from './nodes/python-call-node-validator';

/**
 * Registry of node validators
 */
const validators: Map<string, NodeValidator> = new Map();

// Register built-in validators
validators.set('tool', new ToolNodeValidator());
validators.set('skill', new SkillNodeValidator());
validators.set('agent', new AgentNodeValidator());
validators.set('workflow', new WorkflowNodeValidator());
validators.set('condition', new ConditionNodeValidator());
validators.set('merge', new MergeNodeValidator());
validators.set('decorator', new DecoratorNodeValidator());
// Task #1998: workflow portability — Python function call node
validators.set('python_call', new PythonCallNodeValidator());

/**
 * Get validator for a node type
 */
export function getNodeValidator(type: string): NodeValidator | null {
  return validators.get(type) || null;
}

/**
 * Get all supported node types
 */
export function getSupportedNodeTypes(): string[] {
  return Array.from(validators.keys());
}
