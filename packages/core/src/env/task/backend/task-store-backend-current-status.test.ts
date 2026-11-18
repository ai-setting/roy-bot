/**
 * @fileoverview Task #5060 — TaskStoreBackend.completeTask 也必须写 current_status
 *
 * 背景（DS review r1 的 MAJOR M1）：
 *   `TaskStoreBackend`（自称「roy 语义的唯一实现」，且经 package.json 的
 *   `./env/task/backend` / `./env/task/mcp` 公开导出、绑定到**已发布的 MCP
 *   task server**）有**同一类缺陷** —— completeTask 只设 status/progress，
 *   不碰 current_status ⇒ 通过该 backend 完成任务同样会留下
 *   「status=completed 但描述说没做完」的矛盾状态。
 *
 *   DS review 实测复现：
 *     BACKEND status= completed progress= 100 current_status= "决定暂停：未 commit"
 *
 * 本测试守住 backend 路径的终态文案同步（与 TaskComponent 路径同源）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { SQLiteTaskStore } from "../storage/sqlite-task-store";
import { createSQLiteTaskPort } from "./sqlite-task-port";
import { TaskStoreBackend } from "./task-store-backend";
import type { TaskBackend } from "./types";

let store: SQLiteTaskStore;
let backend: TaskBackend;
let dbPath: string;

beforeEach(async () => {
  dbPath = join(
    tmpdir(),
    `task-5060-backend-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  store = new SQLiteTaskStore(dbPath);
  backend = new TaskStoreBackend(createSQLiteTaskPort(store), { sessionId: "ses_5060" });
});

afterEach(async () => {
  await store.close();
  // Task #5060 DS review MINOR m1: 清理临时 DB（sqlite 还会带 -wal / -shm 副文件）
  // 与 task-complete-current-status.test.ts 的 m4 修复保持同源，避免每次跑泄漏文件。
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        // 清理失败不影响测试结论
      }
    }
  }
});

describe("Task #5060 — backend completeTask syncs current_status (M1)", () => {
  test("completeTask 后 current_status 含「已完成」语义（stale 文案被覆盖）", async () => {
    const created = await backend.createTask({
      title: "backend complete",
      project_path: "/repo",
      context: "{}",
    });
    expect(created).not.toBeNull();

    // 先写入一条「还没做完」的中间态文案，复现用户实测到的矛盾状态
    await backend.updateTask(created!.id, { current_status: "决定暂停：未 commit" });

    const done = await backend.completeTask(created!.id, "ses_5060");
    expect(done).not.toBeNull();
    expect(done!.status).toBe("completed");
    expect(done!.progress).toBe(100);
    expect(done!.current_status).toBeDefined();
    expect(done!.current_status.length).toBeGreaterThan(0);
    expect(done!.current_status).toContain("已完成");
    expect(done!.current_status).not.toContain("决定暂停");
  });

  test("completeTask 带 deliverable 时 current_status 含该路径", async () => {
    const created = await backend.createTask({
      title: "backend complete with deliverable",
      project_path: "/repo",
      context: "{}",
    });
    expect(created).not.toBeNull();

    const deliverable = "/tmp/task5060-backend-report.md";
    const done = await backend.completeTask(created!.id, "ses_5060", deliverable);
    expect(done).not.toBeNull();
    expect(done!.current_status).toContain("已完成");
    expect(done!.current_status).toContain(deliverable);
  });

  test("回归保护：completeTask 仍写 completion operation", async () => {
    const created = await backend.createTask({
      title: "backend op guard",
      project_path: "/repo",
      context: "{}",
    });
    expect(created).not.toBeNull();

    await backend.completeTask(created!.id, "ses_5060", "/tmp/task5060-backend-op.md");

    const ops = await backend.listOperations({ taskId: created!.id });
    const completed = ops.filter(
      (op: any) => (op.milestoneType ?? op.actionType) === "completed",
    );
    expect(completed.length).toBeGreaterThan(0);
  });
});
