/**
 * Task #4834 — F2 调研（第二阶段）：门禁 0.92 在**多种 state 形态**下的表现
 *
 * 目的：为门禁调参提供**分布数据**，而不是单点数据。
 *   覆盖 6 类 state：
 *   ①  部分完成（期望 FAIL）—— 误报/漏报评估
 *   ②  全部完成（期望 PASS）—— **误报 hint 评估**（F1 修复后）
 *   ③  全部未产出（期望 FAIL）
 *   ④  无编号子项（不可比对 → 不生成对照行）
 *   ⑤  URL 型交付物（不可比对）
 *   ⑥  deliverable 声明与 goals 完全不一致（强 FAIL 信号）
 *
 * 只读生产 auth.json，不改门禁代码、不写任何配置。
 *
 * 用法：bun scripts/f2-threshold-matrix.ts [每形态重复次数]
 */

import { LayaDecisionPort, loadLayaAuthForPurpose } from "../packages/core/src/env/task/plugins/laya-port";
import { pickGateConfidence } from "../packages/core/src/env/task/plugins/decision-hint-plugin";
import {
  renderCompletionState,
  buildCompletionQuestion,
} from "../packages/core/src/env/task/plugins/laya-completion-plugin";
import type { Task, TaskOperation } from "../packages/core/src/env/task/types";

const REPEAT = Number(process.argv[2] ?? 3);

function makeTask(goals: string, deliverable: string): Task {
  return {
    id: 900003,
    title: "F2 调研",
    description: "F2 threshold matrix probe",
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
    id: 1, taskId: 900003, sessionId: "f2-matrix",
    milestoneType: "create", milestoneTitle: "Task created",
    milestoneDescription: "任务已创建",
    timestamp: "2026-11-02T00:00:00.000Z",
  } as unknown as TaskOperation,
];

interface Scenario {
  id: string;
  desc: string;
  expect: "FAIL_INCOMPLETE" | "PASS_COMPLETED" | "N/A";
  goals: string;
  deliverable: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "①-部分完成",
    desc: "3 子项产出 1（对照行标 2 条未产出）",
    expect: "FAIL_INCOMPLETE",
    goals: "1. 产出 /tmp/f2/a.txt\n2. 产出 /tmp/f2/b.txt\n3. 产出 /tmp/f2/c.txt",
    deliverable: "/tmp/f2/a.txt",
  },
  {
    id: "②-全部完成",
    desc: "2 子项全部产出（期望 PASS，**误报 hint 风险点**）",
    expect: "PASS_COMPLETED",
    goals: "1. 产出 /tmp/f2/a.txt\n2. 产出 /tmp/f2/b.txt",
    deliverable: "/tmp/f2/a.txt, /tmp/f2/b.txt",
  },
  {
    id: "③-全部未产出",
    desc: "2 子项产出 0（对照行标 2 条未产出）",
    expect: "FAIL_INCOMPLETE",
    goals: "1. 产出 /tmp/f2/x.txt\n2. 产出 /tmp/f2/y.txt",
    deliverable: "/tmp/f2/a.txt",
  },
  {
    id: "④-无编号子项",
    desc: "goals 无编号子项（不生成对照行）",
    expect: "N/A",
    goals: "把事情做好",
    deliverable: "/tmp/f2/a.txt",
  },
  {
    id: "⑤-URL交付物",
    desc: "交付物是 URL（不生成对照行）",
    expect: "N/A",
    goals: "1. 发布 https://my.feishu.cn/docx/abc",
    deliverable: "https://my.feishu.cn/docx/abc",
  },
  {
    id: "⑥-强不一致",
    desc: "声明与 goals 完全无关（强 FAIL 信号）",
    expect: "FAIL_INCOMPLETE",
    goals: "1. 产出 /tmp/f2/a.txt\n2. 产出 /tmp/f2/b.txt",
    deliverable: "/tmp/f2/zzz-other.txt",
  },
];

interface Row {
  scenario: string;
  i: number;
  choice: string;
  picked: number;
  x_jev?: number;
  answer_conf?: number;
  entropy?: number;
  gate: boolean;
  checklist: boolean;
}

async function main() {
  const auth = await loadLayaAuthForPurpose(undefined, "goal");
  if (!auth) {
    console.error("❌ 读不到 laya auth —— 调研无法进行");
    process.exit(1);
  }
  const port = new LayaDecisionPort({
    baseURL: auth.baseURL, apiKey: auth.apiKey, model: auth.model, timeoutMs: 8000,
  });

  const rows: Row[] = [];
  for (const sc of SCENARIOS) {
    const state = renderCompletionState(makeTask(sc.goals, sc.deliverable), OPS);
    const checklist = state.includes("【逐条对照】");
    for (let i = 1; i <= REPEAT; i++) {
      try {
        const res = await port.decide({ state, questions: buildCompletionQuestion() } as any);
        const answer = res?.answers?.["completion_check"];
        const x = (answer as any)?.x_jev_confidence;
        const a = (answer as any)?.answer_confidence;
        const e = (answer as any)?.confidence;
        const picked = pickGateConfidence(answer as any);
        const choice = String((answer as any)?.choice ?? "(none)");
        const row: Row = {
          scenario: sc.id, i, choice, picked,
          x_jev: typeof x === "number" ? x : undefined,
          answer_conf: typeof a === "number" ? a : undefined,
          entropy: typeof e === "number" ? e : undefined,
          gate: picked >= 0.92, checklist,
        };
        rows.push(row);
        console.log(
          `[${sc.id} #${i}] choice=${choice} x_jev=${fmt(x)} ` +
            `answer_conf=${fmt(a)} entropy=${fmt(e)} picked=${picked.toFixed(4)} ` +
            `gate=${row.gate} checklist=${checklist}`,
        );
      } catch (err) {
        console.log(`[${sc.id} #${i}] ERROR ${(err as Error).message}`);
      }
    }
  }

  console.log("\n===== 矩阵汇总 =====");
  console.log(
    "形态 | n | 对照行 | picked(min/avg/max) | 门禁≥0.92 | 方向 | 期望",
  );
  for (const sc of SCENARIOS) {
    const rs = rows.filter((r) => r.scenario === sc.id);
    if (rs.length === 0) continue;
    const picks = rs.map((r) => r.picked);
    const min = Math.min(...picks), max = Math.max(...picks);
    const avg = picks.reduce((a, b) => a + b, 0) / picks.length;
    const passed = rs.filter((r) => r.gate).length;
    const dirOk = rs.filter((r) => r.choice === sc.expect).length;
    console.log(
      `${sc.id} | ${rs.length} | ${rs[0]!.checklist ? "有" : "无"} | ` +
        `${min.toFixed(4)}/${avg.toFixed(4)}/${max.toFixed(4)} | ` +
        `${passed}/${rs.length} | ${dirOk}/${rs.length} | ${sc.expect}`,
    );
  }
}

function fmt(v: unknown): string {
  return typeof v === "number" ? v.toFixed(4) : "n/a";
}

void main();
