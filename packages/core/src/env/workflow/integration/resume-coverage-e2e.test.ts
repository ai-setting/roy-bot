/**
 * @fileoverview Resume coverage E2E tests for 4 interrupt scenarios
 *            (Task #1977 — verify workflow run -s <runId> works for
 *             ask_user / timeout / workflow_run_stop / node-error)
 *
 * Scenario A (baseline, MUST PASS — covered elsewhere):
 *   ask_user interrupt → resume
 *
 * Scenario B (RED expected initially):
 *   timeout interrupt → resume via -s
 *
 * Scenario C (RED expected initially):
 *   workflow_run_stop → resume via -s
 *
 * Scenario D (RED expected initially — scheduler.failed bug):
 *   node throws error → resume via -s
 *   node throws error in middle of DAG → downstream still scheduled on retry
 *
 * NOTE: tests are written first (RED). We then analyze failures and fix
 *       only the bugs the tests reveal — no speculative fixes.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkflowEngine } from "../engine/engine";
import { NodeRegistry } from "../engine/node-registry";
import { AskUserError } from "../types/workflow-hil";
import type {
  WorkflowDefinition,
  NodeDefinition,
  NodeExecutionContext,
} from "../types";
import type { SessionComponent } from "../../session/session-component";

// ============================================================================
// Session harness — record all messages and metadata writes
// ============================================================================

interface SessionRecord {
  metadata: any;
  messages: any[];
}

function makeRecordingSession(): {
  session: SessionComponent;
  records: Map<string, SessionRecord>;
} {
  const records = new Map<string, SessionRecord>();
  const session: SessionComponent = {
    create: async (opts: any) => {
      records.set(opts.id, { metadata: opts.metadata ?? {}, messages: [] });
      return { id: opts.id, ...opts };
    },
    get: async (id: string) => {
      const r = records.get(id);
      if (!r) return null;
      return {
        id,
        title: "test",
        metadata: r.metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    update: async (id: string, patch: any) => {
      const r = records.get(id);
      if (!r) return false;
      r.metadata = { ...r.metadata, ...(patch.metadata ?? {}) };
      records.set(id, r);
      return true;
    },
    addMessage: async (id: string, msg: any) => {
      const r = records.get(id);
      if (r) r.messages.push(msg);
      return "msg";
    },
    getMessages: async (id: string) => records.get(id)?.messages ?? [],
    list: async () => [],
  } as unknown as SessionComponent;
  return { session, records };
}

// ============================================================================
// Workflow repo — maps workflowId / workflowName to definitions for engine
// ============================================================================

function makeWorkflowRepo(definitions: WorkflowDefinition[]) {
  const byName = new Map(definitions.map((d) => [d.name, { id: d.name, definition: d }]));
  return {
    getById: (id: string) => byName.get(id),
    getByName: (name: string) => byName.get(name),
  };
}

// ============================================================================
// Node factories — registered as custom node types so we don't need real
// agent/tool implementations (no LLM calls).
// ============================================================================

/**
 * Stateful mock node: fails/interrupts the first `failCount` times,
 * then returns `successOutput` from `(failCount + 1)`-th call onward.
 * Records call counts to a shared map (keyed by nodeId).
 *
 * Sleep behavior: when `sleepMs > 0` the mock sleeps for that duration,
 * observing the AbortSignal. On abort, it REJECTS with an error so the
 * executor records the node as failed/aborted (NOT successfully
 * completed). This is the realistic behavior for stop/timeout: the
 * session should have no `success=true` workflow.node.end so resume
 * can detect the interruption.
 */
function makeStatefulNode(
  nodeId: string,
  callCounts: Map<string, number>,
  options: {
    failCount?: number;
    successOutput?: any;
    interruptQuery?: string;
    sleepMs?: number;
    throwError?: boolean;
    errorMessage?: string;
  } = {},
) {
  return {
    type: "stateful",
    id: nodeId,
    async execute(context: NodeExecutionContext) {
      const count = (callCounts.get(nodeId) ?? 0) + 1;
      callCounts.set(nodeId, count);

      if (options.sleepMs && options.sleepMs > 0 && count <= (options.failCount ?? 1)) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, options.sleepMs);
          context.abortSignal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error(`node ${nodeId} aborted during sleep`));
          });
        });
      }

      if (options.interruptQuery && count <= (options.failCount ?? 1)) {
        // AskUserError — workflow pauses, resume continues
        throw new AskUserError(
          context.runId,
          context.sessionId,
          nodeId,
          "agent",
          options.interruptQuery,
        );
      }

      if (options.throwError && count <= (options.failCount ?? 1)) {
        // Plain error — workflow fails (and should be resumable)
        throw new Error(
          options.errorMessage ?? `simulated error from ${nodeId} call ${count}`,
        );
      }

      return { output: options.successOutput ?? { nodeId, call: count } };
    },
  };
}

// ============================================================================
// Test fixtures
// ============================================================================

function makeSimpleWorkflow(timeoutMs?: number): WorkflowDefinition {
  return {
    name: "resume-coverage-simple",
    version: "1.0.0",
    description: "single node workflow for resume coverage tests",
    nodes: [
      {
        id: "step",
        type: "stateful",
        name: "Step",
        timeout: timeoutMs,
        config: {},
      } as NodeDefinition,
    ],
    edges: [],
    entry: "__default_entry__",
    outputs: [],
    inputs: {},
    metadata: { tags: [] },
    config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
  };
}

const dagWorkflow: WorkflowDefinition = {
  name: "resume-coverage-dag",
  version: "1.0.0",
  description: "A → B → C DAG for downstream-after-failure test",
  nodes: [
    { id: "A", type: "stateful", name: "A", config: {} } as NodeDefinition,
    { id: "B", type: "stateful", name: "B", config: {}, depends_on: ["A"] } as NodeDefinition,
    { id: "C", type: "stateful", name: "C", config: {}, depends_on: ["B"] } as NodeDefinition,
  ],
  edges: [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
  ],
  entry: "__default_entry__",
  outputs: [],
  inputs: {},
  metadata: { tags: [] },
  config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
};

// ============================================================================
// Scenario A — ask_user interrupt → resume (BASELINE — must remain green)
// ============================================================================

describe("Scenario A: ask_user interrupt → resume (baseline)", () => {
  let callCounts: Map<string, number>;
  let engine: WorkflowEngine;
  let records: Map<string, SessionRecord>;
  let session: SessionComponent;
  let wf: WorkflowDefinition;

  beforeEach(() => {
    callCounts = new Map();
    wf = makeSimpleWorkflow();
    const sessionInfo = makeRecordingSession();
    records = sessionInfo.records;
    session = sessionInfo.session;
    const registry = new NodeRegistry();
    registry.register("stateful", (def) => makeStatefulNode(def.id, callCounts, {
      failCount: 1,
      interruptQuery: "Continue from A1?",
      successOutput: { who: "A1" },
    }));
    const repo = makeWorkflowRepo([wf]);
    engine = new WorkflowEngine(registry, session, repo as any);
  });

  it("A1: should resume from ask_user interrupt with -s", async () => {
    const sessionId = "A1-session";

    // 1st run — triggers ask_user
    const first = await engine.run(sessionId, { workflowId: wf.name });
    expect(first.status).toBe("paused");

    // 2nd run — resume with userQuery
    const resumed = await engine.run(sessionId, { input: { userQuery: "yes" } });
    expect(resumed.status).toBe("completed");
    expect(callCounts.get("step")).toBe(2);

    // Last message should reflect completion
    const messages = records.get(sessionId)!.messages;
    const last = messages[messages.length - 1];
    expect(last.metadata?.type).toBe("workflow.node.end");
  });
});

// ============================================================================
// Scenario B — timeout interrupt → resume
// ============================================================================

describe("Scenario B: timeout interrupt → resume", () => {
  let callCounts: Map<string, number>;
  let records: Map<string, SessionRecord>;
  let session: SessionComponent;
  let wf: WorkflowDefinition;

  beforeEach(() => {
    callCounts = new Map();
    // First call sleeps 1500ms (will hit 300ms timeout), second call returns success
    wf = makeSimpleWorkflow(300);
    const sessionInfo = makeRecordingSession();
    records = sessionInfo.records;
    session = sessionInfo.session;
  });

  it("B1: should resume from timeout interrupt with -s", async () => {
    const registry = new NodeRegistry();
    registry.register("stateful", (def) => makeStatefulNode(def.id, callCounts, {
      sleepMs: 1500,
      failCount: 1,
      successOutput: { who: "B1" },
    }));
    const repo = makeWorkflowRepo([wf]);
    const engine = new WorkflowEngine(registry, session, repo as any);
    const sessionId = "B1-session";

    // 1st run — should time out (with abortSignal plumbing the node resolves quickly)
    const first = await engine.run(sessionId, { workflowId: wf.name });
    expect(first.status).toBe("failed");
    expect(callCounts.get("step")).toBe(1);

    // 2nd run — resume via same sessionId (mirrors `workflow run -s`)
    const resumed = await engine.run(sessionId, { input: { userQuery: "retry" } });

    // After the fix: resume should detect failed node.start → resume_node → retry
    expect(resumed.status).toBe("completed");
    expect(callCounts.get("step")).toBe(2);

    // Sanity: at least one workflow.node.start exists, last is workflow.node.end
    const typesAfter = records.get(sessionId)!.messages.map((m) => m.metadata?.type);
    expect(typesAfter).toContain("workflow.node.start");
    expect(typesAfter[typesAfter.length - 1]).toBe("workflow.node.end");
  });
});

// ============================================================================
// Scenario C — workflow_run_stop → resume
// ============================================================================

describe("Scenario C: workflow_run_stop → resume", () => {
  let callCounts: Map<string, number>;
  let records: Map<string, SessionRecord>;
  let session: SessionComponent;
  let wf: WorkflowDefinition;

  beforeEach(() => {
    callCounts = new Map();
    wf = makeSimpleWorkflow(60_000); // long timeout so we can stop cleanly
    const sessionInfo = makeRecordingSession();
    records = sessionInfo.records;
    session = sessionInfo.session;
  });

  it("C1: should resume from workflow_run_stop with -s", async () => {
    const registry = new NodeRegistry();
    registry.register("stateful", (def) => makeStatefulNode(def.id, callCounts, {
      sleepMs: 800,
      failCount: 1,
      successOutput: { who: "C1" },
    }));
    const repo = makeWorkflowRepo([wf]);
    const engine = new WorkflowEngine(registry, session, repo as any);
    const sessionId = "C1-session";

    // 1st run — start workflow, capture promise
    const firstPromise = engine.run(sessionId, { workflowId: wf.name });
    firstPromise.catch(() => { /* swallow — covered by race */ });

    // Wait for activeSessions to populate
    for (let i = 0; i < 50 && !engine.isSessionActive(sessionId); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(engine.isSessionActive(sessionId)).toBe(true);

    // Stop the workflow
    await engine.stop(sessionId, "test stop for C1");

    // The first run promise may never resolve after stop; await with timeout
    await Promise.race([
      firstPromise.catch(() => ({ status: "stopped" })),
      new Promise((r) => setTimeout(() => r({ status: "timeout" }), 500)),
    ]);

    expect(callCounts.get("step")).toBe(1); // started but interrupted

    // 2nd run — resume via same sessionId (mirrors `workflow run -s`)
    const resumed = await engine.run(sessionId, { input: { userQuery: "resume after stop" } });

    expect(resumed.status).toBe("completed");
    expect(callCounts.get("step")).toBe(2);

    const typesAfter = records.get(sessionId)!.messages.map((m) => m.metadata?.type);
    expect(typesAfter).toContain("workflow.node.start");
    expect(typesAfter[typesAfter.length - 1]).toBe("workflow.node.end");
  });
});

// ============================================================================
// Scenario D — node error interrupt → resume (highest risk)
// ============================================================================

describe("Scenario D: node error → resume (scheduler.failed boundary)", () => {
  let callCounts: Map<string, number>;
  let records: Map<string, SessionRecord>;
  let session: SessionComponent;
  let wf: WorkflowDefinition;

  beforeEach(() => {
    callCounts = new Map();
    wf = makeSimpleWorkflow();
    const sessionInfo = makeRecordingSession();
    records = sessionInfo.records;
    session = sessionInfo.session;
  });

  it("D1: should resume from node error with -s (retry failed node)", async () => {
    const registry = new NodeRegistry();
    registry.register("stateful", (def) => makeStatefulNode(def.id, callCounts, {
      failCount: 1,
      throwError: true,
      errorMessage: "simulated transient error",
      successOutput: { who: "D1" },
    }));
    const repo = makeWorkflowRepo([wf]);
    const engine = new WorkflowEngine(registry, session, repo as any);
    const sessionId = "D1-session";

    const first = await engine.run(sessionId, { workflowId: wf.name });
    expect(first.status).toBe("failed");
    expect(callCounts.get("step")).toBe(1);

    // Resume — second call should succeed
    const resumed = await engine.run(sessionId, { input: { userQuery: "retry" } });

    expect(resumed.status).toBe("completed");
    expect(callCounts.get("step")).toBe(2);

    const messages = records.get(sessionId)!.messages;
    const last = messages[messages.length - 1];
    expect(last.metadata?.type).toBe("workflow.node.end");
  });

  it("D2: downstream nodes should still be scheduled when an upstream node errors and resumes", async () => {
    const registry = new NodeRegistry();
    // B throws on first call, succeeds on second; A and C always succeed
    registry.register("stateful", (def) => {
      if (def.id === "B") {
        return makeStatefulNode(def.id, callCounts, {
          failCount: 1,
          throwError: true,
          errorMessage: "B transient error",
          successOutput: { who: "B" },
        });
      }
      return makeStatefulNode(def.id, callCounts, {
        successOutput: { who: def.id },
      });
    });
    const repo = makeWorkflowRepo([dagWorkflow]);
    const engine = new WorkflowEngine(registry, session, repo as any);
    const sessionId = "D2-session";

    const first = await engine.run(sessionId, { workflowId: dagWorkflow.name });
    expect(first.status).toBe("failed");
    // A completed, B failed on call 1, C never started
    expect(callCounts.get("A")).toBe(1);
    expect(callCounts.get("B")).toBe(1);
    expect(callCounts.get("C")).toBeUndefined();

    // Resume — A already completed, B should retry and succeed, then C should run
    const resumed = await engine.run(sessionId, { input: { userQuery: "retry DAG" } });

    expect(resumed.status).toBe("completed");
    expect(callCounts.get("A")).toBe(1); // A not re-executed
    expect(callCounts.get("B")).toBe(2); // B retried successfully
    expect(callCounts.get("C")).toBe(1); // C ran after B

    const messages = records.get(sessionId)!.messages;
    const completedNodes = messages
      .filter((m) => m.metadata?.type === "workflow.node.end")
      .map((m) => m.metadata?.workflowNodeId);
    expect(completedNodes).toContain("A");
    expect(completedNodes).toContain("B");
    expect(completedNodes).toContain("C");
  });
});