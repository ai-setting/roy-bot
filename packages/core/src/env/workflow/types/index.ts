// Re-export all types
export * from './edge';
export * from './workflow';
export * from './workflow-message';
export * from './workflow-session';
export * from './context';
export * from './workflow-hil';
export * from './event';
export * from './run';

// Export AgentSessionInfo
export type { AgentSessionInfo } from './workflow-message';

// Export AgentSessionRef from workflow-session (avoid duplicate with workflow-message)
export type { AgentSessionRef } from './workflow-session';

// Re-export from run.ts for convenience (includes NodeExecutionContext, NodeExecutionResult)
export type {
  RunStatus,
  NodeStatus,
  WorkflowRun,
  NodeRun,
  RunOptions,
  RunResult,
  NodeExecutionContext,
  NodeExecutionResult,
} from './run';

export { createNodeExecutionContext } from './run';

// Re-export from workflow.ts for convenience (includes Node, RetryConfig, TemplateResolver)
export type {
  WorkflowDefinition,
  WorkflowDefinitionExtended,
  Workflow,
  WorkflowConfig,
  WorkflowMetadata,
  RetryConfig,
  Node,
  NodeDefinition,
  NodeDefinitionSchema,
  DependsOn,
  DependsOnSchema,
  OutputDefinition,
  OutputDefinitionSchema,
  InputParameter,
  WorkflowInputs,
} from './workflow';

// Re-export Node and TemplateResolver from their actual locations
// Note: Node type should be imported from '../nodes' directly
export type { TemplateResolver } from '../utils/template-resolver';

// Export workflow error types
export {
  WorkflowError,
  TemplateUnresolvedError,
  WorkflowValidationError,
  nodeNotFound,
  pathNotFound,
  unresolvedVariable,
} from './workflow-error';
export type { WorkflowErrorContext } from './workflow-error';
