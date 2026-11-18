/**
 * @fileoverview Trace 瘦身**端到端**测试（Task #4479）
 *
 * 上面的 `trace-filters.test.ts` 测的是 filter 函数本身。
 * 本文件测的是**真实链路**：装饰器 → OTel span → SQLiteSpanStorage → traces.db，
 * 断言**真正落库的 span 体积**从「几百 KB」降到「几 KB」。
 *
 * 这是给用户看的硬证据：不是"filter 函数返回了小数"，而是
 * "DB 里那一行的 attributes 真的变小了"。
 *
 * ⚠️ 关键：这里**必须真的调用被装饰的函数**（`wrapFunction`），
 * 让装饰器自己走 paramFilter / resultFilter / recordResult 裁决 ——
 * 如果只是手工 `span.setAttribute(...)`，测的就不是装饰器逻辑，
 * 装饰器写错了测试也照样绿（假绿）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapFunction } from "./decorator";
import {
  getTracerProvider,
  resetTracerProvider,
  setTracerProvider,
  OTelTracerProvider,
} from "./opentelemetry/tracer-provider";
import { SQLiteSpanStorage } from "./span-storage";
import { llmInvokeParamFilter, llmInvokeResultFilter, resetTraceFullModeCache } from "./trace-filters";

/** 体积阈值：单 span attributes 必须 < 4KB */
const MAX_ATTR_BYTES = 4096;

function bigMessages(rounds = 60, charsPerMsg = 4000) {
  const msgs: any[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(charsPerMsg) });
    msgs.push({ role: "assistant", parts: [{ type: "tool-result", output: "y".repeat(charsPerMsg) }] });
  }
  return msgs;
}

/**
 * 装一个「storage 指向临时 DB」的 tracer provider。
 *
 * 装饰器内部走 `getTracerProvider()` → tracer → storage.save()，
 * 所以必须把 provider 的 storage 换成临时库，否则会写到真实 traces.db！
 */
async function installTempProvider(dbPath: string) {
  resetTracerProvider();
  const storage = new SQLiteSpanStorage(dbPath);
  await storage.initialize();
  const provider = new OTelTracerProvider(storage);
  await provider.initialize();
  setTracerProvider(provider);
  return provider;
}

describe("trace 瘦身 · 端到端（真实落库体积）", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
    dir = mkdtempSync(join(tmpdir(), "trace-slim-test-"));
    dbPath = join(dir, "traces.db");
  });

  afterEach(() => {
    resetTracerProvider();
    resetTraceFullModeCache();
    delete process.env.ROY_TRACE_FULL;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("装饰器真实链路：llm.component.invoke 落库 attributes < 4KB（改造前 ~473KB）", async () => {
    await installTempProvider(dbPath);

    const messages = bigMessages();
    const rawBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");

    // ⚠️ 真的包一个函数并调用它 —— 走完整装饰器链路
    const fn = wrapFunction(
      async (req: any) => ({
        output: { text: "z".repeat(200_000), parts: [{ type: "text" }] },
        providerId: "minimax-cn",
        model: "MiniMax-M3",
        latencyMs: 1234,
        usage: { promptTokens: 10, completionTokens: 20 },
      }),
      "llm.component.invoke",
      {
        paramFilter: llmInvokeParamFilter,
        resultFilter: llmInvokeResultFilter,
        recordResult: false,
      },
    );

    await fn({ messages, model: "MiniMax-M3", provider: "minimax-cn", tools: [{ name: "bash" }] });
    await new Promise((r) => setTimeout(r, 400));

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT attributes, result FROM span WHERE name = ? LIMIT 1").get("llm.component.invoke");
    db.close();

    expect(row).toBeTruthy();
    const attrBytes = Buffer.byteLength(row.attributes ?? "", "utf8");
    const resultBytes = Buffer.byteLength(row.result ?? "", "utf8");

    // 原始 messages 确实很大（> 400KB）
    expect(rawBytes).toBeGreaterThan(400_000);
    // 落库体积必须很小
    expect(attrBytes).toBeLessThan(MAX_ATTR_BYTES);
    expect(resultBytes).toBeLessThan(MAX_ATTR_BYTES);

    // 关键字段还在（防止"为了小而丢光"）
    const attrs = JSON.parse(row.attributes ?? "{}");
    expect(attrs.params.model).toBe("MiniMax-M3");
    expect(attrs.params.messageCount).toBe(messages.length);
    expect(attrs.params.totalChars).toBeGreaterThan(0);
    expect(attrs.params.tools).toBe(1);
  });

  test("装饰器真实链路：recordResult:false 现在真的不入库（改造前 DB 里始终有全量 result）", async () => {
    await installTempProvider(dbPath);

    const fn = wrapFunction(
      async () => ({ huge: "q".repeat(300_000), secret: "should-not-be-in-db" }),
      "no.result.span",
      { recordResult: false }, // 无 resultFilter → 新语义：完全不存 result
    );

    await fn();
    await new Promise((r) => setTimeout(r, 400));

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT attributes, result FROM span WHERE name = ? LIMIT 1").get("no.result.span");
    db.close();

    expect(row).toBeTruthy();
    expect(row.result === null || row.result === "").toBe(true);
    // 也不该出现在 attributes 里
    expect(row.attributes ?? "").not.toContain("should-not-be-in-db");
  });

  test("装饰器真实链路：recordResultToDb:true 逃逸阀 —— 显式要求仍存完整 result", async () => {
    await installTempProvider(dbPath);

    const fn = wrapFunction(
      async () => ({ kept: "keep-me" }),
      "escape.hatch.span",
      { recordResult: false, recordResultToDb: true },
    );

    await fn();
    await new Promise((r) => setTimeout(r, 400));

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT attributes, result FROM span WHERE name = ? LIMIT 1").get("escape.hatch.span");
    db.close();

    expect(row).toBeTruthy();
    expect(row.result ?? "").toContain("keep-me");
  });

  test("装饰器真实链路：ROY_TRACE_FULL=1 时回到全量（不改代码即可恢复）", async () => {
    process.env.ROY_TRACE_FULL = "1";
    resetTraceFullModeCache();
    await installTempProvider(dbPath);

    const messages = bigMessages();
    const fn = wrapFunction(
      async () => ({ output: { text: "z".repeat(200_000) } }),
      "full.mode.span",
      {
        paramFilter: llmInvokeParamFilter,
        resultFilter: llmInvokeResultFilter,
        recordResult: false,
      },
    );

    await fn({ messages, model: "MiniMax-M3" });
    await new Promise((r) => setTimeout(r, 400));

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT attributes FROM span WHERE name = ? LIMIT 1").get("full.mode.span");
    db.close();

    const attrBytes = Buffer.byteLength(row?.attributes ?? "", "utf8");
    // 全量模式：体积回到改造前量级（> 100KB）
    expect(attrBytes).toBeGreaterThan(100_000);
  });
});

// ============================================================================
// Task #5341 — 端到端：真实落库的 llm.component.invoke span 里能看到 toolNames
//
// 用户诉求：**从 trace 就能看到 LLM 调用时到底传了哪些工具**（例：渠道专用
// 的 wecom_respond 是否真的进了请求体），不能只停在「工具数量 = 11」。
// 这里走的是完整装饰器链路（wrapFunction → OTel span → SQLite），
// 断言 DB 里那一行 attributes.params.toolNames。
// ============================================================================
/**
 * 轮询等待 span 落库（review MINOR-4：不用固定 sleep，避免 CI 高负载下偶发 flaky）。
 * 用短间隔 + 上限重试，拿不到就返回 null 让断言自然失败。
 */
async function waitForSpan(dbPath: string, name: string, timeoutMs = 5_000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let db: Database | undefined;
    try {
      // 打开动作也放进 try：库文件/表尚未建好时 `new Database` 自己会抛
      db = new Database(dbPath, { readonly: true });
      // ORDER BY start_time DESC：将来同名 span 变多条（重试/嵌套）时取最新那条
      const row = db
        .query("SELECT attributes FROM span WHERE name = ? ORDER BY start_time DESC LIMIT 1")
        .get(name);
      if (row) return row;
    } catch {
      // 表尚未建好（storage 还在初始化）——继续重试
    } finally {
      db?.close();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("trace 瘦身 · Task #5341 toolNames 真实落库", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
    dir = mkdtempSync(join(tmpdir(), "trace-toolnames-"));
    dbPath = join(dir, "traces.db");
  });

  afterEach(() => {
    resetTracerProvider();
    resetTraceFullModeCache();
    delete process.env.ROY_TRACE_FULL;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("企微轮（带 extendTools）落库 attributes.params.toolNames 含 wecom_respond", async () => {
    await installTempProvider(dbPath);

    const tools = [
      { name: "bash" },
      { name: "grep" },
      { name: "wecom_respond" }, // channelOnly 工具：只有企微 ES 轮才注入
    ];
    const fn = wrapFunction(
      async () => ({ output: { content: "ok", finishReason: "stop" } }),
      "llm.component.invoke",
      { paramFilter: llmInvokeParamFilter, resultFilter: llmInvokeResultFilter, recordResult: false },
    );

    await fn({
      messages: [{ role: "user", content: "hi" }],
      model: "fake",
      tools,
      context: { sessionId: "s-wecom" },
    });
    const row = await waitForSpan(dbPath, "llm.component.invoke");

    expect(row).toBeTruthy();
    const attrs = JSON.parse(row!.attributes ?? "{}");
    expect(attrs.params.tools).toBe(3);
    expect(attrs.params.toolNames).toEqual(["bash", "grep", "wecom_respond"]);
    expect(attrs.params.toolNamesTruncated).toBeUndefined(); // 未触发封顶
    // 体积仍然受控
    expect(Buffer.byteLength(row!.attributes ?? "", "utf8")).toBeLessThan(MAX_ATTR_BYTES);
  });

  test("非企微轮（无 extendTools）落库 toolNames 不含 wecom_respond —— 对照可判定", async () => {
    await installTempProvider(dbPath);

    const fn = wrapFunction(
      async () => ({ output: { content: "ok", finishReason: "stop" } }),
      "llm.component.invoke",
      { paramFilter: llmInvokeParamFilter, resultFilter: llmInvokeResultFilter, recordResult: false },
    );

    await fn({
      messages: [{ role: "user", content: "hi" }],
      model: "fake",
      tools: [{ name: "bash" }, { name: "grep" }],
      context: { sessionId: "s-plain" },
    });
    const row = await waitForSpan(dbPath, "llm.component.invoke");

    // 断言对称（review MINOR-3）：先确认 span 真的落库了，再看内容
    expect(row).toBeTruthy();
    const attrs = JSON.parse(row!.attributes ?? "{}");
    expect(attrs.params.tools).toBe(2);
    expect(attrs.params.toolNames).toEqual(["bash", "grep"]);
    expect(attrs.params.toolNames).not.toContain("wecom_respond");
  });
});
