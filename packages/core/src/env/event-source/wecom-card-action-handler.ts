/**
 * @fileoverview Task #5203 — 企微卡片按钮点击处理
 *
 * ## 触发链路
 *
 * 用户点 button_interaction 卡片按钮
 * → 企微推 `template_card_event`（aibot_event_callback，5 秒窗口）
 * → WecomCliInstance.handleWsFrame 分流（不走 Agent）
 * → 本模块 handleWecomCardAction：
 *   1. 解析 event_key / task_id（反解出 roy 任务号）
 *   2. 触发对应 task 操作（mark_done → taskComponent.updateTask(status=completed)）
 *   3. 经 aibot_respond_update_msg（透传回调 req_id）更新卡片按钮态
 *
 * ## 设计原则（对齐 lark-card-action-handler.ts）
 *
 * - 纯函数 + IO 端口注入（markTaskDone / reopenTask / updateCard）
 * - 失败明确返回 ok=false，不静默成功
 * - 并发去重：同 (cardTaskId, action) 处理中 → 后到的拒绝
 *   （用户双击会产生两条独立回调）
 *
 * ## task_id 反解
 *
 * 发卡时 task_id 形如 `roy-task-<taskId>-<seq>-<rand>`（wecom-card-builder）；
 * 回调原样带回 → 用前缀 `roy-task-` 反解出数字任务号。
 * 非 roy-task 前缀（外部卡片）→ taskId=null，动作不执行。
 */

import { createLogger } from "../log-trace/logger";
import {
  WecomCardActionKey,
  ROY_SESSION_PREFIX,
  WECOM_SESSION_TASK_SEP,
  buildWecomCardUpdateFrame,
  buildWecomSessionUpdateFrame,
  type WecomActivityLike,
  type WecomSessionUpdateLifecycle,
  type WecomMilestoneLite,
} from "./wecom-card-builder";
// ★ Task #5364：session 卡持久层（刷新时重建整张卡的唯一数据来源）
import type { WecomSessionCardState } from "../task/plugins/wecom-session-card-store";
// ★ Task #5360：活性快照类型（probe 结果由装配点提供；与飞书侧同源）
import type { ActivityProbeResult } from "../task/plugins/sub-session-activity";

const logger = createLogger("wecom:card-action");

/**
 * 卡片动作类型
 *
 * ★ Task #5360：新增 `refresh_activity`（刷新 sub-session 活性）。
 *
 * 与 `view`（刷操作时间线）分开，因为企微 `horizontal_content_list` 只有
 * 6 条预算且已被时间线占满 —— 见 wecom-card-builder 的
 * `WecomCardActionKey.REFRESH_ACTIVITY` 注释。
 *
 * ★ Task #5419：新增 `create_lark_group`（建关联飞书群，对齐飞书）。
 */
export type WecomCardAction =
  | "view"
  | "mark_done"
  | "reopen"
  | "refresh_activity"
  | "create_lark_group";

/** 解析出的卡片动作事件 */
export interface WecomCardActionEvent {
  /** 用户点的按钮 key（WecomCardActionKey 之一或外部自定义） */
  eventKey: string;
  /** 回调带回的原始 task_id（原样回填更新帧） */
  cardTaskId: string;
  /** 反解出的任务号；非 roy-task 前缀 → null */
  taskId: number | null;
  /**
   * ★ 补充需求（22:31）：反解出的 sub-session id（`roy-session-` 前缀）。
   * 与 `taskId` 互斥：一张卡要么挂 task，要么挂 session。
   */
  sessionId: string | null;
  /** 操作者 userid */
  userId: string;
  /** 回调帧 req_id（更新帧必须原样透传） */
  reqId: string;
}

/** IO 端口（caller 注入；本模块保持纯函数） */
export interface WecomCardActionPorts {
  /** 标记任务完成（status=completed） */
  markTaskDone: (taskId: number) => Promise<void>;
  /** 重新打开任务（status=active） */
  reopenTask: (taskId: number) => Promise<void>;
  /**
   * 更新卡片（aibot_respond_update_msg，5 秒窗口内）
   * @param cardTaskId 回调带回的原始 task_id
   * @param timeline view 动作时携带的操作时间线（可选）
   * @param action ★ Task #5250：触发动作（决定更新后的按钮：
   *   view/reopen → 可点击「刷新详情」；mark_done → 「已处理」）
   */
  updateCard: (
    reqId: string,
    cardTaskId: string,
    statusLabel: string,
    note?: string,
    timeline?: WecomMilestoneLite[],
    action?: WecomCardAction,
    /**
     * ★ Task #5273：任务号+标题（可选，渲染进更新卡 main_title）
     * ★ Task #5360：`activity` —— sub-session 活性
     *   （`undefined` = 不渲染；`null` = 查了但没数据，渲染「暂无数据」）
     */
    extra?: {
      taskNumber?: number;
      taskTitle?: string;
      activity?: WecomActivityLike | null;
      /** ★ Task #5360（CV MAJOR-2）：任务是否已终态（决定 ⚪已结束 vs 🔴疑似停滞） */
      activityTerminal?: boolean;
    },
  ) => Promise<void>;
  /**
   * ★ Task #5364（B 方案）：用**完整快照**刷新 session 卡。
   *
   * 与 `updateCard` 的区别：那个是 task 卡的通用更新（statusLabel/timeline/
   * activity 三个松散参数）；本端口接收一次完整的 session 快照，由实现方
   * 调 `buildWecomSessionCardUpdateBody` 渲染「生命周期 + 会话详情 + 任务 +
   * 操作记录 + 活性」一整套。
   *
   * 未注入 ⇒ 自动降级到 `updateCard`（#5360 行为，仅活性）。
   */
  updateSessionCard?: (
    reqId: string,
    input: {
      sessionId: string;
      /** 回调带回的原始 task_id（刷新帧必须原样回填） */
      cardTaskId: string;
      /** 持久层快照；undefined = 无记录（降级仅活性） */
      state?: WecomSessionCardState;
      /** 实时活性；null = 查了但没数据 */
      activity: WecomActivityLike | null;
      /**
       * ★ Task #5419：session 关联的任务信息（刷新增强）。
       * undefined = 无任务 / 端口未注入。
       */
      task?: {
        id: number;
        title?: string;
        status?: string;
        progress?: number;
        milestones?: WecomMilestoneLite[];
      };
      /**
       * ★ Task #5419：已关联飞书群 chatId（建群后刷新帧带群链接）。
       */
      perTaskChatId?: string;
      /**
       * ★ CV 5419 MAJOR-3：建群失败提示（渲染进 sub_title）。
       */
      errorHint?: string;
      now?: number;
    },
  ) => Promise<void>;
  /**
   * ★ Task #5203：读任务的操作时间线（milestones + processSteps）。
   *
   * view 动作用它把完整操作记录刷进卡片正文。
   * 无记录 / 读取失败 → 返回 []（降级为简单按钮态更新）。
   */
  loadTimeline?: (taskId: number) => WecomMilestoneLite[];
  /**
   * ★ Task #5273：读任务号+标题（渲染进更新卡 main_title，
   * 修复「卡片缺 Task #ID 和 title」）。
   *
   * ★ CV-B1（Task #5273 返工）：生产实现（wecom-cli-handler）
   *   从 taskComponent 读任务，返回 **Promise** —— 端口签名必须
   *   允许 Promise，消费端 doHandle 必须 await。
   * 返回 undefined / reject / 抛错 → 降级为无标题（卡片更新不阻断）。
   */
  loadTaskTitle?: (
    taskId: number,
  ) =>
    | { title?: string; number?: number }
    | undefined
    | Promise<{ title?: string; number?: number } | undefined>;
  /**
   * ★ Task #5360：读 sub-session 活性（「刷新活性」动作用）。
   *
   * 与飞书侧 `CardActionPorts.loadSubSessionActivity` **同一个 probe 实现**
   * （`createActivityProbe`），避免两渠道 liveness 阈值漂移。
   *
   * 不注入 / 抛错 / undefined ⇒ 卡片渲染「暂无数据」，绝不阻断更新。
   */
  loadSubSessionActivity?: (
    taskId: number,
  ) => Promise<ActivityProbeResult> | ActivityProbeResult;
  /**
   * ★ 补充需求（22:31）：**session-only** 活性读取（无 task 场景）。
   *
   * 与 `loadSubSessionActivity(taskId)` 的区别：后者要从 task 反查 bgTask；
   * 本端口**直达** session store —— 因为回调里直接带着 sessionId，
   * 而这条链上根本没有 task。
   */
  loadSessionActivity?: (
    sessionId: string,
  ) => Promise<ActivityProbeResult> | ActivityProbeResult;
  /**
   * ★ Task #5364（B 方案）：读 **session 卡持久层**快照。
   *
   * ## 为什么刷新必须走它（而不是内存 / task）
   *
   * B 方案下「后续 lifecycle 不主动 patch，只写持久层」，所以**刷新是唯一
   * 能看到最新状态的时机**。快照里带着：
   * - `lifecycle`（超时 / 完成 / 失败 / 停止 —— 单靠活性推不出来）
   * - `title` / `agentType` / `startedAt` / `associatedTaskId`（首次发卡的信息）
   * - `milestones`（这一路的状态轨迹）
   * - `cardTaskId`（刷新帧必须原样回填，否则协议拒绝）
   *
   * 读内存 map 的话进程重启就全丢；读 task 的话没有 task 的 session 全丢。
   *
   * 不注入 / 抛错 / undefined ⇒ 降级为「只有活性」的刷新卡（**仍更新卡片**，
   * 用户点了按钮必须有反馈）。
   */
  loadSessionCardState?: (
    sessionId: string,
  ) => WecomSessionCardState | undefined | Promise<WecomSessionCardState | undefined>;
  /**
   * ★ Task #5418：按 roy 任务号反查 session 卡持久层记录。
   *
   * task 卡刷新路径回退 session probe 时需要 sessionId ——
   * `roy-task-` 前缀卡回调里没有 sessionId，唯一持久化来源是
   * `wecom_session_card.associated_task_id`。注入方（wecom-cli-handler）
   * 用 `store.list()` 扫描；缺省 ⇒ 不回退（行为同旧版）。
   */
  findSessionCardByTaskId?: (
    taskId: number,
  ) =>
    | WecomSessionCardState
    | undefined
    | Promise<WecomSessionCardState | undefined>;
  /**
   * ★ Task #5419：session → task 反查 + 全量任务信息（刷新增强）。
   *
   * 用户 2026-11-13：「有刷新详情按钮可以刷新 subsession 状态
   * （包括是否建任务，以及任务名称和动态，也包括 subsession 的
   * 消息数）」。
   *
   * 生产接线（wecom-cli-handler）：`TaskComponent.getTaskIdBySessionId`
   * （task_operation.session_id 反查）+ `getTaskWithOperations`。
   *
   * 返回 undefined = 该 session 没建任务（卡上不渲染任务行）；
   * 抛错 = 降级（不阻断刷新）。
   */
  loadSessionTaskInfo?: (
    sessionId: string,
  ) =>
    | Promise<
        | {
            id: number;
            title?: string;
            status?: string;
            progress?: number;
            milestones?: WecomMilestoneLite[];
          }
        | undefined
      >
    | {
        id: number;
        title?: string;
        status?: string;
        progress?: number;
        milestones?: WecomMilestoneLite[];
      }
    | undefined;
  /**
   * ★ Task #5419：建**关联飞书群**（对齐飞书 handleGroupActionSessionOnly）。
   *
   * 生产接线（wecom-cli-handler）：lark-cli +chat-create +
   * SessionComponent.attachGroupSession（独立群 session + 1 条
   * user 背景事件 + metadata linkedFromSessionId）。
   *
   * 返回新群 chatId；抛错 = 建群失败（结果翻失败，但卡片仍更新）。
   */
  createLarkGroupForSession?: (sessionId: string) => Promise<string>;
  /**
   * ★ Task #5419：读该 session 已关联的飞书群（幂等防重复建群）。
   *
   * 生产接线：`SessionComponent.findGroupChatForSession`
   * （扫 metadata linkedFromSessionId，与飞书侧同源）。
   * 未注入 / 抛错 ⇒ 当作没有群（可能重复建，但不崩）。
   */
  findGroupChatForSession?: (
    sessionId: string,
  ) =>
    | Promise<{ chatId: string } | undefined>
    | { chatId: string } | undefined;
  /**
   * ★ Task #5419：建群成功后发一条企微消息带飞书群 applink。
   *
   * 用户：「建完可以展示或者发一条企微消息带上飞书群跳转链接哈」。
   * best-effort：抛错不阻断建群结果。
   */
  notifyGroupLink?: (input: {
    sessionId: string;
    chatId: string;
    /** 群名（可选，消息文案用） */
    chatName?: string;
    /**
     * ★ CV 5419 BLOCKER-1：点击按钮的**企微用户** userid。
     *
     * 通知消息必须发给企微侧（不是飞书群 —— chatId 是
     * 飞书群 id，企微 CLI 不认）。缺省时实现方从 session
     * store 的 chatId 兜底。
     */
    userId?: string;
  }) => Promise<void>;
}

/** 处理结果 */
export interface WecomCardActionResult {
  ok: boolean;
  /** 执行的动作（解析失败时缺省） */
  action?: WecomCardAction;
  error?: string;
  /**
   * ★ Task #5419：create_lark_group 成功时的新群 chatId
   * （幂等命中时 = 已有群 chatId）。
   */
  newChatId?: string;
}

// ============================================================================
// 并发去重（对齐 lark-card-action-handler 的 cardActionInflight）
// ============================================================================

const cardActionInflight = new Map<string, Promise<WecomCardActionResult>>();

/** 测试钩子：清空 in-flight 去重表（仅供单测 beforeEach 使用） */
export function __resetWecomCardActionInflightForTest(): void {
  cardActionInflight.clear();
}

// ============================================================================
// 回调帧解析
// ============================================================================

/** roy-task-<n> 前缀（wecom-card-builder.wecomCardTaskIdForTask） */
const ROY_TASK_PREFIX = "roy-task-";
// ★ 补充需求（22:31）：session 卡前缀（与 roy-task- 互斥）


/**
 * ★ 补充需求（22:31）：从回调 task_id 反解 **sub-session id**。
 *
 * 前缀 `roy-session-`；非该前缀（含 `roy-task-`）→ null。
 * 与 `parseRoyTaskId` 互斥，所以一张卡永远只会有其中一种主键。
 */
function parseRoySessionId(cardTaskId: string): string | null {
  if (!cardTaskId.startsWith(ROY_SESSION_PREFIX)) return null;
  const rest = cardTaskId.slice(ROY_SESSION_PREFIX.length);
  // ★ 澄清 22:37：task_id 可能带 `@task-<n>` 附加值 → 只取 sessionId 段。
  //   刷新永远读 session store，task 段不参与主键解析。
  const sepIdx = rest.indexOf(WECOM_SESSION_TASK_SEP);
  const id = (sepIdx >= 0 ? rest.slice(0, sepIdx) : rest).trim();
  return id || null;
}


/** 从回调 task_id 反解任务号；非 roy-task 前缀 → null */
function parseRoyTaskId(cardTaskId: string): number | null {
  if (!cardTaskId.startsWith(ROY_TASK_PREFIX)) return null;
  const rest = cardTaskId.slice(ROY_TASK_PREFIX.length);
  const m = rest.match(/^(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 从 WS 帧解析 template_card_event。
 *
 * 非 template_card_event（消息帧 / 其他事件）→ null。
 */
export function extractWecomCardAction(
  frame: unknown,
): WecomCardActionEvent | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as {
    cmd?: string;
    headers?: { req_id?: string };
    body?: Record<string, unknown>;
  };
  if (f.cmd !== "aibot_event_callback") return null;
  const body = f.body;
  if (!body || typeof body !== "object") return null;
  const event = body.event as
    | {
        eventtype?: string;
        template_card_event?: {
          event_key?: string;
          task_id?: string;
        };
      }
    | undefined;
  if (event?.eventtype !== "template_card_event") return null;
  const tce = event.template_card_event;
  if (!tce) return null;

  const cardTaskId = String(tce.task_id ?? "");
  const from = (body.from ?? {}) as { userid?: string };

  return {
    eventKey: String(tce.event_key ?? ""),
    cardTaskId,
    taskId: parseRoyTaskId(cardTaskId),
    sessionId: parseRoySessionId(cardTaskId),
    userId: from.userid ?? "",
    reqId: f.headers?.req_id ?? "",
  };
}

// ============================================================================
// 动作分发
// ============================================================================

/** 动作 → 卡片更新文案 */
const ACTION_CARD_LABEL: Record<
  WecomCardAction,
  { statusLabel: string; note: string }
> = {
  view: {
    statusLabel: "👀 已查看",
    note: "用户已查看任务",
  },
  mark_done: {
    statusLabel: "🎉 已完成",
    note: "用户已确认任务完成",
  },
  reopen: {
    statusLabel: "🔄 进行中",
    note: "用户已重新打开任务",
  },
  // ★ Task #5360：刷新活性是**只读**动作 —— statusLabel 保持不变语义上更诚实，
  //   但企微 protocol 要求更新帧必须有 main_title，所以给一个中性标签，
  //   真正的信息在 quote_area（活性）里。
  refresh_activity: {
    statusLabel: "⚡ 活性已刷新",
    note: "已读取子会话最新活性",
  },
};

/**
 * 处理卡片按钮点击。
 *
 * @returns 处理结果（ok=true 表示动作已执行 + 卡片已更新）
 */
export async function handleWecomCardAction(
  frame: unknown,
  ports: WecomCardActionPorts,
): Promise<WecomCardActionResult> {
  const action = extractWecomCardAction(frame);
  if (!action) {
    return { ok: false, error: "not a template_card_event frame" };
  }

  // 并发去重（key = cardTaskId:action；双击只处理第一次）
  const inflightKey = `${action.cardTaskId}:${action.eventKey}`;
  const inflight = cardActionInflight.get(inflightKey);
  if (inflight) {
    logger.warn(
      `handleWecomCardAction: ${inflightKey} 已有同操作在处理中` +
        `（疑似用户重复点击），本次忽略。`,
    );
    return { ok: false, error: "同操作处理中，已忽略重复点击" };
  }

  const job = doHandle(action, ports).finally(() => {
    cardActionInflight.delete(inflightKey);
  });
  cardActionInflight.set(inflightKey, job);
  return job;
}

/**
 * ★ Task #5418 —— task 卡刷新活性时的 session store 回退 probe。
 *
 * ## 什么时候被调
 *
 * task 路径 `loadSubSessionActivity(taskId)` 返回 `activity=undefined`
 * （bgTask 内存 Map 反查不到 —— 典型场景：进程重启后 terminalTasks
 * 丢失）。此时不能直接渲染「暂无数据」：session store 是持久化的，
 * 数据很可能完好。
 *
 * ## sessionId 从哪来
 *
 * `roy-task-` 前缀卡的回调里没有 sessionId。唯一的持久化映射是
 * `wecom_session_card.associated_task_id → session_id`（sender 每次
 * lifecycle 事件都会 upsert，见 wecom-session-card-sender.ts）。
 * 经 `findSessionCardByTaskId` 端口反查。
 *
 * ## best-effort
 *
 * 端口缺省 / 抛错 / 反查不到 / session probe 无数据 → 返回
 * `undefined`（调用方保持 null「暂无数据」），绝不抛。
 */
async function probeSessionActivityByAssociatedTask(
  taskId: number,
  ports: WecomCardActionPorts,
): Promise<ActivityProbeResult | undefined> {
  if (!ports.findSessionCardByTaskId || !ports.loadSessionActivity) {
    return undefined;
  }
  const card = await ports.findSessionCardByTaskId(taskId);
  if (!card?.sessionId) return undefined;
  return await ports.loadSessionActivity(card.sessionId);
}

async function doHandle(
  action: WecomCardActionEvent,
  ports: WecomCardActionPorts,
): Promise<WecomCardActionResult> {
  // 动作路由
  let actionType: WecomCardAction;
  if (action.eventKey === WecomCardActionKey.MARK_DONE) {
    actionType = "mark_done";
  } else if (action.eventKey === WecomCardActionKey.REOPEN) {
    actionType = "reopen";
  } else if (action.eventKey === WecomCardActionKey.VIEW) {
    actionType = "view";
  } else if (action.eventKey === WecomCardActionKey.REFRESH_ACTIVITY) {
    actionType = "refresh_activity";
  } else if (action.eventKey === WecomCardActionKey.CREATE_LARK_GROUP) {
    actionType = "create_lark_group";
  } else {
    return { ok: false, error: `unknown event_key: ${action.eventKey}` };
  }

  // ★ 澄清（22:37）：session 卡的 `roy-session-` 前缀 —— refresh_activity 走
  //   session 主键路径（有无 task 都一样：消息数/最近消息是会话属性）。
  //
  // ★ Task #5419：create_lark_group 同走 session 主键路径（建群目标
  //   是 session 本身，有无 task 都能建）。
  //
  // 其余动作仍需 task：mark_done/reopen 要改 task 状态，view 要读 task 的
  // 操作时间线 —— session 本身没有这些。（有 task 的 session 卡由 updateCard
  // 里的 task 信息承载，不靠 view。）
  if (action.sessionId !== null) {
    if (actionType === "refresh_activity") {
      return await doHandleSessionActivity(action, ports);
    }
    if (actionType === "create_lark_group") {
      return await doHandleSessionCreateLarkGroup(action, ports);
    }
    return {
      ok: false,
      error: `action ${actionType} requires a task card (got session ${action.sessionId})`,
    };
  }

  // 非 roy-task 卡片（外部发的）→ 不执行任务操作
  //
  // ★ Task #5360：`refresh_activity` 与 `mark_done` / `reopen` 同档 —— 它虽然
  //   是只读动作，但**没有 taskId 就查不到活性**，给一张「暂无数据」的卡
  //   等于噪音。所以一并要求能解出 roy 任务号。
  if (action.taskId === null && actionType !== "view") {
    return {
      ok: false,
      error: `cannot parse roy task id from card task_id: ${action.cardTaskId}`,
    };
  }

  // 1. 触发 task 操作（失败不阻断卡片更新——用户至少看到反馈）
  let opError: string | undefined;
  try {
    if (actionType === "mark_done" && action.taskId !== null) {
      await ports.markTaskDone(action.taskId);
    } else if (actionType === "reopen" && action.taskId !== null) {
      await ports.reopenTask(action.taskId);
    }
  } catch (err) {
    opError = err instanceof Error ? err.message : String(err);
    logger.error(
      `handleWecomCardAction: task op failed for #${action.taskId}: ${opError}`,
    );
  }

  // 2. 更新卡片（5 秒窗口内；失败只 log——窗口已过也无能为力）
  const label = ACTION_CARD_LABEL[actionType];
  const note =
    actionType === "view" || actionType === "refresh_activity"
      ? label.note
      : opError
        ? `${label.note}（操作失败：${opError}）`
        : label.note;

  // ★ Task #5203：view 动作 → 从 store 读时间线刷进卡片正文
  // ★ Task #5261：reopen 动作同样读历史时间线——
  //   旧行为 reopen 不带 timeline → buildWecomCardUpdateFrame
  //   空数组兜底 → 更新后卡片时间线清零（用户反馈）。
  let timeline: WecomMilestoneLite[] | undefined;
  if (
    (actionType === "view" || actionType === "reopen") &&
    action.taskId !== null
  ) {
    try {
      timeline = ports.loadTimeline?.(action.taskId) ?? [];
      if (timeline.length === 0) {
        logger.warn(
          `handleWecomCardAction: task #${action.taskId} 无时间线记录，` +
            `降级为简单按钮态更新`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `handleWecomCardAction: loadTimeline failed for ` +
          `task #${action.taskId}: ${msg}（降级为简单按钮态更新）`,
      );
      timeline = [];
    }
  }

  // ★ Task #5273：读任务号+标题（渲染进更新卡 main_title）
  // ★ CV-B1（返工）：loadTaskTitle 生产实现返回 Promise → 必须
  //   await；reject/抛错统一降级为无标题（不阻断卡片更新，
  //   不产生 unhandledRejection）。
  let taskExtra: { taskNumber?: number; taskTitle?: string } | undefined;
  try {
    const t =
      action.taskId !== null
        ? await ports.loadTaskTitle?.(action.taskId)
        : undefined;
    if (t && (t.title || t.number !== undefined)) {
      taskExtra = { taskNumber: t.number, taskTitle: t.title };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `handleWecomCardAction: loadTaskTitle failed for ` +
        `task #${action.taskId}: ${msg}（降级为无标题更新）`,
    );
  }

  // ★ Task #5360：刷新活性 → 读 sub-session 活性（best-effort）
  //
  // 只有 refresh_activity 才查（view 是"刷操作时间线"，语义不同，不要混）。
  // 任何失败（端口缺失 / 抛错）→ activity 保持 undefined 之外的 `null`，
  // 让卡片渲染「暂无数据」—— 用户点了按钮必须有反馈。
  let activity: WecomActivityLike | null | undefined;
  // ★ CV MAJOR-2 修复：`terminal` 必须透传 —— 否则已结束的任务在企微卡上
  //   会被判成 🔴「疑似停滞」（20 分钟无写入 = 心跳停了），而飞书侧传了
  //   terminal 会正确显示 ⚪「已结束」。同一任务两个渠道给出相反信号，
  //   比不显示更糟。
  let activityTerminal: boolean | undefined;
  if (actionType === "refresh_activity" && action.taskId !== null) {
    try {
      const r = await ports.loadSubSessionActivity?.(action.taskId);
      activity = r?.activity ?? null;
      activityTerminal = r?.terminal === true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `handleWecomCardAction: loadSubSessionActivity failed for ` +
          `task #${action.taskId}: ${msg}（降级为「暂无数据」）`,
      );
      activity = null;
    }
    // ★ Task #5418：反查不到 bgTask ≠ 没有数据 —— 回退 session store。
    //
    // task 路径的活性链（createActivityProbe）要先经
    // `listBackgroundTasks()` 内存 Map 反查 bgTask；进程重启后
    // terminalTasks 全丢（非持久化）→ 反查不到 → `activity=undefined`
    // → 渲染「暂无数据」。但 session store（sessions.db）是持久化的，
    // 数据很可能完好 —— 此时「暂无数据」是撒谎（用户截图 2026-11-13：
    // 标题「活性已刷新」+ 内容「暂无数据」的矛盾即此根因）。
    //
    // 回退条件：task probe 返回 `activity=undefined`（反查不到 /
    // 数据源缺）**或 probe 抛错**（数据源故障就该换源，同样回退），
    // 且能从 session 卡持久层反解出 sessionId。session probe 也
    // 拿不到 / 抛错 → 保持 null（诚实降级）。
    if (activity === null) {
      try {
        const fallback = await probeSessionActivityByAssociatedTask(
          action.taskId,
          ports,
        );
        if (fallback?.activity) {
          activity = fallback.activity;
          activityTerminal = fallback.terminal === true;
          logger.info(
            `handleWecomCardAction: task #${action.taskId} bgTask 反查失败，` +
              `已回退 session store probe（messageCount=${fallback.activity.messageCount}）`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `handleWecomCardAction: session probe fallback failed for ` +
            `task #${action.taskId}: ${msg}（保持「暂无数据」）`,
        );
      }
    }
  }

  try {
    await ports.updateCard(
      action.reqId,
      action.cardTaskId,
      label.statusLabel,
      note,
      timeline,
      actionType,
      // ★ Task #5360：活性合并进 extra（`undefined` = 不渲染，`null` = 暂无数据）
      activity === undefined
        ? taskExtra
        : {
            ...(taskExtra ?? {}),
            activity,
            // ★ CV MAJOR-2：终态透传（undefined 时由渲染层按非终态处理）
            ...(activityTerminal !== undefined
              ? { activityTerminal }
              : {}),
          },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`handleWecomCardAction: updateCard failed: ${msg}`);
    return {
      ok: false,
      action: actionType,
      error: `card update failed: ${msg}`,
    };
  }

  if (opError) {
    return { ok: false, action: actionType, error: opError };
  }
  logger.info(
    `handleWecomCardAction: task #${action.taskId} → ${actionType} ` +
      `(by ${action.userId})`,
  );
  return { ok: true, action: actionType };
}

/**
 * ★ Task #5364（B 方案）—— session 卡片的「刷新」处理。
 *
 * ## 语义（用户 2026-11-12 08:34 拍板 B）
 *
 * > 「靠按钮触发更新：卡片上「刷新」按钮点击时（有 req_id 回调窗口）
 * >   → patch 该卡显示最新状态 + 活性」
 *
 * 这是 **B 方案唯一的信息出口**：后续 lifecycle 事件不主动 patch（协议不允许），
 * 所以用户点这一刻必须看到**全部最新信息**：
 *
 * | 内容 | 来源 | 缺了会怎样 |
 * |------|------|-----------|
 * | 生命周期（完成/超时/失败/停止） | `store.lifecycle` | 卡片永远停在「运行中」 |
 * | 会话详情（id/agent/已运行） | `store` | 首次发卡的信息被擦掉 |
 * | 任务号 + 标题 | `store.associatedTaskId` | 有 task 的用户看不到任务 |
 * | 操作记录时间线 | `store.milestones` | 「这一路发生了什么」丢失 |
 * | 活性（消息数 + 最近 msg） | 实时 probe | 判断不出 LLM 有无推进 |
 *
 * ## 全链路 best-effort
 *
 * store 缺 / 抛错 / 无记录 ⇒ `state = undefined`，仍**照常更新卡片**
 * （只有活性那一块）。用户点了按钮必须有反馈，绝不因取数失败而静默。
 */
async function doHandleSessionActivity(
  action: WecomCardActionEvent,
  ports: WecomCardActionPorts,
): Promise<WecomCardActionResult> {
  const sessionId = action.sessionId!;

  // ---- 1. 读持久层快照（B 方案的核心数据源）----
  let state: WecomSessionCardState | undefined;
  try {
    state = await ports.loadSessionCardState?.(sessionId);
  } catch (err) {
    logger.warn(
      `handleWecomCardAction: loadSessionCardState failed for ${sessionId}: ` +
        `${err instanceof Error ? err.message : String(err)}（降级为仅活性）`,
    );
    state = undefined;
  }
  if (!state) {
    logger.warn(
      `handleWecomCardAction: 无 session 卡持久层记录（${sessionId}）` +
        ` ⇒ 刷新卡降级为仅活性（生命周期/操作记录不可用）`,
    );
  }

  // ---- 2. 实时活性（消息数 + 最近消息）----
  //
  // ★ 同时取 probe 的 `terminal`：快照缺失（无 store 记录 / 进程重启）时要靠
  //   它判断「已结束 vs 疑似停滞」。旧实现从快照推，快照没了就退化成 false，
  //   会把已结束的 session 报成 🔴疑似停滞 —— 比不显示更糟。
  let activity: WecomActivityLike | null = null;
  let probeTerminal: boolean | undefined;
  try {
    const r = await ports.loadSessionActivity?.(sessionId);
    activity = r?.activity ?? null;
    probeTerminal = r?.terminal;
  } catch (err) {
    logger.warn(
      `handleWecomCardAction: loadSessionActivity failed for ${sessionId}: ` +
        `${err instanceof Error ? err.message : String(err)}（降级为「暂无数据」）`,
    );
    activity = null;
  }

  // ---- 2.5 ★ Task #5419：任务信息（是否建任务 + 任务名称 + 任务动态）----
  //
  // 用户 2026-11-13：「有刷新详情按钮可以刷新 subsession 状态
  // （包括是否建任务，以及任务名称和动态，也包括 subsession 的消息数）」。
  //
  // best-effort：端口缺失 / 抛错 ⇒ undefined（卡上不渲染任务行），
  // 绝不阻断刷新。
  let sessionTask:
    | {
        id: number;
        title?: string;
        status?: string;
        progress?: number;
        milestones?: WecomMilestoneLite[];
      }
    | undefined;
  try {
    const t = await ports.loadSessionTaskInfo?.(sessionId);
    if (t && typeof t.id === "number") {
      sessionTask = t;
    }
  } catch (err) {
    logger.warn(
      `handleWecomCardAction: loadSessionTaskInfo failed for ${sessionId}: ` +
        `${err instanceof Error ? err.message : String(err)}（降级为无任务行）`,
    );
  }

  // ---- 2.6 ★ Task #5419：已关联飞书群（建群后刷新带群链接）----
  let linkedChatId: string | undefined;
  try {
    const g = await ports.findGroupChatForSession?.(sessionId);
    if (g && typeof g.chatId === "string" && g.chatId.trim()) {
      linkedChatId = g.chatId.trim();
    }
  } catch (err) {
    logger.warn(
      `handleWecomCardAction: findGroupChatForSession failed for ${sessionId}: ` +
        `${err instanceof Error ? err.message : String(err)}（当作没有群）`,
    );
  }

  // ---- 3a. 优先走完整快照渲染（B 方案）----
  //
  // `updateSessionCard` 是新端口：一次渲染装齐「生命周期 + 会话详情 +
  // 任务 + 操作记录 + 活性」。旧 callers（未注入它）走 3b 的降级路径，
  // 保证 #5360 的既有行为与测试零回归。
  if (ports.updateSessionCard) {
    try {
      await ports.updateSessionCard(action.reqId, {
        sessionId,
        cardTaskId: action.cardTaskId,
        state,
        activity,
        // ★ Task #5419：任务信息 + 群链接
        ...(sessionTask ? { task: sessionTask } : {}),
        ...(linkedChatId ? { perTaskChatId: linkedChatId } : {}),
      });
      logger.info(
        `handleWecomCardAction: session ${sessionId} → refresh ` +
          `(lifecycle=${state?.lifecycle ?? "unknown"}, by ${action.userId})`,
      );
      return { ok: true, action: "refresh_activity" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        `handleWecomCardAction: session card update failed for ${sessionId}: ${msg}`,
      );
      return {
        ok: false,
        action: "refresh_activity",
        error: `card update failed: ${msg}`,
      };
    }
  }

  // ---- 3b. 降级：旧 updateCard 路径（仅活性，无快照）----
  try {
    await ports.updateCard(
      action.reqId,
      action.cardTaskId,
      ACTION_CARD_LABEL.refresh_activity.statusLabel,
      ACTION_CARD_LABEL.refresh_activity.note,
      undefined,
      "refresh_activity",
      {
        activity,
        // 优先级：快照生命周期（权威）> probe terminal > false（乐观）
        activityTerminal:
          state?.lifecycle !== undefined
            ? state.lifecycle !== "running"
            : (probeTerminal ?? false),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `handleWecomCardAction: session card update failed for ${sessionId}: ${msg}`,
    );
    return { ok: false, action: "refresh_activity", error: `card update failed: ${msg}` };
  }

  logger.info(
    `handleWecomCardAction: session ${sessionId} → refresh ` +
      `(lifecycle=${state?.lifecycle ?? "unknown"}, by ${action.userId})`,
  );
  return { ok: true, action: "refresh_activity" };
}

/**
 * ★ Task #5419 —— session 卡「建飞书群」处理。
 *
 * ## 语义（对齐飞书 handleGroupActionSessionOnly，#5397/#5403）
 *
 * 1. 幂等：`findGroupChatForSession` 命中 ⇒ 直接返回已有群，
 *    不重复建（只刷卡片带群链接）
 * 2. 建群：`createLarkGroupForSession`（生产 = lark-cli +chat-create
 *    + attachGroupSession 初始化群 session）
 * 3. 反馈（用户：「建完可以展示或者发一条企微消息带上飞书群
 *    跳转链接哈」）：
 *    - 窗口内 update 卡（horizontal 加「飞书群」行）
 *    - `notifyGroupLink` 发一条企微消息带 applink（best-effort）
 * 4. 失败：ok=false，但**卡片仍更新**（错误反馈，用户点了必须有响应）
 */
async function doHandleSessionCreateLarkGroup(
  action: WecomCardActionEvent,
  ports: WecomCardActionPorts,
): Promise<WecomCardActionResult> {
  const sessionId = action.sessionId!;

  // ---- 1. 幂等：已有群 ⇒ 不重复建 ----
  let existingChatId: string | undefined;
  try {
    const g = await ports.findGroupChatForSession?.(sessionId);
    if (g && typeof g.chatId === "string" && g.chatId.trim()) {
      existingChatId = g.chatId.trim();
    }
  } catch (err) {
    logger.warn(
      `handleWecomCardAction: findGroupChatForSession(${sessionId}) 失败` +
        `（当作没有群）: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (existingChatId) {
    logger.info(
      `handleWecomCardAction: session ${sessionId} 已有飞书群 ` +
        `${existingChatId}（幂等命中，不重复建群）`,
    );
    await updateSessionCardWithGroup(ports, action, sessionId, existingChatId);
    return { ok: true, action: "create_lark_group", newChatId: existingChatId };
  }

  // ---- 2. 建群 ----
  if (!ports.createLarkGroupForSession) {
    return {
      ok: false,
      action: "create_lark_group",
      error:
        "ports.createLarkGroupForSession not injected " +
        "(wecom-cli-handler wiring missing)",
    };
  }

  let chatId: string;
  try {
    chatId = await ports.createLarkGroupForSession(sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `handleWecomCardAction: createLarkGroupForSession(${sessionId}) ` +
        `failed: ${msg}`,
    );
    // 卡片仍更新（错误反馈），但结果翻失败
    await updateSessionCardWithGroup(
      ports,
      action,
      sessionId,
      undefined,
      `⚠️ 建群失败：${msg.slice(0, 80)}`,
    );
    return { ok: false, action: "create_lark_group", error: msg };
  }

  logger.info(
    `handleWecomCardAction: session ${sessionId} → 飞书群 ${chatId} ` +
      `创建成功（by ${action.userId}）`,
  );

  // ---- 3. 反馈：窗口内刷卡 + 发企微消息带 applink（best-effort）----
  await updateSessionCardWithGroup(ports, action, sessionId, chatId);

  if (ports.notifyGroupLink) {
    try {
      // ★ CV 5419 BLOCKER-1：带上点击者 userId（企微侧通知目标）
      await ports.notifyGroupLink({
        sessionId,
        chatId,
        ...(action.userId ? { userId: action.userId } : {}),
      });
    } catch (err) {
      logger.warn(
        `handleWecomCardAction: notifyGroupLink(${sessionId} → ${chatId}) ` +
          `失败（不阻断建群结果）: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { ok: true, action: "create_lark_group", newChatId: chatId };
}

/**
 * ★ Task #5419：建群后窗口内更新卡片（带群链接）。
 *
 * best-effort：updateSessionCard 未注入 / 抛错只 warn（窗口已过
 * 也无能为力），不改变建群结果。
 */
async function updateSessionCardWithGroup(
  ports: WecomCardActionPorts,
  action: WecomCardActionEvent,
  sessionId: string,
  chatId: string | undefined,
  /** ★ CV 5419 MAJOR-3：建群失败时的错误提示（渲染进 sub_title） */
  errorHint?: string,
): Promise<void> {
  if (!ports.updateSessionCard) return;
  try {
    // 读快照 + 活性，尽量保留原信息（与刷新同源）
    let state: WecomSessionCardState | undefined;
    try {
      state = await ports.loadSessionCardState?.(sessionId);
    } catch {
      state = undefined;
    }
    let activity: WecomActivityLike | null = null;
    try {
      const r = await ports.loadSessionActivity?.(sessionId);
      activity = r?.activity ?? null;
    } catch {
      activity = null;
    }
    await ports.updateSessionCard(action.reqId, {
      sessionId,
      cardTaskId: action.cardTaskId,
      ...(state ? { state } : {}),
      activity,
      ...(chatId ? { perTaskChatId: chatId } : {}),
      // ★ CV 5419 MAJOR-3：失败原因要在卡上可见（用户点了必须有响应）
      ...(errorHint ? { errorHint } : {}),
    });
    logger.info(
      `handleWecomCardAction: session card updated after group change ` +
        `(session=${sessionId}, chatId=${chatId ?? "none"})`,
    );
  } catch (err) {
    logger.warn(
      `handleWecomCardAction: session card update after group change ` +
        `failed for ${sessionId}（不阻断建群结果）: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ============================================================================
// 默认端口实现（WecomCliInstance 注入用）
// ============================================================================

/**
 * 构造卡片更新帧（aibot_respond_update_msg）。
 *
 * 供 caller（WecomCliInstance）把 ports.updateCard 接到 bridge.respond：
 * bridge.respond(reqId, buildWecomCardUpdateBody(...).body)。
 *
 * 独立导出是为了单测不依赖 bridge。
 */
export function buildWecomCardUpdateBody(input: {
  cardTaskId: string;
  statusLabel: string;
  note?: string;
  /** ★ Task #5203：view 动作携带的操作时间线 */
  timeline?: WecomMilestoneLite[];
  /**
   * ★ Task #5250：触发更新的动作（决定更新后的按钮）。
   *
   * - view / reopen → 保留可点击的「刷新详情」（key=task_view）：
   *   用户可**重复点击**刷新最新里程碑/操作记录
   * - mark_done / 缺省（旧调用方）→ 死按钮「已处理」
   *   （key=task_done_ack，终态确认，向后兼容 #5203 行为）
   */
  action?: WecomCardAction;
  /**
   * ★ Task #5273：任务号+标题（可选，渲染进 main_title，
   * 修复「更新卡缺 Task #ID 和 title」）
   */
  taskTitle?: string;
  taskNumber?: number;
  /**
   * ★ Task #5360：sub-session 活性
   * （`undefined` = 不渲染；`null` = 暂无数据）
   */
  activity?: WecomActivityLike | null;
  /** ★ Task #5360（CV MAJOR-2）：任务是否已终态 */
  activityTerminal?: boolean;
}): { cmd: string; body: Record<string, unknown> } {
  const refreshable = input.action === "view" || input.action === "reopen";
  // ★ Task #5360：刷新活性后按钮要能继续点「刷新活性」（可重复刷新）
  const activityRefreshable = input.action === "refresh_activity";
  const frame = buildWecomCardUpdateFrame({
    reqId: "placeholder",
    taskId: input.cardTaskId,
    statusLabel: input.statusLabel,
    note: input.note,
    timeline: input.timeline,
    taskTitle: input.taskTitle,
    taskNumber: input.taskNumber,
    // 更新后的按钮：
    // - view/reopen → 「刷新详情」（可重复点击，key=task_view 回调路由）
    // - mark_done/缺省 → 「已处理」（style 4 = 强调/完成，终态）
    buttonOverrides: refreshable
      ? [{ text: "刷新详情", key: WecomCardActionKey.VIEW, style: 1 }]
      : activityRefreshable
        // 刷新活性后：保留「刷新详情」+「刷新活性」两个按钮
        // （用户可能想接着看时间线，也可能想再刷一次活性）
        ? [
            { text: "刷新详情", key: WecomCardActionKey.VIEW, style: 2 },
            { text: "刷新活性", key: WecomCardActionKey.REFRESH_ACTIVITY, style: 1 },
          ]
        : [{ text: "已处理", key: "task_done_ack", style: 4 }],
    ...(input.activity !== undefined ? { activity: input.activity } : {}),
    ...(input.activityTerminal !== undefined
      ? { activityTerminal: input.activityTerminal }
      : {}),
  });
  return { cmd: frame.cmd, body: frame.body };
}

/**
 * ★ Task #5364（B 方案）—— 构造 **session 卡刷新**的更新帧。
 *
 * 独立导出（不走 ports）是为了：
 * 1. 单测能直接断言渲染结果，不依赖 bridge
 * 2. `WecomCliInstance` 的 `updateSessionCard` 实现只需要两步：
 *    `buildWecomSessionCardUpdateBody(...)` → `sendFrameWithReqId`
 *
 * ## 为什么快照允许 `undefined`
 *
 * B 方案里持久层是「刷新时的唯一数据源」，但它可能不存在（进程刚重启 +
 * 首次事件丢了 store / 老卡片）。此时**不能不给反馈** —— 用户点了按钮，
 * 什么都没变比显示「暂无数据」更糟。所以降级路径渲染：状态=「状态未知」+
 * 活性（活性反而是这时最有用的信号）。
 */
export function buildWecomSessionCardUpdateBody(input: {
  /** 回调带回的原始 task_id（原样回填，协议硬约束） */
  cardTaskId: string;
  sessionId: string;
  /**
   * req_id（协议必填）。命名带 ForTest 是历史遗留：生产路径由
   * `updateSessionCard` 端口在 `sendFrameWithReqId` 时注入 headers，
   * 这里仅用于单测直接验证帧结构。
   */
  reqIdForTest?: string;
  /** 持久层快照；undefined = 无记录 */
  state?: WecomSessionCardState;
  /** 活性；undefined = 不渲染该块，null = 暂无数据 */
  activity?: WecomActivityLike | null;
  now?: number;
  /** 关联任务（可选覆盖；缺省从 state.associatedTaskId 推导编号） */
  task?: {
    id: number;
    title?: string;
    status?: string;
    progress?: number;
  };
  /**
   * ★ Task #5419：已关联飞书群 chatId（渲染「飞书群」行）。
   */
  perTaskChatId?: string;
  /** ★ CV 5419 MAJOR-3：建群失败提示（渲染进 sub_title） */
  errorHint?: string;
}): { cmd: string; body: Record<string, unknown> } {
  const state = input.state;

  // ★ DS review R1 MAJOR-2：**不许**在无快照时谎报「运行中」。
  //
  // 旧写法 `state?.lifecycle ?? "running"` 的语义是「查不到就当在跑」。
  // 但「查不到」的真实含义是 **不知道** —— 可能是进程刚重启、store 读失败、
  // 或这张卡是更早版本发的。此时渲染「运行中」会让用户以为还在推进，
  // 而活性侧可能同时显示 🔴 疑似停滞（40 分钟无写入）—— 一张卡上两个
  // 互相矛盾的信号，比不显示更糟（review 原文：恰好打在「用户点了必须有
  // 正确反馈」这条红线上）。
  //
  // ⇒ 无快照时状态用「未知」。它不撒谎，也不会和活性打架。
  const lifecycle: WecomSessionUpdateLifecycle = state?.lifecycle ?? "unknown";

  // 操作记录：持久层里存的是 JSON 字符串（milestones）
  let milestones: WecomMilestoneLite[] | undefined;
  if (state?.milestones) {
    try {
      const arr = JSON.parse(state.milestones);
      if (Array.isArray(arr) && arr.length > 0) {
        milestones = arr as WecomMilestoneLite[];
      }
    } catch {
      milestones = undefined;
    }
  }

  // 任务增强：调用方显式给了就用；否则从 state 里的 taskId 生成最小行
  //（没有标题/状态也至少让用户看到「这事挂在哪个人任务上」）
  const task =
    input.task ??
    (state?.associatedTaskId !== undefined
      ? { id: state.associatedTaskId }
      : undefined);

  const frame = buildWecomSessionUpdateFrame({
    // 这里 req_id 只是占位 —— 真实发送时由 updateSessionCard 端口
    // 用回调 reqId 覆盖 headers（见 buildWecomCardUpdateBody 同款做法）
    reqId: input.reqIdForTest ?? "placeholder",
    cardTaskId: input.cardTaskId,
    sessionId: input.sessionId,
    lifecycle,
    ...(state?.title ? { title: state.title } : {}),
    ...(state?.agentType ? { agentType: state.agentType } : {}),
    ...(state?.startedAt ? { startedAt: state.startedAt } : {}),
    ...(task ? { task } : {}),
    ...(milestones ? { milestones } : {}),
    // ★ Task #5419：已关联飞书群 ⇒ 渲染群行
    ...(input.perTaskChatId ? { perTaskChatId: input.perTaskChatId } : {}),
    // ★ CV 5419 MAJOR-3：失败提示透传（渲染层拼进 sub_title）
    ...(input.errorHint ? { errorHint: input.errorHint } : {}),
    ...(input.activity !== undefined ? { activity: input.activity } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  return { cmd: frame.cmd, body: frame.body };
}
