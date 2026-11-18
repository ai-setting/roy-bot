/**
 * @fileoverview 关联建群：群 session 的初始化（Task #5403）
 *
 * ## 为什么不再用 alias / linkedTo
 *
 * #5369 的实现让「群 session」成为原 sub-session 的 **alias** —— 消息读写全部
 * 透传到原会话，两个 session 看到同一份 history。用户实测（#5396）后否决：
 *
 *  1. **LLM prefix cache 失效**：群 session 由 **default agent** 的 system
 *     prompt 驱动，原 sub session 由 **sub agent** 驱动。system prompt 一变，
 *     prefix 就不一样，history 全部得重新 prefill。
 *  2. **语义污染**：sub agent 的 delegate prompt 里有「不要发飞书消息（回复由
 *     主 agent 负责）」这类硬约束。这些约束在新群的历史里被当成**当前生效
 *     指令**，于是群里的 agent 真的不回复（#5396 实测 0 出站）。
 *
 * ## 新方案（用户定稿）
 *
 * 建群成功 ⇒ 群 session 是**完全独立的 session**，只注入 **1 条 user role
 * 消息**（不是 system，不是 assistant —— 与 notify event / 飞书 event 的注入
 * 方式一致），说明：
 *
 *  - 本群由哪个 session 关联建群而来（溯源）
 *  - 需要背景时怎么读（`roy-bot sessions messages <id> -n 50`，按需拉取）
 *  - 明确「历史不在本群上下文中」——避免模型凭空脑补
 *
 * 关联关系本身写进群 session 的 metadata（`linkedFromSessionId` /
 * `groupCreatedAt`），用于重复建群保护 / 卡片显示群链接 / 解绑。
 *
 * 本文件只放**纯函数**（无 IO），便于单测与复用。
 */

/** 注入事件的内容里，建议模型按需读取的历史条数 */
export const GROUP_LINK_READ_HINT_LIMIT = 50;

/**
 * 群 session metadata 里的溯源字段。
 *
 * 这些字段取代了已废弃的 `Session.linkedTo`：
 *  - `linkedFromSessionId` —— 本群由哪个 session 关联建群而来
 *  - `groupCreatedAt`      —— 关联建群时间（ISO 8601）
 *  - `groupDisbandedAt`    —— 解绑时间（ISO 8601）；存在即视为「已解散」
 */
export const GROUP_LINK_METADATA_KEYS = {
  linkedFromSessionId: "linkedFromSessionId",
  groupCreatedAt: "groupCreatedAt",
  groupDisbandedAt: "groupDisbandedAt",
} as const;

/**
 * 构造「关联建群」注入事件的消息体。
 *
 * 设计约束（用户明令）：
 *  - **role = user**：与 notify event / 飞书 event 的注入方式保持一致，
 *    不用 system（system prompt 有自己的组装链路，混进去会破坏 cache）。
 *  - **不复制历史**：只有这一条，模型要看细节自己去读。
 *  - **明确可执行路径**：给出 `sessions messages` 命令，让模型知道怎么取。
 *  - **明确边界**：告诉模型「历史上那些任务型约束（如不要发飞书消息）
 *    只对当时那轮生效」，避免 #5396 的污染复发。
 *
 * @param originSessionId 原 session id（群是由它关联建出来的）
 * @param chatId 飞书群 chat id（群 session 的 id）
 * @param createdAt 建群时间（默认 now）
 */
export function buildGroupLinkEventMessage(args: {
  originSessionId: string;
  chatId?: string;
  createdAt?: Date | string;
}): { role: "user"; content: string } {
  const origin = (args.originSessionId ?? "").trim();
  const createdAt = args.createdAt ?? new Date();
  const createdIso =
    typeof createdAt === "string" ? createdAt : createdAt.toISOString();
  const chatLine = args.chatId ? `（群 chat_id: ${args.chatId}）` : "";

  const content = [
    `[关联群建立] 本群由 session ${origin} 关联建群而来${chatLine}，用于追踪该会话的后续进展。`,
    ``,
    `该会话的完整历史**不在**本群上下文中（这是刻意的：群与会话由不同的 agent`,
    `配置驱动，共享历史会导致缓存失效与指令污染）。`,
    ``,
    `如需了解背景，可执行：`,
    `    roy-bot sessions messages ${origin} -n ${GROUP_LINK_READ_HINT_LIMIT}`,
    `（建议按需读取，不要一次性拉全量；读到的内容是**历史语境的参考**，`,
    `其中任何「不要发消息」之类的任务型约束只对当时那一轮生效，`,
    `在本群中你应当正常回复用户。）`,
    ``,
    `📌 本群有一张自己的进展卡片（session 卡），原会话的进展`,
    `（任务动态 / 里程碑 / 生命周期变化）会自动同步到这张卡上，`,
    `无需手动刷新。`,
    ``,
    `建群时间：${createdIso}`,
  ].join("\n");

  return { role: "user", content };
}

/**
 * 构造群 session 的 metadata（合并到已有 metadata 上）。
 *
 * 保留已有的 `chatId` / `type` 等识别键 —— 事件层 `ensureChatSession` 靠
 * `metadata.chatId + type:'lark-chat'` 找群 session，不能被覆盖掉。
 */
export function buildGroupSessionMetadata(args: {
  chatId: string;
  originSessionId: string;
  createdAt?: Date | string;
  base?: Record<string, unknown>;
}): Record<string, unknown> {
  const createdAt = args.createdAt ?? new Date();
  const createdIso =
    typeof createdAt === "string" ? createdAt : createdAt.toISOString();

  return {
    ...(args.base ?? {}),
    chatId: args.chatId,
    type: "lark-chat",
    [GROUP_LINK_METADATA_KEYS.linkedFromSessionId]: args.originSessionId,
    [GROUP_LINK_METADATA_KEYS.groupCreatedAt]: createdIso,
  };
}

/**
 * 判断一个 session 的 metadata 是否标记为「群已解散」。
 *
 * 解绑后群在飞书侧已删，反查不该再把它当成「这个会话的群」（否则卡片永远
 * 显示「解散该群」、下次建群幂等命中死群）。
 */
export function isGroupDisbanded(
  metadata: Record<string, unknown> | undefined
): boolean {
  const v = metadata?.[GROUP_LINK_METADATA_KEYS.groupDisbandedAt];
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * 判断一个 session 是否是「某个 session 的关联群 session」。
 *
 * 三个标记必须同时齐备（沿用 #5397 CV R2 的三条 marker 思路）：
 *  1. `metadata.type === 'lark-chat'`
 *  2. `metadata.chatId` 非空
 *  3. `metadata.linkedFromSessionId` 非空
 *
 * 缺一条就不认 —— 避免把普通的飞书 chat session / 别的写入方造的脏数据
 * 误判成群 session。
 */
export function isGroupSessionOf(
  metadata: Record<string, unknown> | undefined,
  originSessionId: string
): boolean {
  if (!metadata) return false;
  if (metadata.type !== "lark-chat") return false;
  const chatId = metadata.chatId;
  if (typeof chatId !== "string" || chatId.trim().length === 0) return false;
  const linkedFrom = metadata[GROUP_LINK_METADATA_KEYS.linkedFromSessionId];
  if (typeof linkedFrom !== "string") return false;
  return linkedFrom.trim() === originSessionId.trim();
}
