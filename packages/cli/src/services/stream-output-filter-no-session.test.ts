/**
 * @fileoverview StreamOutputService session filter 语义修正测试 (Task #4515 / M2)
 *
 * 问题（#4514 复审 M2）：
 *   `handleEvent` 的 session 过滤是「不匹配就丢」：
 *
 *     if (this.sessionFilter !== undefined) {
 *       if (this.extractEventSessionId(event) !== this.sessionFilter) return;
 *     }
 *
 *   于是**没有 sessionId 的事件**（`extractEventSessionId` 返回 undefined）也被丢掉，
 *   而设计文档承诺的语义是「仅当事件带 sessionId 且不匹配才丢」。
 *
 * 为什么必须修：
 *   - `llm.*` 事件由 `llm/invoke.ts:createEnvEventEmitter` 发布，sessionId 来自
 *     `InvokeOptions.context.sessionId`；某些调用点没有传 → 事件无 sessionId。
 *   - `tool.*` / `context.*` 事件也并非全都有 sessionId。
 *   - 一旦 M4/H3 修复后主 executor 也绑上 sessionFilter，这些「无 sessionId」
 *     的合法事件会被静默吞掉 → 用户看不到 tool 调用 / 上下文压缩提示。
 *
 * 目标语义（本测试锁定）：
 *   - 有 sessionId 且 === filter  → 处理
 *   - 有 sessionId 且 !== filter  → 丢弃（并发隔离的核心）
 *   - **无 sessionId**            → 处理（无法归属，不能以"可能是别人的"为由丢弃）
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  StreamOutputService,
  __resetAllStreamAbortForTest,
  type StreamChunkEvent,
} from "../services/stream-output.service";

// ============================================================================
// Helpers
// ============================================================================

function makeLLMTextEvent(delta: string, sessionId?: string) {
  return {
    type: "llm.text",
    payload: {
      delta,
      ...(sessionId ? { metadata: { sessionId } } : {}),
    },
    metadata: sessionId ? { sessionId } : {},
  } as any;
}

/** 无 sessionId 但嵌套在 payload.metadata 之外的形态（真实 tool.* 事件） */
function makeToolCallEvent(toolName: string, sessionId?: string) {
  return {
    type: "tool.call",
    payload: {
      id: `call_${toolName}`,
      name: toolName,
      input: {},
      ...(sessionId ? { metadata: { sessionId } } : {}),
    },
    metadata: sessionId ? { sessionId } : {},
  } as any;
}

function collect(): { svc: StreamOutputService; chunks: StreamChunkEvent[] } {
  const chunks: StreamChunkEvent[] = [];
  // showToolCalls: true —— 否则 handleToolCall 会提前 return（与 session filter 无关），
  // 测不到过滤语义。
  const svc = new StreamOutputService({ silent: true, showToolCalls: true });
  svc.setChunkCallback((e) => chunks.push(e));
  return { svc, chunks };
}

function textDeltas(chunks: StreamChunkEvent[]): string[] {
  return chunks.filter((c) => c.type === "llm.text").map((c) => (c as any).delta);
}

// ============================================================================
// M2: 无 sessionId 的事件不应被 filter 丢弃
// ============================================================================

describe("Task #4515 (M2): session filter 不应吞掉无 sessionId 的事件", () => {
  beforeEach(() => {
    __resetAllStreamAbortForTest();
  });

  test("开了 filter 后，无 sessionId 的 llm.text 仍被处理", () => {
    const { svc, chunks } = collect();
    svc.setSessionFilter("sess_A");

    svc.handleEvent(makeLLMTextEvent("no-session-event"));

    expect(textDeltas(chunks)).toEqual(["no-session-event"]);
  });

  test("开了 filter 后，无 sessionId 的 tool.call 仍被处理", () => {
    const { svc, chunks } = collect();
    svc.setSessionFilter("sess_A");

    svc.handleEvent(makeToolCallEvent("bash"));

    const toolCalls = chunks.filter((c) => c.type === "tool.call");
    expect(toolCalls.length).toBe(1);
  });

  test("有 sessionId 且不匹配的事件仍然被丢弃（并发隔离不能被削弱）", () => {
    const { svc, chunks } = collect();
    svc.setSessionFilter("sess_A");

    svc.handleEvent(makeLLMTextEvent("from-B", "sess_B"));
    svc.handleEvent(makeToolCallEvent("bash", "sess_B"));

    expect(textDeltas(chunks)).toEqual([]);
    expect(chunks.filter((c) => c.type === "tool.call").length).toBe(0);
  });

  test("混合流：本 session + 无 sessionId + 别 session → 只丢别 session 的", () => {
    const { svc, chunks } = collect();
    svc.setSessionFilter("sess_A");

    svc.handleEvent(makeLLMTextEvent("mine", "sess_A"));
    svc.handleEvent(makeLLMTextEvent("orphan"));
    svc.handleEvent(makeLLMTextEvent("theirs", "sess_B"));

    expect(textDeltas(chunks)).toEqual(["mine", "orphan"]);
  });

  test("payload.metadata.sessionId 不匹配时也丢弃（两条取 sessionId 的路径一致）", () => {
    const { svc, chunks } = collect();
    svc.setSessionFilter("sess_A");

    // 只挂在 payload.metadata 上（顶层 metadata 没有）
    svc.handleEvent({
      type: "llm.text",
      payload: { delta: "via-payload-B", metadata: { sessionId: "sess_B" } },
    } as any);

    expect(textDeltas(chunks)).toEqual([]);
  });

  test("未设置 filter 时一切照旧（无 sessionId 事件照常处理）", () => {
    const { svc, chunks } = collect();

    svc.handleEvent(makeLLMTextEvent("orphan-1"));
    svc.handleEvent(makeLLMTextEvent("with-A", "sess_A"));

    expect(textDeltas(chunks)).toEqual(["orphan-1", "with-A"]);
  });
});

// ============================================================================
// M2 × H3: 无 sessionId 的事件必须只有一个"主人"（不能扇出给所有 executor）
// ============================================================================

describe("Task #4515 (M2 × H3): 无 sessionId 事件只能被一个 executor 渲染", () => {
  beforeEach(() => {
    __resetAllStreamAbortForTest();
  });

  test("主 executor 收无 sessionId 事件；per-session executor 不收（避免重复）", () => {
    // 复现交叉验证报告的场景：主 executor（REPL 自己 session）+ 两个
    // per-session executor 同时订阅。一个**无 sessionId** 的 llm.text。
    //
    //  修复前（M2 单独修完）：三个 executor 全都通过 filter → 渲染 3 份 ❌
    //  目标：只有"主"那一个接收 → 恰好 1 份 ✅
    const main = collect();
    main.svc.setSessionFilter("repl-session");
    // 主 executor：默认可作为"无归属事件的兜底主人"
    main.svc.setAcceptsSidelessEvents(true);

    const a = collect();
    a.svc.setSessionFilter("sess_A");
    a.svc.setAcceptsSidelessEvents(false); // per-session executor 不是主人

    const b = collect();
    b.svc.setSessionFilter("sess_B");
    b.svc.setAcceptsSidelessEvents(false);

    main.svc.handleEvent(makeLLMTextEvent("orphan"));
    a.svc.handleEvent(makeLLMTextEvent("orphan"));
    b.svc.handleEvent(makeLLMTextEvent("orphan"));

    const total =
      textDeltas(main.chunks).length + textDeltas(a.chunks).length + textDeltas(b.chunks).length;

    expect(total).toBe(1);
    expect(textDeltas(main.chunks)).toEqual(["orphan"]);
    expect(textDeltas(a.chunks)).toEqual([]);
    expect(textDeltas(b.chunks)).toEqual([]);
  });

  test("per-session executor 自己 session 的事件照常渲染（不受 sideless 策略影响）", () => {
    const a = collect();
    a.svc.setSessionFilter("sess_A");
    a.svc.setAcceptsSidelessEvents(false);

    a.svc.handleEvent(makeLLMTextEvent("mine", "sess_A"));
    a.svc.handleEvent(makeLLMTextEvent("other", "sess_B"));
    a.svc.handleEvent(makeLLMTextEvent("orphan"));

    expect(textDeltas(a.chunks)).toEqual(["mine"]);
  });

  test("默认（未设置策略）仍接收无 sessionId 事件（向后兼容）", () => {
    const svc = new StreamOutputService({ silent: true });
    const chunks: StreamChunkEvent[] = [];
    svc.setChunkCallback((e) => chunks.push(e));
    svc.setSessionFilter("sess_A");

    svc.handleEvent(makeLLMTextEvent("orphan"));

    expect(textDeltas(chunks)).toEqual(["orphan"]);
  });
});
