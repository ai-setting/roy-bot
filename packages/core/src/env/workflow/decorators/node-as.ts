/**
 * @NodeAs 装饰器
 * 
 * 用于将类方法声明为 Workflow 的 Node
 */

import 'reflect-metadata';
import { NODE_METADATA_KEY } from '../metadata/keys';
import type { NodeAsOptions, NodeMetadata } from '../types/decorators-types';

/**
 * 将方法声明为 Workflow 的 Node
 * 
 * @param options - Node 配置选项
 * 
 * @example
 * ```typescript
 * @Workflow({ name: 'my-workflow', entry: 'fetch' })
 * class MyWorkflow {
 *   @NodeAs({
 *     nodeId: 'fetch',
 *     nodeType: 'tool',
 *     config: { tool: 'web_search' }
 *   })
 *   async fetch(input: { query: string }) {
 *     return { data: [] };
 *   }
 * 
 *   @NodeAs({
 *     nodeId: 'process',
 *     dependsOn: 'fetch'
 *   })
 *   async process(input: { data: any }) {
 *     return { result: {} };
 *   }
 * }
 * ```
 */
export function NodeAs(options: NodeAsOptions = {}): MethodDecorator {
  return function (
    target: Object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const methodName = String(propertyKey);

    // 构建节点元数据
    const nodeMetadata: NodeMetadata = {
      nodeId: options.nodeId || methodName, // 默认使用方法名作为 nodeId
      nodeType: options.nodeType || 'tool', // 默认类型为 tool
      name: options.name,
      // 标准化 dependsOn 为数组
      dependsOn: normalizeDependsOn(options.dependsOn),
      condition: options.condition,
      retry: options.retry,
      timeout: options.timeout,
      config: options.config || {},
      methodName,
      method: descriptor.value, // 存储方法引用
    };

    // 获取已存在的节点元数据列表
    const existingNodes: NodeMetadata[] = Reflect.getMetadata(NODE_METADATA_KEY, target) || [];
    
    // 检查是否已存在同名节点（同一方法不能被多次装饰）
    const existingIndex = existingNodes.findIndex(n => n.methodName === methodName);
    
    if (existingIndex >= 0) {
      // 更新已存在的节点元数据
      existingNodes[existingIndex] = nodeMetadata;
    } else {
      // 添加新节点元数据
      existingNodes.push(nodeMetadata);
    }

    // 存储元数据
    Reflect.defineMetadata(NODE_METADATA_KEY, existingNodes, target);

    return descriptor;
  };
}

/**
 * 标准化 dependsOn 为数组
 */
function normalizeDependsOn(dependsOn?: string | string[] | undefined): string[] {
  if (!dependsOn) {
    return [];
  }
  return Array.isArray(dependsOn) ? dependsOn : [dependsOn];
}

/**
 * 获取类上所有方法的 Node 元数据
 */
export function getNodeMetadatas(target: Object): NodeMetadata[] {
  return Reflect.getMetadata(NODE_METADATA_KEY, target) || [];
}
