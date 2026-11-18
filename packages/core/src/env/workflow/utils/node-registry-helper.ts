/**
 * NodeRegistry 集成辅助
 * 
 * 提供函数来帮助将 decorator 节点类型注册到 NodeRegistry
 */

import type { NodeRegistry } from '../engine/node-registry';
import { DecoratorNode } from '../decorators/decorator-node';
import { ConditionNode } from '../nodes/condition-node';
import { MergeNode } from '../nodes/merge-node';

/**
 * 将所有内置节点类型注册到 NodeRegistry
 * 
 * @param registry - NodeRegistry 实例
 * 
 * @example
 * ```typescript
 * import { registerDecoratorNodeType } from '@roy-bot/workflow-decorators';
 * 
 * // 在 WorkflowComponent 初始化时调用
 * registerDecoratorNodeType(registry);
 * ```
 */
export function registerDecoratorNodeType(registry: NodeRegistry): void {
  // 注册 decorator 节点类型
  registry.register('decorator', (definition) => {
    return new DecoratorNode(definition);
  });
  
  // 注册 condition 节点类型
  registry.register('condition', (definition) => {
    return new ConditionNode(definition);
  });
  
  // 注册 merge 节点类型
  registry.register('merge', (definition) => {
    return new MergeNode(definition);
  });
}

/**
 * 检查 WorkflowDefinition 是否包含 decorator 类型的节点
 */
export function hasDecoratorNodes(
  nodes: Array<{ type: string }>
): boolean {
  return nodes.some(node => node.type === 'decorator');
}

/**
 * 从 WorkflowDefinition 中提取所有 decorator 类型的节点
 */
export function getDecoratorNodes(
  nodes: Array<{ type: string; id: string }>
): Array<{ type: string; id: string }> {
  return nodes.filter(node => node.type === 'decorator');
}
