/**
 * @fileoverview Task #4620 — 端到端验证脚本（真调本地 laya 服务 + 真 task_create）
 *
 * 目的：证明「task_create 带上 similar_task_ids → output 里真的出现 hint」这条链路
 * 在**真实服务 + 真实 TaskComponent + 真实 create-tool** 下是通的。
 *
 * 跑法：
 *   cd <worktree>/packages/core
 *   bun run src/env/task/plugins/__e2e__/laya-e2e-verify.ts
 *
 * 前置：
 *   - laya-serve 已在 http://127.0.0.1:8901 跑着（scripts/serve_laya.sh）
 *   - ~/.roy-bot/auth.json 有 providers['laya-decision']
 *
 * ⚠️ 本脚本**只写临时 sqlite**（tmpdir），不碰真实 tasks.db。
 */

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TaskComponent } from "../../task-component";
import { ConfigComponent } from "../../../../config/config-component";
import { createTaskTool } from "../../tools/create-tool";
import { LayaDecisionPlugin } from "../laya-decision-plugin";
import { TaskHookPoints } from "../../hooks/task-hook-points";

async function main(): Promise<number> {
  // ── 1. 起一个隔离的 TaskComponent（临时 sqlite） ──────────────────
  const configComponent = new ConfigComponent();
  const taskComponent = new TaskComponent();
  const dbPath = join(mkdtempSync(join(tmpdir(), "laya-e2e-")), "tasks.db");
  await taskComponent.init({
    options: {
      configComponent,
      config: { storage: { type: "sqlite", dbPath } },
    },
  });

  console.log("=== Task #4620 端到端验证 ===");
  console.log("db:", dbPath);

  try {
    // ── 2. 建两个「已存在的候选任务」 ───────────────────────────────
    const tool = createTaskTool(taskComponent);
    const mk = async (title: string, desc: string, tags: string[]) => {
      const r = await tool.execute(
        { title, description: desc, tags, project_path: "/tmp/laya-e2e", context: '{"type":"general"}' },
        { session_id: "sess_laya_e2e" } as any,
      );
      const id = Number(String((r as any).output).match(/#(\d+)/)?.[1]);
      console.log(`  created #${id} ${title}`);
      return id;
    };

    const c1 = await mk(
      "[E2E-4620] 封装 Laya 模型成 Jev 语义服务",
      "把训练好的 Laya checkpoint 封装成标准 Jev 语义 HTTP 服务，写入 auth.json",
      ["laya", "service"],
    );
    const c2 = await mk(
      "[E2E-4620] 在 roy-bot 里接入 Laya 决策端口",
      "在 roy-bot 新 worktree 实现 Laya decision port 并集成到 task:before.create hook",
      ["laya", "client"],
    );

    // ── 3. 挂上 Laya 决策插件（真读 auth.json、真调服务） ────────────
    const plugin = new LayaDecisionPlugin({
      authPath: `${process.env.HOME ?? "~"}/.roy-bot/auth.json`,
      timeoutMs: 2000,
    });
    taskComponent.registerHook(TaskHookPoints.BEFORE_CREATE, {
      name: "laya-decision",
      priority: 10,
      execute: async (ctx: any) => {
        await plugin.execute(ctx);
      },
    } as any);
    console.log("  registered hook:", TaskHookPoints.BEFORE_CREATE);

    // ── 4. 造一个「与候选高度重叠」的请求 ──────────────────────────
    const title = "[E2E-4620] 把 Laya 封装成 Jev 语义 HTTP 服务并接进 roy-bot";
    const description =
      "把训练好的 Laya 模型封装成标准 Jev 语义 HTTP 服务，写入 auth.json，" +
      "然后在 roy-bot 的新 worktree 里实现 client 并集成到 task:before.create hook。";

    const t0 = Date.now();
    const res = await tool.execute(
      {
        title,
        description,
        tags: ["laya", "service"],
        project_path: "/tmp/laya-e2e",
        // ⚠️ 关键：把候选 id 传给决策检查
        context: JSON.stringify({
          type: "feature",
          similar_task_ids: [c1, c2],
        }),
      },
      { session_id: "sess_laya_e2e" } as any,
    );
    const elapsed = Date.now() - t0;
    const output = String((res as any).output);

    console.log("");
    console.log("=== task_create output ===");
    console.log(output);
    console.log("=======================");
    console.log(`elapsed: ${elapsed}ms`);

    const hasHint = output.includes("[TASK_CREATE_HINT]");
    console.log("");
    console.log(`hint present : ${hasHint ? "YES ✅" : "NO ❌"}`);
    console.log(`new task id  : ${String((res as any).output).match(/#(\d+)/)?.[1]}`);
    console.log(`elapsed      : ${elapsed}ms`);

    if (!hasHint) {
      console.log("");
      console.log("诊断：hint 没出现。可能原因 ——");
      console.log("  1. 模型判了 NEW_TASK（这是合法结果：本次请求与候选足够像时应判复用）");
      console.log("  2. confidence < 0.85 门禁");
      console.log("  3. 服务不可达 / auth.json 缺 provider");
      console.log("  → 看上面的 output 与 roy-bot 日志里的 [laya-decision] / [decision-hint] 行");
    }
    return hasHint ? 0 : 3;
  } finally {
    await taskComponent.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("E2E FAILED:", err);
    process.exit(1);
  });
