import { describe, it, expect } from 'bun:test';
import {
  AskUserError,
  createNodeInterruptEvent,
  createWorkflowAskUserEvent,
  WorkflowMessageRoleSchema,
  type WorkflowMessagePart,
} from './workflow-message';

describe('AskUserError', () => {
  it('should create error with all properties', () => {
    const error = new AskUserError(
      'run_123',
      'workflow_run_123',
      'node_1',
      'agent',
      '确认继续吗？'
    );
    
    expect(error.runId).toBe('run_123');
    expect(error.sessionId).toBe('workflow_run_123');
    expect(error.nodeId).toBe('node_1');
    expect(error.nodeType).toBe('agent');
    expect(error.query).toBe('确认继续吗？');
    expect(error.type).toBe('ask-user');
    expect(error.name).toBe('AskUserError');
  });
  
  it('should convert to WorkflowAskUserEvent', () => {
    const error = new AskUserError(
      'run_123',
      'workflow_run_123',
      'node_1',
      'agent',
      '确认继续吗？'
    );
    
    const event = error.toEvent();
    
    expect(event.type).toBe('workflow.ask-user');
    expect(event.run_id).toBe('run_123');
    expect(event.session_id).toBe('workflow_run_123');
    expect(event.node_id).toBe('node_1');
    expect(event.node_type).toBe('agent');
    expect(event.query).toBe('确认继续吗？');
  });
  
  it('should have correct error message', () => {
    const error = new AskUserError(
      'run_123',
      'workflow_run_123',
      'node_1',
      'agent',
      '确认继续吗？'
    );
    
    expect(error.message).toBe('[agent:node_1] Ask user: 确认继续吗？');
  });
});

describe('createNodeInterruptEvent', () => {
  it('should create event with correct structure', () => {
    const event = createNodeInterruptEvent(
      'run_123',
      'node_1',
      'agent',
      '确认继续吗？'
    );
    
    expect(event.type).toBe('node.interrupt');
    expect(event.run_id).toBe('run_123');
    expect(event.node_id).toBe('node_1');
    expect(event.node_type).toBe('agent');
    expect(event.query).toBe('确认继续吗？');
    expect(typeof event.timestamp).toBe('number');
  });
});

describe('createWorkflowAskUserEvent', () => {
  it('should create event with correct structure', () => {
    const event = createWorkflowAskUserEvent(
      'run_123',
      'workflow_run_123',
      'node_1',
      'agent',
      '确认继续吗？'
    );
    
    expect(event.type).toBe('workflow.ask-user');
    expect(event.run_id).toBe('run_123');
    expect(event.session_id).toBe('workflow_run_123');
    expect(event.node_id).toBe('node_1');
    expect(event.node_type).toBe('agent');
    expect(event.query).toBe('确认继续吗？');
  });
});

describe('WorkflowMessageRoleSchema', () => {
  it('should validate workflow message roles', () => {
    expect(WorkflowMessageRoleSchema.parse('workflow.node.start')).toBe('workflow.node.start');
    expect(WorkflowMessageRoleSchema.parse('workflow.node.interrupt')).toBe('workflow.node.interrupt');
    expect(WorkflowMessageRoleSchema.parse('workflow.node.end')).toBe('workflow.node.end');
    expect(WorkflowMessageRoleSchema.parse('workflow.node.resume')).toBe('workflow.node.resume');
  });
  
  it('should reject invalid roles', () => {
    expect(() => WorkflowMessageRoleSchema.parse('user')).toThrow();
    expect(() => WorkflowMessageRoleSchema.parse('assistant')).toThrow();
  });
});

describe('WorkflowMessagePart types', () => {
  it('should allow WorkflowNodeStartPart', () => {
    const part: WorkflowMessagePart = {
      type: 'workflow-node-start',
      nodeId: 'node_1',
      nodeType: 'agent',
      input: { value: 42 },
      startTime: Date.now(),
    };
    
    expect(part.type).toBe('workflow-node-start');
    expect(part.nodeId).toBe('node_1');
  });
  
  it('should allow WorkflowNodeEndPart', () => {
    const part: WorkflowMessagePart = {
      type: 'workflow-node-end',
      nodeId: 'node_1',
      nodeType: 'agent',
      output: { result: 'success' },
      durationMs: 1000,
    };
    
    expect(part.type).toBe('workflow-node-end');
    expect(part.durationMs).toBe(1000);
  });
});
