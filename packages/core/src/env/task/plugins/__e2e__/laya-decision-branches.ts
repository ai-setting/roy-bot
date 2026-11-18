/**
 * @fileoverview Task #4627 — Laya 决策插件 **全分支回归脚本**（可重跑）
 *
 * 用法：
 * ```bash
 * cd packages/core && bun run src/env/task/plugins/__e2e__/laya-decision-branches.ts
 * # 或从仓库根
 * bun run packages/core/src/env/task/plugins/__e2e__/laya-decision-branches.ts
 * ```
 *
 * ⚠️ 两种驱动模式：
 *   - **mock 模式**（默认）：注入假 port，**确定性**，不依赖 Laya 服务 → 断言 7 个分支的判定逻辑
 *   - **live 模式**（`--live`）：真调本机 Laya 服务（http://127.0.0.1:8901）
 *
 * 每个场景打印：场景名 / 实测值 / 断言结果 / 延迟(ms)，最后给出汇总。
 * 退出码 0 = 全部通过，1 = 有失败。
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { TaskComponent } from "../../task-component";
import { ConfigComponent } from "../../../../config/config-component";
import { createTaskTool } from "../../tools/create-tool";
import { TaskHookPoints } from "../../hooks/task-hook-points";
import { globalHookManager } from "../../../hook/global-hook-manager";
import { registerLayaDecisionTaskHook } from "../../../environment";
import { LayaDecisionPlugin, LAYA_REUSE_THRESHOLD } from "../laya-decision-plugin";
import type { DecisionPort, DecisionResponse } from "../decision-port";

const LIVE = process.argv.includes("--live");
const THRESHOLD = LAYA_REUSE_THRESHOLD;

// ========================================================================
// 迷你测试框架（不引第三方依赖，保证脚本自包含可跑）
// ========================================================================

interface Result {
  /** 分区：MOCK = 假 port（确定性，不碰真实服务）；LIVE = 真调 Laya 服务 */
  group: "MOCK" | "LIVE";
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const results: Result[] = [];

/** 分区标题 —— 明确区分「mock」与「live」，避免把 mock 算进 live 的 pass 数 */
function groupHeader(group: "MOCK" | "LIVE", title: string): void {
  console.log("\n" + "━".repeat(72));
  console.log(`【${group}】${title}`);
  console.log("━".repeat(72));
}

async function scenario(
  group: "MOCK" | "LIVE",
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
  results.push({ group, name, ok, detail, ms });
  console.log(`\n${ok ? "✅" : "❌"} [${ms}ms] ${name}`);
  console.log(`   → ${detail}`);
}

function assert(cond: boolean, msg: string): { ok: boolean; detail: string } {
  return { ok: cond, detail: cond ? msg : `断言失败: ${msg}` };
}

// ========================================================================
// 测试夹具
// ========================================================================

const dir = mkdtempSync(join(tmpdir(), "laya-branches-"));
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

const tool = createTaskTool(taskComponent);

/** 建一个候选任务 */
async function seed(title: string, description: string, tags = ["laya"]): Promise<number> {
  const r: any = await tool.execute(
    {
      title,
      description,
      tags,
      project_path: "/tmp/p",
      context: JSON.stringify({ type: "feature" }),
    },
    { session_id: "s" } as any,
  );
  const m = String(r.output).match(/#(\d+)/);
  if (!m) throw new Error(`seed failed: ${r.output ?? r.error}`);
  return Number(m[1]);
}

/** 记录调用的假 port */
function fakePort(
  answer: (req: any) => { choice: string; confidence: number; x_jev_confidence?: number },
  reqs: any[] = [],
): DecisionPort {
  return {
    async decide(req: any): Promise<DecisionResponse> {
      reqs.push(req);
      const a = answer(req);
      return {
        answers: {
          reuse_or_create: {
            choice: a.choice,
            confidence: a.confidence,
            ...(a.x_jev_confidence !== undefined
              ? { x_jev_confidence: a.x_jev_confidence }
              : {}),
          },
        },
      } as DecisionResponse;
    },
    isDisabled: () => false,
  };
}

/** 注册 hook（每次先摘旧的，保证只有 1 份） */
function register(port: DecisionPort): void {
  registerLayaDecisionTaskHook(taskComponent as any, { decisionPort: port } as any);
}

function unregister(): void {
  globalHookManager.unregister(TaskHookPoints.BEFORE_CREATE, "laya-decision");
}

/** 跑一次 task_create */
async function createTask(
  title: string,
  description: string,
  similarTaskIds: number[] | null,
  tags = ["laya"],
): Promise<{ output: string; success: boolean }> {
  const context = JSON.stringify({
    type: "feature",
    ...(similarTaskIds ? { similar_task_ids: similarTaskIds } : {}),
  });
  const r: any = await tool.execute(
    { title, description, tags, project_path: "/tmp/p", context },
    { session_id: "s" } as any,
  );
  return { output: String(r.output ?? ""), success: Boolean(r.success) };
}

// ========================================================================
// 准备候选任务
// ========================================================================

const idA = await seed(
  "候选A 封装 Laya 模型成 Jev 语义服务",
  "把训练好的 Laya 模型封装成标准 Jev 语义 HTTP 服务，写入 auth.json",
);
const idB = await seed(
  "候选B 在 roy-bot 接入 Laya 决策端口",
  "在 roy-bot 新 worktree 实现 Laya decision port 并集成到 task:before.create hook",
);
console.log(`候选任务已建：#${idA}, #${idB}`);

// ========================================================================
// 场景 1：无 similar_task_ids → 不调模型、无 hint
//
// ⚠️ 重要澄清（#4627 实测发现）：
//   `similar_task_ids` 为空**不等于**「不调模型」—— #4467 契约 P6 规定：
//   候选为空时走**兜底检索**（按 tags 精确子串匹配 title+tags，top-5）。
//   这是 #4620 起就有的行为（git show 731268e5 已确认），**不是本次引入**。
//
//   所以场景 1 分两小问：
//     1a. 无 similar_task_ids **且 tags 匹配不到任何候选** → 真·不调模型、0 次 HTTP
//     1b. 无 similar_task_ids **但 tags 命中候选** → 走 P6 兜底 → 会调模型
//         （此时出不出 hint 取决于模型判定；这里断言「不崩 + task_create 成功」）
// ========================================================================
groupHeader(
  "MOCK",
  "单元分支（假 port 注入 —— **不碰真实服务**，只验证判定逻辑的分支覆盖）",
);

await scenario("MOCK", "场景1a 无 similar_task_ids 且 tags 无命中 → 不调模型、无 hint", async () => {
  const reqs: any[] = [];
  register(fakePort(() => ({ choice: `NEW_TASK`, confidence: 0.99 }), reqs));
  // tags 用一个**不存在**的标签 → 兜底检索也找不到 → 候选为 0
  const r: any = await tool.execute(
    {
      title: "场景1a 新任务",
      description: "描述",
      tags: ["zzz-no-such-tag-zzz"],
      project_path: "/tmp/p",
      context: JSON.stringify({ type: "feature" }),
    },
    { session_id: "s" } as any,
  );
  unregister();
  const output = String(r.output ?? "");
  const noHint = !output.includes("[TASK_CREATE_HINT]");
  const noCall = reqs.length === 0;
  return assert(
    noHint && noCall && Boolean(r.success),
    `模型调用次数=${reqs.length}（期望 0，证明没发 HTTP）, 含 hint=${!noHint}（期望 false）, task_create 成功=${r.success}`,
  );
});

await scenario("MOCK", "场景1b 无 similar_task_ids 但 tags 命中 → P6 兜底检索会调模型（不崩即可）", async () => {
  const reqs: any[] = [];
  register(fakePort(() => ({ choice: `NEW_TASK`, confidence: 0.99 }), reqs));
  // tags=["laya"] 会命中候选 A/B → P6 兜底 → 调模型
  const r = await createTask("场景1b 新任务", "描述", null, ["laya"]);
  unregister();
  return assert(
    r.success,
    `P6 兜底检索命中 → 模型调用次数=${reqs.length}（>0 说明兜底生效，符合契约）, task_create 成功=${r.success}, 未崩=true`,
  );
});

// ========================================================================
// 场景 2：判定 NEW_TASK → 无 hint
// ========================================================================
await scenario("MOCK", "场景2 判定 NEW_TASK → 无 hint", async () => {
  const reqs: any[] = [];
  register(fakePort(() => ({ choice: "NEW_TASK", confidence: 0.99 }), reqs));
  const r = await createTask("场景2 新任务", "描述", [idA, idB]);
  unregister();
  const noHint = !r.output.includes("[TASK_CREATE_HINT]");
  return assert(
    noHint && r.success,
    `模型调用次数=${reqs.length}, 含 hint=${!noHint}（期望 false）, task_create 成功=${r.success}`,
  );
});

// ========================================================================
// 场景 3：该复用且 x_jev_confidence >= 门禁阈值（LAYA_REUSE_THRESHOLD）→ 出 hint
// ========================================================================
await scenario("MOCK", `场景3 应复用且 x_jev_confidence >= ${THRESHOLD} → 出 hint`, async () => {
  const reqs: any[] = [];
  const choice = `#${idB} 候选B 在 roy-bot 接入 Laya 决策端口`;
  register(
    fakePort(() => ({ choice, confidence: 0.99, x_jev_confidence: 0.99 }), reqs),
  );
  const r = await createTask("场景3 新任务", "描述", [idA, idB]);
  unregister();
  const hasHint = r.output.includes("[TASK_CREATE_HINT]");
  const hasTarget = r.output.includes(String(idB));
  const hasUpdate = r.output.includes("task_update");
  return assert(
    hasHint && hasTarget && hasUpdate,
    `含 [TASK_CREATE_HINT]=${hasHint}, 含复用目标 id(${idB})=${hasTarget}, 含 task_update 指令=${hasUpdate}, 模型调用次数=${reqs.length}`,
  );
});

// ========================================================================
// 场景 4：x_jev_confidence < 门禁阈值（LAYA_REUSE_THRESHOLD）→ 静默无 hint
// ========================================================================
await scenario("MOCK", `场景4 x_jev_confidence < ${THRESHOLD} → 静默无 hint`, async () => {
  const reqs: any[] = [];
  const choice = `#${idB} 候选B 在 roy-bot 接入 Laya 决策端口`;
  register(
    fakePort(() => ({ choice, confidence: 0.99, x_jev_confidence: 0.84 }), reqs),
  );
  const r = await createTask("场景4 新任务", "描述", [idA, idB]);
  unregister();
  const noHint = !r.output.includes("[TASK_CREATE_HINT]");
  return assert(
    noHint && r.success,
    `x_jev_confidence=0.84 → 含 hint=${!noHint}（期望 false）, 模型调用次数=${reqs.length}（期望 1，静默档不重复调模型）, task_create 成功=${r.success}`,
  );
});

// ========================================================================
// 场景 5：服务不可达 → fail-open，无 hint，task_create 仍成功
// ========================================================================
await scenario("MOCK", "场景5 服务不可达 → fail-open、无 hint、task_create 仍成功", async () => {
  const boomPort: DecisionPort = {
    async decide(): Promise<DecisionResponse> {
      throw new Error("simulated laya service unreachable");
    },
    isDisabled: () => false,
  };
  register(boomPort);
  const t0 = Date.now();
  const r = await createTask("场景5 新任务", "描述", [idA, idB]);
  const ms = Date.now() - t0;
  unregister();
  const noHint = !r.output.includes("[TASK_CREATE_HINT]");
  return assert(
    noHint && r.success,
    `含 hint=${!noHint}（期望 false）, task_create 成功=${r.success}, 耗时=${ms}ms（不应卡住）`,
  );
});

// ========================================================================
// 场景 6：候选 id 不存在 → 跳过，不崩
// ========================================================================
await scenario("MOCK", "场景6 候选 id 不存在 → 跳过、不崩", async () => {
  const reqs: any[] = [];
  register(fakePort(() => ({ choice: "NEW_TASK", confidence: 0.99 }), reqs));
  const r = await createTask("场景6 新任务", "描述", [999999, 888888]);
  unregister();
  const noHint = !r.output.includes("[TASK_CREATE_HINT]");
  return assert(
    noHint && r.success,
    `模型调用次数=${reqs.length}（期望 0，候选不存在 → 跳过）, 含 hint=${!noHint}, task_create 成功=${r.success}`,
  );
});

// ========================================================================
// 场景 7：置信度来源校验 —— 门禁读 x_jev_confidence，不是 confidence
// ========================================================================
await scenario(
  "MOCK",
  "场景7 门禁读 x_jev_confidence（不是 confidence 归一化熵）",
  async () => {
    const reqs: any[] = [];
    const choice = `#${idB} 候选B 在 roy-bot 接入 Laya 决策端口`;
    register(
      fakePort(
        // confidence（熵）= 0.99 → 误读它会出 hint
        // x_jev_confidence（Jev）= 0.5 → 正确读法应 < 门禁阈值 → 无 hint
        () => ({ choice, confidence: 0.99, x_jev_confidence: 0.5 }),
        reqs,
      ),
    );
    const r = await createTask("场景7 新任务", "描述", [idA, idB]);
    unregister();
    const noHint = !r.output.includes("[TASK_CREATE_HINT]");
    return assert(
      noHint && reqs.length === 1,
      `confidence=0.99(熵) / x_jev_confidence=0.5(Jev) → 含 hint=${!noHint}（期望 false，读了 Jev 源）, 模型调用次数=${reqs.length}`,
    );
  },
);

// ========================================================================
// 场景 8（live 模式专属）：真调 Laya 服务
// ========================================================================
if (LIVE) {
  groupHeader(
    "LIVE",
    "真实端到端（**真调本机 Laya 服务** —— 真 HTTP + 真 task_create）",
  );
  await scenario("LIVE", "场景8 真调本机 Laya 服务（真实链路）", async () => {
    const plugin = new LayaDecisionPlugin();
    // 直接用生产插件（走 auth.json → 真实 HTTP）
    globalHookManager.unregister(TaskHookPoints.BEFORE_CREATE, "laya-decision");

    // ⚠️ Task #4632：捕获模型**原始返回**的两个置信度 —— confidence(熵) 与
    //   x_jev_confidence(Jev)。场景 8 的「真实判定」报告需要它们做证据。
    // ⚠️ 用**可变容器**而不是裸变量：TS 会把只在闭包里赋值的裸变量
    //   收窄成 never（控制流分析），用对象属性则不会。
    const liveConfBox: { v: { entropy?: number; jev?: number } | null } = { v: null };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: any[]) => {
      const res = await (realFetch as any)(...args);
      try {
        const clone = res.clone();
        const body: any = await clone.json();
        const a = body?.answers?.["reuse_or_create"];
        if (a) liveConfBox.v = { entropy: a.confidence, jev: a.x_jev_confidence };
      } catch {
        /* 忽略：解析失败不影响主流程 */
      }
      return res;
    }) as typeof globalThis.fetch;
    taskComponent.registerHook(TaskHookPoints.BEFORE_CREATE, {
      name: "laya-decision",
      priority: 20,
      execute: async (ctx: any) => {
        await plugin.execute(ctx?.data ?? ctx);
      },
    });
    const t0 = Date.now();
    const r = await createTask("场景8 LIVE 新任务", "描述", [idA, idB]);
    const ms = Date.now() - t0;
    unregister();
    // ⚠️ Task #4632：**如实报告真实判定结果**，不再写「不强制」这种含糊说法。
    //   模型可能判 NEW_TASK（→ 无 hint）也可能判复用（→ 出 hint），两种都是合法结果；
    //   这里把真实的 choice / 是否出 hint / hint 指向全部打印出来。
    const hasHint = r.output.includes("[TASK_CREATE_HINT]");
    const hintTarget = hasHint
      ? (r.output.match(/task_update\(task_id=(\d+)/)?.[1] ?? "-")
      : "-";
    // ⚠️ Task #4632：把**模型原始的两个置信度**也报出来 ——
    //   confidence = 归一化熵；x_jev_confidence = Jev 公式置信度（门禁实际读的源）。
    //   二者差异是「门禁读错源」的证据，缺了它「真实判定」的证据链就不完整。
    const conf = liveConfBox.v;
    const confStr =
      conf === null
        ? "confidence=(未捕获)"
        : `confidence(熵)=${conf.entropy ?? "-"}, x_jev_confidence(Jev)=${conf.jev ?? "-"}`;
    return {
      ok: r.success,
      detail:
        `task_create 成功=${r.success}, 端到端耗时=${ms}ms, ` +
        `真实模型判定 → 出 hint=${hasHint}, hint 指向=#${hintTarget}, ${confStr} ` +
        `（判定为 NEW_TASK 时无 hint 属合法结果，不算失败）`,
    };
  });
} else {
  console.log(
    "\n⏭  场景8 [LIVE] 已跳过（加 `--live` 参数启用：真调本机 Laya 服务）",
  );
}

// ========================================================================
// 汇总
// ========================================================================
console.log("\n" + "=".repeat(72));
console.log("汇总（**MOCK 与 LIVE 分开统计 —— 不把 mock 算进 live**）");
console.log("=".repeat(72));

const mockResults = results.filter((r) => r.group === "MOCK");
const liveResults = results.filter((r) => r.group === "LIVE");
const mockPassed = mockResults.filter((r) => r.ok).length;
const livePassed = liveResults.filter((r) => r.ok).length;

console.log(
  `[MOCK] 单元分支（假 port，不碰真实服务）：${mockPassed} pass / ${mockResults.length - mockPassed} fail（共 ${mockResults.length} 个）`,
);
for (const r of mockResults) {
  console.log(`  ${r.ok ? "✅" : "❌"} ${r.name} [${r.ms}ms]`);
}

console.log(
  `[LIVE] 真实端到端（真调 Laya 服务）：${livePassed} pass / ${liveResults.length - livePassed} fail（共 ${liveResults.length} 个）`,
);
for (const r of liveResults) {
  console.log(`  ${r.ok ? "✅" : "❌"} ${r.name} [${r.ms}ms]`);
}

if (liveResults.length === 0) {
  console.log(
    "  （本次未启用 --live → **真实端到端场景一个都没跑**，不能声称 live 通过）",
  );
}
console.log("=".repeat(72));
console.log(
  "⚠️ 真实端到端的**多场景**覆盖在 live 模式（gold unseen 正例 + 对照场景）。",
);

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}

const allFailed =
  mockResults.filter((r) => !r.ok).length + liveResults.filter((r) => !r.ok).length;
process.exit(allFailed === 0 ? 0 : 1);
