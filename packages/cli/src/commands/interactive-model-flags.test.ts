/**
 * @fileoverview Task #4634 — `interactive`（注册名 `run`）的
 * `--model` / `--fallback-model` 必须进入每轮的 AgentContext。
 *
 * ## 为什么测 `buildInteractiveMergedContext` 而不是 REPL
 *
 * 每轮的 AgentContext 原本埋在 REPL 的 `onExecute` 闭包里 —— 想断言它
 * 必须起真实 env + 挂 Ink（单测里跑不动，实测会挂住）。
 * Task #4634 把这段合并逻辑抽成纯函数 `buildInteractiveMergedContext`，
 * 于是「flag → context」的接线规则可以被直接断言。
 *
 * 注意：抽函数**没有改变行为** —— 字段顺序（优先级）逐字保留，
 * 见 `buildInteractiveMergedContext` 的 JSDoc。
 */

import { describe, expect, test } from "bun:test";

import { buildInteractiveMergedContext } from "./run";

describe("buildInteractiveMergedContext (Task #4634)", () => {
  test("两个 flag 都给 → context 里两个都有", () => {
    const ctx = buildInteractiveMergedContext({
      modelFlags: {
        model: "opencodego/primary",
        fallbackModel: "opencodego/backup",
      },
    });
    expect(ctx.model).toBe("opencodego/primary");
    expect(ctx.fallbackModel).toBe("opencodego/backup");
  });

  test("只给 --model → fallbackModel 不出现在 context 里", () => {
    const ctx = buildInteractiveMergedContext({
      modelFlags: { model: "opencodego/primary" },
    });
    expect(ctx.model).toBe("opencodego/primary");
    expect("fallbackModel" in ctx).toBe(false);
  });

  test("只给 --fallback-model → model 不出现在 context 里", () => {
    const ctx = buildInteractiveMergedContext({
      modelFlags: { fallbackModel: "opencodego/backup" },
    });
    expect(ctx.fallbackModel).toBe("opencodego/backup");
    expect("model" in ctx).toBe(false);
  });

  test("都不给 → 两个 key 都不存在", () => {
    const ctx = buildInteractiveMergedContext({});
    expect("model" in ctx).toBe(false);
    expect("fallbackModel" in ctx).toBe(false);
  });

  test("--agent 选中的 agentContext 仍在 context 里（不被 model 覆盖掉）", () => {
    const ctx = buildInteractiveMergedContext({
      currentAgentContext: { agentType: "explore" },
      modelFlags: { model: "opencodego/primary" },
    });
    expect(ctx.agentType).toBe("explore");
    expect(ctx.model).toBe("opencodego/primary");
  });

  test("本轮临时 agentContext 的优先级高于全局 --model（行为未变）", () => {
    const ctx = buildInteractiveMergedContext({
      modelFlags: { model: "opencodego/global" },
      turnAgentContext: { model: "opencodego/turn-level" },
    });
    expect(ctx.model).toBe("opencodego/turn-level");
  });

  test("defaultAgentName 透传到 metadata（行为未变）", () => {
    const ctx = buildInteractiveMergedContext({
      defaultAgentName: "Roy",
      modelFlags: { model: "opencodego/primary" },
    });
    expect(ctx.metadata?.defaultAgentName).toBe("Roy");
  });
});
