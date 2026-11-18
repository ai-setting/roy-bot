/**
 * @fileoverview SessionTreeStopper.cascadeStopSessionTree TDD tests (Task #2245)
 *
 * 验证编排器正确调 BackgroundTaskManager.stopAllForParent + WorkflowService.stopAllForParent，
 * force=true 时额外 force-kill 全部残留。
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { cascadeStopSessionTree } from "./session-tree-stopper";

describe("SessionTreeStopper.cascadeStopSessionTree (Task #2245)", () => {
  let mockEnv: any;
  let stopAllForParentTaskCalls: Array<{ parent: string }>;
  let stopAllForParentWorkflowCalls: Array<{ parent: string }>;
  let forceStopAllTaskCalls: number;
  let forceStopAllWorkflowCalls: number;

  beforeEach(() => {
    stopAllForParentTaskCalls = [];
    stopAllForParentWorkflowCalls = [];
    forceStopAllTaskCalls = 0;
    forceStopAllWorkflowCalls = 0;

    mockEnv = {
      getComponent: (name: string) => {
        if (name === "task") {
          return {
            backgroundTaskManager: {
              stopAllForParent: async (parent: string) => {
                stopAllForParentTaskCalls.push({ parent });
                return { stoppedTaskIds: ["t1", "t2"] };
              },
              forceStopAll: async () => {
                forceStopAllTaskCalls++;
              },
            },
          };
        }
        if (name === "workflow") {
          return {
            workflowService: {
              stopAllForParent: async (parent: string) => {
                stopAllForParentWorkflowCalls.push({ parent });
                return { stoppedSessionIds: ["wf1"] };
              },
              forceStopAll: async () => {
                forceStopAllWorkflowCalls++;
              },
            },
          };
        }
        return undefined;
      },
    };
  });

  test("AC-3: force=false 调 task.stopAllForParent + workflow.stopAllForParent，不调 force-only 方法", async () => {
    const result = await cascadeStopSessionTree(mockEnv, "main_session_1", { force: false });
    expect(stopAllForParentTaskCalls).toEqual([{ parent: "main_session_1" }]);
    expect(stopAllForParentWorkflowCalls).toEqual([{ parent: "main_session_1" }]);
    expect(forceStopAllTaskCalls).toBe(0);
    expect(forceStopAllWorkflowCalls).toBe(0);
    expect(result.stoppedTaskIds).toEqual(["t1", "t2"]);
    expect(result.stoppedWorkflowSessionIds).toEqual(["wf1"]);
    expect(result.force).toBe(false);
  });

  test("AC-4: force=true 额外调 task.forceStopAll + workflow.forceStopAll", async () => {
    const result = await cascadeStopSessionTree(mockEnv, "main_session_1", { force: true });
    expect(stopAllForParentTaskCalls).toEqual([{ parent: "main_session_1" }]);
    expect(stopAllForParentWorkflowCalls).toEqual([{ parent: "main_session_1" }]);
    expect(forceStopAllTaskCalls).toBe(1);
    expect(forceStopAllWorkflowCalls).toBe(1);
    expect(result.force).toBe(true);
  });

  test("AC-3b: 缺 task/workflow component 时静默 skip（不抛错）", async () => {
    const emptyEnv = { getComponent: () => undefined };
    const result = await cascadeStopSessionTree(emptyEnv, "x", { force: false });
    expect(result.stoppedTaskIds).toEqual([]);
    expect(result.stoppedWorkflowSessionIds).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("AC-4b: force=true 时某个 component 抛错，被 catch 到 errors[]", async () => {
    mockEnv.getComponent = (name: string) => {
      if (name === "task") {
        return {
          backgroundTaskManager: {
            stopAllForParent: async () => ({ stoppedTaskIds: [] }),
            forceStopAll: async () => {
              throw new Error("simulated task force failure");
            },
          },
        };
      }
      return undefined;
    };

    const result = await cascadeStopSessionTree(mockEnv, "main", { force: true });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].stage).toBe("task.forceStopAll");
  });

  test("AC-3c: 编排器先调 task.stopAllForParent 再调 workflow.stopAllForParent（顺序保证）", async () => {
    const callOrder: string[] = [];
    mockEnv.getComponent = (name: string) => {
      if (name === "task") {
        return {
          backgroundTaskManager: {
            stopAllForParent: async () => {
              callOrder.push("task.stopAllForParent");
              return { stoppedTaskIds: [] };
            },
            forceStopAll: async () => {
              callOrder.push("task.forceStopAll");
            },
          },
        };
      }
      if (name === "workflow") {
        return {
          workflowService: {
            stopAllForParent: async () => {
              callOrder.push("workflow.stopAllForParent");
              return { stoppedSessionIds: [] };
            },
            forceStopAll: async () => {
              callOrder.push("workflow.forceStopAll");
            },
          },
        };
      }
      return undefined;
    };

    await cascadeStopSessionTree(mockEnv, "p", { force: true });
    expect(callOrder).toEqual([
      "task.stopAllForParent",
      "workflow.stopAllForParent",
      "task.forceStopAll",
      "workflow.forceStopAll",
    ]);
  });
});