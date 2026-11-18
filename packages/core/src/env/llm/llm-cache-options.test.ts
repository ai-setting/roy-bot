/**
 * @fileoverview LLM Cache Options Tests (TDD RED for Task #2748 P1+P2)
 *
 * 测试 4 项 LLM 层 cache 优化（参考 Task #2737 报告 §5.3-5.6）：
 * - 5.3: OpenAI-Compatible provider 挂 prompt_cache_key=sessionId
 * - 5.4: Tool schema 末 tool 挂 cache_control (Anthropic 3 层)
 * - 5.5: parts JSON key 顺序 canonicalize (SQLite 读写双向)
 * - 5.6: System prompt 拆分为多 content block (cache-friendly structure)
 *
 * 4 个核心 RED 测试：
 * - T1 (5.3): OpenAI-Compatible messages 应挂 prompt_cache_key
 * - T2 (5.4): 末 tool 应挂 cache_control（与 system 段组成 3 层）
 * - T3 (5.5): parts 跨 SQLite 读 byte-equal（key 顺序稳定）
 * - T4 (5.6): system message 拆分为多 block（多 cache_control）
 */

import { describe, it, expect } from "vitest";
import { convertToSDKMessages, applyToolCacheControl, canonicalizeParts } from "./invoke";
import { buildMultiBlockSystem } from "../agent/agent-component";

// ============================================================================
// T1 (5.3): OpenAI-Compatible provider 挂 prompt_cache_key
// ============================================================================
describe("convertToSDKMessages — OpenAI-Compatible prompt_cache_key 注入 (Task #2748 §5.3)", () => {
  it("T1.1: 注入 sessionId 到所有 OpenAI-Compatible provider (minimax)", () => {
    const messages = [
      { role: "system" as const, content: "you are helpful" },
      { role: "user" as const, content: "hello" },
    ];
    const result = convertToSDKMessages(messages, {
      sessionId: "sess_minimax_001",
      provider: "openai-compatible",
    });
    expect(result[0].providerOptions?.openai?.promptCacheKey).toBe("sess_minimax_001");
  });

  it("T1.2: DeepSeek provider 也应挂 prompt_cache_key", () => {
    const messages = [
      { role: "system" as const, content: "you are helpful" },
      { role: "user" as const, content: "hello" },
    ];
    const result = convertToSDKMessages(messages, {
      sessionId: "sess_deepseek_002",
      provider: "openai-compatible",
    });
    expect(result[0].providerOptions?.openai?.promptCacheKey).toBe("sess_deepseek_002");
  });

  it("T1.3: Anthropic provider 不挂 prompt_cache_key (保留 cache_control)", () => {
    const messages = [
      { role: "system" as const, content: "you are helpful" },
      { role: "user" as const, content: "hello" },
    ];
    const result = convertToSDKMessages(messages, {
      sessionId: "sess_anthropic_003",
      provider: "anthropic",
    });
    expect(result[0].providerOptions?.openai?.promptCacheKey).toBeUndefined();
    // 已有 cache_control 不变
    expect(result[0].providerOptions?.anthropic?.cacheControl).toBeDefined();
  });
});

// ============================================================================
// T2 (5.4): Tool schema 末 tool 挂 cache_control
// ============================================================================
describe("Tool schema 末 tool cache_control (Task #2748 §5.4)", () => {
  it("T2.1: Anthropic provider 末 tool 挂 cache_control", () => {
    const tools = [
      { name: "tool_a", description: "first", inputSchema: { type: "object" } },
      { name: "tool_b", description: "second", inputSchema: { type: "object" } },
      { name: "tool_c", description: "third", inputSchema: { type: "object" } },
    ];
    const result = applyToolCacheControl(tools, "anthropic") as any[];
    expect(result).toHaveLength(3);
    // 末 tool (tool_c) 应挂 cache_control
    const lastTool = result[result.length - 1] as Record<string, unknown>;
    expect(lastTool.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    // 其他 tool 不挂
    expect((result[0] as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((result[1] as Record<string, unknown>).providerOptions).toBeUndefined();
  });

  it("T2.2: OpenAI-Compatible provider 末 tool 不挂 cache_control (Anthropic 专属)", () => {
    const tools = [
      { name: "tool_a", description: "first", inputSchema: { type: "object" } },
      { name: "tool_b", description: "second", inputSchema: { type: "object" } },
    ];
    const result = applyToolCacheControl(tools, "openai-compatible") as any[];
    const lastTool = result[result.length - 1] as Record<string, unknown>;
    expect(lastTool.providerOptions).toBeUndefined();
  });
});

// ============================================================================
// T3 (5.5): parts JSON canonicalize
// ============================================================================
describe("parts JSON key canonicalize (Task #2748 §5.5)", () => {
  it("T3.1: 写入时 parts key 排序（tool-call arguments 字段稳定）", () => {
    const parts = [
      { type: "text", content: "hi" },
      { type: "tool-call", toolCallId: "tc_1", toolName: "bash", arguments: '{"z":1,"a":2,"m":3}' },
    ];
    const json1 = canonicalizeParts(parts);
    const json2 = canonicalizeParts(parts);
    expect(json1).toBe(json2);
    // 关键：tool-call arguments 的 key 应当按字母序排序
    // 由于 arguments 是 string 字段，sortObjectKeysDeep 不递归进 string。
    // canonicalizeParts 内部 parse → sort → stringify 后，arguments 内的 keys 已排序
    // 测试检查 outer part 字段的 key 顺序（content/type 之前，type 在 content 之后）
    expect(json1).toContain('"content":"hi"');
    expect(json1).toContain('"type":"text"');
    // content 应当在 type 之前（按字母序: c < t）
    const contentIdx = json1.indexOf('"content"');
    const typeIdx = json1.indexOf('"type"');
    expect(contentIdx).toBeLessThan(typeIdx);
  });

  it("T3.2: 写入时 parts key 排序，跨轮 read byte-equal (cache-stable)", () => {
    // 模拟场景：round 1 写入的 parts（key 未排序）vs round 2 写入的 parts（key 已排序）
    // 经过 SQLite JSON.stringify → JSON.parse 后，应当 byte-equal
    const partsRound1 = [
      { type: "tool-call", toolCallId: "tc_1", toolName: "bash", arguments: '{"z":1,"a":2,"m":3}' },
    ];
    const partsRound2 = [
      { type: "tool-call", toolCallId: "tc_1", toolName: "bash", arguments: '{"a":2,"m":3,"z":1}' }, // 不同顺序
    ];
    const stored1 = canonicalizeParts(partsRound1);
    const stored2 = canonicalizeParts(partsRound2);
    // RED: 当前实现直接 JSON.stringify，stored1 !== stored2
    // GREEN: canonicalizeParts 应排序后 stringify，stored1 === stored2
    expect(stored1).toBe(stored2);
  });
});

// ============================================================================
// T4 (5.6): Multi-block system prompt
// ============================================================================
describe("Multi-block system prompt (Task #2748 §5.6)", () => {
  it("T4.1: buildMultiBlockSystem 输出多段 system（按 cache 类型分组）", () => {
    const ctx = {
      characterSheet: "You are a helpful AI assistant.",
      toolDefinitions: "Available tools: bash, read, write.",
      memoryBlock: "User memory: prefers TypeScript.",
      dynamicContext: "[Task #1] running",
    };
    const messages = buildMultiBlockSystem(ctx);
    // 应当至少 2 个 system message 段（character + dynamic）
    const sysMessages = messages.filter((m) => m.role === "system");
    expect(sysMessages.length).toBeGreaterThanOrEqual(2);
    // character sheet 段（稳定）应挂 cache_control
    const first = sysMessages[0] as Record<string, unknown>;
    expect(first.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("T4.2: multi-block system 跨轮 byte-stable（每段独立 cache）", () => {
    const ctx1 = {
      characterSheet: "You are a helpful AI assistant.",
      toolDefinitions: "Available tools: bash, read, write.",
      memoryBlock: "User memory: prefers TypeScript.",
      dynamicContext: "[Task #1] running",
    };
    const ctx2 = {
      characterSheet: "You are a helpful AI assistant.",
      toolDefinitions: "Available tools: bash, read, write.",
      memoryBlock: "User memory: prefers TypeScript.",
      dynamicContext: "[Task #2] running", // <<< dynamic 段变化
    };
    const msgs1 = buildMultiBlockSystem(ctx1);
    const msgs2 = buildMultiBlockSystem(ctx2);
    // character sheet 段（[0]）应当 byte-equal
    expect(msgs1[0]).toEqual(msgs2[0]);
    // memory 段 byte-equal
    expect(msgs1[2]).toEqual(msgs2[2]);
    // dynamic 段（[3]）变化
    expect(msgs1[3]).not.toEqual(msgs2[3]);
  });
});
