/**
 * @fileoverview Task #5080 — 卡片链接解析器的**有上界的位置查询**行为（生产实测回归）
 *
 * ## 生产现象（task 5077，2026-11-06 11:50 飞书群）
 *
 * 终态回执是**纯文本**，没有「📌 查看任务卡片」：
 *
 *     ✅ Task #5077「P3 Phase 2 滚动条键位」已完成（耗时 32m）
 *     助手随后补充交付摘要。
 *
 * 但 `lark-cards.db` 里 **5077 的卡片记录是在的**。
 *
 * ## 根因（生产取证）
 *
 * `traces.db` 的 `event_handler.rule_notice` span：
 *
 *   | task | span dur | 预算 | 群内消息 | 链接 |
 *   |------|----------|------|----------|------|
 *   | 5077 | 5664ms   | 2500ms | om_...7fc4 | ❌ 无 |
 *   | 5079 | 2110ms   | 2500ms | om_...13f | ✅ 有 |
 *
 * 解析器把「读卡片记录（零 IO）」和「查 position（spawn lark-cli，~1.05s）」
 * **串在一次 await** 里，于是慢 spawn 把**本该免费**的 chat 级链接一起拖死。
 *
 * ## 修复契约（有上界的位置查询）
 *
 *   1. position 查询**必须**有本地上界 ⇒ 慢/卡死时不拖垮整条解析
 *   2. 上界到点 ⇒ 降级 **chat 级**链接（**有链接**，不是「没有链接」）
 *   3. 本地上界（1200ms）必须 < 外层回执预算（2500ms）
 *      ⇒ 外层预算永远不先被打爆 ⇒ 有卡片记录就一定带得上链接
 *   4. 正常快路径仍返回**精确**position 链接（常见路径精度不降）
 *
 * 注：「缺省上界（1200ms）下 lookup 卡死仍能落在 2500ms 预算内」这条
 * **只在 `card-link-timeout.test.ts` 里保留一份**（纯函数层），
 * 避免两个文件各留一份 ~1.2s 的真实 sleep 白给测试套件加 2.4s。
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
import {
  createCardUrlResolver,
  resetCardRecordStoreCacheForTest,
} from "./card-link-resolver";

const CHAT = "oc_0c4501033c8200beb51ac65d2c308ad3";
const MSG = "om_x100b61e03c891ca8cfc2b61acdf16c9";
const CHAT_URL = `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`;
const EXACT_URL = `${CHAT_URL}&position=393`;

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetCardRecordStoreCacheForTest();
  clearCardLinkCache();
  tmpDir = mkdtempSync(join(tmpdir(), "card-link-progressive-test-"));
  dbPath = join(tmpDir, "lark-cards.db");
});

afterEach(() => {
  resetCardRecordStoreCacheForTest();
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

// ============================================================================
// 有上界的位置查询
// ============================================================================

describe("createCardUrlResolver — 有上界的位置查询（#5080）", () => {
  test("★ lookup 永不返回（spawn 卡死）⇒ 解析仍在本地上界内返回 chat 级链接", async () => {
    seedCard(5077);
    const resolve = createCardUrlResolver({
      dbPath,
      // 故意永不 resolve —— 模拟 lark-cli 卡死
      lookupPosition: () => new Promise<string | undefined>(() => {}),
      lookupTimeoutMs: 100,
    });

    const t0 = Date.now();
    const url = await resolve(5077);
    const elapsed = Date.now() - t0;

    // 关键：拿到 chat 级链接（**有链接**），不是 undefined（**没链接**）
    expect(url).toBe(CHAT_URL);
    // 且确实被本地上界约束住，不是无限等待
    expect(elapsed).toBeLessThan(1000);
  });

  test("★ lookup 慢（3s）⇒ 降级 chat 级链接，不等满 3s", async () => {
    seedCard(5077);
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => {
        await sleep(3000);
        return "393";
      },
      lookupTimeoutMs: 100,
    });

    const t0 = Date.now();
    const url = await resolve(5077);
    const elapsed = Date.now() - t0;

    expect(url).toBe(CHAT_URL);
    expect(elapsed).toBeLessThan(1000);
  });

  test("★ lookup 正常快 ⇒ 拿到精确链接（常见路径精度不降）", async () => {
    seedCard(5077);
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => "393",
    });
    expect(await resolve(5077)).toBe(EXACT_URL);
  });

  test("★ 精确链接落缓存 ⇒ 第二次解析零成本命中（不再调 lookup）", async () => {
    seedCard(5077);
    let calls = 0;
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => {
        calls += 1;
        return "393";
      },
    });

    expect(await resolve(5077)).toBe(EXACT_URL);
    expect(await resolve(5077)).toBe(EXACT_URL);
    expect(calls).toBe(1);
  });

  test("★ 没有卡片记录 ⇒ undefined（不附链接，绝不编造）", async () => {
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => "393",
    });
    expect(await resolve(9999)).toBeUndefined();
  });

  test("★ 库文件不存在 ⇒ undefined", async () => {
    const resolve = createCardUrlResolver({
      dbPath: join(tmpDir, "does-not-exist.db"),
      lookupPosition: async () => "393",
    });
    expect(await resolve(5077)).toBeUndefined();
  });
});
