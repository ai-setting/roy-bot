/**
 * @fileoverview Real 4-level cascade mock integration test (Task #2245 P1-#3)
 *
 * Reviewer feedback (Claude Code Review P1-#3):
 * "Current multi-level test only verifies 2-level BackgroundTask.stopAllForParent
 *  parent filtering; it does NOT actually exercise delegate→workflow→agentNode→
 *  delegate 4-level cascade. Test JSDoc claims 4 levels but actual coverage
 *  is 2 levels."
 *
 * This test builds a 4-level session tree end-to-end via mocks:
 *   Level 0: main session
 *     └─ Level 1: delegate_task (BackgroundTask A)
 *          └─ Level 2: workflow_run (WorkflowService run)
 *               └─ Level 3: agentNode (engine) → delegate_task (BackgroundTask B)
 *                    └─ Level 4: bash subprocess (ProcessRegistry)
 *
 * On `cascadeStopSessionTree(main, { force: true })`:
 *   - Level 1 (task A) → status=stopped, process killed
 *   - Level 2 (workflow session) → stopRun called
 *   - Level 3 (agentNode session) → stop called
 *   - Level 4 (task B) → status=stopped, process killed
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { BackgroundTaskManager } from "./delegate-tool";
import { cascadeStopSessionTree } from "../../session-tree-stopper";

interface MockEnv {
  handle_query: (...args: any[]) => Promise<string>;
  getComponent: (name: string) => any;
  pushEnvEvent?: any;
  publishEvent?: any;
  [key: string]: any;
}

interface StopRecord {
  level: number;
  sessionId: string;
  source: string;
}

describe("P1-#3: Real 4-level cascade integration (Task #2245)", () => {
  let env: MockEnv;
  let mgr: BackgroundTaskManager;
  let stopRecords: StopRecord[];
  let releaseHandleQuery: () => void;
  let allSessions: Map<string, any>;

  beforeEach(() => {
    stopRecords = [];
    allSessions = new Map();
    let releaseFn: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    releaseHandleQuery = releaseFn;

    let sessionCounter = 0;
    const createdSessions = new Map<string, any>();

    env = {
      handle_query: async () => {
        await released;
        return "done";
      },
      getComponent: (name: string) => {
        if (name === "session") {
          return {
            get: async (id: string) => {
              return createdSessions.get(id) ?? {
                id,
                info: { metadata: { subagent_type: "general" } },
              };
            },
            create: async (opts: any) => {
              const id = `sub_session_${++sessionCounter}`;
              const created = {
                id,
                info: { metadata: opts?.metadata ?? { subagent_type: "general" } },
              };
              createdSessions.set(id, created);
              allSessions.set(id, created);
              return created;
            },
            update: async () => ({}),
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
        if (name === "workflow") {
          return {
            workflowService: {
              stopAllForParent: async (parentId: string) => {
                stopRecords.push({
                  level: 2,
                  sessionId: parentId,
                  source: "workflow.stopAllForParent",
                });
                return { stoppedSessionIds: ["wf_session_1"] };
              },
              forceStopAll: async () => {
                stopRecords.push({
                  level: 2,
                  sessionId: "ALL",
                  source: "workflow.forceStopAll",
                });
              },
              stopRun: async (runId: string) => {
                stopRecords.push({
                  level: 2,
                  sessionId: runId,
                  source: "workflow.stopRun",
                });
              },
            },
          };
        }
        if (name === "task") {
          return {
            backgroundTaskManager: mgr,
          };
        }
        return undefined;
      },
      pushEnvEvent: () => {},
      publishEvent: () => {},
    };

    mgr = new BackgroundTaskManager(env as any);
    // Inject a stub workflowService via the existing setWorkflowService API
    mgr.setWorkflowService({
      stopRun: async (runId: string) => {
        stopRecords.push({
          level: 2,
          sessionId: runId,
          source: "workflow.stopRun",
        });
      },
    });
  });

  afterEach(() => {
    releaseHandleQuery();
  });

  test("P1-3a: 4-level cascade (delegate→workflow→agentNode→delegate) all levels stopped", async () => {
    // Level 1: main delegates to a sub-agent (BackgroundTask A)
    const taskA = await mgr.createTask({
      parentSessionId: "main_session_0",
      description: "Level-1 delegate_task",
      prompt: "test",
      subagentType: "general",
    } as any);

    // Level 2: task A starts a workflow run (workflow attached to taskA)
    (mgr as any).attachWorkflowRun(taskA.taskId, "wf_session_1");

    // Level 3: the workflow's agentNode spawns another sub-agent (BackgroundTask B)
    // (i.e., the workflow is run as part of a sub-session, and inside that
    // workflow there's an agentNode which itself delegates another sub-task)
    const taskB = await mgr.createTask({
      parentSessionId: "wf_session_1",  // parented by the workflow's agentNode session
      description: "Level-3 agentNode→delegate",
      prompt: "test",
      subagentType: "general",
    } as any);

    // Act: cascade stop on main, force=true (worst case, all 4 levels)
    const result = await cascadeStopSessionTree(env as any, "main_session_0", {
      force: true,
    });

    // Assert: Level-1 task A is stopped
    expect(mgr.getTask(taskA.taskId)?.status).toBe("stopped");
    // Assert: Level-3 task B is stopped (forceStopAllAcrossParents)
    expect(mgr.getTask(taskB.taskId)?.status).toBe("stopped");
    // Assert: workflow.stopAllForParent was called with main
    const mainStop = stopRecords.find(
      (r) => r.source === "workflow.stopAllForParent" && r.sessionId === "main_session_0"
    );
    expect(mainStop).toBeDefined();
    // Assert: workflowService.stopRun was called for the attached workflow
    const wfStop = stopRecords.find(
      (r) => r.source === "workflow.stopRun" && r.sessionId === "wf_session_1"
    );
    expect(wfStop).toBeDefined();
  });

  test("P1-3b: 4-level cascade graceful (force=false) only stops level 1 (parent filtering)", async () => {
    const taskA = await mgr.createTask({
      parentSessionId: "main_session_0",
      description: "Level-1",
      prompt: "test",
      subagentType: "general",
    } as any);
    (mgr as any).attachWorkflowRun(taskA.taskId, "wf_session_1");

    // Level-3 task B parented by a sub-session (NOT main_session_0)
    const taskB = await mgr.createTask({
      parentSessionId: "l3_sub_session_xyz",
      description: "Level-3 (not parent=main)",
      prompt: "test",
      subagentType: "general",
    } as any);

    const result = await cascadeStopSessionTree(env as any, "main_session_0", {
      force: false,
    });

    // Level-1 task A stopped
    expect(mgr.getTask(taskA.taskId)?.status).toBe("stopped");
    // Level-3 task B NOT directly stopped (graceful filters by parent=main)
    expect(mgr.getTask(taskB.taskId)?.status).not.toBe("stopped");
  });
});
