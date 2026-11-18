import { describe, test, expect } from 'vitest';
import {
  WorkflowError,
  TemplateUnresolvedError,
  WorkflowValidationError,
  nodeNotFound,
  pathNotFound,
  unresolvedVariable,
} from './workflow-error';

describe('WorkflowError', () => {
  test('should create error with message', () => {
    const error = new WorkflowError('Test error');
    expect(error.message).toBe('Test error');
    expect(error.name).toBe('WorkflowError');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WorkflowError);
  });

  test('should include context', () => {
    const error = new WorkflowError('Test error', { nodeId: 'test-node' });
    expect(error.context).toEqual({ nodeId: 'test-node' });
    expect(error.toJSON()).toMatchObject({
      name: 'WorkflowError',
      message: 'Test error',
      context: { nodeId: 'test-node' },
    });
  });
});

describe('TemplateUnresolvedError', () => {
  test('should create error with unresolved templates', () => {
    const unresolved = ['{{input.missing}}', '{{nodes.nonexistent.value}}'];
    const error = new TemplateUnresolvedError(
      'Failed to resolve templates',
      unresolved
    );
    
    expect(error.message).toBe('Failed to resolve templates');
    expect(error.name).toBe('TemplateUnresolvedError');
    expect(error.unresolved).toEqual(unresolved);
    expect(error).toBeInstanceOf(WorkflowError);
    expect(error.toJSON()).toMatchObject({
      name: 'TemplateUnresolvedError',
      message: 'Failed to resolve templates',
      unresolved,
    });
  });

  test('should handle empty unresolved list', () => {
    const error = new TemplateUnresolvedError('No templates', []);
    expect(error.unresolved).toEqual([]);
  });
});

describe('WorkflowValidationError', () => {
  test('should create error with field and value', () => {
    const error = new WorkflowValidationError(
      'Invalid field',
      'input.schema',
      { type: 'string', required: true }
    );
    
    expect(error.message).toBe('Invalid field');
    expect(error.name).toBe('WorkflowValidationError');
    expect(error.field).toBe('input.schema');
    expect(error.invalidValue).toEqual({ type: 'string', required: true });
    expect(error).toBeInstanceOf(WorkflowError);
  });

  test('should handle optional invalidValue', () => {
    const error = new WorkflowValidationError('Missing required field', 'name');
    expect(error.field).toBe('name');
    expect(error.invalidValue).toBeUndefined();
  });
});

describe('Factory methods', () => {
  describe('nodeNotFound', () => {
    test('should create error for missing node', () => {
      const error = nodeNotFound('fetch', ['{{nodes.fetch.data}}']);
      
      expect(error.name).toBe('TemplateUnresolvedError');
      expect(error.context).toEqual({ nodeId: 'fetch', reason: 'node_not_found' });
      expect(error.unresolved).toContain('{{nodes.fetch.data}}');
    });
  });

  describe('pathNotFound', () => {
    test('should create error for missing path', () => {
      const error = pathNotFound('fetch', 'data.temp', '{{nodes.fetch.data.temp}}');
      
      expect(error.name).toBe('TemplateUnresolvedError');
      expect(error.context).toEqual({ 
        nodeId: 'fetch', 
        path: 'data.temp',
        reason: 'path_not_found' 
      });
      expect(error.unresolved).toContain('{{nodes.fetch.data.temp}}');
    });
  });

  describe('unresolvedVariable', () => {
    test('should create error for unresolved variable', () => {
      const error = unresolvedVariable('{{input.missing}}', 'input.missing');
      
      expect(error.name).toBe('TemplateUnresolvedError');
      expect(error.context).toEqual({ 
        template: '{{input.missing}}',
        path: 'input.missing',
        reason: 'unresolved_variable' 
      });
      expect(error.unresolved).toContain('{{input.missing}}');
    });

    test('should handle variable without path', () => {
      const error = unresolvedVariable('{{unknown}}');
      
      expect(error.context).toEqual({ 
        template: '{{unknown}}',
        reason: 'unresolved_variable' 
      });
    });
  });
});
