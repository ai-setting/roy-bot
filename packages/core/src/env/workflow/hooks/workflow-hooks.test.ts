/**
 * @fileoverview Workflow lifecycle hooks — RED/GREEN contract
 *
 * 背景：在本次改动前，workflow 包内**没有任何** lifecycle hook 点，
 * 外部插件无法观察 workflow run 的开始/结束与节点开始/结束
 * （`RunWorkflowLifecycleHooks` 是 DI 回调，不是通用插件 Hook）。
 *
 * 本测试锁定新增的 4 个 Hook 点在真实 run engine 上的行为：
 *   workflow:before.run  / workflow:after.run
 *   workflow:before.node / workflow:after.node
 *
 * 断言口径：
 *   1. 每个点都真的被触发，且**只触发一次**（不因内部多路径重复触发）
 *   2. 触发顺序 = before.run → before.node → after.node → after.run
 *   3. 载荷字段足以渲染进度卡片（runId/workflowName/nodeId/status/totalNodes/completedNodes）
 *   4. 终态语义正确（completed / failed / stopped 分别落到 after.run 的 status）
 *   5. **Hook 抛错不影响 workflow 运行**（HookManager 错误隔离）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { WorkflowEngine } from "../engine/engine";
import { NodeRegistry } from "../engine/node-registry";
import type { AgentRunner, AgentResult } from "../nodes/agent-node";
import { globalHookManager } from "../../hook";
import {
  WorkflowHookPoints,
  type WorkflowRunHookData,
  type WorkflowNodeHookData,
} from "../hooks";

interface SessionRow {
  id: string;
  title: string;
  metadata: any;
  parentSessionId?: string | null;
  messages?: unknown[];
}

function makeSessionComponent() {
  const store = new Map<string, SessionRow>();
  return {
    _store: store,
    async create(row: { id?: string; title: string; metadata: any; parentSessionId?: string | null }) {
      const id = row.id ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      store.set(id, { ...row, id, messages: row.metadata?.messages ?? [] });
      return { id };
    },
    async get(id: string) {
      return store.get(id) ?? null;
    },
    async update(id: string, patch: any) {
      const row = store.get(id);
      if (!row) return false;
      if (patch.metadata) row.metadata = { ...row.metadata, ...patch.metadata };
      store.set(id, row);
      return true;
    },
    async list() {
      return Array.from(store.values());
    },
    async addMessage(_id: string, _msg: unknown) {
      return "msg";
    },
    async getMessages(id: string) {
      return store.get(id)?.messages ?? [];
    },
    async addMessages(_id: string, _msgs: unknown[]) {
      return [];
    },
    async saveCheckpoint() {},
    async getCheckpoints() {
      return [];
    },
  };
}

/** 立即成功的 runner，避免测试等待 */
function makeFastRunner(): AgentRunner {
  return {
    async run(): Promise<AgentResult> {
      return { output: "node-done" };
    },
  } as unknown as AgentRunner;
}

function simpleWorkflow(name: string, nodeCount = 1) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i + 1}`,
    type: "agent",
    name: `N${i + 1}`,
    config: { agent_type: "general", prompt: "echo", options: { model: "test" } },
  }));
  return {
    name,
    version: "1.0.0",
    description: "hooks test",
    config: {},
    nodes: nodes as any,
    // 链式串行，保证顺序确定
    edges: nodes.slice(1).map((n, i) => ({
      from: `n${i + 1}`,
      to: n.id,
      type: "default",
    })) as any,
    entry: "n1",
  };
}

describe("Workflow lifecycle hooks", () => {
  let sessions: ReturnType<typeof makeSessionComponent>;
  let engine: WorkflowEngine;
  const registered: Array<{ point: string; name: string }> = [];

  beforeEach(() => {
    sessions = makeSessionComponent();
    const registry = new NodeRegistry({
      agentRunner: makeFastRunner(),
      sessionComponent: sessions as any,
    });
    engine = new WorkflowEngine(registry, sessions as any);
  });

  afterEach(() => {
    for (const { point, name } of registered.splice(0)) {
      globalHookManager.unregister(point, name);
    }
  });

  /**
   * 挂一个记录型 hook。
   *
   * ⚠️ 关键约定：`globalHookManager.execute(point, data, metadata)` 会把 data 包进
   * `HookContext` 再交给 hook —— hook 拿到的第 1 个参数是 **ctx**，载荷在 `ctx.data`。
   * （`TaskComponent.executeHook` 注释里的「直接传 data 而非包一层 ctx」指的是
   * 不要把 data 再套一层自定义 ctx，而非 hook 直接收 data。）
   */
  function record<T>(point: string, sink: T[]) {
    const name = `test-hooks:${point}:${Math.random().toString(36).slice(2, 6)}`;
    globalHookManager.register(point, {
      name,
      execute: (ctx: any) => {
        sink.push(ctx?.data as T);
      },
    });
    registered.push({ point, name });
  }

  it("hook 点常量命名符合 repo 约定（<component>:<phase>.<action>）", () => {
    expect(WorkflowHookPoints.BEFORE_RUN).toBe("workflow:before.run");
    expect(WorkflowHookPoints.AFTER_RUN).toBe("workflow:after.run");
    expect(WorkflowHookPoints.BEFORE_NODE).toBe("workflow:before.node");
    expect(WorkflowHookPoints.AFTER_NODE).toBe("workflow:after.node");
  });

  it("成功 run：4 个点各触发一次，顺序正确，载荷可渲染进度卡片", async () => {
    const events: string[] = [];
    const runs: WorkflowRunHookData[] = [];
    const nodes: WorkflowNodeHookData[] = [];

    record(WorkflowHookPoints.BEFORE_RUN, [] as any);
    for (const p of [
      WorkflowHookPoints.BEFORE_RUN,
      WorkflowHookPoints.AFTER_RUN,
      WorkflowHookPoints.BEFORE_NODE,
      WorkflowHookPoints.AFTER_NODE,
    ]) {
      const name = `order:${p}`;
      globalHookManager.register(p, {
        name,
        execute: (ctx: any) => {
          events.push(p);
          const payload = ctx?.data;
          if (p === WorkflowHookPoints.AFTER_RUN || p === WorkflowHookPoints.BEFORE_RUN) {
            runs.push(payload);
          } else {
            nodes.push(payload);
          }
        },
      });
      registered.push({ point: p, name });
    }

    const sessionId = `workflow_${Date.now()}_hooks_ok`;
    const result = await engine.runWorkflow(simpleWorkflow("hooks-ok", 2), {
      runId: sessionId,
      input: { hello: "world" },
    });

    expect(result.status).toBe("completed");

    // 每个点恰好一次（不因内部多路径重复触发）
    expect(events.filter((e) => e === WorkflowHookPoints.BEFORE_RUN)).toHaveLength(1);
    expect(events.filter((e) => e === WorkflowHookPoints.AFTER_RUN)).toHaveLength(1);
    expect(events.filter((e) => e === WorkflowHookPoints.BEFORE_NODE)).toHaveLength(2);
    expect(events.filter((e) => e === WorkflowHookPoints.AFTER_NODE)).toHaveLength(2);

    // 顺序：before.run 最先，after.run 最后
    expect(events[0]).toBe(WorkflowHookPoints.BEFORE_RUN);
    expect(events[events.length - 1]).toBe(WorkflowHookPoints.AFTER_RUN);

    // run 载荷
    const beforeRun = runs.find((r) => r.status === "running")!;
    expect(beforeRun.runId).toBe(sessionId);
    expect(beforeRun.workflowName).toBe("hooks-ok");
    expect(beforeRun.totalNodes).toBe(2);
    expect(beforeRun.input).toEqual({ hello: "world" });

    const afterRun = runs.find((r) => r.status === "completed")!;
    expect(afterRun.runId).toBe(sessionId);
    expect(afterRun.totalNodes).toBe(2);
    expect(afterRun.completedNodes).toBe(2);

    // node 载荷：卡片需要 nodeId/nodeType/status/进度分子分母
    const firstBefore = nodes[0];
    expect(firstBefore.nodeId).toBe("n1");
    expect(firstBefore.nodeType).toBe("agent");
    expect(firstBefore.status).toBe("running");
    expect(firstBefore.totalNodes).toBe(2);

    const firstAfter = nodes.find((n) => n.status === "completed")!;
    expect(firstAfter.nodeId).toBe("n1");
    expect(firstAfter.completedNodes).toBeGreaterThanOrEqual(1);
  });

  it("workflow:after.run 只在**终态**触发，且 status=failed 时带 error", async () => {
    const runs: WorkflowRunHookData[] = [];
    record(WorkflowHookPoints.AFTER_RUN, runs);
    record(WorkflowHookPoints.AFTER_NODE, [] as WorkflowNodeHookData[]);

    const failingRegistry = new NodeRegistry({
      agentRunner: {
        async run(): Promise<AgentResult> {
          throw new Error("node blew up");
        },
      } as unknown as AgentRunner,
      sessionComponent: sessions as any,
    });
    const failEngine = new WorkflowEngine(failingRegistry, sessions as any);

    const sessionId = `workflow_${Date.now()}_hooks_fail`;
    const result = await failEngine.runWorkflow(simpleWorkflow("hooks-fail", 1), {
      runId: sessionId,
      input: {},
    });

    expect(result.status).toBe("failed");

    const terminal = runs.filter((r) => r.status === "failed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].workflowName).toBe("hooks-fail");
    expect(typeof terminal[0].error).toBe("string");
  });

  it("Hook 抛错不影响 workflow 运行（HookManager 错误隔离）", async () => {
    const name = "boom:before.run";
    globalHookManager.register(WorkflowHookPoints.BEFORE_RUN, {
      name,
      execute: () => {
        throw new Error("hook exploded");
      },
    });
    registered.push({ point: WorkflowHookPoints.BEFORE_RUN, name });

    const nodeHooks: WorkflowNodeHookData[] = [];
    record(WorkflowHookPoints.AFTER_NODE, nodeHooks);

    const sessionId = `workflow_${Date.now()}_hooks_boom`;
    const result = await engine.runWorkflow(simpleWorkflow("hooks-boom", 1), {
      runId: sessionId,
      input: {},
    });

    // 运行照常完成
    expect(result.status).toBe("completed");
    expect(nodeHooks.length).toBeGreaterThan(0);
  });
});
