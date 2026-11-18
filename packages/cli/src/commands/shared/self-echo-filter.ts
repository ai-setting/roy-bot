/**
 * @fileoverview Task #4552 (A1 BLOCKING) — 自我回声过滤（防御纵深）
 *
 * ## 缺陷背景（真实 E2E 实测，本机 E2E 报告 `reports/4552-a1-real-e2e.md` §6（`reports/` 被 .gitignore 忽略，未入库））
 *
 * A1 的 telemetry 提示最初用 `lark-cli im +messages-send` **不带** `--as bot`
 * 发出，默认身份是 **user（开发者本人）**。`im.message.receive_v1` 只关心
 * 「是不是 user 发的消息」，于是这条自己发出去的提示被**同一个** lark-cli
 * consumer 当作用户消息**回灌**，又跑一次完整 agent run。
 *
 * 实测（隔离 HOME `/tmp/e2e4552`，真实飞书群 + 真实 LLM）：
 * - `event-store.db` 11 条事件里 **5 条是回灌**（45%）
 * - **4 条 telemetry 提示全部回灌**
 * - 时序：提示 `create_time 19:35:58.257` → 回声事件 `19:35:58.631`（**374ms**）
 * - 回声 trace `01a177fef0904b9dc43d1848880fef21`：5582ms / 188 spans /
 *   含 `agent.component.run` + `invokeLLM`
 *
 * 后果：每条提示 → 新「用户消息」→ 进 lane → 跑完整 agent run。token
 * 一点没省，消息量翻倍，lane 饥饿原封不动，且有正反馈放大风险。
 *
 * ## 两层防线
 *
 * | 层 | 位置 | 作用 | 覆盖面 |
 * |---|---|---|---|
 * | **主修** | `telemetry-notice.ts` `buildLarkSendArgs` | 出站显式 `--as bot` | 治本：我们自己发的东西不再是 user 身份 |
 * | **纵深** | 本模块 + `event-handler.ts` 入口 | 识别「发送者是自己/是 bot」→ 丢弃 | 兜底：将来别的出站路径又忘 `--as bot` / 同群其它 bot / 字段口径漂移 |
 *
 * ## ⚠️ 关键事实：本轮回灌的 `sender_type` 其实是 `user`
 *
 * 从 E2E 的 `event-store.db` 逐条 dump `raw_event`（见 `self-echo-filter.test.ts`
 * 与报告 §6.3），回灌事件的真实形态是：
 *
 * ```json
 * { "sender_type": "user",
 *   "sender_id": "ou_xxxxxxxxxxxxxxxx",   ← 用户本人
 *   "message_type": "post",
 *   "content": "🔔 process_x「…」已启动" }
 * ```
 *
 * ⇒ **只按 `sender_type=bot` 过滤抓不到本轮回灌**。所以本模块覆盖三种判据：
 *
 * 1. `senderType ∈ {bot, app}` —— 飞书 bot 消息的真实取值（`app` 是主取值，
 *    `bot` 是历史/其它 SDK 口径）。这层防「未来出站路径漏 `--as bot`」后的
 *    真实 bot 回声，以及同群里**别的 bot** 的消息。
 * 2. `senderId ∈ selfBotIds` —— 调用方显式注入「我方 bot 身份」（app_id /
 *    bot 的 open_id）。这层防 `sender_type` 口径漂移（历史发生过类似漂移）。
 * 3. 两者都没有 ⇒ **放行**（信息不足时宁可跑 agent，也不能错杀用户消息）。
 *
 * ## 铁律：绝不按文案过滤
 *
 * 「`🔔` / `🔄` 前缀」过滤是**错误**做法 —— 用户完全可能手打一条
 * 「🔔 这是什么意思」。只能按 sender 身份判定。回归护栏见
 * `self-echo-filter.test.ts` 第 3 组 + `event-handler-telemetry-notice.test.ts` RED-3b。
 *
 * ## 本模块**不**负责
 *
 * - 「哪些事件该丢弃」的最终决定（在 `event-handler.ts` 的 `handleEvent` 入口）
 * - 打点 / 日志（调用方决定，便于测试断言）
 */

import type { EnvEvent } from "@ai-setting/roy-bot-core";

// ============================================================================
// 常量
// ============================================================================

/**
 * 飞书 bot 发送者的 `sender_type` 取值集合（小写比较）。
 *
 * - `app`：`im +messages-send --as bot` 发出的消息，`sender_type` 就是 `app`
 *   （实测 chat-messages-list 里 bot 消息是 `sender_type=app` +
 *   `id_type=app_id` + `open_bot_id`）
 * - `bot`：历史 / 其它 SDK / webhook 口径里也见过这个取值
 *
 * 两者都收 —— 少收一个就会漏。
 */
const BOT_SENDER_TYPES: ReadonlySet<string> = new Set(["bot", "app"]);

// ============================================================================
// 发送者身份提取
// ============================================================================

/** 发送者身份（提取不到就是全 undefined）。 */
export interface SenderIdentity {
  /** `sender_type` 原值（保留大小写，便于日志） */
  senderType?: string;
  /** 发送者 id（open_id / app_id / user_id 均可） */
  senderId?: string;
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * 从各种事件形态里把发送者身份挖出来（纯函数，不抛）。
 *
 * ## 覆盖的形态（按优先级）
 *
 * 1. `metadata.senderType` / `metadata.senderId` —— 新事件在 ES 层已提取
 * 2. `payload.metadata.senderType` / `.senderId` —— `EventSourceEvent` 标准位置
 * 3. `payload.rawEvent.sender_type` / `.sender_id` —— **lark-cli consume
 *    简化格式**（真实形态，见文件头）；`sender_id` 是字符串
 * 4. `payload.rawEvent.event.sender.sender_type` /
 *    `.sender_id.open_id|user_id|union_id` —— 飞书原始 webhook 嵌套格式
 * 5. `payload.senderType` / `payload.senderId` —— 少数 handler 的直传
 *
 * 内部事件（`task.background.*` 等）没有这些字段 → 全 undefined，
 * 由 `isSelfEchoEvent` 放行。
 */
export function extractSenderIdentity(event: EnvEvent | undefined): SenderIdentity {
  if (!event) return {};

  const metadata = event.metadata as Record<string, unknown> | undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  const payloadMeta = payload?.metadata as Record<string, unknown> | undefined;
  const rawEvent = payload?.rawEvent as Record<string, unknown> | undefined;
  const innerEvent = rawEvent?.event as Record<string, unknown> | undefined;
  const innerSender = innerEvent?.sender as Record<string, unknown> | undefined;
  const topSender = rawEvent?.sender as Record<string, unknown> | undefined;

  // ---- sender_type ----
  const senderType =
    pickString(metadata?.senderType) ??
    pickString(payloadMeta?.senderType) ??
    pickString(rawEvent?.sender_type) ??
    pickString(innerSender?.sender_type) ??
    pickString(topSender?.sender_type) ??
    pickString(payload?.senderType);

  // ---- sender_id ----
  const nestedSenderId =
    (innerSender?.sender_id ?? topSender?.sender_id) as unknown;

  const senderId =
    pickString(metadata?.senderId) ??
    pickString(payloadMeta?.senderId) ??
    pickString(payload?.senderId) ??
    // 简化格式：顶层字符串
    pickString(rawEvent?.sender_id) ??
    // 嵌套格式：sender_id 可能是字符串或对象
    (typeof nestedSenderId === "string"
      ? pickString(nestedSenderId)
      : (pickString((nestedSenderId as Record<string, unknown> | undefined)?.open_id) ??
        pickString((nestedSenderId as Record<string, unknown> | undefined)?.user_id) ??
        pickString((nestedSenderId as Record<string, unknown> | undefined)?.union_id)));

  return {
    ...(senderType ? { senderType } : {}),
    ...(senderId ? { senderId } : {}),
  };
}

// ============================================================================
// 会话类型 / mentions 提取（Task #5459）
// ============================================================================

/** 事件所在会话的类型（`"group"` / `"p2p"` / 提取不到）。 */
export type ChatKind = "group" | "p2p" | "unknown";

/**
 * 从事件里提取会话类型（`chat_type`，纯函数，不抛）。
 *
 * 覆盖位置（与 `extractSenderIdentity` 同源，按优先级）：
 * 1. `metadata.chatType` —— ES 层已提取
 * 2. `payload.metadata.chatType`
 * 3. `payload.rawEvent.chat_type` —— lark-cli consume 简化格式（真实形态）
 * 4. `payload.rawEvent.event.message.chat_type` —— 飞书原始 webhook 嵌套
 *
 * 只在明确等于 `group` / `p2p` 时返回，其它（含 `topic`、缺失）→ `unknown`
 * （保守：不认识的值不参与放行判定）。
 */
export function extractChatKind(event: EnvEvent | undefined): ChatKind {
  if (!event) return "unknown";

  const metadata = event.metadata as Record<string, unknown> | undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  const payloadMeta = payload?.metadata as Record<string, unknown> | undefined;
  const rawEvent = payload?.rawEvent as Record<string, unknown> | undefined;
  const innerMessage = (rawEvent?.event as Record<string, unknown> | undefined)
    ?.message as Record<string, unknown> | undefined;

  const raw =
    pickString(metadata?.chatType) ??
    pickString(payloadMeta?.chatType) ??
    pickString(rawEvent?.chat_type) ??
    pickString(innerMessage?.chat_type);

  const v = raw?.toLowerCase();
  if (v === "group") return "group";
  if (v === "p2p") return "p2p";
  return "unknown";
}

/**
 * 从事件里提取被 @ 的 id 列表（`mentions[].id`，纯函数，不抛）。
 *
 * ## 为什么是 `mentions`
 *
 * 飞书只在消息带**结构化 at 节点**时才回填 `mentions` 数组
 * （实测 `chat-messages-list` / `event consume` 都有：
 *  `{"key":"@_user_1","id":"ou_xxx","name":"通助理"}`）。
 * 内容里手打的 `@xxx` 不会出现在这里 —— 这正是我们要的语义：
 * 「真正的 @ 收件人」，而不是文案。
 *
 * 覆盖位置：`metadata.mentions` / `payload.mentions` /
 * `payload.rawEvent.mentions` / `payload.rawEvent.event.message.mentions`。
 * 每项的 id 取 `id` / `open_id` / `user_id` / `app_id`（任一）。
 */
export function extractMentionIds(event: EnvEvent | undefined): string[] {
  if (!event) return [];

  const metadata = event.metadata as Record<string, unknown> | undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  const rawEvent = payload?.rawEvent as Record<string, unknown> | undefined;
  const innerMessage = (rawEvent?.event as Record<string, unknown> | undefined)
    ?.message as Record<string, unknown> | undefined;

  const candidates = [
    metadata?.mentions,
    payload?.mentions,
    rawEvent?.mentions,
    innerMessage?.mentions,
  ];

  const ids: string[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const id =
        pickString(rec.id) ??
        pickString(rec.open_id) ??
        pickString(rec.user_id) ??
        pickString(rec.app_id);
      if (id && !ids.includes(id)) ids.push(id);
    }
    // 第一个非空来源就够（四处是同一份数据的不同投影）
    if (ids.length > 0) break;
  }
  return ids;
}

// ============================================================================
// 判定
// ============================================================================

/** `isSelfEchoEvent` 的选项。 */
export interface SelfEchoFilterOptions {
  /**
   * 我方 bot 的身份 id 集合（app_id 和/或 bot 的 open_id）。
   *
   * 用于覆盖 `sender_type` 口径漂移的场景：即使飞书把 bot 消息报成
   * `sender_type=user`，只要 senderId 命中这里，仍然判定为自我回声。
   *
   * 不传 / 空数组 ⇒ 只靠 `senderType` 判定。
   */
  selfBotIds?: readonly string[];
  /**
   * 总开关（默认 `true`）。设 `false` 时**全部放行**，用于运行时软回滚
   * （不需要改代码 / 重发版）。见 `SELF_ECHO_FILTER_ENABLED_ENV`。
   */
  enabled?: boolean;
}

/** 判定结果（`skip=true` 表示必须丢弃）。 */
export interface SelfEchoVerdict {
  /** 是否丢弃该事件 */
  skip: boolean;
  /**
   * 判定原因：
   * - `bot-sender` — `sender_type` ∈ {bot, app}，且不满足「群聊 @ 别人」放行条件
   * - `self-bot-id` — `senderId` 命中 `selfBotIds`
   * - `group-bot-message` — **放行**：群聊里的 bot 消息（协作入站）
   * - `disabled` — 软回滚开关关闭，**放行**
   * - undefined — 信息不足 / 确认为真实用户，**放行**
   */
  reason?: "bot-sender" | "self-bot-id" | "group-bot-message" | "disabled";
  /** 命中的 `sender_type`（诊断用） */
  senderType?: string;
  /** 命中的 `senderId`（诊断用） */
  senderId?: string;
  /** 命中的会话类型（诊断用，Task #5459） */
  chatKind?: ChatKind;
  /** 命中的 mentions id 列表（诊断用，Task #5459） */
  mentionIds?: readonly string[];
}

/**
 * 判定该事件是否为「自己/我方 bot 发出」的回声 → 必须丢弃。
 *
 * ## 判定顺序（顺序即优先级）
 *
 * 0. **`senderId ∈ selfBotIds` → 丢弃（`reason="self-bot-id"`）**
 *    ★ 最高优先：自己发出的消息（不管在群里 @ 了谁）就是回声。
 *    这一条同时是「A/B 两个 bot 在群里互相 @」的最终闸门 —— 少了它，
 *    群聊放行会让两个 bot 无限回灌（每家都把自己的出站当协作入站）。
 *    ⇒ **生产必须注入 selfBotIds**（见 event-handler-wiring）。
 * 1. **群聊 + `senderType ∈ {bot,app}` → 放行（`reason="group-bot-message"`）**
 *    ★ Task #5459 修的就是这里：门禁在**接收方**跑，群里别的 bot 的消息
 *    对本方而言是**协作入站**（大概率就是 @ 我），必须交给 agent。
 *    以前按 `senderType` 一刀切丢弃 ⇒ 协作消息永远进不来。
 *    ⚠️ 刻意**不**按「@ 的是不是自己」决定丢弃：@ 自己的恰恰必须放行。
 * 2. 其余 bot/app 消息（私聊 / chat_type 缺失或不认识）→ 丢弃（`reason="bot-sender"`）
 *    保守：信息不足时宁可拦回声，也不能让 bot 私聊噪声进 lane。
 * 3. 非 bot 发送者 + `senderId` 不在 `selfBotIds` → 放行（真实用户）
 *
 * 纯函数，永不抛。
 */
export function isSelfEchoEvent(
  event: EnvEvent | undefined,
  options: SelfEchoFilterOptions = {},
): SelfEchoVerdict {
  const { senderType, senderId } = extractSenderIdentity(event);
  const chatKind = extractChatKind(event);
  const mentionIds = extractMentionIds(event);

  // 诊断字段统一挂上（每个分支都带，便于运维一眼定位）
  const diag = {
    ...(senderType ? { senderType } : {}),
    ...(senderId ? { senderId } : {}),
    ...(chatKind !== "unknown" ? { chatKind } : {}),
    ...(mentionIds.length > 0 ? { mentionIds } : {}),
  };

  if (options.enabled === false) {
    return { skip: false, reason: "disabled", ...diag };
  }

  // 0) 自己发的 → 一定是回声（最高优先，含自循环闸门语义）
  if (senderId && options.selfBotIds && options.selfBotIds.length > 0) {
    if (options.selfBotIds.includes(senderId)) {
      return { skip: true, reason: "self-bot-id", ...diag };
    }
  }

  // 1) bot / app 发送者
  if (senderType && BOT_SENDER_TYPES.has(senderType.toLowerCase())) {
    // ★ Task #5459：群聊里的 bot 消息 = 协作入站（别的 roy 智能体在 @ 我）
    if (chatKind === "group") {
      return { skip: false, reason: "group-bot-message", ...diag };
    }
    // 私聊 / chat_type 缺失 / 不认识 → 保守丢弃
    return { skip: true, reason: "bot-sender", ...diag };
  }

  // 2) 信息不足 / 确认为真实用户 → 放行
  return { skip: false, ...diag };
}

// ============================================================================
// 环境变量（软回滚开关）
// ============================================================================

/**
 * 软回滚开关的环境变量名。
 *
 * 语义：显式设为 `"0"` / `"false"` / `"off"` / `"no"` → 关闭过滤（全部放行）。
 * 未设置 / 其余任意值 → 开启（默认行为）。
 *
 * **白名单式关闭**：只有明确写出的关闭值才关，其余（含拼错的、空串、
 * 未设置的）一律保持开启 —— 防护默认开，不会因为一个 typo 悄悄失效。
 *
 * 为什么要运行时开关：这层过滤在生产上误伤的代价（用户消息丢失）比漏放
 * 一条回声大。真有误伤时不必等发版，改 env + 重启即可回滚。
 */
export const SELF_ECHO_FILTER_ENABLED_ENV = "ROY_AGENT_SELF_ECHO_FILTER";

/** 从环境变量读取过滤开关（默认 `true`）。 */
export function readSelfEchoFilterEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[SELF_ECHO_FILTER_ENABLED_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}
