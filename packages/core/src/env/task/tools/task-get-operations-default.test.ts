/**
 * Task #4619 — RED test: `task_get` must keep returning the task's operation
 * records by default.
 *
 * ## The regression this pins
 *
 * The old plugin's `bridge.mjs` implemented `task_get` as:
 *
 * ```js
 * const ops = db.prepare("SELECT * FROM task_operation WHERE task_id = ? ORDER BY id ASC").all(id);
 * return { ...task, operations: ops };
 * ```
 *
 * — i.e. **unconditionally**. The old advertised catalogue for `task_get`
 * had exactly one property (`id`); there was no `include_operations` flag at
 * all, so a client had no way to ask for "the task without operations".
 *
 * When the plugin was thinned down to roy's real schemas (Task #4619), the
 * response became roy's own: `include_operations` defaults to `false`, so
 * the operations silently vanished from the response. Every client written
 * against the published plugin lost its milestones **with no error at all** —
 * exactly the class of silent break this task exists to eliminate.
 *
 * ## The fix
 *
 * `include_operations` now defaults to **true**: the richer response is the
 * compatible one. Passing `include_operations: false` still opts out, so
 * callers that want the lean shape can ask for it explicitly.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { getTaskTool } from "./get-tool";
import { createOperationTool } from "./operation/create-tool";
import type { Tool, ToolContext } from "../../tool/types";

function makeCtx(): ToolContext {
  return { session_id: "test-session-4619" } as ToolContext;
}

describe("Task #4619: task_get returns operations by default", () => {
  let taskComponent: TaskComponent;
  let getTool: Tool;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `task-get-ops-${Date.now()}-${Math.random()}.db`),
          },
        },
      },
    } as any);
    getTool = getTaskTool(taskComponent);
  });

  afterEach(async () => {
    await taskComponent.stop();
  });

  test("a task with an operation record returns that record by default", async () => {
    // Create a task through the store.
    const created = await taskComponent.createTask({
      title: "parent task",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess-4619",
    });
    expect(created).toBeDefined();

    // Attach one operation (milestone) to it.
    const opTool = createOperationTool(taskComponent);
    const opResult = await opTool.execute(
      {
        task_id: created!.id,
        milestone_type: "progress",
        milestone_title: "第一步完成",
        milestone_description: "已经完成了第一步",
        process_description:
          "先读源码定位 task_get 的入口与 operations 查询路径，确认 include_operations 默认值语义；再改 schema 让默认值与旧插件契约一致；最后补端到端单测验证默认返回 operation 记录，并跑全量回归确认没有引入新的失败。",
      },
      makeCtx(),
    );
    expect(opResult.success).toBe(true);

    // `task_get` WITHOUT any arguments beyond the id must still carry the
    // operations — that is what the old plugin did unconditionally.
    const result = await getTool.execute({ task_id: created!.id }, makeCtx());
    expect(result.success).toBe(true);

    const payload = JSON.parse(result.output as string);
    expect(payload.operations).toBeDefined();
    expect(Array.isArray(payload.operations)).toBe(true);
    // Creating a task auto-records a "create" operation, so the task now
    // carries 2 records: the auto "create" one and the milestone we added.
    expect(payload.operations.length).toBe(2);
    const titles = payload.operations.map((o: { milestoneTitle?: string }) => o.milestoneTitle);
    expect(titles).toContain("第一步完成");
  });

  test("include_operations: false still opts out (the lean shape stays reachable)", async () => {
    const created = await taskComponent.createTask({
      title: "parent task",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess-4619",
    });

    const result = await getTool.execute(
      { task_id: created!.id, include_operations: false },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output as string);
    expect(payload.id).toBe(created!.id);
    // The lean shape must not carry an operations array.
    expect(payload.operations).toBeUndefined();
  });

  test("the legacy `id` alias also returns operations", async () => {
    const created = await taskComponent.createTask({
      title: "parent task",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess-4619",
    });
    const opTool = createOperationTool(taskComponent);
    await opTool.execute(
      {
        task_id: created!.id,
        milestone_type: "progress",
        milestone_title: "里程碑",
        milestone_description: "描述",
        process_description:
          "先读源码定位 task_get 的入口与 operations 查询路径，确认 include_operations 默认值语义；再改 schema 让默认值与旧插件契约一致；最后补端到端单测验证默认返回 operation 记录，并跑全量回归确认没有引入新的失败。",
      },
      makeCtx(),
    );

    const result = await getTool.execute({ id: created!.id }, makeCtx());
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output as string);
    expect(payload.operations).toBeDefined();
    // 2 = the auto-recorded "create" operation + the milestone we added.
    expect(payload.operations.length).toBe(2);
  });
});
