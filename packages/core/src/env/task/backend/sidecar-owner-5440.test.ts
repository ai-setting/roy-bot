/**
 * Task #5440 补漏 — sidecar port 的 owner 三路透传。
 *
 * backend 的 createTask/updateTask 已把 owner 交给 port
 * （task-store-backend.ts:164/241），但 sidecar port 此前
 * 丢弃了它：create 恒写 `agent`，update 直接不透传，
 * toStoredTask 也不回读。插件（roy-task-plugin）的 owner 列
 * 因此永远只反映 agent，owner 改派完全失效。
 */
import { describe, expect, test } from "bun:test";
import { createRoySidecarTaskPort } from "./roy-sidecar-task-port";

interface Rec {
  id: string;
  num?: number;
  title: string;
  description?: string;
  status: string;
  priority: number;
  tags?: string;
  parent_id: string | null;
  session_id?: string | null;
  owner?: string | null;
  roy?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function makeStore() {
  const tasks = new Map<string, Rec>();
  let n = 0;
  return {
    async createTask(input: any) {
      const id = `t${++n}`;
      const rec: Rec = {
        id,
        num: n,
        title: input.title,
        description: input.description,
        status: input.status ?? "pending",
        priority: input.priority ?? 3,
        tags: input.tags,
        parent_id: input.parent_id ?? null,
        session_id: input.session_id ?? null,
        owner: input.owner ?? null,
        roy: input.roy,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      tasks.set(id, rec);
      return rec;
    },
    async updateTask(id: string, input: any) {
      const rec = tasks.get(id);
      if (!rec) return null;
      if (input.owner !== undefined) rec.owner = input.owner;
      if (input.status !== undefined) rec.status = input.status;
      return rec;
    },
    async getTask(id: string) {
      return tasks.get(id) ?? null;
    },
    async listTasks() {
      return { tasks: [...tasks.values()], total: tasks.size };
    },
    async deleteTask(id: string) {
      return tasks.delete(id);
    },
    async appendOperation(input: any) {
      return {
        id: "op1",
        num: 1,
        task_id: input.task_id,
        type: input.type,
        data: input.data,
        created_at: new Date().toISOString(),
      };
    },
    async listOperations() {
      return { operations: [], total: 0 };
    },
  };
}

const vocab = {
  toRoyStatus: (s: string) => (s === "done" ? "completed" : s === "in_progress" ? "active" : "todo"),
  toStoreStatus: (s: string) => (s === "completed" ? "done" : s === "active" ? "in_progress" : "pending"),
  toRoyPriority: (p: any) => (p <= 2 ? "high" : p === 3 ? "medium" : "low"),
  toStorePriority: (p: any) => (p === "high" ? 1 : p === "medium" ? 3 : 5),
  toRoyTags: (t?: string | null) => (t ? t.split(",") : []),
  toStoreTags: (t?: string[]) => (t && t.length ? t.join(",") : undefined),
};

describe("sidecar port owner 透传（Task #5440 补漏）", () => {
  test("create：显式 owner 优先于 agent", async () => {
    const port = createRoySidecarTaskPort(makeStore() as any, vocab as any, { agent: "roy" });
    const t = await port.createTask({
      title: "x",
      owner: "ou_alice",
    } as any);
    const rec = await port.getTask(t.nativeId);
    expect(rec?.owner).toBe("ou_alice");
  });

  test("create：缺省回落 agent", async () => {
    const port = createRoySidecarTaskPort(makeStore() as any, vocab as any, { agent: "roy" });
    const t = await port.createTask({ title: "y" } as any);
    const rec = await port.getTask(t.nativeId);
    expect(rec?.owner).toBe("roy");
  });

  test("update：owner 改派 / 清空 / 省略不改", async () => {
    const store = makeStore();
    const port = createRoySidecarTaskPort(store as any, vocab as any, { agent: "roy" });
    const t = await port.createTask({ title: "z" } as any);

    await port.updateTask(t.nativeId, { owner: "ou_bob" } as any);
    expect((await port.getTask(t.nativeId))?.owner).toBe("ou_bob");

    await port.updateTask(t.nativeId, { owner: null } as any);
    expect((await port.getTask(t.nativeId))?.owner).toBeNull();

    await port.updateTask(t.nativeId, { title: "z2" } as any);
    expect((await port.getTask(t.nativeId))?.owner).toBeNull();
  });
});
