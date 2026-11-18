/**
 * @Edge 和 @WorkflowEdges 装饰器
 * 
 * 用于显式声明节点之间的边关系
 */

import 'reflect-metadata';
import { EDGE_METADATA_KEY } from '../metadata/keys';
import type { EdgeMetadata, EdgeOptions } from '../types/decorators-types';

/**
 * 声明一条边 (from -> to)
 * 
 * 这是一个方法装饰器，用于在方法上声明边关系
 * 
 * @param from - 起始节点 ID
 * @param to - 目标节点 ID
 * 
 * @example
 * ```typescript
 * @Edge('nodeA', 'nodeB')
 * static __edge_nodeA_to_nodeB__ = null;
 * ```
 */
export function Edge(from: string, to: string): MethodDecorator {
  return function (
    target: Object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const edge: EdgeMetadata = { from, to };

    // 获取已存在的边元数据列表
    const existingEdges: EdgeMetadata[] = Reflect.getMetadata(EDGE_METADATA_KEY, target) || [];

    // 添加新边
    existingEdges.push(edge);

    // 存储元数据
    Reflect.defineMetadata(EDGE_METADATA_KEY, existingEdges, target);

    return descriptor;
  };
}

/**
 * 类级别装饰器，声明多条边
 * 
 * @param edges - 边数组
 * 
 * @example
 * ```typescript
 * @WorkflowEdges([
 *   { from: 'A', to: 'B' },
 *   { from: 'B', to: 'C' }
 * ])
 * @Workflow({ name: 'test' })
 * class TestWorkflow { }
 * ```
 */
export function WorkflowEdges(edges: EdgeOptions[]): ClassDecorator {
  return function <T extends Function>(target: T): T {
    // 将 EdgeOptions[] 转换为 EdgeMetadata[]
    const edgeMetadatas: EdgeMetadata[] = edges.map(edge => ({
      from: edge.from,
      to: edge.to,
      condition: edge.condition,
    }));

    // 存储元数据
    Reflect.defineMetadata(EDGE_METADATA_KEY, edgeMetadatas, target);

    return target;
  };
}

/**
 * 获取类上的所有边元数据
 */
export function getEdgeMetadatas(target: Function): EdgeMetadata[] {
  return Reflect.getMetadata(EDGE_METADATA_KEY, target) || [];
}
