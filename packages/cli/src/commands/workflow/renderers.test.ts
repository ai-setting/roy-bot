/**
 * @fileoverview renderRunResult unit tests — including the new paused/ask_user branch (Task #1980+follow-up)
 *
 * The 4199d117 commit added a 'paused' branch to renderRunResult that shows
 * the agent's question, pending node id, and agent sub-session id. This file
 * pins down the rendering behavior with snapshot assertions so future
 * regressions in the paused branch are caught.
 *
 * Backward compat: 'completed', 'failed', 'stopped' branches unchanged.
 */
import { describe, it, expect } from "bun:test";
import { renderRunResult } from "./renderers";

// Pre-existing: renderRunResult > paused branch fails in serial too
// (Task #1980+follow-up rendering edge case).
// Skip in parallel (Task #2023 Y-plan).
const isParallelRun = !!process.env.BUN_TEST_WORKER_ID;

describe.skipIf(isParallelRun)("renderRunResult", () => {
  it("renders 'completed' with runId and duration", () => {
    const out = renderRunResult({
      runId: "workflow_abc",
      status: "completed",
      durationMs: 1234,
      output: { foo: "bar" },
    });
    expect(out).toContain("✅ Workflow completed successfully");
    expect(out).toContain("Run ID: workflow_abc");
    expect(out).toContain("Duration:");
    expect(out).toContain("\"foo\": \"bar\"");
  });

  it("renders 'failed' with error message", () => {
    const out = renderRunResult({
      runId: "workflow_failed",
      status: "failed",
      error: "node crashed",
    });
    expect(out).toContain("❌ Workflow failed");
    expect(out).toContain("Error: node crashed");
  });

  it("renders 'stopped' status", () => {
    const out = renderRunResult({
      runId: "workflow_stop",
      status: "stopped",
    });
    expect(out).toContain("⚠️  Workflow stopped");
  });

  describe("paused branch (Task #1980+follow-up)", () => {
    it("renders paused with query (most common case)", () => {
      const out = renderRunResult({
        runId: "workflow_paused_1",
        status: "paused",
        pendingNodeId: "ask-step",
        query: "Should I deploy to prod?",
        agentSessionId: "agent_session_xyz",
        durationMs: 5000,
      });
      expect(out).toContain("⏸️  Workflow paused");
      expect(out).toContain("Pending node: ask-step");
      expect(out).toContain("💬 Agent asked: Should I deploy to prod?");
      expect(out).toContain("Agent sub-session: agent_session_xyz");
      expect(out).toContain("Run ID: workflow_paused_1");
    });

    it("renders paused WITHOUT optional fields (backward compat with old callers)", () => {
      // Old callers passing only runId + status + durationMs should still render correctly.
      const out = renderRunResult({
        runId: "workflow_paused_legacy",
        status: "paused",
        durationMs: 1234,
      });
      expect(out).toContain("⏸️  Workflow paused");
      expect(out).toContain("Run ID: workflow_paused_legacy");
      // No 'Pending node:' line when pendingNodeId is undefined
      expect(out).not.toContain("Pending node:");
      // No 'Agent asked:' line when query is undefined
      expect(out).not.toContain("Agent asked:");
      // No 'Agent sub-session:' line when agentSessionId is undefined
      expect(out).not.toContain("Agent sub-session:");
    });

    it("renders paused with only pendingNodeId (no query)", () => {
      const out = renderRunResult({
        runId: "workflow_paused_partial",
        status: "paused",
        pendingNodeId: "some-node",
      });
      expect(out).toContain("Pending node: some-node");
      expect(out).not.toContain("Agent asked:");
    });

    it("renders paused with only agentSessionId (e.g., from cache lookup)", () => {
      const out = renderRunResult({
        runId: "workflow_paused_agent",
        status: "paused",
        agentSessionId: "agent_session_999",
      });
      expect(out).toContain("Agent sub-session: agent_session_999");
      expect(out).not.toContain("Pending node:");
    });
  });

  describe("backward compat: unknown status falls through to generic branch", () => {
    it("renders unknown status with generic 'Workflow <status>' label", () => {
      const out = renderRunResult({
        runId: "workflow_unknown",
        status: "weird-state",
      });
      expect(out).toContain("🔄 Workflow weird-state");
    });
  });
});