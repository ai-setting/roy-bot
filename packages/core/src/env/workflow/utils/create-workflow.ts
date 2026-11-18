/**
 * 便捷函数：createWorkflowFromClass
 */

import { WorkflowConverter } from '../extractor/workflow-converter';
import type { ConvertedWorkflowDefinition } from '../types/decorators-types';

/**
 * 从装饰器类创建 WorkflowDefinition
 * 
 * 这是最常用的便捷函数，自动处理实例创建和转换
 * 
 * @param targetClass - 使用 @Workflow 装饰的类
 * @param options - 可选配置
 * @returns WorkflowDefinition
 * 
 * @example
 * ```typescript
 * @Workflow({ name: 'my-workflow', entry: 'start' })
 * class MyWorkflow {
 *   @NodeAs({ nodeId: 'start' })
 *   async start() { return { done: true }; }
 * }
 * 
 * // 方式一：自动创建实例
 * const workflow = createWorkflowFromClass(MyWorkflow);
 * 
 * // 方式二：传入自定义实例
 * const myInstance = new MyWorkflow(customDep);
 * const workflow = createWorkflowFromClass(MyWorkflow, { instance: myInstance });
 * ```
 */
export function createWorkflowFromClass(
  targetClass: new (...args: any[]) => any,
  options?: {
    /** 自定义实例，不传则自动创建 */
    instance?: any;
    /** 构造函数参数 */
    constructorArgs?: any[];
  }
): ConvertedWorkflowDefinition {
  // 创建或使用提供的实例
  const instance = options?.instance ?? new targetClass(...(options?.constructorArgs ?? []));

  // 转换
  return WorkflowConverter.fromClass(targetClass, instance);
}
