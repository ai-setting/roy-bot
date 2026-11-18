/**
 * @fileoverview P0-2 RED test: cascadeStopSessionTree must serialize
 * same-parent operations and properly upgrade graceful→force.
 *
 * Task #2265 (dual-model review) — both Codex and Claude flagged P0:
 * the current reentrancy key includes \`force\` as a dimension, so
 * \`(parentId, false)\` and \`(parentId, true)\` are different keys and
 * can run concurrently. The user-observed symptoms:
 *
 *  1. First ESC (graceful) is in-flight. The graceful stages have
 *     invoked task.stopAllForParent and are awaiting its resolution.
 *  2. User presses ESC again (within 2s window). The handleEscKey
 *     logic computes \`force=true\` and calls \`cascadeStopSessionTree(force=true)\`.
 *  3. Because the cascade key is \`parentId|force\`, the force call
 *     sees a DIFFERENT key from the in-flight graceful, and runs in
 *     parallel — both stages invoking task.stopAllForParent /
 *     workflow.stopAllForParent on the same parentId.
 *  4. The two cascades race for the same DB rows / cache writes /
 *     agentNode children, producing inconsistent state.
 *
 * Required semantics:
 *  - Same parent MUST be serialized (second call waits for first).
 *  - Graceful-then-force MUST result in BOTH the graceful stages AND
 *    the force stages being executed (second call not dropped).
 *  - Cross-parent calls remain independent (concurrent is fine).
 *  - Graceful throw doesn't block the force upgrade from running.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { cascadeStopSessionTree } from "./session-tree-stopper";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock env with controllable stopAllForParent and forceStopAll
 * hooks. Each hook can be configured to await a deferred signal so
 * we can stage the timing of in-flight operations.
 */
function buildControllableEnv(opts: {
  // delay ms before stopAllForParent resolves (simulate in-flight cascade)
  stopAllForParentDelayMs?: number;
  // delay ms before forceStopAll resolves
  forceStopAllDelayMs?: number;
  // throw on stopAllForParent (simulate graceful failure)
  stopAllForParentThrows?: boolean;
  // record calls to both methods
  callLog?: Array<{ method: string; parentId: string; ts: number }>;
} = {}) {
  const callLog = opts.callLog ?? [];
  const stopDelay = opts.stopAllForParentDelayMs ?? 30;
  const forceDelay = opts.forceStopAllDelayMs ?? 10;
  return {
    callLog,
    env: {
      getComponent: (name: string) => {
        if (name === "task") {
          return {
            backgroundTaskManager: {
              stopAllForParent: async (parentId: string) => {
                callLog.push({ method: "task.stopAllForParent", parentId, ts: Date.now() });
                if (opts.stopAllForParentThrows) {
                  throw new Error("simulated stopAllForParent failure");
                }
                await new Promise((r) => setTimeout(r, stopDelay));
                return { stoppedTaskIds: ["t1"] };
              },
              forceStopAll: async () => {
                callLog.push({ method: "task.forceStopAll", parentId: "*", ts: Date.now() });
                await new Promise((r) => setTimeout(r, forceDelay));
              },
            },
          };
        }
        if (name === "workflow") {
          return {
            workflowService: {
              stopAllForParent: async (parentId: string) => {
                callLog.push({ method: "workflow.stopAllForParent", parentId, ts: Date.now() });
                if (opts.stopAllForParentThrows) {
                  throw new Error("simulated stopAllForParent failure");
                }
                await new Promise((r) => setTimeout(r, stopDelay));
                return { stoppedSessionIds: ["wf1"] };
              },
              forceStopAll: async () => {
                callLog.push({ method: "workflow.forceStopAll", parentId: "*", ts: Date.now() });
                await new Promise((r) => setTimeout(r, forceDelay));
              },
            },
          };
        }
        return undefined;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// P0-2 RED tests
// ---------------------------------------------------------------------------

describe("P0-2: cascadeStopSessionTree serializes same-parent upgrades (Task #2265)", () => {
  test("P0-2.a: graceful in-flight + force call → force stages run AFTER graceful, not concurrently", async () => {
    // Use 80ms stopAllForParent delay so graceful is still in-flight when
    // the force call arrives. Force delay is 10ms so it would otherwise
    // finish well before graceful.
    const { env, callLog } = buildControllableEnv({
      stopAllForParentDelayMs: 80,
      forceStopAllDelayMs: 10,
    });

    const parentId = "pX";
    // Start graceful (force=false)
    const gracefulP = cascadeStopSessionTree(env, parentId, { force: false });
    // Wait 5ms then start force (force=true) — force call should wait
    // for graceful to finish, not race.
    await new Promise((r) => setTimeout(r, 5));
    const forceP = cascadeStopSessionTree(env, parentId, { force: true });

    const [gracefulR, forceR] = await Promise.all([gracefulP, forceP]);

    // Both promises should resolve (force call must not be dropped).
    expect(gracefulR.stoppedTaskIds).toContain("t1");
    expect(gracefulR.stoppedWorkflowSessionIds).toContain("wf1");
    // P0-2: result.force reflects the merged cascade. The first call
    // was graceful, but the second call upgraded to force, so the
    // merged result's force flag is true. Both callers see the same
    // shared result (single in-flight cascade).
    expect(gracefulR.force).toBe(true);
    expect(forceR.force).toBe(true);
    // The two callers receive the SAME result object (same underlying execution).
    expect(gracefulR).toEqual(forceR);
    // Force stages (task.forceStopAll / workflow.forceStopAll) MUST be invoked.
    expect(callLog.some((c) => c.method === "task.forceStopAll")).toBe(true);
    expect(callLog.some((c) => c.method === "workflow.forceStopAll")).toBe(true);

    // CRITICAL: stopAllForParent should be called AT MOST ONCE per parent
    // (graceful and force share the same underlying graceful execution;
    // the force call upgrades by appending force stages, NOT by running
    // a second set of graceful stages in parallel).
    const stopAllCalls = callLog.filter(
      (c) => c.method === "task.stopAllForParent" && c.parentId === parentId,
    );
    const stopAllWfCalls = callLog.filter(
      (c) => c.method === "workflow.stopAllForParent" && c.parentId === parentId,
    );
    expect(stopAllCalls.length).toBe(1);
    expect(stopAllWfCalls.length).toBe(1);

    // CRITICAL: graceful stages and force stages must NOT overlap in time.
    // The latest graceful stopAllForParent call must be BEFORE the earliest
    // forceStopAll call. (We use Date.now() timestamps; allow 5ms slack
    // for event loop granularity.)
    const gracefulCalls = callLog.filter(
      (c) => c.method === "task.stopAllForParent" || c.method === "workflow.stopAllForParent",
    );
    const forceCalls = callLog.filter(
      (c) => c.method === "task.forceStopAll" || c.method === "workflow.forceStopAll",
    );
    const latestGracefulTs = Math.max(...gracefulCalls.map((c) => c.ts));
    const earliestForceTs = Math.min(...forceCalls.map((c) => c.ts));
    expect(earliestForceTs).toBeGreaterThanOrEqual(latestGracefulTs - 5);
  });

  test("P0-2.b: different parents run concurrently (no cross-blocking)", async () => {
    // Each env call is parent-specific; we need to dispatch by parent.
    const callLog: Array<{ method: string; parentId: string; ts: number }> = [];
    const env = {
      getComponent: (name: string) => {
        if (name === "task") {
          return {
            backgroundTaskManager: {
              stopAllForParent: async (parentId: string) => {
                callLog.push({ method: "task.stopAllForParent", parentId, ts: Date.now() });
                await new Promise((r) => setTimeout(r, 50));
                return { stoppedTaskIds: [`t_${parentId}`] };
              },
              forceStopAll: async () => {},
            },
          };
        }
        if (name === "workflow") {
          return {
            workflowService: {
              stopAllForParent: async (parentId: string) => {
                callLog.push({ method: "workflow.stopAllForParent", parentId, ts: Date.now() });
                await new Promise((r) => setTimeout(r, 50));
                return { stoppedSessionIds: [`wf_${parentId}`] };
              },
              forceStopAll: async () => {},
            },
          };
        }
        return undefined;
      },
    };

    // Start cascades for pA and pB at the same time. They should run
    // concurrently — pB's stopAllForParent should start before pA's finishes.
    const t0 = Date.now();
    const [ra, rb] = await Promise.all([
      cascadeStopSessionTree(env, "pA", { force: false }),
      cascadeStopSessionTree(env, "pB", { force: false }),
    ]);
    const total = Date.now() - t0;

    expect(ra.stoppedTaskIds).toContain("t_pA");
    expect(rb.stoppedTaskIds).toContain("t_pB");
    // If serialized, total would be ~100ms (50+50). Concurrent should be
    // ~50ms. Allow generous bound for slow CI.
    expect(total).toBeLessThan(120);

    // pA and pB should both have start_ts close to t0 (within 20ms slack).
    // This is the more reliable concurrency check than total time.
    const pACall = callLog.find((c) => c.parentId === "pA" && c.method === "task.stopAllForParent");
    const pBCall = callLog.find((c) => c.parentId === "pB" && c.method === "task.stopAllForParent");
    expect(pACall).toBeDefined();
    expect(pBCall).toBeDefined();
    // pA and pB should start within 5ms of each other (truly concurrent).
    expect(Math.abs(pACall!.ts - pBCall!.ts)).toBeLessThan(5);
  });

  test("P0-2.c: graceful throws → force upgrade still runs (not blocked by graceful error)", async () => {
    // Make the graceful stopAllForParent throw. The cascade should
    // catch it (safeStage), finish, and then the queued force stages
    // should still run.
    const { env, callLog } = buildControllableEnv({
      stopAllForParentThrows: true,
      stopAllForParentDelayMs: 30,
      forceStopAllDelayMs: 5,
    });

    const parentId = "pErr";
    const gracefulP = cascadeStopSessionTree(env, parentId, { force: false });
    await new Promise((r) => setTimeout(r, 5));
    const forceP = cascadeStopSessionTree(env, parentId, { force: true });

    const [gracefulR, forceR] = await Promise.all([gracefulP, forceP]);

    // Graceful should report the error in its result.
    expect(gracefulR.errors.length).toBeGreaterThan(0);
    // Force stages must still have been invoked (NOT skipped due to graceful error).
    expect(callLog.some((c) => c.method === "task.forceStopAll")).toBe(true);
    expect(callLog.some((c) => c.method === "workflow.forceStopAll")).toBe(true);
  });

  test("P0-2.d: reentrancy — same key (parent, force=false) coalesces to one execution (regression on P1-#6)", async () => {
    // P1-#6 already established: two calls with the SAME (parent, force) key
    // must coalesce. Verify this still holds after the P0-2 refactor.
    const { env, callLog } = buildControllableEnv({
      stopAllForParentDelayMs: 30,
    });

    const [r1, r2] = await Promise.all([
      cascadeStopSessionTree(env, "pCoalesce", { force: false }),
      cascadeStopSessionTree(env, "pCoalesce", { force: false }),
    ]);

    const stopAllCalls = callLog.filter((c) => c.method === "task.stopAllForParent");
    expect(stopAllCalls.length).toBe(1); // coalesced
    // Both results should reflect the same underlying execution.
    expect(r1.stoppedTaskIds).toEqual(r2.stoppedTaskIds);
  });

  test("P0-2.e: reentrancy — same key (parent, force=true) coalesces (force re-call still honored)", async () => {
    // If the user presses ESC three times rapidly (all within window), the
    // second force call should still trigger force stages. But the third
    // call with the same key should coalesce into the second.
    const { env, callLog } = buildControllableEnv({
      stopAllForParentDelayMs: 30,
      forceStopAllDelayMs: 30,
    });

    const p1 = cascadeStopSessionTree(env, "pTriple", { force: false });
    await new Promise((r) => setTimeout(r, 5));
    const p2 = cascadeStopSessionTree(env, "pTriple", { force: true });
    await new Promise((r) => setTimeout(r, 5));
    // Third call (still within window) — same force key as p2.
    const p3 = cascadeStopSessionTree(env, "pTriple", { force: true });

    await Promise.all([p1, p2, p3]);

    // forceStopAll should be invoked ONCE (p2 and p3 coalesce, and the
    // coalesced force call is satisfied by p1's tail-running force stages).
    const forceCalls = callLog.filter((c) => c.method === "task.forceStopAll");
    expect(forceCalls.length).toBe(1);
  });
});
