/**
 * @fileoverview Task #4552 (A1 BLOCKING) — 自我回声过滤（纯判定层）
 *
 * ## 缺陷背景（真实 E2E 实测，本机报告 reports/4552-a1-real-e2e.md §6；reports/ 被 gitignore，未入库）
 *
 * A1 的 telemetry 提示最初用 `lark-cli im +messages-send`（**不带** `--as bot`）
 * 发出，默认身份是 **user（开发者本人）**。而 `im.message.receive_v1` 只关心
 * 「是不是 user 发的消息」→ 这条提示被同一个 lark-cli consumer 当作用户消息
 * **回灌**，又跑一次完整 agent run（188 spans）。实测 11 条事件里 5 条是回灌。
 *
 * 主修是给直发补 `--as bot`（见 telemetry-notice.test.ts）。本文件锁定
 * **防御纵深**：即使将来某条出站路径又忘了 `--as bot`、或另一 app 的 bot
 * 与我们在同群互相回灌，EventHandler 也要能识别「这条是我方 bot 发的」
 * 并丢弃，而不是当成用户消息跑 agent。
 *
 * ## 真实事件形态（证据取自 event-store.db 的 raw_event）
 *
 * lark-cli `event consume` 吐的是**简化格式**，`sender_type` 在**顶层**：
 *
 * ```json
 * { "event_id": "...", "message_id": "om_x...", "chat_id": "oc_...",
 *   "sender_id": "ou_...", "sender_type": "user", "message_type": "post",
 *   "content": "🔔 ..." }
 * ```
 *
 * 飞书 chat-messages-list 里 bot 发的消息则是：
 * `sender: { id: "cli_xxx", id_type: "app_id", sender_type: "app", open_bot_id: "ou_..." }`
 *
 * 所以判定必须**同时**覆盖 `bot` / `app` 两种取值，并且兼容嵌套格式。
 *
 * ## 铁律：不能误伤真实用户消息（goals §2 明确要求）
 *
 * 真实用户消息 `sender_type=user` + 非我方 bot 的 senderId → **必须放行**。
 * 见本文件「回归护栏」组。
 */

import { describe, test, expect } from "bun:test";
import {
  SELF_ECHO_FILTER_ENABLED_ENV,
  extractChatKind,
  extractMentionIds,
  extractSenderIdentity,
  isSelfEchoEvent,
  readSelfEchoFilterEnabled,
} from "./self-echo-filter";

// ============================================================================
// Helpers —— 还原真实事件形态
// ============================================================================

const CHAT = "oc_e0bdaa5381ede5378e225bbec8d727f3";
const USER_OPEN_ID = "ou_b9924f48dc122c3dad0ff4f37851c09b";
const BOT_APP_ID = "cli_aXXXXXXXXXXXXXX";
const BOT_OPEN_ID = "ou_70b460648c0fec2fb260757ee9a6a38f";

/**
 * 真实 lark-cli consume 简化格式（`sender_type` 在顶层）。
 *
 * 这正是 event-store.db 里 raw_event 的形状（E2E 证据）。
 */
function simplifiedLarkEvent(raw: Record<string, unknown> = {}): any {
  return {
    id: `es-e2e4552_a1test-${Date.now()}`,
    type: "event-source.event.lark-cli",
    timestamp: Date.now(),
    metadata: {
      source: "event-source",
      sourceId: "id_e2e4552_a1test",
      sourceMessageType: "im.message.receive_v1",
      replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_x", profile: "default" },
    },
    payload: {
      sourceId: "id_e2e4552_a1test",
      sourceType: "lark-cli",
      rawEvent: {
        type: "im.message.receive_v1",
        event_id: "0a4c366e20b9f1c6cfbf20c60dfddd73",
        message_id: "om_x100b62c7ff2f6ca4b070d56e9200176",
        chat_id: CHAT,
        message_type: "post",
        sender_id: USER_OPEN_ID,
        sender_type: "user",
        content: "🔔 process_x「probe」已启动",
        ...raw,
      },
    },
  };
}

/** 嵌套格式：`event.sender.sender_type`（飞书原始 webhook 形状） */
function nestedLarkEvent(sender: Record<string, unknown>): any {
  return {
    id: "es-nested",
    type: "event-source.event.lark-cli",
    timestamp: Date.now(),
    metadata: { source: "event-source", sourceId: "src" },
    payload: {
      rawEvent: {
        event: {
          message: { message_id: "om_nested", chat_id: CHAT },
          sender,
        },
      },
    },
  };
}

// ============================================================================
// 1. extractSenderIdentity —— 从任意格式里把发送者身份挖出来
// ============================================================================

describe("Task #4552 A1-BLOCKING — extractSenderIdentity", () => {
  test("简化格式：顶层 sender_type / sender_id", () => {
    const id = extractSenderIdentity(simplifiedLarkEvent());
    expect(id.senderType).toBe("user");
    expect(id.senderId).toBe(USER_OPEN_ID);
  });

  test("嵌套格式：event.sender.sender_type + sender_id.open_id", () => {
    const id = extractSenderIdentity(
      nestedLarkEvent({
        sender_id: { open_id: BOT_OPEN_ID, union_id: "on_x" },
        sender_type: "app",
      }),
    );
    expect(id.senderType).toBe("app");
    expect(id.senderId).toBe(BOT_OPEN_ID);
  });

  test("metadata.senderType 优先（新事件在 ES 层已提取）", () => {
    const evt = simplifiedLarkEvent({ sender_type: "user" });
    evt.metadata.senderType = "app";
    expect(extractSenderIdentity(evt).senderType).toBe("app");
  });

  test("payload.metadata.senderType 也可读（EventSourceEvent 的标准位置）", () => {
    const evt = simplifiedLarkEvent();
    delete evt.payload.rawEvent.sender_type;
    evt.payload.metadata = { senderType: "app", senderId: BOT_APP_ID };
    const id = extractSenderIdentity(evt);
    expect(id.senderType).toBe("app");
    expect(id.senderId).toBe(BOT_APP_ID);
  });

  test("内部事件（task.background.*）无发送者信息 → 全 undefined", () => {
    const id = extractSenderIdentity({
      id: "evt-progress",
      type: "task.background.progress",
      timestamp: Date.now(),
      metadata: { source: "task.background" },
      payload: { backgroundTaskId: "bg-1" },
    } as any);
    expect(id.senderType).toBeUndefined();
    expect(id.senderId).toBeUndefined();
  });
});

// ============================================================================
// 2. isSelfEchoEvent —— 判定「这条是 bot/自己 发的，不能当用户消息处理」
// ============================================================================

describe("Task #4552 A1-BLOCKING — isSelfEchoEvent 必须拦住的形态", () => {
  test("sender_type=app（飞书 bot 消息的真实取值）→ skip", () => {
    const v = isSelfEchoEvent(simplifiedLarkEvent({ sender_type: "app" }));
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("bot-sender");
    expect(v.senderType).toBe("app");
  });

  test("sender_type=bot（另一种常见取值）→ skip", () => {
    const v = isSelfEchoEvent(simplifiedLarkEvent({ sender_type: "bot" }));
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("bot-sender");
  });

  test("大小写不敏感：APP / Bot → skip", () => {
    expect(isSelfEchoEvent(simplifiedLarkEvent({ sender_type: "APP" })).skip).toBe(true);
    expect(isSelfEchoEvent(simplifiedLarkEvent({ sender_type: "Bot" })).skip).toBe(true);
  });

  test("嵌套格式的 app sender → skip", () => {
    const v = isSelfEchoEvent(
      nestedLarkEvent({ sender_id: { open_id: BOT_OPEN_ID }, sender_type: "app" }),
    );
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("bot-sender");
  });

  test("sender_type 缺失但 senderId == 我方 bot 身份 → skip（兜底）", () => {
    const evt = simplifiedLarkEvent({ sender_id: BOT_APP_ID });
    delete evt.payload.rawEvent.sender_type;

    const v = isSelfEchoEvent(evt, { selfBotIds: [BOT_APP_ID] });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("self-bot-id");
    expect(v.senderId).toBe(BOT_APP_ID);
  });

  test("sender_type=user 但 senderId 命中我方 bot open_id → 仍然 skip（防伪 user 回声）", () => {
    // 这是关键防御：将来若某条出站路径又忘了 --as bot 但用了 bot 的 open_id，
    // 或者飞书把 bot 消息的 sender_type 报成 user，也不能当用户消息处理。
    const v = isSelfEchoEvent(simplifiedLarkEvent({ sender_id: BOT_OPEN_ID }), {
      selfBotIds: [BOT_OPEN_ID],
    });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("self-bot-id");
  });
});

// ============================================================================
// 3. 回归护栏 —— 真实用户消息绝不能被误伤
// ============================================================================

describe("Task #4552 A1-BLOCKING — 真实用户消息必须放行（回归护栏）", () => {
  test("sender_type=user + 普通用户 open_id → 不 skip", () => {
    const v = isSelfEchoEvent(simplifiedLarkEvent(), { selfBotIds: [BOT_APP_ID] });
    expect(v.skip).toBe(false);
    expect(v.reason).toBeUndefined();
    expect(v.senderType).toBe("user");
    expect(v.senderId).toBe(USER_OPEN_ID);
  });

  test("用户消息内容看起来像 telemetry 提示（🔔/🔄 前缀）→ 仍然放行（不按文案过滤）", () => {
    // 为什么专门测这个：用文案前缀过滤是错误做法 —— 用户完全可能
    // 手打一条「🔔 这是什么意思」。只能按 sender 身份判定。
    const v = isSelfEchoEvent(
      simplifiedLarkEvent({ content: "🔔 这是我自己打的，你要回我", sender_type: "user" }),
    );
    expect(v.skip).toBe(false);
  });

  test("缺 sender_type 且 senderId 不在 selfBotIds → 放行（信息不足时不错杀）", () => {
    const evt = simplifiedLarkEvent({ sender_id: "ou_unknown_user" });
    delete evt.payload.rawEvent.sender_type;
    const v = isSelfEchoEvent(evt, { selfBotIds: [BOT_APP_ID] });
    expect(v.skip).toBe(false);
  });

  test("内部事件（task.background.* / 终态）→ 不 skip（它们没有 sender）", () => {
    for (const type of [
      "task.background.started",
      "task.background.progress",
      "task.background.completed",
      "task.background.failed",
      "task.background.timeout",
      "task.background.stopped",
      "task.background.ask_user",
    ]) {
      const v = isSelfEchoEvent({
        id: `evt-${type}`,
        type,
        timestamp: Date.now(),
        metadata: { source: "task.background" },
        payload: { backgroundTaskId: "bg-1" },
      } as any);
      expect(v.skip).toBe(false);
    }
  });

  test("enabled=false → 全放行（运行时可回滚，不需改代码）", () => {
    expect(
      isSelfEchoEvent(simplifiedLarkEvent({ sender_type: "app" }), { enabled: false }).skip,
    ).toBe(false);
    expect(
      isSelfEchoEvent(simplifiedLarkEvent({ sender_type: "app" }), { enabled: false }).reason,
    ).toBe("disabled");
  });
});

// ============================================================================
// 4. 软回滚开关（`ROY_AGENT_SELF_ECHO_FILTER`）
// ============================================================================
//
// 交叉验证（claude-minimax）指出：生产路径用的是
// `EventHandler.selfEchoFilter.enabled = readSelfEchoFilterEnabled()`，
// 而此前**只有** `isSelfEchoEvent(ev, {enabled:false})` 被测过 ——
// 那个分支生产上根本不会被走到。这组测试补上**真正生效**的那条路径。

describe("Task #4552 A1-BLOCKING — 软回滚开关 readSelfEchoFilterEnabled", () => {
  test("未设置 / 空串 → 开启（默认防护）", () => {
    expect(readSelfEchoFilterEnabled({})).toBe(true);
    expect(readSelfEchoFilterEnabled({ [SELF_ECHO_FILTER_ENABLED_ENV]: "" })).toBe(true);
  });

  test("显式关闭值 → false（0 / false / off / no，大小写与空格不敏感）", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", "Off", "  no  "]) {
      expect(readSelfEchoFilterEnabled({ [SELF_ECHO_FILTER_ENABLED_ENV]: v })).toBe(false);
    }
  });

  test("其它任意值（1/true/yes/on/垃圾）→ 保持开启（白名单式关闭，防误关）", () => {
    for (const v of ["1", "true", "yes", "on", "enabled", "garbage", " "]) {
      expect(readSelfEchoFilterEnabled({ [SELF_ECHO_FILTER_ENABLED_ENV]: v })).toBe(true);
    }
  });

  test("env 变量名稳定（运维文档/runbook 依赖它）", () => {
    expect(SELF_ECHO_FILTER_ENABLED_ENV).toBe("ROY_AGENT_SELF_ECHO_FILTER");
  });
});

// ============================================================================
// ============================================================================
// 5. Task #5459 —— 群聊里「别的 bot @ 我」必须放行（修误杀）
// ============================================================================
//
// ## 误杀现场（用户报障，2026-11-13）
//
// `[EventHandler] self-echo event dropped (reason=bot-sender, senderType=bot,
//  senderId=ou_71223466e5ae5555ae21296fbf06fe4e, type=event-source.event.lark-cli)`
//
// 场景：群里 roy 智能体 A（tongzhuli bot）@ 另一个 roy 智能体 B（gonglin bot）。
// B 的 consumer 收到这条 `sender_type=bot` 的消息 → 被当 self-echo 丢弃
// → 协作消息永远送不到 B 的 agent。
//
// ## 收紧后的判据（顺序即优先级）
//
// 第 0 步（前提）：`senderId ∈ selfBotIds` → **一定是回声，丢弃**。
//   ← 这是防「自己发的东西回灌」+ 「A/B 两个 bot 互相 @ 形成无限循环」的闸门。
//   生产必须注入 selfBotIds（否则群聊每个 bot 消息都被当"协作消息"放行，
//   自循环会放大）。见 event-handler-wiring 的注入。
//
// 1. 群聊（`chat_type=group`）+ `senderType ∈ {bot,app}` → **放行**。
//    ★ 关键语义：门禁在**接收方**跑。别的 bot 在群里发的消息，对本方来说
//    要么是 @ 了我（协作入站，必须处理），要么是跟别人说话（也不该我处理，
//    但丢弃它没有任何收益 —— 后者进 lane 后 agent 自己会判断无关）。
//    **不能**用「@ 的是自己还是别人」来决定丢弃：@ 自己的恰恰必须放行。
// 2. 私聊（`p2p`）bot 消息 → 仍然丢弃（bot 对 bot 私聊无合法业务）。
// 3. 群聊但 chat_type 未知 / 缺失 → 保守丢弃（不因信息不足而放行回声）。
//
// 铁律不变：绝不按文案前缀过滤。

const OTHER_BOT_OPEN_ID = "ou_71223466e5ae5555ae21296fbf06fe4e";
const OTHER_BOT_APP_ID = "cli_aXXXXXXXXXXXXXX";
const SELF_BOT_OPEN_ID = "ou_745dd5b0549250479aefe045c50a8fec";
const SELF_APP_ID = "cli_aXXXXXXXXXXXXXX";
const COLLAB_GROUP = "oc_a5314122eb58609bbf724745bea02a49";

/** 构造群聊 bot 消息（带 mentions / chat_type），还原真实 consume 形态 */
function groupBotEvent(
  mentionIds: readonly string[],
  raw: Record<string, unknown> = {},
): any {
  return simplifiedLarkEvent({
    chat_id: COLLAB_GROUP,
    chat_type: "group",
    sender_type: "bot",
    sender_id: OTHER_BOT_OPEN_ID,
    mentions: mentionIds.map((id, i) => ({ key: `@_user_${i + 1}`, id, name: `m${i}` })),
    ...raw,
  });
}

describe("Task #5459 — 群聊里别的 bot 的消息 → 放行（修误杀）", () => {
  test("群消息 @ 我的 bot open_id → 放行（这正是被误杀的协作入站消息）", () => {
    const v = isSelfEchoEvent(groupBotEvent([SELF_BOT_OPEN_ID]), {
      selfBotIds: [SELF_BOT_OPEN_ID, SELF_APP_ID],
    });
    expect(v.skip).toBe(false);
    expect(v.reason).toBe("group-bot-message");
  });

  test("群消息 @ 我的 app_id → 同样放行（app_id / open_id 两种口径都认）", () => {
    const v = isSelfEchoEvent(groupBotEvent([SELF_APP_ID]), {
      selfBotIds: [SELF_BOT_OPEN_ID, SELF_APP_ID],
    });
    expect(v.skip).toBe(false);
  });

  test("群消息 @ 其它 bot（不是我）→ 也放行（丢弃无收益，交 agent 判断）", () => {
    const v = isSelfEchoEvent(groupBotEvent([OTHER_BOT_APP_ID]), {
      selfBotIds: [SELF_BOT_OPEN_ID, SELF_APP_ID],
    });
    expect(v.skip).toBe(false);
  });

  test("群消息无 mentions（广播）→ 放行", () => {
    const v = isSelfEchoEvent(groupBotEvent([]), {
      selfBotIds: [SELF_BOT_OPEN_ID],
    });
    expect(v.skip).toBe(false);
  });

  test("sender_type=app + 群聊 → 放行（飞书 bot 消息主取值）", () => {
    const v = isSelfEchoEvent(groupBotEvent([SELF_BOT_OPEN_ID], { sender_type: "app" }), {
      selfBotIds: [SELF_BOT_OPEN_ID],
    });
    expect(v.skip).toBe(false);
  });

  test("嵌套 webhook 格式的群聊 bot 消息 → 放行", () => {
    const v = isSelfEchoEvent(
      {
        id: "es-nested-group",
        type: "event-source.event.lark-cli",
        timestamp: Date.now(),
        metadata: { source: "event-source", sourceId: "src" },
        payload: {
          rawEvent: {
            event: {
              message: {
                message_id: "om_nested",
                chat_id: COLLAB_GROUP,
                chat_type: "group",
                mentions: [{ id: SELF_BOT_OPEN_ID, name: "通助理" }],
              },
              sender: { sender_id: { open_id: OTHER_BOT_OPEN_ID }, sender_type: "app" },
            },
          },
        },
      } as any,
      { selfBotIds: [SELF_BOT_OPEN_ID] },
    );
    expect(v.skip).toBe(false);
  });
});

describe("Task #5459 — 真正的回声仍然拦截（防自循环放大）", () => {
  test("群聊消息发送者是自身 bot（app_id 命中）→ skip（自己发的不处理）", () => {
    const v = isSelfEchoEvent(
      groupBotEvent([OTHER_BOT_OPEN_ID], { sender_id: SELF_APP_ID }),
      { selfBotIds: [SELF_APP_ID, SELF_BOT_OPEN_ID] },
    );
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("self-bot-id");
  });

  test("群聊消息发送者是自身 bot（open_id 命中）→ skip", () => {
    const v = isSelfEchoEvent(
      groupBotEvent([OTHER_BOT_OPEN_ID], { sender_id: SELF_BOT_OPEN_ID }),
      { selfBotIds: [SELF_APP_ID, SELF_BOT_OPEN_ID] },
    );
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("self-bot-id");
  });

  test("私聊（p2p）bot 消息 → 仍然 skip（bot 对 bot 私聊无合法业务）", () => {
    const v = isSelfEchoEvent(
      groupBotEvent([SELF_BOT_OPEN_ID], { chat_type: "p2p" }),
      { selfBotIds: [SELF_BOT_OPEN_ID] },
    );
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("bot-sender");
  });

  test("chat_type 缺失的 bot 消息 → 仍然 skip（信息不足时不放行回声）", () => {
    const evt = groupBotEvent([SELF_BOT_OPEN_ID]);
    delete evt.payload.rawEvent.chat_type;
    const v = isSelfEchoEvent(evt, { selfBotIds: [SELF_BOT_OPEN_ID] });
    expect(v.skip).toBe(true);
    expect(v.reason).toBe("bot-sender");
  });

  test("chat_type=topic（不认识）→ 仍然 skip（保守）", () => {
    const v = isSelfEchoEvent(
      groupBotEvent([SELF_BOT_OPEN_ID], { chat_type: "topic" }),
      { selfBotIds: [SELF_BOT_OPEN_ID] },
    );
    expect(v.skip).toBe(true);
  });

  test("回归护栏：真实用户消息 sender_type=user → 放行（不受新逻辑影响）", () => {
    const v = isSelfEchoEvent(
      simplifiedLarkEvent({ chat_type: "group", sender_type: "user", sender_id: USER_OPEN_ID }),
      { selfBotIds: [SELF_BOT_OPEN_ID] },
    );
    expect(v.skip).toBe(false);
  });
});

describe("Task #5459 — extractChatKind / extractMentionIds 提取层", () => {
  test("extractChatKind：metadata / rawEvent / 嵌套 message 三处都能读", () => {
    const viaMeta = simplifiedLarkEvent({ chat_type: "group" });
    viaMeta.metadata.chatType = "group";
    expect(extractChatKind(viaMeta)).toBe("group");

    expect(extractChatKind(simplifiedLarkEvent({ chat_type: "p2p" }))).toBe("p2p");

    const nested: any = {
      id: "n",
      type: "event-source.event.lark-cli",
      timestamp: 0,
      metadata: {},
      payload: {
        rawEvent: { event: { message: { chat_type: "group", chat_id: COLLAB_GROUP } } },
      },
    };
    expect(extractChatKind(nested)).toBe("group");
  });

  test("extractChatKind：缺失 / 不认识的值 → unknown（不参与放行）", () => {
    expect(extractChatKind(simplifiedLarkEvent())).toBe("unknown");
    expect(extractChatKind(simplifiedLarkEvent({ chat_type: "topic" }))).toBe("unknown");
    expect(extractChatKind(undefined)).toBe("unknown");
  });

  test("extractMentionIds：读 id / open_id / user_id / app_id，且去重", () => {
    const evt = simplifiedLarkEvent({
      mentions: [
        { id: "ou_a", name: "A" },
        { open_id: "ou_b" },
        { user_id: "u_c" },
        { app_id: "cli_d" },
        { id: "ou_a" },
      ],
    });
    expect(extractMentionIds(evt)).toEqual(["ou_a", "ou_b", "u_c", "cli_d"]);
  });

  test("extractMentionIds：无 mentions → 空数组（不抛）", () => {
    expect(extractMentionIds(simplifiedLarkEvent())).toEqual([]);
    expect(extractMentionIds(undefined)).toEqual([]);
  });

  test("verdict 带诊断字段（chatKind / mentionIds），便于运维定位", () => {
    const v = isSelfEchoEvent(groupBotEvent([SELF_BOT_OPEN_ID]), {
      selfBotIds: [SELF_BOT_OPEN_ID],
    });
    expect(v.chatKind).toBe("group");
    expect(v.mentionIds).toEqual([SELF_BOT_OPEN_ID]);
  });
});
