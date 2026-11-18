/**
 * 元数据存储的 Symbol 键
 */

// Workflow 元数据键
export const WORKFLOW_METADATA_KEY = Symbol('workflow:metadata');

// Node 元数据键 (用于存储方法上的 @NodeAs 元数据)
export const NODE_METADATA_KEY = Symbol('workflow:node');

// Edge 元数据键 (用于存储类上的 @WorkflowEdges 元数据)
export const EDGE_METADATA_KEY = Symbol('workflow:edges');
