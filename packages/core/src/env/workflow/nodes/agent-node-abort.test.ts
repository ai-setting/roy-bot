/**
 * @fileoverview AgentRunner.run() accepts signal, agentNode passes through (Task #1976 — Step 2c)
 *
 * Verifies:
 *  1. AgentRunner interface declares `signal?: AbortSignal` as the 3rd param of run()
 *  2. agentNode.execute() reads context.abortSignal and passes it to runner.run()
 *  3. When the executor's signal fires (timeout), the runner's signal listener is invoked
 *  4. Backward compat: runners without the signal param still work
 */

import { describe, it, expect } from "bun:test";
import { AgentNode, type AgentRunner, type AgentConfig } from "./agent-node";
import type { NodeDefinition, NodeExecutionContext, NodeExecutionResult } from "../types";

function makeContext(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    runId: "r",
    sessionId: "s",
    workflowName: "w",
    nodeId: "n1",
    input: {},
    previousOutputs: new Map(),
    nodeOutputs: new Map(),
    config: {},
    debug: false,
    eventBus: undefined as any,
    askUser: ((_q: string) => {
      throw new Error("not implemented");
    }) as any,
    ...overrides,
  };
}

describe("AgentRunner signal passthrough (Task #1976 step 2c)", () => {
  it("A1 (RED): AgentRunner.run must accept 3rd arg signal?: AbortSignal", async () => {
    const definition: NodeDefinition = {
      id: "agent-1",
      type: "agent",
      name: "Agent",
      config: { agent_type: "general", prompt: "hi" },
    };

    let receivedSignal: AbortSignal | undefined;
    let receivedConfig: AgentConfig | undefined;
    let receivedResume: any;

    const runner: AgentRunner = {
      run: async (config: AgentConfig, resume, signal?: AbortSignal) => {
        receivedSignal = signal;
        receivedConfig = config;
        receivedResume = resume;
        return { output: "ok" };
      },
    };

    const node = new AgentNode(definition, runner);
    const ctx = makeContext();
    const result = await node.execute(ctx);

    // The runner should have received the abort signal (or undefined if not provided)
    expect(receivedConfig).toBeDefined();
    expect(receivedConfig!.type).toBe("general");
    expect(receivedResume).toBeDefined();

    // If context.abortSignal was undefined, receivedSignal should be undefined.
    // After Step 2c impl, agentNode MUST forward context.abortSignal.
    expect(receivedSignal).toBeUndefined(); // backward compat: no signal in context
    expect(result.error).toBeUndefined();
    expect(result.output).toBeDefined();
  });

  it("A2 (RED→GREEN): agentNode forwards context.abortSignal to runner.run()", async () => {
    const definition: NodeDefinition = {
      id: "agent-2",
      type: "agent",
      name: "Agent2",
      config: { agent_type: "general", prompt: "hi" },
    };

    const ac = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const runner: AgentRunner = {
      run: async (_config, _resume, signal) => {
        receivedSignal = signal;
        return { output: "ok" };
      },
    };

    const node = new AgentNode(definition, runner);
    const ctx = makeContext({ abortSignal: ac.signal });
    await node.execute(ctx);

    // The runner MUST receive the same signal as context.abortSignal
    expect(receivedSignal).toBe(ac.signal);
    expect(receivedSignal?.aborted).toBe(false);

    // Trigger abort — the runner should observe it
    ac.abort();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("A3 (RED→GREEN): runner can observe external abort via context.abortSignal", async () => {
    const definition: NodeDefinition = {
      id: "agent-3",
      type: "agent",
      name: "Agent3",
      config: { agent_type: "general", prompt: "hi" },
    };

    const ac = new AbortController();
    let abortedAt: number | null = null;

    const runner: AgentRunner = {
      run: async (_config, _resume, signal) => {
        if (!signal) return { output: "no-signal" };
        return new Promise((resolve) => {
          const start = Date.now();
          if (signal.aborted) {
            abortedAt = Date.now() - start;
            resolve({ output: "aborted-immediately" });
            return;
          }
          signal.addEventListener("abort", () => {
            abortedAt = Date.now() - start;
            resolve({ output: "aborted" });
          }, { once: true });
          // Safety
          setTimeout(() => resolve({ output: "never-aborted" }), 5000);
        });
      },
    };

    const node = new AgentNode(definition, runner);
    const ctx = makeContext({ abortSignal: ac.signal });

    // Kick off run, abort after 100ms
    const runPromise = node.execute(ctx);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();

    const result = await runPromise;
    expect(result.output).toBeDefined();
    // Output should indicate abort
    const output = JSON.stringify(result.output);
    expect(output).toContain("abort");
    expect(abortedAt).not.toBeNull();
    if (abortedAt !== null) {
      expect(abortedAt).toBeGreaterThanOrEqual(80); // aborted at ~100ms
      expect(abortedAt).toBeLessThan(2000);
    }
  });

  it("A4 (backward compat): runners without signal param still work", async () => {
    const definition: NodeDefinition = {
      id: "agent-4",
      type: "agent",
      name: "Agent4",
      config: { agent_type: "general", prompt: "hi" },
    };

    let ranWithoutSignal = false;
    const runner: AgentRunner = {
      // Run signature WITHOUT signal param (legacy runner)
      run: async (_config: AgentConfig, _resume) => {
        ranWithoutSignal = true;
        return { output: "legacy" };
      },
    };

    const node = new AgentNode(definition, runner);
    const ctx = makeContext({ abortSignal: new AbortController().signal });
    const result = await node.execute(ctx);

    expect(ranWithoutSignal).toBe(true);
    expect(result.error).toBeUndefined();
  });
});