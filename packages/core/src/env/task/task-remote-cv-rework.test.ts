/**
 * Task #5440 — CV（deepseek-v4.1-flash）第一轮 MAJOR 返工的 RED 测试。
 *
 * ## MAJOR-1：可选参数被写成 `null`，破坏 `TaskStore` 接口契约
 *
 * `TaskStore` 用 `?` 声明这些参数是可选的：
 *   searchTasksByKeywords(keywords, options?)
 *   findSimilarTasksByKeywords(keywords, options?)
 *   getTaskTree(taskId, depth?)
 *   getChildTasks(taskId, options?)
 *   findSimilarTasks(taskId, limit?)
 *   searchTasks(query, limit?)
 *   findTasksByContextValue(value, limit?)
 *   listTasks(options?) / listTags(options?)
 *
 * 第一版实现把省略的参数写成 `null` 透传（`options ?? null`），而 service 端
 * 用的是 **默认参数**（`depth: number = -1` / `options: X = {}`）——`null`
 * 不会触发默认值：
 *   - `getTaskTree(id, null)` → `depth !== -1 && 0 >= null` → **返回 []**
 *     （子任务静默丢失）
 *   - `searchTasks("q", null)` → `limit = null` → SQL `LIMIT null` → 500
 *
 * 契约要求：**省略就是省略**。client 必须裁掉尾随的可选参数，让服务端
 * 默认值生效。
 *
 * ## MAJOR-2：热更新 / 失败路径把 store 换掉了，但 tagService 还绑着旧 store
 *
 * `init()` 里 `this.tagService = new DefaultTagService(this.store)` 只建一次。
 * 第一版 `initStore()` 在**切换前**就 close 了旧 store，于是：
 *   1. 切到 remote 后，`createTag` 仍写进**本地** sqlite（静默分叉）
 *   2. remote 配置非法（缺 endpoint）时，旧 store 已被 close 但日志说
 *      "keeping previous store" —— 实际是个已关闭的 store，后续所有 task
 *      操作全部失败（任务子系统整体不可用，且日志撒谎）
 *
 * 正确语义：**先构造新 store，成功后再 close 旧 store 并重绑 tagService**；
 * 失败则旧 store 保持可用（既没被关，也没被替换）。
 */

import { describe, it, expect } from "bun:test";

import { RemoteTaskStore } from "./storage/remote-task-store";
import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";

// ============================================================================
// MAJOR-1：可选参数必须是「省略」而不是 null
// ============================================================================

/** 记录每个 /store/<method> 收到的 args（原样 JSON 解码后的数组）。 */
function startRecordingService(handlers: Record<string, (args: any[]) => unknown>) {
  const recorded: Array<{ method: string; args: any[] }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/version") {
        return Response.json({ protocol: { major: 1, minor: 0 }, engine: "sqlite" });
      }
      const method = url.pathname.replace("/store/", "");
      const body = (await req.json().catch(() => ({}))) as { args?: any[] };
      const args = Array.isArray(body.args) ? body.args : [body];
      recorded.push({ method, args });
      const handler = handlers[method];
      return Response.json(handler ? handler(args) : null);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, recorded, stop: () => server.stop(true) };
}

describe("MAJOR-1 — 省略的可选参数不能变成 null", () => {
  it("getTaskTree(id) 只发 1 个参数（否则 service 的 depth 默认值失效，返回空树）", async () => {
    const svc = startRecordingService({ getTaskTree: () => [] });
    const store = new RemoteTaskStore({ endpoint: svc.url });
    try {
      await store.getTaskTree(7);
      const call = svc.recorded.find((r) => r.method === "getTaskTree")!;
      expect(call.args.length).toBe(1);
      expect(call.args).toEqual([7]);
    } finally {
      store.close();
      svc.stop();
    }
  });

  it("getTaskTree(id, undefined) 同样只发 1 个参数", async () => {
    const svc = startRecordingService({ getTaskTree: () => [] });
    const store = new RemoteTaskStore({ endpoint: svc.url });
    try {
      await store.getTaskTree(7, undefined);
      expect(svc.recorded.find((r) => r.method === "getTaskTree")!.args).toEqual([7]);
    } finally {
      store.close();
      svc.stop();
    }
  });

  it("getTaskTree(id, 2) 仍然透传 depth", async () => {
    const svc = startRecordingService({ getTaskTree: () => [] });
    const store = new RemoteTaskStore({ endpoint: svc.url });
    try {
      await store.getTaskTree(7, 2);
      expect(svc.recorded.find((r) => r.method === "getTaskTree")!.args).toEqual([7, 2]);
    } finally {
      store.close();
      svc.stop();
    }
  });

  it("searchTasks(query) 只发 1 个参数（null limit 会让服务端 SQL 报错）", async () => {
    const svc = startRecordingService({ searchTasks: () => [] });
    const store = new RemoteTaskStore({ endpoint: svc.url });
    try {
      await store.searchTasks("q");
      expect(svc.recorded.find((r) => r.method === "searchTasks")!.args).toEqual(["q"]);
    } finally {
      store.close();
      svc.stop();
    }
  });

  it("findSimilarTasks(id) / findTasksByContextValue(v) 同样裁掉尾随可选参数", async () => {
    const svc = startRecordingService({});
    const store = new RemoteTaskStore({ endpoint: svc.url });
    try {
      await store.findSimilarTasks(7);
      await store.findTasksByContextValue("v");
      expect(svc.recorded.find((r) => r.method === "findSimilarTasks")!.args).toEqual([7]);
      expect(svc.recorded.find((r) => r.method === "findTasksByContextValue")!.args).toEqual(["v"]);
    } finally {
      store.close();
      svc.stop();
    }
  });

  it("searchTasksByKeywords(kw) / findSimilarTasksByKeywords(kw) 裁掉 options", async () => {
    const svc = startRecordingService({
      searchTasksByKeywords: () => ({ tasks: [], total: 0 }),
      findSimilarTasksByKeywords: () => [],
    });
    const store = new RemoteTaskStore({ endpoint: svc.url });
    try {
      await store.searchTasksByKeywords(["k"]);
      await store.findSimilarTasksByKeywords(["k"]);
      expect(svc.recorded.find((r) => r.method === "searchTasksByKeywords")!.args).toEqual([["k"]]);
      expect(svc.recorded.find((r) => r.method === "findSimilarTasksByKeywords")!.args).toEqual([
        ["k"],
      ]);
    } finally {
      store.close();
      svc.stop();
    }
  });

  it("getChildTasks(id) / listTasks() / listTags() 不发 null（服务端默认值生效）", async () => {
    const svc = startRecordingService({
      getChildTasks: () => ({ tasks: [], total: 0 }),
      listTasks: () => ({ tasks: [], total: 0 }),
      listTags: () => [],
    });
    const store = new RemoteTaskStore({ endpoint: svc.url });
    try {
      await store.getChildTasks(7);
      await store.listTasks();
      await store.listTags();
      expect(svc.recorded.find((r) => r.method === "getChildTasks")!.args).toEqual([7]);
      expect(svc.recorded.find((r) => r.method === "listTasks")!.args).toEqual([]);
      expect(svc.recorded.find((r) => r.method === "listTags")!.args).toEqual([]);
    } finally {
      store.close();
      svc.stop();
    }
  });

  it("显式传对象/数字时**不裁剪**（不能被「省掉 falsy」的逻辑吞掉）", async () => {
    const svc = startRecordingService({
      listTasks: () => ({ tasks: [], total: 0 }),
      searchTasks: () => [],
    });
    const store = new RemoteTaskStore({ endpoint: svc.url });
    try {
      await store.listTasks({ limit: 0, offset: 0 });
      await store.searchTasks("q", 0);
      expect(svc.recorded.find((r) => r.method === "listTasks")!.args).toEqual([
        { limit: 0, offset: 0 },
      ]);
      // limit=0 是调用方显式意图，必须原样透传
      expect(svc.recorded.find((r) => r.method === "searchTasks")!.args).toEqual(["q", 0]);
    } finally {
      store.close();
      svc.stop();
    }
  });
});

// ============================================================================
// MAJOR-2：store 切换必须原子（失败不动旧 store；成功后重绑 tagService）
// ============================================================================

function startTagService() {
  const tags: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/version") {
        return Response.json({ protocol: { major: 1, minor: 0 }, engine: "sqlite" });
      }
      const method = url.pathname.replace("/store/", "");
      const body = (await req.json().catch(() => ({}))) as { args?: any[] };
      const args = Array.isArray(body.args) ? body.args : [body];
      if (method === "createTag") {
        tags.push(String(args[0]));
        return Response.json({
          id: tags.length,
          name: String(args[0]),
          createdAt: new Date().toISOString(),
          taskCount: 0,
        });
      }
      if (method === "getTagByName") {
        const name = String(args[0]);
        const idx = tags.indexOf(name);
        return Response.json(
          idx >= 0
            ? { id: idx + 1, name, createdAt: new Date().toISOString(), taskCount: 0 }
            : null,
        );
      }
      return Response.json(null);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, tags, stop: () => server.stop(true) };
}

describe("MAJOR-2 — 切换 store 后 tagService 必须重绑；失败不能让旧 store 变废", () => {
  it("切到 remote 后 createTag 打到 service（不是本地库）", async () => {
    const svc = startTagService();
    const config = new ConfigComponent();
    const component = new TaskComponent();
    try {
      await component.init({
        options: {
          configComponent: config,
          config: {
            storage: {
              type: "sqlite",
              dbPath: `/tmp/task-rework-${Date.now()}-tag.db`,
            },
          },
        },
      });

      await config.set("task.storage.endpoint", svc.url);
      await config.set("task.storage.type", "remote");

      for (let i = 0; i < 80 && (component as any).store.constructor.name !== "RemoteTaskStore"; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((component as any).store.constructor.name).toBe("RemoteTaskStore");

      // tagService 必须已重绑到新 store
      await component.getTagService().createTag("tag-after-swap");
      for (let i = 0; i < 80 && svc.tags.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(svc.tags).toEqual(["tag-after-swap"]);
    } finally {
      await component.stop();
      svc.stop();
    }
  });

  it("remote 配置非法（缺 endpoint）时旧 store 仍然可用（日志不说谎）", async () => {
    const config = new ConfigComponent();
    const component = new TaskComponent();
    try {
      await component.init({
        options: {
          configComponent: config,
          config: {
            storage: { type: "sqlite", dbPath: `/tmp/task-rework-${Date.now()}-keep.db` },
          },
        },
      });

      const before = await component.createTask({
        title: "before swap",
        sessionId: "s",
        project_path: "unknown",
        context: "{}",
      });
      expect(before.id).toBeGreaterThan(0);

      // 触发一次必然失败的切换（type=remote 缺 endpoint）
      await config.set("task.storage.type", "remote");
      await new Promise((r) => setTimeout(r, 100));

      // 旧 store 没被 close、也没被替换 → 仍能正常读写
      const after = await component.createTask({
        title: "after failed swap",
        sessionId: "s",
        project_path: "unknown",
        context: "{}",
      });
      expect(after.id).toBeGreaterThan(before.id);
      expect((await component.getTask(after.id))?.title).toBe("after failed swap");
    } finally {
      await component.stop();
    }
  });

  it("remote 配置非法时 tagService 同样保持可用", async () => {
    const config = new ConfigComponent();
    const component = new TaskComponent();
    try {
      await component.init({
        options: {
          configComponent: config,
          config: { storage: { type: "sqlite", dbPath: `/tmp/task-rework-${Date.now()}-tag2.db` } },
        },
      });

      await config.set("task.storage.type", "remote");
      await new Promise((r) => setTimeout(r, 100));

      const tag = await component.getTagService().createTag("tag-after-failed-swap");
      expect(tag.name).toBe("tag-after-failed-swap");
    } finally {
      await component.stop();
    }
  });
});
