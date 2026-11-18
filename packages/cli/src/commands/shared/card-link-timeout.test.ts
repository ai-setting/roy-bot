/**
 * @fileoverview Task #5080 — 终态回执「查看任务卡片」链接丢失的复现与修复
 *
 * ## 现象（用户实测 2026-11-06 11:50 飞书群 oc_0c4501033c8200beb51ac65d2c308ad3）
 *
 * Task #5077 完成的终态回执是**纯文本**，没有 `[📌 查看任务卡片](applink...)`：
 *
 *     ✅ Task #5077「P3 Phase 2 滚动条键位」已完成（耗时 32m）
 *     助手随后补充交付摘要。
 *
 * 但卡片库 `lark-cards.db` 里 **task 5077 的记录是在的**
 * （message_id=om_x100b61e03c891ca8cfc2b61acdf16c9 / chat_id / profile 齐全）。
 *
 * ## 根因（生产取证）
 *
 * `card-message-link.ts` 的 `resolveCardLinkForTask()`：
 *
 *   1. 先算出 **chat 级**链接（零 IO，`?openChatId=<oc>`）——这已经很够用了
 *   2. 但**不立刻返回**，而是 `await` 一次 position 查询
 *      （`lark-cli im +messages-mget`，实测 ~1.05s，负载高时更久）
 *   3. 查完才决定返回 chat 级还是消息级
 *
 * 而 `event-handler.ts` 的 `resolveRuleNoticeCardUrlWithBudget()` 与
 * `RULE_NOTICE_CARD_LINK_BUDGET_MS = 2500` **赛跑**，超时即 `resolve(undefined)`。
 *
 * ⇒ **本该零成本就能拿到的 chat 级链接，被一次慢 position 查询拖到超时，
 *   最后连 chat 级链接也一起丢了。**
 *
 * 生产证据（traces.db `event_handler.rule_notice` span vs 飞书群真实消息）：
 *
 *   | task | span dur | 群内消息 | 链接 |
 *   |------|----------|----------|------|
 *   | 5077 | 5664ms   | om_...7fc4 | ❌ 无 |
 *   | 5079 | 2110ms   | om_...13f | ✅ 有（position=405）|
 *
 * ## 修复契约
 *
 *   1. **position 查询自带本地上界**：超时 / 异常 ⇒ 降级 **chat 级**链接，
 *      而不是「没有链接」。
 *   2. **内层上界必须小于外层回执预算**（1200ms < 2500ms）⇒ 外层预算
 *      永远不会被触发 ⇒ **只要卡片记录在，回执就一定带链接**。
 *   3. 降级后的 chat 级链接要能落进进程内缓存 ⇒ 后续回执零成本命中。
 */

import { describe, expect, test } from "bun:test";

import {
  clearCardLinkCache,
  resolveCardLinkCached,
  resolveCardLinkForTask,
} from "./card-message-link";

const CHAT = "oc_0c4501033c8200beb51ac65d2c308ad3";
const MSG = "om_x100b61e03c891ca8cfc2b61acdf16c9";
const CHAT_URL = `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`;
const EXACT_URL = `${CHAT_URL}&position=393`;

/** 睡 n 毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// 回归 #5080：慢 position 查询不得拖垮 chat 级链接
// ============================================================================

describe("resolveCardLinkForTask — 慢 position 查询不得拖垮 chat 级链接（#5080）", () => {
  test("★ lookup 永不返回（模拟 spawn 卡死）⇒ 本地超时后降级 chat 级链接", async () => {
    const t0 = Date.now();
    const url = await resolveCardLinkForTask(5077, {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      // 故意永不 resolve —— 模拟 lark-cli 子进程卡住
      lookupPosition: () => new Promise<string | undefined>(() => {}),
      lookupTimeoutMs: 80,
    });
    const elapsed = Date.now() - t0;

    // 关键：拿到的是 chat 级链接（**有链接**），不是 undefined（**没链接**）
    expect(url).toBe(CHAT_URL);
    // 且确实是被本地超时上界约束住的，不是无限等待
    expect(elapsed).toBeLessThan(1000);
  });

  test("★ lookup 慢但在小上界内完成 ⇒ 拿到精确 position 链接", async () => {
    const url = await resolveCardLinkForTask(5077, {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: async () => {
        await sleep(20);
        return "393";
      },
      lookupTimeoutMs: 500,
    });
    expect(url).toBe(EXACT_URL);
  });

  test("★ lookup 抛异常 ⇒ 降级 chat 级链接（不是 undefined）", async () => {
    const url = await resolveCardLinkForTask(5077, {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(url).toBe(CHAT_URL);
  });

  test("★ lookup 返回 undefined ⇒ 降级 chat 级链接（不是 undefined）", async () => {
    const url = await resolveCardLinkForTask(5077, {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: async () => undefined,
    });
    expect(url).toBe(CHAT_URL);
  });

  test("★ lookup 同步抛异常 ⇒ 降级 chat 级链接（绝不 reject）", async () => {
    const url = await resolveCardLinkForTask(5077, {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: (() => {
        throw new Error("sync boom");
      }) as any,
    });
    expect(url).toBe(CHAT_URL);
  });
});

// ============================================================================
// 跨模块不变量：内层上界 < 外层回执预算（2500ms）
// ============================================================================

describe("内层 position 上界必须小于外层回执预算（#5080 核心不变量）", () => {
  test("★ 缺省上界下，lookup 卡死 ⇒ 仍在 2500ms 回执预算内返回 chat 级链接", async () => {
    const t0 = Date.now();
    const url = await resolveCardLinkForTask(5077, {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: () => new Promise<string | undefined>(() => {}),
      // 不传 lookupTimeoutMs ⇒ 用缺省值
    });
    const elapsed = Date.now() - t0;

    expect(url).toBe(CHAT_URL);
    // 外层 RULE_NOTICE_CARD_LINK_BUDGET_MS = 2500ms
    // 内层必须显著小于它，否则外层预算先到 ⇒ 又变成「没有链接」
    expect(elapsed).toBeLessThan(2500);
  });
});

// ============================================================================
// 缓存：慢查询的降级结果也要能落缓存（下次零成本）
// ============================================================================

describe("resolveCardLinkCached — 慢查询后的降级结果（#5080）", () => {
  test("★ lookup 慢 ⇒ 缓存里存 chat 级链接（后续回执零成本命中）", async () => {
    clearCardLinkCache();
    let calls = 0;
    const deps = {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: async () => {
        calls += 1;
        await sleep(120);
        return undefined;
      },
    };

    const first = await resolveCardLinkCached(9501, deps);
    expect(first).toBe(CHAT_URL);

    const second = await resolveCardLinkCached(9501, deps);
    expect(second).toBe(CHAT_URL);
    // 第二次命中缓存 ⇒ 不再 spawn
    expect(calls).toBe(1);
  });
});
