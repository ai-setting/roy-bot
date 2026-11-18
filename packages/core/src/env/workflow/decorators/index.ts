/**
 * @fileoverview Workflow Decorators Index
 * 
 * 导出所有装饰器相关的 API
 */

// Decorators
export { Workflow, getWorkflowMetadata } from './workflow';
export { NodeAs, getNodeMetadatas } from './node-as';
export { Edge, WorkflowEdges, getEdgeMetadatas } from './edge';

// Node
export { DecoratorNode } from './decorator-node';
export type { DecoratorNodeConfig } from './decorator-node';

// Converter (需要单独导入，避免循环依赖)
export { WorkflowConverter } from '../extractor/workflow-converter';
export { createWorkflowFromClass } from '../utils/create-workflow';

// Types
export type {
  WorkflowOptions,
  NodeAsOptions,
  EdgeOptions,
  WorkflowMetadata,
  NodeMetadata,
  EdgeMetadata,
  ValidationResult,
  ConvertedWorkflowDefinition,
  ConvertedNodeDefinition,
} from '../types/decorators-types';
