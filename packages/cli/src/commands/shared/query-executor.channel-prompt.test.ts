/**
 * @fileoverview Task #5217 — channel prompt（lean 渠道 system prompt）注入链修复
 *
 * ## 背景（Task #5210 排查报告 /tmp/1106-airport/REPORT-feishu-doc-gap.md）
 *
 * lean 渠道 system prompt（buildLarkChannelSystemPrompt，含「文档交付规范」）
 * 由 event-source-handlers.ts 注入 envEvent.metadata.systemPrompt →
 * run-headless-dispatch.ts / run.ts 构造 agentContext.systemPrompt →
 * query-executor.execute() 应搬到 context.metadata.systemPrompt →
 * AgentComponent._run 读 context?.metadata?.systemPrompt 追加到 LLM system message。
 *
 * ## Bug（修复点①）
 *
 * query-executor.ts 的 context 构造顺序：
 *   const context = { sessionId, metadata: {...systemPrompt}, ...restAgentContext };
 * `...restAgentContext` 在 metadata 字面量**之后**展开 —— 而
 * buildInteractiveMergedContext 构造的 agentContext 自带 metadata key
 * （run.ts L2196: metadata: {...}），restAgentContext.metadata 整体覆盖
 * 前面的 metadata 字面量 → systemPrompt 丢失 → _run 读到 undefined。
 *
 * TDD RED：先测 `buildQueryContext`（从 execute() 抽出的纯构造函数），
 * 修复前 metadata.systemPrompt 被覆盖 → fail；修复后存活 → GREEN。
 */

import { describe, test, expect } from "bun:test";

import { buildQueryContext } from "./query-executor";

describe("buildQueryContext — metadata.systemPrompt 不被 restAgentContext 覆盖（Task #5217 修复点①）", () => {
  test("RED: agentContext 自带 metadata 时，systemPrompt 仍进 context.metadata", () => {
    const channelPrompt = "# ⭐ 飞书回复规范（lean）…文档交付规范…";
    const ctx = buildQueryContext(
      "session_x",
      "你好",
      "trace_abc",
      // 模拟 buildInteractiveMergedContext 的产物：自带 metadata key
      {
        agentType: undefined,
        pluginEnabled: {},
        envEvent: { type: "event-source.event.lark-cli" },
        systemPrompt: channelPrompt,
        metadata: { defaultAgentName: "Roy" },
      },
    );

    expect(ctx.sessionId).toBe("session_x");
    expect(ctx.metadata).toBeDefined();
    expect(ctx.metadata.systemPrompt).toBe(channelPrompt);
    // agentContext.metadata 的字段也要保留（merge 而非二选一）
    expect(ctx.metadata.defaultAgentName).toBe("Roy");
    expect(ctx.metadata.originalQuery).toBe("你好");
    expect(ctx.metadata.traceId).toBe("trace_abc");
  });

  test("agentContext 无 metadata 时行为不变（向后兼容）", () => {
    const channelPrompt = "CHANNEL_PROMPT_V2";
    const ctx = buildQueryContext("s", "q", "t", {
      systemPrompt: channelPrompt,
      pluginEnabled: {},
    });
    expect(ctx.metadata.systemPrompt).toBe(channelPrompt);
    expect(ctx.pluginEnabled).toEqual({});
  });

  test("无 systemPrompt 时 metadata.systemPrompt 为 undefined（老 caller 兼容）", () => {
    const ctx = buildQueryContext("s", "q", "t", { pluginEnabled: {} });
    expect(ctx.metadata.systemPrompt).toBeUndefined();
  });

  test("agentContext 为 undefined 时也能构造（兜底）", () => {
    const ctx = buildQueryContext("s", "q", "t", undefined);
    expect(ctx.metadata.systemPrompt).toBeUndefined();
    expect(ctx.metadata.originalQuery).toBe("q");
  });

  test("event-time > preloaded 优先级保留", () => {
    const ctx = buildQueryContext("s", "q", "t", {
      systemPrompt: "EVENT_TIME",
      eventSourceSystemPrompt: "PRELOADED",
    });
    expect(ctx.metadata.systemPrompt).toBe("EVENT_TIME");
  });
});
