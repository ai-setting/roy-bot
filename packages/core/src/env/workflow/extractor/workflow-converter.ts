/**
 * WorkflowConverter - 将装饰器类转换为 WorkflowDefinition
 */

import 'reflect-metadata';
import { getWorkflowMetadata } from '../decorators/workflow';
import { getNodeMetadatas } from '../decorators/node-as';
import { getEdgeMetadatas } from '../decorators/edge';
import type {
  WorkflowMetadata,
  NodeMetadata,
  EdgeMetadata,
  ValidationResult,
  ConvertedWorkflowDefinition,
  ConvertedNodeDefinition,
} from '../types/decorators-types';

// Note: createWorkflowFromClass is exported from ./utils/create-workflow
// and re-exported from workflow-component.ts to avoid circular dependencies

/**
 * Workflow 转换器
 * 
 * 负责将使用装饰器定义的类转换为标准的 WorkflowDefinition
 */
export class WorkflowConverter {

  /**
   * 从装饰器类提取 Workflow 元数据
   */
  static extractWorkflowMetadata(targetClass: Function): WorkflowMetadata | undefined {
    return getWorkflowMetadata(targetClass);
  }

  /**
   * 从装饰器类提取所有 Node 元数据
   */
  static extractNodeMetadatas(targetClass: Function): NodeMetadata[] {
    // 获取原型上的元数据（方法装饰器存储在原型上）
    return getNodeMetadatas(targetClass.prototype);
  }

  /**
   * 从装饰器类提取所有 Edge 元数据
   */
  static extractEdgeMetadatas(targetClass: Function): EdgeMetadata[] {
    return getEdgeMetadatas(targetClass);
  }

  /**
   * 将装饰器类转换为 WorkflowDefinition
   */
  static fromClass(
    targetClass: new (...args: any[]) => any,
    instance: any
  ): ConvertedWorkflowDefinition {
    // 1. 获取 Workflow 元数据
    const workflowMeta = this.extractWorkflowMetadata(targetClass);
    if (!workflowMeta) {
      throw new Error('Class must be decorated with @Workflow');
    }

    // 2. 获取所有 Node 元数据
    const nodeMetadatas = this.extractNodeMetadatas(targetClass);
    if (nodeMetadatas.length === 0) {
      throw new Error('At least one method must be decorated with @NodeAs');
    }

    // 3. 获取所有 Edge 元数据
    const edgeMetadatas = this.extractEdgeMetadatas(targetClass);

    // 4. 合并 Edge 到 Node 的 dependsOn，并构建 edges 数组
    const nodeMap = this.buildNodeMap(nodeMetadatas, edgeMetadatas);

    // 5. 转换为 NodeDefinition[]
    const nodes: ConvertedNodeDefinition[] = Array.from(nodeMap.values()).map(meta => ({
      id: meta.nodeId,
      type: meta.nodeType,
      name: meta.name,
      config: {
        ...meta.config,
        _methodName: meta.methodName, // 存储方法名用于执行
        _instance: instance,          // 存储实例引用用于执行
      },
      depends_on: meta.dependsOn,
      condition: meta.condition,
      retry: meta.retry,
      timeout: meta.timeout,
    }));

    // 6. 装饰器边 → 标准 edges.when
    const edges = edgeMetadatas.map(edge => ({
      from: edge.from,
      to: edge.to,
      when: edge.condition,
    }));

    // 7. 确定入口节点
    const entry = workflowMeta.entry || nodeMetadatas[0]?.nodeId || 'unknown';

    // 8. 构建 WorkflowDefinition
    return {
      name: workflowMeta.name,
      version: workflowMeta.version || '1.0',
      description: workflowMeta.description,
      config: workflowMeta.config || {},
      nodes,
      edges,
      entry,
      outputs: [],
      metadata: {
        tags: workflowMeta.tags || [],
        author: workflowMeta.author,
      },
    };
  }

  /**
   * 构建节点映射，并合并边依赖
   */
  private static buildNodeMap(
    nodeMetadatas: NodeMetadata[],
    edgeMetadatas: EdgeMetadata[]
  ): Map<string, NodeMetadata> {
    const nodeMap = new Map<string, NodeMetadata>();

    // 初始化节点映射
    for (const nodeMeta of nodeMetadatas) {
      nodeMap.set(nodeMeta.nodeId, { ...nodeMeta });
    }

    // 从 Edge 元数据添加依赖（条件写入 edges.when，不再合并到节点 inline condition）
    for (const edge of edgeMetadatas) {
      const targetNode = nodeMap.get(edge.to);
      if (targetNode) {
        if (!targetNode.dependsOn.includes(edge.from)) {
          targetNode.dependsOn = [...targetNode.dependsOn, edge.from];
        }
      }
    }

    return nodeMap;
  }

  /**
   * 验证装饰器类的有效性
   */
  static validateWorkflowClass(targetClass: Function): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 检查 @Workflow 装饰器
    const workflowMeta = this.extractWorkflowMetadata(targetClass);
    if (!workflowMeta) {
      errors.push('Class must be decorated with @Workflow');
      return { valid: false, errors, warnings };
    }

    // 2. 检查至少有一个 @NodeAs 节点
    const nodeMetadatas = this.extractNodeMetadatas(targetClass);
    if (nodeMetadatas.length === 0) {
      errors.push('At least one method must be decorated with @NodeAs');
      return { valid: false, errors, warnings };
    }

    // 3. 检查入口节点存在
    const entry = workflowMeta.entry;
    if (entry) {
      const entries = Array.isArray(entry) ? entry : [entry];
      for (const e of entries) {
        if (!nodeMetadatas.find(n => n.nodeId === e)) {
          errors.push(`Entry node '${e}' not found`);
        }
      }
    }

    // 4. 检查依赖节点存在
    for (const node of nodeMetadatas) {
      for (const dep of node.dependsOn) {
        if (!nodeMetadatas.find(n => n.nodeId === dep)) {
          errors.push(`Node '${node.nodeId}' depends on non-existent node '${dep}'`);
        }
      }
    }

    // 5. 检查循环依赖
    if (this.hasCycle(nodeMetadatas)) {
      errors.push('Workflow contains a cycle');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 检测是否存在循环依赖
   * 
   * dependsOn 语义：A 依赖 B 表示 A.dependsOn = [B]
   * 这意味着 B 执行完成后才能执行 A，所以边是 B → A
   * 
   * 检测方法：构建反向邻接表（谁依赖我），然后 DFS 检测环
   */
  private static hasCycle(nodeMetadatas: NodeMetadata[]): boolean {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    // 构建反向邻接表：nodeId -> 依赖此 node 的节点列表
    // 即：谁在我之后执行
    const adjList = new Map<string, string[]>();
    for (const node of nodeMetadatas) {
      adjList.set(node.nodeId, []);
    }
    for (const node of nodeMetadatas) {
      for (const dep of node.dependsOn) {
        const deps = adjList.get(dep);
        if (deps) {
          deps.push(node.nodeId);
        }
      }
    }

    // DFS 检测环：从任意节点出发，如果能回到已在递归栈中的节点，则存在环
    const dfs = (nodeId: string): boolean => {
      visited.add(nodeId);
      recStack.add(nodeId);

      const neighbors = adjList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) {
            return true;
          }
        } else if (recStack.has(neighbor)) {
          // 发现环：neighbor 已在递归栈中
          return true;
        }
      }

      recStack.delete(nodeId);
      return false;
    };

    // 检查所有节点
    for (const node of nodeMetadatas) {
      if (!visited.has(node.nodeId)) {
        if (dfs(node.nodeId)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 执行装饰器方法（用于 WorkflowEngine 调用）
   */
  static async executeNode(
    nodeDef: ConvertedNodeDefinition,
    context: {
      input: any;
      previousOutputs: Map<string, any>;
    }
  ): Promise<{ output: any; error?: Error }> {
    const instance = nodeDef.config._instance;
    const methodName = nodeDef.config._methodName;

    if (!instance || !methodName) {
      return { output: undefined, error: new Error('Missing method information') };
    }

    const method = (instance as any)[methodName as string];
    if (typeof method !== 'function') {
      return { output: undefined, error: new Error(`Method ${methodName} is not a function`) };
    }

    // 准备输入参数
    const deps = nodeDef.depends_on || [];
    let input = context.input;

    if (deps.length > 0) {
      // 从依赖节点输出构建输入
      input = {};
      for (const depId of deps) {
        input[depId] = context.previousOutputs.get(depId);
      }
    }

    try {
      const result = await method.call(instance, input);
      return { output: result };
    } catch (error) {
      return {
        output: undefined,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }
}
