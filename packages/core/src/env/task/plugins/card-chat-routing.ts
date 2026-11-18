/**
 * @fileoverview 任务卡片「该发到哪个群」的路由决策（Task #4230 / #4394）
 *
 * ## 现行规则（用户 2026-10-20 明令，Task #4394）
 *
 * > 去掉专属群卡片逻辑，只保留**触发群的进度卡片**（可用户点击建群）
 *
 * 决策优先级：
 * 1. **有触发群 → 就用触发群**。无条件，不判断它是不是"别的 task 的专属群"。
 * 2. 没有触发群 → 用本 task（其次最近祖先）自己已有的专属群兜底（卡片不能丢）。
 * 3. 两者都没有 → `none`（调用方静默 skip）。
 *
 * ## 已删除的历史逻辑（Task #4394）
 *
 * 旧实现（Task #4230）会在"触发群被判定为别的 task 的专属群"时把卡片**改投**到
 * 本 task / 祖先的 lineage 群，并在触发群补一张「📂 任务卡片已改投专属群 /
 * 这里不是本任务的群，进展请看专属群」的指路卡。
 *
 * 用户实测（Task #4393）该行为是干扰：
 * ```
 * 触发群 oc_8947d9e2…（task 4377 的专属群）
 *   → 卡片被改投到 oc_d27157ac…（lineage 群）
 *   → 用户在触发群只看到一张"这里不是本任务的群"的灰卡
 * ```
 * 用户的诉求是「在哪聊就在哪看到进展」。**跨任务污染不再是需要解决的问题**，
 * 因此整套「专属群归属判定 + 改投 + 指路卡」链路已彻底删除：
 * - 删除 `ChatOwnership` / `mergeChatOwnership` / `analyzeContextOwnership`
 * - 删除 `CardChatDecision.reroutedFrom`
 * - 删除 `new-group` / `fallback-to-trigger` 两种 source（不再自动建群）
 *
 * ## 建群能力仍在（**用户主动点击**才建）
 *
 * 卡片顶部按钮 `create_group` / `disband_group` 由
 * `lark-card-action-handler.ts` 处理，与本文档的路由决策**完全解耦**：
 * ```
 * 用户点「为这个任务建群」
 *   → card.action.trigger 事件
 *   → handleCardAction → ports.createGroupChat (lark-cli im +chat-create)
 *   → 回写 task.context.larkPerTaskChatId
 *   → patch 卡片（按钮翻成「解散该群」+ 出现「进入专属群」链接）
 * ```
 * 建群后下一张进度卡会走本文件的优先级 1（仍进触发群），
 * 但卡片上多了「进入专属群」链接 —— 这是用户可选的入口，不是自动改投。
 *
 * 本模块是**纯函数**（不碰 IO），便于单测覆盖所有分支。
 */

// ========================================================================
// 常量 / 正则
// ========================================================================

/** 群名里隐含的 task id（"Task 3999 - xxx" / "#3999 TMO 提取跟进"） */
export const GROUP_NAME_TASK_ID_RE = /(?:Task\s*#?\s*|#)(\d{1,7})\b/i;

/** 会把 chatId 记进 context 的字段名（用于 DB LIKE 反查） */
export const CTX_FIELD_LARK_PER_TASK_CHAT_ID = "larkPerTaskChatId";

// ========================================================================
// 类型
// ========================================================================

export type CardChatSource =
  | "trigger-chat"
  | "own-group"
  | "ancestor-group"
  | "none";

export interface CardChatDecision {
  chatId?: string;
  profile?: string;
  /** 目标群名（诊断用） */
  chatName?: string;
  source: CardChatSource;
  /** 人类可读的决策原因（写进 span / debug 日志） */
  reason: string;
}

// ========================================================================
// context 解析（纯函数）
// ========================================================================

/** 从 task.context JSON 解析专属群 id（larkPerTaskChatId） */
export function extractPerTaskChatId(contextStr?: string): string | undefined {
  if (!contextStr) return undefined;
  try {
    const obj = JSON.parse(contextStr) as Record<string, unknown>;
    const v = obj?.[CTX_FIELD_LARK_PER_TASK_CHAT_ID];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 从 task.context JSON 解析专属群名（larkPerTaskChatName） */
export function extractPerTaskChatName(contextStr?: string): string | undefined {
  if (!contextStr) return undefined;
  try {
    const obj = JSON.parse(contextStr) as Record<string, unknown>;
    const v = obj?.["larkPerTaskChatName"];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 从 task.context JSON 解析专属群 profile（larkPerTaskChatProfile） */
export function extractPerTaskChatProfile(contextStr?: string): string | undefined {
  if (!contextStr) return undefined;
  try {
    const obj = JSON.parse(contextStr) as Record<string, unknown>;
    const v = obj?.["larkPerTaskChatProfile"];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 从 task.context JSON 解析记录下来的群名（含 `#3999` / `Task 3999` 模式） */
export function extractRecordedChatNames(contextStr?: string): string[] {
  if (!contextStr) return [];
  const out: string[] = [];
  try {
    const obj = JSON.parse(contextStr) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (typeof v === "string" && /chat_?name$/i.test(k) && v.length > 0) {
        out.push(v);
      }
    }
  } catch {
    return [];
  }
  return out;
}

// ========================================================================
// 决策
// ========================================================================

/**
 * 决定卡片该发到哪个群（Task #4394 简化版）
 *
 * 规则只有两条：
 * 1. **有触发群 → 触发群**（无条件，不做任何"是不是别人的群"判定）
 * 2. 没触发群 → 用本 task / 祖先已有的专属群兜底
 *
 * @param input.lineageChat lineage 上找到的专属群（自己优先，其次最近祖先）
 */
export function decideCardChatTarget(input: {
  taskId?: number;
  lineageIds?: number[];
  lineageChat?: { chatId: string; profile?: string; isSelf: boolean };
  triggerChatId?: string;
  triggerProfile?: string;
}): CardChatDecision {
  const { lineageChat, triggerChatId, triggerProfile } = input;

  // 优先级 1：有触发群就用它 —— Task #4394：不再判定"是不是别的 task 的专属群"
  if (triggerChatId) {
    return {
      chatId: triggerChatId,
      profile: triggerProfile,
      source: "trigger-chat",
      reason: `触发群 ${triggerChatId} 直接用（Task #4394：卡片只发触发群，不改投）`,
    };
  }

  // 优先级 2：没有触发群 → 用本 task（或祖先）自己的群兜底，卡片不能丢
  if (lineageChat) {
    return {
      chatId: lineageChat.chatId,
      profile: lineageChat.profile,
      source: lineageChat.isSelf ? "own-group" : "ancestor-group",
      reason: `无触发群 → 用 ${lineageChat.isSelf ? "本 task" : "祖先"} 专属群 ${lineageChat.chatId} 兜底`,
    };
  }

  // 优先级 3：都没有
  return {
    chatId: undefined,
    source: "none",
    reason: "既没有触发群也没有本 task 的群（无法决定投递目标）",
  };
}
