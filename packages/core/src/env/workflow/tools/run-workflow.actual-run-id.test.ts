/**
 * @fileoverview RED probes for Task #2106 — Track B (workflow_run real runId + late stop)
 *
 * Three probes demonstrate the range-introduced defects called out by the
 * post-6bab7146 verification plan:
 *
 *   - B1: WorkflowEngine.createSession ignores a caller-reserved runId and
 *        always synthesizes a new one. Caller therefore cannot pre-allocate
 *        a runId that the tool layer can use for status / stop.
 *   - B2: workflow_run synthesizes a fallback runId but does NOT forward
 *        it to the engine via RunOptions. So the fallback is not a real
 *        session and cannot be queried or stopped by workflow_status /
 *        workflow_run_stop.
 *   - B3: when the real engine session is persisted AFTER the tool's
 *        timeout has already tried to stop the synthetic fallback, the
 *        callback fires but no retry stop is attempted on the real ID.
 *        Background workflow execution therefore continues past the
 *        user-visible timeout.
 *
 * Each probe is expected to FAIL on the current branch (commit range
 * 6bab7146..HEAD) and PASS after the corresponding fix lands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { createRunWorkflowTool } from "./run-workflow";
import type { WorkflowService } from "../service/workflow-service";
import type { ToolContext } from "../../../env/tool/types";

// Mock logger so we don't pollute test output
vi.mock("../../../env/log-trace/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("RED probes — Task #2106 Track B (workflow_run real runId + late stop)", () => {
  let mockService: Partial<WorkflowService>;
  let tool: ReturnType<typeof createRunWorkflowTool>;
  let ctx: ToolContext;

  beforeEach(() => {
    mockService = {
      runWorkflow: vi.fn(),
      resumeSession: vi.fn(),
      stopRun: vi.fn().mockResolvedValue(undefined),
    };
    tool = createRunWorkflowTool(mockService as WorkflowService);
    ctx = { workdir: "/tmp" };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------
  // RED-B2: workflow_run forwards the synthesized fallback runId to the
  // engine via RunOptions.runId, so the fallback IS the real session ID
  // (after GREEN-B, createSession honors the caller-reserved runId).
  //
  // Today the runWorkflow call does NOT include any runId option, so
  // the engine creates its own unrelated sessionId. This probe captures
  // the third arg of runWorkflow and asserts the runId field matches
  // the value later returned in output.run_id.
  // --------------------------------------------------------------------
  it("B2 RED: workflow_run forwards its reserved runId to engine.runWorkflow", async () => {
    let forwardedOptions: any = null;
    (mockService.runWorkflow as any).mockImplementation(
      (_name: string, _input: any, options: any) => {
        forwardedOptions = options;
        // Mimic late onSessionCreated (fires AFTER the tool's timeout).
        // We will trigger it from outside the test once we know the runId.
        return new Promise(() => {});
      },
    );

    const result = await tool.execute(
      { workflow_name: "late-create", timeout: 50 },
      ctx,
    );

    expect(result.success).toBe(false);
    const outRunId = (result.output as any)?.run_id;
    expect(typeof outRunId).toBe("string");
    expect(outRunId).toMatch(/^workflow_/);

    // The engine MUST have been told the same runId we're going to surface.
    expect(forwardedOptions).not.toBeNull();
    expect(forwardedOptions.runId).toBe(outRunId);
  });

  // --------------------------------------------------------------------
  // RED-B3: when the engine persists the session AFTER the tool's
  // timeout fires, the late onSessionCreated callback must trigger a
  // second stopRun attempt on the real sessionId, so background work
  // does not continue past the visible timeout.
  //
  // Timeline:
  //   t=0:   tool starts runWorkflow; reservedRunId pre-synthesized
  //   t=50:  timeout wins the race → stopRun(reservedRunId) rejected
  //          ("Session not found: reservedRunId")
  //   t=80:  engine.createSession finally resolves → calls
  //          onSessionCreated(reservedRunId)
  //   t=80+: tool retries stopRun(reservedRunId) once.
  // --------------------------------------------------------------------
  it("B3 RED: a session persisted after the timeout is stopped once it exists", async () => {
    let capturedOnSessionCreated: ((id: string) => void) | undefined;

    (mockService.stopRun as any)
      .mockRejectedValueOnce(new Error("Session not found: too_early"))
      .mockResolvedValueOnce(undefined);

    (mockService.runWorkflow as any).mockImplementation(
      (_name: string, _input: any, options: any) => {
        capturedOnSessionCreated = options?.onSessionCreated;
        return new Promise(() => {});
      },
    );

    const result = await tool.execute(
      { workflow_name: "late-create", timeout: 50 },
      ctx,
    );

    expect(result.success).toBe(false);
    const outRunId = (result.output as any)?.run_id;
    expect(outRunId).toMatch(/^workflow_/);

    // Now the engine eventually creates the session. The tool's
    // onSessionCreated handler must trigger a retry stop on the real ID.
    expect(typeof capturedOnSessionCreated).toBe("function");
    capturedOnSessionCreated!(outRunId);

    // Allow microtasks / logger warnings to flush.
    await new Promise((r) => setTimeout(r, 5));

    // First stopRun call: with the reserved ID (failed "Session not found").
    // Second stopRun call: with the same reserved ID (succeeds after session
    // is persisted).
    expect(mockService.stopRun).toHaveBeenCalledTimes(2);
    const callArgs = (mockService.stopRun as any).mock.calls;
    expect(callArgs[0][0]).toBe(outRunId);
    expect(callArgs[1][0]).toBe(outRunId);
  });
});