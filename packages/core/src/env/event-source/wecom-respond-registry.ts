/**
 * @fileoverview Task #5174（用户明令 2026-11-08 11:29）— 企微回复注册表 + `wecom_respond` 工具
 *
 * ## 出站主路径 = wecom-cli（CLI 已授权）
 *
 * 用户明令：「彻底改造下回复出站用 cli 吧，已经验证可以收到消息了，不用 ws 回」。
 *
 * 发送顺序：
 *   1. **CLI**（`wecom-cli message aibot send --msg-type markdown`）—— 主路径
 *   2. **WS 回帧**（`aibot_respond_msg`，req_id 透传）—— CLI 失败时 fallback
 *      （两者都不可用时如实报错，绝不假装已发送）
 *
 * ## chat_id 语义（实测硬约束）
 *
 * - WS 回调里的 `from.userid`（如 `DongZhaoKun`）**不是** CLI 可用的 chat_id
 *   → CLI 报 40073「非法的 chat_id」
 * - CLI 需要真实 userid（`wotnB7Wg...` 形态）→ 由 `contact users search` 解析
 *   （`wecom-cli-sender.resolveWecomCliChatId`，带内存缓存）
 *
 * ## 注册表
 *
 * `WecomCliInstance.startWithBridge()` 把实例登记进来（`sourceId → target`），
 * `stop()` 注销；工具通过 `EnvContext.sourceId` 反查，从而拿到：
 * - `respond(reqId, body)` —— WS fallback
 * - `sourceId` 对应的配置（CLI 出站不需要实例，但保留用于 fallback）
 *
 * @see wecom-cli-sender.ts（CLI 出站实现）
 * @see wecom-ws-bridge.ts（WS 回帧 fallback）
 */

import { z } from "zod";
import { getEnvContextOrEmpty } from "../context/env-context";
import type { Tool, ToolContext, ToolResult } from "../types";
import {
  resolveWecomCliChatId,
  sendWecomCliMarkdown,
} from "./wecom-cli-sender";
import { buildWecomSendCardFrame } from "./wecom-card-builder";

// =============================================================================
// 注册表
// =============================================================================

/** 注册表条目：WS fallback 所需的最小面 */
export interface WecomRespondTarget {
  /** 发送 WS 回帧（透传原消息 req_id）；返回错误而不抛（best-effort） */
  respond(reqId: string, body: Record<string, unknown>): Error | undefined;
  /**
   * 主动推送帧（Task #5203：aibot_send_msg 直发 template_card）。
   * 返回错误而不抛（best-effort）。
   */
  sendCmd?(
    cmd: string,
    body: Record<string, unknown>,
  ): Error | undefined;
}

const registry = new Map<string, WecomRespondTarget>();

/** 登记一个可回复的企微实例（sourceId → target） */
export function registerWecomRespondTarget(
  sourceId: string,
  target: WecomRespondTarget,
): void {
  registry.set(sourceId, target);
}

/** 注销（实例 stop 时调用） */
export function unregisterWecomRespondTarget(sourceId: string): void {
  registry.delete(sourceId);
}

/** 查询（工具执行时用） */
export function getWecomRespondTarget(
  sourceId: string,
): WecomRespondTarget | undefined {
  return registry.get(sourceId);
}

/** 测试用：清空注册表 */
export function __resetWecomRespondRegistryForTest(): void {
  registry.clear();
}

// =============================================================================
// 出站发送（CLI 主路径 → WS fallback）
// =============================================================================

/** 出站发送入参 */
export interface WecomSendInput {
  /** 事件源 ID（用于查 WS fallback 实例） */
  sourceId: string;
  /** 原始 WS 回调的 userid / chatid（CLI 侧会自动解析成真实 userid） */
  rawChatId: string;
  /** 原消息帧 req_id（WS fallback 用） */
  reqId?: string;
  /** 回复正文 */
  content: string;
}

/** 出站发送结果 */
export interface WecomSendResult {
  ok: boolean;
  /** 实际走通的通道 */
  channel?: "cli" | "ws";
  /** 失败原因（两个通道都失败时给出合并说明） */
  error?: string;
}

/**
 * 发送企微回复：**被动回帧优先（有 reqId 时），CLI 兜底**（永不抛）。
 *
 * ## 为什么被动回帧优先（Task #5287 回复引用）
 *
 * 取证结论（官方文档 101463 + CLI schema 实查）：
 * - 主动推送（CLI `message.aibot.send` / WS `aibot_send_msg`）schema
 *   **无 quote/引用字段** —— 协议不支持发消息时主动引用某条消息；
 * - 被动回复（WS `aibot_respond_msg`，headers.req_id 原样透传）时，
 *   企微服务端**自动**把回复引用到触发回调的用户消息（群聊场景）。
 *
 * ⇒ 要让用户看到「回复引用了哪条消息」，必须走被动回帧。
 *   因此有 reqId 且 WS 实例在线时**优先** WS 被动回帧；
 *   CLI 降为 fallback（无 reqId / WS 失败 / 无实例时仍可用，
 *   #5174「CLI 主路径」行为在无 reqId 场景不回归）。
 *
 * 发送顺序：
 *   1. **WS 被动回帧**（reqId 存在 + 注册实例在线）—— 带引用语义
 *   2. **CLI**（`wecom-cli message aibot send --msg-type markdown`）—— fallback
 *   3. 都失败 → `{ok:false, error}`（两个原因都带上，便于排障）
 */
export async function sendWecomReply(
  input: WecomSendInput,
): Promise<WecomSendResult> {
  const content = input.content ?? "";
  if (content.trim().length === 0) {
    return { ok: false, error: "empty content" };
  }

  const errors: string[] = [];

  // ── 1. WS 被动回帧（带引用语义，Task #5287）──────────
  if (input.reqId) {
    const target = getWecomRespondTarget(input.sourceId);
    if (target) {
      const wsErr = target.respond(input.reqId, {
        msgtype: "markdown",
        markdown: { content },
      });
      if (!wsErr) return { ok: true, channel: "ws" };
      errors.push(`ws: ${wsErr.message}`);
    } else {
      errors.push(`ws: no instance registered for sourceId=${input.sourceId}`);
    }
  } else {
    errors.push("ws: no req_id");
  }

  // ── 2. CLI fallback（主动推送，无引用）──────────────
  if (input.rawChatId) {
    try {
      const chatId = await resolveWecomCliChatId(input.rawChatId);
      const cliResult = await sendWecomCliMarkdown({ chatId, content });
      if (cliResult.ok) return { ok: true, channel: "cli" };
      errors.push(`cli: ${cliResult.error}`);
    } catch (err) {
      errors.push(`cli: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    errors.push("cli: no chatId");
  }

  return { ok: false, error: errors.join(" | ") };
}

// =============================================================================
// template_card 直发（Task #5203）
// =============================================================================

/** 卡片直发入参 */
export interface WecomTemplateCardSendInput {
  /** 事件源 ID（查注册的 WS 实例） */
  sourceId: string;
  /** 会话 ID（单聊=userid，群聊=群 chatid） */
  chatId: string;
  /** 会话类型（决定 chat_type：1 单聊 / 2 群聊） */
  chatType: "single" | "group";
  /** 卡片结构体（wecom-card-builder 构造） */
  card: Record<string, unknown>;
}

/**
 * 经 WS 长连接直发 template_card（aibot_send_msg 主动推送）。
 *
 * ## 为什么不走 wecom-cli
 *
 * wecom-cli v1.3.4 的 msg_type 枚举只有 markdown/image/file/voice/video，
 * 没封装 template_card（官方仓源码 grep 零命中，Task #5202 取证）。
 * WS 协议原生支持 → 直发。
 *
 * best-effort：永不抛；失败返回 `{ok:false, error}`。
 *
 * ⚠️ 主动推送前提（官方 101463）：需用户先在会话中给机器人发过消息；
 * 限频 30 条/分钟、1000 条/小时（调用方节流）。
 */
export async function sendWecomTemplateCard(
  input: WecomTemplateCardSendInput,
): Promise<WecomSendResult> {
  if (!input.chatId) {
    return { ok: false, error: "no chatId" };
  }
  const target = getWecomRespondTarget(input.sourceId);
  if (!target) {
    return {
      ok: false,
      error: `no instance registered for sourceId=${input.sourceId}`,
    };
  }
  if (typeof target.sendCmd !== "function") {
    return {
      ok: false,
      error: `registered instance has no sendCmd (old bridge?)`,
    };
  }

  const frame = buildWecomSendCardFrame({
    chatId: input.chatId,
    chatType: input.chatType,
    card: input.card as never,
  });

  try {
    const err = target.sendCmd(frame.cmd, frame.body);
    if (err) return { ok: false, error: err.message };
    return { ok: true, channel: "ws" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// =============================================================================
// wecom_respond 工具
// =============================================================================

/**
 * `wecom_respond` —— 回复企微用户（CLI 主路径，WS fallback）。
 *
 * 参数：
 * - `content`：回复正文（markdown）
 * - `chat_id`：**可选**，回复目标；缺省时从 EnvContext 事件 metadata 取
 *   （单聊=senderId；群聊=chatid）。CLI 侧会自动解析成真实 userid。
 * - `req_id`：**可选**，原消息帧 req_id（WS fallback 用）；缺省从 metadata.reqId 取
 */
export const wecomRespondTool: Tool = {
  name: "wecom_respond",
  description:
    "Reply to the WeCom (企业微信) user. Primary path is the official wecom-cli " +
    "(message aibot send, markdown); WS long-connection frame is used as fallback. " +
    "This is the ONLY outbound channel for WeCom messages.",
  parameters: z.object({
    content: z.string().describe("Reply content (markdown supported)"),
    chat_id: z
      .string()
      .optional()
      .describe(
        "Target chat id (single chat = peer userid, group = chatid). " +
          "Defaults to the current event's chatId/senderId.",
      ),
    req_id: z
      .string()
      .optional()
      .describe(
        "Original message frame req_id (optional; used for WS fallback only). " +
          "Defaults to the current event metadata.reqId.",
      ),
  }),
  metadata: {
    category: "messaging",
    tags: ["wecom", "reply", "im"],
    version: "2.0.0",
    // ★ Task #5333：渠道专用工具 —— 只在企微 ES 驱动的一轮里可见。
    //   企微事件源 handler 默认注入 extendTools:["wecom_respond"]；
    //   其它渠道（飞书 / 交互式 CLI / 定时器）的 agent 看不到它，
    //   避免 LLM 在手边没有企微上下文时误调（调用必然失败）。
    channelOnly: true,
  },
  execute: async (
    args: { content: string; chat_id?: string; req_id?: string },
    _ctx: ToolContext,
  ): Promise<ToolResult> => {
    const { content } = args;

    // 1. 从 EnvContext 取事件定位信息
    let sourceId: string | undefined;
    let eventChatId: string | undefined;
    let eventReqId: string | undefined;
    try {
      const ctx = getEnvContextOrEmpty();
      sourceId = typeof ctx.sourceId === "string" ? ctx.sourceId : undefined;
      const meta = (ctx.envEvent as { metadata?: Record<string, unknown> })
        ?.metadata;
      const cid = meta?.chatId;
      if (typeof cid === "string" && cid.length > 0) eventChatId = cid;
      const rid = meta?.reqId;
      if (typeof rid === "string" && rid.length > 0) eventReqId = rid;
      // ★ Task #5333（DS review 第 2 轮 MINOR-1）—— delegate 出去的 sub-agent
      //   也要能把回复投递回原企微会话。
      //
      //   为什么需要这层兜底：sub-agent 跑在自己的 background session 里，
      //   `ctx.envEvent.metadata.chatId` 依赖父级 ALS 继承，跨 await / 后台
      //   任务边界时并不保证有值（buildRunEnvContext 里 envEvent 是
      //   effective → parent 兜底，parent 缺失就为 undefined）。
      //   而 `ctx.replyChannel` 是 delegate 时刻**显式快照**下来的
      //   （Task #4042 follow-up，delegate-tool 的 replyChannelSnapshot），
      //   稳定性高于 envEvent —— 用它作 chatId 的第二来源。
      //
      //   优先级：envEvent.metadata.chatId（当前事件的权威定位）
      //         > replyChannel.chatId（delegate 快照兜底）
      if (!eventChatId) {
        const rcChatId = (ctx.replyChannel as { chatId?: unknown } | undefined)
          ?.chatId;
        if (typeof rcChatId === "string" && rcChatId.length > 0) {
          eventChatId = rcChatId;
        }
      }

      // ★ Task #5325：通知轮（task.background.*）兜底。
      //
      // 根因（生产实锤 2026-11-11 14:21 trace）：通知轮的
      // envEvent.metadata **没有顶层 reqId**（reqId 只在
      // replyChannel.params.reqId / sourceId 里）——
      // 用户消息轮由 handleWsFrame 把 reqId 提到 metadata 顶层，
      // 但 delegate-tool 的 replyChannel 快照只保留 params。
      // 之前只读 metadata.reqId → undefined → 走 CLI 主动推送
      // → 用户看不到引用。
      // 这里从 replyChannel.params 兜底取 reqId / sourceId。
      const rc = meta?.replyChannel as
        | { chatId?: unknown; params?: Record<string, unknown> }
        | undefined;
      // chatId 兜底：通知轮 metadata 无顶层 chatId，只有 replyChannel.chatId
      if (!eventChatId && typeof rc?.chatId === "string" && rc.chatId) {
        eventChatId = rc.chatId;
      }
      // params 兜底：envEvent.metadata.replyChannel.params 与
      //   ctx.replyChannel.params（delegate 快照）两处都尝试
      const rcParamsList: Array<Record<string, unknown> | undefined> = [
        rc?.params,
        (ctx.replyChannel as { params?: Record<string, unknown> } | undefined)
          ?.params,
      ];
      for (const rcParams of rcParamsList) {
        if (!rcParams) continue;
        if (!eventReqId) {
          const prid = rcParams.reqId;
          if (typeof prid === "string" && prid.length > 0) eventReqId = prid;
        }
        if (!sourceId) {
          const psid = rcParams.sourceId;
          if (typeof psid === "string" && psid.length > 0) sourceId = psid;
        }
      }
      // ctx.sourceId 顶层兜底（buildRunEnvContext sourceId 继承）
      // ★ DS review MINOR-4：可选链对齐同段防御风格
      if (!sourceId && typeof ctx?.sourceId === "string" && ctx.sourceId) {
        sourceId = ctx.sourceId;
      }
    } catch {
      /* 无 ALS 上下文 → 只依赖显式参数 */
    }

    const chatId = args.chat_id?.trim() || eventChatId;
    const reqId = args.req_id?.trim() || eventReqId;

    if (!chatId) {
      return {
        success: false,
        output: "",
        error:
          "wecom_respond: cannot resolve chat_id (no explicit chat_id and no EnvContext event chatId).",
      };
    }
    if (!sourceId) {
      // sourceId 只影响 WS fallback；CLI 主路径仍可尝试
      sourceId = "unknown";
    }

    // 2. 发送（CLI 优先 → WS fallback）
    const startedAt = Date.now();
    const result = await sendWecomReply({
      sourceId,
      rawChatId: chatId,
      reqId,
      content,
    });

    if (!result.ok) {
      return {
        success: false,
        output: "",
        error: `wecom_respond: send failed: ${result.error ?? "unknown"}`,
      };
    }

    // ★ 标记本轮已发送 —— 框架兜底（autoReplyWecomTurn）据此避免双发
    markWecomReplySent();

    return {
      success: true,
      output:
        `Reply sent to WeCom via ${result.channel} ` +
        `(chat_id=${chatId}, ${content.length} chars)`,
      metadata: {
        execution_time_ms: Date.now() - startedAt,
        channel: result.channel,
        chat_id: chatId,
      },
    };
  },
};

// =============================================================================
// 框架级自动补发（Task #5174 — LLM 不调工具时的兜底）
// =============================================================================

/**
 * 本轮是否已通过 `wecom_respond` 工具发过回复（单轮标记）。
 *
 * 存在的原因：**靠 systemPrompt 指导 LLM 自觉调工具不可靠** —— 实测
 * （real-run-8, trace 01a1b935e9f0）LLM 直接把回复写在 assistant text 里结束，
 * `toolCallCount=0`，用户永远收不到。因此框架必须在 turn 结束时兜底补发。
 *
 * 标记存放在 EnvContext 的 `agentContext`（父子 agent 共享引用），
 * turn 结束由调用方清理（或随 context 一起丢弃）。
 */
const REPLY_SENT_KEY = "__wecomReplySent";

/**
 * 取防双发标记所在的 bag。
 *
 * 优先用显式传入的 bag（DS review B1：无 ALS 上下文时
 * getEnvContextOrEmpty() 返回空对象，标记会静默丢失 →
 * 防双发失效 → 可能重复发送）；调用方（工具）在 ALS 内
 * 能拿到真实 agentContext 时**必须**显式传入。
 */
function replySentBag(explicit?: Record<string, unknown>): Record<string, unknown> {
  if (explicit) return explicit;
  try {
    const ctx = getEnvContextOrEmpty() as {
      agentContext?: Record<string, unknown>;
    };
    return (ctx.agentContext ??= {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 标记本轮已发送（wecom_respond 工具成功时调用） */
export function markWecomReplySent(explicitBag?: Record<string, unknown>): void {
  replySentBag(explicitBag)[REPLY_SENT_KEY] = true;
}

/** 本轮是否已发送过 */
export function wasWecomReplySent(explicitBag?: Record<string, unknown>): boolean {
  return replySentBag(explicitBag)[REPLY_SENT_KEY] === true;
}

/** 测试用：清空标记 */
export function __resetWecomReplySentForTest(explicitBag?: Record<string, unknown>): void {
  delete replySentBag(explicitBag)[REPLY_SENT_KEY];
}

/** 企微事件类型常量（避免循环依赖 wecom-cli-handler） */
const WECOM_EVENT_TYPE = "event-source.event.wecom-cli";

/**
 * 框架级兜底：turn 结束后，若本轮没发过回复且事件来自企微 → 直接把
 * assistant 的最终文本发出去（CLI 主路径 → WS fallback）。
 *
 * 触发条件（全部满足）：
 * 1. `envEvent.type === "event-source.event.wecom-cli"`
 * 2. 最终文本非空
 * 3. 本轮**尚未**通过 `wecom_respond` 工具发送（避免双发）
 *
 * @returns 发送结果；不满足触发条件时返回 `{skipped: true}`
 */
export async function autoReplyWecomTurn(
  envEvent: unknown,
  finalText: string,
): Promise<
  | { skipped: true; reason: string }
  | { skipped: false; ok: boolean; channel?: "cli" | "ws"; error?: string }
> {
  const evt = envEvent as
    | { type?: string; metadata?: Record<string, unknown> }
    | undefined;
  if (evt?.type !== WECOM_EVENT_TYPE) {
    return { skipped: true, reason: "not a wecom event" };
  }
  const text = (finalText ?? "").trim();
  if (!text) return { skipped: true, reason: "empty final text" };
  if (wasWecomReplySent()) {
    return { skipped: true, reason: "already replied via tool" };
  }

  const meta = evt.metadata ?? {};
  const chatId =
    (typeof meta.chatId === "string" && meta.chatId) ||
    (typeof meta.senderId === "string" && meta.senderId) ||
    "";
  const sourceId =
    (typeof meta.sourceId === "string" && meta.sourceId) || "unknown";
  const reqId = typeof meta.reqId === "string" ? meta.reqId : undefined;

  if (!chatId) {
    return { skipped: true, reason: "no chatId in event metadata" };
  }

  const r = await sendWecomReply({
    sourceId,
    rawChatId: chatId,
    reqId,
    content: text,
  });
  return { skipped: false, ok: r.ok, channel: r.channel, error: r.error };
}
