/**
 * @fileoverview Task #4519 — ES → REPL 跨层 trace 隔离（V3 修复）
 *
 * ## 为什么需要这个测试（关键）
 *
 * #4518 的 E2E 实测发现：一次 `dispatchLines` 推 ≥2 条事件时，多个 run 的
 * span **全部共用一个 traceId**，且有 orphan span。这是真实缺陷，但**现有单测
 * 全绿**——因为它们都停在 tracer 层（`tracer-provider-*.test.ts`）或 REPL 层
 * （`interactive-trace-isolation.test.ts`），**没有一条测试覆盖
 * `ES handleEvent → 全局 context → interactive.executeInternal` 这条残留路径**。
 *
 * 本文件就是补那条跨层测试：直接驱动真实的 `LarkCliInstance`（含真实
 * `@TracedAs` 装饰器、真实 `dispatchLines`、真实 EnvContext 投递），
 * 再从下游消费 `evt.metadata.traceContext`，断言 traceId 隔离。
 *
 * ## 锁定的不变量
 *
 * 1. 一次 `dispatchLines` 推 2 条事件 → 产出 **2 个 distinct traceId**
 * 2. 每条事件的 `traceContext` 是它**自己**的根 span（不串）
 * 3. 根 span 的 `parentSpanId` 必须是 `undefined`（否则指向伪造的、
 *    从未落库的 spanId → orphan）
 * 4. 串行对照：即使事件**依次**到达（物理无并发），也必须 isolation
 *    （证明是状态残留而非竞争）
 * 5. `dispatchLines` 结束后不留进程级残留（否则污染下一条事件 / 下一轮 run）
 * 6. 无 chatId / 无 event_id 的事件也各自独立（兜底路径不退化）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  OTelTracerProvider,
  setTracerProvider,
  resetTracerProvider,
} from "../log-trace/opentelemetry/tracer-provider";
import { SQLiteSpanStorage } from "../log-trace/span-storage";

import { LarkCliInstance } from "./event-source-handlers";
import type { EventSourceConfig, EventSourceEventHandler, EventSourceEvent } from "./types";

// ============================================================================
// Harness
// ============================================================================

let tmpDir: string;
let provider: OTelTracerProvider;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trace4519-"));
  const dbPath = join(tmpDir, "traces.db");
  provider = new OTelTracerProvider(new SQLiteSpanStorage(dbPath), dbPath);
  setTracerProvider(provider);
  // 干净起点
  provider.setGlobalContext(undefined);
  provider.getTracer("roy-tracer").setCurrentContext(undefined);
});

afterEach(() => {
  resetTracerProvider();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** 简化的飞书事件（生产 lark-cli 也支持这种顶层扁平格式） */
function makeRawEvent(opts: { eventId: string; chatId?: string; text?: string }): string {
  return JSON.stringify({
    type: "im.message.receive_v1",
    event_id: opts.eventId,
    timestamp: "1790579077976",
    id: `om_${opts.eventId}`,
    message_id: `om_${opts.eventId}`,
    chat_id: opts.chatId ?? `oc_${opts.eventId}`,
    chat_type: "p2p",
    message_type: "text",
    sender_id: { open_id: "ou_user_X" },
    sender_type: "user",
    content: opts.text ?? `msg-${opts.eventId}`,
  });
}

function makeInstance(): { instance: LarkCliInstance; captured: EventSourceEvent[] } {
  const config: EventSourceConfig = {
    id: "es-4519",
    name: "trace isolation test",
    type: "lark-cli",
    enabled: true,
    command: "lark-cli --profile test event consume im.message.receive_v1 --as bot",
    profile: "test",
  };
  const instance = new LarkCliInstance(config);
  const captured: EventSourceEvent[] = [];
  const handler: EventSourceEventHandler = (evt) => {
    captured.push(evt as EventSourceEvent);
  };
  instance.onEvent(handler);
  return { instance, captured };
}

/** 直接驱动 dispatchLines（= 生产 processStreamWith 在单 chunk 内的同步分发点） */
async function dispatch(instance: LarkCliInstance, lines: string[]): Promise<void> {
  await (instance as unknown as { dispatchLines: (l: string[]) => void }).dispatchLines(lines);
}

/** 等待所有在途 async 事件处理落定（fire-and-forget → 需要显式 flush） */
async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** 从 evt.metadata 取 trace context（新契约：context 走载荷，不走进程级单槽） */
function traceCtxOf(evt: EventSourceEvent): { traceId: string; spanId: string; parentSpanId?: string } | undefined {
  return (evt.metadata as unknown as { traceContext?: any })?.traceContext;
}

// ============================================================================
// 1. 核心：一次 dispatchLines 推 2 条事件 → 2 个 distinct traceId
// ============================================================================

describe("Task #4519 (V3): ES 层多事件不得共用 traceId", () => {
  test("一次 dispatchLines 推 2 条事件 → 必须产出 2 个 distinct traceId", async () => {
    const { instance, captured } = makeInstance();

    // 同一 chunk 里 2 条事件（生产 lark-cli 批量推送必然出现）
    await dispatch(instance, [makeRawEvent({ eventId: "ti4519_evt_A" }), makeRawEvent({ eventId: "ti4519_evt_B" })]);
    await flush();

    expect(captured.length).toBe(2);

    const ctxA = traceCtxOf(captured[0]);
    const ctxB = traceCtxOf(captured[1]);

    expect(ctxA).toBeDefined();
    expect(ctxB).toBeDefined();

    // ★ 核心断言：两个事件各自的根 trace 必须不同
    expect(ctxA!.traceId).not.toBe(ctxB!.traceId);
  });

  test("串行对照：事件依次到达（物理无并发）也必须 isolation", async () => {
    const { instance, captured } = makeInstance();

    // 先推 A，等它完全落定，再推 B —— 排除一切并发竞争因素
    await dispatch(instance, [makeRawEvent({ eventId: "ti4519_seq_A" })]);
    await flush();
    await dispatch(instance, [makeRawEvent({ eventId: "ti4519_seq_B" })]);
    await flush();

    expect(captured.length).toBe(2);

    const ctxA = traceCtxOf(captured[0]);
    const ctxB = traceCtxOf(captured[1]);

    // ★ 串行也必须不同 —— 证明缺陷是「状态残留」而非「并发竞争」
    expect(ctxA!.traceId).not.toBe(ctxB!.traceId);
  });

  test("3 条事件 → 3 个 distinct traceId（真实 E2E 场景）", async () => {
    const { instance, captured } = makeInstance();

    await dispatch(instance, [
      makeRawEvent({ eventId: "ti4519_evt_1", chatId: "oc_chat_A" }),
      makeRawEvent({ eventId: "ti4519_evt_2", chatId: "oc_chat_B" }),
      makeRawEvent({ eventId: "ti4519_evt_3", chatId: "oc_chat_C" }),
    ]);
    await flush();

    expect(captured.length).toBe(3);

    const traceIds = captured.map((e) => traceCtxOf(e)?.traceId);
    expect(new Set(traceIds).size).toBe(3);
  });
});

// ============================================================================
// 2. 无 orphan span：根 span 的 parentSpanId 必须是 undefined
// ============================================================================

describe("Task #4519 (V3): 根 span 不得指向伪造的父（orphan 根因）", () => {
  test("每个事件的根 traceContext.parentSpanId 必须是 undefined", async () => {
    const { instance, captured } = makeInstance();

    await dispatch(instance, [makeRawEvent({ eventId: "ti4519_orph_A" }), makeRawEvent({ eventId: "ti4519_orph_B" })]);
    await flush();

    expect(captured.length).toBe(2);

    for (const evt of captured) {
      const ctx = traceCtxOf(evt);
      expect(ctx).toBeDefined();
      // ★ parentSpanId 必须无父，否则它指向一个「从未作为真实 span 落库」的 id
      expect(ctx!.parentSpanId).toBeUndefined();
    }
  });

  test("根 traceContext 的 spanId 必须真实存在于 spans 表（不是伪造的 id）", async () => {
    const { instance, captured } = makeInstance();

    await dispatch(instance, [makeRawEvent({ eventId: "ti4519_real_A" })]);
    await flush();

    expect(captured.length).toBe(1);
    const ctx = traceCtxOf(captured[0])!;

    // 该 spanId 必须真的作为 span 存在（旧实现里它是「伪造后当父」的 id，
    // 从来不会落库 → 子 span 的 parent 指针悬空 = orphan）
    const stored = provider.getStorage().findBySpanId(ctx.spanId);
    expect(stored).toBeDefined();
  });
});

// ============================================================================
// 3. 不留进程级残留
// ============================================================================

describe("Task #4519 (V3): dispatch 结束后不留进程级残留", () => {
  test("dispatchLines 完成后 getGlobalContext() 必须是 undefined", async () => {
    const { instance } = makeInstance();

    await dispatch(instance, [makeRawEvent({ eventId: "ti4519_res_A" }), makeRawEvent({ eventId: "ti4519_res_B" })]);
    await flush();

    // ★ ES 层不得把 context 遗留在进程级单槽（这是串味的直接载体）
    expect(provider.getGlobalContext()).toBeUndefined();
  });

  test("dispatchLines 完成后 tracer currentContext 不得残留上一个事件的 trace", async () => {
    const { instance, captured } = makeInstance();

    await dispatch(instance, [makeRawEvent({ eventId: "ti4519_res_C" })]);
    await flush();

    const ctx = traceCtxOf(captured[0])!;
    const tracer = provider.getTracer("roy-tracer");
    const residue = tracer.getCurrentContext();

    // 允许 undefined（干净）；若残留则**不得**是上一条事件自己的 trace
    // （残留会让下一条事件 / 下一轮 run 误继承 → 串味）
    if (residue) {
      expect(residue.traceId).not.toBe(ctx.traceId);
    }
  });
});

// ============================================================================
// 4. 兜底路径不退化
// ============================================================================

describe("Task #4519 (V3): 兜底路径也各自独立", () => {
  test("无 event_id 的事件（fallback 路径）也各自独立 trace", async () => {
    const { instance, captured } = makeInstance();

    const noId = (text: string) =>
      JSON.stringify({
        type: "im.message.receive_v1",
        chat_id: "oc_fallback",
        message_id: `om_fb_${text}`,
        message_type: "text",
        content: text,
      });

    await dispatch(instance, [noId("one"), noId("two")]);
    await flush();

    expect(captured.length).toBe(2);
    const t1 = traceCtxOf(captured[0])!.traceId;
    const t2 = traceCtxOf(captured[1])!.traceId;
    expect(t1).not.toBe(t2);
  });
});
