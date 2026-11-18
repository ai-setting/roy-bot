/**
 * Tests for collectEventSourceSystemPrompts (Phase 3)
 *
 * 关键行为:
 * - collect 应该为每个 --es source 解析 systemPrompt
 * - bounty-im: 用 resolveBountyIMSystemPrompt (含 default 工厂)
 * - 其他 type: 读 config.systemPrompt (没设置则跳过)
 * - joinResolvedSystemPrompts: 数组合并成单个 string
 */

import { describe, test, expect } from "bun:test";

describe("joinResolvedSystemPrompts", () => {
  test("空数组返回空串", () => {
    const result = require("./collect-event-source-system-prompts").joinResolvedSystemPrompts([]);
    expect(result).toBe("");
  });

  test("单元素直接返其 prompt", () => {
    const result = require("./collect-event-source-system-prompts").joinResolvedSystemPrompts([
      { id: "a", type: "bounty-im", prompt: "hello" }
    ]);
    expect(result).toBe("hello");
  });

  test("多元素用 \\n\\n---\\n\\n 分隔", () => {
    const result = require("./collect-event-source-system-prompts").joinResolvedSystemPrompts([
      { id: "a", type: "bounty-im", prompt: "alpha" },
      { id: "b", type: "bounty-im", prompt: "beta" }
    ]);
    expect(result).toBe("alpha\n\n---\n\nbeta");
  });
});

describe("collectEventSourceSystemPrompts", () => {
  test("为 bounty-im source 解析默认 prompt（包含 address + endpoint）", () => {
    const mockComponent = {
      get: (id: string) => {
        if (id === "bounty-im-1") {
          return {
            id: "bounty-im-1",
            name: "Bounty IM",
            type: "bounty-im",
            enabled: true,
            address: "agent-x@bounty.example.com",
            imServerUrl: "wss://bounty.example.com/ws",
          };
        }
        return undefined;
      },
    } as any;
    const result = require("./collect-event-source-system-prompts").collectEventSourceSystemPrompts(
      ["bounty-im-1"],
      mockComponent
    );
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("bounty-im-1");
    expect(result[0].type).toBe("bounty-im");
    expect(result[0].prompt).toContain("agent-x@bounty.example.com");
    // default prompt 把 wss 转化为 https endpoint (Phase B.11+ P1-2 fix)
    expect(result[0].prompt).toContain("https://bounty.example.com");
    expect(result[0].prompt).toContain("bounty com send");
  });

  test("bounty-im user config.systemPrompt 优先于 default", () => {
    const customPrompt = "CUSTOM user override prompt";
    const mockComponent = {
      get: () => ({
        id: "b1",
        name: "B1",
        type: "bounty-im",
        enabled: true,
        address: "agent-x@bounty.example.com",
        imServerUrl: "wss://bounty.example.com/ws",
        systemPrompt: customPrompt,
      }),
    } as any;
    const result = require("./collect-event-source-system-prompts").collectEventSourceSystemPrompts(
      ["b1"],
      mockComponent
    );
    expect(result[0].prompt).toBe(customPrompt);
  });

  test("unknown source id 跳过（不抛错）", () => {
    const mockComponent = {
      get: () => undefined,
    } as any;
    const result = require("./collect-event-source-system-prompts").collectEventSourceSystemPrompts(
      ["non-existent"],
      mockComponent
    );
    expect(result.length).toBe(0);
  });

  test("★ ES-M1: lark-cli lean 模式（默认）没设 systemPrompt 时也收集渠道 prompt", () => {
    const mockComponent = {
      get: () => ({
        id: "lark-1",
        name: "Lark",
        type: "lark-cli",
        enabled: true,
        profile: "tongzhuli",
      }),
    } as any;
    const result = require("./collect-event-source-system-prompts").collectEventSourceSystemPrompts(
      ["lark-1"],
      mockComponent
    );
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("lark-cli");
    // 渠道 prompt：含静态规则 + profile
    expect(result[0].prompt).toContain("飞书回复规范");
    expect(result[0].prompt).toContain('profile="tongzhuli"');
    expect(result[0].prompt).toContain("关键 0");
  });

  test("★ ES-M1: lark-cli 显式设了 systemPrompt 就在前 + 渠道 prompt 在后", () => {
    const mockComponent = {
      get: () => ({
        id: "lark-1",
        name: "Lark",
        type: "lark-cli",
        enabled: true,
        systemPrompt: "you are lark assistant",
      }),
    } as any;
    const result = require("./collect-event-source-system-prompts").collectEventSourceSystemPrompts(
      ["lark-1"],
      mockComponent
    );
    expect(result.length).toBe(1);
    expect(result[0].prompt).toContain("you are lark assistant");
    expect(result[0].prompt).toContain("飞书回复规范");
  });

  test("★ ES-M1: lark-cli legacy 模式行为与旧版一致（无渠道注入）", () => {
    const mockComponent = {
      get: () => ({
        id: "lark-1",
        name: "Lark",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy",
      }),
    } as any;
    const result = require("./collect-event-source-system-prompts").collectEventSourceSystemPrompts(
      ["lark-1"],
      mockComponent
    );
    // legacy 且未设置 systemPrompt → 跳过（与旧版一致）
    expect(result.length).toBe(0);
  });

  test("★ ES-M1: lark-cli legacy 模式显式 systemPrompt 原值返回", () => {
    const mockComponent = {
      get: () => ({
        id: "lark-1",
        name: "Lark",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy",
        systemPrompt: "legacy only",
      }),
    } as any;
    const result = require("./collect-event-source-system-prompts").collectEventSourceSystemPrompts(
      ["lark-1"],
      mockComponent
    );
    expect(result.length).toBe(1);
    expect(result[0].prompt).toBe("legacy only");
  });
});
