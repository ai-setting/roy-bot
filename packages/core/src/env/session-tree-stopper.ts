/**
 * @fileoverview SessionTreeStopper — single-entry orchestrator for ESC cascade
 * stop across the entire session tree (Task #2245).
 *
 * When the user presses ESC in the REPL, `handleEscKey()` previously only
 * aborted the top-level LLM stream + the top-level agent stream. This left
 * BackgroundTaskManager-spawned sub-sessions, workflow runs (including those
 * started directly by the main session), and agentNode-nested delegates
 * running as orphans.
 *
 * `cascadeStopSessionTree(env, parentSessionId, { force })` is the single
 * entry point that:
 *   1. Calls BackgroundTaskManager.stopAllForParent(parentSessionId) —
 *      stops every background task whose parent matches, including their
 *      attached workflow runs (Task #2144 propagation).
 *   2. Calls WorkflowService.stopAllForParent(parentSessionId) — stops every
 *      workflow session whose parent matches via engine.stop().
 *   3. (force=true only) Calls task.forceStopAll() and
 *      workflow.forceStopAll() — traverses ALL entries (regardless of parent)
 *      to nuke any orphan that graceful path missed.
 *
 * Errors from individual stages are caught and accumulated in `result.errors`
 * so a partial-failure does not block other stages.
 *
 * @module session-tree-stopper
 */

import { wrapFunction } from "./log-trace/decorator";
import { createLogger } from "./log-trace/logger";

const logger = createLogger("SessionTreeStopper");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CascadeStopOptions {
  /**
   * If true, also invoke force-stop variants (`forceStopAll()`) which
   * traverse ALL entries (regardless of parent) to kill residual orphans.
   * Set on second ESC press within 2 seconds.
   */
  force?: boolean;
}

export interface CascadeStopResult {
  /** Background task ids stopped via BackgroundTaskManager.stopAllForParent */
  stoppedTaskIds: string[];
  /** Workflow session ids stopped via WorkflowService.stopAllForParent */
  stoppedWorkflowSessionIds: string[];
  /** Echo of the requested force flag */
  force: boolean;
  /** Per-stage error info for partial-failure visibility */
  errors: Array<{ stage: CascadeStage; error: string; stack?: string }>;
}

// ---------------------------------------------------------------------------
// P1-#9: type-safe CascadeStage enum
// ---------------------------------------------------------------------------

/**
 * P1-#9: Type-safe enum of cascade stop stages. Use this union instead of
 * raw strings when calling or matching against `result.errors[].stage`.
 */
export type CascadeStage =
  | "task.stopAllForParent"
  | "task.forceStopAll"
  | "workflow.stopAllForParent"
  | "workflow.forceStopAll";

// ---------------------------------------------------------------------------
// P1-#6 + P0-2 (Task #2269): reentrancy guard + force upgrade
// ---------------------------------------------------------------------------

/**
 * P1-#6: Module-level in-flight set keyed by `parentSessionId` (single
 * dimension — NOT including `force`). This prevents the P0-2 race where
 * a graceful call (force=false) and a force call (force=true) for the
 * same parent were treated as different keys and ran concurrently.
 *
 * The slot holds an InflightState which tracks the shared Promise and a
 * `forceTriggered` flag. When a new call arrives:
 *  - same parentId + same force: just await the existing Promise (P1-#6)
 *  - same parentId + different force: await the existing Promise; if
 *    the new call has force=true, flip the slot's `forceTriggered` flag
 *    so the existing cascade runs the force stages at the end of its
 *    graceful stages.
 *  - different parentId: create a new InflightState (concurrent OK).
 *
 * After the promise settles, the slot is removed so future calls
 * re-trigger a fresh cascade.
 */
interface InflightState {
  promise: Promise<CascadeStopResult>;
  // Whether the in-flight cascade (or any of its attached callers) has
  // requested force=true. The graceful stages are always run; force
  // stages are appended at the end if this flag becomes true.
  forceTriggered: boolean;
  // Echo of the FIRST call's force flag (drives the final CascadeStopResult.force).
  // All callers receive a result with this value.
  firstCallForce: boolean;
}

const inflightCascades = new Map<string, InflightState>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely invoke a stop stage and accumulate errors instead of propagating.
 * Returns the stage's resolved value (or an empty fallback) and pushes any
 * thrown error into `errors`. P1-#12: preserves `error.stack` so callers
 * can debug without re-throwing.
 */
async function safeStage<T>(
  stage: CascadeStage,
  fn: () => Promise<T>,
  fallback: T,
  errors: Array<{ stage: CascadeStage; error: string; stack?: string }>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    errors.push({ stage, error: msg, stack });
    logger.warn(`[SessionTreeStopper] ${stage} failed: ${msg}`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Internal (untraced) implementation. The exported `cascadeStopSessionTree`
 * below wraps this with `wrapFunction("session.tree.cascadeStop", ...)` so
 * the span_name is stable for cli-e2e-test verification.
 *
 * P1-#6: reentrancy guard — concurrent calls with the same
 * `(parentSessionId, force)` key coalesce to a single in-flight Promise.
 * Different keys run independently.
 */
function cascadeStopSessionTreeImpl(
  env: { getComponent: (name: string) => any } | undefined | null,
  parentSessionId: string,
  opts: CascadeStopOptions = {},
): Promise<CascadeStopResult> {
  const force = !!opts.force;
  if (!parentSessionId) {
    return Promise.resolve({
      stoppedTaskIds: [],
      stoppedWorkflowSessionIds: [],
      force: false,
      errors: [],
    });
  }

  // P0-2 (Task #2269): the reentrancy key is now JUST parentSessionId.
  // If a cascade is already in flight for this parent, attach to it
  // and (when force=true) request an upgrade to run the force stages
  // after the in-flight graceful stages finish. This serializes
  // same-parent operations and prevents the previous race where a
  // concurrent force cascade could double-invoke stopAllForParent.
  const existing = inflightCascades.get(parentSessionId);
  if (existing) {
    if (force) existing.forceTriggered = true;
    return existing.promise;
  }

  // First call for this parent: create the InflightState and start.
  const state: InflightState = {
    promise: undefined as unknown as Promise<CascadeStopResult>, // assigned below
    forceTriggered: force,
    firstCallForce: force,
  };
  state.promise = (async () => {
    const result: CascadeStopResult = {
      stoppedTaskIds: [],
      stoppedWorkflowSessionIds: [],
      force,
      errors: [],
    };

    if (!env) {
      return result;
    }

    // Run the full cascade including force stages if any caller has
    // requested them. The forceTriggered flag may be flipped mid-flight
    // by a later force=true call, so check it at the end.
    return runCascadeStages(env, parentSessionId, state, result);
  })();

  inflightCascades.set(parentSessionId, state);
  // Cleanup after settle (success or failure) so future calls re-trigger.
  state.promise.finally(() => {
    inflightCascades.delete(parentSessionId);
  });
  return state.promise;
}

/**
 * Run all cascade stages in order. Extracted from cascadeStopSessionTreeImpl
 * so the reentrancy guard can wrap a single async expression.
 */
async function runCascadeStages(
  env: { getComponent: (name: string) => any },
  parentSessionId: string,
  state: InflightState,
  result: CascadeStopResult,
): Promise<CascadeStopResult> {
  // Stage 1: BackgroundTaskManager.stopAllForParent (graceful path)
  // Task #2245 — Codex P1-4: use TaskComponent.getBackgroundTaskManager()
  // accessor instead of accessing the private field directly. The accessor
  // returns `BackgroundTaskManager | undefined`; if defined, we know it has
  // `stopAllForParent` method (compile-time enforced).
  const taskResult = await safeStage(
    "task.stopAllForParent",
    async () => {
      const taskComp = env.getComponent?.("task") as
        | {
            getBackgroundTaskManager?: () => {
              stopAllForParent: (id: string) => Promise<{ stoppedTaskIds: string[] }>;
            };
            // Legacy: pre-P1-4 components expose backgroundTaskManager directly
            // without the typed accessor. We fall back to this path so old
            // mock env objects (used in unit tests) still work.
            backgroundTaskManager?: {
              stopAllForParent?: (id: string) => Promise<{ stoppedTaskIds: string[] }>;
            };
          }
        | undefined;
      // Task #2245 — Codex P1-4: prefer typed accessor; fall back to
      // legacy direct field access for backward compat with mock envs.
      const legacyMgr = taskComp?.backgroundTaskManager;
      const mgr =
        taskComp?.getBackgroundTaskManager?.() ??
        (legacyMgr?.stopAllForParent ? legacyMgr : undefined);
      if (!mgr || typeof mgr.stopAllForParent !== "function") {
        return { stoppedTaskIds: [] as string[] };
      }
      return await mgr.stopAllForParent(parentSessionId);
    },
    { stoppedTaskIds: [] as string[] },
    result.errors,
  );
  result.stoppedTaskIds = taskResult.stoppedTaskIds ?? [];

  // Stage 2: WorkflowService.stopAllForParent (graceful path)
  const workflowResult = await safeStage(
    "workflow.stopAllForParent",
    async () => {
      const workflowComp = env.getComponent?.("workflow") as
        | {
            workflowService?: {
              stopAllForParent?: (
                id: string,
              ) => Promise<{
                stoppedSessionIds: string[];
                errors?: Array<{ sessionId: string; error: string; stack?: string }>;
              }>;
            };
          }
        | undefined;
      const svc = workflowComp?.workflowService;
      if (!svc || typeof svc.stopAllForParent !== "function") {
        return { stoppedSessionIds: [] as string[] };
      }
      return await svc.stopAllForParent(parentSessionId);
    },
    { stoppedSessionIds: [] as string[] },
    result.errors,
  );
  result.stoppedWorkflowSessionIds = workflowResult.stoppedSessionIds ?? [];
  // P1-#7: surface per-item errors from workflow.stopAllForParent in
  // the cascade result, so callers can audit which sessions failed to stop.
  if (Array.isArray(workflowResult.errors)) {
    for (const e of workflowResult.errors) {
      result.errors.push({
        stage: "workflow.stopAllForParent",
        error: `${e.sessionId}: ${e.error}`,
        stack: e.stack,
      });
    }
  }

  // Stage 3 & 4: Force-stop variants (only if force was triggered by
  // ANY caller — P0-2: a later force=true call upgrades the cascade by
  // setting state.forceTriggered, so we check the flag here, not the
  // firstCallForce value).
  if (state.forceTriggered) {
    result.force = state.firstCallForce || true;
    await safeStage(
      "task.forceStopAll",
      async () => {
        const taskComp = env.getComponent?.("task") as
          | { backgroundTaskManager?: { forceStopAll?: () => Promise<void> } }
          | undefined;
        const mgr = taskComp?.backgroundTaskManager;
        if (!mgr || typeof mgr.forceStopAll !== "function") return;
        await mgr.forceStopAll();
      },
      undefined,
      result.errors,
    );

    await safeStage(
      "workflow.forceStopAll",
      async () => {
        const workflowComp = env.getComponent?.("workflow") as
          | { workflowService?: { forceStopAll?: () => Promise<void> } }
          | undefined;
        const svc = workflowComp?.workflowService;
        if (!svc || typeof svc.forceStopAll !== "function") return;
        await svc.forceStopAll();
      },
      undefined,
      result.errors,
    );
  }

  return result;
}

/**
 * Cascade stop the entire session tree rooted at `parentSessionId`.
 *
 * @param env - BaseEnvironment-like object exposing `getComponent(name)`.
 *              Reads `task.backgroundTaskManager` and
 *              `workflow.workflowService` if available; missing components are
 *              silently skipped (no error thrown).
 * @param parentSessionId - The session id whose tree should be stopped
 *              (typically the main REPL session id).
 * @param opts - `{ force: false }` by default; `{ force: true }` invokes
 *              force-stop variants in addition to graceful stop.
 */
export const cascadeStopSessionTree = wrapFunction(
  cascadeStopSessionTreeImpl,
  "session.tree.cascadeStop",
  {
    recordParams: true,
    recordResult: true,
    log: true,
  },
);