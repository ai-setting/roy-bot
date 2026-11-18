/**
 * Task #4834 — F2 调研：门禁 0.92 的置信度漂移实证
 *
 * 目的（**只调研，不改门禁代码**）：
 *   量化「同一 state 重复重放」时 x_jev_confidence 的分布，
 *   为门禁调参提供数据依据。
 *
 * 用法：
 *   bun scripts/f2-threshold-probe.ts [重复次数]
 *
 * ⚠️ 只读生产 auth.json（不写）；不发任务；不改任何配置。
 */

import { LayaDecisionPort, loadLayaAuthForPurpose } from "../packages/core/src/env/task/plugins/laya-port";
import { pickGateConfidence } from "../packages/core/src/env/task/plugins/decision-hint-plugin";
import {
  renderCompletionState,
  buildCompletionQuestion,
} from "../packages/core/src/env/task/plugins/laya-completion-plugin";
import type { Task, TaskOperation } from "../packages/core/src/env/task/types";

const REPEAT = Number(process.argv[2] ?? 5);

function makeTask(goals: string, deliverable: string): Task {
  return {
    id: 900001,
    title: "F2 调研：部分完成场景",
    description: "F2 threshold probe",
    status: "completed",
    priority: "medium",
    type: "normal",
    progress: 100,
    current_status: "",
    goals_and_expected_deliverables: goals,
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    context: JSON.stringify({ deliverable_storage_path: deliverable }),
  } as unknown as Task;
}

const OPS: TaskOperation[] = [
  {
    id: 1,
    taskId: 900001,
    sessionId: "f2-probe",
    milestoneType: "create",
    milestoneTitle: "Task created",
    milestoneDescription: "任务已创建",
    timestamp: "2026-11-02T00:00:00.000Z",
  } as unknown as TaskOperation,
];

const SCENARIOS = [
  {
    id: "S2-B-partial",
    desc: "部分完成（2/3 未产出）—— 期望 FAIL_INCOMPLETE",
    goals: "1. 产出 /tmp/f2/a.txt\n2. 产出 /tmp/f2/b.txt\n3. 产出 /tmp/f2/c.txt",
    deliverable: "/tmp/f2/a.txt",
    expect: "FAIL_INCOMPLETE",
  },
  {
    id: "S2-A-complete",
    desc: "全部完成 —— 期望 PASS_COMPLETED",
    goals: "1. 产出 /tmp/f2/a.txt\n2. 产出 /tmp/f2/b.txt",
    deliverable: "/tmp/f2/a.txt, /tmp/f2/b.txt",
    expect: "PASS_COMPLETED",
  },
];

interface Row {
  scenario: string;
  i: number;
  choice: string;
  x_jev?: number;
  answer_conf?: number;
  entropy?: number;
  picked: number;
  gate: boolean;
}

async function main() {
  const auth = await loadLayaAuthForPurpose(undefined, "goal");
  if (!auth) {
    console.error("❌ 读不到 laya auth（~/.roy-bot/auth.json）—— 调研无法进行");
    process.exit(1);
  }
  const port = new LayaDecisionPort({
    baseURL: auth.baseURL,
    apiKey: auth.apiKey,
    model: auth.model,
    timeoutMs: 8000,
  });

  const rows: Row[] = [];
  for (const sc of SCENARIOS) {
    const state = renderCompletionState(makeTask(sc.goals, sc.deliverable), OPS);
    for (let i = 1; i <= REPEAT; i++) {
      try {
        const res = await port.decide({
          state,
          questions: buildCompletionQuestion(),
        } as any);
        const answer = res?.answers?.["completion_check"];
        const x = (answer as any)?.x_jev_confidence;
        const a = (answer as any)?.answer_confidence;
        const e = (answer as any)?.confidence;
        const picked = pickGateConfidence(answer as any);
        rows.push({
          scenario: sc.id,
          i,
          choice: String((answer as any)?.choice ?? "(none)"),
          x_jev: typeof x === "number" ? x : undefined,
          answer_conf: typeof a === "number" ? a : undefined,
          entropy: typeof e === "number" ? e : undefined,
          picked,
          gate: picked >= 0.92,
        });
        console.log(
          `[${sc.id} #${i}] choice=${rows.at(-1)!.choice} ` +
            `x_jev=${fmt(x)} answer_conf=${fmt(a)} entropy=${fmt(e)} ` +
            `picked=${picked.toFixed(4)} gate=${rows.at(-1)!.gate}`,
        );
      } catch (err) {
        console.log(`[${sc.id} #${i}] ERROR ${(err as Error).message}`);
      }
    }
  }

  console.log("\n===== 汇总 =====");
  for (const sc of SCENARIOS) {
    const rs = rows.filter((r) => r.scenario === sc.id);
    if (rs.length === 0) continue;
    const picks = rs.map((r) => r.picked);
    const min = Math.min(...picks);
    const max = Math.max(...picks);
    const avg = picks.reduce((a, b) => a + b, 0) / picks.length;
    const passed = rs.filter((r) => r.gate).length;
    const dirOk = rs.filter((r) => r.choice === sc.expect).length;
    console.log(
      `${sc.id} (${sc.desc}): n=${rs.length} ` +
        `picked min=${min.toFixed(4)} max=${max.toFixed(4)} avg=${avg.toFixed(4)} ` +
        `spread=${(max - min).toFixed(4)} | 门禁(>=0.92) ${passed}/${rs.length} ` +
        `| 方向正确 ${dirOk}/${rs.length}`,
    );
  }
}

function fmt(v: unknown): string {
  return typeof v === "number" ? v.toFixed(4) : "n/a";
}

void main();
