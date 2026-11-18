/**
 * Registry Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowServiceRegistry, registerWorkflowService, getWorkflowService } from './registry';
import { WorkflowService } from './workflow-service';
import { MockWorkflowRepository, MockRunRepository, MockWorkflowEngine } from '../storage/mock-repositories';

describe('WorkflowServiceRegistry', () => {
  let mockEngine: MockWorkflowEngine;
  
  beforeEach(() => {
    // Reset registry before each test
    WorkflowServiceRegistry.getInstance().reset();
    mockEngine = new MockWorkflowEngine();
  });
  
  const createService = () => new WorkflowService(
    new MockWorkflowRepository(),
    new MockRunRepository(),
    (workflow, options) => mockEngine as any
  );
  
  describe('getInstance', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = WorkflowServiceRegistry.getInstance();
      const instance2 = WorkflowServiceRegistry.getInstance();
      
      expect(instance1).toBe(instance2);
    });
  });
  
  describe('register', () => {
    it('should register a service', () => {
      const registry = WorkflowServiceRegistry.getInstance();
      const service = createService();
      
      registry.register(service);
      
      expect(registry.isRegistered()).toBe(true);
    });
  });
  
  describe('get', () => {
    it('should return the registered service', () => {
      const registry = WorkflowServiceRegistry.getInstance();
      const service = createService();
      
      registry.register(service);
      
      expect(registry.get()).toBe(service);
    });
    
    it('should throw error if no service registered', () => {
      const registry = WorkflowServiceRegistry.getInstance();
      
      expect(() => registry.get()).toThrow('WorkflowService is not registered');
    });
  });
  
  describe('isRegistered', () => {
    it('should return false if no service registered', () => {
      const registry = WorkflowServiceRegistry.getInstance();
      
      expect(registry.isRegistered()).toBe(false);
    });
    
    it('should return true after service is registered', () => {
      const registry = WorkflowServiceRegistry.getInstance();
      const service = new WorkflowService(
        new MockWorkflowRepository(),
        new MockRunRepository(),
        mockEngine as any
      );
      
      registry.register(service);
      
      expect(registry.isRegistered()).toBe(true);
    });
  });
  
  describe('reset', () => {
    it('should reset the registry', () => {
      const registry = WorkflowServiceRegistry.getInstance();
      const service = createService();
      
      registry.register(service);
      registry.reset();
      
      expect(registry.isRegistered()).toBe(false);
    });
  });
});

describe('convenience functions', () => {
  let mockEngine: MockWorkflowEngine;
  
  beforeEach(() => {
    WorkflowServiceRegistry.getInstance().reset();
    mockEngine = new MockWorkflowEngine();
  });
  
  const createService = () => new WorkflowService(
    new MockWorkflowRepository(),
    new MockRunRepository(),
    (workflow, options) => mockEngine as any
  );
  
  describe('registerWorkflowService', () => {
    it('should register service via convenience function', () => {
      const service = createService();
      
      registerWorkflowService(service);
      
      expect(WorkflowServiceRegistry.getInstance().isRegistered()).toBe(true);
    });
  });
  
  describe('getWorkflowService', () => {
    it('should get service via convenience function', () => {
      const service = createService();
      
      registerWorkflowService(service);
      
      expect(getWorkflowService()).toBe(service);
    });
    
    it('should throw if service not registered', () => {
      expect(() => getWorkflowService()).toThrow('WorkflowService is not registered');
    });
  });
});
