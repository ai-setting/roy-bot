/**
 * @fileoverview Workflow Run Stop Tool Tests (Capabilities 2 + 4)
 *
 * Verifies the `workflow_run_stop` tool:
 *   - Calls `WorkflowService.stopRun` with the right args.
 *   - Returns success=true when stop succeeds.
 *   - Returns success=false with a useful error when the session is
 *     missing or the session is not a workflow session.
 *
 * Combined with `workflow-timeout-state.test.ts`, these tests pin down
 * the full "timeout / stop / clean-up" contract:
 *   - engine.timeout → status='failed', activeSessions cleaned (S1-S3)
 *   - engine.stop is idempotent on already-failed sessions (S4)
 *   - workflow_run_stop tool surfaces stopRun() errors to the caller (this file)
 *
 * Task #1974.
 */

import { describe, it, expect, beforeEach, vi } from "bun:test";
import { createWorkflowRunStopTool } from "./workflow-run-stop-tool";
import type { WorkflowService } from "../service/workflow-service";

function makeService(stopRunImpl: (sid: string, reason?: string) => Promise<void>): WorkflowService {
  return {
    stopRun: vi.fn(stopRunImpl),
  } as unknown as WorkflowService;
}

describe("workflow_run_stop tool", () => {
  it("T1: forwards run_id and reason to WorkflowService.stopRun", async () => {
    const service = makeService(async () => {});
    const tool = createWorkflowRunStopTool(service);

    const result = await tool.execute(
      { run_id: "workflow_1784_x", reason: "user-requested" },
      {} as any,
    );

    expect(service.stopRun).toHaveBeenCalledWith("workflow_1784_x", "user-requested");
    expect(result.success).toBe(true);
  });

  it("T2: reason is optional (undefined when omitted)", async () => {
    const service = makeService(async () => {});
    const tool = createWorkflowRunStopTool(service);

    const result = await tool.execute(
      { run_id: "workflow_1784_y" },
      {} as any,
    );

    expect(service.stopRun).toHaveBeenCalledWith("workflow_1784_y", undefined);
    expect(result.success).toBe(true);
  });

  it("T3: surfaces service error as success=false with error message", async () => {
    const service = makeService(async (sid) => {
      throw new Error(`Session not found: ${sid}`);
    });
    const tool = createWorkflowRunStopTool(service);

    const result = await tool.execute(
      { run_id: "workflow_ghost" },
      {} as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Session not found");
  });
});