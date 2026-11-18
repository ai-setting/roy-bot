/**
 * @fileoverview Trace 瘦身过滤器测试（Task #4479）
 *
 * 验证三件事：
 * 1. **变小了** —— 每个 filter 对「大 messages / 大 tool result / 大 embed 输入」
 *    产出的摘要体积 < 2KB（改造前单个 span 平均 473KB，最大 12.8MB）
 * 2. **没丢光** —— 关键字段还在（model / messageCount / tool 名 等）
 * 3. **能恢复全量** —— `ROY_TRACE_FULL=1` 时回到全量行为
 *
 * 同时验证装饰器的新语义：`recordResult: false` 现在真的不入库
 * （改造前只影响日志，DB 里始终存全量 result —— 这是 traces.db 膨胀的主因）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  isTraceFullMode,
  resetTraceFullModeCache,
  llmInvokeParamFilter,
  llmInvokeResultFilter,
  messagesParamFilter,
  toolExecParamFilter,
  embedParamFilter,
  embedResultFilter,
  envQueryParamFilter,
  toolInvokeParamFilter,
  toolExecResultFilter,
  agentRunParamFilter,
  recordSessionMessagesParamFilter,
} from "./trace-filters";

/** 构造一个"大"的 messages 数组：模拟真实 LLM 调用（system prompt + 多轮对话 + 工具结果） */
function bigMessages(rounds = 60, charsPerMsg = 4000) {
  const msgs: any[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(charsPerMsg) });
    msgs.push({
      role: "assistant",
      parts: [{ type: "tool-result", output: "y".repeat(charsPerMsg) }],
    });
  }
  return msgs;
}

/** 摘要体积（字节） */
function sizeOf(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj), "utf8");
}

describe("trace-filters · 体积瘦身", () => {
  beforeEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
  });
  afterEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
  });

  test("llmInvokeParamFilter：大 messages 入参 → 摘要 < 2KB", () => {
    const messages = bigMessages();
    const rawSize = sizeOf(messages);
    const filtered = llmInvokeParamFilter([
      { messages, model: "MiniMax-M3", provider: "minimax-cn", tools: [{ name: "bash" }], maxTokens: 8192 },
    ]);
    const size = sizeOf(filtered);

    expect(rawSize).toBeGreaterThan(400_000); // 原始确实很大（约 473KB 量级）
    expect(size).toBeLessThan(2_000); // 摘要必须很小
  });

  test("llmInvokeParamFilter：关键字段保留（防止为了小而丢光）", () => {
    const messages = bigMessages(10, 100);
    const filtered = llmInvokeParamFilter([
      { messages, model: "MiniMax-M3", provider: "minimax-cn", tools: [{}, {}, {}] },
    ]);
    expect(filtered.model).toBe("MiniMax-M3");
    expect(filtered.provider).toBe("minimax-cn");
    expect(filtered.messageCount).toBe(messages.length);
    expect(filtered.totalChars).toBeGreaterThan(0);
    expect(filtered.tools).toBe(3);
  });

  test("llmInvokeParamFilter：入参形状变化时防御性访问（不抛异常）", () => {
    expect(() => llmInvokeParamFilter([])).not.toThrow();
    expect(() => llmInvokeParamFilter([null])).not.toThrow();
    expect(() => llmInvokeParamFilter([{}])).not.toThrow();
    expect(llmInvokeParamFilter([{}]).messageCount).toBe(0);
    expect(llmInvokeParamFilter([{ messages: "not-an-array" }]).messageCount).toBe(0);
  });

  test("llmInvokeParamFilter：HookContext 形状（agent.component.* 收到的那种）也能拿到 model/messageCount", () => {
    // ⚠️ 回归防护：`agent.component.invokeLLM` / `agent.component.buildAdditionInfo`
    // 的入参是 HookContext（model 藏在 ctx.context.model），不是 LLM 请求对象。
    // 如果 filter 只认 LLM 请求形状，这里 model 会是 null、messageCount 是 0 ——
    // 恰好丢掉用户最关心的两个字段。
    const messages = bigMessages(10, 100);
    const filtered = llmInvokeParamFilter([
      {
        messages,
        tools: [{ name: "bash" }],
        context: { model: "MiniMax-M3", sessionId: "sess-1" },
      },
    ]);
    expect(filtered.model).toBe("MiniMax-M3");
    expect(filtered.sessionId).toBe("sess-1");
    expect(filtered.messageCount).toBe(messages.length);
    expect(filtered.totalChars).toBeGreaterThan(0);
    expect(filtered.tools).toBe(1);
  });

  test("llmInvokeResultFilter：大响应 → 摘要 < 2KB，关键字段保留", () => {
    // 真实形状：LLMInvokeResult = { output: LLMOutput }，LLMOutput 用 content
    // （没有 text / parts —— 按 text 取会永远拿到 undefined）
    const result = {
      output: {
        content: "z".repeat(200_000),
        reasoning: "r".repeat(1_000),
        finishReason: "stop",
        toolCalls: [{ id: "1" }, { id: "2" }],
        usage: { promptTokens: 100, completionTokens: 50 },
      },
      providerId: "minimax-cn",
      model: "MiniMax-M3",
      latencyMs: 1234,
    };
    const size = sizeOf(llmInvokeResultFilter(result));
    expect(size).toBeLessThan(2_000);

    const filtered = llmInvokeResultFilter(result);
    expect(filtered.providerId).toBe("minimax-cn");
    expect(filtered.model).toBe("MiniMax-M3");
    expect(filtered.latencyMs).toBe(1234);
    expect(filtered.outputChars).toBe(200_000);
    expect(filtered.reasoningChars).toBe(1_000);
    expect(filtered.toolCallCount).toBe(2);
    expect(filtered.finishReason).toBe("stop");
    expect(filtered.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
  });

  test("messagesParamFilter：878KB 场景 → 摘要 < 2KB", () => {
    const messages = bigMessages(100, 3000);
    const filtered = messagesParamFilter([messages]);
    expect(sizeOf(messages)).toBeGreaterThan(500_000);
    expect(sizeOf(filtered)).toBeLessThan(2_000);
    expect(filtered.messageCount).toBe(messages.length);
  });

  test("messagesParamFilter：支持 { messages } 包装形状", () => {
    const messages = bigMessages(5, 100);
    expect(messagesParamFilter([{ messages }]).messageCount).toBe(messages.length);
    expect(messagesParamFilter([messages]).messageCount).toBe(messages.length);
  });

  test("toolExecParamFilter：工具参数只留键名，不留值 → < 2KB", () => {
    const ctx = {
      currentToolCall: {
        toolName: "bash",
        toolCallId: "call_123",
        args: { command: "x".repeat(300_000), filePath: "y".repeat(100_000) },
      },
    };
    const filtered = toolExecParamFilter([ctx]);
    expect(sizeOf(filtered)).toBeLessThan(2_000);
    expect(filtered.tool).toBe("bash");
    expect(filtered.toolCallId).toBe("call_123");
    // 只留键名，不留值
    expect(filtered.argKeys).toEqual(["command", "filePath"]);
    expect(JSON.stringify(filtered)).not.toContain("x".repeat(100));
  });

  test("toolExecParamFilter：形状变化时防御性访问", () => {
    expect(() => toolExecParamFilter([])).not.toThrow();
    expect(() => toolExecParamFilter([{}])).not.toThrow();
    expect(() => toolExecParamFilter([{ currentToolCall: null }])).not.toThrow();
    expect(toolExecParamFilter([{}]).tool).toBeNull();
  });

  test("embedParamFilter：大 texts 数组 → 摘要 < 2KB", () => {
    const texts = Array.from({ length: 200 }, () => "w".repeat(5_000));
    const filtered = embedParamFilter([{ provider: "openai", modelId: "text-embedding", input: texts }]);
    expect(sizeOf(filtered)).toBeLessThan(2_000);
    expect(filtered.inputCount).toBe(200);
    expect(filtered.totalChars).toBe(200 * 5_000);
  });

  test("embedResultFilter：embedding 向量 → 只留维度", () => {
    const embeddings = [new Array(1536).fill(0.123)];
    const filtered = embedResultFilter({ embeddings, usage: { promptTokens: 5 } });
    expect(sizeOf(filtered)).toBeLessThan(2_000);
    expect(filtered.dimensions).toBe(1536);
    expect(filtered.embeddingCount).toBe(1);
  });
});

describe("trace-filters · ROY_TRACE_FULL 全量模式", () => {
  beforeEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
  });
  afterEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
  });

  test("默认关闭：isTraceFullMode() === false", () => {
    expect(isTraceFullMode()).toBe(false);
  });

  test("ROY_TRACE_FULL=1 → 全量模式生效", () => {
    process.env.ROY_TRACE_FULL = "1";
    resetTraceFullModeCache();
    expect(isTraceFullMode()).toBe(true);
  });

  test("全量模式下 filter 保留原始大对象（体积回到改造前）", () => {
    const messages = bigMessages(20, 2000);
    process.env.ROY_TRACE_FULL = "1";
    resetTraceFullModeCache();

    const filtered = llmInvokeParamFilter([{ messages, model: "MiniMax-M3" }]);
    // 全量模式：原始 messages 必须还在
    expect(sizeOf(filtered)).toBeGreaterThan(50_000);
    expect(JSON.stringify(filtered)).toContain("x".repeat(100));

    const res = llmInvokeResultFilter({ output: { content: "z".repeat(50_000) } });
    expect(sizeOf(res)).toBeGreaterThan(50_000);
  });

  test("全量模式下 messages / tool / embed filter 同样恢复全量", () => {
    const messages = bigMessages(10, 2000);
    process.env.ROY_TRACE_FULL = "1";
    resetTraceFullModeCache();

    expect(sizeOf(messagesParamFilter([messages]))).toBeGreaterThan(10_000);
    expect(
      sizeOf(toolExecParamFilter([{ currentToolCall: { toolName: "bash", args: { c: "x".repeat(20_000) } } }])),
    ).toBeGreaterThan(10_000);
    expect(sizeOf(embedParamFilter([{ input: ["y".repeat(20_000)] }]))).toBeGreaterThan(10_000);
  });

  test("ROY_TRACE_FULL=0 / false → 仍是瘦身模式（避免歧义写法被误判为开启）", () => {
    for (const v of ["0", "false", "no", ""]) {
      process.env.ROY_TRACE_FULL = v;
      resetTraceFullModeCache();
      expect(isTraceFullMode()).toBe(false);
    }
  });

  test("ROY_TRACE_FULL=true / yes 也识别为开启", () => {
    for (const v of ["true", "TRUE", "yes", "Yes"]) {
      process.env.ROY_TRACE_FULL = v;
      resetTraceFullModeCache();
      expect(isTraceFullMode()).toBe(true);
    }
  });

  test("envQueryParamFilter：handle_query 的 query 不被原样存进 agentName", () => {
    // 回归防护：早期版本把 args[0] 一律当 agentName，
    // 而 `env.handle_query(query, context?)` 的 args[0] 就是 query ——
    // 整条 query 会被原样存进 agentName 字段，过滤器等于没生效。
    const query = "请帮我分析这段很长的需求说明".repeat(200);
    const filtered = envQueryParamFilter([query, { sessionId: "s1" }]);
    expect(filtered.agentName).toBeNull();
    expect(filtered.queryChars).toBe(query.length);
    expect(filtered.contextKeys).toEqual(["sessionId"]);
    // 摘要里不能出现 query 原文
    expect(JSON.stringify(filtered)).not.toContain("请帮我分析这段很长的需求说明");
  });

  test("envQueryParamFilter：handle_workflow_agent_query 的 agentName 正确解析", () => {
    const query = "workflow query";
    const filtered = envQueryParamFilter(["my-agent", query, {}, { sessionId: "s2" }]);
    expect(filtered.agentName).toBe("my-agent");
    expect(filtered.queryChars).toBe(query.length);
    expect(filtered.contextKeys).toEqual(["sessionId"]);
  });

  test("envQueryParamFilter：多模态 query（ContentPart[]）只留条数与长度", () => {
    const filtered = envQueryParamFilter([
      [{ type: "text", text: "a".repeat(5000) }, { type: "image", data: "b".repeat(1000) }],
    ]);
    expect(filtered.isMultimodal).toBe(true);
    expect(filtered.queryParts).toBe(2);
    expect(filtered.queryChars).toBe(5000);
    expect(JSON.stringify(filtered)).not.toContain("aaaaa");
  });

  test("toolInvokeParamFilter / toolExecResultFilter：bash 大命令 + 大 stdout 变摘要", () => {
    // 用**不重复**的标记，否则子串会偶然出现在保留的前 2000 字符里
    const marker = "SECRET_TAIL_MARKER";
    const command = "cat /var/log/huge.log ".repeat(500) + marker;
    const params = toolInvokeParamFilter([{ command, timeout: 30000 }]);
    expect(params.commandChars).toBe(command.length);
    expect(params.commandTruncated).toBe(true);
    // 命令原文按设计保留前 2000 字符（短命令原样保留，长命令截断）
    expect((params.command ?? "").length).toBe(2000);
    // 尾部标记被截掉了
    expect(JSON.stringify(params)).not.toContain(marker);

    const res = toolExecResultFilter({
      success: true,
      output: "x".repeat(50_000),
      metadata: { stdout: "y".repeat(30_000), stderr: "", exit_code: 0, execution_time_ms: 12 },
    });
    expect(res.outputChars).toBe(50_000);
    expect(res.stdoutChars).toBe(30_000);
    expect(res.exitCode).toBe(0);
    expect(JSON.stringify(res).length).toBeLessThan(2000);
  });

  test("toolExecResultFilter：兼容 ToolCallResult 包装与对象型 output", () => {
    // agent.component.executeTool 返回 ToolCallResult = { id, name, success, result: ToolResult }
    const wrapped = toolExecResultFilter({
      id: "call_1",
      name: "read",
      success: true,
      result: { success: true, output: { content: "c".repeat(20_000), lines: 400 } },
    });
    expect(wrapped.tool).toBe("read");
    expect(wrapped.success).toBe(true);
    expect(wrapped.outputChars).toBeGreaterThan(20_000);
    expect(sizeOf(wrapped)).toBeLessThan(2_000);

    // ToolResult 直接形状（tool.bash.execute / tool.component.execute）
    const direct = toolExecResultFilter({ success: false, output: "x".repeat(10_000), error: "boom" });
    expect(direct.outputChars).toBe(10_000);
    expect(direct.error).toBe("boom");
    expect(sizeOf(direct)).toBeLessThan(2_000);
  });

  test("所有 filter 对 null / undefined 入参都不抛（filter 是公开导出的）", () => {
    const fns = [
      llmInvokeParamFilter,
      llmInvokeResultFilter,
      messagesParamFilter,
      toolExecParamFilter,
      toolInvokeParamFilter,
      toolExecResultFilter,
      embedParamFilter,
      embedResultFilter,
      envQueryParamFilter,
      agentRunParamFilter,
      recordSessionMessagesParamFilter,
    ];
    for (const fn of fns as any[]) {
      expect(() => fn(null)).not.toThrow();
      expect(() => fn(undefined)).not.toThrow();
      expect(() => fn([])).not.toThrow();
    }
  });

  test("toolExecParamFilter：函数形状的入参不抛（函数的 arguments 是毒化属性）", () => {
    // 函数对象上的 `arguments` 在严格模式下访问会抛 TypeError ——
    // 直接读 `toolCall.arguments` 会炸。这里确认不会。
    expect(() => toolExecParamFilter([() => {}])).not.toThrow();
    expect(() => toolExecParamFilter([() => {}])).not.toThrow();
    const r = toolExecParamFilter([{ currentToolCall: () => {} }]);
    expect(r.argCount).toBe(0);
  });
});

describe("trace-filters · agent.component.run / recordSessionMessages", () => {
  beforeEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
  });
  afterEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
  });

  test("agentRunParamFilter：query 只留长度，不留内容（CV 发现的漏网之鱼）", async () => {
    const { agentRunParamFilter } = await import("./trace-filters");
    const query = "q".repeat(70_000);
    const filtered = agentRunParamFilter(["roy", query, { sessionId: "s1" }]);
    expect(sizeOf(filtered)).toBeLessThan(2_000);
    expect(filtered.agentName).toBe("roy");
    expect(filtered.queryChars).toBe(70_000);
    expect(filtered.contextKeys).toEqual(["sessionId"]);
    expect(JSON.stringify(filtered)).not.toContain("q".repeat(100));
  });

  test("agentRunParamFilter：多模态 query 不入库", async () => {
    const { agentRunParamFilter } = await import("./trace-filters");
    const query = [{ type: "text", text: "hello" }, { type: "image", data: "B".repeat(200_000) }];
    const filtered = agentRunParamFilter(["roy", query]);
    expect(sizeOf(filtered)).toBeLessThan(2_000);
    expect(filtered.isMultimodal).toBe(true);
    expect(filtered.queryParts).toBe(2);
  });

  test("recordSessionMessagesParamFilter：全量 messages 只留条数（200KB/迭代 → 摘要）", async () => {
    const { recordSessionMessagesParamFilter } = await import("./trace-filters");
    const msgs = Array.from({ length: 100 }, () => ({ role: "assistant", content: "m".repeat(2000) }));
    const filtered = recordSessionMessagesParamFilter(["sess-1", msgs]);
    expect(sizeOf(filtered)).toBeLessThan(2_000);
    expect(filtered.messageCount).toBe(100);
    expect(filtered.totalChars).toBe(200_000);
    expect(filtered.sessionId).toBe("sess-1");
  });

  test("recordSessionMessagesParamFilter：防御性访问", async () => {
    const { recordSessionMessagesParamFilter } = await import("./trace-filters");
    expect(() => recordSessionMessagesParamFilter([])).not.toThrow();
    expect(() => recordSessionMessagesParamFilter([undefined, "not-array"])).not.toThrow();
    expect(recordSessionMessagesParamFilter([]).messageCount).toBe(0);
  });

  test("messagesParamFilter：多模态与 tool part 也计入字符数", async () => {
    const { messagesParamFilter } = await import("./trace-filters");
    const msgs = [
      { role: "user", content: [{ type: "text", text: "t".repeat(500) }, { type: "image", data: "BASE64" }] },
      { role: "assistant", content: [{ type: "tool-call", name: "bash" }] },
      { role: "tool", content: "r".repeat(300) },
    ];
    // 500（part.text）+ 300（字符串 content）；数组形态不再被记成 0
    expect(messagesParamFilter([msgs]).totalChars).toBe(800);
  });
});

// ============================================================================
// Task #5341 — 从 trace 直接看清「LLM 请求到底带了哪些工具」
//
// 背景：slim 模式下 `llm.component.invoke` 只记了 `tools: <数量>`。数量相同
// （比如都是 11）无法区分「带的是 wecom_respond 还是别的工具」—— 渠道专用
// 工具（channelOnly）是否真的注入到 LLM 请求里，从 trace 上根本看不出来。
// 修法：额外记 `toolNames`（名称列表），体积仍在 2KB 以内（工具名很短）。
// ============================================================================
describe("trace-filters · Task #5341 记录 LLM 请求的 toolNames", () => {
  beforeEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
  });
  afterEach(() => {
    delete process.env.ROY_TRACE_FULL;
    resetTraceFullModeCache();
  });

  test("llmInvokeParamFilter：slim 模式记录 tools 名称列表（可判断 wecom_respond 是否真传入）", () => {
    const filtered = llmInvokeParamFilter([
      {
        messages: bigMessages(2, 100),
        model: "MiniMax-M3",
        tools: [
          { name: "bash", description: "d".repeat(5000), parameters: { a: 1 } },
          { name: "wecom_respond", description: "d".repeat(5000), parameters: { b: 2 } },
        ],
      },
    ]);
    expect(filtered.tools).toBe(2);
    expect(filtered.toolNames).toEqual(["bash", "wecom_respond"]);
  });

  test("llmInvokeParamFilter：HookContext 形状同样记录 toolNames", () => {
    const filtered = llmInvokeParamFilter([
      {
        messages: bigMessages(2, 100),
        tools: [{ name: "bash" }, { name: "wecom_respond" }, { name: "grep" }],
        context: { model: "MiniMax-M3", sessionId: "sess-1" },
      },
    ]);
    expect(filtered.tools).toBe(3);
    expect(filtered.toolNames).toEqual(["bash", "wecom_respond", "grep"]);
  });

  test("llmInvokeParamFilter：toolNames 有字符预算，病态入参也不撑破 2KB", () => {
    // 60 个超长工具名（每个 ~34 字节 → 全量 2KB+）→ 触发预算截断
    const tools = Array.from({ length: 60 }, (_, i) => ({
      name: `tool_${i}_with_a_rather_long_name`,
      description: "d".repeat(8000),
      parameters: { x: "y".repeat(8000) },
    }));
    const filtered = llmInvokeParamFilter([{ messages: bigMessages(5, 100), tools }]);
    expect(sizeOf(filtered)).toBeLessThan(2_000);
    expect(filtered.tools).toBe(60); // 数量永远是准确的
    expect(filtered.toolNamesTruncated).toBe(true);
    expect(filtered.toolNames.length).toBeLessThan(60);
    expect(filtered.toolNames[0]).toBe("tool_0_with_a_rather_long_name"); // 保留前缀
  });

  test("llmInvokeParamFilter：单个超长工具名只截断自身，不清空整个列表（review MINOR-2）", () => {
    const filtered = llmInvokeParamFilter([
      { messages: bigMessages(2, 100), tools: [{ name: "z".repeat(5000) }, { name: "bash" }] },
    ]);
    expect(filtered.tools).toBe(2);
    expect(filtered.toolNames.length).toBe(2); // 前缀项仍在
    expect(filtered.toolNames[0].endsWith("…")).toBe(true);
    expect(filtered.toolNames[0].length).toBeLessThanOrEqual(121);
    expect(filtered.toolNames[1]).toBe("bash");
  });

  test("llmInvokeParamFilter：ROY_TRACE_FULL=1 时回到全量，不再产出 toolNames（review MINOR-1）", () => {
    process.env.ROY_TRACE_FULL = "1";
    resetTraceFullModeCache();
    const args = [{ messages: [{ role: "user", content: "hi" }], tools: [{ name: "bash" }] }];
    const filtered = llmInvokeParamFilter(args);
    expect(filtered).toEqual({ args });
    expect((filtered as any).toolNames).toBeUndefined();
  });

  test("llmInvokeParamFilter：无工具 / 形状异常 → toolNames 为空数组（不抛异常）", () => {
    expect(llmInvokeParamFilter([{}]).toolNames).toEqual([]);
    expect(llmInvokeParamFilter([{ tools: "not-an-array" }]).toolNames).toEqual([]);
    expect(() => llmInvokeParamFilter([{ tools: [null, undefined, 42] }])).not.toThrow();
    expect(llmInvokeParamFilter([{ tools: [null, undefined, 42] }]).toolNames).toEqual([]);
  });
});
