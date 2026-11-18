/**
 * @fileoverview P0-3 RED test: WorkflowService.hasActiveWorkflowForParent
 * must filter by parentSessionId precisely.
 *
 * Task #2265 (dual-model review) — Claude flagged this as P0 blocking.
 * The current `hasActiveWorkflowForParent()` returns `true` if ANY
 * `engineInstances` value has `activeSessions.size > 0`, regardless of
 * the parent session. So in multi-REPL scenarios, REPL A (which has no
 * workflow children) but REPL B (which has a running workflow) would
 * cause A's idle ESC to be misclassified as "has active descendant" and
 * trigger a false cascade.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { WorkflowService } from "./workflow-service";
import { MockWorkflowRepository, MockWorkflowEngine } from "../storage/mock-repositories";
import type { Workflow } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSession(opts: {
  id: string;
  parentSessionId?: string | null;
  type: "workflow";
  workflowName: string;
  status: "running" | "paused" | "completed" | "stopped" | "failed";
}) {
  const now = new Date();
  return {
    id: opts.id,
    title: opts.id,
    parentSessionId: opts.parentSessionId ?? null,
    metadata: {
      type: opts.type,
      workflowName: opts.workflowName,
      status: opts.status,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function buildServiceWithMultipleParents(): {
  svc: WorkflowService;
  engineA: any;
  engineB: any;
  // helper: register a sessionId on engine-A as having parentSessionId
  registerActiveOnEngineA: (sessionId: string, parentSessionId: string | null) => void;
  // helper: register a sessionId on engine-B as having parentSessionId
  registerActiveOnEngineB: (sessionId: string, parentSessionId: string | null) => void;
} {
  const repo = new MockWorkflowRepository();
  const engineA = new MockWorkflowEngine();
  const engineB = new MockWorkflowEngine();
  (engineA as any).activeSessions = new Map<string, any>();
  (engineB as any).activeSessions = new Map<string, any>();
  (engineA as any).stop = async () => { /* noop */ };
  (engineB as any).stop = async () => { /* noop */ };

  const engineFactory = (workflow: Workflow) => {
    // Route by workflow name to control which engine is returned.
    if (workflow.name === "wf-A") return engineA as any;
    if (workflow.name === "wf-B") return engineB as any;
    throw new Error(`unexpected workflow ${workflow.name}`);
  };

  const sessionComponent = {
    create: async (_opts: any) => ({ id: "created" }),
    get: async (_id: string) => null,
    list: async (_opts?: any) => [],
    update: async (_id: string, _u: any) => true,
    addMessage: async (_id: string, _msg: any) => "msg_id",
    getMessages: async (_id: string) => [],
  };

  const svc = new WorkflowService(repo, engineFactory, sessionComponent);

  // Pre-register both engines so engineInstances.get() returns them.
  // We do this via the private cache; in real code, runWorkflow populates it.
  // (We need a placeholder workflow to call createWorkflow — the engine
  // factory would return one of the engines based on workflow.name.)
  // We bypass createWorkflow and inject the engines directly.
  (svc as any).engineInstances.set("wf-A", engineA);
  (svc as any).engineInstances.set("wf-B", engineB);

  const registerActiveOnEngineA = (sessionId: string, parentSessionId: string | null) => {
    (engineA as any).activeSessions.set(sessionId, { parentSessionId, status: "running" });
    (svc as any).sessionToEngine.set(sessionId, engineA);
    // P0-3 (Task #2269): the production path also records the
    // parentSessionId in `sessionToParent`. Mirror that here so the
    // precise hasActiveWorkflowForParent lookup has the data it needs.
    (svc as any).sessionToParent.set(sessionId, parentSessionId ?? undefined);
  };
  const registerActiveOnEngineB = (sessionId: string, parentSessionId: string | null) => {
    (engineB as any).activeSessions.set(sessionId, { parentSessionId, status: "running" });
    (svc as any).sessionToEngine.set(sessionId, engineB);
    (svc as any).sessionToParent.set(sessionId, parentSessionId ?? undefined);
  };

  return { svc, engineA, engineB, registerActiveOnEngineA, registerActiveOnEngineB };
}

// ---------------------------------------------------------------------------
// P0-3 RED tests
// ---------------------------------------------------------------------------

describe("P0-3: hasActiveWorkflowForParent precise parent filter (Task #2265)", () => {
  test("P0-3.a: A has no child, B has active child — hasActiveWorkflowForParent(A) === false", () => {
    const { registerActiveOnEngineB } = buildServiceWithMultipleParents();
    // Only B has an active session; it belongs to parent "pB".
    registerActiveOnEngineB("wf_b1", "pB");

    // Build the test inline (re-uses helper setup)
    const built = buildServiceWithMultipleParents();
    built.registerActiveOnEngineB("wf_b1", "pB");

    expect(built.svc.hasActiveWorkflowForParent("pA")).toBe(false);
  });

  test("P0-3.b: A has its own active child — hasActiveWorkflowForParent(A) === true", () => {
    const built = buildServiceWithMultipleParents();
    built.registerActiveOnEngineA("wf_a1", "pA");

    expect(built.svc.hasActiveWorkflowForParent("pA")).toBe(true);
  });

  test("P0-3.c: A and B both have children — hasActiveWorkflowForParent(A) === true, (B) === true, no cross-talk", () => {
    const built = buildServiceWithMultipleParents();
    built.registerActiveOnEngineA("wf_a1", "pA");
    built.registerActiveOnEngineA("wf_a2", "pA");
    built.registerActiveOnEngineB("wf_b1", "pB");

    expect(built.svc.hasActiveWorkflowForParent("pA")).toBe(true);
    expect(built.svc.hasActiveWorkflowForParent("pB")).toBe(true);
    // Unknown parent should still be false.
    expect(built.svc.hasActiveWorkflowForParent("pUnknown")).toBe(false);
  });

  test("P0-3.d: A's child with no parent (top-level) — hasActiveWorkflowForParent(A) === false (top-level not descendant of A)", () => {
    // Edge case: a top-level workflow session (parentSessionId === null) is NOT
    // a descendant of A or B. The current coarse check returns true if any
    // engine has active sessions; the precise check must return false.
    const built = buildServiceWithMultipleParents();
    built.registerActiveOnEngineA("wf_top", null);

    expect(built.svc.hasActiveWorkflowForParent("pA")).toBe(false);
    expect(built.svc.hasActiveWorkflowForParent("pB")).toBe(false);
    // The top-level session itself is the "parent" of nothing — neither A nor B.
  });

  test("P0-3.e: after engine.stop evicts the session, hasActiveWorkflowForParent(parent) === false", () => {
    const built = buildServiceWithMultipleParents();
    built.registerActiveOnEngineA("wf_a1", "pA");
    expect(built.svc.hasActiveWorkflowForParent("pA")).toBe(true);

    // Simulate engine.stop cleanup that removes the active session.
    (built.engineA as any).activeSessions.delete("wf_a1");
    (built.svc as any).sessionToEngine.delete("wf_a1");

    expect(built.svc.hasActiveWorkflowForParent("pA")).toBe(false);
  });

  test("P0-3.f: defensive — undefined parentSessionId in active session is treated as no-match (not as wildcard)", () => {
    // If for some reason the active session's parentSessionId is undefined
    // (corrupted state), it must NOT match arbitrary parents (would cause
    // false cascade for every idle REPL).
    const built = buildServiceWithMultipleParents();
    // Manually inject an entry with undefined parent.
    (built.engineA as any).activeSessions.set("wf_corrupt", { parentSessionId: undefined, status: "running" });
    (built.svc as any).sessionToEngine.set("wf_corrupt", built.engineA);

    expect(built.svc.hasActiveWorkflowForParent("pA")).toBe(false);
    expect(built.svc.hasActiveWorkflowForParent("pB")).toBe(false);
  });

  test("P0-3.g: empty input (no engines cached) — returns false (regression on safe behavior)", () => {
    const repo = new MockWorkflowRepository();
    const sessionComponent = {
      create: async (_opts: any) => ({ id: "created" }),
      get: async (_id: string) => null,
      list: async (_opts?: any) => [],
      update: async (_id: string, _u: any) => true,
      addMessage: async (_id: string, _msg: any) => "msg_id",
      getMessages: async (_id: string) => [],
    };
    const svc = new WorkflowService(repo, (() => { throw new Error("no engine factory"); }) as any, sessionComponent);
    expect(svc.hasActiveWorkflowForParent("pA")).toBe(false);
  });
});
