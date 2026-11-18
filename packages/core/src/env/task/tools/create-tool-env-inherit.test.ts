/**
 * @fileoverview task_create EnvContext.parentTaskId inheritance test
 *                 (Task #4023).
 *
 * Verifies that when `task_create` is called from inside a per-task group
 * chat, the chat-binding injected into `EnvContext.parentTaskId` is used
 * as the default `parent_task_id`:
 *
 *   1. env context has parentTaskId, caller omits → task.parent_task_id === env.parentTaskId
 *   2. env context has parentTaskId, caller passes its own → caller's wins
 *   3. env context has no parentTaskId (undefined), caller omits → root task
 *   4. env context has parentTaskId but parent doesn't exist → fail-fast (don't silently create orphan)
 *
 * Backward compatible: no env context + no parent_task_id → root task (same as before).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskTool } from "./create-tool";
import type { Tool, ToolContext } from "../../tool/types";
import {
  createEnvContext,
  runWithEnvContextAsync,
  type EnvContext,
} from "../../context/env-context";

interface CapturedTask {
  id: number;
  title: string;
  parent_task_id?: number;
  project_path: string;
  context: string;
  tags: string[];
}

function makeCtx(): ToolContext {
  return { session_id: "test-session-4023" } as ToolContext;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

describe("task_create EnvContext.parentTaskId inheritance (Task #4023)", () => {
  let taskComponent: TaskComponent;
  let tool: Tool;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(
              tmpdir(),
              `task-create-env-inherit-${Date.now()}-${Math.random()}.db`
            ),
          },
        },
      },
    } as any);
    tool = createTaskTool(taskComponent);
  });

  afterEach(async () => {
    await taskComponent.stop();
  });

  /**
   * Helper: run a tool.execute() inside an EnvContext that has parentTaskId set.
   * Lets each test control the env context shape explicitly.
   */
  async function callCreateInEnv(
    parentTaskId: number | undefined,
    args: Record<string, unknown>
  ): Promise<CapturedTask> {
    const envContext: EnvContext = createEnvContext({
      envEvent: {},
      sourceId: "es-test-4023",
      userId: "ou_test",
      parentTaskId,
    });

    return runWithEnvContextAsync(envContext, async () => {
      const result = await tool.execute(args, makeCtx());
      if (!result.success) {
        throw new Error(
          `create failed: ${result.error ?? "unknown"} (output=${result.output ?? ""})`
        );
      }
      const metadata = result.metadata as unknown as { task_id: number };
      const taskId = metadata.task_id;
      const task = await taskComponent.getTask(taskId);
      if (!task) throw new Error(`task #${taskId} not found after creation`);
      return {
        id: task.id,
        title: task.title,
        parent_task_id: task.parent_task_id,
        project_path: task.project_path,
        context: task.context ?? "{}",
        tags: task.tags ?? [],
      };
    });
  }

  test("Scenario A: env parentTaskId present, caller omits → task inherits env parent", async () => {
    const parent = await callCreateInEnv(undefined, {
      title: "design X",
      project_path: "/repo/parent",
      context: "{}",
    });

    // Now invoke inside an env that binds to that parent
    const child = await callCreateInEnv(parent.id, {
      title: "child inside group chat",
      project_path: "/repo/child",
      context: "{}",
    });

    expect(child.parent_task_id).toBe(parent.id);
    // project_path was explicit so it wins
    expect(child.project_path).toBe("/repo/child");
  });

  test("Scenario B: env parentTaskId present, caller passes its own → caller's wins", async () => {
    const envParent = await callCreateInEnv(undefined, {
      title: "env-bound task",
      project_path: "/repo/env-parent",
      context: "{}",
    });
    const explicitParent = await callCreateInEnv(undefined, {
      title: "explicitly chosen parent",
      project_path: "/repo/explicit-parent",
      context: "{}",
    });

    const child = await callCreateInEnv(envParent.id, {
      title: "child with caller-supplied parent",
      parent_task_id: explicitParent.id,
      project_path: "/repo/child",
      context: "{}",
    });

    // Caller's explicit parent_task_id wins over env binding
    expect(child.parent_task_id).toBe(explicitParent.id);
    expect(child.parent_task_id).not.toBe(envParent.id);
  });

  test("Scenario C: env parentTaskId undefined, caller omits → root task", async () => {
    const root = await callCreateInEnv(undefined, {
      title: "root task",
      project_path: "/repo/root",
      context: JSON.stringify({ type: "feature" }),
    });

    expect(root.parent_task_id).toBeUndefined();
    expect(root.project_path).toBe("/repo/root");
    const obj = safeParse(root.context);
    expect(obj.type).toBe("feature");
  });

  test("Scenario D: env parentTaskId points to non-existent task → create fails (no orphan)", async () => {
    let capturedError: Error | undefined;
    try {
      await callCreateInEnv(999_999_999, {
        title: "orphan attempt",
        project_path: "/repo/orphan",
        context: "{}",
      });
    } catch (err) {
      capturedError = err as Error;
    }
    expect(capturedError).toBeDefined();
    // The error must mention parent_task_id or non-existence — we don't pin
    // exact wording (taskComponent.createTask owns it), but it must NOT be silent.
    expect(capturedError!.message.length).toBeGreaterThan(0);
  });

  test("Scenario E: env parentTaskId = 0 (falsy) → NOT inherited (treat as missing)", async () => {
    // parentTaskId === 0 is invalid (task ids are positive). Tool should
    // NOT silently bind to "0"; treat as missing.
    const root = await callCreateInEnv(0 as unknown as undefined, {
      title: "zero env parent",
      project_path: "/repo/zero",
      context: "{}",
    });

    expect(root.parent_task_id).toBeUndefined();
  });
});
