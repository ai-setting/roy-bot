/**
 * Service Index - Session-based Workflow Service
 * 
 * After refactoring, RunRepository is removed. Workflow runs are managed via SessionComponent.
 */

export { WorkflowService } from './workflow-service';
export type {
  WorkflowRepository,
  WorkflowEngine,
  CreateOptions,
  ListOptions,
  WorkflowUpdates,
  WorkflowEngineFactory,
  SessionInfo,
  WorkflowSessionMetadata,
  AgentSessionRef,
} from './workflow-service';

export {
  WorkflowServiceRegistry,
  getWorkflowService,
  registerWorkflowService,
} from './registry';

// Re-export WorkflowDefinition from types
export type { WorkflowDefinition } from '../types/workflow';
