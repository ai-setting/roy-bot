/**
 * @fileoverview Task #4620 — 全链路验证：真实 layaRenderer + 真实 LayaDecisionPort
 *
 * 目的：证明「roy-bot 侧渲染 + client + laya 服务」这条完整链路
 * 在**有 ground truth 的 held-out 集**上能复现 #4614 报告的准确率。
 *
 * 这比单点验证强得多：
 *   - 只测 client → 只能证明协议通
 *   - 只测渲染 → 只能证明格式对
 *   - 全链路 → 证明「roy-bot 发的请求」与「训练分布」一致，且结果可复现
 *
 * 跑法（worktree 的 packages/core 下）：
 *   bun run src/env/task/plugins/__e2e__/laya-chain-validate.ts
 */

import { readFileSync } from "fs";
import { LayaDecisionPort, loadLayaAuth } from "../laya-port";
import { layaRenderer } from "../decision-renderers";
import { matchChoiceToCandidate } from "../laya-render";

interface HeldoutRow {
  state: string;
  questions: { reuse_or_create: { type: string; instructions: string; criteria: Record<string, string> } };
  expected?: { reuse_or_create?: string };
}

/** 把 held-out 的一行还原成 roy-bot 侧的 Task 列表 */
function rowToTasks(row: HeldoutRow): { tasks: any[]; gold: string } {
  const crit = row.questions.reuse_or_create.criteria;
  const tasks: any[] = [];
  let gold = "";
  for (const [key, value] of Object.entries(crit)) {
    if (key === "NEW_TASK") continue;
    const m = /^#(\d+)\s+(.*)$/.exec(key);
    if (!m) continue;
    const id = Number(m[1]);
    const title = m[2];
    // value 格式：`{letter}|{ago}|{desc} [tags: ...]`
    const parts = value.split("|");
    const desc = (parts[2] ?? "").replace(/\s*\[tags:.*$/, "");
    const tagsM = /\[tags: ([^\]]*)\]/.exec(value);
    const tags = tagsM ? tagsM[1].split(",").filter(Boolean) : [];
    const statusMap: Record<string, string> = { A: "active", T: "todo", C: "completed", P: "paused", X: "cancelled", R: "archived" };
    tasks.push({
      id,
      title,
      description: desc,
      status: statusMap[parts[0] ?? "T"] ?? "todo",
      type: "normal",
      tags,
      updatedAt: new Date(Date.now() - 5 * 86400_000).toISOString(),
    });
  }
  gold = row.expected?.reuse_or_create ?? "";
  return { tasks, gold };
}

async function main(): Promise<number> {
  const cfg = await loadLayaAuth();
  if (!cfg) {
    console.error("FAIL: providers['laya-decision'] not found in auth.json");
    return 1;
  }
  const port = new LayaDecisionPort({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.model,
    timeoutMs: 5000,
  });

  const path = process.env.HELDOUT ?? "data/heldout-base.jsonl";
  const limit = Number(process.env.LIMIT ?? 200);
  const rows: HeldoutRow[] = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => JSON.parse(l))
    .slice(0, limit);

  console.log("=== Task #4620 全链路验证（真实 renderer + 真实 client + 真实服务）===");
  console.log(`auth : ${cfg.baseURL} model=${cfg.model}`);
  console.log(`data : ${path} (${rows.length} cases)`);
  console.log("");

  let hits = 0;
  let reuse = 0;
  let reuseHit = 0;
  let newTaskPred = 0;
  let errors = 0;
  const lats: number[] = [];
  const confScan: Record<string, { n: number; ok: number }> = {};

  for (const row of rows) {
    const { tasks, gold } = rowToTasks(row);
    if (tasks.length === 0) continue;

    const req = layaRenderer.buildStageA({
      title: "【新任务标题】" + (row.state.match(/【新任务标题】(.*)/)?.[1] ?? "t"),
      description: row.state.match(/【新任务描述】(.*)/)?.[1] ?? "",
      goals: "",
      tags: [],
      projectPath: "",
      candidates: tasks,
      now: Date.now(),
    });

    const t0 = Date.now();
    let res: any;
    try {
      res = await port.decide(req as any);
    } catch (err) {
      errors += 1;
      console.error("  ERR", (err as Error).message);
      continue;
    }
    lats.push(Date.now() - t0);

    const answer = res?.answers?.["reuse_or_create"];
    const choice = answer?.choice;
    const confidence = answer?.confidence ?? 0;

    // 用 gold 的 #id 判定命中（gold 是完整的 key，截断过）
    const goldId = /^#(\d+)/.exec(gold ?? "")?.[1];
    const predId = /^#(\d+)/.exec(choice ?? "")?.[1];

    let hit = choice === gold;
    if (!hit && goldId && predId) hit = goldId === predId;
    if (hit) hits += 1;

    if (choice && choice !== "NEW_TASK") {
      reuse += 1;
      if (hit) reuseHit += 1;
      // 阈值扫描
      for (const thr of ["0.5", "0.6", "0.7", "0.8", "0.85", "0.9", "0.95"]) {
        if (confidence >= Number(thr)) {
          confScan[thr] ??= { n: 0, ok: 0 };
          confScan[thr].n += 1;
          if (hit) confScan[thr].ok += 1;
        }
      }
    } else {
      newTaskPred += 1;
    }
  }

  const n = rows.length;
  const p50 = lats.sort((a, b) => a - b)[Math.floor(lats.length / 2)];
  console.log("=== 结果 ===");
  console.log(`总准确率     : ${hits}/${n} = ${((hits / n) * 100).toFixed(2)}%`);
  console.log(`判复用子集   : ${reuseHit}/${reuse} = ${reuse ? ((reuseHit / reuse) * 100).toFixed(2) : "n/a"}%`);
  console.log(`判 NEW_TASK  : ${newTaskPred}/${n} = ${((newTaskPred / n) * 100).toFixed(1)}%`);
  console.log(`延迟 p50     : ${p50}ms   errors=${errors}`);
  console.log("");
  console.log("阈值扫描（判复用的子集内）：");
  for (const thr of ["0.5", "0.6", "0.7", "0.8", "0.85", "0.9", "0.95"]) {
    const s = confScan[thr];
    if (!s) continue;
    console.log(`  thr=${thr}  n=${String(s.n).padStart(3)}  precision=${((s.ok / s.n) * 100).toFixed(1)}%`);
  }
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
