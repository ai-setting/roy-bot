/**
 * Task #5078 — MCP 暴露 task_pre_complete（两阶段验收 #5073 的插件侧适配）
 *
 * ## 需求（用户 2026-11-06）
 *
 * roy-bot main 已有 task_pre_complete 两阶段验收（#5073），但插件的
 * 各 runtime（claude / codex / cursor 走 MCP）拿不到这个工具：
 *
 * - `TASK_MCP_TOOL_NAMES`（task-mcp-server.ts）不含 `task_pre_complete`
 * - `TASK_TOOL_FACTORIES` 不含 `preCompleteTaskTool`
 * - `TaskStoreBackend` 没有 `preCompleteTask` 方法（TaskComponent 有，
 *   backend 契约 `TaskBackend` 没有）⇒ 工厂 duck-type 到 backend 时
 *   直接 `is not a function`
 *
 * ## 三个验收点
 *
 * 1. **R1** `TaskStoreBackend.preCompleteTask`：同构 TaskComponent 的
 *    语义（status=to_validate、current_status=待验证措辞、deliverable
 *    merge 进 context、milestone operation 留痕），但**不 fire 钩子**
 *    （TaskStoreBackend 没有 hook 链 —— #5035 已确认这一架构事实，
 *    goal 判定由插件 MCP 层的 withGoalCheck 补）。
 * 2. **R2** `task-mcp-server`：`TASK_MCP_TOOL_NAMES` 含
 *    `task_pre_complete`，`tools/list` 广告它，`tools/call` 能执行。
 * 3. **R3** 两阶段 e2e（backend 级）：create → preComplete →
 *    to_validate → complete → completed，全链 status 断言。
 *
 * ## 既有事实（不可破坏）
 *
 * - cycle 任务拒绝 preComplete（与 TaskComponent.preCompleteTask 同规则）
 * - `TASK_TO_VALIDATE_STATUS_WORD = "待验证"` 措辞同源
 * - `formatDeliverableForOperation` 产出 `Deliverable: <path>` 行
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteTaskStore } from "../storage/sqlite-task-store";
import { TaskStoreBackend } from "./task-store-backend";
import { createSQLiteTaskPort } from "./sqlite-task-port";
import {
  TASK_TO_VALIDATE_STATUS_WORD,
} from "../tools/completion-copy";
import {
  TASK_MCP_TOOL_NAMES,
  createTaskMcpServer,
} from "../mcp/task-mcp-server";

function makeBackend(dbPath: string): TaskStoreBackend {
  const store = new SQLiteTaskStore(dbPath);
  return new TaskStoreBackend(createSQLiteTaskPort(store));
}

const TMP = mkdtempSync(join(tmpdir(), "pre-complete-mcp-5078-"));

describe("Task #5078 R1 — TaskStoreBackend.preCompleteTask", () => {
  test("submitting sets status=to_validate + 待验证 current_status wording", async () => {
    const backend = makeBackend(join(TMP, "r1a.db"));
    const t = await backend.createTask({ title: "R1 to_validate", project_path: "/p", context: "{}" });

    const updated = await backend.preCompleteTask(t.id, "sess-r1", "/tmp/deliv.md", "测试全绿");

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("to_validate");
    expect(updated!.current_status).toContain(TASK_TO_VALIDATE_STATUS_WORD);
    expect(updated!.current_status).toContain("测试全绿");
  });

  test("deliverable lands in context.deliverable_storage_path (merge keeps siblings)", async () => {
    const backend = makeBackend(join(TMP, "r1b.db"));
    const t = await backend.createTask({
      title: "R1 deliverable merge",
      project_path: "/p",
      context: JSON.stringify({ feishu_doc_url: "https://example" }),
    });

    const updated = await backend.preCompleteTask(t.id, "sess-r1", "/tmp/r1b.md");

    const ctx = JSON.parse(updated!.context ?? "{}");
    expect(ctx.deliverable_storage_path).toBe("/tmp/r1b.md");
    expect(ctx.feishu_doc_url).toBe("https://example");
  });

  test("writes an auditable milestone operation for the submission", async () => {
    const backend = makeBackend(join(TMP, "r1c.db"));
    const t = await backend.createTask({ title: "R1 op trail", project_path: "/p", context: "{}" });

    await backend.preCompleteTask(t.id, "sess-r1", "/tmp/r1c.md");

    const ops = await backend.listOperations({ taskId: t.id });
    const submission = ops.find((o) =>
      o.milestoneTitle.includes("to_validate"),
    );
    expect(submission).toBeDefined();
    expect(submission!.milestoneType).toBe("milestone");
    expect(submission!.milestoneDescription).toContain("Deliverable: /tmp/r1c.md");
  });

  test("cycle tasks are rejected (roy semantics, same as TaskComponent)", async () => {
    const backend = makeBackend(join(TMP, "r1d.db"));
    const t = await backend.createTask({ title: "R1 cycle", type: "cycle", project_path: "/p", context: "{}" });

    await expect(backend.preCompleteTask(t.id, "sess-r1")).rejects.toThrow(
      /cycle/i,
    );
  });

  test("unknown task id returns null", async () => {
    const backend = makeBackend(join(TMP, "r1e.db"));
    const updated = await backend.preCompleteTask(424242, "sess-r1");
    expect(updated).toBeNull();
  });
});

describe("Task #5078 R2 — MCP advertises and executes task_pre_complete", () => {
  test("TASK_MCP_TOOL_NAMES contains task_pre_complete", () => {
    expect(TASK_MCP_TOOL_NAMES).toContain("task_pre_complete");
  });

  test("tools/list includes task_pre_complete with a two-phase description", async () => {
    const backend = makeBackend(join(TMP, "r2a.db"));
    const server = createTaskMcpServer(backend);

    const tools = server.listTools();
    const pre = tools.find((t) => t.name === "task_pre_complete");

    expect(pre).toBeDefined();
    expect(pre!.description).toContain("to_validate");
    expect(pre!.inputSchema).toBeDefined();
  });

  test("tools/call task_pre_complete flips the task to to_validate", async () => {
    const backend = makeBackend(join(TMP, "r2b.db"));
    const server = createTaskMcpServer(backend);

    const createdOut = (await server.callTool("task_create", {
      title: "R2 call",
      description: "via mcp",
    })) as string;
    const createdId = Number(/#(\d+)/.exec(createdOut)?.[1]);
    expect(createdId).toBeGreaterThan(0);

    await server.callTool("task_pre_complete", {
      task_id: createdId,
      deliverable_storage_path: "/tmp/r2b.md",
      current_status: "实现完成",
    });

    const after = await backend.getTask(createdId);
    expect(after!.status).toBe("to_validate");
  });
});

describe("Task #5078 R3 — two-phase acceptance e2e (backend level)", () => {
  test("create → preComplete → to_validate → complete → completed", async () => {
    const backend = makeBackend(join(TMP, "r3a.db"));
    const t = await backend.createTask({
      title: "R3 two-phase",
      project_path: "/p",
      context: "{}",
      goals_and_expected_deliverables: "1. 实现X\n2. 测试Y",
    });

    // 阶段一：executor 提交待验证
    const submitted = await backend.preCompleteTask(
      t.id,
      "sess-r3",
      "/tmp/r3a.md",
      "交付完成",
    );
    expect(submitted!.status).toBe("to_validate");
    expect(submitted!.progress).not.toBe(100);

    // 阶段二：验收方终验
    const accepted = await backend.completeTask(t.id, "sess-r3-acceptor");
    expect(accepted!.status).toBe("completed");
    expect(accepted!.progress).toBe(100);

    // 操作链：提交待验证里程碑 + 完成里程碑都在
    const ops = await backend.listOperations({ taskId: t.id });
    const titles = ops.map((o) => o.milestoneTitle);
    expect(titles.some((s) => s.includes("to_validate"))).toBe(true);
    expect(ops.some((o) => o.milestoneType === "completed")).toBe(true);
  });
});
