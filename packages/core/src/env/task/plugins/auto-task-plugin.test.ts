import { describe, it, expect } from "bun:test";
import { createAutoTaskPlugin } from "./auto-task-plugin";
import type { HookContext, AgentContext } from "../../agent/types";

/**
 * AutoTaskPlugin v5.1 测试套件 — meta-protocol
 *
 * v5.1 行为契约（meta-protocol）：
 * - iteration === threshold 时通过 toolResult.result.metadata.toAddFakeUserMessage 协议
 *   设置一条 role: "user" 的消息，由 react 循环在 tool result 之后立即 push。
 * - 这样保证 messages 顺序：[assistant(tool_calls), tool(result), user(reminder)]
 *
 * 关键不变量（plugin 侧）：
 * - plugin 不再直接 push 到 ctx.messages（避免破坏相邻性）
 * - plugin 通过 hookCtx.toolResult.result.metadata.toAddFakeUserMessage 声明意图
 * - react 循环读取 metadata 后 push user message，并清除该字段（避免重复消费）
 */

function makeAgentCtx(
  iter: number,
  overrides?: Partial<{
    name: string;
    sid: string;
    traceId: string;
    toolOutput: string;
    toolResultOverride: any;
    messages: any[];
  }>
): HookContext {
  const name = overrides?.name ?? "default";
  const sid = overrides?.sid ?? "sess-A";
  const traceId = overrides?.traceId ?? `q-${crypto.randomUUID()}`;
  const toolOutput = overrides?.toolOutput ?? "some result";

  return {
    agent: { name } as any,
    iteration: iter,
    maxIterations: 50,
    messages: overrides?.messages ?? [
      { role: "user" as const, content: "帮我分析项目结构" },
    ],
    tools: [],
    systemPrompt: "You are a helpful assistant.",
    context: { sessionId: sid, traceId } as unknown as AgentContext,
    toolResult: overrides?.toolResultOverride ?? {
      id: "tc1",
      name: "bash",
      success: true,
      result: { success: true, output: toolOutput },
    },
  } as unknown as HookContext;
}

function extractMetaUserContent(ctx: HookContext): string | null {
  const meta = ctx.toolResult?.result?.metadata as any;
  if (!meta || !meta.toAddFakeUserMessage) return null;
  const m = meta.toAddFakeUserMessage;
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

function getMetaUserMsg(ctx: HookContext): any {
  const meta = ctx.toolResult?.result?.metadata as any;
  return meta?.toAddFakeUserMessage;
}

describe("AutoTaskPlugin v5.1 — meta-protocol: toolResult.result.metadata.toAddFakeUserMessage", () => {
  it("iteration < threshold — 不设置 toolResult.result.metadata", async () => {
    const p = createAutoTaskPlugin({ threshold: 3, agentName: "default" });
    const ctx = makeAgentCtx(1, { sid: "s1" });

    await p.execute(ctx);

    expect(ctx.messages.length).toBe(1);
    expect(getMetaUserMsg(ctx)).toBeUndefined();
  });

  it("iteration === threshold — 设置 metadata.toAddFakeUserMessage 且不 push ctx.messages", async () => {
    const p = createAutoTaskPlugin({ threshold: 3, agentName: "default" });
    const ctx = makeAgentCtx(3, { sid: "s2" });
    const initialMsgCount = ctx.messages.length;

    await p.execute(ctx);

    // ★ plugin 不直接 push 到 ctx.messages
    expect(ctx.messages.length).toBe(initialMsgCount);

    // ★ 通过 meta 协议声明意图
    const meta = ctx.toolResult?.result?.metadata as any;
    expect(meta).toBeDefined();
    expect(meta.toAddFakeUserMessage).toBeDefined();
    expect(meta.toAddFakeUserMessage.role).toBe("user");
  });

  it("metadata.toAddFakeUserMessage 内容包含 delegate_task、roy、iteration、阈值", async () => {
    const p = createAutoTaskPlugin({ threshold: 5, agentName: "default" });
    const ctx = makeAgentCtx(5, { sid: "s3" });

    await p.execute(ctx);

    const content = extractMetaUserContent(ctx);
    expect(content).not.toBeNull();
    expect(content!).toContain("delegate_task");
    expect(content!).toContain("roy");
    expect(content!).toContain("iteration");
    expect(content!).toContain("阈值");
  });

  it("metadata.toAddFakeUserMessage 包含当前 iteration 数字", async () => {
    const p = createAutoTaskPlugin({ threshold: 5, agentName: "default" });
    const ctx = makeAgentCtx(5, { sid: "s4" });

    await p.execute(ctx);

    const content = extractMetaUserContent(ctx);
    expect(content).not.toBeNull();
    expect(content!).toMatch(/5\s*次/);
  });

  it("plugin 永远不 mutate ctx.messages (meta-protocol 核心契约)", async () => {
    const p = createAutoTaskPlugin({ threshold: 1, agentName: "default" });
    const ctx = makeAgentCtx(1, { sid: "s11" });
    const beforeSnapshot = JSON.stringify(ctx.messages);

    await p.execute(ctx);

    // ★ plugin 不直接 push 到 ctx.messages — 这是 meta-protocol 的核心契约
    expect(JSON.stringify(ctx.messages)).toBe(beforeSnapshot);
  });

  it("plugin version === '5.2.0' (meta-protocol + shared helper version)", () => {
    const p = createAutoTaskPlugin({ threshold: 20, agentName: "default" });
    expect(p.version).toBe("5.2.0");
  });

  it("hookCtx.toolResult 缺失时 plugin 安全降级（不抛错）", async () => {
    const p = createAutoTaskPlugin({ threshold: 1, agentName: "default" });
    const ctx = makeAgentCtx(1, { sid: "s13" });
    (ctx as any).toolResult = undefined;

    const result = await p.execute(ctx);
    expect(result).toEqual({ continue: true });
  });
});