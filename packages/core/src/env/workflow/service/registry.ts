/**
 * Registry - Singleton registry for accessing WorkflowService
 */

import { WorkflowService } from './workflow-service';

/**
 * Singleton registry for WorkflowService
 * Provides centralized access to the workflow service instance
 */
export class WorkflowServiceRegistry {
  private static instance: WorkflowServiceRegistry;
  private service: WorkflowService | null = null;
  
  private constructor() {}
  
  /**
   * Get the singleton registry instance
   */
  static getInstance(): WorkflowServiceRegistry {
    if (!WorkflowServiceRegistry.instance) {
      WorkflowServiceRegistry.instance = new WorkflowServiceRegistry();
    }
    return WorkflowServiceRegistry.instance;
  }
  
  /**
   * Register a WorkflowService instance
   */
  register(service: WorkflowService): void {
    this.service = service;
  }
  
  /**
   * Get the registered WorkflowService instance
   * @throws Error if no service is registered
   */
  get(): WorkflowService {
    if (!this.service) {
      throw new Error('WorkflowService is not registered. Call register() first.');
    }
    return this.service;
  }
  
  /**
   * Check if a service is registered
   */
  isRegistered(): boolean {
    return this.service !== null;
  }
  
  /**
   * Reset the registry (primarily for testing)
   */
  reset(): void {
    this.service = null;
  }
}

// Convenience function to get the service
export function getWorkflowService(): WorkflowService {
  return WorkflowServiceRegistry.getInstance().get();
}

// Convenience function to register the service
export function registerWorkflowService(service: WorkflowService): void {
  WorkflowServiceRegistry.getInstance().register(service);
}

// Type for the registry
export type { WorkflowService };
