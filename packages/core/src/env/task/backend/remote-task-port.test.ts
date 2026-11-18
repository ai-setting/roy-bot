/**
 * Task #5440（M4 / 方案 §2.2）— MCP 通道 remote 支持。
 *
 * MCP 的接线不走 `TaskComponent`：`bridge.mjs` 直接
 * `new TaskStoreBackend(createSQLiteTaskPort(new SQLiteTaskStore(dbPath)))`。
 * 所以 remote 必须由 **port 工厂分支**覆盖，而不是靠 initStore 分支。
 *
 * 本文件锁定：
 *   1. `createRemoteTaskPort(endpoint, token)` 让 MCP 通道读写都落到 service
 *   2. 工具面（task_create / task_get / task_operation_create / task_update）
 *      经 remote port 也能完整跑通
 *   3. owner 经 remote port 透传（MCP 侧 owner 全链路）
 *   4. `createTaskPortFromConfig()` 按 task.storage.type 选 port（供 bridge 用）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";

import {
  createRemoteTaskPort,
  createTaskPortFromConfig,
  TaskStoreBackend,
} from "./index";
import { createTaskMcpServer } from "../mcp";

// ============================================================================
// 有状态的 mock task-service（内存实现 TaskStore 子集）
// ============================================================================

interface Row {
  id: number;
  title: string;
  owner: string | null;
  operations: Array<{ id: number; taskId: number; sessionId: string; milestoneType: string; milestoneTitle: string; milestoneDescription: string; processDescription: string; timestamp: string }>;
}

function startFakeService() {
  const tasks = new Map<number, Row>();
  const calls: string[] = [];
  let seq = 100;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/version") {
        return Response.json({ protocol: { major: 1, minor: 0 }, engine: "sqlite" });
      }
      const method = url.pathname.replace("/store/", "");
      calls.push(method);
      const body = (await req.json().catch(() => ({}))) as { args?: any[] };
      const args = Array.isArray(body.args) ? body.args : [body];
      const now = new Date().toISOString();

      switch (method) {
        case "createTask": {
          const opts = args[0] as any;
          const id = ++seq;
          const row: Row = {
            id,
            title: opts.title,
            owner: opts.owner ?? null,
            operations: [],
          };
          tasks.set(id, row);
          return Response.json({
            id,
            title: row.title,
            description: opts.description ?? "",
            status: "todo",
            priority: opts.priority ?? "medium",
            type: opts.type ?? "normal",
            progress: 0,
            current_status: "",
            goals_and_expected_deliverables: opts.goals_and_expected_deliverables ?? "",
            createdAt: now,
            updatedAt: now,
            project_path: opts.project_path ?? "unknown",
            context: opts.context ?? "{}",
            owner: row.owner,
          });
        }
        case "getTask": {
          const row = tasks.get(Number(args[0]));
          if (!row) return Response.json(null);
          return Response.json({
            id: row.id,
            title: row.title,
            description: "",
            status: "todo",
            priority: "medium",
            type: "normal",
            progress: 0,
            current_status: "",
            goals_and_expected_deliverables: "",
            createdAt: now,
            updatedAt: now,
            project_path: "unknown",
            context: "{}",
            owner: row.owner,
          });
        }
        case "updateTask": {
          const id = Number(args[0]);
          const patch = args[1] as any;
          const row = tasks.get(id);
          if (!row) return Response.json(null);
          if (patch.title !== undefined) row.title = patch.title;
          if (patch.owner !== undefined) row.owner = patch.owner || null;
          return Response.json({
            id: row.id,
            title: row.title,
            description: "",
            status: patch.status ?? "todo",
            priority: "medium",
            type: "normal",
            progress: 0,
            current_status: "",
            goals_and_expected_deliverables: "",
            createdAt: now,
            updatedAt: now,
            project_path: "unknown",
            context: "{}",
            owner: row.owner,
          });
        }
        case "deleteTask": {
          return Response.json(tasks.delete(Number(args[0])));
        }
        case "listTasks": {
          const rows = [...tasks.values()].map((row) => ({
            id: row.id,
            title: row.title,
            description: "",
            status: "todo",
            priority: "medium",
            type: "normal",
            progress: 0,
            current_status: "",
            goals_and_expected_deliverables: "",
            createdAt: now,
            updatedAt: now,
            project_path: "unknown",
            context: "{}",
            owner: row.owner,
          }));
          return Response.json({ tasks: rows, total: rows.length });
        }
        case "createOperation": {
          const opts = args[0] as any;
          const row = tasks.get(Number(opts.taskId));
          const op = {
            id: ++seq,
            taskId: Number(opts.taskId),
            sessionId: opts.sessionId,
            milestoneType: opts.milestoneType,
            milestoneTitle: opts.milestoneTitle,
            milestoneDescription: opts.milestoneDescription ?? "",
            processDescription: opts.processDescription ?? "",
            timestamp: now,
          };
          row?.operations.push(op);
          return Response.json(op);
        }
        case "listOperations": {
          const opts = args[0] as any;
          const row = tasks.get(Number(opts.taskId));
          const ops = (row?.operations ?? []).slice().reverse();
          return Response.json(ops);
        }
        case "invalidateOperationsCache":
          return Response.json(null);
        case "getTaskIdBySessionId":
          return Response.json(undefined as any);
        case "getTaskIdsBySessionId":
          return Response.json([]);
        default:
          // 其余方法：给个安全默认值，避免测试因为无关方法失败
          return Response.json(null);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    tasks,
    stop: () => server.stop(true),
  };
}

let svc: ReturnType<typeof startFakeService>;

beforeAll(() => {
  svc = startFakeService();
});

afterAll(() => {
  svc.stop();
});

beforeEach(() => {
  svc.calls.length = 0;
  svc.tasks.clear();
});

describe("createRemoteTaskPort — MCP 通道走 service", () => {
  it("port 的 createTask 落到 service（owner 透传）", async () => {
    const port = createRemoteTaskPort({ endpoint: svc.url, authToken: "tok" });
    const record = await port.createTask({
      title: "via remote port",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess_mcp",
      owner: "ou_mcp",
    });
    expect(record.title).toBe("via remote port");
    expect(record.nativeId).toBe(String(record.id));
    expect((record as any).owner).toBe("ou_mcp");
    expect(svc.calls).toContain("createTask");
    expect(svc.tasks.size).toBe(1);
  });

  it("port 的 listTasks / updateTask / getTaskByNum 都打到 service", async () => {
    const port = createRemoteTaskPort({ endpoint: svc.url });
    const created = await port.createTask({
      title: "t1",
      project_path: "unknown",
      context: "{}",
      sessionId: "s",
    });

    const listed = await port.listTasks({ limit: 10 });
    expect(listed.total).toBe(1);

    const updated = await port.updateTask(created.nativeId, { title: "t2" });
    expect(updated?.title).toBe("t2");

    const byNum = await port.getTaskByNum!(created.id);
    expect(byNum?.id).toBe(created.id);

    expect(svc.calls).toContain("listTasks");
    expect(svc.calls).toContain("updateTask");
    expect(svc.calls).toContain("getTask");
  });

  it("optional 的 getOperationByNum / updateOperationByNum / deleteOperationByNum 存在（防水位检查降级）", () => {
    const port = createRemoteTaskPort({ endpoint: svc.url });
    expect(typeof port.getOperationByNum).toBe("function");
    expect(typeof port.updateOperationByNum).toBe("function");
    expect(typeof port.deleteOperationByNum).toBe("function");
  });
});

describe("MCP server + remote port — 工具面端到端", () => {
  it("task_create → task_get → task_update → task_operation_list 全走 service", async () => {
    const port = createRemoteTaskPort({ endpoint: svc.url, authToken: "tok" });
    const backend = new TaskStoreBackend(port, { sessionId: "sess_mcp" });
    const server = createTaskMcpServer(backend);

    const createdOut = (await server.callTool("task_create", {
      title: "MCP remote task",
      description: "d",
      owner: "ou_via_mcp",
    })) as string;
    const id = Number(/#(\d+)/.exec(createdOut)?.[1]);
    expect(id).toBeGreaterThan(0);

    // owner 经 MCP 落库
    expect(svc.tasks.get(id)?.owner).toBe("ou_via_mcp");

    // task_get 的 output 是 JSON 字符串（工具层约定）
    const got = JSON.parse((await server.callTool("task_get", { task_id: id })) as string);
    expect(got.title).toBe("MCP remote task");
    expect(got.owner).toBe("ou_via_mcp");

    await server.callTool("task_update", { task_id: id, owner: null });
    expect(svc.tasks.get(id)?.owner).toBeNull();

    // create 时 backend 自动写了 create operation，且经 remote port 落 service
    const ops = JSON.parse(
      (await server.callTool("task_operation_list", { task_id: id })) as string,
    );
    expect(Array.isArray(ops.operations)).toBe(true);
    expect(ops.operations.length).toBeGreaterThanOrEqual(1);
    expect(ops.operations[0].milestoneType).toBe("create");

    expect(svc.calls).toContain("createTask");
    expect(svc.calls).toContain("createOperation");
    expect(svc.calls).toContain("listOperations");
  });
});

describe("createTaskPortFromConfig — 按 task.storage.type 选 port", () => {
  function fakeConfig(values: Record<string, unknown>) {
    return { get: (key: string) => values[key] } as any;
  }

  it("type=sqlite → 本地 SQLite port（不碰网络）", async () => {
    const { port, kind } = await createTaskPortFromConfig(
      fakeConfig({ "task.storage.type": "sqlite" }),
      { dbPath: ":memory:" },
    );
    expect(kind).toBe("sqlite");
    const created = await port.createTask({
      title: "local",
      project_path: "unknown",
      context: "{}",
      sessionId: "s",
    });
    expect(created.id).toBeGreaterThan(0);
  });

  it("type=remote → remote port（打到 service）", async () => {
    const { port, kind } = await createTaskPortFromConfig(
      fakeConfig({
        "task.storage.type": "remote",
        "task.storage.endpoint": svc.url,
        "task.storage.authToken": "tok",
      }),
    );
    expect(kind).toBe("remote");
    const created = await port.createTask({
      title: "remote",
      project_path: "unknown",
      context: "{}",
      sessionId: "s",
    });
    expect(created.title).toBe("remote");
    expect(svc.calls).toContain("createTask");
  });

  it("type=remote 但缺 endpoint → 明确报错（与 initStore 同语义）", async () => {
    const err = await createTaskPortFromConfig(
      fakeConfig({ "task.storage.type": "remote" }),
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/task\.storage\.endpoint/);
  });
});
