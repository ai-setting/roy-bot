/**
 * @fileoverview Tests for hasActiveDescendants helper (Task #2255)
 *
 * The helper is the gate that lets REPL.handleEscKey() cascade-stop the
 * session tree even when the main LLM is idle (isExecuting=false) but a
 * delegate_task child or direct workflow_run is still running.
 *
 * Coverage:
 * - Falsy env / missing getComponent → false
 * - No parentSessionId → false
 * - Active background task for parent → true
 * - Active workflow session for parent → true
 * - Both active → true (deduped by OR)
 * - None active → false
 * - Component throws → false (defensive)
 */

import { describe, test, expect, mock } from "bun:test";
import { hasActiveDescendants } from "./esc-active-descendant";

describe("hasActiveDescendants (Task #2255)", () => {
  test("null env → false", () => {
    expect(hasActiveDescendants(null, "main")).toBe(false);
    expect(hasActiveDescendants(undefined, "main")).toBe(false);
  });

  test("env without getComponent → false", () => {
    expect(hasActiveDescendants({}, "main")).toBe(false);
    expect(hasActiveDescendants({ getComponent: undefined as any }, "main")).toBe(false);
  });

  test("empty parentSessionId → false", () => {
    const env = { getComponent: mock(() => ({})) };
    expect(hasActiveDescendants(env, "")).toBe(false);
  });

  test("active background task for parent → true (via typed accessor)", () => {
    const mgr = {
      hasActiveTaskForParent: mock((p: string) => p === "main"),
    };
    const env = {
      getComponent: mock((name: string) => {
        if (name === "task") {
          return { getBackgroundTaskManager: () => mgr };
        }
        return undefined;
      }),
    };
    expect(hasActiveDescendants(env, "main")).toBe(true);
    expect(mgr.hasActiveTaskForParent).toHaveBeenCalledWith("main");
  });

  test("active background task for parent → true (via legacy field)", () => {
    const mgr = {
      hasActiveTaskForParent: mock((p: string) => p === "main"),
    };
    const env = {
      getComponent: mock((name: string) => {
        if (name === "task") {
          return {
            getBackgroundTaskManager: undefined as any,
            backgroundTaskManager: mgr,
          };
        }
        return undefined;
      }),
    };
    expect(hasActiveDescendants(env, "main")).toBe(true);
  });

  test("active workflow session for parent → true", () => {
    const svc = {
      hasActiveWorkflowForParent: mock((p: string) => p === "main"),
    };
    const env = {
      getComponent: mock((name: string) => {
        if (name === "workflow") {
          return { workflowService: svc };
        }
        return undefined;
      }),
    };
    expect(hasActiveDescendants(env, "main")).toBe(true);
  });

  test("workflow via getService() fallback → true", () => {
    const svc = {
      hasActiveWorkflowForParent: mock((p: string) => p === "main"),
    };
    const env = {
      getComponent: mock((name: string) => {
        if (name === "workflow") {
          return {
            workflowService: undefined,
            getService: () => svc,
          };
        }
        return undefined;
      }),
    };
    expect(hasActiveDescendants(env, "main")).toBe(true);
  });

  test("no active descendant → false", () => {
    const mgr = { hasActiveTaskForParent: mock(() => false) };
    const svc = { hasActiveWorkflowForParent: mock(() => false) };
    const env = {
      getComponent: mock((name: string) => {
        if (name === "task") return { getBackgroundTaskManager: () => mgr };
        if (name === "workflow") return { workflowService: svc };
        return undefined;
      }),
    };
    expect(hasActiveDescendants(env, "main")).toBe(false);
  });

  test("component throws → false (defensive)", () => {
    const env = {
      getComponent: mock((name: string) => {
        if (name === "task") {
          return {
            getBackgroundTaskManager: () => {
              throw new Error("init not ready");
            },
          };
        }
        return undefined;
      }),
    };
    expect(hasActiveDescendants(env, "main")).toBe(false);
  });

  test("OR semantics: bg active OR wf active → true (even if other side is false)", () => {
    const env = {
      getComponent: mock((name: string) => {
        if (name === "task") {
          return {
            getBackgroundTaskManager: () => ({
              hasActiveTaskForParent: () => true,
            }),
          };
        }
        if (name === "workflow") {
          return {
            workflowService: {
              hasActiveWorkflowForParent: () => false,
            },
          };
        }
        return undefined;
      }),
    };
    expect(hasActiveDescendants(env, "main")).toBe(true);
  });
});