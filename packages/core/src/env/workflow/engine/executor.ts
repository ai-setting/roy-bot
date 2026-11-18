/**
 * @fileoverview Executor - Executes nodes in a workflow
 * 
 * The Executor is responsible for:
 * - Executing individual nodes
 * - Handling retries
 * - Managing timeouts
 * - Tracking execution state
 */

import type { 
  NodeDefinition, 
  RetryConfig,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../types/index';
import { createWorkflowEvent } from '../types/event';
import { EventBus } from './event-bus';
import { NodeRegistry, NodeContext } from './node-registry';
import type { SessionComponent } from '../../session/session-component';
import { 
  AskUserError,
  createNodeInterruptEvent,
  type WorkflowNodeStartPart,
  type WorkflowNodeInterruptPart,
  type WorkflowNodeEndPart,
  type WorkflowNodeResumePart,
} from '../types/index';
import { TracedAs } from '../../log-trace/decorator';
import {
  buildWorkflowNodeMetadata,
  getWorkflowNodeIdFromMetadata,
  patchAgentSessionIdOnMessage,
} from '../utils/workflow-message-metadata';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Executor Options
 */
export interface ExecutorOptions {
  /** Global timeout for node execution (ms). null = no timeout */
  globalTimeout: number | null;
  /** Global retry configuration */
  globalRetry: RetryConfig | null;
  /** Debug mode */
  debug: boolean;
}

// ============================================================================
// Executor Class
// ============================================================================

/**
 * Executor
 * 
 * Executes nodes in a workflow with support for:
 * - Timeout handling
 * - Retry with configurable backoff
 * - Error propagation
 * - Session message writing
 * - AskUserError handling
 * 
 * @example
 * ```typescript
 * const executor = new Executor(nodeRegistry, eventBus, {
 *   globalTimeout: 60000,
 *   globalRetry: { max_attempts: 3, backoff: 'exponential', initial_delay: 1000 },
 *   debug: false
 * });
 * 
 * const result = await executor.executeNode(nodeDefinition, context);
 * ```
 */
export class Executor {
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(
    private nodeRegistry: NodeRegistry,
    private eventBus: EventBus,
    private options: ExecutorOptions,
    private sessionComponent?: SessionComponent
  ) {}

  /**
   * Execute a node with timeout and retry handling
   */
  // result.output 是节点完整输出（任意大）→ 不入库（executeWithTimeout/Retry 同理）
  @TracedAs("workflow.executor.executeNode", { recordParams: true, recordResult: false })
  async executeNode(
    definition: NodeDefinition,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    const nodeId = definition.id;
    const nodeType = definition.type;

    // Get agent session ID if this is an agent node
    const agentSessionId = (context as any).agentSessionId;

    // Publish node started event
    await this.eventBus.publish(
      createWorkflowEvent('node.started', context.runId, {
        node_id: nodeId,
        input: context.input,
      })
    );

    // Write workflow.node.start message with agent session ID
    await this.writeNodeStart(
      context.sessionId,
      nodeId,
      nodeType,
      context.input,
      agentSessionId
    );

    // Create abort controller for this execution
    const abortController = new AbortController();
    this.abortControllers.set(nodeId, abortController);

    // Task #2275: Compose the session-level cancellation scope's signal
    // (already pre-populated by `buildNodeContext`) with this per-node
    // controller's signal so that BOTH can abort the node:
    //   - engine.stop() → scope.cancel() → scope.signal aborts
    //   - per-node timeout → abortController.abort() (executor cancels)
    //   - retry inner-attempt timeout → combinedController aborts
    // The node receives ONE composed AbortSignal that fires on any source.
    const incomingSignal = context.abortSignal;
    const composedSignal: AbortSignal = incomingSignal
      ? AbortSignal.any([incomingSignal, abortController.signal])
      : abortController.signal;
    // Mutate the context so downstream consumers see the composed signal.
    (context as { abortSignal?: AbortSignal }).abortSignal = composedSignal;

    // Determine timeout precedence (Task #1974 + Task #1980):
    //   1. `definition.timeout` — top-level static field on the NodeDefinition
    //      (existing behavior — preserved for backward compat).
    //   2. `context.config.timeout` — merged config (nodeDef.config shallow-
    //      merged with `RunOptions.nodeConfig[nodeId]` at buildNodeContext
    //      time). This is the FIX from Task #1980: previously the executor
    //      read `definition.config.timeout` directly, but `buildNodeContext`
    //      writes the merged value to `context.config` and never mutates
    //      `definition`. As a result, --node-config overrides were silently
    //      ignored by the executor even though the merge itself was correct.
    //   3. `this.options.globalTimeout` — engine-wide default.
    // This means nodeConfig["<nodeId>"].timeout (and YAML `config.timeout`)
    // both flow through to the per-node timeout without needing top-level
    // definition edits.
    const ctxCfg = context.config as Record<string, unknown> | undefined;
    const cfgTimeout =
      ctxCfg && typeof ctxCfg.timeout === "number" && ctxCfg.timeout > 0
        ? ctxCfg.timeout
        : undefined;
    const timeout = definition.timeout ?? cfgTimeout ?? this.options.globalTimeout ?? undefined;

    // Determine retry config (node config overrides global)
    const retryConfig = definition.retry ?? this.options.globalRetry;

    try {
      let result: NodeExecutionResult;

      if (retryConfig && retryConfig.max_attempts > 1) {
        // Execute with retry
        result = await this.executeWithRetry(
          definition,
          context,
          abortController,
          timeout
        );
      } else {
        // Execute without retry
        result = await this.executeWithTimeout(
          definition,
          context,
          abortController,
          timeout
        );
      }

      // Handle AskUserError specially
      if (result.error instanceof AskUserError) {
        // Publish node.interrupt event with agentSessionId
        const interruptEvent = createNodeInterruptEvent(
          context.runId,
          nodeId,
          nodeType,
          result.error.query,
          result.error.agentSessionId || agentSessionId
        );
        await this.eventBus.publish(interruptEvent);
        
        // Write workflow.node.interrupt message with agentSessionId
        await this.writeNodeInterrupt(
          context.sessionId,
          nodeId,
          nodeType,
          result.error.query,
          result.error.agentSessionId || agentSessionId
        );
        
        // Re-throw AskUserError
        throw result.error;
      }

      // Publish completion or failure event
      if (result.error) {
        const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
        const errorStack = result.error instanceof Error ? result.error.stack : undefined;
        await this.eventBus.publish(
          createWorkflowEvent('node.failed', context.runId, {
            node_id: nodeId,
            error: {
              message: errorMessage,
              stack: errorStack,
            },
          })
        );
        
        // Write workflow.node.end message (error case)
        await this.writeNodeEnd(
          context.sessionId,
          nodeId,
          nodeType,
          result.output,
          errorMessage,
          result.durationMs ?? 0,
          agentSessionId
        );
      } else {
        await this.eventBus.publish(
          createWorkflowEvent('node.completed', context.runId, {
            node_id: nodeId,
            output: result.output,
            duration_ms: result.durationMs ?? 0,
          })
        );
        
        // Write workflow.node.end message (success case)
        await this.writeNodeEnd(
          context.sessionId,
          nodeId,
          nodeType,
          result.output,
          undefined,
          result.durationMs ?? 0,
          agentSessionId
        );
      }

      return result;
    } finally {
      // Clean up abort controller
      this.abortControllers.delete(nodeId);
    }
  }

  /**
   * Execute node with timeout handling
   *
   * Task #1976: when the timeout fires, also abort the controller so the
   * node has a chance to react via its AbortSignal — instead of being
   * silently orphaned (the bug this method was leaking).
   */
  @TracedAs("workflow.executor.executeWithTimeout", { recordParams: true, recordResult: false })
  private async executeWithTimeout(
    definition: NodeDefinition,
    context: NodeExecutionContext,
    abortController: AbortController,
    timeout: number | undefined
  ): Promise<NodeExecutionResult> {
    const startTime = Date.now();

    // Create the node instance
    const nodeContext: NodeContext = {
      runId: context.runId,
      workflowName: context.workflowName,
      eventBus: this.eventBus,
      debug: context.debug,
    };

    const node = this.nodeRegistry.createNode(definition, nodeContext);
    const signal = abortController.signal;

    if (timeout) {
      // Execute with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        const handle = setTimeout(() => {
          // ★ Task #1976: fire the abort signal so the node can react to
          // cancellation (instead of being orphaned). This is the key
          // piece of the agent-leak fix: timeout → signal aborted →
          // node's AbortSignal listener resolves/rejects promptly.
          if (!abortController.signal.aborted) {
            abortController.abort(new Error(`Node execution timeout: ${timeout}ms`));
          }
          reject(new Error(`Node execution timeout: ${timeout}ms`));
        }, timeout);
        signal.addEventListener('abort', () => clearTimeout(handle));
      });

      try {
        const result = await Promise.race([
          node.execute(context),
          timeoutPromise,
        ]);
        return {
          output: result.output,
          error: result.error ?? undefined,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        // AskUserError 需要特殊处理，向上传播而不是包装为错误
        if (error instanceof AskUserError) {
          throw error;
        }
        return {
          output: undefined,
          error: error instanceof Error ? error : new Error(String(error)),
          durationMs: Date.now() - startTime,
        };
      }
    } else {
      // Execute without timeout
      try {
        const result = await node.execute(context);
        return {
          output: result.output,
          error: result.error,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        // AskUserError 需要特殊处理，向上传播而不是包装为错误
        if (error instanceof AskUserError) {
          throw error;
        }
        return {
          output: undefined,
          error: error instanceof Error ? error : new Error(String(error)),
          durationMs: Date.now() - startTime,
        };
      }
    }
  }

  /**
   * Execute node with retry handling
   */
  @TracedAs("workflow.executor.executeWithRetry", { recordParams: true, recordResult: false })
  private async executeWithRetry(
    definition: NodeDefinition,
    context: NodeExecutionContext,
    abortController: AbortController,
    timeout: number | undefined
  ): Promise<NodeExecutionResult> {
    const retryConfig = definition.retry!;
    let lastError: Error | undefined;
    let delay = retryConfig.initial_delay;
    // Task #2275: prefer the composed signal (session-level scope +
    // per-node controller) over the bare per-node controller's signal
    // so retry backoff honors engine.stop() and the per-node controller
    // both. Fallback to abortController.signal for backward compat when
    // the executor's caller didn't pre-compose the signal.
    const signal = context.abortSignal ?? abortController.signal;

    for (let attempt = 1; attempt <= retryConfig.max_attempts; attempt++) {
      // Check if aborted before attempt
      // Task #2291 P0-1: propagate the original abort reason instead of
      // hardcoding "Execution aborted" so consumers can distinguish
      // engine-stop vs node-timeout vs retry-aborted.
      if (signal.aborted) {
        const reason = (signal as any).reason;
        return {
          output: undefined,
          error: reason instanceof Error
            ? reason
            : new Error(typeof reason === "string" && reason ? reason : "Execution aborted"),
          durationMs: 0,
        };
      }

      // Create new abort controller for this attempt. We need a controller
      // whose `signal` is the combination of the outer signal (Task #1976
      // semantics) and an inner attemptAbort. The inner attemptAbort is
      // what `executeWithTimeout` will call `.abort()` on when its own
      // timeout fires (Task #1976 — abort on timeout).
      //
      // Task #2291 P1-3: drop the dead `combinedController` proxy and the
      // `attemptAbortController` Object-literal cast. The combined signal
      // already aborts when `attemptAbort` aborts (via AbortSignal.any
      // inside `combineAbortSignals`), so wrapping the same signal in a
      // second controller is redundant and the proxy swallowed the abort
      // reason.
      const attemptAbort = new AbortController();
      const combinedSignal = this.combineAbortSignals(signal, attemptAbort.signal);
      // Thin AbortController: signal is the composed signal, .abort()
      // delegates to attemptAbort (the composed signal follows).
      const attemptAbortController: AbortController = {
        get signal() { return combinedSignal; },
        abort: (reason?: any) => {
          if (!attemptAbort.signal.aborted) attemptAbort.abort(reason);
        },
      } as unknown as AbortController;

      try {
        const result = await this.executeWithTimeout(
          definition,
          context,
          attemptAbortController,
          timeout
        );

        if (!result.error) {
          return result;
        }

        // Convert string error to Error instance if needed
        lastError = result.error instanceof Error ? result.error : new Error(String(result.error));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // If not last attempt, wait before retry
      if (attempt < retryConfig.max_attempts) {
        // Task #2275: signal-aware backoff — abort immediately if the
        // session-level cancellation scope fires during retry delay.
        try {
          await this.sleep(delay, signal);
        } catch (e) {
          // Aborted during retry backoff — return abort error, no new attempt.
          return {
            output: undefined,
            error: e instanceof Error ? e : new Error(String(e)),
            durationMs: 0,
          };
        }

        // Increase delay for exponential backoff
        if (retryConfig.backoff === 'exponential') {
          delay *= 2;
        }
      }
    }

    return {
      output: undefined,
      error: lastError ?? new Error('Unknown error after retries'),
      durationMs: 0,
    };
  }

  /**
   * Cancel execution of a specific node
   */
  @TracedAs("workflow.executor.cancelNode", { recordParams: true, recordResult: false })
  cancelNode(nodeId: string): void {
    const controller = this.abortControllers.get(nodeId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(nodeId);
    }
  }

  /**
   * Cancel all running nodes
   */
  @TracedAs("workflow.executor.cancelAll", { recordParams: false, recordResult: false })
  cancelAll(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  /**
   * Combine two abort signals.
   *
   * Task #2291 P0-1 / P1-3:
   *   Replaced the addEventListener-based composition with `AbortSignal.any`
   *   which (a) preserves the abort reason from the firing input and
   *   (b) aborts synchronously when any input is already aborted.
   */
  private combineAbortSignals(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
    return AbortSignal.any([signal1, signal2]);
  }

  /**
   * Sleep for specified milliseconds, with optional signal-aware abort
   * (Task #2275). When `signal` is provided, the returned Promise rejects
   * with `signal.reason` if the signal aborts before the timer fires,
   * and the underlying setTimeout is cleared (no leftover timer).
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const handle = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, ms);
      if (typeof (handle as any).unref === "function") {
        (handle as any).unref();
      }
      const onAbort = () => {
        clearTimeout(handle);
        reject(signal!.reason ?? new Error("aborted"));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Write workflow.node.start message
   * 对应 tool-call，节点开始执行
   */
  @TracedAs("workflow.executor.writeNodeStart", { recordParams: true, recordResult: true })
  async writeNodeStart(
    sessionId: string,
    nodeId: string,
    nodeType: string,
    input: unknown,
    agentSessionId?: string
  ): Promise<void> {
    if (!this.sessionComponent) return;
    
    const startTime = Date.now();
    const part: WorkflowNodeStartPart = {
      type: 'workflow-node-start',
      nodeId,
      nodeType,
      input,
      startTime,
      ...(agentSessionId ? { agentSessionId } : {}),
    };
    
    // Create meaningful content summary for display
    const contentSummary = this.summarizeCall(nodeType, nodeId, input);
    
    await this.sessionComponent.addMessage(sessionId, {
      role: 'workflow.node.start',
      content: contentSummary,
      parts: [part],
      metadata: buildWorkflowNodeMetadata('workflow.node.start', nodeId, nodeType, {
        ...(agentSessionId ? { agentSessionId } : {}),
      }),
    });
  }

  /**
   * Patch agentSessionId onto the latest workflow.node.start for a node (P1).
   */
  @TracedAs('workflow.executor.attachAgentSessionToLastStart', { log: true })
  async attachAgentSessionToLastStart(
    sessionId: string,
    nodeId: string,
    agentSessionId: string
  ): Promise<void> {
    if (!this.sessionComponent?.getMessages || !this.sessionComponent.updateMessage) {
      return;
    }

    const messages = await this.sessionComponent.getMessages(sessionId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const meta = msg.metadata as Record<string, unknown> | undefined;
      if (meta?.type !== 'workflow.node.start') {
        continue;
      }
      if (getWorkflowNodeIdFromMetadata(meta) !== nodeId) {
        continue;
      }
      if (meta.agentSessionId) {
        return;
      }

      const patched = patchAgentSessionIdOnMessage(meta, msg.parts as unknown[] | undefined, agentSessionId);
      await this.sessionComponent.updateMessage(sessionId, msg.id, patched);
      return;
    }
  }
  
  /**
   * Create a meaningful content summary for call message
   */
  private summarizeCall(nodeType: string, nodeId: string, input: unknown): string {
    if (input === undefined || input === null) {
      return `[${nodeType}] ${nodeId} started`;
    }
    
    if (typeof input === 'object') {
      const inputObj = input as Record<string, unknown>;
      const keys = Object.keys(inputObj);
      if (keys.length === 0) {
        return `[${nodeType}] ${nodeId} started`;
      }
      // Show first few keys as summary
      const summary = keys.slice(0, 3).map(k => `${k}: ${JSON.stringify(inputObj[k])}`).join(', ');
      return `[${nodeType}] ${nodeId}: ${summary}`;
    }
    
    return `[${nodeType}] ${nodeId}: ${String(input)}`;
  }

  /**
   * Write workflow.node.interrupt message
   */
  @TracedAs("workflow.executor.writeNodeInterrupt", { recordParams: true, recordResult: true })
  async writeNodeInterrupt(
    sessionId: string,
    nodeId: string,
    nodeType: string,
    query: string,
    agentSessionId?: string
  ): Promise<void> {
    if (!this.sessionComponent) return;
    
    const timestamp = Date.now();
    const part: WorkflowNodeInterruptPart = {
      type: 'workflow-node-interrupt',
      nodeId,
      nodeType,
      query,
      timestamp,
      ...(agentSessionId ? { agentSessionId } : {}),
    };
    
    await this.sessionComponent.addMessage(sessionId, {
      role: 'workflow.node.interrupt' as any,
      content: query,
      parts: [part] as any,
      metadata: buildWorkflowNodeMetadata('workflow.node.interrupt', nodeId, nodeType, {
        query,
        ...(agentSessionId ? { agentSessionId } : {}),
        timestamp,
      }) as any,
    });
  }

  /**
   * Write workflow.node.end message (对应 tool-result)
   */
  @TracedAs("workflow.executor.writeNodeEnd", { recordParams: true, recordResult: true })
  async writeNodeEnd(
    sessionId: string,
    nodeId: string,
    nodeType: string,
    output: unknown,
    error: string | undefined,
    durationMs: number,
    agentSessionId?: string
  ): Promise<void> {
    if (!this.sessionComponent) return;
    
    const part: WorkflowNodeEndPart = {
      type: 'workflow-node-end',
      nodeId,
      nodeType,
      output,
      error,
      durationMs,
      ...(agentSessionId ? { agentSessionId } : {}),
    };
    
    // Create meaningful content summary for display
    const contentSummary = this.summarizeResult(nodeId, output, error, durationMs);
    
    await this.sessionComponent.addMessage(sessionId, {
      role: 'workflow.node.end',
      content: contentSummary,
      parts: [part],
      metadata: buildWorkflowNodeMetadata('workflow.node.end', nodeId, nodeType, {
        success: !error,
        ...(agentSessionId ? { agentSessionId } : {}),
      }),
    });
  }
  
  /**
   * Create a meaningful content summary for result display
   */
  private summarizeResult(
    nodeId: string,
    output: unknown,
    error: string | undefined,
    durationMs: number
  ): string {
    if (error) {
      return `❌ ${nodeId} failed: ${error}`;
    }
    
    if (output === undefined || output === null) {
      return `✅ ${nodeId} completed (${durationMs}ms)`;
    }
    
    if (typeof output === 'object') {
      const keys = Object.keys(output);
      if (keys.length === 0) {
        return `✅ ${nodeId} completed (${durationMs}ms)`;
      }
      // Show first few keys as summary
      const summary = keys.slice(0, 3).join(', ');
      return `✅ ${nodeId}: ${summary} (${durationMs}ms)`;
    }
    
    // Truncate long strings
    const strOutput = String(output);
    const truncated = strOutput.length > 100 ? strOutput.substring(0, 100) + '...' : strOutput;
    return `✅ ${nodeId}: ${truncated} (${durationMs}ms)`;
  }

  /**
   * Write workflow.node.resume message
   */
  @TracedAs("workflow.executor.writeNodeResume", { recordParams: true, recordResult: true })
  async writeNodeResume(
    sessionId: string,
    nodeId: string,
    nodeType: string,
    response: string,
    agentSessionId?: string
  ): Promise<void> {
    if (!this.sessionComponent) return;
    
    const timestamp = Date.now();
    const part: WorkflowNodeResumePart = {
      type: 'workflow-node-resume',
      nodeId,
      response,
      timestamp,
      ...(agentSessionId ? { agentSessionId } : {}),
    };
    
    await this.sessionComponent.addMessage(sessionId, {
      role: 'workflow.node.resume',
      content: response,
      parts: [part],
      metadata: buildWorkflowNodeMetadata('workflow.node.resume', nodeId, nodeType, {
        response,
        ...(agentSessionId ? { agentSessionId } : {}),
        timestamp,
      }),
    });
  }
}
