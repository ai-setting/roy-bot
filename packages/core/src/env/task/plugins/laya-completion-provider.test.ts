/**
 * Task #4804 — completion hook 的 provider 选择（goal-decision 分离）
 *
 * 验证点：completion hook（LayaCompletionPlugin）读 auth.json 时
 *   1. 优先取 providers["laya-goal-decision"]（model=task-completion）
 *   2. goal 专用缺失 → 保守回退 providers["laya-decision"]
 *   3. 都缺失 → fail-open（不构造 port，不调模型）
 *
 * 用本地 HTTP server 截获 LayaDecisionPort 发出的真实请求，
 * 断言 body.model —— 这是最接近真实链路的 provider 选择证据。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { LayaCompletionPlugin } from "./laya-completion-plugin";
import type { TaskCompleteResultContext } from "../hooks/contexts";
import type { Task } from "../types";

let dir: string;
try {
  dir = mkdtempSync(join(tmpdir(), "laya-completion-prov-"));
} catch {
  dir = "/tmp";
}

const cleanupFns: Array<() => void> = [];
afterEach(() => {
  while (cleanupFns.length) cleanupFns.pop()!();
});

interface CapturedReq {
  model: string;
  url: string;
}

/** 本地 HTTP server：截获 /v1/systemone 请求的 body.model */
async function startCaptureServer(): Promise<{
  url: string;
  reqs: CapturedReq[];
  stop: () => void;
}> {
  const reqs: CapturedReq[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/systemone") {
        const body = (await req.json()) as { model?: string };
        reqs.push({ model: body.model ?? "", url: req.url });
      }
      return Response.json({
        answers: {
          completion_check: {
            choice: "FAIL_INCOMPLETE",
            confidence: 0.97,
            x_jev_confidence: 0.97,
          },
        },
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  cleanupFns.push(() => server.stop(true));
  return { url, reqs, stop: () => server.stop(true) };
}

function writeAuth(providers: Record<string, unknown>): string {
  const p = join(dir, `auth-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ providers }));
  return p;
}

function makeCtx(task: Task): TaskCompleteResultContext {
  return {
    task,
    changes: { status: "completed" },
    terminalStatus: "completed",
    sessionId: "s1",
    tagService: {} as any,
  };
}

function fakeTaskComponent(ops: Array<{ milestoneType: string; title: string; description: string }>) {
  return {
    listOperations: async () => ops,
    getTask: async () => null,
    updateTask: async () => ({}),
    createOperation: async () => ({}),
  };
}

function makeTask(): Task {
  return {
    id: 4804,
    title: "验证 provider 分离",
    description: "completion hook 应走 laya-goal-decision",
    goals_and_expected_deliverables: "1. hint fire\n2. report",
    context: JSON.stringify({ type: "feature" }),
  } as unknown as Task;
}

describe("Task #4804 — completion hook provider 选择", () => {
  test("goal 专用 provider 存在 → 请求 model=task-completion（v13e）", async () => {
    const srv = await startCaptureServer();
    const authPath = writeAuth({
      "laya-goal-decision": {
        baseURL: srv.url,
        apiKey: "k-goal",
        model: "task-completion",
      },
      "laya-decision": {
        baseURL: "http://should-not-be-used:1",
        apiKey: "k-shared",
        model: "task-decision",
      },
    });
    const plugin = new LayaCompletionPlugin({ authPath });
    await plugin.execute(makeCtx(makeTask()), fakeTaskComponent([
      { milestoneType: "create", title: "创建任务", description: "初始化" },
      { milestoneType: "milestone", title: "做了一半", description: "RED 完成" },
    ]));
    expect(srv.reqs.length).toBe(1);
    expect(srv.reqs[0].model).toBe("task-completion");
    expect(srv.reqs[0].url).toContain(srv.url);
  });

  test("goal 专用缺失 → 回退 laya-decision（model=task-decision）", async () => {
    const srv = await startCaptureServer();
    const authPath = writeAuth({
      "laya-decision": {
        baseURL: srv.url,
        apiKey: "k-shared",
        model: "task-decision",
      },
    });
    const plugin = new LayaCompletionPlugin({ authPath });
    await plugin.execute(makeCtx(makeTask()), fakeTaskComponent([
      { milestoneType: "create", title: "创建任务", description: "初始化" },
    ]));
    expect(srv.reqs.length).toBe(1);
    expect(srv.reqs[0].model).toBe("task-decision");
  });

  test("两者都缺失 → 不发任何模型请求（fail-open）", async () => {
    const srv = await startCaptureServer();
    const authPath = writeAuth({
      openai: { baseURL: srv.url, apiKey: "k", model: "gpt" },
    });
    const plugin = new LayaCompletionPlugin({ authPath });
    await plugin.execute(makeCtx(makeTask()), fakeTaskComponent([
      { milestoneType: "create", title: "创建任务", description: "初始化" },
    ]));
    expect(srv.reqs.length).toBe(0);
  });
});
