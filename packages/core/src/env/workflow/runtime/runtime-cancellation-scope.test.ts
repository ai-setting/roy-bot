/**
 * @fileoverview TDD RED — RuntimeCancellationScope contract (Task #2275 Task 2)
 *
 * Module under test: `packages/core/src/env/workflow/runtime/runtime-cancellation-scope.ts`
 *
 * Contract:
 *   - `new RuntimeCancellationScope()` → `{signal, forceSignal, level, track, onForce, cancel, waitForCleanup}`
 *   - Two separate AbortControllers (graceful + force). `forceSignal` aborts
 *     only after `cancel({force:true})`. force must IMPLY graceful.
 *   - `cancel(reason, {force?:bool})` sets the reason on the right controller.
 *   - `track(label, work)` returns a Promise that settles with `work`; when
 *     work settles it is removed from tracking. The scope NEVER swallows
 *     work errors — but a cleanup-handler error during `cancel`/`onForce`
 *     is captured into a CleanupReport instead of throwing.
 *   - `onForce(label, handler)` registers a handler invoked synchronously
 *     when `cancel({force:true})` fires; returns an `unsubscribe()` fn.
 *   - `waitForCleanup(timeoutMs)` returns once all tracked work settles, or
 *     after timeout. CleanupReport has `completed: boolean`, `pendingLabels`,
 *     `errors: [{label, error}]`.
 *   - `level`: `"running" | "graceful" | "force"` — reflects current state.
 *
 * RED state: the module path does not exist yet, so `import` from the
 * target path will fail the test loader.
 */

import { describe, it, expect } from "bun:test";
import {
  RuntimeCancellationScope,
} from "./runtime-cancellation-scope";

describe("[Task #2275 RED] RuntimeCancellationScope contract", () => {
  it("RED-T2-1: graceful cancel only fires once, signal carries reason", async () => {
    const scope = new RuntimeCancellationScope();
    expect(scope.level).toBe("running");
    expect(scope.signal.aborted).toBe(false);
    expect(scope.forceSignal.aborted).toBe(false);

    let gracefulAbortCount = 0;
    let observedReason: unknown = null;
    scope.signal.addEventListener("abort", () => {
      gracefulAbortCount++;
      observedReason = scope.signal.reason;
    });

    await scope.cancel("user-stopped");
    expect(scope.signal.aborted).toBe(true);
    expect(scope.level).toBe("graceful");
    expect(observedReason).toBe("user-stopped");

    // Second cancel is a no-op (must NOT re-fire abort).
    await scope.cancel("user-stopped-again");
    expect(gracefulAbortCount).toBe(1);
    // force still not fired.
    expect(scope.forceSignal.aborted).toBe(false);
  });

  it("RED-T2-2: force cancel implies graceful AND fires its own force handlers", async () => {
    const scope = new RuntimeCancellationScope();
    let gracefulFired = false;
    let forceFired = false;
    scope.signal.addEventListener("abort", () => (gracefulFired = true));
    scope.forceSignal.addEventListener("abort", () => (forceFired = true));

    let forceHandlerCalls = 0;
    scope.onForce("force-handler-1", () => {
      forceHandlerCalls++;
    });

    await scope.cancel("kill", { force: true });
    expect(gracefulFired).toBe(true);
    expect(forceFired).toBe(true);
    expect(scope.level).toBe("force");
    expect(forceHandlerCalls).toBe(1);

    // force handlers are not re-invoked on subsequent cancel.
    await scope.cancel("kill-2", { force: true });
    expect(forceHandlerCalls).toBe(1);
  });

  it("RED-T2-3: tracked work settles and waitForCleanup reports completed:true", async () => {
    const scope = new RuntimeCancellationScope();
    const settled: Array<string> = [];

    const tracked1 = scope.track("label-1", (async () => {
      await new Promise((r) => setTimeout(r, 30));
      settled.push("label-1");
      return "result-1";
    })());
    const tracked2 = scope.track("label-2", (async () => {
      await new Promise((r) => setTimeout(r, 60));
      settled.push("label-2");
      return "result-2";
    })());

    expect(await tracked1).toBe("result-1");
    const report = await scope.waitForCleanup(500);
    expect(report.completed).toBe(true);
    expect(report.pendingLabels).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(settled).toContain("label-1");

    // tracked2 has already settled by now
    expect(await tracked2).toBe("result-2");
  });

  it("RED-T2-4: cleanup handler errors are aggregated, not thrown; do not block siblings", async () => {
    const scope = new RuntimeCancellationScope();
    let okHandlerCalled = 0;
    let badHandlerCalled = 0;

    scope.onForce("ok", async () => {
      okHandlerCalled++;
    });
    scope.onForce("bad", async () => {
      badHandlerCalled++;
      throw new Error("boom");
    });
    scope.onForce("bad-2", async () => {
      throw new Error("boom-2");
    });

    // Should not throw.
    const report = await scope.cancel("kill", { force: true });
    expect(okHandlerCalled).toBe(1);
    expect(badHandlerCalled).toBe(1);
    // Errors must be aggregated, not bubbled.
    expect(report.errors.length).toBeGreaterThanOrEqual(2);
    expect(report.errors.find((e) => e.error.includes("boom"))).toBeDefined();
    expect(report.errors.find((e) => e.error.includes("boom-2"))).toBeDefined();
  });

  it("RED-T2-5: onForce() returns an unsubscribe function that detaches the handler", async () => {
    const scope = new RuntimeCancellationScope();
    let calls = 0;
    const off = scope.onForce("once", () => {
      calls++;
    });
    off();
    await scope.cancel("kill", { force: true });
    expect(calls).toBe(0);
  });
});