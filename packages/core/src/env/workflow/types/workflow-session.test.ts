import { describe, it, expect } from 'vitest';
import { isWorkflowSessionMetadata, getWorkflowSessionStatus } from './workflow-session';

describe('WorkflowSessionMetadata', () => {
  describe('isWorkflowSessionMetadata', () => {
    it('should accept simplified metadata with required fields only', () => {
      const metadata = {
        type: 'workflow' as const,
        workflowId: 'my-workflow',
        workflowName: 'My Workflow',
        status: 'running' as const,
      };
      
      expect(isWorkflowSessionMetadata(metadata)).toBe(true);
    });
    
    it('should accept all valid statuses', () => {
      const statuses = ['running', 'paused', 'completed', 'failed', 'stopped'];
      
      for (const status of statuses) {
        const metadata = {
          type: 'workflow' as const,
          workflowId: 'wf',
          workflowName: 'Wf',
          status,
        };
        expect(isWorkflowSessionMetadata(metadata)).toBe(true, `Status ${status} should be valid`);
      }
    });
    
    it('should accept metadata with optional fields', () => {
      const metadata = {
        type: 'workflow' as const,
        workflowId: 'my-workflow',
        workflowName: 'My Workflow',
        status: 'running' as const,
        workflowVersion: '1.0.0',
      };
      
      expect(isWorkflowSessionMetadata(metadata)).toBe(true);
    });
    
    it('should reject non-workflow metadata', () => {
      const metadata = { type: 'agent', name: 'test' };
      expect(isWorkflowSessionMetadata(metadata)).toBe(false);
    });
    
    it('should reject metadata without type', () => {
      const metadata = { workflowId: 'wf', workflowName: 'Wf', status: 'running' };
      expect(isWorkflowSessionMetadata(metadata)).toBe(false);
    });
    
    it('should reject metadata without workflowId', () => {
      const metadata = { type: 'workflow', workflowName: 'Wf', status: 'running' };
      expect(isWorkflowSessionMetadata(metadata)).toBe(false);
    });
    
    it('should reject metadata without workflowName', () => {
      const metadata = { type: 'workflow', workflowId: 'wf', status: 'running' };
      expect(isWorkflowSessionMetadata(metadata)).toBe(false);
    });
    
    it('should reject metadata without status', () => {
      const metadata = { type: 'workflow', workflowId: 'wf', workflowName: 'Wf' };
      expect(isWorkflowSessionMetadata(metadata)).toBe(false);
    });
    
    it('should reject null', () => {
      expect(isWorkflowSessionMetadata(null)).toBe(false);
    });
  });
  
  describe('getWorkflowSessionStatus', () => {
    it('should return status from metadata', () => {
      const metadata = {
        type: 'workflow' as const,
        workflowId: 'wf',
        workflowName: 'Wf',
        status: 'paused' as const,
      };
      
      expect(getWorkflowSessionStatus(metadata)).toBe('paused');
    });
    
    it('should return running as default when status is missing', () => {
      const metadata = {
        type: 'workflow' as const,
        workflowId: 'wf',
        workflowName: 'Wf',
      } as any;
      
      expect(getWorkflowSessionStatus(metadata)).toBe('running');
    });
  });
});
