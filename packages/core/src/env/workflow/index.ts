/**
 * Workflow Module
 * 
 * 提供基于装饰器的 Workflow 定义和执行能力
 * 
 * @example
 * ```typescript
 * import { Workflow, NodeAs, createWorkflowFromClass } from '@ai-setting/roy-bot-core';
 * 
 * @Workflow({ name: 'my-workflow', entry: 'step1' })
 * @WorkflowEdges([{ from: 'step1', to: 'step2' }])
 * class MyWorkflow {
 *   @NodeAs({ nodeId: 'step1', nodeType: 'tool' })
 *   async step1() { return { result: 'done' }; }
 * 
 *   @NodeAs({ nodeId: 'step2', dependsOn: 'step1' })
 *   async step2() { return { result: 'processed' }; }
 * }
 * 
 * const workflow = createWorkflowFromClass(MyWorkflow);
 * ```
 */

// Decorators
export { Workflow } from './decorators/workflow';
export { NodeAs } from './decorators/node-as';
export { Edge, WorkflowEdges } from './decorators/edge';
export { DecoratorNode } from './decorators/decorator-node';

// Converter
export { WorkflowConverter } from './extractor/workflow-converter';
export { createWorkflowFromClass } from './utils/create-workflow';

// Component
export { WorkflowComponent } from './workflow-component';

// Task #2251: workflow-runner failure fallback is prompt-driven; no runtime state machine is exported.

// Types - re-export from types/index
export * from './types/index';
