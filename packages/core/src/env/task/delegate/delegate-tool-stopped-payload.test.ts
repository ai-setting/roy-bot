/**
 * @fileoverview Task #2190 — BackgroundTaskCompletedPayload exposes
 * `attached_workflow_run_ids` and `workflow_stop_results` so the main
 * session can audit which workflows were stopped.
 *
 * Validation: stopTask() returns the registered workflow_run_ids list and
 * the per-id stop results in the result payload. Currently these fields
 * don't exist on the stop-task result, so the test FAILS RED.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { BackgroundTaskManager } from "./delegate-tool";

// ---------------------------------------------------------------------------
// Mock env builder (mirrors delegate-tool-propagate-stop.test.ts pattern)
// ---------------------------------------------------------------------------

interface MockEnv {
  handle_query: (...args: any[]) => Promise<string>;
  getComponent: (name: string) => any;
  publishEvent?: any;
  pushEnvEvent?: any;
  [key: string]: any;
}

function buildMockEnv(
  opts: { blockHandleQuery?: boolean } = {},
): { env: MockEnv; release: () => void } {
  let releaseFn: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  const subSession = {
    id: "sub_session_1",
    info: { metadata: { subagent_type: "general", task_description: "mock" } },
  };
  const parentSession = {
    id: "parent_session_1",
    info: { metadata: {} },
  };

  const env: MockEnv = {
    handle_query:
      opts.blockHandleQuery === false
        ? async () => "done"
        : async () => {
            await released;
            return "done";
          },
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          get: async (id: string) =>
            id === "sub_session_1" ? subSession : parentSession,
          create: async (_opts: any) => subSession,
          update: async (_id: string, _patch: any) => ({}),
        };
      }
      if (name === "agent") {
        return {
          getRegistry: () => undefined,
          getAgent: () => undefined,
          registerAgent: () => undefined,
          abort: () => {},
        };
      }
      return undefined;
    },
    pushEnvEvent: () => {},
    publishEvent: () => {},
  };
  return { env, release: releaseFn };
}

describe("BackgroundTaskManager.stopTask payload (Task #2190)", () => {
  let mockEnv: MockEnv;
  let releaseHandle: () => void;
  let stopRunCalls: Array<{ runId: string; reason: string | undefined }>;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    const built = buildMockEnv({ blockHandleQuery: true });
    mockEnv = built.env;
    releaseHandle = built.release;
    stopRunCalls = [];
    mgr = new BackgroundTaskManager(mockEnv as any);
    mgr.setWorkflowService({
      stopRun: async (runId: string, reason?: string) => {
        stopRunCalls.push({ runId, reason });
      },
    });
  });

  // ---------------------------------------------------------------------
  // AC-6a: stopTask payload includes `attached_workflow_run_ids`
  // ---------------------------------------------------------------------
  test("AC-6a: stopTask result includes attached_workflow_run_ids (list of runIds that were stopped)", async () => {
    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "stopped payload test",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });

    mgr.attachWorkflowRun(taskId, "wf_run_payload_1");
    mgr.attachWorkflowRun(taskId, "wf_run_payload_2");

    const result = await mgr.stopTask(taskId);
    releaseHandle();

    // stopTask should succeed
    expect(result.success).toBe(true);

    // ★ The fix: payload must include attached_workflow_run_ids
    const payload = (result as any).attached_workflow_run_ids;
    expect(payload).toBeDefined();
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload).toContain("wf_run_payload_1");
    expect(payload).toContain("wf_run_payload_2");
  });

  // ---------------------------------------------------------------------
  // AC-6b: stopTask payload includes `workflow_stop_results` (per-id results)
  // ---------------------------------------------------------------------
  test("AC-6b: stopTask result includes workflow_stop_results (per-id stop outcomes)", async () => {
    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "stop results payload test",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });

    mgr.attachWorkflowRun(taskId, "wf_run_results_1");
    mgr.attachWorkflowRun(taskId, "wf_run_results_2");

    const result = await mgr.stopTask(taskId);
    releaseHandle();

    expect(result.success).toBe(true);

    // ★ The fix: payload must include workflow_stop_results (per-id stop outcome)
    const stopResults = (result as any).workflow_stop_results;
    expect(stopResults).toBeDefined();
    expect(Array.isArray(stopResults)).toBe(true);
    expect(stopResults).toHaveLength(2);

    // Each entry must expose at least the runId and the outcome
    const ids = stopResults.map((r: any) => r.runId ?? r.workflowRunId);
    expect(ids).toContain("wf_run_results_1");
    expect(ids).toContain("wf_run_results_2");
  });

  // ---------------------------------------------------------------------
  // AC-6c: empty registry → empty arrays (not undefined, not null)
  // ---------------------------------------------------------------------
  test("AC-6c: stopTask with no attached workflows returns empty arrays (not undefined)", async () => {
    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "no workflow attached",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });

    const result = await mgr.stopTask(taskId);
    releaseHandle();

    expect(result.success).toBe(true);
    // Even with no workflows, the payload fields should be present
    // (empty arrays) so consumers can rely on the shape.
    const payload = (result as any).attached_workflow_run_ids;
    expect(payload).toBeDefined();
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(0);

    const stopResults = (result as any).workflow_stop_results;
    expect(stopResults).toBeDefined();
    expect(Array.isArray(stopResults)).toBe(true);
    expect(stopResults).toHaveLength(0);
  });
});