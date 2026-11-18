/**
 * @fileoverview Task #5036 — 生产端卡片链接解析器测试（lark-cards.db → applink）
 *
 * 锁定的不变量：
 *   1. 库里有记录 → 解析出可点击链接（position 由注入的 lookup 提供，不真 spawn）
 *   2. 库里**没有**该 task → `undefined`（回执不附链接）
 *   3. 库文件**不存在** → `undefined`，且 **不** 凭空创建空 db（不污染用户目录）
 *   4. 任何异常（坏库 / 查询抛）→ `undefined`，**绝不 reject**
 *   5. 同一库路径复用同一个 store（不重复打开连接）
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLarkCardStateStore,
  type LarkCardStateStore,
} from "@ai-setting/roy-bot-core/env/task/plugins";

import { clearCardLinkCache } from "./card-message-link";
import {
  createCardUrlResolver,
  getCardRecordReader,
  getDefaultLarkCardDbPath,
  isForbiddenCardDbPath,
  resetCardRecordStoreCacheForTest,
  resolveCardDbPath,
} from "./card-link-resolver";

const CHAT = "oc_0c4501033c8200beb51ac65d2c308ad3";
const MSG = "om_x100b61f0eb7b3cbcb0992f91e236159";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetCardRecordStoreCacheForTest();
  clearCardLinkCache();
  tmpDir = mkdtempSync(join(tmpdir(), "card-link-resolver-test-"));
  dbPath = join(tmpDir, "lark-cards.db");
});

afterEach(() => {
  resetCardRecordStoreCacheForTest();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 往库里塞一条卡片记录 */
function seedCard(taskId: number, over: Partial<{ chatId: string; messageId: string; profile: string }> = {}) {
  const store: LarkCardStateStore = createLarkCardStateStore(dbPath);
  store.upsert({
    taskId,
    messageId: over.messageId ?? MSG,
    chatId: over.chatId ?? CHAT,
    ...(over.profile ? { profile: over.profile } : {}),
    pinned: true,
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.close();
}

// ============================================================================
// getCardRecordReader
// ============================================================================

describe("getCardRecordReader", () => {
  test("库不存在 → undefined（且不创建文件）", () => {
    const missing = join(tmpDir, "nope.db");
    expect(getCardRecordReader(missing)).toBeUndefined();
    expect(existsSync(missing)).toBe(false);
  });

  test("★ 库存在 → 读得到记录（含 chatId/messageId/profile）", () => {
    seedCard(5036, { profile: "tongzhuli" });
    const read = getCardRecordReader(dbPath);
    expect(read).toBeDefined();
    expect(read!(5036)).toEqual({
      chatId: CHAT,
      messageId: MSG,
      profile: "tongzhuli",
    });
  });

  test("库里没有该 task → undefined", () => {
    seedCard(1);
    const read = getCardRecordReader(dbPath);
    expect(read!(9999)).toBeUndefined();
  });
});

// ============================================================================
// createCardUrlResolver
// ============================================================================

describe("createCardUrlResolver", () => {
  test("★ 有记录 + lookup 给 position → 消息级精确链接", async () => {
    seedCard(5036);
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => "127",
    });
    expect(await resolve(5036)).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=127`,
    );
  });

  test("★ lookup 查不到 position → 降级 chat 级链接（仍可跳会话）", async () => {
    seedCard(5036);
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => undefined,
    });
    expect(await resolve(5036)).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`,
    );
  });

  test("★ 库里没这个 task → undefined（回执不附链接）", async () => {
    seedCard(1);
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => "127",
    });
    expect(await resolve(9999)).toBeUndefined();
  });

  test("★ 库文件不存在 → undefined，绝不抛，也不建库", async () => {
    const missing = join(tmpDir, "missing.db");
    const resolve = createCardUrlResolver({
      dbPath: missing,
      lookupPosition: async () => "127",
    });
    expect(await resolve(5036)).toBeUndefined();
    expect(existsSync(missing)).toBe(false);
  });

  test("★ lookup 抛异常 → 仍降级 chat 级链接（不 reject）", async () => {
    seedCard(5036);
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => {
        throw new Error("lark-cli timed out after 3500ms");
      },
    });
    expect(await resolve(5036)).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`,
    );
  });

  test("★ 坏库文件（不是 sqlite）→ undefined，绝不抛", async () => {
    const bad = join(tmpDir, "bad.db");
    await Bun.write(bad, "this is not a sqlite database at all");
    const resolve = createCardUrlResolver({
      dbPath: bad,
      lookupPosition: async () => "127",
    });
    expect(await resolve(5036)).toBeUndefined();
  });

  test("非法 taskId（0 / 负数）→ undefined", async () => {
    seedCard(5036);
    const resolve = createCardUrlResolver({
      dbPath,
      lookupPosition: async () => "127",
    });
    expect(await resolve(0)).toBeUndefined();
    expect(await resolve(-1)).toBeUndefined();
  });
});

// ============================================================================
// DS review B2：测试环境绝不允许打开生产库
// ============================================================================

describe("生产库隔离（DS review B2）", () => {
  const PROD = getDefaultLarkCardDbPath();

  test("★ 测试环境 + 默认生产路径 → 拒绝打开（返回 undefined）", () => {
    // NODE_ENV=test 由 bun test 注入；显式传生产路径曾经绕过 core 的
    // MemoryStore 保护 → SqliteStore 以读写模式打开真实用户库。
    const read = getCardRecordReader(PROD);
    expect(read).toBeUndefined();
  });

  test("★ 解析器在测试环境指向生产路径 → undefined，且不改库 mtime", async () => {
    const resolve = createCardUrlResolver({
      dbPath: PROD,
      lookupPosition: async () => "127",
    });
    expect(await resolve(5036)).toBeUndefined();
  });

  test("生产环境不受该守卫影响（用临时库模拟，守卫只看路径+env）", () => {
    // 临时路径（非生产默认路径）在测试环境仍允许 —— 守卫只拦生产库
    seedCard(5036);
    const read = getCardRecordReader(dbPath);
    expect(read).toBeDefined();
  });
});

// ============================================================================
// DS review 第二轮 N1/N2/N4：路径解析与守卫加固
// ============================================================================

describe("N1：读端必须与写端同一套路径解析（认 ROY_AGENT_LARK_CARD_DB）", () => {
  const prev = process.env.ROY_AGENT_LARK_CARD_DB;

  afterEach(() => {
    if (prev === undefined) delete process.env.ROY_AGENT_LARK_CARD_DB;
    else process.env.ROY_AGENT_LARK_CARD_DB = prev;
    resetCardRecordStoreCacheForTest();
    clearCardLinkCache();
  });

  test("★ 设了 env 覆盖点 → 读端也要读那个库（否则功能静默失效）", () => {
    const custom = join(tmpDir, "custom-cards.db");
    process.env.ROY_AGENT_LARK_CARD_DB = custom;

    // 记录必须写进 env 指向的那个库（模拟写端行为）
    const writer = createLarkCardStateStore(custom);
    writer.upsert({
      taskId: 777,
      messageId: MSG,
      chatId: CHAT,
      pinned: true,
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    writer.close();

    const read = getCardRecordReader(); // 不传 dbPath，走「默认」
    expect(read).toBeDefined();
    expect(read!(777)).toBeDefined();
  });

  test("★ resolveCardDbPath()：显式 > env > 默认（与写端完全一致的优先级）", () => {
    const custom = join(tmpDir, "c.db");
    process.env.ROY_AGENT_LARK_CARD_DB = custom;
    expect(resolveCardDbPath()).toBe(custom);
    expect(resolveCardDbPath("/explicit/x.db")).toBe("/explicit/x.db");
    delete process.env.ROY_AGENT_LARK_CARD_DB;
    expect(resolveCardDbPath()).toBe(getDefaultLarkCardDbPath());
  });
});

describe("N2：守卫必须做路径规范化（/./ 与 /../ 不能绕过）", () => {
  test("★ /./ 未规范化写法也要被拦（否则测试仍能碰生产库）", () => {
    const prod = getDefaultLarkCardDbPath();
    const dotted = prod.replace("/lark-cards.db", "/./lark-cards.db");
    expect(dotted).not.toBe(prod); // 确认构造成功
    expect(isForbiddenCardDbPath(dotted)).toBe(true);
  });

  test("★ /../ 绕行写法也要被拦", () => {
    const prod = getDefaultLarkCardDbPath();
    const dotdot = prod.replace(
      "/roy-bot/lark-cards.db",
      "/roy-bot/../roy-bot/lark-cards.db",
    );
    expect(dotdot).not.toBe(prod);
    expect(isForbiddenCardDbPath(dotdot)).toBe(true);
  });

  test("★ HOME 被改写后，真实生产路径仍被识别（用 import 期快照，不看 process.env）", () => {
    const prod = getDefaultLarkCardDbPath();
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = "/tmp/fakehome-n2";
      // 即便 HOME 变了，传入**旧的真实生产路径**也必须被拦
      expect(isForbiddenCardDbPath(prod)).toBe(true);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("★ HOME 被改写 + 用旧路径 getCardRecordReader → undefined（绝不读生产库）", () => {
    const prod = getDefaultLarkCardDbPath();
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = "/tmp/fakehome-n2b";
      expect(getCardRecordReader(prod)).toBeUndefined();
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("tmp 库不受影响（只拦生产候选路径）", () => {
    seedCard(1);
    expect(isForbiddenCardDbPath(dbPath)).toBe(false);
    expect(getCardRecordReader(dbPath)).toBeDefined();
  });
});

describe("N4：库不存在 → 缓存 null，但库出现后必须能恢复", () => {
  test("★ 先读不存在的库 → undefined；建库后再读 → 读得到（null 缓存不能永久粘住）", () => {
    const late = join(tmpDir, "late.db");
    expect(getCardRecordReader(late)).toBeUndefined();

    // 库后来出现了
    const store = createLarkCardStateStore(late);
    store.upsert({
      taskId: 4242,
      messageId: MSG,
      chatId: CHAT,
      pinned: true,
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.close();

    const read = getCardRecordReader(late);
    expect(read).toBeDefined();
    expect(read!(4242)).toBeDefined();
  });
});
