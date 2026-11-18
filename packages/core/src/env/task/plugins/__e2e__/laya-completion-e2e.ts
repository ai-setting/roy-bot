/**
 * @fileoverview Task #4760 — Laya 完成判定插件 **e2e 回归脚本**（可重跑）
 *
 * 用法：
 * ```bash
 * bun run packages/core/src/env/task/plugins/__e2e__/laya-completion-e2e.ts
 * ```
 *
 * ⚠️ mock 模式（默认）：注入假 port（FAIL_INCOMPLETE@0.97 / PASS@0.97），
 *   走**真实** TaskComponent.completeTask 流程（真实 hook 派发、真实 DB），
 *   断言 hint 回写 context + operation 记录。
 *   真实模型的 OOD 偏 PASS 限制另见 live 探针记录（Task #4760 operation）。
 *
 * 退出码 0 = 全部通过，1 = 有失败。
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { TaskComponent } from "../../task-component";
import { ConfigComponent } from "../../../../config/config-component";
import { TaskHookPoints } from "../../hooks/task-hook-points";
import { globalHookManager } from "../../../hook/global-hook-manager";
import { registerLayaCompletionTaskHook } from "../laya-completion-plugin";
import type { DecisionPort, DecisionResponse } from "../decision-port";

// ========================================================================
// 迷你测试框架
// ========================================================================

interface Result {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const results: Result[] = [];

async function scenario(
  name: string,
  fn: () => Promise<{ ok: boolean; detail: string }>,
): Promise<void> {
  const t0 = Date.now();
  let ok = false;
  let detail = "";
  try {
    const r = await fn();
    ok = r.ok;
    detail = r.detail;
  } catch (err) {
    ok = false;
    detail = `EXCEPTION: ${(err as Error)?.message ?? String(err)}`;
  }
  const ms = Date.now() - t0;
  results.push({ name, ok, detail, ms });
  console.log(`\n${ok ? "✅" : "❌"} [${ms}ms] ${name}`);
  console.log(`   → ${detail}`);
}

function assert(cond: boolean, msg: string): { ok: boolean; detail: string } {
  return { ok: cond, detail: cond ? msg : `断言失败: ${msg}` };
}

// ========================================================================
// 夹具
// ========================================================================

const dir = mkdtempSync(join(tmpdir(), "laya-completion-e2e-"));
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

function fakePort(
  choice: string,
  jev: number,
  reqs: any[] = [],
): DecisionPort {
  return {
    async decide(req: any): Promise<DecisionResponse> {
      reqs.push(req);
      return {
        answers: { completion_check: { choice, confidence: jev, x_jev_confidence: jev } },
      } as DecisionResponse;
    },
    isDisabled: () => false,
  };
}

async function seedTask(withMilestone: boolean): Promise<number> {
  const t = await taskComponent.createTask({
    title: "完成 SDK 测试并交付报告",
    description: "编写 SDK 测试",
    goals_and_expected_deliverables: "交付 /tmp/report.md，全部 21 测试通过",
    context: JSON.stringify({ type: "feature" }),
    project_path: "/tmp/p",
    sessionId: "s0",
  } as any);
  if (withMilestone) {
    await taskComponent.createOperation({
      taskId: t.id,
      sessionId: "s0",
      milestoneType: "milestone",
      milestoneTitle: "测试写了一半",
      milestoneDescription: "RED 完成，GREEN 未开始",
    });
  }
  return t.id;
}

async function readContext(taskId: number): Promise<Record<string, unknown>> {
  const t = await taskComponent.getTask(taskId);
  try {
    return JSON.parse(t!.context || "{}");
  } catch {
    return {};
  }
}

function unregister(): void {
  globalHookManager.unregister(TaskHookPoints.AFTER_COMPLETE, "laya-completion");
}

// ========================================================================
// 场景 1：FAIL_INCOMPLETE@0.97 → hint 写入 context + operation 记录
// ========================================================================

await scenario("FAIL@0.97 → hint 写入 context + operation", async () => {
  unregister();
  const reqs: any[] = [];
  registerLayaCompletionTaskHook(taskComponent, {
    decisionPort: fakePort("FAIL_INCOMPLETE", 0.97, reqs),
  } as any);

  const id = await seedTask(true);
  const done = await taskComponent.completeTask(id, "s1");
  const ctx = await readContext(id);
  const hint = String(ctx.completion_hint ?? "");
  const ops = await taskComponent.listOperations({ taskId: id });
  const hintOp = ops.find((o) =>
    (o.milestoneTitle || "").includes("TASK_COMPLETION_HINT"),
  );

  const ok =
    done?.status === "completed" &&
    reqs.length === 1 &&
    hint.includes("[TASK_COMPLETION_HINT]") &&
    hint.includes("你必须核实本提示") &&
    hint.includes("task_get") &&
    hint.includes("task_update") &&
    hint.includes("status=todo") &&
    hint.includes("task_operation_create") &&
    hint.includes("不允许无视本提示") &&
    Boolean(hintOp);
  return assert(
    ok,
    `status=${done?.status} reqs=${reqs.length} hintLen=${hint.length} hintOp=${Boolean(hintOp)}`,
  );
});

// ========================================================================
// 场景 2：PASS_COMPLETED@0.97 → 无 hint，任务正常完成
// ========================================================================

await scenario("PASS@0.97 → 无 hint，正常完成", async () => {
  unregister();
  const reqs: any[] = [];
  registerLayaCompletionTaskHook(taskComponent, {
    decisionPort: fakePort("PASS_COMPLETED", 0.97, reqs),
  } as any);

  const id = await seedTask(true);
  const done = await taskComponent.completeTask(id, "s1");
  const ctx = await readContext(id);

  const ok =
    done?.status === "completed" &&
    reqs.length === 1 &&
    !ctx.completion_hint;
  return assert(ok, `status=${done?.status} reqs=${reqs.length} noHint=${!ctx.completion_hint}`);
});

// ========================================================================
// 场景 3：低置信 0.5 → 不调门禁，静默放行
// ========================================================================

await scenario("FAIL@0.5 (<0.92) → 静默放行", async () => {
  unregister();
  const reqs: any[] = [];
  registerLayaCompletionTaskHook(taskComponent, {
    decisionPort: fakePort("FAIL_INCOMPLETE", 0.5, reqs),
  } as any);

  const id = await seedTask(true);
  const done = await taskComponent.completeTask(id, "s1");
  const ctx = await readContext(id);

  const ok = done?.status === "completed" && reqs.length === 1 && !ctx.completion_hint;
  return assert(ok, `status=${done?.status} reqs=${reqs.length} noHint=${!ctx.completion_hint}`);
});

// ========================================================================
// 场景 4：port 抛错（网络故障）→ fail-open，完成不受影响
// ========================================================================

await scenario("port 抛错 → fail-open 完成", async () => {
  unregister();
  registerLayaCompletionTaskHook(taskComponent, {
    decisionPort: {
      async decide(): Promise<DecisionResponse> {
        throw new Error("simulated laya outage");
      },
      isDisabled: () => false,
    },
  } as any);

  const id = await seedTask(true);
  const done = await taskComponent.completeTask(id, "s1");
  const ctx = await readContext(id);

  const ok = done?.status === "completed" && !ctx.completion_hint;
  return assert(ok, `status=${done?.status} noHint=${!ctx.completion_hint}`);
});

// ========================================================================
// 汇总
// ========================================================================

unregister();

const pass = results.filter((r) => r.ok).length;
console.log("\n" + "━".repeat(72));
console.log(`汇总: ${pass}/${results.length} pass`);
console.log("━".repeat(72));

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}

process.exit(pass === results.length ? 0 : 1);
