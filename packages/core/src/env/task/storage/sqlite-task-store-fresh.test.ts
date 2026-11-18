/**
 * @fileoverview Task #5081 — TaskStore fresh-query bypass + multi-task session lookup tests
 *
 * 覆盖：
 * - S1 `listOperationsFresh` 返回 ORDER BY id DESC
 * - S2 `listOperationsFresh` 不写 operationsCache（fresh 后 listOperations 仍为旧快照）
 * - S3 两个 store 实例（同一 DB 文件）：B 写的 op，A 的 fresh 能看到（跨进程模拟）
 * - S4 `getTaskIdsBySessionId` 返回该 session 关联的**全部** task id
 */

import { describe, test, expect, afterEach } from "bun:test";
import { SQLiteTaskStore, TaskStore } from "./sqlite-task-store";
import { tmpdir } from "os";
import { join } from "path";

describe("SQLiteTaskStore — listOperationsFresh / getTaskIdsBySessionId (Task #5081)", () => {
  const created: TaskStore[] = [];
  const dbPath = join(tmpdir(), `task-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

  function makeStore(): TaskStore {
    const s = new SQLiteTaskStore(dbPath); // 同一 DB 文件（S3 跨实例）
    created.push(s);
    return s;
  }

  afterEach(async () => {
    for (const s of created.splice(0)) {
      await s.close();
    }
  });

  async function seedTask(store: TaskStore, sessionId: string) {
    return await store.createTask({
      title: "t",
      sessionId,
      project_path: "unknown",
      context: "{}",
    } as any);
  }

  test("S1: listOperationsFresh returns operations ordered by id DESC", async () => {
    const store = makeStore();
    const task = await seedTask(store, "sess-1");

    await store.createOperation({ taskId: task.id, sessionId: "sess-1", milestoneType: "progress", milestoneTitle: "one" } as any);
    await store.createOperation({ taskId: task.id, sessionId: "sess-1", milestoneType: "progress", milestoneTitle: "two" } as any);
    await store.createOperation({ taskId: task.id, sessionId: "sess-2", milestoneType: "milestone", milestoneTitle: "three" } as any);

    const fresh = await (store as any).listOperationsFresh({ taskId: task.id });
    expect(fresh.length).toBeGreaterThanOrEqual(3); // createTask 自带 create 记录
    const ids = fresh.map((o: any) => o.id);
    const sortedDesc = [...ids].sort((a, b) => b - a);
    expect(ids).toEqual(sortedDesc);
    expect(fresh[0].milestoneTitle).toBe("three");
  });

  test("S2: listOperationsFresh does NOT populate operationsCache (main cache stays stale-only)", async () => {
    const store = makeStore();
    const task = await seedTask(store, "sess-a");

    const op1 = await store.createOperation({ taskId: task.id, sessionId: "sess-b", milestoneType: "progress", milestoneTitle: "first" } as any);

    // 填主缓存（store 层 createTask 不写 create 记录 → 此时只有 op1）
    const cached = await store.listOperations({ taskId: task.id });
    expect(cached.some((o: any) => o.milestoneTitle === "first")).toBe(true);

    // 另一"进程"（新 store 实例）写新 op
    const other = makeStore();
    await other.createOperation({ taskId: task.id, sessionId: "sess-b", milestoneType: "progress", milestoneTitle: "second" } as any);

    // 主实例 fresh 能看到新 op（直打 DB）
    const fresh = await (store as any).listOperationsFresh({ taskId: task.id, limit: 50 });
    expect(fresh.some((o: any) => o.milestoneTitle === "second")).toBe(true);

    // 主缓存未被 fresh 改写：listOperations 仍返回旧快照（不含 second）
    const stale = await store.listOperations({ taskId: task.id });
    expect(stale.some((o: any) => o.milestoneTitle === "second")).toBe(false);
    expect(stale.some((o: any) => o.milestoneTitle === "first" || o.id === op1.id)).toBe(true);

    // invalidateOperationsCache 后 listOperations 刷新
    (store as any).invalidateOperationsCache(task.id);
    const refreshed = await store.listOperations({ taskId: task.id });
    expect(refreshed.some((o: any) => o.milestoneTitle === "second")).toBe(true);
  });

  test("S3: cross-store-instance visibility — B writes, A's fresh sees it (cross-process simulation)", async () => {
    const storeA = makeStore();
    const task = await seedTask(storeA, "sess-x");

    const storeB = makeStore();
    await storeB.createOperation({ taskId: task.id, sessionId: "other-process", milestoneType: "decision", milestoneTitle: "written by B" } as any);

    // A 走 fresh（绕缓存）必须看到 B 写的记录
    const fresh = await (storeA as any).listOperationsFresh({ taskId: task.id, limit: 50 });
    expect(fresh.some((o: any) => o.milestoneTitle === "written by B")).toBe(true);

    // A 走 TaskComponent 语义的包装（此处直接验 store 接口能力探测前提）
    expect(typeof (storeA as any).listOperationsFresh).toBe("function");
    expect(typeof (storeA as any).invalidateOperationsCache).toBe("function");
  });

  test("S4: getTaskIdsBySessionId returns ALL task ids linked via any operation", async () => {
    const store = makeStore();
    // store 层 createTask 不写 create 记录（TaskComponent 层才写）——
    // 显式给每个 task 写一条 session 关联记录（含非 create 类型）。
    const t1 = await seedTask(store, "sess-multi");
    await store.createOperation({ taskId: t1.id, sessionId: "sess-multi", milestoneType: "milestone", milestoneTitle: "milestone on t1" } as any);
    const t2 = await seedTask(store, "sess-multi");
    // 只往 t2 写 progress（非 create 记录也算关联）
    await store.createOperation({ taskId: t2.id, sessionId: "sess-multi", milestoneType: "progress", milestoneTitle: "progress on t2" } as any);

    const ids = await (store as any).getTaskIdsBySessionId("sess-multi");
    expect(ids.length).toBe(2);
    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);

    // 未知 session → []
    expect(await (store as any).getTaskIdsBySessionId("sess-none")).toEqual([]);
    // 空 session → []
    expect(await (store as any).getTaskIdsBySessionId("")).toEqual([]);
  });
});
