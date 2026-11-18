/**
 * @fileoverview Task #5036 — 提示消息嵌入「跳到任务卡片」链接 —— 纯函数 + 解析测试
 *
 * 锁定的不变量：
 *   1. 链接格式 = `{base}/client/chat/open?openChatId=<oc>&position=<N>`
 *      （飞书唯一权威格式，来自 Message API 的 `message_app_link` 字段）
 *   2. 无 position ⇒ 降级成 **chat 级**链接（`?openChatId=<oc>`），仍可跳会话
 *   3. 无 chatId / 无卡片记录 / 任何异常 ⇒ **不附链接**（零痕迹降级，绝不抛）
 *   4. 链接行插在标题行之后（用户一眼看到），不是塞到最末尾
 *   5. position = "0" / 负数 **必须保留**（飞书 API 真实返回值，PR #668 明确要求）
 */

import { describe, expect, test } from "bun:test";

import {
  FEISHU_APPLINK_BASE,
  appendCardLinkLine,
  buildCardLinkLine,
  buildCardOpenUrl,
  clearCardLinkCache,
  extractMessagePosition,
  normalizeMessagePosition,
  resolveCardLinkCached,
  resolveCardLinkForTask,
} from "./card-message-link";

const CHAT = "oc_0c4501033c8200beb51ac65d2c308ad3";
const MSG = "om_x100b61f0eb7b3cbcb0992f91e236159";

// ============================================================================
// normalizeMessagePosition
// ============================================================================

describe("normalizeMessagePosition", () => {
  test("字符串数字 → 原样（CLI 从 API 透传的就是字符串）", () => {
    expect(normalizeMessagePosition("127")).toBe("127");
  });

  test("number → 字符串", () => {
    expect(normalizeMessagePosition(9)).toBe("9");
  });

  test("★ 0 与负数必须保留（飞书真实返回值）", () => {
    expect(normalizeMessagePosition("0")).toBe("0");
    expect(normalizeMessagePosition("-1")).toBe("-1");
    expect(normalizeMessagePosition(0)).toBe("0");
    expect(normalizeMessagePosition(-3)).toBe("-3");
  });

  test("空白 / 非数字 / 非有限 → undefined", () => {
    expect(normalizeMessagePosition("")).toBeUndefined();
    expect(normalizeMessagePosition("   ")).toBeUndefined();
    expect(normalizeMessagePosition("abc")).toBeUndefined();
    expect(normalizeMessagePosition("1.5")).toBeUndefined();
    expect(normalizeMessagePosition(Number.NaN)).toBeUndefined();
    expect(normalizeMessagePosition(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeMessagePosition(null)).toBeUndefined();
    expect(normalizeMessagePosition(undefined)).toBeUndefined();
  });
});

// ============================================================================
// buildCardOpenUrl
// ============================================================================

describe("buildCardOpenUrl", () => {
  test("★ chatId + position → 消息级精确跳转链接（飞书唯一权威格式）", () => {
    const url = buildCardOpenUrl({ chatId: CHAT, position: "127" });
    expect(url).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=127`,
    );
  });

  test("无 position → chat 级链接（仍能跳到会话，不报错）", () => {
    const url = buildCardOpenUrl({ chatId: CHAT });
    expect(url).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`,
    );
    expect(url).not.toContain("position");
  });

  test("契约为空 → undefined（调用方据此不附链接）", () => {
    expect(buildCardOpenUrl({ chatId: "" })).toBeUndefined();
    expect(buildCardOpenUrl({ chatId: "   " })).toBeUndefined();
    expect(buildCardOpenUrl({})).toBeUndefined();
  });

  test("自定义 base（Lark 国际版）且尾斜杠被归一", () => {
    const url = buildCardOpenUrl({
      chatId: CHAT,
      position: "1",
      appLinkBase: "https://applink.larksuite.com/",
    });
    expect(url).toBe(
      `https://applink.larksuite.com/client/chat/open?openChatId=${CHAT}&position=1`,
    );
  });

  test("默认 base 常量就是飞书", () => {
    expect(FEISHU_APPLINK_BASE).toBe("https://applink.feishu.cn");
  });
});

// ============================================================================
// buildCardLinkLine / appendCardLinkLine
// ============================================================================

describe("buildCardLinkLine", () => {
  test("有 url → Markdown 可点击链接", () => {
    const line = buildCardLinkLine("https://x.test/a");
    expect(line).toBe("[📌 查看任务卡片](https://x.test/a)");
  });

  test("无 url → 空串（不留空行）", () => {
    expect(buildCardLinkLine(undefined)).toBe("");
    expect(buildCardLinkLine("")).toBe("");
  });
});

describe("appendCardLinkLine", () => {
  const notice =
    "✅ Task #4954「实施 P1 布局+状态栏」已完成（耗时 1h5m）\n助手随后补充交付摘要。";

  test("★ 链接插在标题行之后、帮助句之前（不是塞到末尾）", () => {
    const out = appendCardLinkLine(notice, "https://x.test/a");
    const lines = out.split("\n");
    expect(lines[0]).toContain("已完成");
    expect(lines[1]).toBe("[📌 查看任务卡片](https://x.test/a)");
    expect(lines[2]).toBe("助手随后补充交付摘要。");
  });

  test("无 url → 原样返回（零痕迹降级）", () => {
    expect(appendCardLinkLine(notice, undefined)).toBe(notice);
    expect(appendCardLinkLine(notice, "")).toBe(notice);
  });

  test("单行文案（无换行）→ 追加到末尾", () => {
    expect(appendCardLinkLine("单行", "https://x.test/a")).toBe(
      "单行\n[📌 查看任务卡片](https://x.test/a)",
    );
  });
});

// ============================================================================
// extractMessagePosition
// ============================================================================

describe("extractMessagePosition", () => {
  const payload = {
    ok: true,
    data: {
      messages: [
        {
          message_id: MSG,
          message_position: "127",
          message_app_link: `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=127`,
        },
      ],
    },
  };

  test("★ 优先取 message_app_link 里的 position（服务端算好的最权威）", () => {
    expect(extractMessagePosition(JSON.stringify(payload))).toBe("127");
  });

  test("link 与字段冲突 → 以 link 为准", () => {
    const conflicted = {
      data: {
        messages: [
          {
            message_position: "999",
            message_app_link: `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=127`,
          },
        ],
      },
    };
    expect(extractMessagePosition(conflicted)).toBe("127");
  });

  test("无 link → 落到 message_position 字段", () => {
    const onlyField = { data: { messages: [{ message_position: "42" }] } };
    expect(extractMessagePosition(onlyField)).toBe("42");
  });

  test("空 messages / 缺字段 / 非法 JSON / null → undefined（绝不抛）", () => {
    expect(extractMessagePosition({ data: { messages: [] } })).toBeUndefined();
    expect(extractMessagePosition({ data: {} })).toBeUndefined();
    expect(extractMessagePosition("not json{{")).toBeUndefined();
    expect(extractMessagePosition("")).toBeUndefined();
    expect(extractMessagePosition(null)).toBeUndefined();
    expect(extractMessagePosition(undefined)).toBeUndefined();
    expect(extractMessagePosition({ data: { messages: [{}] } })).toBeUndefined();
  });
});

// ============================================================================
// resolveCardLinkForTask
// ============================================================================

describe("resolveCardLinkForTask", () => {
  test("★ 有卡片记录 + 查到 position → 精确消息级链接", async () => {
    const url = await resolveCardLinkForTask(5036, {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: async () => "127",
    });
    expect(url).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=127`,
    );
  });

  test("★ 有卡片记录但 position 查不到 → 降级 chat 级链接（不返回 undefined）", async () => {
    const url = await resolveCardLinkForTask(5036, {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: async () => undefined,
    });
    expect(url).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`,
    );
  });

  test("★ 无卡片记录 → undefined（优雅降级不附链接）", async () => {
    const url = await resolveCardLinkForTask(5036, {
      getCardRecord: () => undefined,
      lookupPosition: async () => "127",
    });
    expect(url).toBeUndefined();
  });

  test("记录缺 chatId → undefined", async () => {
    const url = await resolveCardLinkForTask(5036, {
      getCardRecord: () => ({ messageId: MSG }),
    });
    expect(url).toBeUndefined();
  });

  test("有 chatId 但无 messageId → 直接 chat 级（不查 position，省一次子进程）", async () => {
    let looked = false;
    const url = await resolveCardLinkForTask(5036, {
      getCardRecord: () => ({ chatId: CHAT }),
      lookupPosition: async () => {
        looked = true;
        return "127";
      },
    });
    expect(url).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`,
    );
    expect(looked).toBe(false);
  });

  test("★ getCardRecord 抛异常（sqlite 故障）→ undefined，绝不 reject", async () => {
    const url = await resolveCardLinkForTask(5036, {
      getCardRecord: () => {
        throw new Error("SQLITE_BUSY");
      },
    });
    expect(url).toBeUndefined();
  });

  test("★ lookupPosition 抛异常 → 降级 chat 级链接，绝不 reject", async () => {
    const url = await resolveCardLinkForTask(5036, {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: async () => {
        throw new Error("lark-cli timed out");
      },
    });
    expect(url).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`,
    );
  });

  test("非法 taskId（≤0 / NaN）→ undefined", async () => {
    expect(await resolveCardLinkForTask(0, { getCardRecord: () => ({ chatId: CHAT }) })).toBeUndefined();
    expect(await resolveCardLinkForTask(-5, { getCardRecord: () => ({ chatId: CHAT }) })).toBeUndefined();
    expect(await resolveCardLinkForTask(Number.NaN, { getCardRecord: () => ({ chatId: CHAT }) })).toBeUndefined();
  });

  test("未注入 getCardRecord → undefined（默认不查真实库）", async () => {
    expect(await resolveCardLinkForTask(5036, {})).toBeUndefined();
  });
});

// ============================================================================
// resolveCardLinkCached
// ============================================================================

describe("resolveCardLinkCached", () => {
  test("★ 同一 taskId 第二次命中缓存（只查一次 position）", async () => {
    clearCardLinkCache();
    let calls = 0;
    const deps = {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: async () => {
        calls += 1;
        return "127";
      },
    };
    const first = await resolveCardLinkCached(9001, deps);
    const second = await resolveCardLinkCached(9001, deps);
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  test("失败结果不入缓存（下次还会重试）", async () => {
    clearCardLinkCache();
    let calls = 0;
    const deps = {
      getCardRecord: () => undefined,
      lookupPosition: async () => {
        calls += 1;
        return "1";
      },
    };
    await resolveCardLinkCached(9002, deps);
    await resolveCardLinkCached(9002, deps);
    expect(calls).toBe(0); // 无记录 ⇒ 连 position 都不查
  });

  test("clearCardLinkCache 让请求重新走一次", async () => {
    clearCardLinkCache();
    let calls = 0;
    const deps = {
      getCardRecord: () => ({ messageId: MSG, chatId: CHAT }),
      lookupPosition: async () => {
        calls += 1;
        return "127";
      },
    };
    await resolveCardLinkCached(9003, deps);
    clearCardLinkCache();
    await resolveCardLinkCached(9003, deps);
    expect(calls).toBe(2);
  });
});

// ============================================================================
// DS review m6：position "0" / 负数 的端到端 URL 断言
// ============================================================================

describe("buildCardOpenUrl — position 边界端到端（DS review m6）", () => {
  test("★ position='0' 真的产出一个带 position=0 的 URL（会被 URLSearchParams 吃掉吗？）", () => {
    const url = buildCardOpenUrl({ chatId: CHAT, position: "0" });
    expect(url).toBe(
      `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=0`,
    );
    // 关键：解析回来必须还能拿到 "0"（不是被判空/丢弃）
    expect(new URL(url!).searchParams.get("position")).toBe("0");
  });

  test("★ position='-1' 端到端保留负号", () => {
    const url = buildCardOpenUrl({ chatId: CHAT, position: "-1" });
    expect(new URL(url!).searchParams.get("position")).toBe("-1");
  });
});
