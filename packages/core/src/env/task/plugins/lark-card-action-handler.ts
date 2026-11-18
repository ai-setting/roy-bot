/**
 * @fileoverview 处理飞书卡片按钮点击（Task #4331）
 *
 * 用户在卡片顶部点 button：
 *   - "为这个任务建群" → ensureGroupChat + 写 task.context.larkPerTaskChatId
 *   - "解散该群" → lark-cli im +chat-delete + 清 task.context.larkPerTaskChatId
 *   - 两种 case 都触发卡片 patch（按钮翻转 + 链接显示/隐藏）
 *
 * 触发源：lark-cli event consume card.action.trigger（参看 lark-card-action-handler.test.ts）
 *
 * 设计原则：
 *   - 纯函数 + IO 端口注入（taskGetter / taskUpdater / notifier / chatCreator / chatDeleter）
 *   - 不依赖具体 bot 身份 / profile（由 caller 注入）
 *   - 失败必须明确返回 ok=false，不静默成功
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../../log-trace/logger";
import { extractPerTaskChatId, extractPerTaskChatName } from "./card-chat-routing";
import { buildSessionCard, buildTaskCard, DEFAULT_APP_LINK_BASE, type CardStatus, type LarkCardPatchNotifier, type Milestone, type SessionCardTaskSummary, type TaskMeta } from "./lark-card-patch-notifier";
import { getSharedLarkCardStateStore } from "./lark-card-state-store";
// ★ 补充需求（22:31）：卡片主键 task-or-session
import { cardKeyOf, pickCardSubject, type CardSubject } from "./card-subject";
// ★ Task #5360：活性快照类型（probe 结果由装配点提供）
import {
  RECENT_MESSAGE_LIMIT,
  type ActivityMessage,
  type ToolCallView,
  type ActivityProbeResult,
  type SessionLifecycle,
} from "./sub-session-activity";

const logger = createLogger("lark-card-action-handler");

const execAsync = promisify(exec);

/** 卡片按钮点击事件的关键字段（精简版，caller 从 event 里挑出） */
export interface CardActionEvent {
  /**
   * action.value 序列化成的对象
   *
   * ★ Task #5360：新增 `refresh_activity`（展示 sub-session 活性）
   * ★ Task #5377（合并）：`action` 放宽成 string、`taskId` 放宽成可选 ——
   *   这样未知 action 能走到 `Unknown action` 分支（而不是被 TS 挡掉后
   *   运行时静默落到解散群分支），session 卡也能不带 taskId。
   */
  actionValue: {
    /** 运行时再校验（#5377：先判白名单）；合法值见 `CardActionName` */
    action: CardActionName | string;
    /** ★ Task #5360：task 卡带它；session 卡不带（可选，#5377） */
    taskId?: string | number;
    /**
     * ★ 补充需求（22:31）：session 卡的主键。
     *
     * **它是卡片主键**（澄清 22:37）：刷新永远走 session store。
     * `taskId` 只是附加增强 —— 有就多渲染「任务信息」面板，不影响刷新路径。
     */
    sessionId?: string;
  };
  /** 卡片所在的 chat_id */
  chatId: string;
  /** 被点的卡片 message_id（用于 notifier.updateTask） */
  messageId: string;
  /** 飞书提供的 token（30min 有效，可直接更新卡片） */
  token: string;
  /**
   * 触发用户 open_id（Task #4337 用于拉人进群）
   * 兼容 string 或 {open_id: "ou_xxx"} 两种格式
   * （lark-cli event consume 的 card.action.trigger 字段是对象形式）
   */
  operatorId?: string | { open_id: string };
  /** lark-cli profile */
  profile?: string;
}

/** 卡片动作名（★ Task #5360：加 `refresh_activity`；★ Task #5580：加 `select_task`） */
export type CardActionName =
  | "create_group"
  | "disband_group"
  | "refresh_activity"
  | "select_task";

/** 已知动作白名单（运行时校验用 —— 见 `isCardActionName`） */
const KNOWN_CARD_ACTIONS: ReadonlySet<string> = new Set<CardActionName>([
  "create_group",
  "disband_group",
  "refresh_activity",
  // ★ Task #5580：点任务列表里的某个任务 → 切换执行动态/里程碑区
  "select_task",
]);

/**
 * 运行时判定一个字符串是否是本 handler 认识的 action。
 *
 * ★ Task #5360（防误伤）：改造前 handler 的结构是
 * ```ts
 * if (action === "create_group") { ...建群... } else { ...解散群... }
 * ```
 * 也就是**任何**非 create_group 的 action 都会走解散群分支。
 * 加了 `refresh_activity` 之后，如果只在新分支外面套一层判断，漏掉/拼错
 * 的 action（或未来第三方卡片复用同一 handler）会**默默解散用户的群**。
 * 所以改成显式白名单 + switch，未知 action 一律 `ok:false` 且**不执行任何操作**。
 */
export function isCardActionName(v: unknown): v is CardActionName {
  return typeof v === "string" && KNOWN_CARD_ACTIONS.has(v);
}

/**
 * ★ Task #5377：每个 action 依赖的**主键字段**。
 *
 * 这是 #5377 那个生产 bug 的核心表：prod 上 session 卡的按钮 value 是
 * `{ action:"refresh_activity", sessionId }`，**没有 taskId**。
 * 改造前代码在判 action 之前就要求 taskId ⇒ 所有 session 卡按钮在
 * `Invalid taskId: undefined` 处永久早退（实测 3 次点击全失败）。
 */
const ACTION_SUBJECT_FIELD: Record<CardActionName, "taskId" | "sessionId" | "taskId or sessionId"> = {
  // ★ Task #5397（用户拍板「做「无 task 也能建群」」）：group 动作的主键从
  //   「必须 taskId」放宽为「**taskId 优先，无则 sessionId**」。
  //   这样无 task 的 sub-session 也能建群/解绑（session-only 路径）。
  //   只要有一个合法主键就够 —— 两个都缺才报错，且错误信息同时点名两个字段。
  create_group: "taskId or sessionId",
  disband_group: "taskId or sessionId",
  refresh_activity: "sessionId",
  // ★ Task #5580：select_task 需要 sessionId（卡片主键）+ taskId（要切到哪个任务）
  select_task: "taskId or sessionId",
};

/** ★ Task #5377：actionValue 的运行时形状（字段都可能缺，先当 unknown 校验） */
export interface CardActionValue {
  action?: unknown;
  taskId?: unknown;
  sessionId?: unknown;
}

/** ★ Task #5377：校验结果（判别联合 —— 通过时主键已收窄成对应类型） */
export type CardActionValidation =
  | { ok: true; action: "create_group" | "disband_group"; taskId: number; sessionId?: string }
  | {
      ok: true;
      action: "create_group" | "disband_group";
      taskId?: undefined;
      sessionId: string;
    }
  | { ok: true; action: "refresh_activity"; sessionId: string }
  /** ★ Task #5580：切任务需要 sessionId（卡片主键）+ taskId（切到哪个任务） */
  | { ok: true; action: "select_task"; sessionId: string; taskId: number }
  | { ok: false; action: string; error: string };

/**
 * ★ Task #5377 修复主体：**先判 action 白名单，再按 action 类型取主键**。
 *
 * 顺序契约（不可颠倒）：
 *   1. action 不在白名单 → `Unknown action: <action>`
 *      （此时**不看** taskId/sessionId —— 未知动作不该报"缺字段"，
 *      更不能落到解散群分支误删用户的群）
 *   2. 白名单内 → 按 `ACTION_SUBJECT_FIELD` 只校验该 action 需要的那一个字段
 *   3. 缺 / 非法 → 错误信息**必须指明字段名**（taskId 或 sessionId）
 *
 * 纯函数、无 IO，便于逐个 action 单测。
 */
export function validateCardActionValue(raw: CardActionValue): CardActionValidation {
  const action = raw.action;

  // ── 第 1 步：action 白名单（先判！）
  if (!isCardActionName(action)) {
    return { ok: false, action: String(action), error: `Unknown action: ${String(action)}` };
  }

  // ── 第 2 步：按 action 取它真正需要的主键
  //   （用显式的 action 判定收窄类型，而不是查表后的 field 值 —— TS 无法从
  //    `ACTION_SUBJECT_FIELD[action]` 反推 action 的联合成员）
  const requiredField = ACTION_SUBJECT_FIELD[action];

  if (action === "create_group" || action === "disband_group") {
    const rawTaskId = raw.taskId;
    const rawSessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";

    // ── taskId 缺失 ⇒ ★ Task #5397 走 session-only（主键可以是 sessionId）
    if (rawTaskId === undefined || rawTaskId === null || rawTaskId === "") {
      if (rawSessionId) {
        return { ok: true, action, sessionId: rawSessionId };
      }
      return {
        ok: false,
        action,
        error: `Missing required field: ${requiredField} (action=${action})`,
      };
    }
    const taskId =
      typeof rawTaskId === "number"
        ? rawTaskId
        : typeof rawTaskId === "string"
          ? parseInt(rawTaskId, 10)
          : Number.NaN;
    if (!Number.isFinite(taskId) || Number.isNaN(taskId) || taskId <= 0) {
      // ★ Task #5397：**只**在 taskId「缺失」时才降级到 sessionId 主键。
      //   taskId 存在但非法（"abc" / 0 / -1）是**脏数据**，必须硬失败 ——
      //   静默降级到 session-only 会替用户建出一个他没要的群（且 #5377 的
      //   「非法 taskId ⇒ Invalid taskId」契约要保留）。
      return { ok: false, action, error: `Invalid taskId: ${String(rawTaskId)}` };
    }
    return {
      ok: true,
      action,
      taskId,
      ...(rawSessionId ? { sessionId: rawSessionId } : {}),
    };
  }

  // session 类动作（field === "sessionId"）：**绝不**回退到 taskId
  const rawSessionId = raw.sessionId;
  const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
  if (!sessionId) {
    return {
      ok: false,
      action,
      error: `Missing required field: ${requiredField} (action=${action})`,
    };
  }

  // ★ Task #5580：select_task 除 sessionId 外还必须带合法 taskId
  //   （「切到哪个任务」是动作语义的一部分，缺了就无法渲染）。
  if (action === "select_task") {
    const rawTaskId = raw.taskId;
    const taskId =
      typeof rawTaskId === "number"
        ? rawTaskId
        : typeof rawTaskId === "string"
          ? parseInt(rawTaskId, 10)
          : Number.NaN;
    // ★ CV P9（#5580）：区分「缺字段」与「字段非法」—— 前者是卡片版本过旧，
    //   后者是脏数据，混成一句 "Missing" 会把排查方向带偏（与 group 动作的
    //   `Invalid taskId: <raw>` 契约对齐）。
    if (rawTaskId === undefined || rawTaskId === null || rawTaskId === "") {
      return {
        ok: false,
        action,
        error: `Missing required field: taskId (action=${action}; sessionId=${sessionId})`,
      };
    }
    if (!Number.isFinite(taskId) || Number.isNaN(taskId) || taskId <= 0) {
      return {
        ok: false,
        action,
        error: `Invalid taskId: ${String(rawTaskId)} (action=${action})`,
      };
    }
    return { ok: true, action, sessionId, taskId };
  }

  return { ok: true, action, sessionId };
}

/**
 * ★ Task #5377：session 类卡片（refresh_activity）的外部刷新实现（**可选**）。
 *
 * 生产默认**不需要**注入它 —— 内置的 `handleRefreshSessionActivity`（#5364）
 * 只依赖数据端口 `loadSessionActivity` 就能渲染整张 session 卡。
 * 本端口留给需要跨进程 / 特殊渲染的宿主复用同一 handler。
 *
 * ⚠️ 契约：**端口只负责 render，不负责发**。返回的 `cardUpdate` 由 caller
 * 统一 patch（见 event-source-handlers 的 handleCardActionEvent），
 * 所以端口实现**不要**自己再 patch 一次（会重复更新）。
 */
export type SessionCardRefreshHandler = (opts: {
  sessionId: string;
  chatId: string;
  messageId: string;
  token: string;
  profile?: string;
}) => Promise<{
  /** 渲染好的卡片 payload（caller 负责发） */
  cardUpdate?: ReturnType<typeof buildTaskCard>;
  error?: string;
}>;

/**
 * ★ Task #5580（CV P6 配套）：`loadSessionTasks` 的**带总数**返回形态。
 *
 * ## 为什么需要
 *
 * 端口为了压掉 N+1 查询，详情只取**前 N 个**（默认 20）；但卡片要写
 * 「共 12 个任务」，数字必须来自**真实总数**，不能退化成「共 20 个」。
 *
 * 兼容：端口也可以直接返回数组（老形态）—— 那时总数按数组长度计。
 */
export interface SessionCardTaskListResult {
  tasks: SessionCardTaskSummaryPortItem[];
  /** 该 session 关联的**全部** task 数量（可大于 tasks.length） */
  total?: number;
}

/**
 * ★ Task #5580：`loadSessionTasks` 端口的条目形状（= 渲染层摘要 + 可选详情字段）。
 *
 * 端口实现可以直接返回 `Task` 实体（多字段无害），渲染层只取它认识的。
 */
export type SessionCardTaskSummaryPortItem = SessionCardTaskSummary & {
  currentStatus?: string;
  priority?: string;
  parentTaskId?: number;
  goals?: string;
  createdAt?: string;
  updatedAt?: string;
};

/** 端口注入（caller 提供 IO 能力，本模块保持纯函数） */
export interface CardActionPorts {
  /** 读取 task（用于读 context）★ #5581：session_id 可选透传（MCP 路径按钮主键） */
  getTask?: (id: number) => Promise<{ context?: string; title?: string; description?: string; goals?: string; priority?: string; type?: string; project_path?: string; parent_task_id?: number | null; current_status?: string; session_id?: string | null; id: number } | undefined>;
  /** 写 task.context（用于回写/清除 larkPerTaskChatId） */
  updateTaskContext?: (taskId: number, newContext: string) => Promise<void>;
  /**
   * 创建群聊
   * @param opts.initialUserIds ★ Task #4337：建群时一并拉人（如操作者 open_id）；用 `+chat-create --users` 一次到位
   * @param opts.initialBotIds ★ Task #5425：建群时一并拉 bot（app_id cli_xxx）；不拉 bot 发卡会 230002
   */
  createGroupChat?: (opts: {
    name: string;
    description: string;
    profile?: string;
    initialUserIds?: string[];
    initialBotIds?: string[];
  }) => Promise<string>;
  /** 解散群聊 */
  deleteGroupChat?: (chatId: string, profile?: string) => Promise<void>;
  /**
   * 拉用户进群（Task #4337 后置邀请 fallback）
   * 实际推荐用 createGroupChat({initialUserIds}) 一次到位；本端口是 fallback
   * （caller 实现可以是 no-op，因为 --users 已经邀请好了）
   */
  inviteUser?: (chatId: string, userOpenId: string, profile?: string) => Promise<void>;
  /**
   * ★ Task #5360：读 sub-session 活性（消息数 + 最后写入时间 + 最近消息）。
   *
   * 用户点「🔄 刷新活性」时调用，用来判断**有没有 LLM 在推进**。
   *
   * 不注入 / 抛错 / 返回 undefined ⇒ 卡片渲染「暂无数据」，
   * **绝不让 patch 失败**（与其它端口同一套 best-effort 语义）。
   *
   * 装配点见 `event-source-handlers.ts` 的 `wireCardActionPorts()`
   * （复用 `createActivityProbe`，与企微侧同一份实现）。
   */
  loadSubSessionActivity?: (
    taskId: number,
  ) => Promise<ActivityProbeResult> | ActivityProbeResult;
  /**
   * ★ Task #5360：任务是否已终态（决定活性档位报「已结束」而非「疑似停滞」）。
   * 不注入 ⇒ 按非终态处理（最坏情况是终态任务显示"疑似停滞"，不影响可用性）。
   */
  isTerminalTask?: (taskId: number) => Promise<boolean> | boolean;
  /**
   * ★ CV BLOCKER-1：按 taskId 反查所属 sub-session（旧卡片向后兼容）。
   *
   * 存量 task 卡的按钮 value 只有 `taskId`（改造前的形态）。为了让它们
   * 不失效，用一个反查端口把它们补成标准 `{sessionId, taskId}` subject。
   *
   * 装配点实现：`taskId → BackgroundTaskManager.listTasks() 里
   * associatedTaskId 命中 → subSessionId`。
   * 不注入 / 反查不到 ⇒ 旧卡片刷新被拒（不猜）。
   */
  resolveSessionIdByTask?: (
    taskId: number,
  ) => Promise<string | undefined> | string | undefined;
  /**
   * ★ 补充需求（22:31）：**session-only** 活性读取（无 task 场景）。
   *
   * 与 `loadSubSessionActivity(taskId)` 的区别：后者要从 task 反查 bgTask 才能
   * 拿到 subSessionId；本端口**直达** session store —— 因为调用方手里已经有
   * sessionId 了，而这条链上**根本没有 task**。
   *
   * 不注入 / 抛错 ⇒ 卡片渲染「暂无数据」，绝不阻断 patch。
   */
  loadSessionActivity?: (
    sessionId: string,
  ) => Promise<ActivityProbeResult> | ActivityProbeResult;
  /**
   * ★ Task #5420：「💬 会话查看」—— 读最近 N 条消息。
   *
   * 与 `loadSessionActivity` 的区别：活性只带**最近 1 条**消息
   * （判断有无 LLM 推进够用）；本端口取**尾部 5 条**（用户拍板
   * 「A 五条，只展示名称和 reason」）。
   *
   * 装配点实现：`getMessages(sessionId, { offset: -1, limit: 5 })`
   * （sqlite 负 offset 语义 = total + offset*limit，-1×5 = 最新 5 条）。
   *
   * 不注入 / 抛错 / 返回 undefined ⇒ **不渲染**最近消息面板
   * （降级不抛，与活性端口同一套 best-effort 语义）；
   * 返回 [] ⇒ 面板照出 + 「暂无消息」（诚实）。
   */
  loadSessionMessages?: (
    sessionId: string,
    limit?: number,
  ) =>
    | Promise<ActivityMessage[] | ToolCallView[] | undefined>
    | ActivityMessage[]
    | ToolCallView[]
    | undefined;
  /**
   * ★ Task #5580：读该 session 内的**全部 task**（最近优先，最多若干条）。
   *
   * 用途：session 卡的「🗂️ 任务列表」面板（一个 session 复用多次时会有多个
   * task 生命周期，只显示单 task 不够）。
   *
   * 装配点实现：`taskComponent.getTaskIdsBySessionId(sessionId)` + 逐个 `getTask`。
   *
   * 不注入 / 抛错 ⇒ 不渲染任务列表面板（降级不抛，与其它端口同一套
   * best-effort 语义）；返回 [] ⇒ 面板不渲染（没有任务 = 没有这个面板）。
   */
  loadSessionTasks?: (
    sessionId: string,
  ) =>
    | Promise<SessionCardTaskListResult | SessionCardTaskSummaryPortItem[] | undefined>
    | SessionCardTaskListResult
    | SessionCardTaskSummaryPortItem[]
    | undefined;
  /**
   * ★ Task #5580：读某个 task 的里程碑（task_operation 的 milestone 形态）。
   *
   * 用途：点 `select_task` 后渲染「📌 任务里程碑」区。
   *
   * 不注入 / 抛错 ⇒ 里程碑区显示「（该任务暂无里程碑）」，绝不阻断整卡 patch。
   */
  loadTaskMilestones?: (
    taskId: number,
  ) =>
    | Promise<Milestone[] | undefined>
    | Milestone[]
    | undefined;
  /**
   * ★ Task #5403：建群成功后初始化「群 session」—— **关联建群**。
   *
   * 取代 #5369 的 `linkSessionAlias`（alias / linkedTo 能力已整体废弃）。
   *
   * 新语义：群 session 是**独立会话**，不共享原会话历史。本端口负责：
   *  1. 建/补群 session 行（id = chatId，metadata 带 `linkedFromSessionId`）
   *  2. 注入 **1 条 user role** 事件说明「本群由 session X 关联建群，需要
   *     背景时用 `roy-bot sessions messages X` 按需读取」
   *
   * 为什么不共享历史（用户 2026-11-12 定稿）：群 session 由 default agent 的
   * system prompt 驱动，原 sub session 由 sub agent 驱动 —— 复用 history 会让
   * LLM prefix cache 失效，且 sub agent 的 delegate prompt（「不要发飞书消息」）
   * 会污染群对话（#5396 实测 0 回复）。
   *
   * 可选端口：
   *  - 未注入 → 建群照旧成功（向后兼容，老部署不炸）
   *  - 抛错   → best-effort 吞掉，**绝不回滚已建好的群**
   */
  attachGroupSession?: (args: {
    chatId: string;
    originSessionId: string;
    title?: string;
  }) => Promise<unknown>;
  /**
   * ★ Task #5397：**会话 → 群** 反向查询（等价 task 维度的
   * `task.context.larkPerTaskChatId`）。
   *
   * 用途（三处）：
   * 1. **重复建群保护**：同 session 已有群 ⇒ 返回已有群链接，不新建
   * 2. 卡片显示已有群链接（session 卡首渲 / 刷新时带 `perTaskChatId`）
   * 3. 解绑时定位要解散哪个群
   *
   * 装配点实现：`SessionComponent.findGroupChatForSession(sessionId)`
   * —— 扫 metadata `linkedFromSessionId`（Task #5403 起，走 JSON1 抽取，
   * 零 schema 变更；`linked_to` 列已废弃不再使用）。
   *
   * 不注入 ⇒ session-only 建群失去重复保护（仍能建），解绑退化为「无群可解」
   * （明确报错，不静默成功）。
   */
  findGroupChatForSession?: (
    sessionId: string,
  ) => Promise<{ chatId: string; aliasSessionId?: string } | undefined>
    | { chatId: string; aliasSessionId?: string }
    | undefined;
  /**
   * ★ Task #5403：解除「会话 ↔ 群」的关联（解绑时调用）。
   *
   * 取代 #5397 的 `unlinkSessionAlias`。新语义：群 session 是独立会话，解绑
   * 只是把「这个群还活着」的标记打掉（metadata.groupDisbandedAt），让
   * `findGroupChatForSession` 不再命中它。
   *
   * 不注入 / 抛错 ⇒ best-effort 吞掉（群已经解散了，不能让 detach 失败把结果
   * 翻成失败）。
   */
  detachGroupSession?: (chatId: string) => Promise<{ ok: boolean } | void>;
  /**
   * ★ Task #5397：读会话标题（session-only 建群时用来生成群名）。
   *
   * 不注入 / 取不到 ⇒ 群名退化为 `会话 <sessionId 截断>`。
   */
  getSessionTitle?: (sessionId: string) => Promise<string | undefined> | string | undefined;
  /**
   * 卡片更新（用 messageId patch）
   */
  notifier: LarkCardPatchNotifier;
  /**
   * ★ Task #4339：用飞书 30min token patch 卡片（可选端口）。
   *
   * 飞书推 card.action.trigger 时会带一个 30min 有效、最多用 2 次的 token；
   * 点了按钮之后必须立刻用它把原卡片刷成新形态（按钮翻面 + 群链接）。
   *
   * 不注入时 caller 用默认实现（`patchCardByLarkCli` → `lark-cli api POST
   * /open-apis/interactive/v1/card/update`）。
   * 抽成端口是为了单测能断言"patch 被调用了 / 内容对不对"而不真发请求。
   */
  patchByToken?: (token: string, card: unknown, profile?: string) => Promise<void>;
  /**
   * ★ Task #5377：session 类卡片（refresh_activity）的外部刷新实现（可选）。
   *
   * 未注入 ⇒ 走内置 `handleRefreshSessionActivity`（#5364 生产默认路径）；
   * 连 `loadSessionActivity` 也没有 ⇒ 返回**指明 action 的**错误
   * （而不是改造前那句误导性的 `Invalid taskId: undefined`）。
   */
  refreshSessionCard?: SessionCardRefreshHandler;
}

/** 路由决策 / 处理结果 */
export interface CardActionResult {
  ok: boolean;
  /**
   * 成功执行的操作。
   * ★ 合并：`CardActionName`（正常路径）× `#5377` 未知 action 时保留原始字符串
   * （便于日志定位是哪个拼错/第三方动作打进来的）
   */
  action: CardActionName | string;
  /** 新的 chatId（create 成功时返回；disband 成功时返回空） */
  newChatId?: string;
  /** 给飞书的卡片更新 payload（用 token 即时 patch） */
  cardUpdate?: ReturnType<typeof buildTaskCard>;
  /** 错误信息（ok=false 时） */
  error?: string;
}

/** 上下文 key（与 per-task-group-chat-plugin 保持一致） */
/**
 * ★ Task #5369：从 task.context 里挑出「本 task 所属的 sub-session / session id」。
 *
 * 顺序：`subSessionId`（delegate 起的子会话）→ `sessionId`（通用键）。
 * 都没有则返回 undefined —— 此时**不建 alias**（不猜目标，宁可没有链也不能链错）。
 */
function extractTargetSessionId(context: string | undefined): string | undefined {
  if (!context) return undefined;
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    for (const key of ["subSessionId", "sessionId"]) {
      const v = parsed[key];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * ★ Task #5390：解析「群 session 应该链到哪个 session」。
 *
 * ## 为什么必须改（#5369 的 bug）
 *
 * #5369 只从 `task.context` 的 `subSessionId` / `sessionId` 取目标，但**生产
 * 上从来没有代码写这两个 key**：
 *
 *   tasks.db 全库 4934 条任务，context 带 subSessionId/sessionId 的 = 0 条
 *
 * 于是 `extractTargetSessionId()` 永远返回 undefined ⇒ 建群后从不 link ⇒
 * 新群是个空 session（用户问「我们聊了啥」得到「这个群其实还没有对话」）。
 *
 * ## 真正的目标来源（本就存在，只是没读）
 *
 * 卡片按钮 value 一直带 `sessionId`（`buildSessionCard` / `buildTaskCard`
 * 都塞了），`CardActionEvent.actionValue.sessionId` 也早已声明 —— 这是
 * **主路径**，卡片上点建群的人手里就握着它。
 *
 * ## 优先级（高 → 低）
 *
 * 1. `event.actionValue.sessionId` —— 卡片主键，生产真实来源
 * 2. `task.context.subSessionId` / `sessionId` —— 向后兼容（老宿主可能真写过）
 * 3. `ports.resolveSessionIdByTask?.(taskId)` —— 旧卡兜底（按钮 value 只有
 *    taskId 的存量卡片），复用 `refresh_activity` 已有的反查端口
 * 4. 都取不到 → undefined，**不猜**（保持 #5369 的安全语义）
 *
 * 任一步抛错/取空都继续往下一级走，绝不因为反查失败阻断建群。
 */
async function resolveGroupLinkTargetSessionId(
  event: CardActionEvent,
  ports: CardActionPorts,
  taskId: number,
  taskContext: string | undefined
): Promise<{ sessionId: string | undefined; source: string }> {
  // ── 1. 卡片带来的 sessionId（主路径）
  const fromCard = event.actionValue?.sessionId;
  if (typeof fromCard === "string" && fromCard.trim().length > 0) {
    return { sessionId: fromCard.trim(), source: "card" };
  }

  // ── 2. task.context（向后兼容）
  const fromContext = extractTargetSessionId(taskContext);
  if (fromContext) {
    return { sessionId: fromContext, source: "task.context" };
  }

  // ── 3. 旧卡兜底：反查 task → sub-session（端口与 refresh_activity 共用）
  if (ports.resolveSessionIdByTask) {
    try {
      const resolved = await ports.resolveSessionIdByTask(taskId);
      if (typeof resolved === "string" && resolved.trim().length > 0) {
        return { sessionId: resolved.trim(), source: "resolveSessionIdByTask" };
      }
    } catch (err) {
      logger.warn(
        `resolveGroupLinkTargetSessionId: resolveSessionIdByTask(${taskId}) 失败（继续跳过 link）: ` +
          `${(err as Error).message}`
      );
    }
  }

  return { sessionId: undefined, source: "none" };
}

/**
 * ★ Task #5369：best-effort 把群 session 链到原 sub-session。
 * 失败只 warn 不抛（建群已经成功了，不能让 link 失败把结果翻成失败）。
 *
 * ★ Task #5390：目标改由 `resolveGroupLinkTargetSessionId` 三级解析
 * （此前只读 task.context，生产恒为空 ⇒ 本函数永远静默 return）。
 */
async function attachGroupSessionForTask(
  event: CardActionEvent,
  ports: CardActionPorts,
  taskId: number,
  chatId: string,
  taskContext: string | undefined
): Promise<void> {
  if (!ports.attachGroupSession) return;
  const { sessionId: targetSessionId, source } = await resolveGroupLinkTargetSessionId(
    event,
    ports,
    taskId,
    taskContext
  );
  if (!targetSessionId) {
    logger.warn(
      `attachGroupSessionForTask: 取不到目标 session（card/context/resolveSessionIdByTask 全空），` +
        `跳过关联 —— 群 ${chatId} 将是独立空会话（无背景提示）`
    );
    return;
  }
  try {
    await ports.attachGroupSession({
      chatId,
      originSessionId: targetSessionId,
      title: `Lark Chat ${chatId}`,
    });
    logger.info(
      `attachGroupSessionForTask: ${chatId} ← ${targetSessionId}` +
        `（来源=${source}，已注入 1 条 user 事件作为背景提示）`
    );
  } catch (err) {
    logger.warn(
      `attachGroupSessionForTask: attach(${chatId} ← ${targetSessionId}) 失败（不阻断建群）: ` +
        `${(err as Error).message}`
    );
  }
}

const CTX_FIELD_CHAT_ID = "larkPerTaskChatId";
const CTX_FIELD_CHAT_NAME = "larkPerTaskChatName";
const CTX_FIELD_CHAT_CREATED_AT = "larkPerTaskChatCreatedAt";
const CTX_FIELD_CHAT_TASK_ID = "larkPerTaskChatTaskId";
/** Task #4337：记录已邀请的人（数组）。解散时保留（观察用）。 */
const CTX_FIELD_CHAT_INVITEES = "larkPerTaskChatInvitees";

/**
 * ★ Task #4339：同一 (taskId, action) 的**并发点击去重**。
 *
 * 根因：`LarkCliInstance.handleEvent` 对 card.action.trigger 是 fire-and-forget
 * （`void this.handleCardActionEvent(...)`），用户双击按钮会产生两条不同
 * event_id 的事件（通用 event_id 去重挡不住）→ 两个 handleCardAction 并发进入
 * → 都读到 `existingChatId === undefined` → **建出两个群**。
 *
 * key = `${taskId}:${action}`；value = 正在处理的 promise。
 * 后到的同 key 请求直接拒绝（不 patch 卡片，避免两次重复 patch）。
 */
const cardActionInflight = new Map<string, Promise<CardActionResult>>();

/**
 * 测试钩子：清空 in-flight 去重表（仅供单测 beforeEach 使用）。
 */
export function __resetCardActionInflightForTest(): void {
  cardActionInflight.clear();
}

/**
 * 处理卡片按钮点击
 *
 * @returns 处理结果（ok=true 表示 action 已成功执行；ok=false 表示错误）
 */
export async function handleCardAction(
  event: CardActionEvent,
  ports: CardActionPorts
): Promise<CardActionResult> {
  const rawAction = event.actionValue.action;

  // ★★ 语义合并（#5364 × #5377）—— 三层顺序契约，不可颠倒：
  //
  //   ① **先判 action 白名单**（#5377）：未知动作不看任何主键，且绝不落到
  //      「解散群」分支（改造前 if/else 会误删用户的群）。
  //   ② **session 类动作（refresh_activity）**：主键是 sessionId（#5364 澄清
  //      22:37「sessionId 永远是卡片主键」），旧卡（只有 taskId）用
  //      `resolveSessionIdByTask` 反查兜底 —— 见 `handleRefreshSessionCard`。
  //   ③ **group 类动作（create_group / disband_group）**：只校验 taskId
  //      （#5377），缺字段报 **字段名**；旧卡只带 taskId 也照常工作。
  //
  // #5364 的不变量（一个 session 一张卡 / 刷新走 session store / 旧 task 卡
  // 能反查）与 #5377 的不变量（未知 action 不误解散群 / 缺字段报字段名 /
  // session 动作不需要 taskId）在这里**同时成立**。
  if (!isCardActionName(rawAction)) {
    // 白名单外的 action：不读 task、不碰群、不留原始值歧义
    return { ok: false, action: String(rawAction), error: `Unknown action: ${String(rawAction)}` };
  }

  // ② session 类动作：session 主键路径（含旧卡 taskId 反查兜底）
  if (rawAction === "refresh_activity") {
    return await handleRefreshSessionCard(event, ports);
  }

  // ③ group 类动作：按 action 取主键（#5377 的 validateCardActionValue）
  const validation = validateCardActionValue(event.actionValue);
  // ⚠️ 为什么这里用显式 cast 而不是直接靠判别联合收窄：
  //   `packages/cli/tsconfig.json` 是 `strict: false`（没有 strictNullChecks），
  //   在这种配置下 `ok: true | false` 会塌成 `boolean`，**按 `ok` 的判别收窄
  //   失效**（core 自己的 strict tsconfig 没问题，cli 会把 core 源码一起编）。
  //   收窄语义仍然由 `validateCardActionValue` 的返回类型静态保证，这里只是
  //   让两种 tsconfig 都能编过。
  if (!validation.ok) {
    const failed = validation as Extract<CardActionValidation, { ok: false }>;
    return { ok: false, action: rawAction, error: failed.error };
  }
  // refresh_activity 已在上面走 session 主键路径，这里理论上不可达；显式写出
  // 也作为「将来加新 session 类 action 但忘了在上面分发」的运行时兜底。
  if (validation.action === "refresh_activity") {
    return await handleRefreshSessionCard(event, ports);
  }
  // ★ Task #5580：select_task —— 点任务列表里的任务 → 切换执行动态 + 里程碑区
  if (validation.action === "select_task") {
    const sel = validation as Extract<
      CardActionValidation,
      { ok: true; action: "select_task" }
    >;
    return await handleSelectTask(event, ports, {
      sessionId: sel.sessionId,
      taskId: sel.taskId,
    });
  }
  const groupValidation = validation as Extract<
    CardActionValidation,
    { ok: true; action: "create_group" | "disband_group" }
  >;
  const action = groupValidation.action;
  const taskId = groupValidation.taskId;
  // ★ Task #5397：group 动作的**第二主键** —— 无 task 时用它走 session-only 路径。
  const subjectSessionId = groupValidation.sessionId;

  // ★ Task #4339：并发点击去重（防双击建出两个群）
  //   key 用「profile + 卡片 messageId + action」——双击产生的两条事件
  //   message_id 相同；而不同 app（profile）/ 不同卡片的点击互不影响。
  //   （只按 taskId 做 key 会把"同一 task 在别的 app 下的卡片点击"误判成重复）
  //
  // ★ Task #5397：session-only 路径没有 taskId，兜底主键改用 sessionId
  //   （否则所有无 task 的建群点击都会撞到同一个 `undefined` key 被误判重复）。
  const inflightSubject =
    event.messageId || (taskId !== undefined ? String(taskId) : subjectSessionId) || "-";
  const inflightKey = `${event.profile ?? "-"}:${inflightSubject}:${action}`;
  const inflight = cardActionInflight.get(inflightKey);
  if (inflight) {
    logger.warn(
      `handleCardAction: ${inflightKey} 已有同操作在处理中（疑似用户重复点击），本次忽略。`
    );
    return { ok: false, action, error: `重复点击：${inflightKey} 正在处理中，已忽略` };
  }

  const pending =
    taskId !== undefined
      ? handleCardActionInner(event, ports, action, taskId)
      : handleGroupActionSessionOnly(event, ports, action, subjectSessionId!);
  cardActionInflight.set(inflightKey, pending);
  try {
    return await pending;
  } finally {
    cardActionInflight.delete(inflightKey);
  }
}

/**
 * session 类卡片（`refresh_activity`）的处理路径 —— **sessionId 是主键**。
 *
 * ## 两个分支（语义合并，不是二选一）
 *
 * | | 条件 | 行为 |
 * |---|---|---|
 * | A. 外部端口 | `ports.refreshSessionCard` 已注入 | 交给端口渲染（#5377 契约：端口**只 render 不发**，caller 统一 patch） |
 * | B. 内置默认 | 端口未注入 | `handleRefreshSessionActivity`（#5364：直接读 `loadSessionActivity` + task 增强，不需要外部实现） |
 *
 * 为什么两个都要：B 是生产默认（飞书装配点只注入数据端口，不注入 handler），
 * A 留给需要跨进程 / 特殊渲染的宿主（如企微侧复用的实现）。两者都不碰 task
 * 的写、不碰群的建/删。
 *
 * ## 旧卡兜底（#5364 CV BLOCKER-1）
 *
 * 改造前发出去的 task 卡按钮 value **只有 taskId**。若直接拒绝，存量卡片会
 * 全部失效。所以：无 sessionId 但有合法 taskId 时，用 `resolveSessionIdByTask`
 * 反查 → 拿到后**补全成标准 subject** 再走 session 主键路径（语义仍是
 * session 主键，只是多一步反查）。反查不到 ⇒ 才拒绝（不猜）。
 */
async function handleRefreshSessionCard(
  event: CardActionEvent,
  ports: CardActionPorts
): Promise<CardActionResult> {
  const action = "refresh_activity" as const;

  // ---- 1. 主键：sessionId 优先（#5364：session 永远是卡片主键）----
  let subject: CardSubject | undefined = pickCardSubject(event.actionValue);

  // ---- 2. 旧卡兜底：只有 taskId ⇒ 反查 sessionId（不猜、失败即拒绝）----
  if (!subject) {
    const legacyTaskId = parseTaskIdLoose(event.actionValue.taskId);
    if (legacyTaskId !== undefined) {
      let resolved: string | undefined;
      try {
        resolved = await ports.resolveSessionIdByTask?.(legacyTaskId);
      } catch {
        resolved = undefined;
      }
      if (resolved) {
        subject = { sessionId: resolved, taskId: legacyTaskId };
        logger.info(
          `handleCardAction: 旧 task 卡 #${legacyTaskId} 无 sessionId，` +
            `反查得到 ${resolved}（按 session 主键刷新）`,
        );
      }
    }
  }

  if (!subject) {
    // 缺的是 **sessionId** 这个字段（不是 taskId —— #5377 的病根就在这个错位上）
    return {
      ok: false,
      action,
      error:
        `Missing required field: sessionId (action=${action}; sessionId is required ` +
        `as the card primary key, got taskId=${String(event.actionValue.taskId)})`,
    };
  }

  // ---- 3. 能力闸门：有没有「session 卡渲染能力」？----
  //
  // 两个来源任一即可：
  //   a) `loadSessionActivity` 数据端口（生产装配点注入，见 event-source-handlers）
  //   b) notifier 的 `buildSessionCardWithActivity`（进程内有 session 卡状态）
  //
  // 都没有 ⇒ **明确报"没有渲染实现"**（而不是假装成功发一张空卡）。这正是
  // #5377 要求的行为：错误信息指名 action，且绝不误报 `Invalid taskId`。
  const canRenderSessionCard =
    ports.loadSessionActivity !== undefined ||
    typeof ports.notifier?.buildSessionCardWithActivity === "function";

  // ---- 3-Legacy. 旧装配点（只注入了 task 维度的活性 probe）----
  //
  // 只在「没有 session 渲染能力 + 有旧 probe + 有 task」时启用。这是 #5360 之前
  // 的 task 主键刷新路径，保留是为了不打死只升级了一半的宿主；生产装配点
  // 三者都有，走的是下面的 session 主键路径（#5364 澄清 22:37 的语义）。
  if (!canRenderSessionCard && ports.loadSubSessionActivity && subject.taskId !== undefined) {
    const legacyTask = await ports.getTask?.(subject.taskId);
    if (legacyTask) {
      logger.info(
        `handleCardAction: 旧装配点（无 loadSessionActivity）—— task #${subject.taskId} ` +
          `刷新回落到 task 主键路径（保留 #5360 之前的可达性）`,
      );
      return await handleRefreshActivity(event, ports, legacyTask, subject.taskId);
    }
  }

  if (!canRenderSessionCard && !ports.refreshSessionCard) {
    logger.warn(
      `handleCardAction: refresh_activity 已通过 sessionId 校验（sessionId=${subject.sessionId}），` +
        `但既没有 ports.refreshSessionCard，也没有 loadSessionActivity / ` +
        `buildSessionCardWithActivity —— 无 session 卡渲染实现。`,
    );
    return {
      ok: false,
      action,
      error:
        `refresh_activity not available: no session card renderer injected ` +
        `(sessionId=${subject.sessionId}; ports.refreshSessionCard / loadSessionActivity both missing)`,
    };
  }

  // ---- 3A. 外部端口优先（#5377 契约）----
  if (ports.refreshSessionCard) {
    // 并发去重（对齐 task 路径：双击只处理第一次）
    const inflightKey = `${event.profile ?? "-"}:${event.messageId || subject.sessionId}:${action}`;
    const inflight = cardActionInflight.get(inflightKey);
    if (inflight) {
      logger.warn(
        `handleCardAction: ${inflightKey} 已有同操作在处理中（疑似用户重复点击），本次忽略。`
      );
      return { ok: false, action, error: `重复点击：${inflightKey} 正在处理中，已忽略` };
    }

    const pending = (async (): Promise<CardActionResult> => {
      try {
        const result = await ports.refreshSessionCard!({
          sessionId: subject!.sessionId,
          chatId: event.chatId,
          messageId: event.messageId,
          token: event.token,
          profile: event.profile,
        });
        if (result.error) {
          return { ok: false, action, error: result.error };
        }
        return { ok: true, action, cardUpdate: result.cardUpdate };
      } catch (err) {
        logger.error(`handleCardAction.refresh_activity failed: ${(err as Error).message}`);
        return { ok: false, action, error: (err as Error).message };
      }
    })();

    cardActionInflight.set(inflightKey, pending);
    try {
      return await pending;
    } finally {
      cardActionInflight.delete(inflightKey);
    }
  }

  // ---- 3B. 内置默认实现（#5364：生产装配点走这条）----
  return await handleRefreshSessionActivity(event, ports, subject);
}

/**
 * ★ Task #5397 —— **session-only** 的建群 / 解绑（卡片上没有 taskId）。
 *
 * ## 为什么需要这条路径
 *
 * 用户拍板（2026-11-12 15:35）「做「无 task 也能建群」」：
 * 没有 task 的 sub-session 也应该能建一个自己的群，而且群里能读到**自己的
 * 背景提示（靠建群后的 `attachGroupSession` —— 群 session 是**独立会话**，
 * 只注入 1 条 user 事件说明「原 session 可作背景、按需用 sessions messages 读」）。
 *
 * ## 与 task 路径的差异（关键：不碰 task）
 *
 * | | task 路径 | session-only 路径（本函数） |
 * |---|---|---|
 * | 前置 | `getTask(taskId)`，读 `task.context` | **完全不读 task** |
 * | 已有群判定 | `task.context.larkPerTaskChatId` | `findGroupChatForSession(sessionId)` |
 * | 建群后回写 | `updateTaskContext(larkPerTaskChatId)` | **不写任何 task.context** |
 * | 群 → 会话 | `attachGroupSession({chatId, originSessionId})` | 同（origin = 本 sessionId） |
 * | 解绑后回写 | 清 task.context 群字段 | `detachGroupSession(chatId)` |
 *
 * ## 降级语义（每层都不把成功翻成失败）
 *
 * - `findGroupChatForSession` 未注入/抛错 ⇒ 当作"没有群"（建群会重复，但不会崩）
 * - `attachGroupSession` 失败 ⇒ warn（群已建好，不能回滚）
 * - `detachGroupSession` 失败 ⇒ warn（群已解散，不能把结果翻成失败）
 * - `getSessionTitle` 未注入 ⇒ 群名退化成 `会话 <sessionId 截断>`
 */
async function handleGroupActionSessionOnly(
  event: CardActionEvent,
  ports: CardActionPorts,
  action: "create_group" | "disband_group",
  sessionId: string,
): Promise<CardActionResult> {
  // ---- 1. 查这个会话已有的群（重复建群保护 / 解绑定位）----
  const existing = await lookupSessionGroup(ports, sessionId);

  if (action === "create_group") {
    if (existing?.chatId) {
      // 幂等命中：不重复建群（等价 task 路径的 larkPerTaskChatId 行为）
      logger.info(
        `handleGroupActionSessionOnly: 会话 ${sessionId} 已有群 ${existing.chatId}` +
          `（幂等命中，不重复建群）`,
      );
      return {
        ok: true,
        action,
        newChatId: existing.chatId,
        cardUpdate: buildCardAfterSessionGroupChange(event, ports, {
          sessionId,
          chatId: existing.chatId,
        }),
      };
    }

    if (!ports.createGroupChat) {
      return { ok: false, action, error: "ports.createGroupChat not injected" };
    }

    try {
      // 群名：优先会话标题（能读就读），否则退化成 sessionId 截断
      let title: string | undefined;
      try {
        const t = await ports.getSessionTitle?.(sessionId);
        if (typeof t === "string" && t.trim()) title = t.trim();
      } catch (err) {
        logger.warn(
          `handleGroupActionSessionOnly: getSessionTitle(${sessionId}) 失败（用 sessionId 兜底）: ` +
            `${(err as Error).message}`,
        );
      }
      const renderedName = truncateText(`会话 ${title ?? sessionId}`, 60);
      const description = truncateText(`roy-bot session ${sessionId}`, 100);

      const operatorOpenId = extractOperatorOpenId(event.operatorId);
      const initialUserIds = operatorOpenId ? [operatorOpenId] : undefined;

      // ⭐ Task #5425：建群时把 bot 拉进群（--bots）。
      //   `--as bot` 创建的群**创建者 bot 默认不在群里**，后续
      //   upsertSessionCard（#5417 新群卡）会报 230002
      //   「Bot/User can NOT be out of the chat」→ 新群永远没卡。
      //   bot app_id 从 `lark-cli auth status --json` 解析
      //   （与 deleteGroupChatViaLarkCli 同款解析），best-effort：
      //   解析失败只 warn，不阻断建群。
      let initialBotIds: string[] | undefined;
      try {
        const botAppId = await resolveBotAppId(event.profile);
        if (botAppId) initialBotIds = [botAppId];
      } catch (err) {
        logger.warn(
          `handleGroupActionSessionOnly: resolveBotAppId 失败` +
            `（bot 可能不在群里，发卡会 230002）: ${(err as Error).message}`,
        );
      }

      const chatId = await ports.createGroupChat({
        name: renderedName,
        description,
        profile: event.profile,
        initialUserIds,
        initialBotIds,
      });

      // 后置邀请 fallback（与 task 路径同语义：caller 不支持 initialUserIds 时）
      if (operatorOpenId && !initialUserIds && ports.inviteUser) {
        try {
          await ports.inviteUser(chatId, operatorOpenId, event.profile);
        } catch (err) {
          logger.warn(
            `handleGroupActionSessionOnly: inviteUser(${chatId}, ${operatorOpenId}) 失败` +
              `（不阻断主流程）: ${(err as Error).message}`,
          );
        }
      }

      // ⭐ 关键：初始化群 session（独立会话 + 1 条 user 事件背景说明）。
      //   best-effort —— 建群已经成功，初始化失败只 warn。
      await attachGroupSessionForSession(ports, chatId, sessionId, renderedName);

      // ⭐ Task #5417（方案 A）：为**新群 session** 发自己的卡。
      //   session_id = 群 session id = chatId（#5364 单卡规格：每 session
      //   每 chat 一张）。原卡不动；后续原 session 进展由
      //   notifier.syncGroupCardFromOrigin 双写到这张卡。
      //   best-effort：发卡失败只 warn，绝不把建群成功翻成失败。
      if (ports.notifier?.upsertSessionCard) {
        try {
          const cardRes = await ports.notifier.upsertSessionCard({
            chatId,
            sessionId: chatId,
            title: renderedName,
            lifecycle: "running",
            perTaskChatId: chatId,
          });
          logger.info(
            `handleGroupActionSessionOnly: 新群卡已发 chatId=${chatId} ` +
              `messageId=${cardRes.messageId}（session_id=群 session，#5417）`,
          );
        } catch (err) {
          logger.warn(
            `handleGroupActionSessionOnly: 新群卡发送失败（不阻断建群）: ` +
              `${(err as Error).message}`,
          );
        }
      }

      return {
        ok: true,
        action,
        newChatId: chatId,
        cardUpdate: buildCardAfterSessionGroupChange(event, ports, {
          sessionId,
          chatId,
          chatName: renderedName,
        }),
      };
    } catch (err) {
      logger.error(
        `handleCardAction.create_group(session-only) failed: ${(err as Error).message}`,
      );
      return { ok: false, action, error: (err as Error).message };
    }
  }

  // ---- disband_group ----
  if (!existing?.chatId) {
    return {
      ok: false,
      action,
      error: `会话 ${sessionId} 没有专属群，无需解散`,
    };
  }
  if (!ports.deleteGroupChat) {
    return { ok: false, action, error: "ports.deleteGroupChat not injected" };
  }

  try {
    await ports.deleteGroupChat(existing.chatId, event.profile);

    // 断开「群 → 会话」alias（best-effort：群都没了，链不该留着误导反查）
    //
    // ★ CV 5397 M3：**必须用 aliasSessionId（alias 行自己的 id）**，不能用
    //   chatId —— 两者在生产的 `linkSession(aliasId=chatId)` 形状下相等，但
    //   一旦 alias 行 id 与 metadata.chatId 不一致（历史 / 未来别的写入方），
    //   `unlink(chatId)` 会失败并留下**脏 alias** ⇒ findGroupChatForSession
    //   仍然命中已解散的群 ⇒ 卡片永远显示「解散该群」、下次建群幂等命中死群。
    if (!ports.detachGroupSession) {
      logger.warn(
        `handleGroupActionSessionOnly: detachGroupSession 端口未注入 ⇒ 群 ${existing.chatId} ` +
          `已解散但关联标记残留（反查仍会命中这个群）`,
      );
    } else {
      const unlinkTarget = existing.aliasSessionId ?? existing.chatId;
      try {
        await ports.detachGroupSession(unlinkTarget);
      } catch (err) {
        logger.warn(
          `handleGroupActionSessionOnly: detachGroupSession(${unlinkTarget}) 失败` +
            `（不阻断解散）: ${(err as Error).message}`,
        );
      }
    }

    return {
      ok: true,
      action,
      cardUpdate: buildCardAfterSessionGroupChange(event, ports, { sessionId }),
    };
  } catch (err) {
    logger.error(
      `handleCardAction.disband_group(session-only) failed: ${(err as Error).message}`,
    );
    return { ok: false, action, error: (err as Error).message };
  }
}

/** ★ Task #5397：读「本会话的群」（端口缺失/抛错 ⇒ undefined，不猜） */
async function lookupSessionGroup(
  ports: CardActionPorts,
  sessionId: string,
): Promise<{ chatId: string; aliasSessionId?: string } | undefined> {
  if (!ports.findGroupChatForSession) return undefined;
  try {
    const r = await ports.findGroupChatForSession(sessionId);
    if (r && typeof r.chatId === "string" && r.chatId.trim()) {
      return { chatId: r.chatId.trim(), ...(r.aliasSessionId ? { aliasSessionId: r.aliasSessionId } : {}) };
    }
    return undefined;
  } catch (err) {
    logger.warn(
      `lookupSessionGroup(${sessionId}) 失败（当作没有群）: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/** ★ Task #5403：session-only 的群 session 初始化（best-effort，绝不影响建群结果） */
async function attachGroupSessionForSession(
  ports: CardActionPorts,
  chatId: string,
  sessionId: string,
  title?: string,
): Promise<void> {
  if (!ports.attachGroupSession) {
    logger.warn(
      `attachGroupSessionForSession: 端口未注入 ⇒ 群 ${chatId} 将没有背景提示事件` +
        `（连不到 ${sessionId} 的溯源信息）`,
    );
    return;
  }
  try {
    await ports.attachGroupSession({
      chatId,
      originSessionId: sessionId,
      ...(title ? { title } : {}),
    });
    logger.info(
      `attachGroupSessionForSession: ${chatId} ← ${sessionId}` +
        `（已注入 1 条 user 事件作为背景提示）`,
    );
  } catch (err) {
    logger.warn(
      `attachGroupSessionForSession: attach(${chatId} ← ${sessionId}) 失败（不阻断建群）: ` +
        `${(err as Error).message}`,
    );
  }
}

/**
 * ★ Task #5397：session 卡「群状态变化」后的卡片重建。
 *
 * 优先走 notifier 的 `applySessionGroupChange`（保留标题/里程碑/活性/
 * updateCount，并同步 state —— 否则下一次生命周期 patch 会把群链接擦掉）。
 * notifier 不认这张卡（重启未 hydrate）⇒ fallback 用最小 meta 重建。
 */
function buildCardAfterSessionGroupChange(
  event: CardActionEvent,
  ports: CardActionPorts,
  opts: { sessionId: string; chatId?: string; chatName?: string },
): ReturnType<typeof buildSessionCard> {
  const preserved = ports.notifier?.applySessionGroupChange?.(event.messageId, {
    sessionId: opts.sessionId,
    // ★ Task #5414 修复（用户实测「建群后卡片没有群链接」）：
    //   旧代码把 opts 原样透传，但 applySessionGroupChange 期望的参数名是
    //   perTaskChatId/perTaskChatName —— 传 chatId 进去等于没传，
    //   undefined ⇒ 走 delete 分支把卡上的群链接擦掉。
    //   fallback 分支（buildSessionCard）用的是 chatId，所以只有
    //   notifier 命中时才触发这个 bug。
    ...(opts.chatId ? { perTaskChatId: opts.chatId } : {}),
    ...(opts.chatName ? { perTaskChatName: opts.chatName } : {}),
  });
  if (preserved) return preserved;

  logger.warn(
    `buildCardAfterSessionGroupChange: notifier 无 messageId=${event.messageId} 的状态，` +
      `fallback 重建 session 卡（历史里程碑可能丢失）`,
  );
  return buildSessionCard({
    sessionId: opts.sessionId,
    ...(opts.chatId ? { perTaskChatId: opts.chatId } : {}),
    ...(opts.chatName ? { perTaskChatName: opts.chatName } : {}),
  });
}

async function handleCardActionInner(
  event: CardActionEvent,
  ports: CardActionPorts,
  action: "create_group" | "disband_group",
  taskId: number,
): Promise<CardActionResult> {
  // 读取 task
  if (!ports.getTask) {
    return { ok: false, action, error: "ports.getTask not injected" };
  }
  const task = await ports.getTask(taskId);
  if (!task) {
    return { ok: false, action, error: `Task #${taskId} not found` };
  }

  const existingChatId = extractPerTaskChatId(task.context);

  // ★ Task #5360：显式 switch（不写 default —— action 已被白名单 + 判别联合
  //   收窄成 "create_group" | "disband_group"，漏分支编译不过）。
  switch (action) {
    case "create_group":
      return await handleCreateGroup(event, ports, task, existingChatId);
    case "disband_group":
      return await handleDisbandGroup(event, ports, task, existingChatId);
  }
}

/**
 * ★ Task #4339：构建"群状态变化"后的卡片。
 *
 * 优先走 notifier 的 `updateMetaAndBuildCard` —— 它会**保留**卡片上已累积的
 * 里程碑 / 过程时间线 / 进度 / 更新次数（并同步内部 state.meta，避免下一次
 * updateTask 把群链接抹掉）。
 *
 * notifier 没有该 messageId 的状态时（进程重启 / 卡片非本 notifier 发出），
 * fallback 到现构建（只有 1 条 "Task 创建" 里程碑）。
 */
function buildCardAfterGroupChange(
  event: CardActionEvent,
  ports: CardActionPorts,
  task: NonNullable<Awaited<ReturnType<NonNullable<CardActionPorts["getTask"]>>>>,
  perTaskChatId: string | undefined,
  perTaskChatName: string | undefined
): ReturnType<typeof buildTaskCard> {
  const meta = buildTaskMetaFromTask(task, perTaskChatId, perTaskChatName);

  const preserved = ports.notifier?.updateMetaAndBuildCard?.(
    event.messageId,
    meta,
    { clearPerTaskChat: !perTaskChatId }
  );
  if (preserved) {
    logger.debug(
      `buildCardAfterGroupChange: 复用 notifier 累积状态（里程碑历史保留）messageId=${event.messageId}`
    );
    return preserved;
  }

  logger.warn(
    `buildCardAfterGroupChange: notifier 无 messageId=${event.messageId} 的状态，` +
      `fallback 重建卡片（该卡片的历史里程碑可能丢失）`
  );
  return buildTaskCard({
    status: "running",
    meta,
    milestones: [
      { title: "Task 创建", timestamp: new Date().toISOString(), description: task.current_status },
    ],
  });
}

async function handleCreateGroup(
  event: CardActionEvent,
  ports: CardActionPorts,
  task: NonNullable<Awaited<ReturnType<NonNullable<CardActionPorts["getTask"]>>>>,
  existingChatId: string | undefined
): Promise<CardActionResult> {
  if (existingChatId) {
    // ★ Task #4339：这是**幂等命中**而不是错误（例如双击的第二下、或事件重投）。
    // 返回 ok=true，并把卡片 patch 成"已有群"的正确形态（按钮翻"解散"+群链接），
    // 避免用户看到一张与实际不一致的卡片。
    const existingName = extractPerTaskChatName(task.context);
    logger.info(
      `handleCreateGroup: Task #${task.id} 已有专属群 ${existingChatId}（幂等命中，不重复建群）`
    );
    // ★ Task #5369：老任务（建群时还没有 alias 能力）在这里补链，让升级后的
    //   存量群也能享受 alias 语义。best-effort，绝不影响幂等返回。
    await attachGroupSessionForTask(event, ports, task.id, existingChatId, task.context);
    return {
      ok: true,
      action: "create_group",
      newChatId: existingChatId,
      cardUpdate: buildCardAfterGroupChange(event, ports, task, existingChatId, existingName),
    };
  }
  if (!ports.createGroupChat) {
    return { ok: false, action: "create_group", error: "ports.createGroupChat not injected" };
  }

  try {
    const renderedName = truncateText(
      `Task #${task.id} - ${task.title ?? "(无标题)"}`,
      60
    );
    const description = truncateText(
      `roy-bot task #${task.id} - ${task.project_path ?? ""}`,
      100
    );
    // ★ Task #4337：建群时通过 --users 把操作者一并拉进去
    //   兼容 operatorId 是 string 或 {open_id: "ou_xxx"} 两种形式
    const operatorOpenId = extractOperatorOpenId(event.operatorId);
    const initialUserIds = operatorOpenId ? [operatorOpenId] : undefined;
    const chatId = await ports.createGroupChat({
      name: renderedName,
      description,
      profile: event.profile,
      initialUserIds,
    });

    // ★ Task #4337 fallback：如果 caller 不支持 initialUserIds，try inviteUser 端口
    //   实际推荐走 initialUserIds 路径（lark-cli im +chat-create --users 一次到位）
    //   本端口是给不能修改 createGroupChat 时使用
    let invitedOpenIds: string[] = [];
    if (operatorOpenId) {
      if (initialUserIds) {
        // 推荐路径：建群时已邀请。仅记录 invitees 不再调 inviteUser（避免重复）
        invitedOpenIds = [operatorOpenId];
        logger.debug(`handleCreateGroup: ${operatorOpenId} 已在建群时邀请（initialUserIds 路径）`);
      } else if (ports.inviteUser) {
        // Fallback 路径：后置邀请
        try {
          await ports.inviteUser(chatId, operatorOpenId, event.profile);
          invitedOpenIds = [operatorOpenId];
          logger.debug(`handleCreateGroup: 走 inviteUser 端口邀请 ${operatorOpenId} 进 ${chatId}`);
        } catch (err) {
          logger.warn(
            `handleCreateGroup: inviteUser(${chatId}, ${operatorOpenId}) 失败（不阻断主流程）: ${(err as Error).message}`
          );
        }
      } else {
        logger.warn(
          `handleCreateGroup: createGroupChat 不支持 initialUserIds 且 inviteUser 未注入，` +
            `${operatorOpenId} 未被拉进群 ${chatId}。` +
            `需升级 caller（bridge/real impl）使用 ports.inviteUser 或实现 createGroupChat.initialUserIds 参数。`
        );
      }
    }

    // 回写 task.context
    const newContext = patchContext(task.context ?? "{}", {
      [CTX_FIELD_CHAT_ID]: chatId,
      [CTX_FIELD_CHAT_NAME]: renderedName,
      [CTX_FIELD_CHAT_CREATED_AT]: new Date().toISOString(),
      [CTX_FIELD_CHAT_TASK_ID]: task.id,
      // ★ Task #4337：记录已邀请的人（数组）。解散时**保留**这个字段（飞书 API 不开放群解散，被邀请的人不会自动退群）。
      [CTX_FIELD_CHAT_INVITEES]: invitedOpenIds.length > 0 ? invitedOpenIds : undefined,
    });
    if (ports.updateTaskContext) {
      await ports.updateTaskContext(task.id, newContext);
    }

    // 渲染新卡片（按钮翻"解散" + 显示链接）
    // ★ Task #4339：优先复用 notifier 累积状态，避免丢掉里程碑历史
    const cardUpdate = buildCardAfterGroupChange(event, ports, task, chatId, renderedName);

    // ★ Task #5369：群建好之后立刻把「群 session」链到原 sub-session。
    //   位置在 return 之前、catch 之外 —— link 失败不会把成功建群翻成失败。
    await attachGroupSessionForTask(event, ports, task.id, chatId, task.context);

    return { ok: true, action: "create_group", newChatId: chatId, cardUpdate };
  } catch (err) {
    logger.error(`handleCardAction.create_group failed: ${(err as Error).message}`);
    return { ok: false, action: "create_group", error: (err as Error).message };
  }
}

/**
 * 兼容 operatorId 是 string 或 {open_id: "ou_xxx"} 两种形式。
 * 真实 lark-cli card.action.trigger 的 operator_id 字段是对象；
 * 但 caller 也可能简化成字符串。
 */
function extractOperatorOpenId(raw: string | { open_id: string } | undefined): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && typeof raw.open_id === "string") return raw.open_id;
  return undefined;
}

/** 宽松解析 taskId（"5360" / 5360 / " 5360 " 都接受；非法 → undefined） */
function parseTaskIdLoose(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/**
 * ★ 补充需求（22:31）—— 处理 **session-only** 卡片（无 task）的「刷新活性」。
 *
 * ## 与 `handleRefreshActivity` 的差异
 *
 * | | task 卡 | session 卡 |
 * |---|---|---|
 * | 前置校验 | 必须 `getTask()` 拿到 task | **不查 task**（本来就没有） |
 * | 活性来源 | `loadSubSessionActivity(taskId)`（task→bgTask→subSession） | `loadSessionActivity(sessionId)`（直达 store） |
 * | 渲染 | `buildTaskCard`（含任务详情/进度/建群按钮） | `buildSessionCard`（会话详情 + 只有刷新按钮） |
 * | 终态 | 有（completed/failed…） | 无（session 没有「完成」语义 ⇒ 恒非终态） |
 *
 * 相同的：都是**只读**（不 updateTask / 不改 context / 不改 updateCount），
 * 都用同一套 `formatActivityLines` 渲染活性 —— 口径不漂移。
 *
 * ## 降级链（每层都不抛）
 *
 * 1. 端口未注入 → 「暂无数据」面板照出（用户点了按钮必须有反馈）
 * 2. 端口抛错 → 同上 + warn
 * 3. notifier 无这张卡的状态（重启未 hydrate）→ 用最小 meta 重建 session 卡
 *    （session 卡没有 task 的 title/status 可丢，所以重建损失最小）
 */
async function handleRefreshSessionActivity(
  event: CardActionEvent,
  ports: CardActionPorts,
  subject: CardSubject,
): Promise<CardActionResult> {
  const action = "refresh_activity" as const;
  const sessionId = subject.sessionId;

  // ---- 0. ★ Task #5602：task 卡归属守卫（先于一切 session 渲染）----
  //
  // task 卡上的「💬 会话查看」按钮 value 同时带 taskId + sessionId
  // （#5581 透传 + CV BLOCKER-1），点击会走到本函数。但本函数的
  // 渲染目标是 **session 卡**：
  // - `buildSessionCardWithActivity` 只查 `sessionStates` ⇒ task 卡
  //   （在 `states` 里）查不到 → undefined；
  // - fallback `buildSessionCard` 整卡重建 ⇒ **task 卡被 session
  //   渲染器覆盖**（用户实测：任务卡点一下变会话卡）。
  //
  // 这张卡确实是 task 卡 ⇒ 委托回 task 主键路径
  // `handleRefreshActivity`（保持 task 卡身份 + 里程碑历史，
  // 活性面板同样渲染 —— 信息一个不少）。
  //
  // ⚠️ 判定必须排除 **session 卡**：#5364 单卡语义下
  //   task 卡 == session 卡（同一 messageId 同时在 `states` 与
  //   `sessionStates`，见 lark-card-activity-5360 测试的
  //   makeHydratedNotifier），那种卡走 session 渲染是正确语义。
  //   只有「是 task 卡但**不是** session 卡」（两卡并存，#5580）
  //   才需要委托 task 路径。
  if (
    subject.taskId !== undefined &&
    ports.notifier?.isTaskCardMessage?.(event.messageId) &&
    !ports.notifier?.isSessionCardMessage?.(event.messageId)
  ) {
    logger.info(
      `handleRefreshSessionActivity: messageId=${event.messageId} 是 task 卡 ` +
        `(task #${subject.taskId})，refresh_activity 委托 task 路径（保持卡身份）`,
    );
    const taskCard = await ports.getTask?.(subject.taskId);
    if (taskCard) {
      return await handleRefreshActivity(event, ports, taskCard, subject.taskId);
    }
    // task 已查不到（被删？）→ 不猜，继续走 session 路径
    // （此时该卡在 notifier 里也未必还有 task state，行为与旧版一致）
    logger.warn(
      `handleRefreshSessionActivity: task #${subject.taskId} 读取失败，` +
        `refresh_activity 回落 session 路径`,
    );
  }

  // ---- 0b. ★ Task #5608：持久层兜底（notifier 无内存状态时）----
  //
  // ## 为什么 0 还不够（用户 2026-11-15 真机复发）
  //
  // 插件 daemon（roy-task serve）的 card-action 链路里，
  // `ports.notifier` 是 daemon 自己 new 的**全新实例**
  // （packages/cli/src/daemon/task-card.ts `loadNotifier`）：
  // task 卡从未进它的 `states` / `finalisedCards` ⇒
  // `isTaskCardMessage` 恒 false ⇒ 守卫 0 永不触发 ⇒
  // fallback `buildSessionCard` 整卡重建（用户实测：任务卡点
  // 「💬 会话查看」变会话卡）。
  //
  // ## 兜底判据（跨进程权威）
  //
  // `lark_card` 持久层（`~/.local/share/roy-bot/lark-cards.db`）
  // 由 core hook 与插件 ledger 双方写入：按 taskId 查到记录、
  // 且记录的 messageId 与被点的卡一致 ⇒ 这张卡**就是** task 卡
  // （open / closed 都算 —— closed 卡仍钉在会话里，用户照样会点）。
  //
  // ⚠️ 不需要再排除 session 卡：`lark_card` 只记 task 卡
  // （session 卡在独立的 `lark_session_card` 表），messageId
  // 匹配即无歧义。内存判定（守卫 0）仍在前 —— 内存比持久层新鲜。
  if (
    subject.taskId !== undefined &&
    !ports.notifier?.isSessionCardMessage?.(event.messageId) &&
    !ports.notifier?.isTaskCardMessage?.(event.messageId)
  ) {
    let persisted: { messageId?: string } | undefined;
    try {
      persisted = getSharedLarkCardStateStore().get(subject.taskId);
    } catch (err) {
      logger.warn(
        `handleRefreshSessionActivity: 持久层读取失败 ` +
          `(task #${subject.taskId})，跳过兜底: ${(err as Error).message}`,
      );
      persisted = undefined;
    }
    if (persisted?.messageId && persisted.messageId === event.messageId) {
      logger.info(
        `handleRefreshSessionActivity: notifier 无状态但持久层确认 ` +
          `messageId=${event.messageId} 是 task 卡（task #${subject.taskId}），` +
          `refresh_activity 委托 task 路径（保持卡身份）`,
      );
      const taskCard = await ports.getTask?.(subject.taskId);
      if (taskCard) {
        return await handleRefreshActivity(event, ports, taskCard, subject.taskId);
      }
      logger.warn(
        `handleRefreshSessionActivity: task #${subject.taskId} 读取失败，` +
          `refresh_activity 回落 session 路径`,
      );
    }
  }

  // ---- 1. 读 session 活性（主键路径，永远执行）----
  let probe: ActivityProbeResult | undefined;
  try {
    probe = await ports.loadSessionActivity?.(sessionId);
  } catch (err) {
    logger.warn(
      `handleRefreshSessionActivity: loadSessionActivity failed for ${sessionId}: ` +
        `${(err as Error).message}（降级为「暂无数据」）`,
    );
    probe = undefined;
  }

  // ---- 2. 若有关联 task，把 task 信息一并同步进卡片（可选增强）----
  //
  // ★ 澄清（22:37）第 3 点：「如果把该 sub-session 创建了 task → 把 task 信息
  //   同步进卡片（taskId、title、状态、进度、操作记录等原有信息一个不少）」。
  //   注意这里**只读**（getTask），不 updateTask —— 刷新仍是只读操作。
  let taskEnrichment: TaskEnrichment | undefined;
  if (subject.taskId !== undefined) {
    taskEnrichment = await loadTaskEnrichment(subject.taskId, ports);
  }

  // ---- 2.5 最近消息（★ Task #5420「💬 会话查看」）----
  //
  // best-effort：端口未注入 / 抛错 → undefined（不渲染面板）；
  // ★ CV MINOR-5（#5420）已知取舍：抛错时 buildSessionCardWithActivity
  //   会沿用 state 里**上一次成功**的消息（可能过期）——这是
  //   「不擦面板」与「显示过期数据」的权衡，刻意选前者
  //   （用户至少能看到上次的内容，而不是面板凭空消失）。
  // [] → 面板照出 +「暂无消息」（诚实）。绝不阻断 patch。
  let recentMessages: ActivityMessage[] | ToolCallView[] | undefined;
  try {
    recentMessages = await ports.loadSessionMessages?.(
      sessionId,
      RECENT_MESSAGE_LIMIT,
    );
  } catch (err) {
    logger.warn(
      `handleRefreshSessionActivity: loadSessionMessages failed for ${sessionId}: ` +
        `${(err as Error).message}（降级为不渲染最近消息面板）`,
    );
    recentMessages = undefined;
  }

  // ★ Task #5580：刷新时也要带回「🗂️ 任务列表」—— 否则用户点一次刷新
  //   任务列表面板就被擦掉（与 #5420 的 recentMessages 同一类回归）。
  const sessionTaskList = await loadSessionTasksSafe(sessionId, ports);
  const sessionTasks = sessionTaskList.tasks;

  const snapshot = probe?.activity ?? null;
  // ★ 终态来自 session 层生命周期（跑这个 session 的后台任务状态），
  //   不是 task 状态 —— 没 task 的 session 一样会超时/完成。
  // ⚠️ 优先级坑：`a ?? b ? c : d` 解析成 `(a ?? b) ? c : d`，
  //   会把 truthy 的 lifecycle 字符串当成条件 → 恒返回 "completed"。
  //   必须用括号显式表达「先取 task 生命周期，没有再看 probe.terminal」。
  // ★ 优先级（澄清 22:37）：**session 层的 terminal 最权威** ——
  //   它来自「跑这个 session 的后台任务是否已结束」，是会话事实；
  //   task.status 只是**代理信号**（session 建了 task 时才有，且可能
  //   比 session 本身更滞后/更超前）。所以先看 probe.terminal。
  // ★ CV BLOCKER-3：优先用 probe 给出的**具体**生命周期（timeout/failed/stopped
  //   都能区分），只有它缺省时才用 terminal 推导，最后才退到 task 代理信号。
  // ★ CV MAJOR-4 修复：**session 事实 > task 代理信号**。
  //
  // 反例（CV 指出，确实成立）：session 还在写消息（🟢），但 task 已被用户
  // completed/paused ⇒ 若信 task.status，卡片会显示「已停止」，并把活性
  // 判成终态、藏起「正在跑」的事实。
  //
  // 顺序：probe 具体 lifecycle → probe.terminal → session 看起来还活着就
  // 是 running（**拒绝** task 的终态作为"会话已结束"的证据）→ 最后才退回 task。
  const sessionAlive = probe?.activity !== undefined && !probe?.terminal;
  const lifecycle: SessionLifecycle = probe?.lifecycle
    ? probe.lifecycle
    : probe?.terminal
      ? "completed"
      : sessionAlive
        ? "running"
        : (taskEnrichment?.lifecycle ?? "running");

  const preserved = ports.notifier?.buildSessionCardWithActivity?.(
    event.messageId,
    sessionId,
    snapshot,
    {
      lifecycle,
      task: taskEnrichment?.info,
      // ★ Task #5420：最近 5 条消息（端口未注入/抛错 → undefined 不渲染）
      ...(recentMessages !== undefined ? { recentMessages } : {}),
      // ★ Task #5580：任务列表（读不到 → [] 不渲染面板，不擦旧数据）
      sessionTasks,
    },
  );

  if (preserved) {
    logger.debug(
      `handleRefreshSessionActivity: ${sessionId} 活性已刷新 ` +
        `(messageCount=${snapshot?.messageCount ?? "n/a"}, task=${subject.taskId ?? "none"})`,
    );
    return { ok: true, action, cardUpdate: preserved };
  }

  logger.warn(
    `handleRefreshSessionActivity: notifier 无 messageId=${event.messageId} 的状态，` +
      `fallback 重建 session 卡`,
  );
  // ★ Task #5397：fallback 重建也要带上「本会话已有的群」，否则重启后点一次
  //   刷新，卡上的「解散该群」+ 群链接会变回「为本会话建群」（信息丢失）。
  //
  // ⚠️ CV 5397 第二轮：**有 task 时不查 alias**（双真相源，与
  //   `pickGroupChatIdForSessionCard` 同一条裁决）。task 存在时群的真源是
  //   `task.context.larkPerTaskChatId`（刷新路径不读它，但绝不能拿 alias
  //   反查的结果去覆盖）；此时宁可不渲染群链接，也不显示可能错的群。
  const groupChat = taskEnrichment?.info
    ? undefined
    : await lookupSessionGroup(ports, sessionId);
  return {
    ok: true,
    action,
    cardUpdate: buildSessionCard({
      sessionId,
      activity: snapshot,
      lifecycle,
      ...(sessionTasks.length > 0 ? { tasks: sessionTasks } : {}),
      ...(sessionTaskList.total !== undefined ? { taskTotal: sessionTaskList.total } : {}),
      ...(taskEnrichment?.info ? { task: taskEnrichment.info } : {}),
      ...(groupChat?.chatId ? { perTaskChatId: groupChat.chatId } : {}),
      // ★ Task #5420：fallback 重建同样带最近消息（信息不丢）
      ...(recentMessages !== undefined ? { recentMessages } : {}),
      // ★ Task #5580：fallback 重建同样带任务列表（信息不丢）
      ...(sessionTasks.length > 0 ? { tasks: sessionTasks } : {}),
    }),
  };
}

/** task 增强信息的渲染载荷（与 buildSessionCard 的 `task` 入参同形） */
type TaskEnrichmentInfo = NonNullable<
  NonNullable<Parameters<typeof buildSessionCard>[0]["task"]>
>;

// ============================================================================
// ★ Task #5580 —— select_task：点任务列表里的某个任务，切换执行动态 + 里程碑区
// ============================================================================

/**
 * 把端口返回的任务条目 / Task 实体统一成渲染层的 `SessionCardTaskSummary`。
 *
 * 端口实现可能直接返回 core `Task`（字段是 snake_case：`current_status`），
 * 也可能返回已归一化的 camelCase 形状 —— 两种都吃。
 */
function toTaskSummary(raw: unknown): SessionCardTaskSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as {
    id?: unknown;
    title?: unknown;
    status?: unknown;
    progress?: unknown;
    current_status?: unknown;
    currentStatus?: unknown;
    priority?: unknown;
    parent_task_id?: unknown;
    parentTaskId?: unknown;
    goals?: unknown;
    goals_and_expected_deliverables?: unknown;
    createdAt?: unknown;
    created_at?: unknown;
    updatedAt?: unknown;
    updated_at?: unknown;
  };
  const id =
    typeof r.id === "number"
      ? r.id
      : typeof r.id === "string"
        ? parseInt(r.id, 10)
        : Number.NaN;
  if (!Number.isFinite(id) || id <= 0) return undefined;
  const currentStatus =
    typeof r.currentStatus === "string"
      ? r.currentStatus
      : typeof r.current_status === "string"
        ? r.current_status
        : undefined;
  const goals =
    typeof r.goals === "string"
      ? r.goals
      : typeof r.goals_and_expected_deliverables === "string"
        ? r.goals_and_expected_deliverables
        : undefined;
  const parentTaskId =
    typeof r.parentTaskId === "number"
      ? r.parentTaskId
      : typeof r.parent_task_id === "number" && r.parent_task_id > 0
        ? r.parent_task_id
        : undefined;
  const createdAt =
    typeof r.createdAt === "string"
      ? r.createdAt
      : typeof r.created_at === "string"
        ? r.created_at
        : undefined;
  const updatedAt =
    typeof r.updatedAt === "string"
      ? r.updatedAt
      : typeof r.updated_at === "string"
        ? r.updated_at
        : undefined;
  return {
    id,
    ...(typeof r.title === "string" && r.title ? { title: r.title } : {}),
    ...(typeof r.status === "string" && r.status ? { status: r.status } : {}),
    ...(typeof r.progress === "number" ? { progress: r.progress } : {}),
    ...(currentStatus ? { currentStatus } : {}),
    ...(typeof r.priority === "string" && r.priority ? { priority: r.priority } : {}),
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    ...(goals ? { goals } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * 读该 session 的 task 列表（best-effort：任何失败 → 空数组）。
 *
 * 用户需求（2026-11-13）：一个 session 复用多次 → 卡片要给出「这个会话干过
 * 哪些任务」的索引。失败绝不阻断卡片的其它部分。
 */
async function loadSessionTasksSafe(
  sessionId: string,
  ports: CardActionPorts,
): Promise<{ tasks: SessionCardTaskSummary[]; total?: number }> {
  try {
    const raw = await ports.loadSessionTasks?.(sessionId);
    // 两种形态都接受：[...] 与 { tasks, total }
    const list = Array.isArray(raw) ? raw : raw?.tasks;
    if (!Array.isArray(list)) return { tasks: [] };
    const tasks = list
      .map((t) => toTaskSummary(t))
      .filter((t): t is SessionCardTaskSummary => t !== undefined);
    const total =
      !Array.isArray(raw) && typeof raw?.total === "number" ? raw.total : undefined;
    return { tasks, ...(total !== undefined ? { total } : {}) };
  } catch (err) {
    logger.warn(
      `loadSessionTasksSafe: ${sessionId} 读取失败（任务列表面板降级为空）: ` +
        `${(err as Error).message}`,
    );
    return { tasks: [] };
  }
}

/**
 * ★ Task #5580 —— 点「任务列表」里的某个任务 → 切换卡片的执行动态与里程碑区。
 *
 * ## 语义
 *
 * - 这是**只读**操作（不 updateTask、不改 task.context）—— 只是换一个视角看
 *   同一张卡。
 * - 卡片结构保持不变：任务列表仍在（用户可继续切换），执行动态/里程碑区
 *   换成选中任务的内容。
 * - 任何数据端口失败都降级（不整卡失败）：列表读不到 → 只剩选中任务；
 *   选中任务读不到 → 只剩列表 + 诚实提示。
 *
 * ## 与 refresh_activity 的关系
 *
 * 两者都 patch 同一张 session 卡、都走 notifier 的 session 渲染器；
 * 区别只在「渲染焦点」：refresh 刷新**会话活性**，select 切换**任务视角**。
 */
async function handleSelectTask(
  event: CardActionEvent,
  ports: CardActionPorts,
  subject: { sessionId: string; taskId: number },
): Promise<CardActionResult> {
  const action = "select_task" as const;
  const { sessionId, taskId } = subject;

  // ---- 1. 任务列表（导航用，尽量给全）----
  const taskListResult = await loadSessionTasksSafe(sessionId, ports);
  const tasks = taskListResult.tasks;

  // ---- 1.5 ★ CV P5（#5580）：membership 校验 ----
  //
  // 卡片按钮可能被**陈旧卡片**或**跨会话重放**触发：那时 taskId 不一定还属于
  // 本 session（任务被删除 / 改绑 / 用户在别的 session 复用同一张卡）。
  // 不做校验就会让 session 卡展示一个**不属于本会话**的任务详情与里程碑。
  //
  // 裁决：列表可用（非空）且不含该 taskId ⇒ 拒绝切换，保持卡面不变（诚实降级）。
  // 列表读不到（端口缺失 / 抛错 → []）时**不拦**：那只是数据源不可用，
  // 拦下来会让正常点击全失效（与其它端口的 best-effort 语义一致）。
  if (tasks.length > 0 && !tasks.some((t) => t.id === taskId)) {
    logger.warn(
      `handleSelectTask: task #${taskId} 不属于 ${sessionId}（列表 ${tasks.length} 个）→ 忽略本次切换`,
    );
    return {
      ok: false,
      action,
      error: `task #${taskId} is not a member of session ${sessionId}`,
    };
  }

  // ---- 2. 选中任务的详情（getTask，可能没有）----
  let selectedTask: SessionCardTaskSummary | undefined;
  try {
    const raw = await ports.getTask?.(taskId);
    selectedTask = toTaskSummary(raw);
  } catch (err) {
    logger.warn(
      `handleSelectTask: getTask(${taskId}) 失败（降级为不渲染任务详情）: ` +
        `${(err as Error).message}`,
    );
    selectedTask = undefined;
  }
  // getTask 没给（端口缺失/任务不存在）但列表里有它 → 用列表条目兜底
  if (!selectedTask) {
    selectedTask = tasks.find((t) => t.id === taskId);
  }

  // ---- 3. 选中任务的里程碑（task_operation 的 milestone 形态）----
  let milestones: Milestone[] | undefined;
  try {
    const raw = await ports.loadTaskMilestones?.(taskId);
    milestones = Array.isArray(raw) ? raw : undefined;
  } catch (err) {
    logger.warn(
      `handleSelectTask: loadTaskMilestones(${taskId}) 失败（里程碑区降级为空）: ` +
        `${(err as Error).message}`,
    );
    milestones = undefined;
  }

  // ---- 4. 会话活性（保持卡片原有信息，不因为切任务就丢）----
  //
  // ⚠️ 三态语义（与 refresh 路径一致）：端口没注入/抛错时**不能**编造 null
  //   （null = 「查了确实没有」），否则会把卡片上已有的活性面板擦成「暂无数据」。
  //   所以缺数据时回落到 notifier state 里的上次快照；再没有才传 null。
  let probe:
    | Awaited<ReturnType<NonNullable<CardActionPorts["loadSessionActivity"]>>>
    | undefined;
  try {
    probe = await ports.loadSessionActivity?.(sessionId);
  } catch (err) {
    logger.warn(
      `handleSelectTask: loadSessionActivity(${sessionId}) 失败（沿用上次快照）: ` +
        `${(err as Error).message}`,
    );
    probe = undefined;
  }
  const stateActivity = ports.notifier?.getSessionCardState?.(sessionId)?.activity;
  const activitySnapshot = probe ? (probe.activity ?? null) : (stateActivity ?? null);

  // ---- 5. 优先让 notifier 用**它自己的 state** 渲染（保留 title/里程碑/群链接）----
  const patched = ports.notifier?.buildSessionCardWithActivity?.(
    event.messageId,
    sessionId,
    activitySnapshot,
    {
      ...(probe?.lifecycle ? { lifecycle: probe.lifecycle } : {}),
      sessionTasks: tasks,
      ...(taskListResult.total !== undefined
        ? { taskTotal: taskListResult.total }
        : {}),
      ...(selectedTask ? { selectedTask } : {}),
      ...(milestones !== undefined ? { selectedTaskMilestones: milestones } : {}),
    },
  );
  if (patched) {
    logger.debug(
      `handleSelectTask: ${sessionId} 切到 task #${taskId}（列表 ${tasks.length} 个任务）`,
    );
    return { ok: true, action, cardUpdate: patched };
  }

  // ---- 6. notifier 不认这张卡（重启未 hydrate）→ fallback 重建 ----
  logger.warn(
    `handleSelectTask: notifier 无 messageId=${event.messageId} 的状态，fallback 重建 session 卡`,
  );
  return {
    ok: true,
    action,
    cardUpdate: buildSessionCard({
      sessionId,
      tasks,
      ...(taskListResult.total !== undefined ? { taskTotal: taskListResult.total } : {}),
      ...(selectedTask ? { selectedTask } : {}),
      ...(milestones !== undefined ? { selectedTaskMilestones: milestones } : {}),
      ...(probe?.activity !== undefined ? { activity: probe.activity } : {}),
      ...(probe?.lifecycle ? { lifecycle: probe.lifecycle } : {}),
    }),
  };
}

interface TaskEnrichment {
  info: TaskEnrichmentInfo;
  /** session 层生命周期（由 task.status 映射；无 task 时 undefined） */
  lifecycle?: "running" | "completed" | "timeout" | "failed" | "stopped";
}

/**
 * ★ 澄清（22:37）：读关联 task 并转成卡片渲染载荷（**只读**）。
 *
 * 任何失败（端口缺失 / task 不存在 / 抛错）都返回 `undefined` ——
 * 卡片降级为「只有 session 活性」，绝不因为 task 读不到而整卡失败。
 */
async function loadTaskEnrichment(
  taskId: number,
  ports: CardActionPorts,
): Promise<TaskEnrichment | undefined> {
  try {
    const task = await ports.getTask?.(taskId);
    if (!task) return undefined;
    const raw = task as {
      id?: number;
      title?: string;
      status?: string;
      progress?: number;
      current_status?: string;
      /** ★ port 可附带操作记录（getTask 的扩展字段，见装配点） */
      milestones?: Array<{ title: string; timestamp: string; description?: string }>;
      /** ★ CV MAJOR-5：这些字段也要同步（用户要求「一个不少」） */
      priority?: string;
      goals_and_expected_deliverables?: string;
      goals?: string;
      parent_task_id?: number | null;
      created_at?: string;
      createdAt?: string;
      updated_at?: string;
      updatedAt?: string;
    };
    return {
      lifecycle: lifecycleOfTaskStatus(raw.status),
      info: {
        id: typeof raw.id === "number" ? raw.id : taskId,
        ...(raw.title ? { title: raw.title } : {}),
        ...(raw.status ? { status: raw.status } : {}),
        ...(typeof raw.progress === "number" ? { progress: raw.progress } : {}),
        ...(raw.current_status ? { currentStatus: raw.current_status } : {}),
        // ★ 澄清 22:37 第 3 点：「操作记录等原有信息一个不少」——
        //   装配点若提供了 milestones，就渲染成时间线。
        ...(Array.isArray(raw.milestones) && raw.milestones.length > 0
          ? { milestones: raw.milestones }
          : {}),
        // ★ CV MAJOR-5：补齐「一个不少」里剩下的字段
        ...(raw.priority ? { priority: raw.priority } : {}),
        ...(raw.goals_and_expected_deliverables || raw.goals
          ? { goals: raw.goals_and_expected_deliverables ?? raw.goals }
          : {}),
        ...(typeof raw.parent_task_id === "number" && raw.parent_task_id > 0
          ? { parentTaskId: raw.parent_task_id }
          : {}),
        ...(raw.created_at || raw.createdAt
          ? { createdAt: raw.created_at ?? raw.createdAt }
          : {}),
        ...(raw.updated_at || raw.updatedAt
          ? { updatedAt: raw.updated_at ?? raw.updatedAt }
          : {}),
      },
    };
  } catch (err) {
    logger.warn(
      `loadTaskEnrichment: task #${taskId} 读取失败（降级为无 task 信息）: ` +
        `${(err as Error).message}`,
    );
    return undefined;
  }
}

/**
 * task.status → **session 生命周期**映射。
 *
 * ⚠️ 这不是「task 状态」——它表示「跑这个 session 的执行是否已结束」。
 * 只映射到生命周期允许的 5 个值；未知状态保守当 `running`。
 */
export function lifecycleOfTaskStatus(
  status: string | undefined,
): "running" | "completed" | "timeout" | "failed" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "archived":
    case "paused":
      return "stopped";
    case "active":
    case "todo":
    case "to_validate":
      return "running";
    default:
      return undefined;
  }
}

/**
 * ★ Task #5360 — 处理「🔄 刷新活性」点击。
 *
 * ## 用户诉求
 *
 * > 「按下后展示该任务对应 subsession 的消息数 + 最近一条 msg（截断）
 * >   —— 用来判断有无 LLM 推进」
 *
 * ## 关键设计：**只 patch 卡片，不动任务状态**
 *
 * 刷新是**只读**操作。绝不能：
 * - 调 `updateTask`（会触发 `task:after.update` → 时间线多一条 + 卡片重发）
 * - 改 `task.context`（会触发 #4536 记录的"插件重入"坑）
 * - 改 updateCount（用户点 5 次 = 卡片说自己更新了 5 次，是假信息）
 *
 * 所以走 `notifier.buildCardWithActivity()` —— 纯读 state + 重新渲染，
 * 由 caller 用飞书 30min token patch 原卡。
 *
 * ## 降级链（每一层都不抛）
 *
 * 1. `loadSubSessionActivity` 未注入 → 渲染「暂无数据」（面板照出，按钮有反馈）
 * 2. 端口抛错 → 同上（log warn，不阻断 patch）
 * 3. notifier 无该 messageId 状态（重启后未 hydrate）→ fallback 重建卡片，
 *    与 `buildCardAfterGroupChange` 同一套降级语义
 */
async function handleRefreshActivity(
  event: CardActionEvent,
  ports: CardActionPorts,
  task: NonNullable<Awaited<ReturnType<NonNullable<CardActionPorts["getTask"]>>>>,
  taskId: number,
): Promise<CardActionResult> {
  const action = "refresh_activity" as const;

  // ---- 1. 取活性（best-effort，失败降级为"查了但没数据"）----
  let activity: Awaited<ReturnType<NonNullable<CardActionPorts["loadSubSessionActivity"]>>> | undefined;
  try {
    activity = await ports.loadSubSessionActivity?.(taskId);
  } catch (err) {
    logger.warn(
      `handleRefreshActivity: loadSubSessionActivity failed for task #${taskId}: ` +
        `${(err as Error).message}（降级为「暂无数据」）`
    );
    activity = undefined;
  }

  const snapshot = activity?.activity ?? null;
  const terminal = activity?.terminal ?? false;

  // ---- 2. 用 notifier 的累计状态重建卡片（保留里程碑/过程/进度）----
  const preserved = ports.notifier?.buildCardWithActivity?.(event.messageId, snapshot, {
    terminal,
  });

  if (preserved) {
    logger.debug(
      `handleRefreshActivity: task #${taskId} 活性已刷新 ` +
        `(messageCount=${snapshot?.messageCount ?? "n/a"}, terminal=${terminal})`
    );
    return { ok: true, action, cardUpdate: preserved };
  }

  // ---- 3. 降级：notifier 不认这张卡 → 用 task 重建（会丢历史，但有反馈）----
  logger.warn(
    `handleRefreshActivity: notifier 无 messageId=${event.messageId} 的状态，` +
      `fallback 重建卡片（历史里程碑可能丢失）`
  );
  // ★ CV MINOR-3：降级重建必须带上**真实**的 task meta 与状态，
  //   否则重启后点刷新会把「已完成」的任务显示成「进行中」并丢掉标题 ——
  //   那正是用户明令禁止的「旧信息丢失」。
  const meta = buildTaskMetaFromTask(task, extractPerTaskChatId(task.context), undefined);
  return {
    ok: true,
    action,
    cardUpdate: buildTaskCard({
      status: cardStatusOfTaskStatus((task as { status?: string }).status),
      meta,
      activity: snapshot,
      activityTerminal: terminal,
    }),
  };
}

/**
 * ★ Task #5360（CV MINOR-3）：task.status → CardStatus。
 *
 * 只做本文件需要的最小映射；不在映射表里的值保守当作 `running`
 * （宁可按"还在跑"显示，也不要凭空显示一个终态）。
 */
function cardStatusOfTaskStatus(status: string | undefined): CardStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "paused":
      return "stopped";
    case "archived":
      return "stopped";
    default:
      return "running";
  }
}

async function handleDisbandGroup(
  event: CardActionEvent,
  ports: CardActionPorts,
  task: NonNullable<Awaited<ReturnType<NonNullable<CardActionPorts["getTask"]>>>>,
  existingChatId: string | undefined
): Promise<CardActionResult> {
  if (!existingChatId) {
    return {
      ok: false,
      action: "disband_group",
      error: `Task #${task.id} 无专属群（context.larkPerTaskChatId 空），无需解散`,
    };
  }
  if (!ports.deleteGroupChat) {
    return { ok: false, action: "disband_group", error: "ports.deleteGroupChat not injected" };
  }

  try {
    await ports.deleteGroupChat(existingChatId, event.profile);

    // 清掉 task.context 里的群字段
    const newContext = patchContext(task.context ?? "{}", {
      [CTX_FIELD_CHAT_ID]: undefined,
      [CTX_FIELD_CHAT_NAME]: undefined,
      [CTX_FIELD_CHAT_CREATED_AT]: undefined,
      [CTX_FIELD_CHAT_TASK_ID]: undefined,
    });
    if (ports.updateTaskContext) {
      await ports.updateTaskContext(task.id, newContext);
    }

    // 渲染新卡片（按钮翻"建群" + 隐藏链接）
    // ★ Task #4339：优先复用 notifier 累积状态，避免丢掉里程碑历史
    const cardUpdate = buildCardAfterGroupChange(event, ports, task, undefined, undefined);

    return { ok: true, action: "disband_group", cardUpdate };
  } catch (err) {
    logger.error(`handleCardAction.disband_group failed: ${(err as Error).message}`);
    return { ok: false, action: "disband_group", error: (err as Error).message };
  }
}

function patchContext(
  contextStr: string,
  changes: Record<string, string | number | string[] | undefined>
): string {
  let obj: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(contextStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    obj = {};
  }
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) {
      delete obj[k];
    } else {
      obj[k] = v;
    }
  }
  return JSON.stringify(obj);
}

function buildTaskMetaFromTask(
  task: NonNullable<Awaited<ReturnType<NonNullable<CardActionPorts["getTask"]>>>>,
  perTaskChatId: string | undefined,
  perTaskChatName: string | undefined
): TaskMeta {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    goals: task.goals,
    parentTaskId:
      typeof task.parent_task_id === "number" && task.parent_task_id > 0
        ? task.parent_task_id
        : undefined,
    priority: task.priority,
    type: task.type,
    projectPath: task.project_path,
    // ★ Task #4339：传**原始** task.context（renderTaskInfoLines 会展开成可读 bullet）。
    // 旧实现用 JSON.stringify({larkPerTaskChatId, larkPerTaskChatName}) 覆盖，
    // 导致卡片上的"📜 背景"只剩群字段，task 真实 context 全丢。
    context: task.context,
    currentStatus: task.current_status,
    perTaskChatId,
    perTaskChatName,
    // ★ Task #5581：透传 task.session_id → meta.sessionId。
    //
    // 「💬 会话查看」按钮 sessionIdForButton 取自 opts.meta.sessionId；
    // 上一版这里不透传 ⇒ notifier 反查不可用的路径（典型：MCP 建卡，
    // 卡在另一进程发出）按钮 value 只有 taskId ⇒ 点击报
    // `Missing required field: sessionId`。task 带 session_id 就写，
    // 缺省不写该键（向后兼容，不猜）。
    ...(typeof (task as { session_id?: string | null }).session_id ===
      "string" && (task as { session_id?: string }).session_id
      ? { sessionId: (task as { session_id?: string }).session_id }
      : {}),
  };
}

/**
 * "解散"群聊（Task #4331 实测发现：飞书 Open API **不支持解散群聊**）
 *
 * 实测结论（2026-10-18 / 2026-10-19 复核）：
 * - 飞书开放平台 lark-cli skill 文档：chats 只有 `create / get / link / update`，**没有 dissolve / delete**
 * - 开放 API `DELETE /open-apis/im/v1/chats/:id` 也不存在
 * - ★ Task #4339 复核：**旧实现用的 `/chats/:id/members/me` 是 404 不存在的路径**
 *   （实测 `HTTP 404: 404 page not found`），所以历史上"bot 退群"从未真正执行过，
 *   只是被 `2>/dev/null` 吞掉 + `echo 完成` 伪装成成功。
 *
 * 真实可用的退群接口（已用无效 chat_id 探活确认路径存在，返回 99992356 而非 404）：
 *   DELETE /open-apis/im/v1/chats/:chat_id/members?member_id_type=app_id
 *   body: {"id_list": ["<bot 的 app_id>"]}
 *
 * 用户原意"解散该群" → 我们做的是**逻辑解散**：
 * 1. 调 deleteGroupChat 让 bot 退群（能退就退）
 * 2. 把 chat_id 从 task.context 移除（后续不再往这个群发卡片）
 * 3. 重新渲染卡片（按钮翻回"建群" + 隐藏链接）
 * 4. 飞书侧的群仍存在（用户后续可手动删除 / 保留作为历史）
 *
 * ⚠️ 已知限制：群是 bot 自己建的 → bot 可能是群主；飞书对"群主退群"有额外约束，
 *    这种情况下退群会失败。失败不阻断主流程（context 仍会清掉），但会打 warn。
 *
 * @returns 无（失败也 resolve，由日志体现）
 */
export async function deleteGroupChatViaLarkCli(
  chatId: string,
  profile?: string
): Promise<void> {
  const profileFlag = profile ? `--profile ${profile} ` : "";
  try {
    // 1) 取 bot 的 app_id —— 退群要用 app_id（不是 open_id）
    const { stdout: authStdout } = await execAsync(
      `lark-cli ${profileFlag}auth status --json`,
      { timeout: 15_000 }
    );
    const appId = (JSON.parse(authStdout) as { appId?: string }).appId;
    if (!appId) {
      throw new Error(`lark-cli auth status 未返回 appId: ${authStdout.slice(0, 200)}`);
    }

    // 2) 正确的退群接口
    const cmd =
      `lark-cli ${profileFlag}api DELETE /open-apis/im/v1/chats/${chatId}/members ` +
      `--params '{"member_id_type":"app_id"}' ` +
      `--data ${shellQuote(JSON.stringify({ id_list: [appId] }))} ` +
      `--as bot`;
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000 });
    logger.debug(
      `deleteGroupChatViaLarkCli(${chatId}) bot 退群 ok: ` +
        `stdout=${stdout?.slice(0, 300)} stderr=${stderr?.slice(0, 300)}`
    );
  } catch (err) {
    // bot 退群失败不阻断主流程（task.context 仍会清掉）
    logger.warn(
      `deleteGroupChatViaLarkCli(${chatId}) bot 退群失败（task.context 仍会清掉，` +
        `飞书侧群会保留）：${(err as Error).message}`
    );
  }
}


/**
 * "解散"群聊（Task #4331 实测发现：飞书 Open API **不支持解散群聊**）
 *
 * 实测结论（2026-10-18 / 2026-10-19 复核）：
 * - 飞书开放平台 lark-cli skill 文档：chats 只有 `create / get / link / update`，**没有 dissolve / delete**
 * - 开放 API `DELETE /open-apis/im/v1/chats/:id` 也不存在
 * - ★ Task #4339 复核：**旧实现用的 `/chats/:id/members/me` 是 404 不存在的路径**
 *   （实测 `HTTP 404: 404 page not found`），所以历史上"bot 退群"从未真正执行过，
 *   只是被 `2>/dev/null` 吞掉 + `echo 完成` 伪装成成功。
 *
 * 真实可用的退群接口（已用无效 chat_id 探活确认路径存在，返回 99992356 而非 404）：
 *   DELETE /open-apis/im/v1/chats/:chat_id/members?member_id_type=app_id
 *   body: {"id_list": ["<bot 的 app_id>"]}
 *
 * 用户原意"解散该群" → 我们做的是**逻辑解散**：
 * 1. 调 deleteGroupChat 让 bot 退群（能退就退）
 * 2. 把 chat_id 从 task.context 移除（后续不再往这个群发卡片）
 * 3. 重新渲染卡片（按钮翻回"建群" + 隐藏链接）
 * 4. 飞书侧的群仍存在（用户后续可手动删除 / 保留作为历史）
 *
 * ⚠️ 已知限制：群是 bot 自己建的 → bot 可能是群主；飞书对"群主退群"有额外约束，
 *    这种情况下退群会失败。失败不阻断主流程（context 仍会清掉），但会打 warn。
 *
 * @returns 无（失败也 resolve，由日志体现）
 */
export async function deleteGroupChatViaLarkCli(
  chatId: string,
  profile?: string
): Promise<void> {
  const profileFlag = profile ? `--profile ${profile} ` : "";
  try {
    // 1) 取 bot 的 app_id —— 退群要用 app_id（不是 open_id）
    const { stdout: authStdout } = await execAsync(
      `lark-cli ${profileFlag}auth status --json`,
      { timeout: 15_000 }
    );
    const appId = (JSON.parse(authStdout) as { appId?: string }).appId;
    if (!appId) {
      throw new Error(`lark-cli auth status 未返回 appId: ${authStdout.slice(0, 200)}`);
    }

    // 2) 正确的退群接口
    const cmd =
      `lark-cli ${profileFlag}api DELETE /open-apis/im/v1/chats/${chatId}/members ` +
      `--params '{"member_id_type":"app_id"}' ` +
      `--data ${shellQuote(JSON.stringify({ id_list: [appId] }))} ` +
      `--as bot`;
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000 });
    logger.debug(
      `deleteGroupChatViaLarkCli(${chatId}) bot 退群 ok: ` +
        `stdout=${stdout?.slice(0, 300)} stderr=${stderr?.slice(0, 300)}`
    );
  } catch (err) {
    // bot 退群失败不阻断主流程（task.context 仍会清掉）
    logger.warn(
      `deleteGroupChatViaLarkCli(${chatId}) bot 退群失败（task.context 仍会清掉，` +
        `飞书侧群会保留）：${(err as Error).message}`
    );
  }
}

/**
 * shell 安全引用（单引号包裹 + 内部单引号转义）

/**
 * "解散"群聊（Task #4331 实测发现：飞书 Open API **不支持解散群聊**）
 *
 * 实测结论（2026-10-18 / 2026-10-19 复核）：
 * - 飞书开放平台 lark-cli skill 文档：chats 只有 `create / get / link / update`，**没有 dissolve / delete**
 * - 开放 API `DELETE /open-apis/im/v1/chats/:id` 也不存在
 * - ★ Task #4339 复核：**旧实现用的 `/chats/:id/members/me` 是 404 不存在的路径**
 *   （实测 `HTTP 404: 404 page not found`），所以历史上"bot 退群"从未真正执行过，
 *   只是被 `2>/dev/null` 吞掉 + `echo 完成` 伪装成成功。
 *
 * 真实可用的退群接口（已用无效 chat_id 探活确认路径存在，返回 99992356 而非 404）：
 *   DELETE /open-apis/im/v1/chats/:chat_id/members?member_id_type=app_id
 *   body: {"id_list": ["<bot 的 app_id>"]}
 *
 * 用户原意"解散该群" → 我们做的是**逻辑解散**：
 * 1. 调 deleteGroupChat 让 bot 退群（能退就退）
 * 2. 把 chat_id 从 task.context 移除（后续不再往这个群发卡片）
 * 3. 重新渲染卡片（按钮翻回"建群" + 隐藏链接）
 * 4. 飞书侧的群仍存在（用户后续可手动删除 / 保留作为历史）
 *
 * ⚠️ 已知限制：群是 bot 自己建的 → bot 可能是群主；飞书对"群主退群"有额外约束，
 *    这种情况下退群会失败。失败不阻断主流程（context 仍会清掉），但会打 warn。
 *
 * @returns 无（失败也 resolve，由日志体现）
 */
export async function deleteGroupChatViaLarkCli(
  chatId: string,
  profile?: string
): Promise<void> {
  const profileFlag = profile ? `--profile ${profile} ` : "";
  try {
    // 1) 取 bot 的 app_id —— 退群要用 app_id（不是 open_id）
    const { stdout: authStdout } = await execAsync(
      `lark-cli ${profileFlag}auth status --json`,
      { timeout: 15_000 }
    );
    const appId = (JSON.parse(authStdout) as { appId?: string }).appId;
    if (!appId) {
      throw new Error(`lark-cli auth status 未返回 appId: ${authStdout.slice(0, 200)}`);
    }

    // 2) 正确的退群接口
    const cmd =
      `lark-cli ${profileFlag}api DELETE /open-apis/im/v1/chats/${chatId}/members ` +
      `--params '{"member_id_type":"app_id"}' ` +
      `--data ${shellQuote(JSON.stringify({ id_list: [appId] }))} ` +
      `--as bot`;
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000 });
    logger.debug(
      `deleteGroupChatViaLarkCli(${chatId}) bot 退群 ok: ` +
        `stdout=${stdout?.slice(0, 300)} stderr=${stderr?.slice(0, 300)}`
    );
  } catch (err) {
    // bot 退群失败不阻断主流程（task.context 仍会清掉）
    logger.warn(
      `deleteGroupChatViaLarkCli(${chatId}) bot 退群失败（task.context 仍会清掉，` +
        `飞书侧群会保留）：${(err as Error).message}`
    );
  }
}

/**
 * shell 安全引用（单引号包裹 + 内部单引号转义）
 *
 * ★ Task #4339：task 标题是任意用户文本，直接 `"${name}"` 插值会被
 *   引号 / `$` / 反引号 / `;` 破坏（命令截断甚至注入）。
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * ★ Task #5425：解析当前 profile 对应的 bot app_id（cli_xxx）。
 *
 * 用 `lark-cli <profile> auth status --json` 的 `appId` 字段
 * （与 deleteGroupChatViaLarkCli 同款解析）。建群时把它传给
 * `+chat-create --bots`，让创建者 bot 进群 —— 否则 bot 发卡
 * （#5417 新群 session 卡）会报 230002。
 *
 * @throws lark-cli 失败 / 输出无 appId 时抛错（caller best-effort）
 */
export async function resolveBotAppId(profile?: string): Promise<string> {
  const profileFlag = profile ? `--profile ${profile} ` : "";
  const { stdout } = await execAsync(
    `lark-cli ${profileFlag}auth status --json`,
    { timeout: 15_000 },
  );
  const appId = (JSON.parse(stdout) as { appId?: string }).appId;
  if (!appId) {
    throw new Error(`lark-cli auth status 未返回 appId: ${stdout.slice(0, 200)}`);
  }
  return appId;
}

/**
 * 截断到指定长度（含 "..."，语义与 PerTaskGroupChatPlugin.truncate 一致）
 *
 * ★ Task #4339：lark-cli `+chat-create` 的硬限制是
 *   `--name` ≤ 60 字符 / `--description` ≤ 100 字符，超了直接报错 →
 *   任务标题一长，"建群"按钮就彻底不可用。
 */
export function truncateText(text: string, maxLen: number): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.substring(0, Math.max(0, maxLen - 3)) + "...";
}

/**
 * 调 lark-cli im +chat-create 建群（供 ports.createGroupChat 使用）
 *
 * 返回新建的 chatId。
 */
export async function createGroupChatViaLarkCli(opts: {
  name: string;
  description: string;
  profile?: string;
  /** ★ Task #4339：建群时一并拉人（lark-cli `+chat-create --users "ou_a,ou_b"`） */
  initialUserIds?: string[];
  /**
   * ★ Task #5425：建群时一并拉 bot（lark-cli `+chat-create --bots "cli_xxx"`）。
   *
   * 背景：`--as bot` 创建群时**创建者 bot 默认不在群里**（飞书行为），
   * 后续 `+messages-send`（发 session 卡）会报
   * 230002「Bot/User can NOT be out of the chat」→ 新群永远没卡。
   * 传本群要用的 bot app_id（cli_xxx）即可在建群时拉 bot 入群。
   */
  initialBotIds?: string[];
}): Promise<string> {
  const profileFlag = opts.profile ? `--profile ${opts.profile} ` : "";
  // ★ Task #4337 Bug A：去掉 `--output json`（lark-cli 1.0.96 不支持该 flag）
  //   默认输出就是 JSON，stdout 直接含 {"chat_id":"oc_xxx"}
  // ★ Task #4339：改用 shellQuote 单引号引用（旧的双引号插值可被标题里的
  //   引号 / $ / 反引号破坏）
  const usersFlag =
    opts.initialUserIds && opts.initialUserIds.length > 0
      ? `--users ${shellQuote(opts.initialUserIds.join(","))} `
      : "";
  // ★ Task #5425：--bots 拉 bot 入群（否则 bot 发卡 230002）
  const botsFlag =
    opts.initialBotIds && opts.initialBotIds.length > 0
      ? `--bots ${shellQuote(opts.initialBotIds.join(","))} `
      : "";
  // ★ Task #4339：lark-cli +chat-create 硬限制 name ≤ 60 / description ≤ 100
  const cmd =
    `lark-cli ${profileFlag}im +chat-create --name ${shellQuote(truncateText(opts.name, 60))} ` +
    usersFlag +
    botsFlag +
    `--description ${shellQuote(truncateText(opts.description, 100))} --as bot`;
  const { stdout } = await execAsync(cmd, { timeout: 60_000 });
  // 解析 {"chat_id":"oc_xxx"} 或类似格式
  const m = stdout.match(/"chat_id"\s*:\s*"(oc_[a-f0-9]+)"/);
  if (!m) {
    throw new Error(`lark-cli +chat-create 返回无法解析: ${stdout.slice(0, 300)}`);
  }
  return m[1];
}

/** 重新导出 DEFAULT_APP_LINK_BASE 方便测试用 */
export { DEFAULT_APP_LINK_BASE };
