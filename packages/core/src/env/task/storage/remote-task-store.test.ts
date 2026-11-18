/**
 * Task #5440 (M2) — RemoteTaskStore 契约测试（TDD RED 先行）。
 *
 * 用本地 mock HTTP server 覆盖 **TaskStore 全量方法**（含 3 个 optional），
 * 以及方案 §5.3 的故障语义：
 *   - 401 → 明确报错（RemoteAuthError），不静默降级
 *   - 409 IDEMPOTENCY_CONFLICT → 明确报错，不重试
 *   - 503 BUSY（sqlite batch 占用连接）→ 有界重试后明确报错
 *   - 5xx / 网络错误 / 超时 → 有界重试（写方法带同一 Idempotency-Key，重放安全）
 *   - /version 握手：protocol.major 不匹配 → 明确报错
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  RemoteTaskStore,
  RemoteAuthError,
  RemoteBatchBusyError,
  RemoteIdempotencyConflictError,
  RemoteProtocolError,
} from "./remote-task-store";

// ============================================================================
// Mock HTTP server —— 记录每个 /store/<method> 调用，按 handler 返回
// ============================================================================

type Recorded = { method: string; args: any[]; idemKey: string | null };

interface MockHandle {
  url: string;
  calls: Recorded[];
  handlers: Map<string, (args: any[], call: Recorded) => unknown>;
  /** 前 N 次对某方法返回 503 BUSY */
  busyTimes: Map<string, number>;
  /** 强制某方法返回指定 HTTP 错误 */
  failures: Map<string, { status: number; body: unknown }>;
  /** 某方法延迟（毫秒） */
  delays: Map<string, number>;
  versionBody: unknown;
  reset(): void;
  stop(): void;
}

function startMock(): MockHandle {
  const calls: Recorded[] = [];
  const handlers = new Map<string, (args: any[], call: Recorded) => unknown>();
  const busyTimes = new Map<string, number>();
  const failures = new Map<string, { status: number; body: unknown }>();
  const delays = new Map<string, number>();
  const state: { versionBody: unknown } = {
    versionBody: { protocol: { major: 1, minor: 0 }, engine: "sqlite", storeSchema: "task-v1" },
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/version") {
        return Response.json(state.versionBody);
      }
      if (!path.startsWith("/store/")) {
        return new Response("not found", { status: 404 });
      }
      const method = path.slice("/store/".length);
      const body = (await req.json().catch(() => ({}))) as { args?: any[] };
      const args = Array.isArray(body.args) ? body.args : [body];
      const rec: Recorded = { method, args, idemKey: req.headers.get("idempotency-key") };
      calls.push(rec);

      const delay = delays.get(method);
      if (delay) await new Promise((r) => setTimeout(r, delay));

      const fail = failures.get(method);
      if (fail) return Response.json(fail.body, { status: fail.status });

      const remaining = busyTimes.get(method) ?? 0;
      if (remaining > 0) {
        busyTimes.set(method, remaining - 1);
        return Response.json(
          { error: { code: "BUSY", message: "batch in progress" } },
          { status: 503, headers: { "retry-after": "0" } },
        );
      }

      const handler = handlers.get(method);
      if (!handler) return Response.json({ error: { code: "METHOD_NOT_FOUND", message: method } }, { status: 404 });
      return Response.json(handler(args, rec) ?? null);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    handlers,
    busyTimes,
    failures,
    delays,
    get versionBody() {
      return state.versionBody;
    },
    set versionBody(v: unknown) {
      state.versionBody = v;
    },
    reset() {
      calls.length = 0;
      handlers.clear();
      busyTimes.clear();
      failures.clear();
      delays.clear();
      state.versionBody = { protocol: { major: 1, minor: 0 }, engine: "sqlite", storeSchema: "task-v1" };
    },
    stop() {
      server.stop(true);
    },
  } as MockHandle;
}

// ============================================================================
// Fixtures
// ============================================================================

const TASK = {
  id: 7,
  title: "demo",
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

const OPERATION = {
  id: 3,
  taskId: 7,
  sessionId: "s1",
  milestoneType: "progress" as const,
  milestoneTitle: "m",
  milestoneDescription: "d",
  processDescription: "p".repeat(120),
  timestamp: "2026-11-13T00:00:00.000Z",
};

const TAG = { id: 5, name: "t", createdAt: "2026-11-13T00:00:00.000Z", taskCount: 1 };

let mock: MockHandle;

beforeAll(() => {
  mock = startMock();
});

afterAll(() => {
  mock.stop();
});

function newStore(overrides: Partial<ConstructorParameters<typeof RemoteTaskStore>[0]> = {}) {
  return new RemoteTaskStore({
    endpoint: mock.url,
    authToken: "tok",
    maxRetries: 2,
    retryBaseDelayMs: 1,
    timeoutMs: 2_000,
    ...overrides,
  });
}

// ============================================================================
// 1. 全量方法映射
// ============================================================================

describe("RemoteTaskStore — TaskStore 全量方法 1:1 映射到 /store/<method>", () => {
  test("task CRUD", async () => {
    mock.reset();
    mock.handlers.set("createTask", () => TASK);
    mock.handlers.set("getTask", () => TASK);
    mock.handlers.set("updateTask", () => TASK);
    mock.handlers.set("deleteTask", () => true);
    mock.handlers.set("listTasks", () => ({ tasks: [TASK], total: 1 }));

    const store = newStore();
    const created = await store.createTask({
      title: "demo",
      sessionId: "s1",
      project_path: "unknown",
      context: "{}",
    });
    expect(created.id).toBe(7);

    expect((await store.getTask(7))?.title).toBe("demo");
    expect((await store.updateTask(7, { title: "x" }))?.id).toBe(7);
    expect(await store.deleteTask(7)).toBe(true);
    const listed = await store.listTasks({ limit: 5, status: "todo" });
    expect(listed.total).toBe(1);
    expect(listed.tasks[0].id).toBe(7);

    expect(mock.calls.map((c) => c.method)).toEqual([
      "createTask",
      "getTask",
      "updateTask",
      "deleteTask",
      "listTasks",
    ]);
    // 多参方法用 args 数组透传（顺序必须与服务端 apply 一致）
    expect(mock.calls[2].args[0]).toBe(7);
    expect(mock.calls[2].args[1]).toEqual({ title: "x" });
  });

  test("session 反查", async () => {
    mock.reset();
    mock.handlers.set("getTaskIdBySessionId", () => 7);
    mock.handlers.set("getTaskIdsBySessionId", () => [7, 8]);

    const store = newStore();
    expect(await store.getTaskIdBySessionId("s1")).toBe(7);
    expect(await store.getTaskIdsBySessionId("s1")).toEqual([7, 8]);
  });

  test("operation CRUD（含 optional 的 listOperationsFresh / invalidateOperationsCache）", async () => {
    mock.reset();
    mock.handlers.set("createOperation", () => OPERATION);
    mock.handlers.set("getOperation", () => OPERATION);
    mock.handlers.set("updateOperation", () => OPERATION);
    mock.handlers.set("deleteOperation", () => true);
    mock.handlers.set("listOperations", () => [OPERATION]);
    mock.handlers.set("listOperationsFresh", () => [OPERATION]);
    mock.handlers.set("invalidateOperationsCache", () => null);

    const store = newStore();
    const op = await store.createOperation({
      taskId: 7,
      sessionId: "s1",
      milestoneType: "progress",
      milestoneTitle: "m",
      processDescription: "p".repeat(120),
    });
    expect(op.id).toBe(3);
    expect((await store.getOperation(3))?.id).toBe(3);
    expect((await store.updateOperation(3, { milestoneTitle: "n" }))?.id).toBe(3);
    expect(await store.deleteOperation(3)).toBe(true);
    expect((await store.listOperations({ taskId: 7 })).length).toBe(1);

    // optional 方法必须**真实存在**（防水位检查静默降级 → 方案风险 #5）
    expect(typeof store.listOperationsFresh).toBe("function");
    expect(typeof store.invalidateOperationsCache).toBe("function");

    const fresh = await store.listOperationsFresh!({ taskId: 7 });
    expect(fresh.length).toBe(1);

    store.invalidateOperationsCache!(7);
    // fire-and-forget：轮询等待请求发出
    for (let i = 0; i < 50 && !mock.calls.some((c) => c.method === "invalidateOperationsCache"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(mock.calls.some((c) => c.method === "invalidateOperationsCache")).toBe(true);
  });

  test("tag CRUD + task↔tag 关联", async () => {
    mock.reset();
    mock.handlers.set("createTag", () => TAG);
    mock.handlers.set("getTag", () => TAG);
    mock.handlers.set("getTagByName", () => TAG);
    mock.handlers.set("listTags", () => [TAG]);
    mock.handlers.set("searchTags", () => [TAG]);
    mock.handlers.set("deleteTag", () => true);
    mock.handlers.set("addTagsToTask", () => null);
    mock.handlers.set("removeTagsFromTask", () => null);
    mock.handlers.set("getTagsForTask", () => [TAG]);
    mock.handlers.set("getTaskIdsByTags", () => [7]);
    mock.handlers.set("updateTaskTags", () => null);

    const store = newStore();
    expect((await store.createTag("t")).name).toBe("t");
    expect((await store.getTag(5))?.id).toBe(5);
    expect((await store.getTagByName("t"))?.id).toBe(5);
    expect((await store.listTags({ limit: 3 })).length).toBe(1);
    expect((await store.searchTags({ query: "t" })).length).toBe(1);
    await store.addTagsToTask(7, [5]);
    await store.removeTagsFromTask(7, [5]);
    expect((await store.getTagsForTask(7)).length).toBe(1);
    expect(await store.getTaskIdsByTags(["t"])).toEqual([7]);
    await store.updateTaskTags(7, ["t"]);
    expect(await store.deleteTag(5)).toBe(true);

    expect(mock.calls.find((c) => c.method === "addTagsToTask")!.args).toEqual([7, [5]]);
  });

  test("检索能力（含 depth / tree / search 变体）", async () => {
    mock.reset();
    mock.handlers.set("searchTasksByKeywords", () => ({ tasks: [TASK], total: 1 }));
    mock.handlers.set("findSimilarTasksByKeywords", () => [TASK]);
    mock.handlers.set("getTaskTree", () => [TASK]);
    mock.handlers.set("getChildTasks", () => ({ tasks: [TASK], total: 1 }));
    mock.handlers.set("findSimilarTasks", () => [TASK]);
    mock.handlers.set("searchTasks", () => [TASK]);
    mock.handlers.set("findTasksByContextValue", () => [TASK]);

    const store = newStore();
    expect((await store.searchTasksByKeywords(["a"], { depth: 2 })).total).toBe(1);
    expect((await store.findSimilarTasksByKeywords(["a"], { limit: 3 })).length).toBe(1);
    expect((await store.getTaskTree(7, 2)).length).toBe(1);
    expect((await store.getChildTasks(7)).total).toBe(1);
    expect((await store.findSimilarTasks(7, 3)).length).toBe(1);
    expect((await store.searchTasks("q", 3)).length).toBe(1);
    expect((await store.findTasksByContextValue("v", 3)).length).toBe(1);
  });
});

// ============================================================================
// 2. 幂等 key / 鉴权头 / version 握手
// ============================================================================

describe("RemoteTaskStore — 传输契约", () => {
  test("写方法带 Idempotency-Key，读方法不带", async () => {
    mock.reset();
    mock.handlers.set("createTask", () => TASK);
    mock.handlers.set("getTask", () => TASK);

    const store = newStore();
    await store.createTask({ title: "a", sessionId: "s", project_path: "unknown", context: "{}" });
    await store.getTask(7);

    const create = mock.calls.find((c) => c.method === "createTask")!;
    const get = mock.calls.find((c) => c.method === "getTask")!;
    expect(typeof create.idemKey).toBe("string");
    expect(create.idemKey!.length).toBeGreaterThan(8);
    expect(get.idemKey).toBeNull();
  });

  test("每次写调用用**不同**的幂等 key（同一 key 会命中服务端重放缓存）", async () => {
    mock.reset();
    mock.handlers.set("createTag", () => TAG);
    const store = newStore();
    await store.createTag("a");
    await store.createTag("b");
    const keys = mock.calls.map((c) => c.idemKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("version 握手：major 不匹配 → RemoteProtocolError 且不发业务请求", async () => {
    mock.reset();
    mock.versionBody = { protocol: { major: 2, minor: 0 }, engine: "sqlite", storeSchema: "task-v1" };
    const store = newStore();
    await expect(store.getTask(7)).rejects.toBeInstanceOf(RemoteProtocolError);
    expect(mock.calls.filter((c) => c.method === "getTask").length).toBe(0);
  });

  test("version 握手只做一次（后续调用复用）", async () => {
    mock.reset();
    mock.handlers.set("getTask", () => TASK);
    const store = newStore();
    await store.getTask(7);
    await store.getTask(7);
    // /version 不在 calls 里（只有 /store/* 被记录），用 store 内部计数断言
    expect(store.getStats().handshakes).toBe(1);
  });

  test("Bearer token 随请求发送", async () => {
    mock.reset();
    mock.handlers.set("getTask", () => TASK);
    const sent: (string | null)[] = [];
    const store = newStore({
      fetchImpl: (async (input: any, init: any) => {
        const url = String(input);
        if (url.endsWith("/version")) {
          // 握手请求不参与断言（无 auth 头也可）
          return Response.json({ protocol: { major: 1, minor: 0 }, engine: "sqlite" });
        }
        sent.push(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify(TASK), {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    await store.getTask(7);
    expect(sent).toEqual(["Bearer tok"]);
  });
});

// ============================================================================
// 3. 故障语义（方案 §5.3：无本地降级）
// ============================================================================

describe("RemoteTaskStore — 故障语义", () => {
  test("401 → RemoteAuthError（不重试）", async () => {
    mock.reset();
    mock.failures.set("getTask", { status: 401, body: { error: { code: "UNAUTHORIZED", message: "bad token" } } });
    const store = newStore();
    await expect(store.getTask(7)).rejects.toBeInstanceOf(RemoteAuthError);
    expect(mock.calls.filter((c) => c.method === "getTask").length).toBe(1);
  });

  test("401 报错信息含 endpoint 与排障指引（不静默 fallback local）", async () => {
    mock.reset();
    mock.failures.set("getTask", { status: 401, body: { error: { code: "UNAUTHORIZED", message: "bad token" } } });
    const store = newStore();
    const err = (await store.getTask(7).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(RemoteAuthError);
    expect(err.message).toContain(mock.url);
    expect(err.message.toLowerCase()).toContain("task.storage.authtoken");
  });

  test("503 BUSY（batch 进行中）→ 有界重试后 RemoteBatchBusyError", async () => {
    mock.reset();
    mock.handlers.set("createTask", () => TASK);
    mock.busyTimes.set("createTask", 99);
    const store = newStore({ maxRetries: 2 });
    await expect(
      store.createTask({ title: "a", sessionId: "s", project_path: "unknown", context: "{}" }),
    ).rejects.toBeInstanceOf(RemoteBatchBusyError);
    // 首次 + 2 次重试
    expect(mock.calls.filter((c) => c.method === "createTask").length).toBe(3);
  });

  test("503 BUSY 短暂后恢复 → 重试成功，且重试复用**同一** Idempotency-Key", async () => {
    mock.reset();
    mock.handlers.set("createTask", () => TASK);
    mock.busyTimes.set("createTask", 1);
    const store = newStore({ maxRetries: 2 });
    const task = await store.createTask({
      title: "a",
      sessionId: "s",
      project_path: "unknown",
      context: "{}",
    });
    expect(task.id).toBe(7);
    const keys = mock.calls.filter((c) => c.method === "createTask").map((c) => c.idemKey);
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test("409 IDEMPOTENCY_CONFLICT → RemoteIdempotencyConflictError（不重试）", async () => {
    mock.reset();
    mock.failures.set("createTask", {
      status: 409,
      body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "key reused with different payload" } },
    });
    const store = newStore();
    await expect(
      store.createTask({ title: "a", sessionId: "s", project_path: "unknown", context: "{}" }),
    ).rejects.toBeInstanceOf(RemoteIdempotencyConflictError);
    expect(mock.calls.filter((c) => c.method === "createTask").length).toBe(1);
  });

  test("404 METHOD_NOT_FOUND → RemoteProtocolError（服务端版本过旧）", async () => {
    mock.reset();
    const store = newStore();
    // 未注册 handler → mock 返回 404 METHOD_NOT_FOUND
    await expect(store.searchTasks("q")).rejects.toBeInstanceOf(RemoteProtocolError);
  });

  test("超时 → 有界重试后抛出原始错误", async () => {
    mock.reset();
    mock.handlers.set("getTask", () => TASK);
    mock.delays.set("getTask", 200);
    const store = newStore({ timeoutMs: 30, maxRetries: 1, retryBaseDelayMs: 1 });
    await expect(store.getTask(7)).rejects.toBeTruthy();
    // 首次 + 1 次重试
    expect(mock.calls.filter((c) => c.method === "getTask").length).toBe(2);
  });

  test("5xx → 有界重试", async () => {
    mock.reset();
    mock.failures.set("listTags", { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } });
    const store = newStore({ maxRetries: 1 });
    await expect(store.listTags()).rejects.toBeTruthy();
    expect(mock.calls.filter((c) => c.method === "listTags").length).toBe(2);
  });

  test("close() 后再调用 → 明确报错（不复用已关闭 store）", async () => {
    mock.reset();
    const store = newStore();
    store.close();
    await expect(store.getTask(7)).rejects.toThrow(/closed/i);
  });
});

// ============================================================================
// 4. 形状兼容：不吞字段（owner / context / goals）
// ============================================================================

describe("RemoteTaskStore — 返回值直通", () => {
  test("owner 字段原样返回（create / get / update 三路）", async () => {
    mock.reset();
    const withOwner = { ...TASK, owner: "ou_123" };
    mock.handlers.set("createTask", () => withOwner);
    mock.handlers.set("getTask", () => withOwner);
    mock.handlers.set("updateTask", () => ({ ...withOwner, owner: null }));

    const store = newStore();
    expect(
      (await store.createTask({
        title: "a",
        sessionId: "s",
        project_path: "unknown",
        context: "{}",
        owner: "ou_123",
      })).owner,
    ).toBe("ou_123");
    expect((await store.getTask(7))!.owner).toBe("ou_123");
    expect((await store.updateTask(7, { owner: null }))!.owner).toBeNull();

    // owner 必须真的被发出去（不是本地丢弃）
    expect(mock.calls[0].args[0].owner).toBe("ou_123");
    expect(mock.calls[2].args[1]).toEqual({ owner: null });
  });

  test("undefined 返回值（getTask 未命中）保持 undefined，不变成 null", async () => {
    mock.reset();
    mock.handlers.set("getTask", () => null);
    const store = newStore();
    // 服务端 Response.json(undefined ?? null) → null；client 归一化为 undefined
    expect(await store.getTask(999)).toBeUndefined();
  });
});
