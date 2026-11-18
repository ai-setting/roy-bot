/**
 * Task #2140 — engine-layer timeout defense.
 *
 * The private waitForCompletion timer must request a stop before its timeout
 * rejection escapes. Otherwise callers that miss this exact error wording can
 * return while in-flight workflow nodes continue running.
 */
import { describe, expect, it, vi } from "bun:test";

import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";

describe("WorkflowEngine.waitForCompletion — Task #2140", () => {
  it("calls stop(sessionId, 'execution timeout') before rejecting", async () => {
    const engine = new WorkflowEngine(new NodeRegistry());
    const sessionId = "workflow_2140_engine_self_stop";
    const abortController = new AbortController();
    const cancelAll = vi.fn();
    const clear = vi.fn();
    const stopSpy = vi.spyOn(engine, "stop");

    (engine as any).activeSessions.set(sessionId, {
      sessionId,
      status: "running",
      abortController,
      executor: { cancelAll },
      eventBus: {
        publish: vi.fn().mockResolvedValue(undefined),
        clear,
      },
      completedPromise: new Promise(() => {
        // Intentionally pending so the internal timeout wins the race.
      }),
    });

    await expect(
      (engine as any).waitForCompletion(sessionId, 10),
    ).rejects.toThrow("Workflow execution timeout: 10ms");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledWith(sessionId, "execution timeout");
    expect(abortController.signal.aborted).toBe(true);
    expect(cancelAll).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(engine.isSessionActive(sessionId)).toBe(false);
  });
});
