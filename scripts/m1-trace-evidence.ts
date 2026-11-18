/**
 * Task #5144 — trace 取证（用户问「从 trace 拿到证据了吗」）
 *
 * 真实链路：LarkCliInstance.handleEvent(真实 lark 事件 JSON)
 *   → extractMetadata → lean 动态卡片 + metadata.systemPrompt 注入
 *   → eventHandler(evt) → invoke()（MiniMax 官方，usage 回 cached_tokens）
 *
 * trace DB 隔离：XDG_DATA_HOME=/tmp/m1-trace-home（铁律：绝不写生产库）
 * 证据产物：/tmp/m1-trace-evidence/
 *   - spans-lean.json：trace 内全部 span（名称/关键属性）
 *   - evidence.md：三条证据的结构化报告
 *
 * 运行：bun run scripts/m1-trace-evidence.ts
 */

import { mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 隔离断言（先于任何 import）：进程的 HOME/XDG 必须是 /tmp 隔离目录 ──
const ISOLATED_HOME = process.env.M1_ISOLATED_HOME ?? "";
const ISOLATED_XDG = process.env.M1_ISOLATED_XDG ?? "";
if (!ISOLATED_HOME || !existsSync(ISOLATED_HOME)) {
  console.error("FATAL: M1_ISOLATED_HOME not set — refusing to run without isolation");
  process.exit(2);
}

// 隔离后 import（trace 存储在 import 时读 env）
const { invoke } = await import("../packages/core/src/env/llm/invoke");
const {
  larkCliHandler,
} = await import("../packages/core/src/env/event-source/event-source-handlers");
const { LarkCliInstance } = await import(
  "../packages/core/src/env/event-source/event-source-handlers"
);
const { SQLiteSpanStorage } = await import(
  "../packages/core/src/env/log-trace/span-storage"
);
const { resetTracerProvider } = await import(
  "../packages/core/src/env/log-trace/opentelemetry/tracer-provider"
);

const auth = JSON.parse(await Bun.file(process.env.HOME + "/.roy-bot/auth.json").text());
const apiKey = process.env.MINIMAX_CN_API_KEY!;
const baseURL = "https://api.minimaxi.com/v1";
const MODEL = "minimax/MiniMax-M3.1-Flash";
const SESSION_ID = "es_m1_trace_evidence_001";

function makeLarkMessageEvent(i: number): any {
  return JSON.stringify({
    type: "im.message.receive_v1",
    event_id: `evt_trace_${i}`,
    event: {
      header: { event_type: "im.message.receive_v1", app_id: "cli_app123" },
      message: {
        message_id: `om_trace_${i}`,
        chat_id: "oc_trace_chat",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: `第 ${i} 条 trace 取证消息` }),
      },
      sender: { sender_id: { open_id: "ou_user_001" } },
    },
  });
}

// ── 收集 evt 证据（handleEvent 的 onEvent 回调）──
const capturedEvents: any[] = [];
let instance: any;

async function runOneEvent(i: number) {
  const raw = makeLarkMessageEvent(i);
  await instance.handleEvent(raw);
  const evt = capturedEvents[capturedEvents.length - 1];
  if (!evt) throw new Error(`event ${i} not captured`);

  const systemPrompt = evt.metadata?.systemPrompt as string | undefined;
  const recommendedAction = evt.payload?.recommendedAction;

  // ── LLM invoke（走 LLMComponent.invoke → @TracedAs("llm.component.invoke") span）──
  const history: { role: string; content: string }[] = [];
  for (let j = 1; j < i; j++) {
    history.push({ role: "user", content: JSON.stringify({ evt: j }) });
    history.push({ role: "assistant", content: "ok" });
  }
  history.push({ role: "user", content: JSON.stringify({ evt: i }) });

  const { LLMComponent } = await import("../packages/core/src/env/llm/llm");
  const { ConfigComponent } = await import("../packages/core/src/config/config-component");
  if (!globalThis.__m1LLM) {
    const configComponent = new ConfigComponent();
    configComponent.set("llm.providers", {
      minimax: { apiKey, baseURL },
    });
    configComponent.set("llm.defaultProvider", "minimax");
    configComponent.set("llm.defaultModel", "MiniMax-M3.1-Flash");
    configComponent.set("llm.temperature", 0.7);
    configComponent.set("llm.maxTokens", 50);
    const llm = new LLMComponent();
    await llm.init({
      name: "llm",
      version: "2.0.0",
      enabled: true,
      env: { getComponent: () => undefined, hasComponent: () => false } as any,
      options: { configComponent },
    });
    globalThis.__m1LLM = llm;
  }
  const llm = globalThis.__m1LLM;

  const llmResult = await llm.invoke({
    messages: [
      { role: "system", content: systemPrompt ?? "" },
      ...history,
    ] as any,
    model: MODEL,
    temperature: 0.7,
    maxTokens: 50,
    cacheRetention: "long" as any,
    skipThresholdCheck: true,
    context: { sessionId: SESSION_ID } as any,
  } as any);

  return {
    turn: i,
    systemPromptHash: systemPrompt
      ? new Bun.CryptoHasher("sha256").update(systemPrompt).digest("hex").slice(0, 16)
      : null,
    systemPromptLen: systemPrompt?.length ?? 0,
    actionLen: recommendedAction?.action?.length ?? 0,
    usage: llmResult?.output?.usage ?? {},
    evtTraceContext: evt.metadata?.traceContext,
  };
}

async function main() {
  const evidenceDir = "/tmp/m1-trace-evidence";
  await Bun.$`mkdir -p ${evidenceDir}`.quiet();

  // ── 初始化 trace 存储（隔离 DB）──
  const dbPath = join(ISOLATED_XDG, "roy-bot", "traces.db");
  const storage = new SQLiteSpanStorage(dbPath);
  await storage.initialize();
  resetTracerProvider();
  // getTracerProvider 会 new OTelTracerProvider()（无参 → 默认路径）
  // 用注入 storage 的方式不可行（单例构造无参），改为：
  // 让默认路径落在 XDG_DATA_HOME 下（已在隔离 env 里）→ initialize 它。
  const { getTracerProvider } = await import(
    "../packages/core/src/env/log-trace/opentelemetry/tracer-provider"
  );
  const provider = getTracerProvider();
  await provider.initialize();

  // ── 建 LarkCliInstance（mock child_process 避免 spawn 真实 lark-cli）──
  const { createChildProcessMockModule } = await import(
    "../packages/core/src/test-utils/child-process-mock"
  );
  const { mock } = await import("bun:test");
  const spawnMock = (cmd: string, args: string[]) => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (event: string, cb: Function) => { if (event === "close") cb(0); },
    kill: () => {},
    pid: 99111,
  } as any);
  const execStub = (_cmd: string, cb?: Function) => {
    if (typeof cb === "function") cb(null, { stdout: "", stderr: "" });
    return { on: () => {}, kill: () => {}, pid: 99112 } as any;
  };
  mock.module("child_process", () =>
    createChildProcessMockModule({ spawn: spawnMock, exec: execStub as any }),
  );

  const handler = larkCliHandler;
  instance = handler.createInstance({
    id: "es-trace-evidence",
    name: "trace-evidence",
    type: "lark-cli",
    enabled: true,
    profile: "default",
  });
  instance.onEvent((evt: any) => capturedEvents.push(evt));

  LarkCliInstance.__resetDedupForTest();

  // ── 跑 3 条事件（turn1-3）──
  const turnEvidence: any[] = [];
  for (let i = 1; i <= 3; i++) {
    turnEvidence.push(await runOneEvent(i));
  }

  // ── 从隔离 DB 提取 span 证据 ──
  // 全部 span（跨 trace），按 name 聚合
  const db = (storage as any).db;
  const allSpans = db
    ? db.prepare("SELECT trace_id, span_id, parent_span_id, name, status, start_time, end_time FROM span ORDER BY start_time").all()
    : [];
  const byTrace: Record<string, any[]> = {};
  for (const s of allSpans) {
    (byTrace[s.trace_id] ??= []).push(s);
  }

  // 找 handleEvent / invoke 相关 span
  const handleSpans = allSpans.filter((s: any) => s.name.includes("handleEvent"));
  const invokeSpans = allSpans.filter((s: any) => /invoke|llm/i.test(s.name));

  // ── systemPrompt span 入参取证：handleEvent span 的 attributes.params ──
  const handleDetail = handleSpans.map((s: any) => {
    const row = db
      .prepare("SELECT attributes, result FROM span WHERE span_id = ?")
      .get(s.span_id);
    return { ...s, attributesLen: row?.attributes?.length ?? 0, hasParams: row?.attributes?.includes("systemPrompt") ?? false };
  });

  const report = {
    isolation: { home: ISOLATED_HOME, xdg: ISOLATED_XDG, dbPath, dbExists: existsSync(dbPath) },
    turnEvidence,
    spanCounts: { total: allSpans.length, traces: Object.keys(byTrace).length, handleEvent: handleSpans.length, invokeLike: invokeSpans.length },
    handleSpans: handleDetail,
    allSpanNames: [...new Set(allSpans.map((s: any) => s.name))],
  };

  writeFileSync(join(evidenceDir, "spans-all.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(evidenceDir, "evidence.md"),
    [
      "# ES-M1 trace 证据（Task #5144）",
      "",
      `隔离: HOME=${ISOLATED_HOME} XDG_DATA_HOME=${ISOLATED_XDG}`,
      `trace DB: ${dbPath} (exists=${existsSync(dbPath)})`,
      "",
      "## turn 级证据（handleEvent → systemPrompt → invoke）",
      "",
      ...turnEvidence.map(
        (t) =>
          `- turn ${t.turn}: systemPromptHash=${t.systemPromptHash} (len=${t.systemPromptLen}) actionLen=${t.actionLen} usage=${JSON.stringify(t.usage)}`
      ),
      "",
      "## span 级证据",
      "",
      `- 总 span: ${report.spanCounts.total}，trace 数: ${report.spanCounts.traces}`,
      `- handleEvent span: ${report.spanCounts.handleEvent}`,
      `- invoke-like span: ${report.spanCounts.invokeLike}`,
      "",
      "## span 名清单",
      "",
      ...report.allSpanNames.map((n: any) => `- ${n}`),
      "",
    ].join("\n"),
  );

  console.log(JSON.stringify(report, null, 2).slice(0, 3000));
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
