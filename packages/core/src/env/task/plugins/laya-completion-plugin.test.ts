/**
 * @fileoverview Task #4760 — LayaCompletionPlugin 单测（mock port，不真调服务）
 *
 * 覆盖 fail-open 六场景（对齐 create 侧 #4620）：
 *   1. 未配置 provider（auth.json 缺失）→ 不调模型、不写 hint
 *   2. port 抛错（网络/超时）→ 静默、不抛
 *   3. 响应畸形（无 answers / 无 answer）→ 静默
 *   4. 置信度 < 0.92 → 不写 hint
 *   5. operation chain 空 → 不调模型
 *   6. choice 无法识别 → 静默
 * 以及判定主路径：
 *   - PASS_COMPLETED → 无 hint
 *   - FAIL_INCOMPLETE + conf ≥ 0.92 → context.completion_hint + operation 记录
 * 以及注册路径：幂等 + 真 completeTask 触发。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import {
  LayaCompletionPlugin,
  registerLayaCompletionTaskHook,
  LAYA_COMPLETION_THRESHOLD,
} from "./laya-completion-plugin";
import { TaskHookPoints } from "../hooks/task-hook-points";
import { globalHookManager } from "../../hook/global-hook-manager";
import type { DecisionPort, DecisionRequest, DecisionResponse } from "./decision-port";
import type { TaskCompleteResultContext } from "../hooks/contexts";
import type { Task } from "../types";

// ========================================================================
// 夹具
// ========================================================================

interface Fixture {
  taskComponent: TaskComponent;
  dir: string;
}

let fixture: Fixture | null = null;

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "laya-completion-"));
  const configComponent = new ConfigComponent();
  const taskComponent = new TaskComponent();
  await taskComponent.init({
    name: "task",
    version: "1.0.0",
    enabled: true,
    options: {
      configComponent,
      config: { storage: { type: "sqlite", dbPath: join(dir, "tasks.db") } },
    },
  } as any);
  return { taskComponent, dir };
}

/** 建任务 + 造 2 条 operation（create + milestone），返回 task */
async function seedCompletedTask(
  f: Fixture,
  opts?: { noOperations?: boolean; context?: string },
): Promise<Task> {
  const task = await f.taskComponent.createTask({
    title: "写完 SDK 测试并交付报告",
    description: "编写 SDK 测试",
    goals_and_expected_deliverables: "交付 /tmp/report.md",
    context: opts?.context ?? JSON.stringify({ type: "feature" }),
    project_path: "/tmp/p",
    sessionId: "s0",
  } as any);
  if (!opts?.noOperations) {
    await f.taskComponent.createOperation({
      taskId: task.id,
      sessionId: "s0",
      milestoneType: "create",
      milestoneTitle: "Task created",
      milestoneDescription: "任务已创建",
    });
    await f.taskComponent.createOperation({
      taskId: task.id,
      sessionId: "s0",
      milestoneType: "milestone",
      milestoneTitle: "测试写了一半",
      milestoneDescription: "RED 完成，GREEN 未开始",
    });
  }
  const final = await f.taskComponent.getTask(task.id);
  return final!;
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

/** 假 port：记录请求，返回固定答案 */
function fakePort(
  answer: any,
  opts?: { throwErr?: Error; record?: DecisionRequest[] },
): DecisionPort {
  return {
    async decide(req: DecisionRequest): Promise<DecisionResponse> {
      opts?.record?.push(req);
      if (opts?.throwErr) throw opts.throwErr;
      return { answers: { completion_check: answer } } as DecisionResponse;
    },
    isDisabled: () => false,
  };
}

function answerFor(choice: string, jev: number): any {
  return { choice, confidence: jev, x_jev_confidence: jev };
}

async function readContext(taskId: number): Promise<Record<string, unknown>> {
  const t = await fixture!.taskComponent.getTask(taskId);
  try {
    return JSON.parse(t!.context || "{}");
  } catch {
    return {};
  }
}

describe("LayaCompletionPlugin — fail-open", () => {
  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(() => {
    globalHookManager.unregister(TaskHookPoints.AFTER_COMPLETE, "laya-completion");
    if (fixture) {
      try {
        rmSync(fixture.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fixture = null;
    }
  });

  test("no provider configured (authPath missing) → no model call, no hint", async () => {
    const calls: DecisionRequest[] = [];
    const port = fakePort(answerFor("FAIL_INCOMPLETE", 0.99), { record: calls });
    // 注入 port 但 authPath 也给缺失路径 → 有 port 时走 port（与 create 侧一致：
    // 这里验证「无 port + auth 缺失」路径，见下一个 test）
    const plugin = new LayaCompletionPlugin({ authPath: join(fixture!.dir, "nope.json") });
    const task = await seedCompletedTask(fixture!);
    await plugin.execute(makeCtx(task), fixture!.taskComponent as any);
    expect(calls).toHaveLength(0);
    expect((await readContext(task.id)).completion_hint).toBeUndefined();
  });

  test("port throws (network outage) → silent, no hint, no throw", async () => {
    const plugin = new LayaCompletionPlugin({
      decisionPort: fakePort(null, { throwErr: new Error("laya down") }),
    });
    const task = await seedCompletedTask(fixture!);
    await plugin.execute(makeCtx(task), fixture!.taskComponent as any);
    expect((await readContext(task.id)).completion_hint).toBeUndefined();
  });

  test("malformed response (no answers) → silent", async () => {
    const plugin = new LayaCompletionPlugin({
      decisionPort: fakePort(undefined),
    });
    const task = await seedCompletedTask(fixture!);
    await plugin.execute(makeCtx(task), fixture!.taskComponent as any);
    expect((await readContext(task.id)).completion_hint).toBeUndefined();
  });

  test("confidence below threshold (0.92) → no hint", async () => {
    const plugin = new LayaCompletionPlugin({
      decisionPort: fakePort(answerFor("FAIL_INCOMPLETE", 0.5492)),
    });
    const task = await seedCompletedTask(fixture!);
    await plugin.execute(makeCtx(task), fixture!.taskComponent as any);
    expect((await readContext(task.id)).completion_hint).toBeUndefined();
  });

  test("empty operation chain (legacy task with zero ops) → no model call", async () => {
    const calls: DecisionRequest[] = [];
    const plugin = new LayaCompletionPlugin({
      decisionPort: fakePort(answerFor("FAIL_INCOMPLETE", 0.99), { record: calls }),
    });
    // 构造 ops.length === 0：mock listOperations 返回空
    const tc = {
      listOperations: async () => [] as any[],
      updateTask: async () => undefined,
      createOperation: async () => ({}),
    };
    const task = await seedCompletedTask(fixture!);
    await plugin.execute(makeCtx(task), tc as any);
    expect(calls).toHaveLength(0);
    expect((await readContext(task.id)).completion_hint).toBeUndefined();
  });

  test("unrecognized choice → silent", async () => {
    const plugin = new LayaCompletionPlugin({
      decisionPort: fakePort(answerFor("SOMETHING_ELSE", 0.99)),
    });
    const task = await seedCompletedTask(fixture!);
    await plugin.execute(makeCtx(task), fixture!.taskComponent as any);
    expect((await readContext(task.id)).completion_hint).toBeUndefined();
  });

  // ★ Task #5007 review r3：task_cancel 走 updateTask 也会 fire AFTER_COMPLETE
  //   （cancelled ∈ TASK_COMPLETE_TERMINAL_STATUSES）。若插件不短路，取消一个
  //   任务会稳定产出一条「任务已标记完成」的错语义 hint。这里锁死短路行为。
  test("terminalStatus=cancelled → skip goal check (no model call, no hint)", async () => {
    const calls: DecisionRequest[] = [];
    const plugin = new LayaCompletionPlugin({
      // 故意给 FAIL 答案：若短路失效，就会写出 hint 被抓到
      decisionPort: fakePort(answerFor("FAIL_INCOMPLETE", 0.99), { record: calls }),
    });
    const task = await seedCompletedTask(fixture!);
    const ctx = { ...makeCtx(task), terminalStatus: "cancelled" as const };
    await plugin.execute(ctx as any, fixture!.taskComponent as any);

    expect(calls.length).toBe(0); // 模型根本没被调用
    expect((await readContext(task.id)).completion_hint).toBeUndefined();
  });

  // ★ Task #4776 review MINOR-2：store 层 listOperations 默认 limit=20，
  //   >20 条 op 的任务 create 锚点（最早记录）会被挤出证据窗口，
  //   与 7c2d30f2「create 记录视为有效证据」前提不符。
  //   修复：插件显式全量取 + 渲染窗口保证首条 create 锚点在场。
  test(">20 ops → create anchor stays in evidence window", async () => {
    const calls: DecisionRequest[] = [];
    const plugin = new LayaCompletionPlugin({
      decisionPort: fakePort(answerFor("PASS_COMPLETED", 0.97), { record: calls }),
    });
    // 建任务（自动落 1 条 create）+ 再造 25 条 milestone → 共 26 条
    const task = await seedCompletedTask(fixture!);
    for (let i = 0; i < 25; i++) {
      await fixture!.taskComponent.createOperation({
        taskId: task.id,
        sessionId: "s0",
        milestoneType: "milestone",
        milestoneTitle: `进度里程碑 ${i + 1}`,
        milestoneDescription: `第 ${i + 1} 步`,
      });
    }
    await plugin.execute(makeCtx(task), fixture!.taskComponent as any);
    expect(calls).toHaveLength(1);
    const state = String(calls[0].state);
    // create 锚点（Task created: <title>）必须出现在证据窗口内
    expect(state).toContain("Task created:");
    // 最近记录也应在（窗口尾部）
    expect(state).toContain("进度里程碑 25");
  });
});

describe("LayaCompletionPlugin — hint 写入不触发 AFTER_UPDATE", () => {
  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(() => {
    globalHookManager.unregister(TaskHookPoints.AFTER_COMPLETE, "laya-completion");
    if (fixture) {
      try {
        rmSync(fixture.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fixture = null;
    }
  });

  // ★ Task #4776 review MINOR-1（DS 独有发现）：writeHint 在 AFTER_COMPLETE
  //   内走 updateTask({context}) → 二次 fire AFTER_UPDATE → 订阅者
  //   （LarkCliTaskNotifyHook 等）被无谓触发（cardStatusOf 看到
  //   task.status="completed" 会再次走终态路径）。修复：hint 写入改走
  //   updateTaskContext（直接 store 层，不 fire hook / 不发事件）。
  test("writeHint does not fire AFTER_UPDATE hook", async () => {
    let afterUpdateCalls = 0;
    const spyHook = {
      name: "after-update-spy",
      priority: 0,
      execute: async () => {
        afterUpdateCalls++;
      },
    };
    fixture!.taskComponent.registerHook(TaskHookPoints.AFTER_UPDATE, spyHook);
    try {
      const plugin = new LayaCompletionPlugin({
        decisionPort: fakePort(answerFor("FAIL_INCOMPLETE", 0.97)),
      });
      const task = await seedCompletedTask(fixture!);
      await plugin.execute(makeCtx(task), fixture!.taskComponent as any);

      // hint 已写入
      const ctx = await readContext(task.id);
      expect(String(ctx.completion_hint ?? "")).toContain("[TASK_COMPLETION_HINT]");
      // AFTER_UPDATE 不应被触发（嵌套副作用消除）
      expect(afterUpdateCalls).toBe(0);
    } finally {
      fixture!.taskComponent.unregisterHook(
        TaskHookPoints.AFTER_UPDATE,
        "after-update-spy",
      );
    }
  });
});

describe("LayaCompletionPlugin — 判定主路径", () => {
  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(() => {
    globalHookManager.unregister(TaskHookPoints.AFTER_COMPLETE, "laya-completion");
    if (fixture) {
      try {
        rmSync(fixture.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fixture = null;
    }
  });

  test("PASS_COMPLETED → no hint, model called once", async () => {
    const calls: DecisionRequest[] = [];
    const plugin = new LayaCompletionPlugin({
      decisionPort: fakePort(answerFor("PASS_COMPLETED", 0.97), { record: calls }),
    });
    const task = await seedCompletedTask(fixture!);
    await plugin.execute(makeCtx(task), fixture!.taskComponent as any);
    expect(calls).toHaveLength(1);
    // state 必须是中文文本形态（laya 训练格式），含任务标题与操作记录段
    const state = String(calls[0].state);
    expect(state).toContain("【任务标题】");
    expect(state).toContain("【任务目标】");
    expect(state).toContain("【交付物声明】");
    expect(state).toContain("【操作记录】");
    // question key 必须是 completion_check（不命中泄漏 deny-list）
    expect(Object.keys(calls[0].questions)).toContain("completion_check");
    expect((await readContext(task.id)).completion_hint).toBeUndefined();
  });

  test("FAIL_INCOMPLETE + conf ≥ 0.92 → hint written to context + operation", async () => {
    const plugin = new LayaCompletionPlugin({
      decisionPort: fakePort(answerFor("FAIL_INCOMPLETE", 0.97)),
    });
    const task = await seedCompletedTask(fixture!);
    await plugin.execute(makeCtx(task), fixture!.taskComponent as any);

    const ctx = await readContext(task.id);
    const hint = String(ctx.completion_hint ?? "");
    expect(hint).toContain("[TASK_COMPLETION_HINT]");
    expect(hint).toContain("你必须核实本提示");
    expect(hint).toContain("task_get");
    expect(hint).toContain("核实后二选一");
    expect(hint).toContain("(a)");
    expect(hint).toContain("task_update");
    expect(hint).toContain("status=todo");
    expect(hint).toContain("(b)");
    expect(hint).toContain("operation");
    expect(hint).toContain("不允许无视本提示");

    // operation 记录也落一条
    const ops = await fixture!.taskComponent.listOperations({ taskId: task.id });
    const hintOp = ops.find((o) =>
      (o.milestoneTitle || "").includes("TASK_COMPLETION_HINT"),
    );
    expect(hintOp).toBeTruthy();
  });

  test("execute never throws (inner explosion tolerated)", async () => {
    const plugin = new LayaCompletionPlugin({
      decisionPort: {
        async decide(): Promise<DecisionResponse> {
          throw new Error("boom");
        },
        isDisabled: () => false,
      },
    });
    const task = await seedCompletedTask(fixture!);
    // 不应抛
    await plugin.execute(makeCtx(task), fixture!.taskComponent as any);
  });
});

describe("LayaCompletionPlugin — 注册路径", () => {
  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(() => {
    globalHookManager.unregister(TaskHookPoints.AFTER_COMPLETE, "laya-completion");
    if (fixture) {
      try {
        rmSync(fixture.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fixture = null;
    }
  });

  test("registered hook → real preCompleteTask (goal check gate) writes hint into context", async () => {
    const task = await seedCompletedTask(fixture!);
    const port = fakePort(answerFor("FAIL_INCOMPLETE", 0.97));
    const ok = registerLayaCompletionTaskHook(
      fixture!.taskComponent,
      { decisionPort: port } as any,
    );
    expect(ok).toBe(true);

    // ★ #5073 设计调整②：goal 检查的触发点 = preCompleteTask
    //   （sub-agent 自查关，AFTER_COMPLETE 终态语义 = to_validate）
    const done = await fixture!.taskComponent.preCompleteTask(task.id, "s1");
    expect(done).toBeTruthy();

    const ctx = await readContext(task.id);
    expect(String(ctx.completion_hint ?? "")).toContain("[TASK_COMPLETION_HINT]");
  });

  test("registering twice → only ONE hook (idempotent)", () => {
    const port = fakePort(answerFor("PASS_COMPLETED", 0.97));
    const before = globalHookManager.count(TaskHookPoints.AFTER_COMPLETE);
    registerLayaCompletionTaskHook(fixture!.taskComponent, { decisionPort: port } as any);
    const afterFirst = globalHookManager.count(TaskHookPoints.AFTER_COMPLETE);
    registerLayaCompletionTaskHook(fixture!.taskComponent, { decisionPort: port } as any);
    const afterSecond = globalHookManager.count(TaskHookPoints.AFTER_COMPLETE);
    expect(afterFirst).toBe(before + 1);
    expect(afterSecond).toBe(afterFirst);
  });

  test("taskComponent missing → registration fails open (false)", () => {
    const ok = registerLayaCompletionTaskHook(null, { decisionPort: fakePort(null) } as any);
    expect(ok).toBe(false);
  });
});

describe("LAYA_COMPLETION_THRESHOLD", () => {
  test("is 0.92 (aligned with create-side gate)", () => {
    expect(LAYA_COMPLETION_THRESHOLD).toBe(0.92);
  });
});
