/**
 * @fileoverview Workflow types compatibility layer
 * Re-exports all types from types/index.ts for backward compatibility
 */

// Re-export from types/index.ts
export type {
  // Workflow types
  Workflow,
  WorkflowDefinition,
  WorkflowDefinitionExtended,
  WorkflowConfig,
  WorkflowMetadata,
  RetryConfig,
  Node,
  NodeDefinition,
  NodeDefinitionSchema,
  DependsOn,
  DependsOnSchema,
  OutputDefinition,
  TemplateResolver,
  ParsedWorkflow,
} from './types';

export { 
  WorkflowDefinitionSchema, 
  RetryConfigSchema,
  WorkflowConfigSchema,
  WorkflowMetadataSchema,
  parseWorkflowFile,
  parseWorkflowFileSync,
} from './types/workflow';

export { OutputDefinitionSchema } from './types/workflow';

// Run types
export type {
  RunStatus,
  RunOptions,
  RunResult,
  WorkflowRun,
  NodeRun,
  NodeStatus,
  NodeExecutionContext,
  NodeExecutionResult,
} from './types';

export { createNodeExecutionContext } from './types';

// Other types
export type { AgentSessionInfo } from './types';
