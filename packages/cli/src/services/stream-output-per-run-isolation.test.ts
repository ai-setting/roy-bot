/**
 * @fileoverview 共享资源隔离测试 (Task #4486 Phase 3)
 *
 * 核心语义（TDD）：
 * 1. **per-run abort**：`resetStreamAbort(scope)` / `abortStream(scope)` 不再
 *    全局互踩 —— 单 run 结束只清自己，A run 的 abort 不影响 B run。
 *    无 scope 时保持旧全局语义（backward compat）。
 * 2. **StreamOutputService sessionId 过滤**：一个 stream service 可以只关心
 *    自己 session 的事件，别 session 的 llm.* / tool.* 事件被跳过。
 * 3. **事件驱动 turn 的 silent 渲染能力**：StreamOutputService 的 silent 模式
 *    下不写 stdout（仅 chunk callback），供"完成时整段提交"使用。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import {
  StreamOutputService,
  resetStreamAbort,
  abortStream,
  isStreamAborted,
  __resetAllStreamAbortForTest,
  streamAbortSignal,
  type StreamChunkEvent,
} from "../services/stream-output.service";

// ============================================================================
// 1. per-run abort scope
// ============================================================================

describe("Task #4486 Phase 3: per-run abort scope", () => {
  beforeEach(() => {
    __resetAllStreamAbortForTest();
  });

  test("无 scope 时保持旧全局语义（backward compat）", () => {
    expect(streamAbortSignal.aborted).toBe(false);
    abortStream();
    expect(streamAbortSignal.aborted).toBe(true);
    resetStreamAbort();
    expect(streamAbortSignal.aborted).toBe(false);
  });

  test("abortStream(scopeA) 只置位 A，不污染 B / 全局", () => {
    abortStream("run_A");

    expect(isStreamAborted("run_A")).toBe(true);
    expect(isStreamAborted("run_B")).toBe(false);
    // 全局标记不被 scope abort 影响（老代码读 streamAbortSignal 仍安全）
    expect(streamAbortSignal.aborted).toBe(false);
  });

  test("resetStreamAbort(scopeA) 只清 A，B 仍 aborted", () => {
    abortStream("run_A");
    abortStream("run_B");

    resetStreamAbort("run_A");

    expect(isStreamAborted("run_A")).toBe(false);
    expect(isStreamAborted("run_B")).toBe(true);
  });

  test("无 scope 的 resetStreamAbort() 清空所有 scope（abortAll 语义）", () => {
    abortStream("run_A");
    abortStream("run_B");

    resetStreamAbort();

    // ★ 收尾 review 修复：无 scope 版本语义收窄为"只清全局 abortAll 标记"。
    //   原因：executeInternal 每轮都会调无 scope 版本；若连 abortedRuns 一起清空，
    //   并发时 session B 开新一轮就会抹掉 session A 的 abort 标记。
    //   要全清（测试 / shutdown）请用 __resetAllStreamAbortForTest()。
    expect(isStreamAborted("run_A")).toBe(true);
    expect(isStreamAborted("run_B")).toBe(true);
    expect(streamAbortSignal.aborted).toBe(false);

    __resetAllStreamAbortForTest();
    expect(isStreamAborted("run_A")).toBe(false);
    expect(isStreamAborted("run_B")).toBe(false);
  });

  test("abortStream() 无 scope = abortAll（ESC 语义），全局标记置位", () => {
    abortStream("run_A");
    abortStream("run_B");

    expect(isStreamAborted("run_A")).toBe(true);
    expect(isStreamAborted("run_B")).toBe(true);
    expect(streamAbortSignal.aborted).toBe(false); // scope abort 不影响全局

    // 无 scope = ESC 的 abortAll → 置全局标记
    abortStream();
    expect(streamAbortSignal.aborted).toBe(true);
  });

  test("isStreamAborted 未登记 scope 返回 false（不会因全局 aborted 误判）", () => {
    abortStream("run_A");
    expect(isStreamAborted("run_C")).toBe(false);
  });
});

// ============================================================================
// 2. StreamOutputService sessionId 过滤
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

function makeLLMStartEvent(sessionId?: string) {
  return {
    type: "llm.start",
    payload: {
      metadata: { model: "test-model", ...(sessionId ? { sessionId } : {}) },
    },
    metadata: sessionId ? { sessionId } : {},
  } as any;
}

describe("Task #4486 Phase 3: StreamOutputService sessionId filter", () => {
  let chunks: StreamChunkEvent[];

  beforeEach(() => {
    resetStreamAbort();
    chunks = [];
  });

  test("未设置 sessionId 过滤时接受所有事件（向后兼容）", () => {
    const svc = new StreamOutputService({ silent: true });
    svc.setChunkCallback((e) => chunks.push(e));

    svc.handleEvent(makeLLMStartEvent("sess_A"));
    svc.handleEvent(makeLLMTextEvent("hello", "sess_A"));
    svc.handleEvent(makeLLMTextEvent("world", "sess_B"));

    expect(chunks.filter((c) => c.type === "llm.text").length).toBe(2);
  });

  test("设置 sessionId 过滤后只接受本 session 事件", () => {
    const svc = new StreamOutputService({ silent: true });
    svc.setSessionFilter("sess_A");
    svc.setChunkCallback((e) => chunks.push(e));

    svc.handleEvent(makeLLMStartEvent("sess_A"));
    svc.handleEvent(makeLLMTextEvent("mine", "sess_A"));
    svc.handleEvent(makeLLMStartEvent("sess_B"));
    svc.handleEvent(makeLLMTextEvent("other", "sess_B"));

    const texts = chunks.filter((c) => c.type === "llm.text").map((c) => c.delta);
    expect(texts).toEqual(["mine"]);
  });

  // ★ Task #4515 (M2): 语义修正 —— 原断言「无 sessionId 的事件在过滤模式下被跳过」
  //   描述的是缺陷本身（filter 误吞无法归属的事件）。真实语义是：只有"带了
  //   sessionId 且不匹配"才丢弃；无 sessionId 的事件无法归属，照常处理
  //   （llm.* 的 sessionId 来自 InvokeOptions.context.sessionId，并非所有调用点
  //   都传；tool.* / context.* 同理）。详见 stream-output-filter-no-session.test.ts。
  test("无 sessionId 的事件在过滤模式下仍被处理（无法归属 ≠ 属于别人）", () => {
    const svc = new StreamOutputService({ silent: true });
    svc.setSessionFilter("sess_A");
    svc.setChunkCallback((e) => chunks.push(e));

    svc.handleEvent(makeLLMTextEvent("no-session"));

    expect(chunks.filter((c) => c.type === "llm.text").length).toBe(1);
  });

  test("带 sessionId 且不匹配的事件仍然被跳过（并发隔离不削弱）", () => {
    const svc = new StreamOutputService({ silent: true });
    svc.setSessionFilter("sess_A");
    svc.setChunkCallback((e) => chunks.push(e));

    svc.handleEvent(makeLLMTextEvent("other-session", "sess_B"));

    expect(chunks.filter((c) => c.type === "llm.text").length).toBe(0);
  });

  test("setSessionFilter(undefined) 解除过滤", () => {
    const svc = new StreamOutputService({ silent: true });
    svc.setChunkCallback((e) => chunks.push(e));
    svc.setSessionFilter("sess_A");
    svc.handleEvent(makeLLMTextEvent("blocked", "sess_B"));

    svc.setSessionFilter(undefined);
    svc.handleEvent(makeLLMTextEvent("allowed", "sess_B"));

    const texts = chunks.filter((c) => c.type === "llm.text").map((c) => c.delta);
    expect(texts).toEqual(["allowed"]);
  });

  test("过滤命中时 sessionId 从 event.metadata 或 payload.metadata 都能取到", () => {
    const svc = new StreamOutputService({ silent: true });
    svc.setSessionFilter("sess_A");
    svc.setChunkCallback((e) => chunks.push(e));

    // metadata 顶层
    svc.handleEvent({
      type: "llm.text",
      payload: { delta: "via-metadata" },
      metadata: { sessionId: "sess_A" },
    } as any);
    // payload.metadata
    svc.handleEvent(makeLLMTextEvent("via-payload", "sess_A"));

    const texts = chunks.filter((c) => c.type === "llm.text").map((c) => c.delta);
    expect(texts).toEqual(["via-metadata", "via-payload"]);
  });
});

// ============================================================================
// 3. per-run abort 与 StreamOutputService 联动
// ============================================================================

describe("Task #4486 Phase 3: StreamOutputService per-run abort", () => {
  beforeEach(() => {
    __resetAllStreamAbortForTest();
  });

  test("service 绑定 runId 后，只受自己 run 的 abort 影响", () => {
    const chunks: StreamChunkEvent[] = [];
    const svcA = new StreamOutputService({ silent: true });
    svcA.setRunId("run_A");
    svcA.setChunkCallback((e) => chunks.push(e));

    const svcB = new StreamOutputService({ silent: true });
    svcB.setRunId("run_B");
    const chunksB: StreamChunkEvent[] = [];
    svcB.setChunkCallback((e) => chunksB.push(e));

    // abort B 不应该打断 A
    abortStream("run_B");

    svcA.handleEvent(makeLLMTextEvent("a-text", "sess_A"));
    svcB.handleEvent(makeLLMTextEvent("b-text", "sess_B"));

    expect(chunks.filter((c) => c.type === "llm.text").map((c) => c.delta)).toEqual([
      "a-text",
    ]);
    // B 已 abort → 不再产出 chunk
    expect(chunksB.filter((c) => c.type === "llm.text").length).toBe(0);
  });

  test("未绑定 runId 的 service 回落到全局 abort 语义（向后兼容）", () => {
    const chunks: StreamChunkEvent[] = [];
    const svc = new StreamOutputService({ silent: true });
    svc.setChunkCallback((e) => chunks.push(e));

    abortStream(); // 全局 abort
    svc.handleEvent(makeLLMTextEvent("x", "sess_A"));

    expect(chunks.filter((c) => c.type === "llm.text").length).toBe(0);
  });
});

// ============================================================================
// 4. ESC / abortAll 必须能穿透 runId 作用域（Task #4486 收尾 review 修复）
// ============================================================================

describe("Task #4486 fix: ESC abortAll must reach runId-bound streams", () => {
  beforeEach(() => {
    __resetAllStreamAbortForTest();
  });

  /**
   * 回归：ESC 走 `abortStream()`（无 scope，旧契约 = 中断全部）。
   * 分支给事件驱动 turn 绑了 runId，若 `checkAbort()` 只看 run 标记、
   * `isStreamAborted()` 又不回落全局信号，ESC 就对这些流**完全失效**
   * （相对 main 是功能回归：main 没有 runId，所有流都读全局 flag）。
   */
  test("abortStream() 后，绑定了 runId 的流也必须停止产出", () => {
    const chunks: StreamChunkEvent[] = [];
    const svc = new StreamOutputService({ silent: true });
    svc.setChunkCallback((e) => chunks.push(e));
    svc.setSessionFilter("sess_A");
    svc.setRunId("sess_A"); // 事件驱动 turn 的实际形态

    abortStream(); // ESC / /abort —— 无 scope
    svc.handleEvent(makeLLMTextEvent("after-esc", "sess_A"));

    expect(chunks.filter((c) => c.type === "llm.text").length).toBe(0);
  });


  /**
   * 回归：ESC 之后**下一轮 turn** 会调无 scope 的 `resetStreamAbort()`
   * （`executeInternal` 每轮都调）。若 ESC 只打了全局标记，这个 reset 会把
   * 中断状态清掉 → 被中断的流"复活"继续渲染。
   * 所以 ESC 还必须给每个正在执行的 session 单独打标记（interactive.ts）。
   */
  test("ESC 打上 per-session 标记后，下一轮 turn 的 resetStreamAbort() 不会让流复活", () => {
    const chunks: StreamChunkEvent[] = [];
    const svc = new StreamOutputService({ silent: true });
    svc.setChunkCallback((e) => chunks.push(e));
    svc.setSessionFilter("sess_A");
    svc.setRunId("sess_A");

    // ESC：全局 + 每个正在执行的 session 各打一个标记（模拟 interactive.ts 修复后行为）
    abortStream();
    abortStream("sess_A");

    // 下一轮 turn 开头
    resetStreamAbort();

    svc.handleEvent(makeLLMTextEvent("resumed?", "sess_A"));
    expect(chunks.filter((c) => c.type === "llm.text").length).toBe(0);
  });

  /**
   * 反向保护：per-run 隔离不能被上面修复破坏 ——
   * 绑了 runId 的流，**别的** run 被 abort 时仍要正常工作。
   */
  test("别的 run 被 abort 时，本 run 仍正常产出（隔离不受影响）", () => {
    const chunks: StreamChunkEvent[] = [];
    const svc = new StreamOutputService({ silent: true });
    svc.setChunkCallback((e) => chunks.push(e));
    svc.setSessionFilter("sess_A");
    svc.setRunId("sess_A");

    abortStream("sess_B"); // 别的 run
    svc.handleEvent(makeLLMTextEvent("still-works", "sess_A"));

    expect(chunks.filter((c) => c.type === "llm.text").map((c) => c.delta)).toEqual([
      "still-works",
    ]);
  });
});

// ============================================================================
// 5. 一个 session 开新一轮不能清掉别的 session 的 abort 标记
// ============================================================================

describe("Task #4486 fix: per-turn global reset must not wipe peer run marks", () => {
  beforeEach(() => {
    __resetAllStreamAbortForTest();
  });

  /**
   * 回归：`executeInternal` 每轮开头都调 `resetStreamAbort()`（无 scope）。
   * 旧实现会把 `abortedRuns` 整个清空 → 并发时 session B 一开新一轮，
   * 就把 session A 的 per-run abort 标记抹掉。
   */
  test("无 scope 的 resetStreamAbort() 只清全局标记，不清别人 run 的标记", () => {
    abortStream("sess_A"); // A 刚被要求中断
    expect(isStreamAborted("sess_A")).toBe(true);

    resetStreamAbort(); // B 开新一轮

    // A 自己的标记必须还在
    expect(isStreamAborted("sess_A")).toBe(true);
    // 全局标记被清（新一轮不再继承上一次 ESC）
    expect(streamAbortSignal.aborted).toBe(false);
  });

  /**
   * 但 ESC 之后又开新一轮：全局 veto 被清，A 的 run 标记仍在 → A 仍中断。
   * 说明两者互不干扰地各自生效。
   */
  test("全局标记清除后，run 自己的标记仍独立生效", () => {
    abortStream(); // ESC（全局）
    abortStream("sess_A"); // 同时标记 A
    resetStreamAbort(); // 新一轮清全局
    expect(streamAbortSignal.aborted).toBe(false);
    expect(isStreamAborted("sess_A")).toBe(true);
    expect(isStreamAborted("sess_B")).toBe(false);
  });
});
