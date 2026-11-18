/**
 * @fileoverview Task #5080 — **真实解析器**接进 EventHandler 的端到端回归
 *
 * ## 为什么单独一个文件（DS review 指出的缺口）
 *
 * 之前的三组测试各自覆盖一层，但**没有**一条测试把
 * 「真实的 `createCardUrlResolver()`（真读 lark-cards.db + 真 spawn lark-cli）」
 * 接进「真实的 `EventHandler`」再走一遍完整回执链路。
 *
 * 缺口的后果：如果将来有人在 `createCardUrlResolver` 里重新引入
 * 「await 一个可能很慢的 position 查询」，前两层的单测可能仍然全绿
 * （因为它们各自 mock 了 lookupPosition / 直接调纯函数），
 * 而生产照样退化成「纯文本回执」。
 *
 * 本文件用**真实的解析器**（tmp 卡片库 + 可控时延的 lookupPosition）
 * 接进**真实的 EventHandler**，端到端断言「回执正文含可点击链接」。
 *
 * ## 断言的关键点
 *
 *   1. 有卡片记录 ⇒ 回执正文**必定**含「📌 查看任务卡片」+ applink URL
 *   2. position 查询慢（远超外层 2500ms 回执预算）⇒ **仍然**含链接
 *   3. 无卡片记录 ⇒ 不含链接（绝不编造）
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLarkCardStateStore,
  type LarkCardStateStore,
} from "@ai-setting/roy-bot-core/env/task/plugins";

import { clearCardLinkCache } from "./card-message-link";
import { createCardUrlResolver } from "./card-link-resolver";
import { EventHandler } from "./event-handler";

const CHAT = "oc_0c4501033c8200beb51ac65d2c308ad3";
const MSG = "om_x100b61e03c891ca8cfc2b61acdf16c9";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  clearCardLinkCache();
  tmpDir = mkdtempSync(join(tmpdir(), "notice-real-resolver-test-"));
  dbPath = join(tmpDir, "lark-cards.db");
});

afterEach(() => {
  clearCardLinkCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedCard(taskId: number): void {
  const store: LarkCardStateStore = createLarkCardStateStore(dbPath);
  store.upsert({
    taskId,
    messageId: MSG,
    chatId: CHAT,
    profile: "tongzhuli",
    pinned: true,
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 生产形态的终态事件（payload 里 associatedTaskId 存在 —— 实测确证） */
function makeCompletedEvent(associatedTaskId?: number): any {
  return {
    id: "evt-completed-5080-real",
    type: "task.background.completed",
    timestamp: Date.now(),
    metadata: {
      source: "task.background",
      trigger_session_id: CHAT,
      replyChannel: {
        type: "lark-cli",
        chatId: CHAT,
        messageId: "om_x100b61303080ecb8b0e218b6241b1ef",
        profile: "tongzhuli",
      },
    },
    payload: {
      backgroundTaskId: "process_1793934948642_1wgujbhjl",
      subSessionId: "session_bc11204c-bd52-400d-afd6-11bb680e2703",
      parentSessionId: CHAT,
      status: "completed",
      description: "P3 Phase 2 滚动条键位",
      ...(associatedTaskId !== undefined ? { associatedTaskId } : {}),
      executionTimeMs: 1967161,
    },
  };
}

/** 用**真实解析器**装配 EventHandler，只替换 lark 投递（避免真发消息） */
function makeHandler(resolveCardUrl: (t: number) => Promise<string | undefined>) {
  const sent: { text: string; chatId: string }[] = [];
  const handler: any = new EventHandler({
    env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
    eventTypes: ["task.background.*"],
    formatter: { format: (e: any) => ({ message: "", envEvent: e }) } as any,
    isIdle: () => true,
    onEvent: async () => {},
    onEventWithEnv: async () => {},
    resolveCardUrl,
    // ★ Task #5360：本文件锁定的是**文本直发/回执**的机制（文案 / 链接 /
    //   硬预算 / best-effort），不是"要不要发"。卡片化改造把默认模式改成
    //   `"auto"`（按 ES 配置 statusNotifications，缺省 false ⇒ 静默走卡片），
    //   所以显式钉 `"text"` 让这些机制断言继续测它们该测的东西。
    //   "默认 auto + 配置 false 时静默" 由 telemetry-notice-card-mode-5360.test.ts 覆盖。
    noticeTextDelivery: "text",
    telemetrySender: async (n: any) => {
      sent.push(n);
    },
  } as any);
  return { handler, sent };
}

// ============================================================================
// 真实解析器 + 真实 EventHandler 的端到端断言
// ============================================================================

describe("真实解析器 → EventHandler → 回执正文（#5080）", () => {
  test("★ 有卡片 + position 查询正常 ⇒ 回执含精确 applink 链接", async () => {
    seedCard(5077);
    // ★ 真实解析器（真读 tmp 卡片库）；只把 spawn 换成即时返回
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => "393",
    });
    const { handler, sent } = makeHandler(resolve);

    const t0 = Date.now();
    await handler["sendRuleNotice"](makeCompletedEvent(5077));
    const dur = Date.now() - t0;

    expect(sent.length).toBe(1);
    const text = sent[0].text;
    expect(text).toContain("📌 查看任务卡片");
    expect(text).toContain("applink.feishu.cn");
    expect(text).toContain("position=393");
    expect(dur).toBeLessThan(2500);
  });

  test("★ 有卡片 + position 查询卡死 ⇒ 回执**仍**含 chat 级链接（核心回归）", async () => {
    seedCard(5077);
    // ★ 真实解析器 + 永不返回的 position 查询（模拟 lark-cli spawn 卡死）
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: () => new Promise<string | undefined>(() => {}),
      lookupTimeoutMs: 100,
    });
    const { handler, sent } = makeHandler(resolve);

    await handler["sendRuleNotice"](makeCompletedEvent(5077));

    expect(sent.length).toBe(1);
    const text = sent[0].text;
    // ★ 关键：链接必须还在（生产事故就是这个链接消失了）
    expect(text).toContain("📌 查看任务卡片");
    expect(text).toContain("applink.feishu.cn");
    expect(text).toContain(`openChatId=${CHAT}`);
    // 正文其余部分完整
    expect(text).toContain("✅ Task #5077");
  });

  test("★ 有卡片 + position 查询极慢（5s > 回执预算）⇒ 回执**仍**含链接", async () => {
    seedCard(5077);
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => {
        await sleep(5000);
        return "393";
      },
      lookupTimeoutMs: 100,
    });
    const { handler, sent } = makeHandler(resolve);

    await handler["sendRuleNotice"](makeCompletedEvent(5077));

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("📌 查看任务卡片");
    expect(sent[0].text).toContain("applink.feishu.cn");
  });

  test("★ 无卡片记录 ⇒ 回执不含链接（绝不编造）", async () => {
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => "393",
    });
    const { handler, sent } = makeHandler(resolve);

    await handler["sendRuleNotice"](makeCompletedEvent(5077));

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("✅ Task #5077");
    expect(sent[0].text).not.toContain("查看任务卡片");
  });
});
