/**
 * @fileoverview Task #5142 — `wecom-cli` EventSource handler
 *
 * ## 定位
 *
 * 企业微信（WeCom）官方 CLI 是 `@wecom/cli`（Rust 编译，npm 名 `@wecom/cli`，
 * 二进制名 `wecom-cli`，仓库 https://github.com/WeComTeam/wecom-cli）。
 * 本 handler 把企微接入 roy-bot 的 EventSource 体系，esType = **`wecom-cli`**。
 *
 * ## 为什么 esType 必须是新类型名（不能抄 `lark-cli`）
 *
 * `getHandlerForEsType(esType)` 是 v2 notify prompt 的**唯一分派 key**。
 * 若落库写成 `lark-cli`，主 agent 会拿到「用 lark-cli 发到 oc_xxx」的 prompt ——
 * 而企微根本没有 `oc_xxx`，agent 必然发不出去。
 *
 * ## 入站 transport 三方案（调研结论）
 *
 * | 方案 | 机制 | 结论 |
 * |---|---|---|
 * | A | 企微 webhook 回调 URL | 需**公网可达 URL** + 消息加解密（EncodingAESKey）。本机是内网 → 不可直接用 |
 * | B | 轮询 `wecom-cli chat messages list` | 只支持**最近 7 天**，且需先知道 `chat_id` → 只能作补充，不能作主路径 |
 * | C | 第三方桥接（CLI-WeChat-Bridge / golembot） | 依赖非官方项目（AGPL-3.0 传染风险）→ 只作参考实现 |
 * | **D（采用）** | **企微长连接 WebSocket** `wss://openws.work.weixin.qq.com` | ✅ **无需公网 IP**、无需加解密；官方 SDK `@wecom/aibot-node-sdk` 已封装认证/心跳/重连/reply 串行队列 |
 *
 * 企微官方文档：
 * - 长连接：https://developer.work.weixin.qq.com/document/path/101463
 * - 接收消息（webhook 模式）：https://developer.work.weixin.qq.com/document/path/100719
 * - 官方 Node SDK：https://www.npmjs.com/package/@wecom/aibot-node-sdk
 *
 * ## 长连接协议要点（来自官方文档 101463）
 *
 * - 握手：`wss://openws.work.weixin.qq.com` → 发送 `aibot_subscribe`（body: bot_id + secret）
 * - 入站：`aibot_msg_callback`（消息）/ `aibot_event_callback`（事件）
 * - 出站：`aibot_respond_msg`（被动回复，**必须透传回调的 req_id**）/
 *   `aibot_send_msg`（主动推送）/ `aibot_respond_welcome_msg` / `aibot_respond_update_msg`
 * - 心跳：`ping`，建议 30s
 * - **每个机器人同一时刻只允许 1 条长连接**（新连接会踢掉旧连接）⇒ 必须做单实例互斥
 * - 收到回调后 **24h 内**可回复该会话；限频 **30 条/分钟、1000 条/小时**
 * - 流式消息需 10 分钟内 `finish=true`
 *
 * ## 本 handler 的边界（Phase 1 骨架）
 *
 * Phase 1 只做「spawn 子进程 + 解析行 JSON + 产出 EventSourceEvent」：
 * 入站通过 `wecom-cli` 的**行 JSON 输出**（未来由长连接桥接进程产出 NDJSON），
 * 出站由 notify prompt 指导 agent 直接调 `wecom-cli message aibot send --json ...`。
 *
 * @see packages/core/src/env/event-source/wecom-cli-handler.test.ts
 */

import { ChildProcess, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { delimiter, isAbsolute, join } from "path";
import {
  WecomWsBridge,
  WECOM_WS_URL,
  type WecomFrame,
} from "./wecom-ws-bridge";
import {
  registerWecomRespondTarget,
  unregisterWecomRespondTarget,
} from "./wecom-respond-registry";
// ★ Task #5311（方案 B）：event handler 同步抛错时回触发方
import { notifyReactFailure } from "../error-reply";
import {
  extractWecomCardAction,
  handleWecomCardAction,
  buildWecomCardUpdateBody,
  buildWecomSessionCardUpdateBody,
  type WecomCardActionPorts,
} from "./wecom-card-action-handler";
import { createWecomCardStateStore } from "../task/plugins/wecom-card-state-store";
// ★ Task #5364（B 方案）：session 卡持久层端口类型
import {
  getSharedWecomSessionCardStore,
  type WecomSessionCardStore,
} from "../task/plugins/wecom-session-card-store";
// ★ Task #5360：sub-session 活性 probe（与飞书侧共用的同一实现）
import {
  createActivityProbe,
  createSessionActivityProbe,
  mapBgTaskStatusToSessionLifecycle,
  toActivityMessage,
} from "../task/plugins/sub-session-activity";
// ★ Task #5419：建关联飞书群（lark-cli +chat-create）+ applink 基址
import { createGroupChatViaLarkCli } from "../task/plugins/lark-card-action-handler";
import { DEFAULT_APP_LINK_BASE } from "../task/plugins/lark-card-action-handler";
import { sendWecomCliMarkdown } from "./wecom-cli-sender";
import {
  extractWecomMediaRefs,
  fetchAndSaveWecomMedia,
} from "./wecom-media";
import {
  importPluginShared,
  registerPluginHooksShared,
  unregisterPluginHooksShared,
  getWecomPluginFactories,
  type PluginFactoryConfig,
} from "./es-plugins";
import { normalizeToolEnv } from "../context";
import type {
  EventSourceHandler,
  EventSourceInstance,
  EventSourceConfig,
  EventSourceEvent,
  EventSourceEventHandler,
  EventSourceStatus,
  EventMetadata,
  ReplyChannel,
} from "./types";

// =============================================================================
// 常量
// =============================================================================

/** 企微事件源类型名（必须是**新**类型名，不能抄 lark-cli） */
export const WECOM_CLI_ES_TYPE = "wecom-cli";

/**
 * 企微 chatId 前缀。
 *
 * 企微的 `chatid` 与飞书的 `oc_xxx` 语义不同（企微群聊 id 是业务方自己的
 * chatid，单聊则是 userid），下游按前缀即可反解「这是企微会话」，
 * 避免与 lark / cli 的 chatId 撞车。
 */
export const WECOM_CHAT_ID_PREFIX = "wecom:";

/** 企微长连接默认地址（官方文档 101463） */
export const WECOM_WS_DEFAULT_URL = "wss://openws.work.weixin.qq.com";

// =============================================================================
// 配置读取
// =============================================================================

interface WecomCliConfig {
  botId?: string;
  secret?: string;
  /** 覆盖默认命令（高级用法） */
  command?: string;
  /** 群机器人 webhook（可选） */
  webhook?: string;
  /**
   * 独立凭据文件路径（Task #5228）。
   *
   * 多 bot 场景（如 wecom-bot-2）用独立凭据文件隔离凭据；
   * 曾是 dead config（声明≠实现），现已接入 resolveWecomCredentials。
   */
  credentialsPath?: string;
}

/**
 * 从 EventSourceConfig 读取企微相关字段。
 *
 * 优先级：顶级字段 → `options.*`（CLI 透传路径）。
 */
export function readWecomCliConfig(config: EventSourceConfig): WecomCliConfig {
  const top = config as unknown as Record<string, unknown>;
  const opts = (config.options ?? {}) as Record<string, unknown>;
  return {
    botId: (top.botId as string) || (opts.botId as string) || undefined,
    secret: (top.secret as string) || (opts.secret as string) || undefined,
    command: (top.command as string) || (opts.command as string) || undefined,
    webhook: (top.webhook as string) || (opts.webhook as string) || undefined,
    credentialsPath:
      (top.credentialsPath as string) ||
      (opts.credentialsPath as string) ||
      undefined,
  };
}

// =============================================================================
// 凭据读取（Phase 2：credentials file 接入）
// =============================================================================

/** 默认凭据文件路径（~/.roy-bot/wecom-credentials.json，权限 600） */
export const WECOM_CREDENTIALS_DEFAULT_PATH = join(
  process.env.HOME || "/tmp",
  ".roy-bot",
  "wecom-credentials.json",
);

/** 凭据文件解析结果 */
export interface WecomCredentials {
  botId: string;
  secret: string;
}

/**
 * 读取企微凭据文件（不抛）。
 *
 * 文件形态：`{"agent_id":"1000003","secret":"..."}`
 * （agent_id 即智能机器人 BotID）。
 *
 * 缺失 / 坏 JSON / 字段不全 → null（调用方据此降级）。
 */
export function readWecomCredentialsFile(
  path: string,
): WecomCredentials | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const agentId =
      typeof parsed.agent_id === "string" ? parsed.agent_id : undefined;
    const botId =
      typeof parsed.bot_id === "string" ? parsed.bot_id : undefined;
    const secret = typeof parsed.secret === "string" ? parsed.secret : undefined;
    const id = botId || agentId;
    if (!id || !secret) return null;
    return { botId: id, secret };
  } catch {
    return null;
  }
}

/**
 * 解析企微凭据（优先级：config 显式配置 > options.credentialsPath
 * 独立凭据文件 > 默认凭据文件）。
 *
 * ★ Task #5228：`options.credentialsPath` 曾是 dead config——
 *   wecom-bot-2 配置了独立凭据文件却仍用生产默认凭据连接 → 无回复。
 *   声明 ≠ 实现（与 #4946 provider temperature 同类坑）。
 *
 * 全缺 → undefined：调用方（start）据此**优雅降级**为骨架模式，
 * 不 crash、不假装在收消息。
 */
export function resolveWecomCredentials(
  config: EventSourceConfig,
  credentialsPath: string = WECOM_CREDENTIALS_DEFAULT_PATH,
): WecomCredentials | undefined {
  const cliConfig = readWecomCliConfig(config);
  if (cliConfig.botId && cliConfig.secret) {
    return { botId: cliConfig.botId, secret: cliConfig.secret };
  }
  // options.credentialsPath（独立凭据文件）优先于默认凭据文件
  const fromFile = readWecomCredentialsFile(
    cliConfig.credentialsPath ?? credentialsPath,
  );
  if (fromFile) return fromFile;
  return undefined;
}

// =============================================================================
// replyChannel 构造
// =============================================================================

/** `buildWecomReplyChannel` 的入参 */
export interface WecomReplyChannelInput {
  /** 企微会话 id（群聊有，单聊通常无） */
  chatId?: string;
  /** 消息 id（msgid） */
  messageId?: string;
  /** 会话类型：single / group */
  chatType?: string;
  /** 发送者 userid */
  userId?: string;
  /**
   * ★ Task #5311（CV M1）：事件源 ID —— 失败回执的 WS fallback 需要它
   * 反查注册实例（`getWecomRespondTarget(sourceId)`）。缺了只剩 CLI 一条路。
   */
  sourceId?: string;
  /** ★ Task #5311：原始 req_id —— WS 被动回帧（带引用语义）需要 */
  reqId?: string;
  /**
   * ★ Task #5360（补充需求）：状态通知文本开关（来自 ES 配置）。
   *
   * 写进 `params` 让 delegate 快照带下去 —— 与 lark 侧同字段同语义。
   * 严格 `=== true`；显式写 false（不省略，保留"源上显式关"的信息）。
   */
  statusNotifications?: boolean;
}

/**
 * 构造企微的 replyChannel。
 *
 * ★ 硬约束：`_captureReplyChannelSnapshot()`（delegate-tool.ts:2864）要求
 * `chatId || messageId` **至少一个非空**，否则整份快照被丢弃 →
 * notify event 无回复目标 → 规则通知静默丢失。
 *
 * 因此本函数**恒不返回 chatId/messageId 双空**：
 * - 群聊 → chatId = 原始 `chatid`
 * - 单聊 → chatId = 原始 `userid`（企微单聊的回复目标就是 userid）
 * - 全空 → chatId = `"wecom:unknown"`（占位，保证下游不丢快照）
 *
 * ⚠️ **`chatId` 必须是「可直接用于回复命令」的原始值**，不能加前缀：
 * `extractReplyContext()` 返回的 chatId 会一路流到 notify prompt，
 * agent 会把它原样塞进 `wecom-cli message aibot send --json '{"chat_id":"..."}'`。
 * 加了前缀就等于给 agent 塞了个错误的 chat_id。
 *
 * 渠道区分靠 `type: "wecom-cli"` + `params.chatType`，
 * 原始值同时冗余存进 `params.wecomChatId` / `params.wecomUserId`。
 */
export function buildWecomReplyChannel(input: WecomReplyChannelInput): ReplyChannel {
  const chatType = input.chatType === "group" ? "group" : "single";
  const userId = input.userId?.trim() || undefined;
  const rawChatId = input.chatId?.trim() || undefined;

  // 群聊用 chatid；单聊无 chatid → 用 userid（企微单聊的 chat_id 就是 userid）
  const chatId = rawChatId ?? userId ?? `${WECOM_CHAT_ID_PREFIX}unknown`;

  return {
    type: WECOM_CLI_ES_TYPE,
    chatId,
    messageId: input.messageId?.trim() || undefined,
    params: {
      chatType,
      userId,
      /** 企微原始 chatid（群聊），回复时要用它 */
      wecomChatId: rawChatId,
      /** 企微原始 userid（单聊回复目标） */
      wecomUserId: userId,
      // ★ Task #5311：失败回执（error-reply 的 spawnWecomReply）从这里取
      //   sourceId（WS fallback 实例反查）/ reqId（被动回帧）
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.reqId ? { reqId: input.reqId } : {}),
      // ★ Task #5360（补充需求）：状态通知开关随快照带下去
      //   （与 lark 侧 replyChannel.params.statusNotifications 同语义）
      statusNotifications: input.statusNotifications === true,
    },
  };
}

// =============================================================================
// 入站帧解析
// =============================================================================

/** 解析结果 */
export interface ParsedWecomFrame {
  metadata: EventMetadata;
  text: string;
  /** 原始 req_id（长连接回复必须透传） */
  reqId?: string;
}

/**
 * 企微长连接帧的最小形状
 *
 * ★ Task #5419：与 wecom-ws-bridge 的 `WecomFrame` 同名 ——
 * 本地接口删除，直接复用 import 的类型（消除 TS2440 冲突）。
 */

/**
 * 从 `body` 里提取文本内容。
 *
 * 企微消息类型：text / image / mixed / voice / file / video。
 * 非文本类型没有可直接读的正文 → 用类型占位说明。
 */
/** 判定消息体的某媒体字段是否带完整引用（url + aeskey） */
function hasWecomMediaRef(
  body: Record<string, unknown>,
  kind: "image" | "voice" | "file" | "video",
): boolean {
  const field = body[kind] as { url?: unknown; aeskey?: unknown } | undefined;
  return (
    !!field &&
    typeof field === "object" &&
    typeof field.url === "string" &&
    typeof field.aeskey === "string"
  );
}

function extractText(body: Record<string, unknown>): string {
  const msgType = String(body.msgtype ?? "");
  switch (msgType) {
    case "text": {
      const t = body.text as { content?: string } | undefined;
      return t?.content ?? "";
    }
    case "mixed": {
      const mixed = body.mixed as { msg_item?: unknown[] } | undefined;
      const items = mixed?.msg_item ?? [];
      const parts: string[] = [];
      for (const it of items) {
        const item = it as { msgtype?: string; text?: { content?: string } };
        if (item?.msgtype === "text" && item.text?.content) {
          parts.push(item.text.content);
        } else if (item?.msgtype) {
          parts.push(`[${item.msgtype}]`);
        }
      }
      return parts.join("\n");
    }
    case "image":
      // ★ Task #5199：媒体引用完整（url+aeskey）时标注
      //   「已提取引用」，handler 会异步下载落盘并把路径
      //   注入 metadata；无引用（缺 aeskey）保持裸占位。
      return hasWecomMediaRef(body, "image")
        ? "[image](media:downloading)"
        : "[image]";
    case "voice":
      return hasWecomMediaRef(body, "voice")
        ? "[voice](media:downloading)"
        : "[voice]";
    case "file":
      return hasWecomMediaRef(body, "file")
        ? "[file](media:downloading)"
        : "[file]";
    case "video":
      return hasWecomMediaRef(body, "video")
        ? "[video](media:downloading)"
        : "[video]";
    default:
      return msgType ? `[${msgType}]` : "";
  }
}

/**
 * 从 `body.quote`（企微引用结构体，SDK message.d.ts
 * `BaseMessage.quote?: QuoteContent`）提取被引用内容的
 * 归一文本。
 *
 * ★ 与 lark 引用（#5212，只给消息 id）不同：企微长连接
 * 直接**内嵌被引用内容**（msgtype + text/image/mixed/voice/file
 * 完整结构体），无被引用消息 id —— 因此 replyContext 只有
 * quotedText，无 rootId/parentId/threadId。
 *
 * 无 quote / 结构异常 → undefined（不产生空对象）。
 */
function extractWecomQuotedText(
  body: Record<string, unknown>,
): string | undefined {
  const quote = body.quote as
    | { msgtype?: string; text?: { content?: string } }
    | undefined;
  if (!quote || typeof quote !== "object") return undefined;
  const msgType = String(quote.msgtype ?? "");
  if (msgType === "text") {
    const content = quote.text?.content;
    return typeof content === "string" && content ? content : undefined;
  }
  // 非文本引用（image/mixed/voice/file）：类型占位（与
  // extractText 的占位口径一致，不解析媒体内容）
  return msgType ? `[${msgType}]` : undefined;
}

/**
 * ★ Task #5271：构建企微 user message（payload.message）。
 *
 * 企微的 user message 是**纯文本**（lark 是
 * JSON.stringify({rawData, recommendedAction})，recommendedAction
 * 能进 user message；企微不能）。#5251 把 quotedText 挂到
 * recommendedAction.replyContext，但 LLM 永远看不到
 * （#5212 MAJOR-2 同型问题在企微重演）。
 *
 * replyContext 存在时把引用内容拼进正文，格式：
 *
 *   [用户正文]
 *
 *   [引用消息] 被引用的原文内容
 *
 * 无 replyContext 时返回原正文（字节不变，向后兼容）。
 */
export function buildWecomUserMessage(
  text: string,
  replyContext?: { quotedText?: string },
): string {
  const quotedText = replyContext?.quotedText;
  if (!quotedText) return text;
  return `${text}\n\n[引用消息] ${quotedText}`;
}

/**
 * 解析企微长连接帧 → EventSourceEvent 元数据。
 *
 * 无效帧返回 `null`（不抛）—— 非法输入不能拖垮整个事件源。
 *
 * @param frame 原始帧（`aibot_msg_callback` / `aibot_event_callback`）
 */
export function parseWecomFrame(raw: unknown): ParsedWecomFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as WecomFrame;
  const cmd = String(frame.cmd ?? "");
  const body = frame.body;
  if (!body || typeof body !== "object") return null;

  const msgid = typeof body.msgid === "string" ? body.msgid : undefined;
  const isMsg = cmd === "aibot_msg_callback";
  const isEvent = cmd === "aibot_event_callback";

  if (!isMsg && !isEvent) return null;
  // 消息帧必须有 msgid（事件帧的 disconnected_event 也带 msgid，但宽松处理）
  if (isMsg && !msgid) return null;

  const msgType = String(body.msgtype ?? (isEvent ? "event" : ""));
  const from = (body.from ?? {}) as { userid?: string };
  const senderId = from.userid ?? "";
  const chattype = typeof body.chattype === "string" ? body.chattype : undefined;
  const rawChatId = typeof body.chatid === "string" ? body.chatid : undefined;

  let eventType: string;
  let text: string;
  if (isEvent) {
    const event = (body.event ?? {}) as { eventtype?: string };
    const eventTypeName = event.eventtype ?? "unknown";
    eventType = `wecom.event.${eventTypeName}`;
    text = `[wecom-event:${eventTypeName}]`;
  } else {
    eventType = "wecom.message.receive";
    text = extractText(body);
  }

  const metadata: EventMetadata = {
    sourceType: WECOM_CLI_ES_TYPE,
    eventType,
    eventId: msgid,
    appId: typeof body.aibotid === "string" ? body.aibotid : undefined,
    // 单聊无 chatid → 用 userid 兜底（企微单聊的 chat_id 就是 userid）
    chatId: rawChatId ?? senderId ?? undefined,
    chatType: chattype,
    messageId: msgid,
    messageType: msgType,
    senderId,
    sourceTime:
      typeof body.create_time === "number"
        ? new Date(body.create_time * 1000).toISOString()
        : undefined,
    payload: body,
  };

  // ★ Task #5251：引用消息上下文（对齐 #5212 lark replyContext）。
  //   企微协议内嵌被引用内容（quote.text 等），归一为 quotedText。
  //   无 quote 时保持 undefined（不产生空对象）。
  const quotedText = extractWecomQuotedText(body);
  if (quotedText) {
    metadata.replyContext = { quotedText };
  }

  return {
    metadata,
    text,
    reqId: frame.headers?.req_id,
  };
}

// =============================================================================
// 渠道专用工具放行名单（Task #5333）
// =============================================================================

/**
 * 企微渠道**恒需**放行的 channel-only 工具。
 *
 * `wecom_respond` 是企微唯一出站通道（wecom-cli 主路径 + WS 回帧 fallback）。
 * 它带有 `metadata.channelOnly = true`（Task #5333），默认对所有 agent 隐藏
 * ——如果不在这里显式放行，企微事件的 agent 将**无法回复**用户。
 */
export const WECOM_DEFAULT_EXTEND_TOOLS: readonly string[] = ["wecom_respond"];

/**
 * 解析企微渠道的 extendTools（默认 + 配置，去重保序）。
 *
 * 顺序：WECOM_DEFAULT_EXTEND_TOOLS 在前（确定性前缀），config.extendTools 在后。
 * 去重保持首次出现位置 —— 保证同一 config 多次调用结果**逐字节一致**
 * （对齐 buildWecomChannelSystemPrompt 的稳定性纪律，避免无意义的 diff）。
 *
 * @param config 事件源配置（可选字段 extendTools）
 */
export function resolveWecomExtendTools(
  config: EventSourceConfig | undefined,
): string[] {
  const out: string[] = [];
  const push = (name: unknown): void => {
    if (typeof name !== "string") return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    if (!out.includes(trimmed)) out.push(trimmed);
  };
  WECOM_DEFAULT_EXTEND_TOOLS.forEach(push);
  (config?.extendTools ?? []).forEach(push);
  return out;
}

// =============================================================================
// 渠道 system prompt（Phase 2，对标 buildLarkChannelSystemPrompt 模式）
// =============================================================================

/** 企微渠道 system prompt 的章节标题（lean 卡片指回这里） */
export const WECOM_CHANNEL_PROMPT_SECTION_TITLE =
  "⭐ 企业微信回复规范（system prompt 注入版）";

/** `buildWecomChannelSystemPrompt` 入参（只允许渠道级配置，禁 event） */
export interface WecomChannelSystemPromptInput {
  /** 智能机器人 BotID（渠道身份，可选） */
  botId?: string;
}

/**
 * 构造企微渠道的 system prompt（单点构造，只读渠道配置）。
 *
 * ★ 与 buildLarkChannelSystemPrompt 同款纪律：
 *   - 构造入参**只来自渠道配置**，禁止读 event/rawEvent
 *     （否则字节漂移破坏 LLM prompt cache 前缀一致性）；
 *   - 同一入参多次调用**逐字节一致**；
 *   - per-event 动态部分（chatId/messageId/正文）只进
 *     recommendedAction 动态卡片，不进这里。
 *
 * 内容：回复命令模板 + chatId 语义（单聊=userid / 群聊=chatid）+
 * 出站纪律 + 文档交付规范（文档类生成不落本地路径，给企微可读内容）。
 */
export function buildWecomChannelSystemPrompt(
  opts: WecomChannelSystemPromptInput,
): string {
  const botLine = opts.botId
    ? `本渠道智能机器人 BotID：${opts.botId}。`
    : `本渠道未配置 BotID（使用事件回调里的 aibotid）。`;

  return [
    `# ${WECOM_CHANNEL_PROMPT_SECTION_TITLE}`,
    ``,
    `本节是企业微信渠道的**回复规范**（静态规则，随 system prompt 注入）。`,
    `每条企微事件的 \`recommendedAction\` 只带动态定位（chatId / messageId），`,
    `所有回复规则都在本节 —— replyChannel 给出的 chatId 是本轮唯一权威定位。`,
    botLine,
    ``,
    `## 回复命令（唯一出站通道）`,
    `用 \`wecom_respond\` 工具回复。工具内部**主路径是官方 CLI**`,
    `（\`wecom-cli message aibot send --msg-type markdown\`，已扫码授权），`,
    `CLI 失败时自动降级为 WS 长连接回帧（aibot_respond_msg）。`,
    `- \`content\`：**必填**，回复正文（markdown 格式）。`,
    `- \`chat_id\`：可选；缺省自动取本事件的 chatId/senderId（单聊=对方 userid，群聊=chatid）。`,
    `- \`req_id\`：可选；缺省取 metadata.reqId（仅 WS fallback 用）。`,
    `- ⚠️ 不要自己拼 \`wecom-cli\` 命令 —— 统一走 \`wecom_respond\`（chat_id 需要内部解析成真实 userid，手工拼会报 40073）。`,
    `- ⚠️ CLI 没有 text 类型；markdown 上限 20480 UTF-8 字节，超长分段压缩，不要静默截断。`,
    `- 工具返回 success=false 时如实告知用户，不要假装已发送。`,
    ``,
    `## 出站纪律`,
    `- ❌ 不要用 \`curl\` 直连 \`qyapi.weixin.qq.com\`（绕过 CLI 丢鉴权与错误规范）。`,
    `- ❌ 不要用 \`lark-cli\` 的任何 flag（--profile / --msg-type / --as bot 都不适用于企微）。`,
    `- ❌ 整次回复只发**一条**消息：先想清楚再发，不要拆段循环 send 刷屏。`,
    ``,
    `## 文档交付规范`,
    `- 文档类生成（报告 / 代码 / 长文）：企微消息里给**结论 + 关键内容摘要**，`,
    `  完整文档内容直接放进 markdown 正文（企微支持 markdown 渲染），`,
    `  **不要只给本地文件路径** —— 企微用户无法访问 roy-bot 所在机器的文件系统。`,
    `- **调研文档 / docs / ppt 等文档类产出必须上传到企微文档，链接作为交付物**：`,
    `  - 在线文档：\`wecom-cli doc create --doc-name <标题> --doc-type doc --content-type text --file-path <本地md>\``,
    `    （或 --content 传纯文本；ppt 用 --doc-type ppt），取返回里的文档链接`,
    `  - 微盘文件：\`wecom-cli disk files upload --file-path <本地文件>\`（默认传到我的空间），取返回里的文件链接`,
    `  - 本地路径只作中转（生成 → 上传企微文档 → 回复里贴链接），**不落本地路径**交付`,
    ``,
    `## 图片/文件消息处理（Task #5199）`,
    `- 用户发图片时，消息正文是 \`[image](media:downloading)\` 占位；`,
    `  媒体文件已自动下载解密落盘，本地路径在事件 metadata.mediaFiles`,
    `  （数组，如 \`/tmp/wecom-media/<chatId>/<msgid>_photo.png\`）。`,
    `- ⚠️ **只用 metadata.mediaFiles 里列出的路径**（Task #5313）——`,
    `  禁止 \`ls\`/\`find\` 扫媒体目录：同目录下的历史文件属于别的消息，`,
    `  扫目录会把它们误当本条消息的附件。`,
    `- **看图**：用 \`understand_image\` 工具，\`image_source\` 传`,
    `  metadata.mediaFiles 里的本地路径，\`prompt\` 写想了解什么。`,
    `- mediaFiles 缺失（下载失败/URL 过期）时如实告知用户，不要编造图片内容。`,
    `- ⚠️ 截图内容边界（Task #5317）：截图/图片里可能内嵌`,
    `  **其他群聊或其他会话的聊天记录**（如聊天记录截图、转发图）。`,
    `  截图里的聊天记录**不是本群的对话上下文**——分析图片时如需`,
    `  提及其中内容，必须明确标注「截图里包含的内容」，`,
    `  禁止把截图内的聊天记录当作本群刚发生的消息来转述或回应。`,
    ``,
    `## 引用消息上下文 replyContext`,
    `本条消息引用了其他消息时，user message 末尾会带 \`[引用消息] <原文>\` 行；`,
    `同时 recommendedAction.replyContext.quotedText 也有同一份内容（非文本引用为 [image] 等占位）。`,
    `- 回复时优先围绕被引用内容作答，不要忽略引用语境。`,
  ].join("\n");
}

// =============================================================================
// notify prompt（四段式）
// =============================================================================

/** `buildWecomNotifyPrompt` 入参 */
export interface WecomNotifyPromptInput {
  chatId?: string;
  messageId?: string;
  chatType?: string;
  userId?: string;
}

/**
 * 构造 notify prompt —— 四段式（与 lark-cli 版结构对齐，内容换成企微）。
 *
 * ① 用哪个 CLI 回消息
 * ② 什么 flag（--json / chat_id / msg_type / markdown.content）
 * ③ 禁什么（禁 curl、禁直连 qyapi、禁 lark-cli flag）
 * ④ 怎么判成功（exit code + 解析 error.type / error.code）
 */
export function buildWecomNotifyPrompt(input: WecomNotifyPromptInput): string {
  const isGroup = input.chatType === "group";
  const target = isGroup
    ? `群聊 chat_id = "${input.chatId ?? "<chatid>"}"`
    : `单聊 chat_id = "${input.userId ?? "<userid>"}"（企微单聊用对方 userid 作 chat_id）`;

  return [
    // ── ① 用哪个工具回消息 ─────────────────────────────────────
    `### ① 用 wecom_respond 工具回消息\n` +
      `本事件来自企业微信（WeCom）。回复用户请用 \`wecom_respond\` 工具（主路径 = 官方 wecom-cli 已授权，CLI 失败自动降级 WS 回帧），目标：${target}。\n` +
      `不要使用 lark-cli —— 那是飞书的通道，参数完全不同。`,

    // ── ② 什么参数 ────────────────────────────────────────
    `### ② 具体参数\n` +
      `调用 \`wecom_respond\` 工具：\n` +
      `- \`content\`：**必填**，回复正文（markdown）\n` +
      `- \`chat_id\`：可选；缺省自动取本事件 chatId / senderId（单聊 = 对方 userid）\n` +
      `- \`req_id\`：可选；缺省取 metadata.reqId（仅 WS fallback 用）\n` +
      `- ⚠️ 不要自己拼 \`wecom-cli\` 命令 —— chat_id 需内部解析成真实 userid，手拼会报 40073`,

    // ── ③ 禁什么 ────────────────────────────────────────────────────
    `### ③ 禁止的做法\n` +
      `- ❌ 不要用 \`curl\` 直连 \`qyapi.weixin.qq.com\` —— 绕过官方通道会丢鉴权与错误规范\n` +
      `- ❌ 不要用 \`lark-cli\` 的任何 flag（--profile / --msg-type post / --content）\n` +
      `- ❌ 不要自己编 chat_id / req_id —— 用工具默认值即可\n` +
      `- ❌ 不要在失败时假装已发送`,

    // ── ④ 怎么判成功 ──────────────────────────────────────────────
    `### ④ 怎么判断成功\n` +
      `- 工具返回 \`success: true\` = 回帧已发出\n` +
      `- 工具返回 \`success: false\` = 发送失败（读 \`error\` 字段），如实告知用户失败原因`,
  ].join("\n\n");
}

// =============================================================================
// 二进制探测（优雅降级的关键）
// =============================================================================

/**
 * 探测 `wecom-cli` 二进制是否存在。
 *
 * 为什么需要预探测：`spawn("exec <cmd>", {shell:true})` 在二进制缺失时
 * **不会同步抛错**，而是让 shell 以 exit 127 退出 —— 事件源会短暂进入
 * "running" 再变 error，状态闪烁且 CLI status 展示不及时。
 *
 * 预探测让「二进制不存在」在 start() 里**同步**变成可见的 error 状态。
 *
 * ⚠️ **Windows 兼容**（DS review MINOR M3）：Windows 上可执行文件可能是
 * `wecom-cli.exe` / `wecom-cli.cmd`，纯命令名探测必须带这些扩展名兜底，
 * 否则在 Windows 上永远判定「找不到」。
 *
 * @param binName 二进制名（默认 `wecom-cli`）
 */
export function resolveWecomBinary(binName = "wecom-cli"): { found: boolean; path?: string } {
  // 绝对路径：直接判存在
  if (isAbsolute(binName)) {
    return existsSync(binName) ? { found: true, path: binName } : { found: false };
  }
  // 相对路径（含 ./）：相对 CWD 判存在
  if (binName.includes("/")) {
    return existsSync(binName) ? { found: true, path: binName } : { found: false };
  }
  // 纯命令名：查 PATH（含 Windows 扩展名兜底）
  const pathEnv = process.env.PATH ?? "";
  const candidates = [binName, `${binName}.exe`, `${binName}.cmd`, `${binName}.bat`];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full)) return { found: true, path: full };
    }
  }
  return { found: false };
}

/**
 * 从自定义命令串里解析出「可执行文件」并探测是否存在。
 *
 * 自定义 command 的形态是 shell 命令串（`exec <cmd> <args...>`），
 * 可能带 `exec ` 前缀与引号。这里只做**保守**判定：
 * - 取第一个「像路径」的 token（含 `/`）
 * - 若是绝对路径且不存在 → 判定不可用
 * - 其它情况一律返回 found=true（不误伤，避免把正常命令判死）
 *
 * @returns found=false 表示该命令的绝对路径可执行文件不存在
 */
export function probeCommandBinary(command: string): { found: boolean; path?: string } {
  const stripped = command.trim().replace(/^exec\s+/, "");
  // 去掉引号
  const firstToken = (stripped.match(/^"[^"]+"|^'[^']+'|^\S+/) ?? [""])[0].replace(/^["']|["']$/g, "");
  if (!firstToken) return { found: true };
  if (!firstToken.includes("/")) {
    // 纯命令名 → 走 PATH 探测
    return resolveWecomBinary(firstToken);
  }
  return resolveWecomBinary(firstToken);
}

// =============================================================================
// WS 工厂（生产路径：动态 import('ws')，bounty-im-handler 同款）
// =============================================================================

/** WsBridge 需要的最小 WebSocket 面（测试 mock 友好） */
export interface WebSocketLike {
  on(ev: string, cb: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

/** 生产默认工厂：动态 import('ws')（bun/Node 双 runtime 兼容） */
export async function defaultWecomWsFactory(): Promise<
  (url: string) => WebSocketLike
> {
  const { WebSocket: Ws } = await import("ws");
  return (url: string) => new Ws(url) as unknown as WebSocketLike;
}

// =============================================================================
// Instance
// =============================================================================

/**
 * WecomCliInstance —— spawn `wecom-cli` 子进程，解析 NDJSON 行，产出事件。
 *
 * 设计原则（与 lark-cli handler 一致）：
 * - 一个 EventKey 一个子进程
 * - stdout 是 NDJSON 事件流，stderr 是状态/日志
 * - **外部二进制缺失时优雅降级**：不 crash，状态可见
 */
class WecomCliInstance implements EventSourceInstance {
  private config: EventSourceConfig;
  private status: EventSourceStatus = "created";
  private child?: ChildProcess;
  private buffer = "";
  private eventHandler?: EventSourceEventHandler;
  private lastError?: string;
  /** ★ Phase 2：长连接 WS 桥（有凭据时非空） */
  private wsBridge?: WecomWsBridge;
  /** ★ Task #5193：已加载的插件实例（name → instance） */
  private pluginInstances: Map<string, any> = new Map();
  /** ★ Task #5193：已注册的插件 hook 点（stop 时注销） */
  private loadedPlugins: Array<{ name: string; hooks: string[] }> = [];
  /** ★ Task #5203：卡片按钮 callback 端口（未注入时 template_card_event skip） */
  private cardActionPorts?: WecomCardActionPorts;
  /**
   * ★ Task #5364（B 方案）：session 卡持久层（刷新时重建整张卡的数据源）。
   *
   * 必须与 sender 用**同一个实例**（wiring 侧 `getWecomSessionCardStore()`），
   * 否则 sender 写的生命周期刷新时读不到 ⇒ 卡片永远停在「运行中」。
   */
  private sessionCardStore?: WecomSessionCardStore;

  constructor(config: EventSourceConfig) {
    this.config = config;
  }

  /**
   * ★ Task #5203：注入卡片按钮 callback 端口。
   *
   * 外部（embedder / 单测）显式注入优先；未注入时 start() 会尝试
   * 默认 cross-wire（environment.getComponent("task")）。
   */
  setCardActionPorts(ports: WecomCardActionPorts): void {
    this.cardActionPorts = ports;
    // ★ Task #5364：若 store 已先注入，补上刷新端口（??= 不覆盖显式实现）
    this.applySessionCardPorts();
  }

  /** 诊断：端口是否注入 */
  hasCardActionPorts(): boolean {
    return this.cardActionPorts !== undefined;
  }

  /**
   * ★ Task #5364（B 方案）：注入 session 卡持久层。
   *
   * 未注入 ⇒ 刷新降级为「仅活性」（卡片仍更新，只是没有生命周期/操作记录）。
   */
  setSessionCardStore(store: WecomSessionCardStore): void {
    this.sessionCardStore = store;
    this.applySessionCardPorts();
  }

  /** 诊断：session 卡持久层是否注入 */
  hasSessionCardStore(): boolean {
    return this.sessionCardStore !== undefined;
  }

  /**
   * ★ Task #5364：把持久层接到刷新端口上（`loadSessionCardState` +
   * `updateSessionCard`）。
   *
   * 为什么单独一个方法：`setCardActionPorts`（外部显式注入）与
   * `wireCardActionPorts`（默认 cross-wire）都可能先跑，两条路径都要能补上
   * 这两个端口 —— 但不能互相覆盖对方已有的实现（用 ??=）。
   */
  private applySessionCardPorts(): void {
    if (!this.cardActionPorts || !this.sessionCardStore) return;
    const store = this.sessionCardStore;

    // 读快照（B 方案刷新数据源）
    this.cardActionPorts.loadSessionCardState ??= (sessionId: string) =>
      store.get(sessionId);

    // ★ Task #5418：task 卡刷新活性回退路径的反查端口。
    //
    // task 路径 probe 依赖 BackgroundTaskManager 内存 Map（重启即丢）；
    // 反查不到时经这里从 session 卡持久层（wecom_session_card，
    // 持久化）拿 sessionId，再走 session store probe —— 避免
    // 「标题活性已刷新 + 内容暂无数据」的矛盾卡。
    //
    // ★ CV 5418 M1：多 sub-session 关联同一 task 时取**最新**一条
    //   （list() SQL 是 created_at ASC，find() 会命中最早/可能已
    //   closed 的旧会话 —— 与 findBackgroundTaskByAssociatedTaskId
    //   「多命中取最后一个（越晚越新鲜）」的成文约定一致）。
    this.cardActionPorts.findSessionCardByTaskId ??= (taskId: number) => {
      const hits = store
        .list()
        .filter((s) => s.associatedTaskId === taskId);
      if (hits.length === 0) return undefined;
      // 优先未终结的行；都终结了则取 updatedAt 最新的一条
      const open = hits.filter((s) => s.closedAt === undefined);
      const pool = open.length > 0 ? open : hits;
      return pool.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    };

    // 完整快照刷新帧（优先于旧 updateCard 路径）
    this.cardActionPorts.updateSessionCard ??= async (reqId, input) => {
      const { cmd, body } = buildWecomSessionCardUpdateBody({
        cardTaskId: input.cardTaskId,
        sessionId: input.sessionId,
        ...(input.state ? { state: input.state } : {}),
        activity: input.activity,
        // ★ Task #5419：任务信息 + 群链接透传进刷新帧
        ...(input.task ? { task: input.task } : {}),
        ...(input.perTaskChatId ? { perTaskChatId: input.perTaskChatId } : {}),
        // ★ CV 5419 MAJOR-3：失败提示透传
        ...(input.errorHint ? { errorHint: input.errorHint } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      const err = this.wsBridge?.sendFrameWithReqId({
        cmd,
        headers: { req_id: reqId },
        body,
      } as never);
      if (err) throw err;
    };

    // ★ Task #5419：session → task 反查 + 全量任务信息（刷新增强）
    this.cardActionPorts.loadSessionTaskInfo ??= async (sessionId: string) => {
      const taskComponent = this.environment?.getComponent?.("task") as
        | {
            getTaskIdBySessionId?: (
              sid: string,
            ) => Promise<number | undefined>;
            getTaskWithOperations?: (id: number) => Promise<unknown>;
          }
        | undefined;
      const getter = taskComponent?.getTaskIdBySessionId;
      if (typeof getter !== "function") return undefined;
      const taskId = await getter.call(taskComponent, sessionId);
      if (typeof taskId !== "number") return undefined; // 没建任务
      const withOps = (await taskComponent?.getTaskWithOperations?.(
        taskId,
      )) as
        | {
            title?: unknown;
            status?: unknown;
            progress?: unknown;
            operations?: Array<{
              milestoneTitle?: string;
              milestoneType?: string;
              timestamp?: string;
            }>;
          }
        | undefined;
      if (!withOps) return { id: taskId };
      const ops = Array.isArray(withOps.operations) ? withOps.operations : [];
      return {
        id: taskId,
        ...(typeof withOps.title === "string" ? { title: withOps.title } : {}),
        ...(typeof withOps.status === "string"
          ? { status: withOps.status }
          : {}),
        ...(typeof withOps.progress === "number"
          ? { progress: withOps.progress }
          : {}),
        ...(ops.length > 0
          ? {
              milestones: ops
                .slice(-10) // 最近 10 条足够（horizontal 预算 6 行）
                .map((o) => ({
                  title: String(o.milestoneTitle ?? o.milestoneType ?? ""),
                  timestamp: String(o.timestamp ?? ""),
                })),
            }
          : {}),
      };
    };
  }

  /**
   * ★ Task #5203：Environment 引用（EventSourceComponent.startSource 注入）。
   * 用于默认卡片动作端口 cross-wire（env.getComponent("task")）。
   */
  private environment?: { getComponent?: (name: string) => unknown };

  /** 注入 Environment 引用（start() 之前调用） */
  setEnvironment(env: unknown): void {
    this.environment = env as { getComponent?: (name: string) => unknown };
  }

  /** 测试/诊断：取当前 WS 桥 */
  getBridge(): WecomWsBridge | undefined {
    return this.wsBridge;
  }

  /**
   * 处理 WS 帧 → EventSourceEvent（对标 lark handleEvent 的产出契约）。
   *
   * - `aibot_msg_callback` / `aibot_event_callback` → parseWecomFrame
   *   → metadata.systemPrompt 注入渠道 prompt（单点构造、字节稳定）
   *   → replyChannel（chatId 恒非空）→ eventHandler
   * - 其它帧（认证/心跳响应）→ 忽略
   */
  async handleWsFrame(frame: unknown): Promise<void> {
    // ★ Task #5203：template_card_event（用户点卡片按钮）走专属
    //   callback handler —— 确定性动作，不走 Agent、不分发事件。
    //   必须在 parseWecomFrame 之前分流（事件帧无 msgtype 文本语义）。
    const cardAction = extractWecomCardAction(frame);
    if (cardAction) {
      await this.handleCardActionEvent(frame, cardAction);
      return;
    }

    const parsed = parseWecomFrame(frame);
    if (!parsed) return;

    // ★ DS review M1：readWecomCliConfig 只调一遍（每帧热路径）
    const { botId } = readWecomCliConfig(this.config);
    const channelPrompt = buildWecomChannelSystemPrompt(
      botId ? { botId } : {},
    );
    const metadata: EventMetadata = {
      ...parsed.metadata,
      systemPrompt: channelPrompt,
      // ★ Task #5333：渠道专用工具放行名单 —— 企微默认注入 wecom_respond
      //   （唯一出站通道），用户 config.extendTools 追加在后并去重。
      //   → run.ts / run-headless-dispatch.ts 透传到 AgentContext.extendTools
      //   → AgentComponent.getAvailableTools 据此放行 channelOnly 工具。
      extendTools: resolveWecomExtendTools(this.config),
      // ★ Task #5659：工具子进程 env（ES config toolEnv）。
      //   未配置时不写该键 —— 行为不变。下游：
      //   createEnvContext / buildRunEnvContext → EnvContext.toolEnv
      //   → wecom-cli spawn / bash spawn 合并（解决 #5654）。
      //   （normalizeToolEnv 只调一次，结果复用到两处 metadata。）
      ...(() => {
        const te = normalizeToolEnv(this.config.toolEnv);
        return te ? { toolEnv: te } : {};
      })(),
      // ★ Task #5174：req_id 透传 —— wecom_respond 工具回复时
      //   必须原样带回（aibot_respond_msg 帧的关联键）。
      reqId: parsed.reqId,
      // ★ Task #5193：plugins / pluginEnabled 注入（对齐 lark
      //   handleEvent 的 metadata 构造）—— HeadlessDispatcher
      //   据此构造 agentContext.pluginEnabled，hook-manager 的
      //   pluginEnabled 守卫才能放行（否则 hook 静默 skip）。
      plugins: this.config.handleRule?.plugins || [],
      pluginEnabled: Object.fromEntries(
        (this.config.handleRule?.plugins || []).map((p) => [
          `${this.config.id}:${p}`,
          true,
        ])
      ),
    };

    const replyChannel = buildWecomReplyChannel({
      chatId: metadata.chatId,
      messageId: metadata.messageId,
      chatType: metadata.chatType,
      userId: metadata.senderId,
      // ★ Task #5311：失败回执 WS fallback 需要（sourceId 反查实例 / reqId 被动回帧）
      sourceId: this.config.id,
      reqId: parsed.reqId,
      // ★ Task #5360（补充需求）：状态通知开关随快照带下去
      statusNotifications: this.config.statusNotifications === true,
    });

    const event: EventSourceEvent = {
      id: `es-${this.config.id}-${Date.now()}`,
      type: "event-source.event.wecom-cli",
      timestamp: Date.now(),
      metadata: {
        source: "event-source",
        sourceId: this.config.id,
        sourceMessageType: metadata.eventType,
        systemPrompt: channelPrompt,
        replyChannel,
        ...metadata,
      } as EventMetadata,
      // ★ Task #5174 根因修复：payload.message 必填 ——
      //   EventMessageFormatter.formatEventSourceEvent() 只读
      //   `payload.message`；缺失时 agent 收到的 query 是字面
      //   `"[unknown] undefined"`（实测：agent 连回 5 条「内容为空」）。
      //   形态对齐 bounty-im-handler（payload = { sourceId, sourceType,
      //   rawEvent, message, metadata, recommendedAction, replyChannel }）。
      payload: {
        sourceId: this.config.id,
        sourceType: WECOM_CLI_ES_TYPE,
        rawEvent: frame,
        // ★ Task #5271：引用内容必须进 user message。
        //   企微 user message = payload.message **纯文本**
        //   （lark 是 JSON.stringify({rawData, recommendedAction})，
        //   recommendedAction 能进 user message；企微不能）。
        //   #5251 把 quotedText 挂 recommendedAction.replyContext
        //   但 LLM 永远看不到（#5212 MAJOR-2 同型问题）。
        //   replyContext 存在时把引用内容拼进 message 正文。
        message: buildWecomUserMessage(parsed.text, metadata.replyContext),
        metadata,
        replyChannel,
        timestamp: Date.now(),
      },
      rawEvent: frame,
      replyChannel,
      recommendedAction: {
        action:
          `处理企业微信消息并回复。回复规范见 system prompt「${WECOM_CHANNEL_PROMPT_SECTION_TITLE}」章节。` +
          ` 用 wecom_respond 工具回复（content=回复正文）；` +
          `chat_id 缺省取本事件 chatId。` +
          (parsed.reqId ? `（WS fallback req_id=${parsed.reqId}）` : ""),
        replyTo: {
          chatId: replyChannel.chatId,
          messageId: replyChannel.messageId,
        },
        // ★ Task #5251：引用消息上下文挂 agent 可见位置
        //   （user message = {rawData, recommendedAction}，不含
        //   metadata 键 —— 对齐 #5212 DS review MAJOR-2 教训）。
        ...(metadata.replyContext
          ? { replyContext: metadata.replyContext }
          : {}),
        staticRulesInSystemPrompt: true,
      },
    };

    // ★ Task #5199：图片/文件消息媒体落盘。
    //   ★ DS review M1 修复（Task #5199）：**await 下载完成再分发**——
    //   fire-and-forget 存在竞态（agent 读事件时 mediaFiles 尚未注入）。
    //   下载通常几百 ms，URL 5 分钟有效本就该尽快下载；等待可接受。
    //   双保险：整体 10s 超时 + 单条失败只 log（媒体缺失不拖垮消息）。
    const mediaRefs = extractWecomMediaRefs(
      (frame as { body?: Record<string, unknown> }).body ?? {},
    );
    if (mediaRefs.length > 0 && parsed.metadata.messageId) {
      const msgid = parsed.metadata.messageId;
      // ★ Task #5313：传 chatId → 媒体按会话落子目录（跨群隔离）
      const saved = await this.downloadMediaRefs(
        msgid,
        mediaRefs,
        parsed.metadata.chatId,
      );
      if (saved.length > 0) {
        event.payload.mediaFiles = saved;
        event.metadata.mediaFiles = saved;
      }
    }

    try {
      this.eventHandler?.(event);
    } catch (err) {
      console.error(`[wecom-cli] event handler threw: ${err}`);
      // ★ Task #5311（方案 B 补漏）：不允许静默 —— 事件已解析出
      //   replyChannel 却只打日志，触发方在企微群里只会一直等。
      //   best-effort 回一条失败说明；不 await（不能阻塞帧处理），
      //   notifyReactFailure 自身已保证不抛。
      void notifyReactFailure({
        error: err,
        envEvent: event,
        replyChannel,
      }).catch(() => {
        /* 兜底 reply 永不影响主流程 */
      });
    }
  }

  /**
   * ★ Task #5203：处理 template_card_event（用户点卡片按钮）。
   *
   * 流程（对齐 lark handleCardActionEvent）：
   *   1. extractWecomCardAction 解析 event_key / task_id（handleWsFrame 已做）
   *   2. handleWecomCardAction：触发 task 操作 + 构造更新帧
   *   3. 经 bridge.respond（aibot_respond_update_msg，req_id 透传）
   *      在 5 秒窗口内更新卡片
   *
   * 端口未注入 → warn + skip（不阻塞其他事件处理）。
   */
  private async handleCardActionEvent(
    frame: unknown,
    action: ReturnType<typeof extractWecomCardAction>,
  ): Promise<void> {
    if (!this.cardActionPorts) {
      console.warn(
        `[wecom-cli] handleCardActionEvent: cardActionPorts 未注入，` +
          `template_card_event 被跳过（event_key=${action?.eventKey}）。` +
          `调 instance.setCardActionPorts({markTaskDone, reopenTask, updateCard}) 注入。`,
      );
      return;
    }
    try {
      const result = await handleWecomCardAction(frame, this.cardActionPorts);
      if (!result.ok) {
        console.warn(
          `[wecom-cli] handleCardActionEvent failed: ${result.error ?? "unknown"}`,
        );
      }
    } catch (err) {
      console.error(
        `[wecom-cli] handleCardActionEvent threw: ${(err as Error).message}`,
      );
    }
  }

  /**
   * ★ Task #5203：默认卡片动作端口 cross-wire。
   *
   * - markTaskDone / reopenTask ← environment.getComponent("task").updateTask
   * - updateCard ← bridge.respond（aibot_respond_update_msg）
   *
   * 外部显式注入（setCardActionPorts）优先，不覆盖。
   */
  private wireCardActionPorts(): void {
    if (this.cardActionPorts) return;

    const taskComponent = this.environment?.getComponent?.("task") as
      | {
          updateTask?: (
            id: number,
            options: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      | undefined;

    // ★ Task #5364（B 方案）：task 端口与 session 卡刷新端口**解耦**。
    //
    // 旧逻辑：`!taskComponent.updateTask || !wsBridge` 一律 early-return ⇒
    // **连 session 卡刷新也一起死掉**。但 session 卡刷新根本不需要 task
    // （它读 session store + 实时活性），只需要 wsBridge 能发帧。所以在
    // 「插件以 no-task 形态部署 / task 组件未注册」时，B 方案的刷新会
    // 完全不可用 —— 这正是要避免的静默失效。
    //
    // 新逻辑：只有 wsBridge 是硬前提（没有它连一帧都发不出）；
    // taskComponent 缺失 → task 动作降级为「明确报错」，session 刷新照常可用。
    if (!this.wsBridge) {
      console.warn(
        `[wecom-cli] cardActionPorts 未注入：wsBridge 缺失（没有通道发更新帧）。` +
          `卡片按钮点击会被跳过。`,
      );
      return;
    }

    const taskOpsAvailable = typeof taskComponent?.updateTask === "function";
    if (!taskOpsAvailable) {
      console.warn(
        `[wecom-cli] taskComponent.updateTask 不可用 ⇒ 「标记完成 / 重新打开」` +
          `降级为报错；session 卡「刷新」不受影响（Task #5364）。`,
      );
    }

    /** task 动作的统一降级实现（明确抛错，不静默假装成功） */
    const requireTaskOps = (): void => {
      if (!taskOpsAvailable) {
        throw new Error("task ops unavailable (taskComponent.updateTask missing)");
      }
    };

    this.cardActionPorts = {
      markTaskDone: async (taskId) => {
        requireTaskOps();
        await taskComponent!.updateTask!(taskId, {
          status: "completed",
          current_status: "用户在企微卡片点「标记完成」确认完成",
        });
      },
      reopenTask: async (taskId) => {
        requireTaskOps();
        await taskComponent!.updateTask!(taskId, {
          status: "active",
          current_status: "用户在企微卡片点「重新打开」",
        });
      },
      updateCard: async (
        reqId,
        cardTaskId,
        statusLabel,
        note,
        timeline,
        action,
        extra,
      ) => {
        // ★ Task #5203 回归修复：必须保留 buildWecomCardUpdateBody
        //   的 cmd（aibot_respond_update_msg）——卡片更新走
        //   respond_update 帧，不能用 respond()（它硬包成
        //   aibot_respond_msg，服务端静默拒绝 → 卡片不更新）。
        //   sendCmd 保留 cmd，req_id 由 headers 透传。
        const { cmd, body } = buildWecomCardUpdateBody({
          cardTaskId,
          statusLabel,
          note,
          timeline,
          action,
          // ★ Task #5273：任务号+标题渲染进更新卡 main_title
          taskTitle: extra?.taskTitle,
          taskNumber: extra?.taskNumber,
          // ★ Task #5360：sub-session 活性（undefined = 不渲染）
          ...(extra?.activity !== undefined ? { activity: extra.activity } : {}),
          // ★ CV MAJOR-2：终态透传（决定 ⚪已结束 vs 🔴疑似停滞）
          ...(extra?.activityTerminal !== undefined
            ? { activityTerminal: extra.activityTerminal }
            : {}),
        });
        const frame = {
          cmd,
          headers: { req_id: reqId },
          body,
        };
        const err = this.wsBridge!.sendFrameWithReqId(frame);
        if (err) throw err;
      },
      // ★ Task #5203：view 动作 → 从插件共享的 cardStateStore 读时间线
      loadTimeline: (taskId) => {
        const store = this.getWecomCardStateStore();
        if (!store) return [];
        const rec = store.get(taskId);
        if (!rec?.timeline) return [];
        try {
          const arr = JSON.parse(rec.timeline);
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      },
      // ★ Task #5273：读任务号+标题（更新卡 main_title 渲染用）
      loadTaskTitle: (taskId) => {
        const taskComponent = this.environment?.getComponent?.("task") as
          | {
              getTask?: (id: number) => Promise<unknown> | unknown;
            }
          | undefined;
        // ★ CV-m2（Task #5273 返工）：删掉 taskComponent.get 兜底
        //   （TaskComponent 无 get 方法，纯死代码），只认 getTask。
        const getter = taskComponent?.getTask;
        if (!getter) return undefined;
        try {
          const raw = getter.call(taskComponent, taskId) as
            | Promise<unknown>
            | unknown;
          // getTask 可能返回 Promise 或同步值，统一处理
          const extract = (t: unknown) => {
            if (!t || typeof t !== "object") return undefined;
            const rec = t as { id?: number; title?: string };
            if (typeof rec.title !== "string" || !rec.title) return undefined;
            return {
              title: rec.title,
              number: typeof rec.id === "number" ? rec.id : taskId,
            };
          };
          if (
            raw &&
            typeof (raw as Promise<unknown>).then === "function"
          ) {
            // ★ CV-B1（Task #5273 返工）：Promise 必须 .catch —— 消费端
            //   doHandle 已 await + try/catch，这里兜一层防 unhandledRejection。
            return (raw as Promise<unknown>)
              .then(extract)
              .catch((err: unknown) => {
                console.warn(
                  `[wecom-cli] loadTaskTitle failed for task #${taskId}: ${err}`,
                );
                return undefined;
              });
          }
          return extract(raw);
        } catch (err) {
          console.warn(
            `[wecom-cli] loadTaskTitle failed for task #${taskId}: ${err}`,
          );
          return undefined;
        }
      },
    };
    // ★ Task #5360：sub-session 活性 probe（「刷新活性」按钮用）
    //
    // 与飞书侧 `event-source-handlers.ts` 用**同一个工厂** `createActivityProbe`
    // —— 两渠道的 liveness 阈值 / 截断 / taskId 反查规则必须逐字一致，
    // 否则同一个任务在飞书显示 🟢、企微显示 🔴。
    this.cardActionPorts.loadSubSessionActivity = createActivityProbe({
      listBackgroundTasks: () => {
        const tc = this.environment?.getComponent?.("task") as
          | {
              getBackgroundTaskManager?: () => {
                listTasks?: () => Array<{
                  id: string;
                  subSessionId: string;
                  associatedTaskId?: number;
                }>;
              } | undefined;
            }
          | undefined;
        return tc?.getBackgroundTaskManager?.()?.listTasks?.();
      },
      getSubSessionActivity: (bgId) => {
        const tc = this.environment?.getComponent?.("task") as
          | {
              getBackgroundTaskManager?: () => {
                getSubSessionActivity?: (
                  id: string,
                ) => Promise<
                  { messageCount: number; updatedAt: number } | undefined
                >;
              } | undefined;
            }
          | undefined;
        return tc?.getBackgroundTaskManager?.()?.getSubSessionActivity?.(bgId);
      },
      getLastMessage: async (subSessionId) => {
        const sc = this.environment?.getComponent?.("session") as
          | {
              getMessages?: (
                id: string,
                opts?: { offset?: number; limit?: number },
              ) => Promise<
                Array<{ role?: string; content?: string; timestamp?: number }>
              >;
            }
          | undefined;
        if (!sc?.getMessages) return undefined;
        // 负 offset = 从尾部取（sqlite 实现折算成 total-1）
        const tail = await sc.getMessages(subSessionId, { offset: -1, limit: 1 });
        return toActivityMessage(tail?.[tail.length - 1]);
      },
      isTerminalTask: async (taskId: number) => {
        const tc = this.environment?.getComponent?.("task") as
          | { getTask?: (id: number) => Promise<unknown> | unknown }
          | undefined;
        const raw = tc?.getTask?.call(tc, taskId);
        const t = (raw && typeof (raw as Promise<unknown>).then === "function"
          ? await (raw as Promise<unknown>)
          : raw) as { status?: string } | undefined;
        return (
          t?.status === "completed" ||
          t?.status === "cancelled" ||
          t?.status === "failed" ||
          t?.status === "archived"
        );
      },
    });

    // ★ Task #5364 返工（BLOCKER-1 企微侧同源）：**session-only 活性端口真注入**。
    //
    // 上一版 `createSessionActivityProbe` 在生产零注入（只有单测构造）⇒ 企微
    // 卡片点「刷新详情」也永远拿不到「消息数 + 最近一条消息」。
    //
    // 与飞书侧用同一个工厂 + 同一份 `mapBgTaskStatusToSessionLifecycle`，
    // 保证同一 session 在两渠道的生命周期/活性文案逐字一致。
    this.cardActionPorts.loadSessionActivity = createSessionActivityProbe({
      getSession: async (sessionId: string) => {
        const sc = this.environment?.getComponent?.("session") as
          | {
              get?: (
                id: string,
              ) => Promise<
                { messageCount?: number; updatedAt?: number } | undefined
              >;
            }
          | undefined;
        if (!sc?.get) return undefined;
        const s = await sc.get(sessionId);
        if (!s) return undefined;
        return {
          ...(typeof s.messageCount === "number"
            ? { messageCount: s.messageCount }
            : {}),
          ...(typeof s.updatedAt === "number" ? { updatedAt: s.updatedAt } : {}),
        };
      },
      getLastMessage: async (sessionId: string) => {
        const sc = this.environment?.getComponent?.("session") as
          | {
              getMessages?: (
                id: string,
                opts?: { offset?: number; limit?: number },
              ) => Promise<
                Array<{ role?: string; content?: string; timestamp?: number }>
              >;
            }
          | undefined;
        if (!sc?.getMessages) return undefined;
        const tail = await sc.getMessages(sessionId, { offset: -1, limit: 1 });
        return toActivityMessage(tail?.[tail.length - 1]);
      },
      getLifecycle: (sessionId: string) => {
        const tc = this.environment?.getComponent?.("task") as
          | {
              getBackgroundTaskManager?: () => {
                listTasks?: () => Array<{ subSessionId?: string; status?: string }>;
              } | undefined;
            }
          | undefined;
        const tasks = tc?.getBackgroundTaskManager?.()?.listTasks?.() ?? [];
        const hit = tasks.find((t) => t?.subSessionId === sessionId);
        return mapBgTaskStatusToSessionLifecycle(hit?.status);
      },
    });

    // ★ Task #5364（B 方案）：把 session 卡持久层接到刷新端口。
    //
    // ★★ 这里是**生产真接线**（不是测试注入）：store 取 core 侧进程级共享
    //    单例 —— 与 `event-handler-wiring.ts` 里 sender 用的**同一个实例**。
    //    两处各建一个 = sender 写 A、刷新读 B ⇒ 卡片永远停在「运行中」。
    //    外部若已 `setSessionCardStore(...)` 显式注入，??= 不覆盖。
    this.sessionCardStore ??= getSharedWecomSessionCardStore();
    this.applySessionCardPorts();

    // ★ Task #5419：建关联飞书群三端口（对齐飞书 #5397/#5403）。
    //
    // 建群目标 = **飞书群**（独立群 session + 1 条 user 背景事件 +
    // metadata linkedFromSessionId），企微卡只是遥控入口。
    // 全部 best-effort：sessionComponent 缺失只降级，不阻断建群。
    if (this.cardActionPorts) {
      const sessionComponent = () =>
        this.environment?.getComponent?.("session") as
          | {
              findGroupChatForSession?: (
                sid: string,
              ) => Promise<{ chatId: string } | undefined>;
              attachGroupSession?: (args: {
                chatId: string;
                originSessionId: string;
                title?: string;
              }) => Promise<unknown>;
              get?: (id: string) => Promise<{ title?: string } | undefined>;
            }
          | undefined;

      // 会话 → 群 反查（幂等防重复建群）
      this.cardActionPorts.findGroupChatForSession ??= async (sessionId) => {
        const sc = sessionComponent();
        if (typeof sc?.findGroupChatForSession !== "function") {
          return undefined;
        }
        return sc.findGroupChatForSession(sessionId);
      };

      // 建群：lark-cli +chat-create → attachGroupSession 初始化群 session
      this.cardActionPorts.createLarkGroupForSession ??= async (sessionId) => {
        const sc = sessionComponent();
        // 群名：优先会话标题，退化 sessionId 截断
        let title: string | undefined;
        try {
          const s = await sc?.get?.(sessionId);
          if (typeof s?.title === "string" && s.title.trim()) {
            title = s.title.trim();
          }
        } catch {
          /* 读不到标题用 sessionId 兜底 */
        }
        const name = title ?? sessionId.slice(-20);
        const chatId = await createGroupChatViaLarkCli({
          name: `会话 ${name}`.slice(0, 60),
          description: `roy-bot session ${sessionId}`.slice(0, 100),
        });
        // 初始化群 session（独立会话 + 1 条 user 背景事件）——best-effort
        try {
          await sc?.attachGroupSession?.({
            chatId,
            originSessionId: sessionId,
            title: name,
          });
        } catch (err) {
          console.warn(
            `[wecom-cli] attachGroupSession(${chatId} ← ${sessionId}) ` +
              `失败（不阻断建群）: ${err}`,
          );
        }
        return chatId;
      };

      // 建群成功 → 发一条企微消息带飞书群 applink（best-effort）
      //
      // ★ CV 5419 BLOCKER-1：通知目标必须是**企微会话**，不是
      //   飞书群（input.chatId 是 oc_xxx 飞书群 id，企微 CLI 不认）。
      //   目标优先级：点击者 userId（单聊=userid）→ session store
      //   里的 chatId（发卡时的企微会话，群聊场景是群 chatid）。
      this.cardActionPorts.notifyGroupLink ??= async (input) => {
        const link = `${DEFAULT_APP_LINK_BASE}/client/chat/open?openChatId=${input.chatId}`;
        const text =
          `📨 会话 ${input.sessionId} 的关联飞书群已建立：` +
          `[点击进入群](${link})`;
        let target = input.userId || "";
        if (!target) {
          try {
            target = this.sessionCardStore?.get(input.sessionId)?.chatId ?? "";
          } catch {
            target = "";
          }
        }
        if (!target) {
          console.warn(
            `[wecom-cli] notifyGroupLink: 无法定位企微会话 ` +
              `(userId 缺失且 session store 无 chatId)，跳过通知`,
          );
          return;
        }
        const r = await sendWecomCliMarkdown({ chatId: target, content: text });
        if (!r.ok) {
          console.warn(
            `[wecom-cli] notifyGroupLink cli failed: ` +
              `${r.ok ? "unknown" : (r as { error: string }).error}`,
          );
        }
      };
    }

    console.info(
      `[wecom-cli] cardActionPorts 已注入（task ops + bridge.respond 更新 + timeline + taskTitle + activity + session task info + lark group）`,
    );
  }

  /**
   * ★ Task #5203：取插件共享的 cardStateStore。
   *
   * WecomTaskNotifyHook 持有持久化时间线（wecom-cards.db）；
   * view 动作从这里读（与进展卡同一数据源，重启后仍完整）。
   * 插件未加载 → undefined（降级为空时间线）。
   */
  /**
   * ★ Task #5250：插件未加载时降级为懒创建的持久化 store。
   *
   * 此前插件未加载（如 handleRule.plugins 未配置）→ undefined
   * → view/刷新读不到时间线（降级为空）。现在回落到
   * createWecomCardStateStore()（~/.local/share/roy-bot/wecom-cards.db，
   * 失败自动降级内存实现）——重启后映射不丢，刷新仍可用。
   */
  private getWecomCardStateStore():
    | { get: (taskId: number) => { timeline?: string } | undefined }
    | undefined {
    const plugin = this.pluginInstances.get("WecomTaskNotifyPlugin");
    const store = plugin?.cardStateStore;
    if (store && typeof store.get === "function") {
      return store as { get: (t: number) => { timeline?: string } | undefined };
    }
    if (!this.fallbackCardStateStore) {
      try {
        this.fallbackCardStateStore = createWecomCardStateStore();
      } catch (err) {
        console.warn(
          `[wecom-cli] fallback card state store 创建失败: ${err}`,
        );
        return undefined;
      }
    }
    return this.fallbackCardStateStore as {
      get: (t: number) => { timeline?: string } | undefined;
    };
  }

  /**
   * ★ Task #5250：懒创建的降级持久化 store（插件未加载时用）。
   * DS review（#5250）M-1：保留完整类型（含 close），
   * stop 时显式关闭防 SQLite 句柄泄漏。
   */
  private fallbackCardStateStore?: {
    get: (taskId: number) => { timeline?: string } | undefined;
    close?: () => void;
  };

  /**
   * 下载媒体引用（Task #5199，DS review M1 修复）。
   *
   * - 落盘按 chatId 分子目录（Task #5313，跨群媒体隔离）；
   * - 整体 10s 超时（URL 5 分钟有效，超时说明网络异常）；
   * - 单条失败只 log（媒体缺失不拖垮消息处理）；
   * - 返回成功落盘的本地路径列表。
   */
  private async downloadMediaRefs(
    msgid: string,
    refs: ReturnType<typeof extractWecomMediaRefs>,
    chatId?: string,
  ): Promise<string[]> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("media download timeout (10s)")), 10_000),
    );
    try {
      const paths = await Promise.race([
        timeout,
        Promise.all(
          refs.map(async (ref) => {
            try {
              const path = await fetchAndSaveWecomMedia({
                msgid,
                url: ref.url,
                aeskey: ref.aeskey,
                kind: ref.kind,
                filename: ref.filename,
                // ★ Task #5313：落盘到 <mediaDir>/<chatId>/ 实现跨群隔离
                chatId,
              });
              console.log(
                `[wecom-cli] media saved: ${ref.kind} chat=${chatId ?? "(none)"} ${path}`,
              );
              return path;
            } catch (err) {
              console.error(
                `[wecom-cli] media download failed for ${ref.kind}: ${(err as Error).message}`,
              );
              return undefined;
            }
          }),
        ),
      ]);
      return (paths as Array<string | undefined>).filter(
        (p): p is string => !!p,
      );
    } catch (err) {
      console.error(`[wecom-cli] media download aborted: ${(err as Error).message}`);
      return [];
    }
  }

  getStatus(): EventSourceStatus {
    return this.status;
  }

  setStatus(status: EventSourceStatus): void {
    this.status = status;
  }

  onEvent(handler: EventSourceEventHandler): void {
    this.eventHandler = handler;
  }
  offEvent(): void {
    this.eventHandler = undefined;
  }

  /** 最后一次错误（供 CLI status 展示） */
  getLastError(): string | undefined {
    return this.lastError;
  }

  /**
   * 构造默认命令。
   *
   * ⚠️ **Phase 1 是骨架**：这里的占位命令**不会产出任何事件**（只是打印帮助）。
   * 真正的入站要等 Phase 2/3 —— 把长连接桥接进程（`@wecom/aibot-node-sdk` 的
   * `WSClient`，协议见官方文档 101463）接到这里，输出 NDJSON 事件流。
   *
   * 为避免用户误以为「已经在收消息了」，`start()` 会打一条醒目告警。
   */
  private buildCommand(): string {
    const { command } = readWecomCliConfig(this.config);
    if (command) return command;
    return "wecom-cli chat messages list --help";
  }

  /**
   * ★ Task #5193：加载 handleRule.plugins 中指定的插件。
   *
   * 复用 es-plugins.ts 共享逻辑（与 LarkCliInstance 同语义）：
   * - BUILT_IN_PLUGIN_FACTORIES 按名实例化（工厂表由 handlers 注入）
   * - Hook 模式插件按 5 个 task hook 点注册到 globalHookManager
   * - pluginEnabled 检查 key = `${sourceId}:${pluginName}`
   *
   * ⚠️ 此前 handleRule.plugins 配在 wecom 源上是 **dead config**
   *   （插件机制只存在于 LarkCliInstance）—— 本方法补齐缺口。
   */
  private loadPlugins(): void {
    const plugins = this.config.handleRule?.plugins || [];
    if (plugins.length === 0) return;

    for (const pluginName of plugins) {
      const pluginConfig =
        this.config.handleRule?.pluginConfig?.[pluginName] ?? {};
      const plugin = importPluginShared(
        pluginName,
        getWecomPluginFactories(),
        {
          sourceId: this.config.id,
          pluginName,
          // ★ Task #5360（补充需求）：ES 配置的状态通知开关透传给插件。
          //
          // 为什么由这里注入而不是插件自己读：插件不持 ES 配置句柄，且同一
          // 进程可能有多个 wecom 源 —— 把**该源自己的**配置值传进去语义最准。
          // 插件内会再 `=== true` 严判（防 pluginConfig 里被写成 "true" 字符串）。
          statusNotifications: this.config.statusNotifications === true,
          ...pluginConfig,
        } as PluginFactoryConfig
      );
      if (!plugin) continue;

      this.pluginInstances.set(pluginName, plugin);
      const hookPoints = registerPluginHooksShared(
        plugin,
        pluginName,
        this.config.id
      );
      this.loadedPlugins.push({ name: pluginName, hooks: hookPoints });
      console.debug(
        `[wecom-cli] Loaded plugin "${pluginName}" with ` +
          `${hookPoints.length} hook(s): [${hookPoints.join(", ")}]`
      );
    }
  }

  /** 注销插件 hooks（stop 时调用，防泄漏 + 防重复注册） */
  private unloadPlugins(): void {
    for (const p of this.loadedPlugins) {
      unregisterPluginHooksShared(p.name, p.hooks);
    }
    this.loadedPlugins = [];
    this.pluginInstances.clear();
  }

  async start(): Promise<void> {
    // ★ Task #5193：先加载 handleRule.plugins（对齐 LarkCliInstance.start）
    //   必须先于 WS 桥启动 —— hook 注册完成后事件才能被插件消费。
    this.loadPlugins();

    // ★ Phase 2（Task #5165）：有凭据 → 长连接 WS 模式（真实收消息）；
    //   无凭据 → 骨架模式（占位命令 + 告警）。
    await this.startWithBridge(await defaultWecomWsFactory());
  }

  /**
   * Phase 2 主入口：凭据解析 → WS 桥或骨架模式。
   *
   * @param wsFactory WebSocket 工厂（测试注入 mock；生产用真实 ws）
   * @param credentialsPath 凭据文件路径（测试覆盖；默认 ~/.roy-bot/wecom-credentials.json）
   */
  async startWithBridge(
    wsFactory: (url: string) => WebSocketLike,
    credentialsPath?: string,
  ): Promise<void> {
    if (this.status === "running") return;
    this.setStatus("starting");

    // ── 凭据解析：config 显式 > 凭据文件 > 无 ─────────────────
    const credentials = resolveWecomCredentials(this.config, credentialsPath);

    if (credentials) {
      // ── 长连接 WS 模式（真实收消息）────────────────────────
      this.startWsBridge(credentials, wsFactory);
      return;
    }

    // ── 骨架模式（无凭据降级）──────────────────────────────
    this.startSkeletonMode();
  }

  /** 长连接 WS 模式：建桥 + connect + 事件分发 */
  private startWsBridge(
    credentials: WecomCredentials,
    wsFactory: (url: string) => WebSocketLike,
  ): void {
    const bridge = new WecomWsBridge({
      botId: credentials.botId,
      secret: credentials.secret,
      wsFactory: wsFactory as unknown as (url: string) => import("ws").WebSocket,
    });
    this.wsBridge = bridge;
    // ★ Task #5174：登记到回复注册表 —— wecom_respond 工具
    //   通过 sourceId 找到这里，把 agent 回复经 WS 发回企微。
    registerWecomRespondTarget(this.config.id, {
      respond: (reqId, body) => bridge.respond(reqId, body),
      // ★ Task #5203：主动推送（aibot_send_msg 直发 template_card）
      sendCmd: (cmd, body) => bridge.sendCmd(cmd, body),
    });
    // ★ Task #5203：卡片动作端口 cross-wire（bridge 已就绪）
    this.wireCardActionPorts();
    bridge.onMessage((frame) => {
      void this.handleWsFrame(frame).catch((err: unknown) => {
        console.error(`[wecom-cli] ws frame handling threw: ${err}`);
        // ★ Task #5311（方案 B 补漏）：整帧处理失败时尽力回触发方。
        //   帧可能还没解析出 replyChannel（parseWecomFrame 失败的场景
        //   无目标可回）—— 此时 notifyReactFailure 走 no_channel 分支
        //   只 warn，不抛，不影响主流程。
        //   ★ CV M1：补 sourceId / reqId 进 params —— 否则 WS fallback
        //   拿不到注册实例（sourceId="unknown"），只剩 CLI 一条路。
        try {
          const parsed = parseWecomFrame(frame);
          if (!parsed) {
            /* 帧解析失败 → 无目标可回，只能 log（上面已 console.error） */
            return;
          }
          const baseChannel = buildWecomReplyChannel({
            chatId: parsed.metadata.chatId,
            messageId: parsed.metadata.messageId,
            chatType: parsed.metadata.chatType,
            userId: parsed.metadata.senderId,
            sourceId: this.config.id,
            reqId: parsed.reqId,
            // ★ Task #5360（补充需求）：状态通知开关随快照带下去
            statusNotifications: this.config.statusNotifications === true,
          });
          void notifyReactFailure({
            error: err,
            envEvent: {
              type: "event-source.event.wecom-cli",
              metadata: {
                sourceId: this.config.id,
                replyChannel: baseChannel,
              },
              payload: {},
            },
          }).catch(() => {
            /* 兜底 reply 永不影响主流程 */
          });
        } catch {
          /* 连帧解析都失败 → 无目标可回，只能 log */
        }
      });
    });
    bridge.onError((err) => {
      this.lastError = err.message;
      console.error(`[wecom-cli] ws error: ${err.message}`);
    });
    bridge.connect();
    this.setStatus("running");
  }

  /** 骨架模式（Phase 1 行为保持）：占位命令 + 醒目告警 */
  private startSkeletonMode(): void {
    console.warn(
      `[wecom-cli] ⚠️ 骨架模式：未找到企微凭据（config botId/secret 或 ` +
        `${WECOM_CREDENTIALS_DEFAULT_PATH}），**不会收到任何入站消息**。\n` +
        `[wecom-cli]    请在 event source 配置里提供 botId + secret，或创建凭据文件（chmod 600）。\n` +
        `[wecom-cli]    如需临时自定义，可在事件源配置里设置 'command' 字段。`,
    );
    this.startSkeletonSpawn();
  }

  /** 骨架模式的占位命令 spawn（Phase 1 原逻辑原样保留） */
  private startSkeletonSpawn(): void {
    const { command: customCommand } = readWecomCliConfig(this.config);

    // ⚠️ 骨架模式告警（DS review MINOR M1）：占位命令**不会产出事件**，
    //   不告警的话用户会以为「已经在收消息了」但永远收不到。
    //   ⚠️ 必须放在二进制探测**之前** —— 否则二进制缺失时先 return，
    //   用户连「这是骨架模式」都看不到。
    if (!customCommand) {
      console.warn(
        `[wecom-cli] ⚠️ 骨架模式：当前启动的是占位命令 ` +
          `"wecom-cli chat messages list --help"，它**不会产出任何入站事件**。\n` +
          `[wecom-cli]    Phase 2 长连接需要凭据（config botId/secret 或凭据文件）。\n` +
          `[wecom-cli]    如需临时自定义，可在事件源配置里设置 'command' 字段。`,
      );
    }

    // ★ 预探测二进制：不存在就**同步**降级，不 spawn、不假装 running。
    if (customCommand) {
      // 自定义命令：只在其可执行文件是绝对/相对路径时做存在性判定
      const probe = probeCommandBinary(customCommand);
      if (!probe.found) {
        this.lastError = `wecom-cli command not found: ${customCommand}`;
        this.setStatus("error");
        return;
      }
    } else {
      const bin = resolveWecomBinary();
      if (!bin.found) {
        this.lastError =
          "wecom-cli binary not found on PATH. " +
          "Install it with: npm install -g @wecom/cli --registry=https://registry.npmmirror.com " +
          "(or set 'command' in the event source config to override the launch command).";
        this.setStatus("error");
        return;
      }
    }

    const command = this.buildCommand();

    let child: ChildProcess;
    try {
      child = spawn(`exec ${command}`, [], {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      // ★ 优雅降级：二进制不存在 → 不 crash，记错误 + 状态非 running
      this.lastError = `failed to spawn wecom-cli: ${(err as Error).message}`;
      this.setStatus("error");
      return;
    }

    this.child = child;

    child.stdout?.on("data", (data: Buffer) => {
      this.processStdout(data.toString());
    });

    child.stderr?.on("data", (data: Buffer) => {
      // stderr 是日志/错误，不解析为事件
      const text = data.toString().trim();
      if (text) {
        this.lastError = text.slice(0, 500);
        console.error(`[wecom-cli] ${text}`);
      }
    });

    child.on("error", (err) => {
      // ENOENT 等 spawn 异步错误
      this.lastError = `wecom-cli process error: ${err.message}`;
      this.setStatus("error");
    });

    child.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGINT" && signal !== "SIGTERM") {
        this.lastError = `wecom-cli exited with code ${code}`;
        this.setStatus("error");
      } else {
        this.setStatus("stopped");
      }
    });

    this.setStatus("running");
  }

  /** 处理 stdout 的 NDJSON 行流 */
  private processStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleEventLine(trimmed);
    }
  }

  /** 处理单行 JSON 事件 */
  private handleEventLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // 非 JSON 行：不是事件，但**必须留痕**（DS review MINOR M2）——
      // 静默忽略会让桥接进程的调试输出变成黑洞，无法排查。
      console.error(
        `[wecom-cli] skipping non-JSON line: ${line.slice(0, 200)}`,
      );
      return;
    }
    const parsed = parseWecomFrame(raw);
    if (!parsed) {
      console.error(
        `[wecom-cli] skipping non-event frame: ${JSON.stringify(raw).slice(0, 200)}`,
      );
      return;
    }

    const replyChannel = buildWecomReplyChannel({
      chatId: parsed.metadata.chatId,
      messageId: parsed.metadata.messageId,
      chatType: parsed.metadata.chatType,
      userId: parsed.metadata.senderId,
      // ★ Task #5311：失败回执 WS fallback 需要
      sourceId: this.config.id,
      reqId: parsed.reqId,
      // ★ Task #5360（补充需求）：状态通知开关随快照带下去
      statusNotifications: this.config.statusNotifications === true,
    });

    const event: EventSourceEvent = {
      metadata: parsed.metadata,
      // ★ Task #5174：骨架路径同样必须带 payload.message（见 handleWsFrame）
      payload: {
        sourceId: this.config.id,
        sourceType: WECOM_CLI_ES_TYPE,
        rawEvent: raw,
        // ★ Task #5271：骨架路径同步修（见 handleWsFrame 内注释）
        message: buildWecomUserMessage(
          parsed.text,
          parsed.metadata.replyContext,
        ),
        metadata: parsed.metadata,
        replyChannel,
        timestamp: Date.now(),
      },
      rawEvent: raw,
      replyChannel,
      recommendedAction: {
        description: "Reply to the WeCom user via `wecom-cli message aibot send --json ...`",
        command: `wecom-cli message aibot send --json '{"chat_id":"${
          parsed.metadata.chatId ?? parsed.metadata.senderId ?? ""
        }","msg_type":"markdown","markdown":{"content":"..."}}'`,
        notes: [
          "企微单聊的 chat_id 是对方 userid；群聊的 chat_id 是回调里的 chatid。",
          "发送成功 = 退出码 0 且 stdout 无 error 字段。",
        ],
      },
    };

    if (this.eventHandler) {
      try {
        this.eventHandler(event);
      } catch (err) {
        console.error(`[wecom-cli] event handler threw: ${err}`);
        // ★ Task #5311（方案 B 补漏）：骨架路径同样不允许静默
        void notifyReactFailure({
          error: err,
          envEvent: event,
          replyChannel,
        }).catch(() => {
          /* 兜底 reply 永不影响主流程 */
        });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "created") return;
    // ★ Task #5193：注销插件 hooks（防泄漏 + 防重复注册）
    this.unloadPlugins();
    // ★ Phase 2：先停 WS 桥（手动关闭，不再重连）
    if (this.wsBridge) {
      // ★ Task #5174：先注销回复注册表（防泄漏 + 防止向已停桥发送）
      unregisterWecomRespondTarget(this.config.id);
      this.wsBridge.stop();
      this.wsBridge = undefined;
    }
    // ★ Task #5250（DS review M-1）：显式 close 防 SQLite 句柄泄漏
    try {
      this.fallbackCardStateStore?.close?.();
    } catch {
      // close 失败不影响主流程
    }
    this.fallbackCardStateStore = undefined;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGINT");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.child && !this.child.killed) this.child.kill("SIGKILL");
          resolve();
        }, 3000);
        if (this.child) {
          this.child.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        } else {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    this.setStatus("stopped");
  }
}

// =============================================================================
// Handler
// =============================================================================

export const wecomCliHandler: EventSourceHandler = {
  type: WECOM_CLI_ES_TYPE,

  validateConfig(config: EventSourceConfig): string[] {
    const errors: string[] = [];
    if (!config.id) errors.push("EventSource ID is required");
    if (!config.name) errors.push("EventSource name is required");

    const { botId, secret } = readWecomCliConfig(config);
    if (!botId) {
      errors.push(
        "WeCom 'botId' is required (企业微信智能机器人的 BotID；CLI 用 --bot-id 传入)",
      );
    }
    if (!secret) {
      errors.push(
        "WeCom 'secret' is required (智能机器人 Secret；CLI 用 --secret 传入)",
      );
    }
    return errors;
  },

  createInstance(config: EventSourceConfig): EventSourceInstance {
    return new WecomCliInstance(config);
  },

  getOptions() {
    return [
      { name: "botId", description: "企业微信智能机器人 BotID", required: true, type: "string" },
      { name: "secret", description: "智能机器人 Secret（长连接专用密钥）", required: true, type: "string" },
      { name: "webhook", description: "群机器人 webhook URL（可选）", required: false, type: "string" },
      { name: "command", description: "覆盖默认启动命令（高级）", required: false, type: "string" },
    ];
  },
};
