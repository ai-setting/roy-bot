/**
 * @fileoverview Task #4643 — Laya 复用门禁阈值 0.85 → 0.92
 *
 * 背景（#4627/#4632 实测结论）：
 *   阈值 0.85 时 live 提示精确率仅 12/19 = 63.2%（25 条 gold unseen），
 *   「应复用 #X」是破坏性建议（用户可能因此不建新任务），
 *   63.2% 的精确率意味着约 1/3 的提示在误导用户。
 *
 *   方案 1（用户拍板）：把门禁提到 0.92 —— 用更高的置信度门槛换精确率，
 *   代价是出 hint 率下降（覆盖率↓）。live 对比数据见 #4643 报告。
 *
 * 本文件断言三件事：
 *   1. 常量本身 = 0.92（防回退）
 *   2. 生产路径（不传 options）走共享实例（默认阈值来自常量）
 *   3. 门禁行为随阈值变化：x_jev=0.88 在 0.85 下出 hint、在 0.92 下静默
 */

import { describe, test, expect } from "bun:test";
import { LAYA_REUSE_THRESHOLD, LayaDecisionPlugin, createLayaDecisionPlugin } from "./laya-decision-plugin";
import type { DecisionPort, DecisionRequest, DecisionResponse } from "./decision-port";
import type { Task, TaskCreateContext } from "../hooks/contexts";
import type { TaskComponentReadonly } from "./decision-hint-plugin";

function makeCtx(similarTaskIds: number[]): TaskCreateContext {
  return {
    options: {
      title: "阈值校验请求",
      description: "Task #4643 阈值语义校验",
      context: JSON.stringify({ type: "general", similar_task_ids: similarTaskIds }),
      tags: [],
    } as any,
    sessionId: "s",
    tagService: {} as any,
    taskComponent: {
      getTask: async (id: number): Promise<Task | undefined> =>
        ({
          id,
          title: `候选任务 ${id}`,
          description: "候选描述",
          status: "active",
          type: "normal",
          tags: [],
          updatedAt: new Date().toISOString(),
        }) as Task,
    } as unknown as TaskComponentReadonly,
  } as TaskCreateContext;
}

function fakePort(answer: any): DecisionPort {
  return {
    async decide(_req: DecisionRequest): Promise<DecisionResponse> {
      return { answers: { reuse_or_create: answer } } as DecisionResponse;
    },
    isDisabled: () => false,
  };
}

describe("Task #4643 — Laya 复用门禁阈值 0.92", () => {
  test("LAYA_REUSE_THRESHOLD === 0.92", () => {
    expect(LAYA_REUSE_THRESHOLD).toBe(0.92);
  });

  test("production default: factory without options returns the shared instance", () => {
    // 不传 options → 共享实例（生产默认路径，阈值来自常量）
    const hook = createLayaDecisionPlugin();
    const hook2 = createLayaDecisionPlugin();
    expect(hook.plugin).toBeInstanceOf(LayaDecisionPlugin);
    expect(hook2.plugin).toBe(hook.plugin);
  });

  test("gate behavior: x_jev=0.88 → silent (below 0.92), would have hinted at 0.85", async () => {
    // 0.88 在旧阈值 0.85 下会出 hint；新阈值 0.92 下必须静默。
    // 这条测试同时锁住「门禁读 x_jev_confidence」与「阈值=0.92」两件事。
    const calls: DecisionRequest[] = [];
    const port: DecisionPort = {
      async decide(req: DecisionRequest): Promise<DecisionResponse> {
        calls.push(req);
        return {
          answers: {
            reuse_or_create: {
              choice: "#1 候选任务",
              confidence: 0.99, // 归一化熵（干扰项，不该被读）
              x_jev_confidence: 0.88, // Jev 置信度：0.85 ≤ 0.88 < 0.92
            },
          },
        } as DecisionResponse;
      },
      isDisabled: () => false,
    };
    const plugin = new LayaDecisionPlugin({ decisionPort: port });
    const ctx = makeCtx([1]);
    await plugin.execute(ctx);
    // 0.88 < 0.92 → 静默档 → 不出 hint
    expect(ctx.options.context).not.toContain("decision_hint");
    expect(calls.length).toBeGreaterThanOrEqual(1); // 模型被调过（静默在判定层，不在调用层）
  });

  test("gate behavior: x_jev=0.95 (>= 0.92) → hint still produced", async () => {
    const port = fakePort({
      choice: "#1 候选任务",
      confidence: 0.5,
      x_jev_confidence: 0.95,
    });
    const plugin = new LayaDecisionPlugin({ decisionPort: port });
    const ctx = makeCtx([1]);
    await plugin.execute(ctx);
    // 0.95 ≥ 0.92 → 出 hint（decision_hint 写进 context）
    expect(ctx.options.context).toContain("decision_hint");
  });
});
