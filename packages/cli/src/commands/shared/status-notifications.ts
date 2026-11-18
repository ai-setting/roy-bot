/**
 * @fileoverview Task #5360（补充需求 2026-11-11 20:54）——
 *   「状态通知文本」开关的解析层（per-ES 配置驱动）
 *
 * ## 用户补充需求原文
 *
 * > 「`~/.roy-bot/event-sources.json` 新增配置项控制「状态通知消息」，
 * >   默认 false 不启动；false = 不发状态通知文本（走卡片），
 * >   true = 恢复之前的状态通知消息推送。覆盖 lark ES（wecom ES 对称考虑）」
 *
 * ## 本模块只做一件事：**解析出这次事件该不该发状态通知文本**
 *
 * 卡片侧（`lark-card-*` / `wecom-card-*`）与本模块**完全正交** ——
 * 卡片永远发，开关只管文本。这一点由调用方（`EventHandler`）保证。
 *
 * ## 为什么是「快照优先」而不是「每次活取 ES 配置」
 *
 * 后台任务可能跑几小时，期间用户会改 `event-sources.json`。通知该按
 * **任务诞生时**的配置语义走 —— 与 `replyChannel` / `pluginEnabledSnapshot`
 * （#5265）同一设计原则：一次任务的所有通知必须口径一致，不能中途变脸。
 *
 * 快照怎么来的：delegate 时刻 `_captureReplyChannelSnapshot()`（整份保留
 * `params`）随 `task.background.*` 事件一路带下来，与 #5311 塞
 * `sourceId` / `reqId` 是同一机制。所以写入点必须**显式写 false**
 * （不能省略），否则「源上显式 false」与「源上没这个字段」在快照里不可区分。
 *
 * ## 读取分层（越靠前越权威，全部零 IO 优先）
 *
 * | 优先级 | 来源 | 场景 |
 * |--------|------|------|
 * | 1 | `metadata.replyChannel.params.statusNotifications` | **主路径**（delegate 快照） |
 * | 2 | `metadata.sourceId` → 活取 ES 配置 | 事件源直发事件不走快照时兜底 |
 * | 3 | 单源推断：该渠道**恰好只有 1 个源** ⇒ 用它的值 | 老 delegate / 跨进程重启（快照缺失） |
 * | 4 | 默认 `false` | 解析失败 / 多源歧义 ⇒ 走卡片（安全侧） |
 */

import type { EnvEvent } from "@ai-setting/roy-bot-core";

// ============================================================================
// 类型
// ============================================================================

/** 解析所需的最小 ES 配置形状（不依赖 core 的完整类型，便于单测注入） */
export interface StatusNotificationSource {
  id: string;
  type: string;
  /** 原始值：可能是 `true` / `false` / `"true"` / `1` / `null`（手改 JSON） */
  statusNotifications?: unknown;
}

/** 渠道类型（与 ES 配置的 `type` 对齐） */
export type StatusNotificationChannel = "lark-cli" | "wecom-cli";

// ============================================================================
// 严格布尔归一化
// ============================================================================

/**
 * 只有**真布尔 `true`** 才算开启。
 *
 * 为什么不用 truthy 判断：`event-sources.json` 是用户会手改的文件，
 * `"false"`（字符串）是 truthy 但语义是关；`1` 也无从判断用户意图。
 * 一律 `=== true` 最可预测，且与 #5265 的 `pluginEnabledSnapshot` 口径一致。
 */
export function isStrictlyTrue(v: unknown): boolean {
  return v === true;
}

// ============================================================================
// 第 1 层：快照
// ============================================================================

/**
 * 从 `replyChannel.params` 里取 `statusNotifications`。
 *
 * @returns `true` / `false`（显式写了）/ `undefined`（没写 —— 落到下一层）
 *
 * ⚠️ 注意这里**返回原始三态而不是布尔**：`undefined` 意味着"快照里没有
 * 这个信息，请继续往下找"，与"快照说 false"是**不同**语义。直接返回布尔
 * 会让第 2/3 层永远不生效，等于退化成"只有快照"。
 */
export function pickStatusNotificationsFromParams(
  params: unknown,
): boolean | undefined {
  if (!params || typeof params !== "object") return undefined;
  const raw = (params as Record<string, unknown>).statusNotifications;
  if (raw === true) return true;
  if (raw === false) return false;
  // 非布尔（"true" / 1 / null / 缺失）→ 当作"快照里没有可用信息"
  return undefined;
}

// ============================================================================
// 第 2/3 层：ES 配置
// ============================================================================

/**
 * 从 ES 配置列表里解析。
 *
 * 1. `metadata.sourceId` 命中某个源 ⇒ 用该源的 `statusNotifications`
 *    （**命中即返回**，即使值是 false —— 显式配置永远优先于推断）
 * 2. 未命中 sourceId ⇒ 找"该渠道恰好只有 1 个源"时用它的值
 * 3. 多源 / 零源 ⇒ `undefined`（落到默认 false）
 *
 * @param channel 渠道类型。传 `undefined` 时不走单源推断（宁可保守）。
 */
export function pickStatusNotificationsFromSources(
  event: Pick<EnvEvent, "metadata">,
  sources: ReadonlyArray<StatusNotificationSource> | undefined,
  channel?: StatusNotificationChannel,
): boolean | undefined {
  if (!sources || sources.length === 0) return undefined;

  // ---- 1. sourceId 精确命中 ----
  const metadata = event?.metadata as Record<string, unknown> | undefined;
  const sourceId =
    typeof metadata?.sourceId === "string" ? (metadata.sourceId as string) : undefined;
  if (sourceId) {
    const hit = sources.find((s) => s?.id === sourceId);
    if (hit) return isStrictlyTrue(hit.statusNotifications);
  }

  // ---- 2. 单源推断（只在渠道明确时） ----
  if (!channel) return undefined;
  const sameChannel = sources.filter((s) => s?.type === channel);
  if (sameChannel.length === 1) {
    return isStrictlyTrue(sameChannel[0].statusNotifications);
  }

  // 多源歧义 / 该渠道零源 → 保守走卡片
  return undefined;
}

// ============================================================================
// 组合：最终语义
// ============================================================================

/**
 * 解析「这次事件该不该发状态通知文本」。
 *
 * 分层顺序见文件头注释。任何一层给出**布尔**就停；全 `undefined` ⇒ `false`。
 *
 * @param event   EnvEvent（读 `metadata.replyChannel.params` / `metadata.sourceId`）
 * @param sources ES 配置列表（`env.getComponent("event-source")?.list() ?? []`）
 * @param channel 渠道（用于单源推断；`undefined` 时跳过该层）
 *
 * ⚠️ **永不抛**：任何字段形状异常都退化为 `false`（走卡片，安全侧）。
 */
export function resolveStatusNotificationsFromEvent(
  event: EnvEvent,
  sources: ReadonlyArray<StatusNotificationSource> | undefined,
  channel?: StatusNotificationChannel,
): boolean {
  try {
    const metadata = event?.metadata as Record<string, unknown> | undefined;

    // ---- 层 1：delegate 快照（最权威 —— 任务诞生时的语义） ----
    const replyChannel = metadata?.replyChannel as
      | { params?: unknown }
      | undefined;
    const fromSnapshot = pickStatusNotificationsFromParams(replyChannel?.params);
    if (fromSnapshot !== undefined) return fromSnapshot;

    // ---- 层 2/3：ES 配置（无快照时兜底） ----
    const fromSources = pickStatusNotificationsFromSources(event, sources, channel);
    if (fromSources !== undefined) return fromSources;

    // ---- 层 4：默认 false（= 卡片化，用户要的行为） ----
    return false;
  } catch {
    return false;
  }
}

// ============================================================================
// 渠道推断（给 wiring 用，避免各调用点各写一份）
// ============================================================================

/**
 * 从事件的 replyChannel / sourceId 推断渠道类型。
 *
 * 用于「单源推断」那一层 —— 得先知道这次事件是 lark 还是 wecom，
 * 才能判断"该渠道是否恰好只有 1 个源"。
 *
 * @returns `undefined` 当无法判断（此时跳过单源推断，保守走卡片）
 */
export function inferChannelFromEvent(
  event: EnvEvent,
): StatusNotificationChannel | undefined {
  const metadata = event?.metadata as Record<string, unknown> | undefined;

  // replyChannel.type 是权威来源（lark-cli / wecom-cli）
  const rcType = (metadata?.replyChannel as { type?: unknown } | undefined)?.type;
  if (rcType === "lark-cli") return "lark-cli";
  if (rcType === "wecom-cli") return "wecom-cli";

  // 退一步：chatId 前缀（企微单聊 chatId = userid；群 = wecom:... 前缀）
  const chatId = (metadata?.replyChannel as { chatId?: unknown } | undefined)?.chatId;
  if (typeof chatId === "string" && chatId.startsWith("wecom")) return "wecom-cli";

  return undefined;
}