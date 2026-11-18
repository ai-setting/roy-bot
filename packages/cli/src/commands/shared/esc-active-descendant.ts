/**
 * @fileoverview ESC active-descendant detection (Task #2255)
 *
 * `handleEscKey()` previously used `if (!isExecuting) return;` to early-exit
 * idle presses. That guard silently dropped presses when the parent session
 * had running delegate_task / workflow_run descendants whose main LLM had
 * already returned — leaving the user with "ESC doesn't do anything" and
 * orphan background processes.
 *
 * `hasActiveDescendants()` provides a cheap, sync check for "is there at
 * least one running background task or active workflow engine session whose
 * parent is `parentSessionId`?". If true, the REPL should treat ESC as a
 * cascade-stop signal even when `isExecuting=false`.
 *
 * Design constraints:
 * - O(1) / O(N) with small N — runs on every keypress.
 * - No DB / no network — must work while stdin is in raw mode.
 * - Tolerant of partial env setup (no task/workflow component → returns false).
 * - Coarse workflow check (engineInstances cache) is acceptable: the actual
 *   `cascadeStopSessionTree` → `stopAllForParent` does precise parent
 *   matching when cascade is invoked.
 */

type EnvLike = {
  getComponent?: (name: string) => unknown;
} | null | undefined;

/**
 * Returns true if there is at least one active background task or active
 * workflow engine session whose parent is `parentSessionId`.
 *
 * @param env - REPL's BaseEnvironment (or test mock). Falsy = no active.
 * @param parentSessionId - The main REPL session id whose tree to inspect.
 */
export function hasActiveDescendants(
  env: EnvLike,
  parentSessionId: string,
): boolean {
  if (!env || !parentSessionId) return false;
  if (typeof env.getComponent !== "function") return false;

  // Background task children (delegate_task, etc.)
  try {
    const taskComp = env.getComponent("task") as
      | {
          getBackgroundTaskManager?: () => {
            hasActiveTaskForParent?: (id: string) => boolean;
          };
          backgroundTaskManager?: {
            hasActiveTaskForParent?: (id: string) => boolean;
          };
        }
      | undefined;
    const mgr =
      taskComp?.getBackgroundTaskManager?.() ??
      (taskComp?.backgroundTaskManager?.hasActiveTaskForParent
        ? taskComp.backgroundTaskManager
        : undefined);
    if (mgr && typeof mgr.hasActiveTaskForParent === "function") {
      if (mgr.hasActiveTaskForParent(parentSessionId)) return true;
    }
  } catch {
    // Component may not be initialized yet; treat as no active.
  }

  // Workflow children (workflow_run from main session or via delegate).
  // Coarse check: any engine with activeSessions > 0 may host a matching
  // session; cascadeStop's stopAllForParent does precise filtering.
  try {
    const wfComp = env.getComponent("workflow") as
      | {
          workflowService?: {
            hasActiveWorkflowForParent?: (id: string) => boolean;
          };
          getService?: () => {
            hasActiveWorkflowForParent?: (id: string) => boolean;
          } | null;
        }
      | undefined;
    const svc =
      wfComp?.workflowService ??
      wfComp?.getService?.() ??
      undefined;
    if (svc && typeof svc.hasActiveWorkflowForParent === "function") {
      if (svc.hasActiveWorkflowForParent(parentSessionId)) return true;
    }
  } catch {
    // Component may not be initialized yet; treat as no active.
  }

  return false;
}