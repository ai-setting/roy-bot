/**
 * Task #4815 真机验证脚本（隔离 HOME）
 *
 * 验证链路（全部用真实组件，不用 mock）：
 * 1. 真实 EnvironmentService 加载隔离 HOME 的 event-sources.json
 * 2. 真实 EventSourceComponent 启动 timer（schedule 模式）
 * 3. 真实 EventHandler + 真实 SessionComponent（sqlite）消费事件
 * 4. 断言：
 *    a. 到点触发（事件真的来了）
 *    b. prompt 注入正确（是当次 schedule 项的 prompt）
 *    c. 事件路由到**独立 session**（sessionId == 期望的 trigger session，不是主会话）
 *    d. 独立 session 在 DB 里真的被创建了
 *    e. 同日不重复触发
 *
 * 用法：
 *   HOME=/tmp/timer-4815-verify/home bun run scripts/verify-timer-schedule-e2e.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { EnvironmentService } from "../packages/cli/src/services/environment.service";
import { OutputService } from "../packages/cli/src/services/output.service";
import { EventHandler } from "../packages/cli/src/commands/shared/event-handler";
import { EventMessageFormatter } from "../packages/cli/src/commands/shared/event-message-formatter";
import type { EventSourceConfig } from "@ai-setting/roy-bot-core";

const VERIFY_SESSION_ID = "daily-summary-session";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const home = process.env.HOME ?? homedir();
  console.log(`[verify] 隔离 HOME = ${home}`);

  // ── 1. 加载真实 event-sources.json ────────────────────────────────
  const configPath = join(home, ".roy-bot", "event-sources.json");
  const raw = await Bun.file(configPath).text();
  const parsed = JSON.parse(raw) as { sources: EventSourceConfig[] };
  const timerSource = parsed.sources.find((s) => s.type === "timer");
  if (!timerSource) {
    console.error("[verify] ❌ 隔离环境里没有 timer 事件源");
    process.exit(1);
  }
  console.log(`[verify] 找到 timer 事件源: ${timerSource.name} (${timerSource.id})`);

  // 触发时刻设为「1 分钟后」（保证真机能等到）
  const target = new Date(Date.now() + 60_000);
  const hh = String(target.getHours()).padStart(2, "0");
  const mm = String(target.getMinutes()).padStart(2, "0");
  const targetTime = `${hh}:${mm}`;
  const marker = `【真机验证】${targetTime}`;
  const schedule = [{ time: targetTime, prompt: marker, label: "e2e" }];
  timerSource.options = { ...(timerSource.options ?? {}), schedule };
  console.log(`[verify] 目标触发时刻 = ${targetTime}`);

  // ── 2. 真实 EnvironmentService ───────────────────────────────────
  const output = new OutputService();
  const envService = new EnvironmentService(output);
  await envService.create({
    quiet: true,
    sessionStorage: {
      type: "sqlite",
      dbPath: join(home, ".roy-bot", "sessions-verify.db"),
    },
    taskStorage: { type: "memory" },
  });
  const env = envService.getEnvironment();
  if (!env) throw new Error("env 创建失败");

  const esComponent = env.getComponent("event-source") as any;
  const sessionComponent = env.getComponent("session") as any;

  // ── 3. 真实 EventHandler + 真实 SessionComponent ──────────────────
  const formatter = new EventMessageFormatter({ prefix: "[验证]" });
  const received: { message: string; sessionId?: string; metadata: any }[] = [];

  const handler = new EventHandler({
    env: env as any,
    eventTypes: ["event-source.event.*"],
    formatter,
    isIdle: () => true,
    onEvent: async () => {},
    onEventWithEnv: async (fe: any) => {
      received.push({
        message: fe.message,
        sessionId: fe.eventSessionId,
        metadata: fe.envEvent?.metadata,
      });
    },
    sessionComponent,
  } as any);
  handler.start();

  // ── 4. 找到已加载的 timer 实例并更新 schedule（环境已自动加载配置）──
  const loaded = esComponent
    .list()
    .find((s: any) => s.type === "timer") as any;
  if (!loaded) {
    console.error("[verify] ❌ 事件源组件里没有 timer");
    await envService.dispose();
    process.exit(1);
  }
  // 更新 schedule（用 update API，保证走真实的 update 链路）
  await esComponent.update(loaded.id, { options: { ...(loaded.options ?? {}), schedule } });
  await esComponent.startSource(loaded.id);

  const esId = loaded.id;
  console.log(`[verify] timer 已启动，等待 ${targetTime} 触发（最长 150 秒）...`);

  // ── 5. 等待触发 ───────────────────────────────────────────────────
  const deadline = Date.now() + 150_000;
  while (received.length === 0 && Date.now() < deadline) {
    await sleep(1000);
  }

  // ── 6. 断言 ───────────────────────────────────────────────────────
  if (received.length === 0) {
    check("定时触发", false, "150 秒内没有收到任何事件");
    await envService.dispose();
    process.exit(1);
  }
  check("定时触发", true, `收到 ${received.length} 个事件`);

  const first = received[0];

  check(
    "prompt 注入正确",
    first.message.includes(marker),
    `事件消息包含当次 prompt 标记「${marker}」`,
  );

  check(
    "事件路由到独立 session",
    first.sessionId === VERIFY_SESSION_ID,
    `eventSessionId = ${first.sessionId}（期望 ${VERIFY_SESSION_ID}）`,
  );

  check(
    "metadata 带 trigger_session_id",
    first.metadata?.trigger_session_id === VERIFY_SESSION_ID,
    `metadata.trigger_session_id = ${first.metadata?.trigger_session_id}`,
  );

  check(
    "metadata 带 createSessionIfMissing",
    first.metadata?.createSessionIfMissing === true,
    `metadata.createSessionIfMissing = ${first.metadata?.createSessionIfMissing}`,
  );

  check(
    "metadata 带 scheduleLabel",
    first.metadata?.scheduleLabel === "e2e",
    `metadata.scheduleLabel = ${first.metadata?.scheduleLabel}`,
  );

  // 独立 session 在 DB 里真的存在
  const created = await sessionComponent.get(VERIFY_SESSION_ID);
  check(
    "独立 session 已落库",
    !!created,
    created
      ? `sessionComponent.get("${VERIFY_SESSION_ID}") 返回 ${created.id}`
      : "session 不存在",
  );

  // 主会话没被污染（active session 不应是独立 session）
  const activeId = sessionComponent.getActiveSessionId();
  check(
    "未污染 REPL 主会话",
    activeId !== VERIFY_SESSION_ID,
    `getActiveSessionId() = ${activeId}（不应等于独立 session）`,
  );

  // 同日不重复触发：再等 40 秒（tick 每 30s 一次），确认不重复
  console.log("[verify] 等待 40 秒确认同日不重复触发...");
  await sleep(40_000);
  check(
    "同日不重复触发",
    received.length === 1,
    `40 秒后累计事件数 = ${received.length}（期望 1）`,
  );

  handler.stop();
  await esComponent.stopSource(esId);
  await envService.dispose();

  // ── 7. 汇总 ───────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(
    `=== 真机验证结果：${results.length - failed.length}/${results.length} 通过 ===`,
  );
  if (failed.length > 0) {
    console.log("失败项：");
    for (const f of failed) console.log(`  ❌ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("全部通过 ✅");
}

main().catch((err) => {
  console.error("[verify] 异常：", err);
  process.exit(1);
});
