/**
 * @Workflow 装饰器
 * 
 * 用于声明一个类为 Workflow 类
 */

import 'reflect-metadata';
import { WORKFLOW_METADATA_KEY } from '../metadata/keys';
import type { WorkflowOptions, WorkflowMetadata } from '../types/decorators-types';

/**
 * 声明一个类为 Workflow 类
 * 
 * @param options - Workflow 配置选项
 * 
 * @example
 * ```typescript
 * @Workflow({
 *   name: 'my-workflow',
 *   version: '1.0',
 *   entry: 'start'
 * })
 * class MyWorkflow {
 *   @NodeAs({ nodeId: 'start' })
 *   async start() { }
 * }
 * ```
 */
export function Workflow(options: WorkflowOptions): ClassDecorator {
  return function <T extends Function>(target: T): T {
    // 构建元数据对象
    const metadata: WorkflowMetadata = {
      name: options.name,
      version: options.version || '1.0',
      description: options.description,
      entry: options.entry,
      config: options.config,
      tags: options.tags || [],
      author: options.author,
    };

    // 使用 Reflect.metadata 存储元数据
    Reflect.defineMetadata(WORKFLOW_METADATA_KEY, metadata, target);

    return target;
  };
}

/**
 * 获取类上的 Workflow 元数据
 */
export function getWorkflowMetadata(target: Function): WorkflowMetadata | undefined {
  return Reflect.getMetadata(WORKFLOW_METADATA_KEY, target);
}
