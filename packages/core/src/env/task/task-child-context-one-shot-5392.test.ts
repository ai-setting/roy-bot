import { describe, test, expect } from "bun:test";
import { inheritChildContext } from "./task-child-context";

const HINT = "[TASK_CREATE_HINT] 检测到本次任务的挂载位置可能不合理。建议归属：root #789";

describe("Task #5392 — 一次性提示不得从父任务继承给子任务", () => {
  test("父 context 的 decision_hint 不出现在子 context 里", () => {
    const out = inheritChildContext({
      parent: {
        taskId: 5388,
        projectPath: "/tmp/p",
        contextJson: JSON.stringify({
          type: "verification",
          branch: "main",
          decision_hint: HINT,
        }),
      },
      overrides: {},
    });
    const ctx = JSON.parse(out.context);
    expect(ctx.decision_hint).toBeUndefined();
    expect(out.context).not.toContain("TASK_CREATE_HINT");
    // 其他字段照旧继承
    expect(ctx.branch).toBe("main");
    expect(ctx.type).toBe("verification");
  });

  test("delivered_at / digest 审计锚点同样不继承", () => {
    const out = inheritChildContext({
      parent: {
        taskId: 5389,
        projectPath: "/tmp/p",
        contextJson: JSON.stringify({
          branch: "main",
          decision_hint_delivered_at: "2026-11-12T05:34:07.301Z",
          decision_hint_digest: "remount",
        }),
      },
      overrides: {},
    });
    const ctx = JSON.parse(out.context);
    expect(ctx.decision_hint_delivered_at).toBeUndefined();
    expect(ctx.decision_hint_digest).toBeUndefined();
  });

  test("completion_hint 也不继承（另一套一次性信号）", () => {
    const out = inheritChildContext({
      parent: {
        taskId: 5390,
        projectPath: "/tmp/p",
        contextJson: JSON.stringify({ branch: "main", completion_hint: "[TASK_COMPLETION_HINT] x" }),
      },
      overrides: {},
    });
    const ctx = JSON.parse(out.context);
    expect(ctx.completion_hint).toBeUndefined();
    expect(ctx.branch).toBe("main");
  });
});
