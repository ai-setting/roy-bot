/**
 * DecoratorNode - 执行装饰器类方法的节点
 * 
 * 实现 Node 接口，用于执行使用 @Workflow/@NodeAs 装饰的类方法
 */

import type { Node, NodeDefinition, NodeExecutionContext, NodeExecutionResult } from '../types';

/**
 * DecoratorNode 节点配置
 */
export interface DecoratorNodeConfig extends NodeDefinition {
  config: {
    /** 方法名称 */
    _methodName: string;
    /** 类实例 */
    _instance: any;
    /** 用户自定义配置 */
    [key: string]: unknown;
  };
}

/**
 * DecoratorNode - 执行装饰器类方法的节点
 * 
 * 用于执行使用 @Workflow/@NodeAs 装饰器定义的类方法
 * 
 * @example
 * ```typescript
 * const definition: DecoratorNodeConfig = {
 *   id: 'myNode',
 *   type: 'decorator',
 *   config: {
 *     _methodName: 'myMethod',
 *     _instance: myWorkflowInstance,
 *   }
 * };
 * 
 * const node = new DecoratorNode(definition);
 * const result = await node.execute(context);
 * ```
 */
export class DecoratorNode implements Node {
  readonly type = 'decorator';
  readonly id: string;

  private readonly methodName: string;
  private readonly instance: any;
  private readonly dependsOn: string[];
  private readonly timeout?: number;
  private readonly retryConfig?: {
    max_attempts?: number;
    backoff?: 'fixed' | 'exponential';
    initial_delay?: number;
  };

  constructor(definition: NodeDefinition) {
    const config = definition.config as DecoratorNodeConfig['config'];
    
    this.id = definition.id;
    this.methodName = config._methodName;
    this.instance = config._instance;
    this.dependsOn = definition.depends_on || [];
    this.timeout = definition.timeout;
    this.retryConfig = definition.retry;
  }

  /**
   * 执行装饰器方法
   */
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const startTime = Date.now();

    // 获取方法
    const method = this.instance[this.methodName];
    if (typeof method !== 'function') {
      return {
        success: false,
        error: `Method '${this.methodName}' is not a function`,
        duration: Date.now() - startTime,
      };
    }

    // 准备输入参数
    const input = this.prepareInput(context);

    // 执行（带重试和超时）
    const result = await this.executeWithRetry(input, (context as any).abort);

    return {
      success: !result.error,
      output: result.output,
      error: result.error,
      duration: Date.now() - startTime,
      metadata: {
        methodName: this.methodName,
      },
    };
  }

  /**
   * 准备输入参数
   * 
   * 根据依赖的节点 ID，从 nodeOutputs 中提取对应的输出
   * 返回格式: { [depNodeId]: depOutput }
   */
  private prepareInput(context: NodeExecutionContext): any {
    // nodeOutputs 可以是 Map 或普通对象
    const nodeOutputs = context.nodeOutputs;
    
    // 如果没有依赖节点，直接使用全局 input
    if (this.dependsOn.length === 0) {
      return context.input || {};
    }

    // 根据依赖节点 ID 提取输出，构建输入对象
    const input: Record<string, unknown> = {};
    for (const depId of this.dependsOn) {
      // 支持 Map 和普通对象
      const depOutput = nodeOutputs instanceof Map 
        ? nodeOutputs.get(depId) 
        : nodeOutputs?.[depId];
        
      if (depOutput && typeof depOutput === 'object') {
        // 如果是完整的 NodeExecutionResult，提取 output 字段
        if ('output' in depOutput) {
          input[depId] = (depOutput as any).output;
        } else {
          // 已经是裸对象
          input[depId] = depOutput;
        }
      }
    }

    return input;
  }

  /**
   * 带重试的执行
   */
  private async executeWithRetry(
    input: any,
    abort?: AbortSignal
  ): Promise<{ output?: unknown; error?: string }> {
    const maxAttempts = this.retryConfig?.max_attempts ?? 1;
    const backoff = this.retryConfig?.backoff ?? 'exponential';
    const initialDelay = this.retryConfig?.initial_delay ?? 1000;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 检查中断信号
      if (abort?.aborted) {
        return { error: 'Execution aborted' };
      }

      try {
        // 执行方法
        const output = await this.executeWithTimeout(input, abort);
        return { output };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxAttempts) {
          const delay = this.calculateBackoff(backoff, initialDelay, attempt - 1);
          await this.sleep(delay, abort);
        }
      }
    }

    return { error: lastError?.message || 'Unknown error' };
  }

  /**
   * 带超时的执行
   */
  private async executeWithTimeout(
    input: any,
    abort?: AbortSignal
  ): Promise<unknown> {
    if (!this.timeout) {
      // 无超时限制
      return this.instance[this.methodName](input);
    }

    // 创建超时 Promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Execution timeout after ${this.timeout}ms`));
      }, this.timeout);
    });

    // 竞速执行
    return Promise.race([
      this.instance[this.methodName](input),
      timeoutPromise,
    ]);
  }

  /**
   * 计算退避延迟
   */
  private calculateBackoff(
    backoff: 'fixed' | 'exponential',
    initialDelay: number,
    attempt: number
  ): number {
    if (backoff === 'exponential') {
      return initialDelay * Math.pow(2, attempt);
    }
    return initialDelay;
  }

  /**
   * 睡眠
   */
  private sleep(ms: number, abort?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      
      // 如果被中断，清除定时器
      abort?.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
