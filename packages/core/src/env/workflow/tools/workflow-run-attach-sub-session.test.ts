/**
 * @fileoverview workflow_run attach to bgTaskId TDD tests (Task #2144)
 *
 * 验证 workflow_run 工具：
 * 1. AC-4: 主 session 直接调用（无 bgTaskId）时，不注册 attach
 * 2. AC-5: sub-session 调用时，把 runId 注册到对应 bgTaskId 的 registry
 * 3. 自然完成 detach；失败路径不 detach（让 propagateStop 清理）
 * 4. ALS nested: 嵌套 sub-session 使用 innermost bgTaskId
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";

import {
  runWithBgTaskIdAsync,
} from "../../task/delegate/bg-task-id-storage";
import { createRunWorkflowTool } from "./run-workflow";

describe("workflow_run attach to bgTaskId (Task #2144)", () => {
  let mockWorkflowService: any;
  let attachedCalls: Array<{ bgTaskId: string; runId: string }>;
  let detachedCalls: Array<{ bgTaskId: string; runId: string }>;

  beforeEach(() => {
    attachedCalls = [];
    detachedCalls = [];
    // Real engine (Task #2106 GREEN-B) honors the reserved runId, so
    // the engine-reported id equals what we PRE-attached. We mimic that
    // here so the registry ends up with the same id we attached.
    mockWorkflowService = {
      runWorkflow: vi.fn(async (_name: string, _input: any, _opts: any) => {
        const realRunId =
          typeof _opts?.runId === "string" && _opts.runId.length > 0
            ? _opts.runId
            : "wf_real_123";
        if (typeof _opts?.onSessionCreated === "function") {
          _opts.onSessionCreated(realRunId);
        }
        return {
          runId: realRunId,
          sessionId: realRunId,
          status: "completed",
          output: { result: "ok" },
          durationMs: 100,
        };
      }),
      resumeSession: vi.fn(),
    };
  });

  function buildTool() {
    return createRunWorkflowTool(mockWorkflowService, {
      attachWorkflowRun: (bgTaskId: string, runId: string) =>
        attachedCalls.push({ bgTaskId, runId }),
      detachWorkflowRun: (bgTaskId: string, runId: string) =>
        detachedCalls.push({ bgTaskId, runId }),
    });
  }

  test("AC-4: main session direct workflow_run (no bgTaskId) does NOT call attach", async () => {
    const tool = buildTool();
    const result = await tool.execute(
      { workflow_name: "x" } as any,
      { session_id: "main_1" } as any
    );
    expect(result.success).toBe(true);
    expect(attachedCalls).toHaveLength(0);
    expect(detachedCalls).toHaveLength(0);
  });

  test("AC-5: sub-session workflow_run registers to corresponding bgTaskId", async () => {
    const tool = buildTool();
    await runWithBgTaskIdAsync("bg_sub_42", async () => {
      const result = await tool.execute(
        { workflow_name: "x" } as any,
        { session_id: "sub_42" } as any
      );
      expect(result.success).toBe(true);
    });
    // Task #2190 — with PRE-attach the registry entry holds the
    // reservedRunId (synthesized `workflow_xxx` format). The engine's
    // onSessionCreated then fires `replaceWorkflowRun` which swaps the
    // entry to itself (same id, since real engine honors reserved id).
    // The registry's effective value equals the attached id.
    expect(attachedCalls).toHaveLength(1);
    expect(attachedCalls[0].bgTaskId).toBe("bg_sub_42");
    expect(attachedCalls[0].runId).toMatch(/^workflow_/);
    const attachedRunId = attachedCalls[0].runId;

    // 自然完成 → 应当 detach (same id that was attached)
    expect(detachedCalls).toEqual([
      { bgTaskId: "bg_sub_42", runId: attachedRunId },
    ]);
  });

  test("natural completion detaches; failure path keeps attached (lets propagateStop clean up)", async () => {
    const tool = buildTool();

    // Success path: should detach
    await runWithBgTaskIdAsync("bg_1", async () => {
      await tool.execute({ workflow_name: "x" } as any, {} as any);
    });
    // The detached runId matches the PRE-attached reservedRunId (since
    // the engine's onSessionCreated reported the same id, so the
    // registry entry never changes its value).
    const bg1Attached = attachedCalls.find((c) => c.bgTaskId === "bg_1");
    expect(bg1Attached).toBeDefined();
    expect(detachedCalls).toEqual([
      { bgTaskId: "bg_1", runId: bg1Attached!.runId },
    ]);

    // Failure path: should NOT detach (let propagateStop handle cleanup).
    // The runId on failure is the synthesized fallback (Task #2106 semantics),
    // not the engine's pre-success id. We just assert attach happened at all.
    mockWorkflowService.runWorkflow.mockRejectedValueOnce(
      new Error("engine boom")
    );
    await runWithBgTaskIdAsync("bg_2", async () => {
      const result = await tool.execute({ workflow_name: "x" } as any, {} as any);
      expect(result.success).toBe(false);
    });
    // detachedCalls unchanged — still only the success-path entry
    expect(detachedCalls).toEqual([
      { bgTaskId: "bg_1", runId: bg1Attached!.runId },
    ]);
    // attachedCalls has a bg_2 entry with the synthesized fallback runId
    expect(attachedCalls.some((c) => c.bgTaskId === "bg_2")).toBe(true);
  });

  test("ALS nested: sub-session inside sub-session uses innermost bgTaskId", async () => {
    const tool = buildTool();
    await runWithBgTaskIdAsync("bg_outer", async () => {
      await runWithBgTaskIdAsync("bg_inner", async () => {
        await tool.execute({ workflow_name: "x" } as any, {} as any);
      });
    });
    // Task #2190 — PRE-attach registers against the innermost bgTaskId
    // (same ALS resolution as before). The runId is the reservedRunId.
    expect(attachedCalls).toHaveLength(1);
    expect(attachedCalls[0]).toEqual({
      bgTaskId: "bg_inner",
      runId: expect.stringMatching(/^workflow_/),
    });
    const innerRunId = attachedCalls[0].runId;
    expect(detachedCalls).toEqual([
      { bgTaskId: "bg_inner", runId: innerRunId },
    ]);
  });
});
