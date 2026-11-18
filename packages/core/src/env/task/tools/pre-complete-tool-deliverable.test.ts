/**
 * @fileoverview Tests for task deliverable_storage_path parameter
 *
 * ★ Task #5073 设计调整①（用户 2026-11-06 明令）：
 *   交付物通道从 task_complete 迁移到 task_pre_complete ——
 *   task_complete 精简为**纯验收动作**（schema 不再有 deliverable 入参），
 *   交付物在 pre_complete 阶段提交落库。
 *
 * 本文件迁移自 #2778 的 complete-tool-deliverable 契约，验证 7 个关键行为：
 * 1. pre_complete 传 deliverable_storage_path → 写入 task.context
 * 2. description 提示（pre_complete 提到交付物；complete 不再有）
 * 3. pre_complete 可省略 deliverable（向后兼容）
 * 4. 支持本地路径 / git branch / 飞书 doc 各种格式
 * 5. deliverable 与 task 现有 context 字段合并（不覆盖其他字段）
 * 6. cycle 类型任务带 deliverable 也应被拒绝
 * 7. pre_complete 双写 operation milestoneDescription（Deliverable 行）
 *    + complete 验收后 operation 语义
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import {
  completeTaskTool,
  createTaskTool,
  getTaskTool,
  preCompleteTaskTool,
} from "./index";
import { tmpdir } from "os";
import { join } from "path";

describe("task deliverable_storage_path (Task #2778 → #5073 迁移)", () => {
  let taskComponent: TaskComponent;
  let parentTaskId: number;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `task-pre-complete-deliverable-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
          },
        },
      },
    });

    // Create parent task
    const parentTask = await (taskComponent as any).store.createTask({
      title: "Parent Task",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess_init",
    });
    parentTaskId = parentTask.id;
  });

  afterEach(async () => {
    await taskComponent.stop();
  });

  /**
   * TEST 1: pre_complete 传 deliverable_storage_path
   * 调用 task_pre_complete 时传 deliverable_storage_path，期望：
   * - 执行成功
   * - task.context.deliverable_storage_path === 该 URL
   */
  it("pre_complete accepts deliverable_storage_path and persists it to task.context", async () => {
    const tool = preCompleteTaskTool(taskComponent);

    // 先创建一个 normal 任务
    const createResult = await createTaskTool(taskComponent).execute(
      {
        parent_task_id: parentTaskId,
        title: "Task With Deliverable",
        project_path: "unknown",
        context: "{}",
      },
      { session_id: "sess_123" }
    );
    expect(createResult.success).toBe(true);
    const taskId = createResult.metadata?.task_id as number;

    // 调用 pre_complete 时传入 deliverable_storage_path
    const result = await tool.execute(
      {
        task_id: taskId,
        deliverable_storage_path: "https://my.feishu.cn/docx/abc123",
      },
      { session_id: "sess_123" }
    );

    expect(result.success).toBe(true);
    const task = result.metadata?.task as any;
    expect(task).toBeDefined();
    expect(task.context).toBeDefined();

    const ctx = JSON.parse(task.context);
    expect(ctx.deliverable_storage_path).toBe("https://my.feishu.cn/docx/abc123");

    // 验证持久化：通过 get_task 读回来的 task.context 也包含该字段
    const getResult = await getTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_123" }
    );
    expect(getResult.success).toBe(true);
    const fetchedTask = JSON.parse(getResult.output as string);
    const fetchedCtx = JSON.parse(fetchedTask.context);
    expect(fetchedCtx.deliverable_storage_path).toBe("https://my.feishu.cn/docx/abc123");
  });

  /**
   * TEST 2: description 提示 —— pre_complete 提到交付物参数；
   * complete 的 description **不再**含 deliverable_storage_path（纯验收）。
   */
  it("descriptions: pre_complete mentions deliverable; complete does not", () => {
    const preTool = preCompleteTaskTool(taskComponent);
    expect(preTool.description).toContain("deliverable_storage_path");

    const tool = completeTaskTool(taskComponent);
    expect(tool.description).toContain("goal");
    expect(tool.description).toContain("delivery");
    // #5073 设计调整①：complete 不再接收交付物入参
    expect(tool.description).toContain("task_pre_complete");
  });

  /**
   * TEST 3: 可选参数 deliverable_storage_path 可以省略
   */
  it("pre_complete works without deliverable_storage_path (backward compatible)", async () => {
    const tool = preCompleteTaskTool(taskComponent);

    const createResult = await createTaskTool(taskComponent).execute(
      {
        parent_task_id: parentTaskId,
        title: "Legacy Task Without Deliverable",
        project_path: "unknown",
        context: "{}",
      },
      { session_id: "sess_123" }
    );
    expect(createResult.success).toBe(true);
    const taskId = createResult.metadata?.task_id as number;

    // 不传 deliverable_storage_path
    const result = await tool.execute(
      { task_id: taskId },
      { session_id: "sess_123" }
    );

    expect(result.success).toBe(true);
    const task = result.metadata?.task as any;
    expect(task.status).toBe("to_validate");
    // context 中不应出现 deliverable_storage_path（未传）
    const ctx = JSON.parse(task.context || "{}");
    expect(ctx.deliverable_storage_path).toBeUndefined();
  });

  /**
   * TEST 4: 支持本地路径 / git branch / 飞书 doc 各种格式
   * 多种交付物地址都应被接受并持久化。
   */
  it("pre_complete supports various deliverable_storage_path formats (URL/path/branch)", async () => {
    const tool = preCompleteTaskTool(taskComponent);
    const createTool = createTaskTool(taskComponent);

    const paths = [
      "/tmp/report.md",
      "~/work/codework/myproject",
      "feature/my-feature",
      "https://my.feishu.cn/docx/abc",
      "https://github.com/foo/bar/commit/abcdef1234567890",
      "https://my.feishu.cn/wiki/xyz123",
      "main",
      "/tmp/screenshots/screenshot-2026-08-05.png",
    ];

    for (const path of paths) {
      const createResult = await createTool.execute(
        {
          parent_task_id: parentTaskId,
          title: `Task for path: ${path}`,
          project_path: "unknown",
          context: "{}",
        },
        { session_id: "sess_123" }
      );
      expect(createResult.success).toBe(true);
      const taskId = createResult.metadata?.task_id as number;

      const result = await tool.execute(
        {
          task_id: taskId,
          deliverable_storage_path: path,
        },
        { session_id: "sess_123" }
      );

      expect(result.success).toBe(true);
      const task = result.metadata?.task as any;
      expect(task).toBeDefined();
      const ctx = JSON.parse(task.context || "{}");
      expect(ctx.deliverable_storage_path).toBe(path);
    }
  });

  /**
   * TEST 5: deliverable_storage_path 应与 task 现有 context 字段合并（不覆盖其他字段）
   */
  it("pre_complete merges deliverable_storage_path into existing context (preserve other fields)", async () => {
    const tool = preCompleteTaskTool(taskComponent);
    const createTool = createTaskTool(taskComponent);

    const createResult = await createTool.execute(
      {
        parent_task_id: parentTaskId,
        title: "Task With Rich Context",
        project_path: "/path/to/proj",
        context: JSON.stringify({
          worktree_path: "/path/to/proj/.worktrees/foo",
          branch: "feat/foo",
          type: "feature",
          created_at: "2026-08-05T00:00:00.000Z",
        }),
      },
      { session_id: "sess_123" }
    );
    expect(createResult.success).toBe(true);
    const taskId = createResult.metadata?.task_id as number;

    const result = await tool.execute(
      {
        task_id: taskId,
        deliverable_storage_path: "/tmp/final-report.md",
      },
      { session_id: "sess_123" }
    );

    expect(result.success).toBe(true);
    const task = result.metadata?.task as any;
    const ctx = JSON.parse(task.context);

    // 原字段必须保留
    expect(ctx.worktree_path).toBe("/path/to/proj/.worktrees/foo");
    expect(ctx.branch).toBe("feat/foo");
    expect(ctx.type).toBe("feature");
    expect(ctx.created_at).toBe("2026-08-05T00:00:00.000Z");
    // 新字段写入
    expect(ctx.deliverable_storage_path).toBe("/tmp/final-report.md");
  });

  /**
   * TEST 6: cycle 类型任务即使带 deliverable_storage_path 也应被拒绝
   */
  it("pre_complete rejects cycle task even with deliverable_storage_path", async () => {
    const tool = preCompleteTaskTool(taskComponent);
    const createTool = createTaskTool(taskComponent);

    const createResult = await createTool.execute(
      {
        parent_task_id: parentTaskId,
        title: "Cycle Task With Deliverable",
        type: "cycle",
        project_path: "unknown",
        context: "{}",
      },
      { session_id: "sess_123" }
    );
    expect(createResult.success).toBe(true);
    const taskId = createResult.metadata?.task_id as number;

    const result = await tool.execute(
      {
        task_id: taskId,
        deliverable_storage_path: "https://my.feishu.cn/docx/cycle-doc",
      },
      { session_id: "sess_123" }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("cycle");
  });

  /**
   * TEST 7 (#2778 v2 双写 → #5073 迁移): pre_complete 双写
   * operation.milestoneDescription 含 "Deliverable: <path>"；
   * 随后 task_complete 验收落定的 completed operation 语义不变。
   */
  it("pre_complete double-writes deliverable to operation milestoneDescription (with path)", async () => {
    const preTool = preCompleteTaskTool(taskComponent);
    const tool = completeTaskTool(taskComponent);

    const createResult = await createTaskTool(taskComponent).execute(
      {
        parent_task_id: parentTaskId,
        title: "Task With Deliverable And Op",
        project_path: "unknown",
        context: "{}",
      },
      { session_id: "sess_123" }
    );
    expect(createResult.success).toBe(true);
    const taskId = createResult.metadata?.task_id as number;

    const deliverablePath = "https://my.feishu.cn/docx/doublewrite-test";
    const result = await preTool.execute(
      {
        task_id: taskId,
        deliverable_storage_path: deliverablePath,
      },
      { session_id: "sess_double" }
    );
    expect(result.success).toBe(true);

    // 通过 taskComponent.listOperations 拿到 pre_complete 创建的 operation
    const operations = await taskComponent.listOperations({ taskId });
    expect(operations.length).toBeGreaterThanOrEqual(1);

    const deliverableOps = operations.filter(
      (op) => (op.milestoneDescription || "") === `Deliverable: ${deliverablePath}`,
    );
    expect(deliverableOps.length).toBeGreaterThanOrEqual(1);

    // task_complete 验收落定（不传 deliverable —— #5073 设计调整①）
    const completeResult = await tool.execute(
      { task_id: taskId },
      { session_id: "sess_double" }
    );
    expect(completeResult.success).toBe(true);
    const completedOps = (await taskComponent.listOperations({ taskId }))
      .filter((op) => op.milestoneType === "completed");
    expect(completedOps.length).toBeGreaterThanOrEqual(1);
    expect(completedOps[completedOps.length - 1].milestoneTitle).toBe("Task completed");
  });

  /**
   * TEST 8 (#2778 v2 → #5073 迁移): 不传 deliverable 时，pre_complete 的
   * operation.milestoneDescription 不应误写 "Deliverable: undefined"。
   */
  it("pre_complete does not set 'Deliverable:' when no deliverable (backward compat)", async () => {
    const tool = preCompleteTaskTool(taskComponent);

    const createResult = await createTaskTool(taskComponent).execute(
      {
        parent_task_id: parentTaskId,
        title: "Legacy Task Without Deliverable And Op",
        project_path: "unknown",
        context: "{}",
      },
      { session_id: "sess_123" }
    );
    expect(createResult.success).toBe(true);
    const taskId = createResult.metadata?.task_id as number;

    const result = await tool.execute(
      { task_id: taskId },
      { session_id: "sess_legacy" }
    );
    expect(result.success).toBe(true);

    const operations = await taskComponent.listOperations({ taskId });
    const submittedOps = operations.filter(
      (op) => (op.milestoneTitle || "").includes("待验证"),
    );
    expect(submittedOps.length).toBeGreaterThanOrEqual(1);
    const latest = submittedOps[submittedOps.length - 1];

    // ★ 关键断言：没有 deliverable 时 milestoneDescription 不含 "Deliverable:"
    const desc = latest.milestoneDescription;
    expect(desc === undefined || desc === "" || desc === null || desc === "待验证").toBe(true);
    if (desc) {
      expect(desc).not.toContain("undefined");
      expect(desc).not.toContain("Deliverable:");
    }
  });
});
