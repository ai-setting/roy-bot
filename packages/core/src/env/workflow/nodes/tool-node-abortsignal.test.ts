/**
 * @fileoverview ToolNode should propagate context.abortSignal to tool execution (Task #1980+review)
 *
 * Bug hypothesis: ToolNode.execute() ignores context.abortSignal. The
 * executor sets it (Task #1976) so the node can react to cancellation,
 * but ToolNode never threads it into the tool's execute() call OR the
 * inner timeoutPromise. As a result, when the executor's timeout fires:
 *
 *   1. The outer Promise.race resolves with a "timeout" error.
 *   2. The tool's execute() promise is left orphaned — it keeps running.
 *   3. For tool:bash this means a spawned child process may outlive the
 *      node's logical completion.
 *
 * This test demonstrates the gap end-to-end. RED: this test asserts the
 * tool can observe the abort signal via its ToolContext argument.
 *
 * Expected current behavior:
 *   - tool.execute() is called with toolContext that does NOT contain abort.
 *   - the tool cannot observe the executor's abort signal.
 *
 * Expected behavior after fix (GREEN):
 *   - tool.execute() is called with toolContext.abort === context.abortSignal
 *     OR the tool's execute() gets the signal via some other channel.
 */
import { describe, it, expect, beforeEach } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;

import { ToolNode } from "./tool-node";
import type {
  NodeDefinition,
  NodeExecutionContext,
} from "../types";
import type { Tool } from "./tool-node";
import type { EventBus } from "../engine/event-bus";
import type { NodeContext } from "../engine/node-registry";

describe.skipIf(isParallelRun)("ToolNode: abortSignal propagation (Task #1980+review)", () => {
  let nodeDefinition: NodeDefinition;
  let executionContext: NodeExecutionContext;
  let abortController: AbortController;
  let receivedAbortSignal: AbortSignal | undefined;
  let toolInvokedTimes: number;

  const mockEventBus = {
    emit: () => {},
    on: () => {},
    off: () => {},
  } as unknown as EventBus;

  beforeEach(() => {
    abortController = new AbortController();
    receivedAbortSignal = undefined;
    toolInvokedTimes = 0;

    nodeDefinition = {
      id: "abort-test",
      type: "tool",
      name: "Abort Test",
      config: {
        tool: "capture-abort",
        input: { foo: "bar" },
      },
    };

    executionContext = {
      runId: "run-abort-test",
      sessionId: "session-abort-test",
      workflowName: "abort-test-workflow",
      nodeId: "abort-test",
      input: {},
      previousOutputs: new Map(),
      nodeOutputs: new Map(),
      config: nodeDefinition.config,
      debug: false,
      eventBus: mockEventBus,
      askUser: () => {
        throw new Error("askUser not implemented");
      },
      templateResolver: {
        resolveValue: (v: unknown) => v,
      } as any,
      // Task #1976: executor injects abortSignal onto context
      abortSignal: abortController.signal,
    } as unknown as NodeExecutionContext;
  });

  it("T1 (RED for fix): tool receives abortSignal via ToolContext so it can observe cancellation", async () => {
    // Tool that snapshots whatever signal was passed to it via ToolContext
    const captureAbortTool: Tool = {
      name: "capture-abort",
      execute: async (_input: any, ctx?: any) => {
        toolInvokedTimes++;
        receivedAbortSignal = ctx?.abort;
        // Wait for abort to fire
        if (receivedAbortSignal) {
          await new Promise<void>((resolve, reject) => {
            if (receivedAbortSignal!.aborted) {
              reject(new Error("aborted-before-listener"));
              return;
            }
            receivedAbortSignal!.addEventListener("abort", () => {
              reject(new Error("tool-observed-abort"));
            });
            // Failsafe: resolve after 5s if no abort fires
            setTimeout(resolve, 5000);
          });
        }
        return { output: "ok" };
      },
    };
    const toolRegistry = {
      getTool: () => captureAbortTool,
      hasTool: () => true,
    };

    const toolNode = new ToolNode(nodeDefinition, toolRegistry as any);

    // Fire the abort signal shortly after tool starts
    setTimeout(() => abortController.abort(new Error("test-cancel")), 50);

    const result = await toolNode.execute(executionContext);

    // Assert: tool was invoked AND observed the abort
    expect(toolInvokedTimes).toBeGreaterThan(0);
    // ★ RED: today this is `undefined` because tool-node never threads
    // context.abortSignal into ToolContext.abort.
    expect(receivedAbortSignal).toBeDefined();
    expect(receivedAbortSignal?.aborted).toBe(true);
    // The tool should have rejected with "tool-observed-abort" (or similar),
    // not resolved with "ok". This proves abort propagation works end-to-end.
    expect(String(result.error?.message ?? "")).toMatch(/abort|cancel/i);
  }, 5000);

  it("T2 (control): when no abortSignal is on context, tool's ToolContext.abort is undefined (backward compat)", async () => {
    // Remove the abortSignal from context (legacy path)
    delete (executionContext as any).abortSignal;

    let observedAbort: AbortSignal | undefined;
    const captureAbortTool: Tool = {
      name: "capture-abort",
      execute: async (_input: any, ctx?: any) => {
        observedAbort = ctx?.abort;
        return { output: "ok" };
      },
    };
    const toolRegistry = {
      getTool: () => captureAbortTool,
      hasTool: () => true,
    };

    const toolNode = new ToolNode(nodeDefinition, toolRegistry as any);

    const result = await toolNode.execute(executionContext);

    // No signal on context → tool sees no signal. This is the expected
    // backward-compat behavior — tool-node should not invent one.
    expect(observedAbort).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ output: "ok" });
  }, 3000);
});