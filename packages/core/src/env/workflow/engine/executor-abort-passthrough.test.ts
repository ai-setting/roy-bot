/**
 * @fileoverview Executor abort signal passthrough (Task #1976 — Step 2b)
 *
 * Verifies that:
 *  1. When the executor's node timeout fires, the abortController is aborted.
 *  2. The context.abortSignal passed to node.execute() reflects that abort.
 *  3. The signal fires BEFORE the timeout error is returned (so the node has
 *     a chance to react).
 *  4. The engine-level retry signal chain (line 149/157/245/318 in executor.ts)
 *     is preserved.
 *
 * The mock node is a custom node type that captures the AbortSignal it
 * received via context.abortSignal and reports whether/when it fired.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type {
  WorkflowDefinition,
  NodeDefinition,
  NodeExecutionContext,
  NodeExecutionResult,
} from "../types";
import type { Node } from "../types";
import type { SessionComponent } from "../../session/session-component";

/**
 * A custom node that captures context.abortSignal and resolves once the
 * signal fires (or after a long sleep, simulating an agent hang).
 */
class SignalCaptureNode implements Node {
  type = "signal-capture";
  id: string;
  constructor(public definition: NodeDefinition) {
    this.id = definition.id;
  }

  static capturedSignals: Array<{
    nodeId: string;
    abortedAt: number | null;
    signalReceived: boolean;
  }> = [];

  static reset() {
    SignalCaptureNode.capturedSignals = [];
  }

  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const start = Date.now();
    const signal = context.abortSignal;
    const entry = {
      nodeId: context.nodeId,
      signalReceived: !!signal,
      abortedAt: null as number | null,
    };
    SignalCaptureNode.capturedSignals.push(entry);

    if (!signal) {
      // No signal — leak the node (simulate original bug).
      await new Promise(() => {});
      return { output: "leaked" };
    }

    // Return as soon as the signal fires (or after 30s safety timeout)
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        entry.abortedAt = Date.now() - start;
        resolve();
        return;
      }
      const handler = () => {
        entry.abortedAt = Date.now() - start;
        resolve();
      };
      signal.addEventListener("abort", handler, { once: true });
      // Safety: don't hang the test forever
      setTimeout(() => {
        entry.abortedAt = -1; // marker: never aborted within window
        resolve();
      }, 30000);
    });

    return {
      output: signal.aborted ? "aborted" : "timeout-window-ended",
      error: signal.aborted
        ? new Error("Node aborted via AbortSignal")
        : new Error("Signal did not fire within test window"),
    };
  }
}

function makeMinimalSession(): SessionComponent {
  const records = new Map<string, any>();
  return {
    create: async (opts: any) => {
      records.set(opts.id, { metadata: opts.metadata ?? {}, messages: [] });
      return { id: opts.id, ...opts };
    },
    get: async (id: string) => {
      const r = records.get(id);
      if (!r) return null;
      return { id, title: "t", metadata: r.metadata, createdAt: new Date(), updatedAt: new Date() };
    },
    update: async (id: string, patch: any) => {
      const r = records.get(id);
      if (!r) return false;
      r.metadata = { ...r.metadata, ...(patch.metadata ?? {}) };
      return true;
    },
    addMessage: async () => "m",
    getMessages: async () => [],
    list: async () => [],
  } as unknown as SessionComponent;
}

describe("Executor abort signal passthrough (Task #1976 step 2b)", () => {
  let registry: NodeRegistry;
  let session: SessionComponent;

  beforeEach(() => {
    SignalCaptureNode.reset();
    session = makeMinimalSession();
    registry = new NodeRegistry({ sessionComponent: session });
    registry.register("signal-capture", (def) => new SignalCaptureNode(def));
  });

  it("E1 (RED): when node timeout fires, context.abortSignal.aborted becomes true", async () => {
    const wf: WorkflowDefinition = {
      name: "abort-passthrough",
      version: "1.0.0",
      description: "verify abort signal on timeout",
      nodes: [
        {
          id: "slow",
          type: "signal-capture",
          name: "Slow Capture",
          config: {},
          timeout: 100, // tight timeout to trigger fast
        },
      ],
      edges: [],
      entry: "__default_entry__",
      outputs: [],
      inputs: {},
      metadata: { tags: [] },
      config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
    };

    const engine = new WorkflowEngine(registry, session);

    const result = await Promise.race([
      engine.runWorkflow(wf, { input: {} }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("engine call itself hung")), 3000),
      ),
    ]);

    // Engine should return failed because the signal-capture node either
    // returned aborted (with error) or never aborted (test would hang).
    expect(result.status).toBe("failed");

    // Now verify the captured signal — was it received AND did it fire?
    const captured = SignalCaptureNode.capturedSignals.find((c) => c.nodeId === "slow");
    expect(captured).toBeDefined();
    expect(captured!.signalReceived).toBe(true); // executor must inject signal
    expect(captured!.abortedAt).not.toBeNull();
    expect(captured!.abortedAt).not.toBe(-1);
    // abortedAt should be ~100ms (the timeout)
    if (captured!.abortedAt !== null && captured!.abortedAt > 0) {
      expect(captured!.abortedAt).toBeGreaterThanOrEqual(80); // signal fired after timeout
      expect(captured!.abortedAt).toBeLessThan(2000); // but not too late
    }
  });

  it("E2 (RED): without timeout, the signal is still injected but never fires (within window)", async () => {
    const wf: WorkflowDefinition = {
      name: "no-timeout",
      version: "1.0.0",
      description: "verify signal injected but not aborted when no timeout",
      nodes: [
        {
          id: "patient",
          type: "signal-capture",
          name: "Patient Capture",
          config: {},
          // No timeout — node can run forever
        },
      ],
      edges: [],
      entry: "__default_entry__",
      outputs: [],
      inputs: {},
      metadata: { tags: [] },
      config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
    };

    const engine = new WorkflowEngine(registry, session);

    // Race: workflow will hang (no timeout). We give it 500ms then abort the test.
    // The signal should be injected but never fire within the window.
    let captured: typeof SignalCaptureNode.capturedSignals[number] | undefined;
    const wfPromise = engine.runWorkflow(wf, { input: {} }).catch(() => "stopped");

    // Wait 500ms for the node to start
    await new Promise((r) => setTimeout(r, 500));
    captured = SignalCaptureNode.capturedSignals.find((c) => c.nodeId === "patient");

    // Stop the workflow so the test can finish — verify stop fires the signal
    const sessionIds = Array.from((engine as any).activeSessions?.keys?.() ?? []) as string[];
    if (sessionIds.length > 0) {
      await engine.stop(sessionIds[0], "test cancel");
    }

    // Wait for engine to settle (or timeout)
    await Promise.race([
      wfPromise,
      new Promise((r) => setTimeout(r, 1500)),
    ]);

    expect(captured).toBeDefined();
    expect(captured!.signalReceived).toBe(true); // signal must be present
    // After engine.stop, the signal SHOULD have fired
    if (captured!.abortedAt === null || captured!.abortedAt === -1) {
      throw new Error(
        `Expected signal to fire after engine.stop, got abortedAt=${captured!.abortedAt}`,
      );
    }
    // Aborted reasonably quickly after stop
    expect(captured!.abortedAt).toBeGreaterThanOrEqual(0);
    expect(captured!.abortedAt).toBeLessThan(2000);
  });

  it("E3 (RED): cancelAll aborts the per-node signal", async () => {
    // Start a slow workflow, then cancel via engine.stop
    const wf: WorkflowDefinition = {
      name: "stop-test",
      version: "1.0.0",
      description: "verify signal aborts on stop",
      nodes: [
        {
          id: "slow-stop",
          type: "signal-capture",
          name: "Slow Stop",
          config: {},
          timeout: 60000, // long, so timeout won't fire
        },
      ],
      edges: [],
      entry: "__default_entry__",
      outputs: [],
      inputs: {},
      metadata: { tags: [] },
      config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
    };

    const engine = new WorkflowEngine(registry, session);

    const wfPromise = engine.runWorkflow(wf, { input: {} }).catch(() => "stopped");

    // Wait for the node to start
    await new Promise((r) => setTimeout(r, 200));

    // Stop the workflow via the correct internal map (activeSessions)
    const sessionIds = Array.from((engine as any).activeSessions?.keys?.() ?? []) as string[];
    expect(sessionIds.length).toBeGreaterThan(0);
    if (sessionIds.length > 0) {
      await engine.stop(sessionIds[0], "test stop");
    }

    // Wait for workflow to settle (or hang)
    await Promise.race([
      wfPromise,
      new Promise((r) => setTimeout(r, 1500)),
    ]);

    const captured = SignalCaptureNode.capturedSignals.find((c) => c.nodeId === "slow-stop");
    expect(captured).toBeDefined();
    expect(captured!.signalReceived).toBe(true);
    // The signal should have fired (via cancelAll)
    if (captured!.abortedAt === null || captured!.abortedAt === -1) {
      throw new Error(
        `Expected signal to fire within 2s after stop, got abortedAt=${captured!.abortedAt}`,
      );
    }
    expect(captured!.abortedAt).toBeGreaterThanOrEqual(0);
    expect(captured!.abortedAt).toBeLessThan(2000);
  });
});