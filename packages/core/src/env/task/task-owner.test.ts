/**
 * Task #5440 — owner（负责人）全链路 RED 测试。
 *
 * 用户需求（2026-11-13，第 2 步任务第 4 条）：
 *   「task_create / task_update 等 agent 工具入参 schema 加 owner（可选，不传即
 *     null，向后兼容）；CLI tasks create/update 加 `--owner`；工具描述注明
 *     owner 语义（负责人，可空，多人协作场景）」
 *
 * 覆盖三件事：
 *   1. 存储层：新建默认 null、可写入、可改、可清空（null / ""）、读回一致
 *   2. 工具层（agent 直连 TaskComponent）：createTask / updateTask 透传 owner
 *   3. schema 层：task_create / task_update 的入参含可选 owner，且**不传也能用**
 *   4. 迁移：老库（无 owner 列）打开后自动补列，存量行 owner 为 null
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, rmSync } from "fs";

import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { CreateTaskToolSchema, UpdateTaskToolSchema } from "./tools/task-types";

function tempDbPath(tag: string): string {
  return join(tmpdir(), `task-owner-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

describe("owner — 存储层（SQLiteTaskStore）", () => {
  let component: TaskComponent;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDbPath("store");
    component = new TaskComponent();
    await component.init({
      options: {
        configComponent: new ConfigComponent(),
        config: { storage: { type: "sqlite", dbPath } },
      },
    });
  });

  afterEach(async () => {
    await component.stop();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it("不传 owner → 创建成功且 owner 为 null（向后兼容）", async () => {
    const task = await component.createTask({
      title: "no owner",
      sessionId: "s1",
      project_path: "unknown",
      context: "{}",
    });
    expect(task.owner).toBeNull();
  });

  it("传 owner → 落库并可读回", async () => {
    const created = await component.createTask({
      title: "with owner",
      sessionId: "s1",
      project_path: "unknown",
      context: "{}",
      owner: "ou_abc",
    });
    expect(created.owner).toBe("ou_abc");

    const readBack = await component.getTask(created.id);
    expect(readBack?.owner).toBe("ou_abc");
  });

  it("update 改 owner → 生效", async () => {
    const created = await component.createTask({
      title: "t",
      sessionId: "s1",
      project_path: "unknown",
      context: "{}",
      owner: "a",
    });
    const updated = await component.updateTask(created.id, { owner: "b" });
    expect(updated?.owner).toBe("b");
    expect((await component.getTask(created.id))?.owner).toBe("b");
  });

  it("update 传 null 或 \"\" → 清空 owner", async () => {
    const created = await component.createTask({
      title: "t",
      sessionId: "s1",
      project_path: "unknown",
      context: "{}",
      owner: "a",
    });
    expect((await component.updateTask(created.id, { owner: null }))?.owner ?? null).toBeNull();

    await component.updateTask(created.id, { owner: "c" });
    expect((await component.updateTask(created.id, { owner: "" }))?.owner ?? null).toBeNull();
  });

  it("update 不改 owner（字段省略）→ 原值保留", async () => {
    const created = await component.createTask({
      title: "t",
      sessionId: "s1",
      project_path: "unknown",
      context: "{}",
      owner: "keep",
    });
    const updated = await component.updateTask(created.id, { title: "new title" });
    expect(updated?.owner).toBe("keep");
  });

  it("老库（无 owner 列）打开后自动补列，存量行 owner = null", async () => {
    // 手工造一个没有 owner 列的老库
    const legacyPath = tempDbPath("legacy");
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(legacyPath);
    legacy.run(`CREATE TABLE task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'todo',
      priority TEXT DEFAULT 'medium',
      type TEXT DEFAULT 'normal',
      progress INTEGER DEFAULT 0,
      current_status TEXT DEFAULT '',
      goals_and_expected_deliverables TEXT DEFAULT '',
      parent_task_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      due_date TEXT,
      tags TEXT,
      project_path TEXT NOT NULL DEFAULT 'unknown',
      context TEXT NOT NULL DEFAULT '{}'
    )`);
    legacy.run(
      `INSERT INTO task (title, created_at, updated_at, project_path, context)
       VALUES ('legacy row', ?, ?, 'unknown', '{}')`,
      [Date.now(), Date.now()],
    );
    legacy.close();

    const legacyComponent = new TaskComponent();
    await legacyComponent.init({
      options: {
        configComponent: new ConfigComponent(),
        config: { storage: { type: "sqlite", dbPath: legacyPath } },
      },
    });

    const rows = await legacyComponent.listTasks({ limit: 10 });
    expect(rows.tasks.length).toBe(1);
    expect(rows.tasks[0].title).toBe("legacy row");
    expect(rows.tasks[0].owner ?? null).toBeNull();

    // 补列后仍可写 owner
    const updated = await legacyComponent.updateTask(rows.tasks[0].id, { owner: "new-owner" });
    expect(updated?.owner).toBe("new-owner");

    await legacyComponent.stop();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${legacyPath}${suffix}`;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });
});

describe("owner — 工具 schema（agent 入参）", () => {
  it("task_create schema 含可选 owner，且不传可解析", () => {
    expect(CreateTaskToolSchema.shape.owner).toBeDefined();
    const parsed = CreateTaskToolSchema.parse({ title: "x" });
    expect(parsed.owner).toBeUndefined();
  });

  it("task_create schema 接受 owner 字符串", () => {
    const parsed = CreateTaskToolSchema.parse({ title: "x", owner: "ou_1" });
    expect(parsed.owner).toBe("ou_1");
  });

  it("task_update schema 含可选 owner，且接受 null（清空）", () => {
    // update schema 是 z.preprocess 包裹（legacy task_id 归一化），shape 在内层
    const inner = (UpdateTaskToolSchema as any)._def?.schema ?? UpdateTaskToolSchema;
    expect(inner.shape.owner).toBeDefined();
    const parsed = UpdateTaskToolSchema.parse({ task_id: 1, owner: null });
    expect(parsed.owner).toBeNull();
  });

  it("task_update 省略 owner 时不产生该字段（不改动语义）", () => {
    const parsed = UpdateTaskToolSchema.parse({ task_id: 1, title: "x" });
    expect(parsed.owner).toBeUndefined();
  });

  it("工具描述里注明了 owner 语义（负责人 / 可空 / 多人协作）", () => {
    const desc = CreateTaskToolSchema.shape.owner.description ?? "";
    expect(desc).toMatch(/负责人|owner/i);
    expect(desc).toMatch(/可空|null|可选/);
    expect(desc).toMatch(/协作|多人|assigned/i);
  });
});
