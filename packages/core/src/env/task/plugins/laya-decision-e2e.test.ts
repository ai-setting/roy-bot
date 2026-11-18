/**
 * @fileoverview Task #4620 — Laya 载体的端到端行为测试（mock port，不真调服务）
 *
 * 覆盖任务书的行为规范（第 ③ 步）：
 *
 *   hook (task:before.create):
 *     1. 从 ctx.options.context.similar_task_ids 读候选 id
 *     2. 没有 → 直接放行，不调模型
 *     3. 有 → 按 id 取任务详情 → 构造 state + criteria
 *     4. 调 Laya 服务（client）
 *     5. verdict: choice == "NEW_TASK" → 不出提示
 *               否则 → 出提示，且**必须 confidence 门禁 ≥ 0.85**
 *     6. hint 写进 ctx.options.context.decision_hint
 *     7. create-tool.ts 的 output 拼上 hint
 *
 * 本文件覆盖 1/2/3/5/6；第 7 步在 create-tool 的测试里。
 */

import { describe, test, expect } from "bun:test";
import { DecisionHintPlugin } from "./decision-hint-plugin";
import { layaRenderer } from "./decision-renderers";
import { LayaDecisionPlugin } from "./laya-decision-plugin";
import type { DecisionPort, DecisionRequest, DecisionResponse } from "./decision-port";
import type { TaskCreateContext } from "../hooks/contexts";
import type { Task } from "../types";

const LAYA_THRESHOLD = 0.85;

function makeTask(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `候选任务 ${id} 的标题`,
    description: `候选任务 ${id} 的描述内容`,
    status: "active",
    type: "normal",
    tags: ["feature"],
    updatedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    ...over,
  } as Task;
}

/** 只读能力的假 taskComponent */
function fakeTaskComponent(tasks: Task[]) {
  return {
    getTask: async (id: number) => tasks.find((t) => t.id === id),
    listTasks: async () => ({ tasks, total: tasks.length }),
    searchTasksByKeywords: async () => ({ tasks: [], total: 0 }),
    getChildTasks: async () => ({ tasks: [], total: 0 }),
  } as any;
}

function makeCtx(
  ids: number[] | null,
  extra: Record<string, unknown> = {},
  taskComponent?: any,
): TaskCreateContext {
  const context = ids === null ? "{}" : JSON.stringify({ similar_task_ids: ids, ...extra });
  return {
    options: {
      title: "新任务标题",
      description: "新任务描述",
      goals_and_expected_deliverables: "",
      tags: ["feature"],
      project_path: "/tmp/x",
      context,
    } as any,
    sessionId: "s1",
    tagService: {} as any,
    // ⚠️ taskComponent 挂在**hook context** 上（插件从 ctx.taskComponent 读）
    ...(taskComponent ? { taskComponent } : {}),
  } as TaskCreateContext;
}

function hintOf(ctx: TaskCreateContext): string | undefined {
  try {
    return (JSON.parse(ctx.options.context as string) as any).decision_hint;
  } catch {
    return undefined;
  }
}

/** 记录请求并返回指定答案的 port */
function portReturning(choice: string, confidence: number, reqs: DecisionRequest[] = []): DecisionPort {
  return {
    async decide(req: DecisionRequest): Promise<DecisionResponse> {
      reqs.push(req);
      return {
        answers: { reuse_or_create: { choice, confidence, x_jev_confidence: confidence } },
      } as DecisionResponse;
    },
    isDisabled: () => false,
  };
}

/** 造一个「laya 配置」的插件（阈值 0.85 / laya 渲染 / 走模型） */
function layaPlugin(port: DecisionPort): DecisionHintPlugin {
  return new DecisionHintPlugin({
    decisionPort: port,
    renderer: layaRenderer,
    reuseThreshold: LAYA_THRESHOLD,
    softHintThreshold: LAYA_THRESHOLD,
    singleCandidateShortcut: false,
  });
}

/** 带 taskComponent 的 ctx（插件从 ctx.taskComponent 取任务详情） */
function ctxWithTasks(ids: number[], tasks: Task[]): TaskCreateContext {
  return makeCtx(ids, {}, fakeTaskComponent(tasks));
}

describe("Laya 载体 — task:before.create 行为规范", () => {
  // ==================================================================
  // 步骤 1/2：候选为空 → 放行，不调模型
  // ==================================================================

  test("no similar_task_ids → port NOT called, no hint", async () => {
    const reqs: DecisionRequest[] = [];
    const p = layaPlugin(portReturning("#1 x", 0.99, reqs));
    const ctx = makeCtx(null);

    await p.execute(ctx);

    expect(reqs).toHaveLength(0);
    expect(hintOf(ctx)).toBeUndefined();
  });

  test("similar_task_ids referencing non-existent tasks → port NOT called", async () => {
    const reqs: DecisionRequest[] = [];
    const p = layaPlugin(portReturning("#1 x", 0.99, reqs));
    // taskComponent 里也没有这两个 id → 候选为空 → 兜底检索也找不到 → 不调模型
    const ctx = ctxWithTasks([999, 1000], []);

    await p.execute(ctx);

    expect(reqs).toHaveLength(0);
    expect(hintOf(ctx)).toBeUndefined();
  });

  // ==================================================================
  // 步骤 3：构造 state + criteria（laya 格式）
  // ==================================================================

  test("builds a laya-format request (text state + laya criteria keys)", async () => {
    const reqs: DecisionRequest[] = [];
    const tasks = [makeTask(11), makeTask(22), makeTask(33)];
    const p = layaPlugin(portReturning("#22 x", 0.99, reqs), tasks);
    const ctx = ctxWithTasks([11, 22, 33], tasks);

    await p.execute(ctx);

    expect(reqs).toHaveLength(1);
    const req = reqs[0];
    expect(typeof req.state).toBe("string");
    expect(String(req.state)).toContain("【新任务标题】新任务标题");
    expect(String(req.state)).toContain("【候选任务】");
    const crit = (req.questions as any).reuse_or_create.criteria;
    expect(Object.keys(crit)).toContain("#11 候选任务 11 的标题");
    expect(Object.keys(crit)).toContain("NEW_TASK");
  });

  // ==================================================================
  // 步骤 5：NEW_TASK → 不出提示
  // ==================================================================

  test("choice == NEW_TASK → no hint", async () => {
    const tasks = [makeTask(11), makeTask(22)];
    const p = layaPlugin(portReturning("NEW_TASK", 0.99));
    const ctx = ctxWithTasks([11, 22], tasks);

    await p.execute(ctx);

    expect(hintOf(ctx)).toBeUndefined();
  });

  // ==================================================================
  // 步骤 5：confidence 门禁 ≥ 0.85
  // ==================================================================

  test("confidence 0.99 (>= 0.85) → hint IS produced", async () => {
    const tasks = [makeTask(11), makeTask(22)];
    const p = layaPlugin(portReturning("#22 候选任务 22 的标题", 0.99));
    const ctx = ctxWithTasks([11, 22], tasks);

    await p.execute(ctx);

    const hint = hintOf(ctx);
    expect(hint).toBeDefined();
    expect(hint).toContain("[TASK_CREATE_HINT]");
    expect(hint).toContain("task_update");
    expect(hint).toContain("22");
  });

  test("confidence exactly 0.85 (== threshold) → hint IS produced (>= is inclusive)", async () => {
    const tasks = [makeTask(11), makeTask(22)];
    const p = layaPlugin(portReturning("#22 候选任务 22 的标题", 0.85));
    const ctx = ctxWithTasks([11, 22], tasks);

    await p.execute(ctx);

    expect(hintOf(ctx)).toBeDefined();
  });

  test("confidence 0.84 (< 0.85) → NO hint", async () => {
    const tasks = [makeTask(11), makeTask(22)];
    const p = layaPlugin(portReturning("#22 候选任务 22 的标题", 0.84));
    const ctx = ctxWithTasks([11, 22], tasks);

    await p.execute(ctx);

    expect(hintOf(ctx)).toBeUndefined();
  });

  test("confidence 0.5 (< 0.85) → NO hint", async () => {
    const tasks = [makeTask(11), makeTask(22)];
    const p = layaPlugin(portReturning("#22 候选任务 22 的标题", 0.5));
    const ctx = ctxWithTasks([11, 22], tasks);

    await p.execute(ctx);

    expect(hintOf(ctx)).toBeUndefined();
  });

  test("confidence 0.0 → NO hint", async () => {
    const tasks = [makeTask(11), makeTask(22)];
    const p = layaPlugin(portReturning("#22 候选任务 22 的标题", 0));
    const ctx = ctxWithTasks([11, 22], tasks);

    await p.execute(ctx);

    expect(hintOf(ctx)).toBeUndefined();
  });

  // ==================================================================
  // 单候选：默认也走模型（Laya 载体关掉快捷路径）
  // ==================================================================

  test("single candidate STILL calls the model (shortcut disabled for laya)", async () => {
    const reqs: DecisionRequest[] = [];
    const tasks = [makeTask(11)];
    const p = layaPlugin(portReturning("#11 候选任务 11 的标题", 0.99, reqs));
    const ctx = ctxWithTasks([11], tasks);

    await p.execute(ctx);

    expect(reqs).toHaveLength(1);
    expect(hintOf(ctx)).toBeDefined();
  });

  test("single candidate with LOW confidence → NO hint (goes through the gate)", async () => {
    const tasks = [makeTask(11)];
    const p = layaPlugin(portReturning("#11 候选任务 11 的标题", 0.3));
    const ctx = ctxWithTasks([11], tasks);

    await p.execute(ctx);

    expect(hintOf(ctx)).toBeUndefined();
  });

  // ==================================================================
  // 步骤 6：hint 写进 context.decision_hint
  // ==================================================================

  test("hint is written into context.decision_hint (context stays valid JSON)", async () => {
    const tasks = [makeTask(11), makeTask(22)];
    const p = layaPlugin(portReturning("#22 候选任务 22 的标题", 0.99));
    const ctx = ctxWithTasks([11, 22], tasks);

    await p.execute(ctx);

    const parsed = JSON.parse(ctx.options.context as string);
    expect(parsed.decision_hint).toBeDefined();
    // 原始字段没被破坏
    expect(parsed.similar_task_ids).toEqual([11, 22]);
  });

  // ==================================================================
  // fail-open：模型异常 → 不出 hint、不抛
  // ==================================================================

  test("model throws → no hint, no throw", async () => {
    const failing: DecisionPort = {
      async decide(): Promise<DecisionResponse> {
        throw new Error("laya service unreachable");
      },
      isDisabled: () => false,
    };
    const tasks = [makeTask(11), makeTask(22)];
    const p = layaPlugin(failing);
    const ctx = ctxWithTasks([11, 22], tasks);

    await expect(p.execute(ctx)).resolves.toBeUndefined();
    expect(hintOf(ctx)).toBeUndefined();
  });

  test("LayaDecisionPlugin wrapper: model throws → task_create unaffected", async () => {
    const failing: DecisionPort = {
      async decide(): Promise<DecisionResponse> {
        throw new Error("boom");
      },
      isDisabled: () => false,
    };
    const plugin = new LayaDecisionPlugin({ decisionPort: failing });
    const ctx = ctxWithTasks([11, 22], [makeTask(11), makeTask(22)]);

    await expect(plugin.execute(ctx)).resolves.toBeUndefined();
    expect(hintOf(ctx)).toBeUndefined();
  });
});
