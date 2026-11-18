/**
 * @fileoverview Task #5360 —— 企微 session 卡发送器单测
 *
 * 用户明令「企微也是这个逻辑哈」，且前几轮的教训是：
 * **代码写了但没接线 ⇒ 单测假绿**。
 *
 * 所以本文件既测「sender 本身的逻辑」，也测「渠道判定两个方向」
 * （企微事件发、飞书事件**不**发）。
 */

import { describe, test, expect } from "bun:test";
import type { EnvEvent } from "../types";
import {
  createWecomSessionCardSender,
  parseWecomSessionCardPayload,
  resolveWecomSessionCardTarget,
} from "./wecom-session-card-sender";
import {
  ROY_SESSION_PREFIX,
  WecomCardActionKey,
} from "./wecom-card-builder";

const SESSION_ID = "session_wecom_04357c17";
const SOURCE_ID = "wecom-bot-1";
const USER_ID = "dzk_wecom_userid";

function ev(
  over: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
): EnvEvent {
  return {
    id: "evt-wecom-1",
    type: "task.background.session_started",
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "process_1",
      subSessionId: SESSION_ID,
      parentSessionId: "parent-1",
      description: "调研 airport 本体生成",
      subagentType: "roy",
      lifecycle: "running",
      ...over,
    },
    metadata: {
      source: "task.background",
      sourceId: SOURCE_ID,
      replyChannel: {
        type: "wecom-cli",
        chatId: USER_ID,
        params: { chatType: "single", sourceId: SOURCE_ID },
      },
      ...meta,
    },
  } as unknown as EnvEvent;
}

// ============================================================================
// 1. 目标解析（含渠道判定两个方向）
// ============================================================================

describe("resolveWecomSessionCardTarget", () => {
  test("★ 企微单聊事件 → 解析出 sourceId + chatId + chatType=single", () => {
    const t = resolveWecomSessionCardTarget(ev());
    expect(t).toEqual({
      sourceId: SOURCE_ID,
      chatId: USER_ID,
      chatType: "single",
    });
  });

  test("★ 企微群聊（params.chatType=group）→ group", () => {
    const t = resolveWecomSessionCardTarget(
      ev({}, {
        replyChannel: {
          type: "wecom-cli",
          chatId: "wecom_group_chatid",
          params: { chatType: "group", sourceId: SOURCE_ID },
        },
      }),
    );
    expect(t?.chatType).toBe("group");
  });

  test("★ 有 wecomChatId 视为群聊（params.chatType 缺省时）", () => {
    const t = resolveWecomSessionCardTarget(
      ev({}, {
        replyChannel: {
          type: "wecom-cli",
          chatId: "wecom_group_chatid",
          params: { wecomChatId: "wecom_group_chatid", sourceId: SOURCE_ID },
        },
      }),
    );
    expect(t?.chatType).toBe("group");
  });

  test("★ 飞书事件（type=lark-cli）→ undefined（绝不发到企微）", () => {
    const t = resolveWecomSessionCardTarget(
      ev({}, {
        replyChannel: { type: "lark-cli", chatId: "oc_feishu_chat" },
      }),
    );
    expect(t).toBeUndefined();
  });

  test("★ 无 replyChannel.type → undefined（判不出渠道就丢弃，不猜）", () => {
    expect(
      resolveWecomSessionCardTarget(
        ev({}, { replyChannel: { chatId: USER_ID } }),
      ),
    ).toBeUndefined();
  });

  test("缺 chatId / 缺 sourceId → undefined", () => {
    expect(
      resolveWecomSessionCardTarget(
        ev({}, { replyChannel: { type: "wecom-cli", params: { sourceId: SOURCE_ID } } }),
      ),
    ).toBeUndefined();
    expect(
      resolveWecomSessionCardTarget(
        ev({ sourceId: undefined }, {
          sourceId: undefined,
          replyChannel: { type: "wecom-cli", chatId: USER_ID, params: {} },
        }),
      ),
    ).toBeUndefined();
  });
});

// ============================================================================
// 2. payload 解析
// ============================================================================

describe("parseWecomSessionCardPayload", () => {
  test("正常 payload → sessionId + lifecycle + title + agent", () => {
    const p = parseWecomSessionCardPayload(ev());
    expect(p?.sessionId).toBe(SESSION_ID);
    expect(p?.lifecycle).toBe("running");
    expect(p?.title).toBe("调研 airport 本体生成");
    expect(p?.agentType).toBe("roy");
  });

  test("★ 缺 subSessionId → undefined（没有主键）", () => {
    expect(parseWecomSessionCardPayload(ev({ subSessionId: undefined }))).toBeUndefined();
    expect(parseWecomSessionCardPayload(ev({ subSessionId: "  " }))).toBeUndefined();
  });

  test("★ lifecycle 非法/缺失 → running（乐观，不凭空宣布结束）", () => {
    expect(parseWecomSessionCardPayload(ev({ lifecycle: "bogus" }))?.lifecycle).toBe(
      "running",
    );
    expect(parseWecomSessionCardPayload(ev({ lifecycle: undefined }))?.lifecycle).toBe(
      "running",
    );
  });

  test("五种合法 lifecycle 都透传", () => {
    for (const l of ["running", "completed", "timeout", "failed", "stopped"]) {
      expect(parseWecomSessionCardPayload(ev({ lifecycle: l }))?.lifecycle).toBe(l);
    }
  });
});

// ============================================================================
// 3. sender：真的发 & 卡片内容正确
// ============================================================================

describe("createWecomSessionCardSender", () => {
  test("★ 企微事件 → 调 sendCard 一次，卡片用 roy-session- 主键 + 刷新活性按钮", async () => {
    const calls: any[] = [];
    const send = createWecomSessionCardSender({
      sendCard: async (input) => {
        calls.push(input);
        return { ok: true };
      },
    });

    await send(ev());

    expect(calls).toHaveLength(1);
    expect(calls[0].sourceId).toBe(SOURCE_ID);
    expect(calls[0].chatId).toBe(USER_ID);
    expect(calls[0].chatType).toBe("single");
    expect(calls[0].sessionId).toBe(SESSION_ID);

    const card = calls[0].card;
    expect(card.task_id.startsWith(ROY_SESSION_PREFIX)).toBe(true);
    expect(card.button_list[0].key).toBe(WecomCardActionKey.REFRESH_ACTIVITY);
  });

  test("★ 飞书事件 → **不调** sendCard（渠道 guard 双向）", async () => {
    let called = 0;
    const send = createWecomSessionCardSender({
      sendCard: async () => {
        called++;
        return { ok: true };
      },
    });

    await send(
      ev({}, { replyChannel: { type: "lark-cli", chatId: "oc_feishu" } }),
    );
    expect(called).toBe(0);
  });

  test("★ 终态事件 → 卡片带「已完成」文案", async () => {
    const calls: any[] = [];
    const send = createWecomSessionCardSender({
      sendCard: async (i) => {
        calls.push(i);
        return { ok: true };
      },
    });
    await send(ev({ lifecycle: "completed" }));
    expect(JSON.stringify(calls[0].card)).toContain("已完成");
  });

  test("★ 超时 → 「已超时」（区分终态种类，不都压成已完成）", async () => {
    const calls: any[] = [];
    const send = createWecomSessionCardSender({
      sendCard: async (i) => {
        calls.push(i);
        return { ok: true };
      },
    });
    await send(ev({ lifecycle: "timeout" }));
    expect(JSON.stringify(calls[0].card)).toContain("已超时");
  });

  test("★ 端口未注入 → 丢弃，不抛", async () => {
    const send = createWecomSessionCardSender({});
    await expect(send(ev())).resolves.toBeUndefined();
  });

  test("★ sendCard 抛错 → 吞掉（fire-and-forget，不污染事件循环）", async () => {
    const warns: string[] = [];
    const send = createWecomSessionCardSender({
      sendCard: async () => {
        throw new Error("ws down");
      },
      warn: (m) => warns.push(m),
    });
    await expect(send(ev())).resolves.toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  });

  test("★ sendCard 返回 ok:false → warn，不抛", async () => {
    const warns: string[] = [];
    const send = createWecomSessionCardSender({
      sendCard: async () => ({ ok: false, error: "11011 invalid chatid" }),
      warn: (m) => warns.push(m),
    });
    await expect(send(ev())).resolves.toBeUndefined();
    expect(warns.join(" ")).toContain("11011");
  });

  test("缺 sessionId → 不发", async () => {
    let called = 0;
    const send = createWecomSessionCardSender({
      sendCard: async () => {
        called++;
        return { ok: true };
      },
    });
    await send(ev({ subSessionId: undefined }));
    expect(called).toBe(0);
  });
});