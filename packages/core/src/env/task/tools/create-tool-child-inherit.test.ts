/**
 * @fileoverview task_create child-context inheritance integration test
 *                 (Task #2395).
 *
 * Verifies that when `task_create` is called with `parent_task_id`, the new
 * task automatically inherits spatial fields from the parent via the
 * `inheritChildContext` helper:
 *   - project_path: inherited unless overridden
 *   - context.worktree_path / branch / parent_branch: merged in (caller wins)
 *   - prior_context.commit: stripped (security)
 *   - created_at: re-injected by task_create's own auto-detection logic
 *
 * The tests build a real TaskComponent (with SQLite store) so the full
 * create-flow (including hooks) runs end-to-end.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskTool } from "./create-tool";
import type { Tool, ToolContext } from "../../tool/types";

interface CapturedTask {
  id: number;
  title: string;
  parent_task_id?: number;
  project_path: string;
  context: string;
  tags: string[];
}

function makeCtx(): ToolContext {
  return { session_id: "test-session-2395" } as ToolContext;
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

describe("task_create child-context inheritance (Task #2395)", () => {
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
              `task-create-child-inherit-${Date.now()}-${Math.random()}.db`
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

  async function callCreate(args: Record<string, unknown>): Promise<CapturedTask> {
    const result = await tool.execute(args, makeCtx());
    if (!result.success) {
      throw new Error(`create failed: ${result.error ?? "unknown"}`);
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
  }

  test("inherits project_path from parent when caller omits it", async () => {
    const parent = await callCreate({
      title: "design X",
      project_path: "/repo/parent",
      context: JSON.stringify({
        worktree_path: "/repo/parent/.worktrees/feat-x",
        branch: "feat/x",
        parent_branch: "main",
        type: "feature",
      }),
    });

    const child = await callCreate({
      title: "child bug fix",
      parent_task_id: parent.id,
      project_path: "", // empty string → use inherited
      context: "{}",
    });
    expect(child.project_path).toBe("/repo/parent");
  });

  test("preserves caller's explicit project_path over parent", async () => {
    const parent = await callCreate({
      title: "design X",
      project_path: "/repo/parent",
      context: "{}",
    });
    const child = await callCreate({
      title: "child in different repo",
      parent_task_id: parent.id,
      project_path: "/repo/override",
      context: "{}",
    });
    expect(child.project_path).toBe("/repo/override");
  });

  test("merges parent context.worktree_path / branch / parent_branch into child", async () => {
    const parent = await callCreate({
      title: "design X",
      project_path: "/repo/parent",
      context: JSON.stringify({
        worktree_path: "/repo/parent/.worktrees/feat-x",
        branch: "feat/x",
        parent_branch: "main",
        type: "feature",
      }),
    });
    const child = await callCreate({
      title: "child",
      parent_task_id: parent.id,
      project_path: "",
      context: JSON.stringify({ custom_key: "caller-value" }),
    });
    const obj = safeParse(child.context);
    expect(obj.worktree_path).toBe("/repo/parent/.worktrees/feat-x");
    expect(obj.branch).toBe("feat/x");
    expect(obj.parent_branch).toBe("main");
    expect(obj.type).toBe("feature");
    expect(obj.custom_key).toBe("caller-value"); // caller preserved
  });

  test("strips parent prior_context.commit from child context (security)", async () => {
    const parent = await callCreate({
      title: "design X",
      project_path: "/repo/parent",
      context: JSON.stringify({
        branch: "feat/x",
        prior_context: { prev_task: 99, commit: "secret-commit-sha" },
      }),
    });
    const child = await callCreate({
      title: "child",
      parent_task_id: parent.id,
      project_path: "",
      context: "{}",
    });
    const obj = safeParse(child.context);
    const pc = obj.prior_context as Record<string, unknown> | undefined;
    expect(pc).toBeDefined();
    expect(pc!.commit).toBeUndefined();
    expect(pc!.prev_task).toBe(99);
  });

  test("does NOT inherit tags by default; caller can pass own", async () => {
    const parent = await callCreate({
      title: "design X",
      project_path: "/repo/parent",
      context: "{}",
      tags: ["feature-x", "v0.7.0"],
    });
    const child = await callCreate({
      title: "child",
      parent_task_id: parent.id,
      project_path: "",
      context: "{}",
      tags: ["child-bug"],
    });
    expect(child.tags).toEqual(["child-bug"]);
  });

  test("root task creation (no parent_task_id) is unaffected by inheritance logic", async () => {
    const root = await callCreate({
      title: "root",
      project_path: "/repo/root",
      context: JSON.stringify({ type: "feature" }),
    });
    expect(root.parent_task_id).toBeUndefined();
    expect(root.project_path).toBe("/repo/root");
    const obj = safeParse(root.context);
    expect(obj.type).toBe("feature");
  });

  test("parent_task_id round-trip: child.parent_task_id === parent.id after save", async () => {
    const parent = await callCreate({
      title: "design X",
      project_path: "/repo/parent",
      context: "{}",
    });
    const child = await callCreate({
      title: "child",
      parent_task_id: parent.id,
      project_path: "",
      context: "{}",
    });
    expect(child.parent_task_id).toBe(parent.id);
    expect(child.id).not.toBe(parent.id);
  });
});