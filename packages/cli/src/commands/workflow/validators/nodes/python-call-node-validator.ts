/**
 * @fileoverview PythonCall node validator
 *
 * Task #1998: 投资选股 workflow 解耦 CLI/bash 依赖
 *
 * Validates `type: python_call` workflow nodes. The required fields are
 * `module` and `function`. Optional fields: `args`, `cwd`, `python`, `timeout`.
 */

import { BaseNodeValidator } from '../node-validator';
import { ValidationErrorType } from '../types';
import type { RawNodeDefinition, ValidationError } from '../types';

export class PythonCallNodeValidator extends BaseNodeValidator {
  readonly nodeType = 'python_call';

  protected getRequiredFields(): string[] {
    return ['module', 'function'];
  }

  protected validateTypeSpecific(node: RawNodeDefinition): ValidationError[] {
    const errors: ValidationError[] = [];
    const config = node.config ?? {};

    // module: required string matching Python dotted-identifier
    const moduleVal = config.module;
    if (moduleVal === undefined || moduleVal === null) {
      errors.push({
        type: ValidationErrorType.MISSING_REQUIRED_FIELD,
        description: 'Field "module" is required for python_call node',
        expected: 'module: "<python.module.path>"',
        actual: 'undefined',
        fix: 'Add `module: "<python.module.path>"` to the node config',
        nodeId: node.id,
      });
    } else if (typeof moduleVal !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "module" has invalid type',
        expected: 'string (Python module path, e.g. "investment_strategy.scripts.market_timing")',
        actual: typeof moduleVal,
        fix: 'Change `module` to a string',
        nodeId: node.id,
      });
    } else if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(moduleVal)) {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: `Field "module" is not a valid Python module path: "${moduleVal}"`,
        expected: 'dotted identifier like "pkg.sub.mod"',
        actual: moduleVal,
        fix: 'Use only letters, digits, underscores, and dots',
        nodeId: node.id,
      });
    }

    // function: required string matching Python identifier
    const fnVal = config.function;
    if (fnVal === undefined || fnVal === null) {
      errors.push({
        type: ValidationErrorType.MISSING_REQUIRED_FIELD,
        description: 'Field "function" is required for python_call node',
        expected: 'function: "<python_function_name>"',
        actual: 'undefined',
        fix: 'Add `function: "<name>"` to the node config',
        nodeId: node.id,
      });
    } else if (typeof fnVal !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "function" has invalid type',
        expected: 'string (Python function name, e.g. "run")',
        actual: typeof fnVal,
        fix: 'Change `function` to a string',
        nodeId: node.id,
      });
    } else if (!/^[A-Za-z_]\w*$/.test(fnVal)) {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: `Field "function" is not a valid Python identifier: "${fnVal}"`,
        expected: 'Python identifier: starts with letter/underscore, contains only [A-Za-z0-9_]',
        actual: fnVal,
        fix: 'Use a plain Python function name (no dots, no operators)',
        nodeId: node.id,
      });
    }

    // args: optional object
    const argsVal = config.args;
    if (argsVal !== undefined && (typeof argsVal !== 'object' || argsVal === null || Array.isArray(argsVal))) {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "args" has invalid type',
        expected: 'object (kwargs to pass to the function)',
        actual: Array.isArray(argsVal) ? 'array' : typeof argsVal,
        fix: 'Change `args` to an object: args: { key: value }',
        nodeId: node.id,
      });
    }

    // cwd: optional string
    if (config.cwd !== undefined && typeof config.cwd !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "cwd" has invalid type',
        expected: 'string (filesystem path)',
        actual: typeof config.cwd,
        fix: 'Change `cwd` to a string',
        nodeId: node.id,
      });
    }

    // python: optional string
    if (config.python !== undefined && typeof config.python !== 'string') {
      errors.push({
        type: ValidationErrorType.INVALID_FIELD_TYPE,
        description: 'Field "python" has invalid type',
        expected: 'string (path to python interpreter)',
        actual: typeof config.python,
        fix: 'Change `python` to a string',
        nodeId: node.id,
      });
    }

    // timeout: optional positive number
    if (config.timeout !== undefined) {
      const t = config.timeout;
      if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
        errors.push({
          type: ValidationErrorType.INVALID_FIELD_TYPE,
          description: 'Field "timeout" has invalid type',
          expected: 'positive number (milliseconds)',
          actual: typeof t === 'number' ? `${t}` : typeof t,
          fix: 'Change `timeout` to a positive number, e.g. timeout: 60000',
          nodeId: node.id,
        });
      }
    }

    return errors;
  }
}