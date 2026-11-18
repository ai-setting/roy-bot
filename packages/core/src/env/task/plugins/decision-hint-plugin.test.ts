/**
 * @fileoverview Task #4467 — decision-hint plugin 端到端单测（mock decision port）
 *
 * 契约：/tmp/task-create-verdict-contract-v2.md
 *
 * 覆盖门槛行为：
 *   - 候选 0 个 → 放行，不调模型，无 hint
 *   - 候选 1 个 → 不调模型，直接给「建议复用 #id」hint
 *   - 候选 ≥2 个 → 调 decision model，按 confidence 三档产出 hint
 *   - parent 已传入时：同 root 静默，不同 root 产出 remount hint
 *   - 决策异常 → 降级放行，不抛错
 *
 * ⚠️ 测试**不真调 API**：传一个假 DecisionPort 返回固定答案。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { DecisionHintPlugin } from "./decision-hint-plugin";
import type { DecisionPort, DecisionRequest, DecisionResponse } from "./decision-port";
import type { TaskCreateContext } from "../hooks/contexts";
import type { CreateTaskOptions, Task } from "../types";

// ========================================================================
// Fake fixtures
// ========================================================================

interface FakeTask {
  id: number;
  title: string;
  status: Task["status"];
  type: Task["type"];
  description: string;
  tags: string[];
  parent_task_id?: number;
}

function task(over: Partial<FakeTask> & { id: number }): Task {
  return {
    id: over.id,
    title: over.title ?? `task ${over.id}`,
    description: over.description ?? "",
    status: over.status ?? "todo",
    priority: "medium",
    type: over.type ?? "normal",
    progress: 0,
    current_status: "",
    goals_and_expected_deliverables: "",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    tags: over.tags ?? [],
    project_path: "/p",
    context: "{}",
    ...(over.parent_task_id !== undefined ? { parent_task_id: over.parent_task_id } : {}),
  } as Task;
}

/** 假 port：记录调用次数，返回预设答案 */
class FakeDecisionPort implements DecisionPort {
  calls: DecisionRequest[] = [];
  disabled = false;
  constructor(
    private readonly answer: (req: DecisionRequest) => DecisionResponse,
    private readonly throwErr?: Error,
  ) {}

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    this.calls.push(req);
    if (this.throwErr) throw this.throwErr;
    return this.answer(req);
  }

  isDisabled(): boolean {
    return this.disabled;
  }
}

function makeTaskComponentStub(tasks: FakeTask[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    async getTask(id: number): Promise<Task | undefined> {
      return byId.get(id);
    },
    async listTasks(options?: any): Promise<{ tasks: Task[]; total: number }> {
      let list = [...byId.values()];
      if (options?.depth === 0) list = list.filter((t) => t.parent_task_id === undefined);
      if (options?.type) list = list.filter((t) => t.type === options.type);
      return { tasks: list, total: list.length };
    },
    async searchTasksByKeywords(keywords: string[], options?: any): Promise<{ tasks: Task[]; total: number }> {
      const kws = keywords.map((k) => k.toLowerCase());
      const list = [...byId.values()].filter((t) => {
        if (options?.include_archived === false && t.status === "archived") return false;
        const inTitle = kws.some((k) => t.title.toLowerCase().includes(k));
        const inTags = (t.tags ?? []).some((tag) => kws.some((k) => tag.toLowerCase().includes(k)));
        return inTitle || inTags;
      });
      return { tasks: list, total: list.length };
    },
    async getChildTasks(taskId: number): Promise<{ tasks: Task[]; total: number }> {
      const list = [...byId.values()].filter((t) => t.parent_task_id === taskId);
      return { tasks: list, total: list.length };
    },
  };
}

function makeCtx(
  options: Partial<CreateTaskOptions> & { context: string },
  taskComponent?: any,
): TaskCreateContext {
  return {
    options: {
      title: options.title ?? "new task",
      sessionId: "sess-1",
      project_path: options.project_path ?? "/p",
      context: options.context,
      ...(options.tags ? { tags: options.tags } : {}),
      ...(options.parent_task_id !== undefined ? { parent_task_id: options.parent_task_id } : {}),
    },
    sessionId: "sess-1",
    tagService: {} as any,
    ...(taskComponent ? { taskComponent } : {}),
  } as TaskCreateContext;
}

// ========================================================================
// Tests
// ========================================================================

describe("DecisionHintPlugin — candidate thresholds", () => {
  let port: FakeDecisionPort;

  beforeEach(() => {
    port = new FakeDecisionPort(() => ({
      answers: { reuse_or_create: { choice: "#1", confidence: 0.9 } },
    }));
  });

  test("0 candidates → no model call, no hint", async () => {
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [] }) },
      makeTaskComponentStub([]),
    );

    await plugin.execute(ctx as any);

    expect(port.calls).toHaveLength(0);
    expect(JSON.parse(ctx.options.context).decision_hint).toBeUndefined();
  });

  test("1 candidate → no model call, hint suggests reusing it", async () => {
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [4447] }) },
      makeTaskComponentStub([task({ id: 4447, title: "[E2E] run3", status: "completed" })]),
    );

    await plugin.execute(ctx as any);

    expect(port.calls).toHaveLength(0);
    const hint = JSON.parse(ctx.options.context).decision_hint;
    expect(hint).toContain("[TASK_CREATE_HINT]");
    expect(hint).toContain("task_update(task_id=4447");
  });

  test("≥2 candidates → model IS called", async () => {
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [4447, 4399] }) },
      makeTaskComponentStub([
        task({ id: 4447, title: "[E2E] run3", status: "completed" }),
        task({ id: 4399, title: "[Investigate] extractor", status: "active" }),
      ]),
    );

    await plugin.execute(ctx as any);

    expect(port.calls).toHaveLength(1);
    // state / questions 必须是顶层键（载体实测：标准 chat/completions 会 400）
    const req = port.calls[0];
    expect(req.state).toBeDefined();
    expect(req.questions).toBeDefined();
    expect(req.questions.reuse_or_create).toBeDefined();
  });

  test("fallback: empty similar_task_ids + tags → retrieval finds candidates", async () => {
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [] }), tags: ["decision-model"] },
      makeTaskComponentStub([
        task({ id: 4469, title: "[Decision 请求契约] ...", tags: ["decision-model"] }),
        task({ id: 4467, title: "[Task 创建检测] ...", tags: ["decision-model"] }),
      ]),
    );

    await plugin.execute(ctx as any);

    // 兜底检索命中 2 个 → 调模型
    expect(port.calls).toHaveLength(1);
  });

  test("fallback: no tags and no ids → 0 candidates, no model call", async () => {
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx({ context: JSON.stringify({ similar_task_ids: [] }) }, makeTaskComponentStub([]));

    await plugin.execute(ctx as any);

    expect(port.calls).toHaveLength(0);
  });
});

describe("DecisionHintPlugin — confidence tiers", () => {
  test("confidence >= 0.6 → reuse hint with task_update", async () => {
    const port = new FakeDecisionPort(() => ({
      answers: { reuse_or_create: { choice: "#4447", confidence: 0.85 } },
    }));
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [4447, 4399] }) },
      makeTaskComponentStub([
        task({ id: 4447, title: "[E2E] run3", status: "active" }),
        task({ id: 4399, title: "[Investigate] extractor", status: "active" }),
      ]),
    );

    await plugin.execute(ctx as any);

    const hint = JSON.parse(ctx.options.context).decision_hint;
    expect(hint).toContain("[TASK_CREATE_HINT]");
    expect(hint).toContain("task_update(task_id=4447");
  });

  test("confidence 0.4..0.6 → soft hint (weaker wording)", async () => {
    const port = new FakeDecisionPort(() => ({
      answers: { reuse_or_create: { choice: "#4447", confidence: 0.5 } },
    }));
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [4447, 4399] }) },
      makeTaskComponentStub([
        task({ id: 4447, title: "[E2E] run3", status: "active" }),
        task({ id: 4399, title: "[Investigate] extractor", status: "active" }),
      ]),
    );

    await plugin.execute(ctx as any);

    const hint = JSON.parse(ctx.options.context).decision_hint;
    expect(hint).toContain("仅供参考");
  });

  test("confidence < 0.4 → silent, no hint", async () => {
    const port = new FakeDecisionPort(() => ({
      answers: { reuse_or_create: { choice: "#4447", confidence: 0.2 } },
    }));
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [4447, 4399] }) },
      makeTaskComponentStub([
        task({ id: 4447, title: "[E2E] run3", status: "active" }),
        task({ id: 4399, title: "[Investigate] extractor", status: "active" }),
      ]),
    );

    await plugin.execute(ctx as any);

    expect(JSON.parse(ctx.options.context).decision_hint).toBeUndefined();
  });

  test("choice not in candidate set → silent, no hint", async () => {
    const port = new FakeDecisionPort(() => ({
      answers: { reuse_or_create: { choice: "#99999", confidence: 0.9 } },
    }));
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [4447, 4399] }) },
      makeTaskComponentStub([
        task({ id: 4447, title: "[E2E] run3", status: "active" }),
        task({ id: 4399, title: "[Investigate] extractor", status: "active" }),
      ]),
    );

    await plugin.execute(ctx as any);

    expect(JSON.parse(ctx.options.context).decision_hint).toBeUndefined();
  });
});

describe("DecisionHintPlugin — degradation", () => {
  test("model throws → degrade to pass-through, no hint, no throw", async () => {
    const port = new FakeDecisionPort(
      () => ({ answers: {} }),
      new Error("network down"),
    );
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [4447, 4399] }) },
      makeTaskComponentStub([
        task({ id: 4447, title: "[E2E] run3", status: "active" }),
        task({ id: 4399, title: "[Investigate] extractor", status: "active" }),
      ]),
    );

    await plugin.execute(ctx as any); // must not throw

    expect(JSON.parse(ctx.options.context).decision_hint).toBeUndefined();
    // 原始 context 字段不能被破坏
    expect(JSON.parse(ctx.options.context).similar_task_ids).toEqual([4447, 4399]);
  });

  test("missing taskComponent → no hint, no throw", async () => {
    const port = new FakeDecisionPort(() => ({ answers: {} }));
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx({ context: JSON.stringify({ similar_task_ids: [4447] }) });

    await plugin.execute(ctx as any);

    expect(JSON.parse(ctx.options.context).decision_hint).toBeUndefined();
  });

  test("invalid context JSON → no hint, context untouched", async () => {
    const port = new FakeDecisionPort(() => ({ answers: {} }));
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx({ context: "not json" }, makeTaskComponentStub([]));

    await plugin.execute(ctx as any);

    expect(ctx.options.context).toBe("not json");
  });
});

describe("DecisionHintPlugin — Stage B parent handling", () => {
  const rootTask = task({ id: 2859, title: "[Longterm] roy-bot 主线研发", type: "longterm" });
  const otherRoot = task({ id: 4467, title: "[Task 创建检测] ...", type: "normal" });

  test("same root → silent (no hint)", async () => {
    const port = new FakeDecisionPort((req) => {
      const q = req.questions as any;
      if (q.reuse_or_create) {
        return { answers: { reuse_or_create: { choice: "NEW_TASK", confidence: 0.9 } } };
      }
      return { answers: { root_choice: { choice: "#2859", confidence: 0.9 } } };
    });
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [] }), parent_task_id: 2859 },
      makeTaskComponentStub([rootTask, otherRoot]),
    );

    await plugin.execute(ctx as any);

    // Stage A 无候选 → 0 candidates → 不会进入 Stage B，因此无 hint
    expect(JSON.parse(ctx.options.context).decision_hint).toBeUndefined();
  });

  test("different root → remount hint with parent_task_id param", async () => {
    // 先用 2 个候选让 Stage A 跑起来并判定新建
    const port = new FakeDecisionPort((req) => {
      const q = req.questions as any;
      if (q.reuse_or_create) {
        return { answers: { reuse_or_create: { choice: "NEW_TASK", confidence: 0.9 } } };
      }
      return { answers: { root_choice: { choice: "#2859", confidence: 0.9 } } };
    });
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      {
        context: JSON.stringify({ similar_task_ids: [4447, 4399] }),
        parent_task_id: 4467,
      },
      makeTaskComponentStub([
        rootTask,
        otherRoot,
        task({ id: 4447, title: "[E2E] run3", status: "active" }),
        task({ id: 4399, title: "[Investigate] extractor", status: "active" }),
      ]),
    );

    await plugin.execute(ctx as any);

    const hint = JSON.parse(ctx.options.context).decision_hint;
    expect(hint).toContain("[TASK_CREATE_HINT]");
    // 新任务 id 在写入时还不存在 → 占位符（create-tool 侧替换成真实 id）
    expect(hint).toContain("parent_task_id=2859");
    expect(hint).toContain("__NEW_TASK_ID__");
  });
});

// ========================================================================
// 交叉验证 P1 回归 —— 框架派发的是 HookContext（载荷在 .data）
// ========================================================================

describe("DecisionHintPlugin — HookContext shape (CV P1 regression)", () => {
  test("execute() accepts a framework HookContext (payload in .data) and still writes hint", async () => {
    const port = new FakeDecisionPort(() => ({
      answers: { reuse_or_create: { choice: "#1", confidence: 0.9 } },
    }));
    const plugin = new DecisionHintPlugin({ decisionPort: port });

    const inner = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [4447] }) },
      makeTaskComponentStub([task({ id: 4447, title: "[E2E] run3", status: "active" })]),
    );
    // 模拟 HookManager.createContext 的产物：{ component, data, metadata, phase, hookPoint }
    const hookCtx = {
      component: { name: "task", version: "1.0.0" },
      data: inner,
      metadata: {},
      phase: "before" as const,
      hookPoint: "task:before.create",
    };

    await plugin.execute(hookCtx as any);

    // 若未做形状归一化，这里会静默跳过（taskComponent not injected）→ 无 hint
    const hint = JSON.parse(inner.options.context).decision_hint;
    expect(hint).toBeDefined();
    expect(hint).toContain("[TASK_CREATE_HINT]");
  });

  test("execute() still accepts a bare TaskCreateContext (backward compatible)", async () => {
    const port = new FakeDecisionPort(() => ({
      answers: { reuse_or_create: { choice: "#1", confidence: 0.9 } },
    }));
    const plugin = new DecisionHintPlugin({ decisionPort: port });
    const ctx = makeCtx(
      { context: JSON.stringify({ similar_task_ids: [4447] }) },
      makeTaskComponentStub([task({ id: 4447, title: "[E2E] run3", status: "active" })]),
    );

    await plugin.execute(ctx as any);

    expect(JSON.parse(ctx.options.context).decision_hint).toContain("[TASK_CREATE_HINT]");
  });
});
