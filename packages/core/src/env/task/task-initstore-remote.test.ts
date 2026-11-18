/**
 * Task #5440（M4）— `initStore` 引擎分支 RED 测试。
 *
 * 方案 v3 §4.1：`task.storage.type = "sqlite" | "remote"`
 *   - `sqlite`（默认）→ SQLiteTaskStore（现状零改动）
 *   - `remote`        → RemoteTaskStore（`task.storage.endpoint` +
 *                       `task.storage.authToken`）
 *
 * 关键约束（方案 §1.3 非目标 / §5.3 故障语义）：
 *   1. **没有静默 fallback**：remote 不可达时组件 init 必须明确失败
 *      （或首次调用明确报错），绝不悄悄退回本地库（否则双库分叉）。
 *   2. watcher 热更新沿用：`task.storage.type` / `endpoint` / `authToken`
 *      变化都要重建 store。
 *   3. 配置校验：type=remote 但缺 endpoint → 明确报错，不猜默认值。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, rmSync } from "fs";

import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { RemoteTaskStore, RemoteTaskStoreError } from "./storage/remote-task-store";
import { SQLiteTaskStore } from "./storage/sqlite-task-store";

const TASK_ROW = {
  id: 42,
  title: "remote task",
  description: "",
  status: "todo" as const,
  priority: "medium" as const,
  type: "normal" as const,
  progress: 0,
  current_status: "",
  goals_and_expected_deliverables: "",
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
  project_path: "unknown",
  context: "{}",
  owner: null,
};

/** 极简 mock service：只应答 /version 与 /store/getTask。 */
function startService(port = 0) {
  const calls: string[] = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/version") {
        return Response.json({ protocol: { major: 1, minor: 0 }, engine: "sqlite" });
      }
      const method = url.pathname.replace("/store/", "");
      calls.push(method);
      if (method === "getTask") return Response.json(TASK_ROW);
      if (method === "createTask") return Response.json(TASK_ROW);
      return Response.json({ ok: true });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

function tempDbPath(tag: string) {
  return join(tmpdir(), `task-initstore-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

describe("initStore — 引擎分支", () => {
  it("默认（无配置）→ SQLiteTaskStore（现状行为不变）", async () => {
    const dbPath = tempDbPath("default");
    const component = new TaskComponent();
    await component.init({
      options: {
        configComponent: new ConfigComponent(),
        config: { storage: { type: "sqlite", dbPath } },
      },
    });
    const store = (component as any).store;
    expect(store).toBeInstanceOf(SQLiteTaskStore);
    await component.stop();
    for (const s of ["", "-wal", "-shm"]) if (existsSync(`${dbPath}${s}`)) rmSync(`${dbPath}${s}`, { force: true });
  });

  it("type=remote → RemoteTaskStore，且请求真的打到 service", async () => {
    const svc = startService();
    const component = new TaskComponent();
    try {
      await component.init({
        options: {
          configComponent: new ConfigComponent(),
          config: {
            storage: { type: "remote", endpoint: svc.url, authToken: "tok" },
          },
        },
      });
      const store = (component as any).store;
      expect(store).toBeInstanceOf(RemoteTaskStore);

      const task = await component.getTask(42);
      expect(task?.title).toBe("remote task");
      expect(svc.calls).toContain("getTask");
    } finally {
      await component.stop();
      svc.stop();
    }
  });

  it("type=remote 但缺 endpoint → 明确报错（不猜默认值、不静默退回本地）", async () => {
    const component = new TaskComponent();
    let error: Error | undefined;
    try {
      await component.init({
        options: {
          configComponent: new ConfigComponent(),
          config: { storage: { type: "remote" } },
        },
      });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(String(error?.message)).toMatch(/endpoint/i);
    expect(String(error?.message)).toMatch(/task\.storage\.endpoint/);
    try {
      await component.stop();
    } catch {
      /* init 失败时 stop 允许报错 */
    }
  });

  it("type=remote 且 service 不可达 → 调用明确报错（无静默 fallback）", async () => {
    const component = new TaskComponent();
    try {
      await component.init({
        options: {
          configComponent: new ConfigComponent(),
          config: {
            // 端口 1 必然连不上
            storage: { type: "remote", endpoint: "http://127.0.0.1:1", authToken: "t" },
          },
        },
      });
      const store = (component as any).store;
      expect(store).toBeInstanceOf(RemoteTaskStore);
      // 存储层没有被替换成本地库
      expect(store).not.toBeInstanceOf(SQLiteTaskStore);

      const err = await component.getTask(1).catch((e: Error) => e);
      expect(err).toBeInstanceOf(RemoteTaskStoreError);
      expect(String((err as Error).message)).toMatch(/127\.0\.0\.1:1/);
      expect(String((err as Error).message).toLowerCase()).toMatch(/fallback|no local/);
    } finally {
      await component.stop();
    }
  });
});

describe("initStore — 配置热更新（watcher）", () => {
  let svc: ReturnType<typeof startService>;

  beforeEach(() => {
    svc = startService();
  });

  afterEach(() => {
    svc.stop();
  });

  it("task.storage.type 从 sqlite 切到 remote → store 实例换成 RemoteTaskStore", async () => {
    const dbPath = tempDbPath("watch");
    const configComponent = new ConfigComponent();
    const component = new TaskComponent();
    try {
      await component.init({
        options: {
          configComponent,
          config: { storage: { type: "sqlite", dbPath } },
        },
      });
      expect((component as any).store).toBeInstanceOf(SQLiteTaskStore);

      await configComponent.set("task.storage.endpoint", svc.url);
      await configComponent.set("task.storage.authToken", "tok");
      await configComponent.set("task.storage.type", "remote");

      // watcher 是异步 fire-and-forget：轮询等待
      for (let i = 0; i < 60 && !((component as any).store instanceof RemoteTaskStore); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((component as any).store).toBeInstanceOf(RemoteTaskStore);
    } finally {
      await component.stop();
      for (const s of ["", "-wal", "-shm"]) if (existsSync(`${dbPath}${s}`)) rmSync(`${dbPath}${s}`, { force: true });
    }
  });

  it("task.storage.endpoint 变化 → 重建 RemoteTaskStore（新 endpoint 生效）", async () => {
    const other = startService();
    const configComponent = new ConfigComponent();
    const component = new TaskComponent();
    try {
      await component.init({
        options: {
          configComponent,
          config: { storage: { type: "remote", endpoint: svc.url, authToken: "tok" } },
        },
      });
      const before = (component as any).store as RemoteTaskStore;
      expect(before).toBeInstanceOf(RemoteTaskStore);

      await configComponent.set("task.storage.endpoint", other.url);

      for (let i = 0; i < 60; i++) {
        const now = (component as any).store;
        if (now !== before) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const after = (component as any).store as RemoteTaskStore;
      expect(after).not.toBe(before);
      expect(after).toBeInstanceOf(RemoteTaskStore);
    } finally {
      await component.stop();
      other.stop();
    }
  });
});
