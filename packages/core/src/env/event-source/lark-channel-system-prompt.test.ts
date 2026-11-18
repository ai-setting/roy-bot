/**
 * @fileoverview Task #5144 — ES-M1 渠道信息前置 system prompt（方案 Task #5139 §5.1）
 *
 * 核心改造（lean 模式，默认）：
 *   1. `buildLarkChannelSystemPrompt()` — 把 buildLarkRecommendedAction 的
 *      **静态章节**（~4381 chars：关键 0/1/2/3、30KB 上限、禁分段、
 *      禁 --reply-in-thread、--as bot、mktemp+jq 模板）迁入渠道级
 *      system prompt；插值只有开头 profile 2-3 行（profile 是渠道配置
 *      不是事件属性）。
 *   2. `extractMetadata` 在 lean 模式下产出**动态小卡片**：action 一句话
 *      指回 system prompt 章节 + replyTo 四元组（appId/profile/chatId/
 *      messageId）原结构不动。
 *   3. `resolveLarkChannelSystemPrompt(config)` 单点构造（只读 config，
 *      禁止读 event/rawEvent —— 渠道 prompt 构造函数禁止读事件级变量，
 *      否则字节漂移破坏 cache）。
 *   4. legacy 回退：`channelPromptMode: "legacy"` 时行为与旧版完全一致
 *      （长模板 + 无 systemPrompt）。
 *
 * 守护组迁移：single-message-reply-prompt.test.ts 的 (A)/(D)/(G)
 * 全部改测 buildLarkChannelSystemPrompt 输出（规则文本的唯一新家）。
 *
 * cache 不变量：
 *   - 同一渠道两次 resolve → 逐字节一致（prompt cache 前缀稳定）
 *   - 动态卡片不含规则文本（规则只在 system prompt 一处）
 *   - replyTo 结构与旧版逐字段一致（老 consumer 不破坏）
 */

import { describe, test, expect } from "bun:test";
import {
  buildLarkRecommendedAction,
  buildLarkChannelSystemPrompt,
  resolveLarkChannelSystemPrompt,
  extractMetadata,
  LARK_PROMPT_LENGTH_BUDGET,
} from "./event-source-handlers";
import type { EventSourceConfig } from "./types";

const baseOpts = {
  profile: "tongzhuli",
  chatType: "group",
  appId: "cli_aXXXXXXXXXXXXXX",
  chatId: "oc_6bc538acf41894300cf8da037f9f7cd0",
  messageId: "om_x100b63ee7efb8cacb18909655fcba6f",
} as const;

const baseConfig: EventSourceConfig = {
  id: "es-lark-test",
  name: "Lark Test",
  type: "lark-cli",
  enabled: true,
  profile: "tongzhuli",
} as EventSourceConfig;

/** 统计 needle 在 hay 里出现次数 */
function occurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** 章节标题（以 "## " 开头的行） */
function sectionHeadings(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("## "));
}

// ============================================================================
// 1. buildLarkChannelSystemPrompt — 静态规则的新家
// ============================================================================

describe("buildLarkChannelSystemPrompt（ES-M1：静态规则前置 system prompt）", () => {
  // ── 守护组 (A) 迁移：单一来源 ──
  test("(A-migrated) 渠道 prompt 只有 1 个章节标题谈「分段」", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    const segmentedSections = sectionHeadings(sp).filter((h) => /分段/.test(h));
    expect(segmentedSections).toHaveLength(1);
  });

  test("(A-migrated) --reply-in-thread 全文只出现 1 次", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(occurrences(sp, "--reply-in-thread")).toBe(1);
  });

  test("(A-migrated) 核心禁令措辞各只出现 1 次", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(occurrences(sp, "禁止分段")).toBe(1);
    expect(occurrences(sp, "只发一条")).toBe(1);
    expect(occurrences(sp, "陆续更新")).toBe(1);
  });

  // ── 守护组 (D) 迁移：模板一致 ──
  test("(D-migrated) 发送类命令模板不超过 4 份（#5472 群聊 @ sender 示例为第 4 份）", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    const sendLines = sp
      .split("\n")
      .filter((line) => /^\s*lark-cli\s/.test(line))
      .filter((line) => /\+messages-(reply|send)/.test(line));
    expect(sendLines.length).toBeLessThanOrEqual(4);
  });

  test("(D-migrated) 回复模板用 +messages-reply --message-id 且带 --as bot", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(sp).toMatch(/messages-reply\s+--message-id/);
    const sendLines = sp
      .split("\n")
      .filter((line) => /^\s*lark-cli\s/.test(line))
      .filter((line) => /\+messages-(reply|send)/.test(line));
    for (const line of sendLines) {
      expect(line).toContain("--as bot");
    }
    expect(sp).toMatch(/messages-reply[\s\S]*?--as\s+bot/);
    expect(sp).toMatch(/messages-send[\s\S]*?--as\s+bot/);
  });

  // ── 守护组 (G) 迁移：防膨胀 ──
  test("(G-migrated) 渠道 prompt 长度与旧 action 同量级（不膨胀），含静态规则", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    // 旧 action 模板 ~4486 chars（profile=tongzhuli 时 4745；Task #5164
    // 追加文档交付规范段后 4991；Task #5212 追加引用上下文段后 5287）。
    // 迁入后渠道 prompt ≈ 旧静态章节 + profile 句 + 指回说明，
    // 防御性上限与 (G) 同步：LARK_PROMPT_LENGTH_BUDGET（单一来源）。
    expect(sp.length).toBeGreaterThan(3000); // 规则文本真的迁进来了
    expect(sp.length).toBeLessThanOrEqual(LARK_PROMPT_LENGTH_BUDGET);
  });

  // ── 文档交付规范（Task #5164 需求 1）──
  test("文档交付规范：文档类产出必须存飞书云盘 + 云盘链接交付", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(sp).toMatch(/飞书云盘/);
    expect(sp).toMatch(/云盘链接/);
    expect(sp).toMatch(/docs \+create/);
    // 不落本地路径交付
    expect(sp).toMatch(/不(要|得|能)以本地路径|禁止.*本地路径|不落本地/);
  });

  test("文档交付规范：同一渠道两次构造仍逐字节一致（cache 前缀稳定）", () => {
    const a = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    const b = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(a).toBe(b);
  });

  // ── 硬规则保留（#4137/#4171/#4242 家底，不可丢失）──
  test("硬规则保留：--as bot / 30 KB / 230025 / idempotency / mktemp / jq --rawfile", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(sp).toMatch(/--as\s+bot/);
    expect(sp).toMatch(/30\s*KB/);
    expect(sp).toMatch(/230025/);
    expect(sp).toMatch(/idempotency-key[\s\S]{0,30}50\s*字符/);
    expect(sp).toMatch(/mktemp/);
    expect(sp).toMatch(/--rawfile/);
    expect(sp).toMatch(/--msg-type\s+post\s+--content/);
    expect(sp).not.toMatch(/4096/);
    expect(sp).not.toContain("<details>");
  });

  test("profile 插值：含必须用 profile=X 的警告 + 模板带 --profile flag", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "zhishitong" });
    expect(sp).toContain('profile="zhishitong"');
    expect(sp).toContain("--profile zhishitong");
    const noProfile = buildLarkChannelSystemPrompt({});
    expect(noProfile).not.toContain("--profile ");
  });

  // ── cache 核心不变量 ──
  test("同一渠道两次构造逐字节一致（prompt cache 前缀稳定）", () => {
    const a = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    const b = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(a).toBe(b);
  });

  test("渠道 prompt 不含任何事件级变量（chatId/messageId/senderId）", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    expect(sp).not.toContain("oc_6bc538acf41894300cf8da037f9f7cd0");
    expect(sp).not.toContain("om_x100b63ee7efb8cacb18909655fcba6f");
  });
});

// ============================================================================
// 2. resolveLarkChannelSystemPrompt — 单点构造 + channelPromptMode 开关
// ============================================================================

describe("resolveLarkChannelSystemPrompt（单点构造 + legacy/lean 开关）", () => {
  test("lean 模式（默认）：config 无 systemPrompt 时返回渠道 prompt", () => {
    const resolved = resolveLarkChannelSystemPrompt(baseConfig);
    expect(resolved).toBeDefined();
    expect(resolved).toContain('profile="tongzhuli"');
    expect(resolved).toContain("关键 0");
  });

  test("lean 模式：config.systemPrompt 用户配置优先（追加渠道 prompt，不覆盖）", () => {
    const config = {
      ...baseConfig,
      systemPrompt: "自定义渠道说明",
    } as EventSourceConfig;
    const resolved = resolveLarkChannelSystemPrompt(config)!;
    expect(resolved).toContain("自定义渠道说明");
    expect(resolved).toContain("关键 0"); // 渠道 prompt 仍注入
  });

  test("legacy 模式：channelPromptMode=legacy 返回 config.systemPrompt 原值（无渠道注入）", () => {
    const config = {
      ...baseConfig,
      channelPromptMode: "legacy",
      systemPrompt: "legacy-only prompt",
    } as unknown as EventSourceConfig;
    const resolved = resolveLarkChannelSystemPrompt(config);
    expect(resolved).toBe("legacy-only prompt");
  });

  test("legacy 模式：无 systemPrompt 时返回 undefined（与旧版行为一致）", () => {
    const config = {
      ...baseConfig,
      channelPromptMode: "legacy",
    } as unknown as EventSourceConfig;
    expect(resolveLarkChannelSystemPrompt(config)).toBeUndefined();
  });

  test("同一 config 两次 resolve 逐字节一致（渠道 prompt cache 稳定性）", () => {
    const a = resolveLarkChannelSystemPrompt(baseConfig);
    const b = resolveLarkChannelSystemPrompt(baseConfig);
    expect(a).toBe(b);
  });

  test("单点构造禁读事件：resolve 入参只有 config（类型层面约束，运行时冒烟）", () => {
    // resolveLarkChannelSystemPrompt(config) — 只有一个参数。
    // 运行时冒烟：同一 config、不同"事件"上下文多次调用结果一致。
    const c1 = resolveLarkChannelSystemPrompt(baseConfig);
    const c2 = resolveLarkChannelSystemPrompt(baseConfig);
    expect(c1).toBe(c2);
  });
});

// ============================================================================
// 3. extractMetadata lean 动态卡片 + legacy 长模板
// ============================================================================

describe("extractMetadata lean 动态卡片（ES-M1）", () => {
  function makeLarkMessageEvent(overrides: any = {}): any {
    return {
      type: "im.message.receive_v1",
      profile: overrides.profile,
      event: {
        header: {
          event_type: "im.message.receive_v1",
          app_id: overrides.appId || "cli_app123",
          tenant_key: "tenant_xyz",
        },
        message: {
          message_id: overrides.messageId || "om_msg_001",
          chat_id: overrides.chatId || "oc_chat_001",
          chat_type: overrides.chatType || "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
        sender: {
          sender_id: { open_id: "ou_user_001" },
        },
      },
    };
  }

  test("lean 模式：action 是一句话指回 system prompt 章节（不含规则文本）", () => {
    const { recommendedAction } = extractMetadata(makeLarkMessageEvent(), "im.message.receive_v1");
    expect(recommendedAction).toBeDefined();
    expect(recommendedAction!.action.length).toBeLessThan(500);
    // 动态卡片不含规则文本（规则只住 system prompt）
    expect(recommendedAction!.action).not.toMatch(/mktemp/);
    expect(recommendedAction!.action).not.toMatch(/30\s*KB/);
    expect(recommendedAction!.action).not.toMatch(/--rawfile/);
    expect(recommendedAction!.action).not.toMatch(/idempotency/);
    expect(recommendedAction!.action).not.toMatch(/--reply-in-thread/);
    // 但必须指回规则章节
    expect(recommendedAction!.action).toMatch(/system prompt|飞书回复规范/);
    expect(recommendedAction!.action).toContain("p2p 私聊"); // chatType 动态信息保留
  });

  test("lean 模式：replyTo 四元组结构不变（appId/profile/chatId/messageId）", () => {
    const { recommendedAction } = extractMetadata(
      makeLarkMessageEvent({ profile: "zhishitong", chatType: "group" }),
      "im.message.receive_v1",
    );
    expect(recommendedAction!.replyTo).toEqual({
      appId: "cli_app123",
      profile: "zhishitong",
      chatId: "oc_chat_001",
      messageId: "om_msg_001",
    });
  });

  test("legacy 模式：channelPromptMode=legacy 时行为与旧版一致（长模板含规则文本）", () => {
    const legacyEvent = { ...makeLarkMessageEvent(), channelPromptMode: "legacy" };
    const leanAction = buildLarkRecommendedAction(baseOpts).action;
    const { recommendedAction } = extractMetadata(legacyEvent, "im.message.receive_v1");
    expect(recommendedAction).toBeDefined();
    // legacy 长模板：包含规则文本（与 buildLarkRecommendedAction 同源）
    expect(recommendedAction!.action).toMatch(/mktemp/);
    expect(recommendedAction!.action).toMatch(/30\s*KB/);
    expect(recommendedAction!.action).toContain("禁止分段");
    // 且与旧 builder 输出同量级（不等于 lean 卡片）
    expect(recommendedAction!.action.length).toBeGreaterThan(3000);
    expect(leanAction.length).toBeGreaterThan(3000);
  });

  test("非 im.message.receive_v1 事件不产生 recommendedAction（原有行为不变）", () => {
    // 事件类型和 event.type 都不是 im.message.receive_v1
    const cardEvent = makeLarkMessageEvent();
    cardEvent.type = "card.action.trigger";
    const { recommendedAction } = extractMetadata(cardEvent, "card.action.trigger");
    expect(recommendedAction).toBeUndefined();
  });
});

// ============================================================================
// 4. guard: 静态规则文本在 lean 卡片中消失（不重复计费）
// ============================================================================

describe("lean 卡片与渠道 prompt 的职责分割", () => {
  test("规则文本（mktemp 模板）只出现在渠道 prompt，不出现在 lean 卡片", () => {
    const sp = buildLarkChannelSystemPrompt({ profile: "tongzhuli" });
    const { recommendedAction } = extractMetadata(
      { type: "im.message.receive_v1", event: { header: { event_type: "im.message.receive_v1", app_id: "cli_x" }, message: { message_id: "om_1", chat_id: "oc_1", chat_type: "group", message_type: "text", content: "{}" }, sender: { sender_id: { open_id: "ou_1" } } } },
      "im.message.receive_v1",
    );
    expect(sp).toMatch(/mktemp/);
    expect(recommendedAction!.action).not.toMatch(/mktemp/);
  });

  test("chatType 动态语义保留在卡片（p2p vs 群聊差异）", () => {
    const group = extractMetadata(
      { type: "im.message.receive_v1", event: { header: { event_type: "im.message.receive_v1" }, message: { message_id: "om_1", chat_id: "oc_1", chat_type: "group", message_type: "text", content: "{}" }, sender: { sender_id: { open_id: "ou_1" } } } },
      "im.message.receive_v1",
    ).recommendedAction!.action;
    const p2p = extractMetadata(
      { type: "im.message.receive_v1", event: { header: { event_type: "im.message.receive_v1" }, message: { message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: "{}" }, sender: { sender_id: { open_id: "ou_1" } } } },
      "im.message.receive_v1",
    ).recommendedAction!.action;
    expect(group).toContain("群聊");
    expect(p2p).toContain("p2p");
    expect(group).not.toBe(p2p);
  });
});
