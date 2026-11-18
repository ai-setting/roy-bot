/**
 * @fileoverview LarkCardPatchNotifier - 单卡片 patch 不刷屏通知器（Task #4230 重写）
 *
 * 封装"单卡片 patch"逻辑：每个 task 在飞书群里只有**一张**交互式卡片，
 * 状态变化时只 patch 这张卡片的内容（不刷屏），并且把卡片**置顶**（pin），
 * 让用户随时能看到任务进展。
 *
 * ## 设计要点
 *
 * 1. **生命周期**：startTask → updateTask* → finishTask
 *    - startTask: `im +messages-send` 发初始卡片 → 拿 messageId → `im pins create` 置顶
 *    - updateTask: `im messages patch` 改同一卡片内容（进度/当前步骤/里程碑/过程时间线）
 *    - finishTask: `im messages patch` 终态 + `im pins delete` 取消置顶
 *
 * 2. **卡片样式（用户验收过的 live card 样式）**
 *    - header.title       📊 Task 实时更新（<标题>）
 *    - header.subtitle    spinner: '<emoji>' | <状态短语>
 *    - 实时进度（进度条 / 进行中）
 *    - 当前步骤
 *    - 🎯 里程碑时间线
 *    - 🔧 过程时间线
 *    - footer：🔄 更新次数 | 🔄 Spinner | 🟣 状态
 *
 * 3. **lark-cli 参数契约（Task #4230 修复，2026-10-15 用 tongzhuli profile 实测）**
 *    - `im +messages-send`：`--msg-type interactive --content <card JSON>` ✅
 *      （+shortcut 的 --content 直接吃 card JSON；旧的 `{"content":...}` 双重包裹会 230099）
 *    - `im messages patch`：**只能**用 `--data '{"content":"<card JSON 字符串>"}'`
 *      ❌ 不能传 `--content`（unknown flag → 秒失败 → 卡片永远停在初始态）
 *    - `im pins create`：**只能**用 `--data '{"message_id":"om_xxx"}'`
 *      ❌ 不能传 `--chat-id/--message-id`（unknown flag → pin 永远失败）
 *    - `im pins delete`：`--message-id om_xxx --yes`（high-risk-write，必须 --yes）
 *
 * 4. **状态自持（不刷屏 + 持续滚动）**
 *    - 同一 messageId 的里程碑/过程时间线由 notifier 自己累积（append + 去重）
 *    - 每次 update 递增更新次数并轮换 spinner emoji（"持续滚动"观感）
 *    - caller 只需要传"本次新增了什么"，不需要自己维护全量历史
 *
 * 5. **并发串行化**：同一 messageId 的 patch 走 mutex，避免飞书端并发覆盖
 *
 * 6. **错误处理**
 *    - 发卡/pat 失败 → 抛错（caller 决定是否 graceful degrade）
 *    - pin/unpin 失败 → 非致命（warn + span 属性标记），卡片仍可见
 *
 * @example
 * ```typescript
 * const notifier = new LarkCardPatchNotifier();
 * const { messageId, pinned } = await notifier.startTask({
 *   chatId: "oc_xxx", profile: "tongzhuli", taskId: 4221, taskTitle: "调研",
 * });
 * await notifier.updateTask({
 *   messageId, status: "running", taskId: 4221, taskTitle: "调研",
 *   currentStep: "扫描 GitHub Issues",
 *   milestones: [{ title: "调研启动", timestamp: new Date().toISOString() }],
 * });
 * await notifier.finishTask({ messageId, status: "completed" });
 * ```
 */

import { spawn } from "node:child_process";
import {
  getSharedLarkSessionCardStore,
  type LarkSessionCardStore,
} from "./lark-card-state-store";
import { createLogger } from "../../log-trace/logger";
import { TracedAs } from "../../log-trace/decorator";
// ★ Task #5360：子会话活性渲染（纯函数叶子模块，无回向依赖）
import {
  formatActivityLines,
  formatRecentToolCallLines,
  type ActivityMessage,
  type ToolCallView,
  type SubSessionActivity,
} from "./sub-session-activity";

const logger = createLogger("lark-cli:card-patch-notifier");

// ========================================================================
// 类型定义
// ========================================================================

/**
 * 卡片状态。
 *
 * ★ Part 2（workflow 通知）：新增 `"stopped"`（灰）—— task 只会用前三种，
 *   但同一套卡片骨架要给 workflow run 复用，而 workflow 有 stopped 终态。
 */
export type CardStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  /**
   * ★ Task #4536：任务被**取消**（task.status = "cancelled"）
   *
   * 旧实现把 cancelled 映射成 "failed" → 卡片显示「🚨 任务失败」，
   * 语义错误（用户主动取消 ≠ 失败）。新增独立状态，灰色 + 「已取消」。
   */
  | "cancelled"
  /**
   * ★ Task #4540：任务被**删除**（用户口中的「取消」= `deleteTask()` 硬删除）
   *
   * 与 `cancelled` 的区别：
   * - `cancelled` = `updateTask(status="cancelled")`，任务**实体还在**（可查、可恢复）
   * - `deleted`   = `deleteTask()`，任务实体**已从库消失**（不可恢复）
   *
   * 语义上必须分开：用户看到「🚫 已取消」会以为任务还能找回来；
   * 硬删除后任务真的没了，卡片应显示「🗑️ 已删除」。
   */
  | "deleted"
  /**
   * ★ Task #5164 需求 2b：任务进入「待验证」（两阶段验收，
   *   task_pre_complete 置 to_validate）。**非终态**活跃等待态：
   *   卡片保持可更新，但 header 第二行显示专属短语「🔍 待验证」，
   *   让用户一眼看出任务在等验收而不是在跑。
   */
  | "to_validate";

/** workflow 卡片状态（与 CardStatus 同集合；语义别名，便于阅读） */
export type WorkflowCardStatus = CardStatus;

/** 里程碑（关键节点）：时间 + 标题 + 描述 */
export interface Milestone {
  /** 里程碑标题（如 "调研启动"），会被拼进 "🟢 <title>" */
  title: string;
  /** ISO 8601 时间戳；缺省时渲染 "—" */
  timestamp?: string;
  /** 补充说明（渲染成 "  → <description>"） */
  description?: string;
}

/** 过程步骤（中间步骤）：时间段 + 描述 */
export interface ProcessStep {
  /** 步骤标题（如 "扫描 GitHub Issues"） */
  title: string;
  /** ISO 8601 起始时间；缺省时不渲染时间行 */
  timestamp?: string;
  /** ISO 8601 结束时间；缺省时渲染成 "→ 现在" */
  endTimestamp?: string;
  /** 补充说明（渲染成 "  → <description>"） */
  description?: string;
  /** 步骤分类（如 research / code / test），有值时追加到标题括号内 */
  category?: string;
  /**
   * ★ Task #4889 —— 这条过程步骤的**语义来源**。
   *
   * ## 为什么需要这个字段
   *
   * 「过程信息」区历史上混装了两种**语义完全不同**的东西：
   *
   *   1. **operation** —— 真正的任务操作记录（`task_operation_create` 写的）。
   *      core 自己派生（`deriveTimelineFromOperation`），title 是人写的
   *      里程碑标题，形如「勘查反转：manifest 并非残废」。
   *   2. **tool-trace** —— 工具调用轨迹。插件派生（`describeToolUse`），
   *      title 是**动作名**，形如「执行命令」「记录进展」。
   *
   * 两者在卡片上同属一个「🔧 过程信息」区块、底部统一计「N 个过程」，
   * 用户读起来就等同于「**每个工具调用都记了一条操作记录**」
   * —— 这正是 Task #4889 用户反馈的核心不满。
   *
   * 所以：卡片按 source **分区呈现**，让两种语义在 UI 上泾渭分明。
   *
   * - `"tool-trace"` → 渲染进「🔧 执行轨迹（工具调用）」区
   * - `"operation"` / 缺省 → 渲染进「📝 操作记录」区
   *
   * 缺省视为 operation：**旧数据（没有这个字段）必须继续渲染在操作记录区**，
   * 不能因为新增字段就丢掉历史内容。
   */
  source?: "operation" | "tool-trace";
  /**
   * ★ Task #4889 —— 该步骤的**唯一标识**（可选）。
   *
   * 有 id 时，去重完全按 id 进行 —— 于是「同一个工具被连续调用两次」
   * （title 相同、timestamp 可能同毫秒）不会撞成同一条而被**静默吞掉**。
   *
   * 缺省时退化为「内容 key」去重（同 title+timestamp+description+category+source
   * 视为同一条）—— 对 operation 记录是对的（同一 operation 重复上报就是同一条），
   * 对 tool-trace 则要求生产方补 id（插件已补）。
   */
  id?: string;
}

/**
 * 任务元信息（卡片顶部"任务栏位"区块的数据源）
 *
 * ★ 用户验收要求（Task #4230 v2）：
 *   卡片第一块必须是任务栏位：任务 ID / 标题 / 描述 / 目标 / 父任务 / 优先级 / context…
 *   且 context 要渲染成**人类可读的 markdown**（绝不出现 JSON 原文）。
 */
export interface TaskMeta {
  /** 任务 ID（#4223） */
  id?: number | string;
  /**
   * ★ 澄清 22:37：该任务所属的 sub-session（卡片**真正**的主键）。
   *
   * task 卡渲染时把它放进「刷新活性」按钮 value —— 因为刷新永远读 session
   * store。缺省时该按钮退化为 task 兜底路径（见 handler 注释）。
   */
  sessionId?: string;
  /** 任务标题 */
  title?: string;
  /** 任务描述 */
  description?: string;
  /** 目标与预期交付物（task.goals_and_expected_deliverables） */
  goals?: string;
  /** 父任务 ID（无父任务时不渲染） */
  parentTaskId?: number;
  /** 优先级（low/medium/high） */
  priority?: string;
  /** 任务类型（normal/cycle/longterm） */
  type?: string;
  /** 项目路径 */
  projectPath?: string;
  /** task.context 原始 JSON 字符串 —— 渲染时会被展开成可读 bullet，不显示 JSON */
  context?: string;
  /** 任务当前状态描述（task.current_status） */
  currentStatus?: string;
  /**
   * ★ Task #4331：专属群 chatId（决定卡片顶部按钮 + 下方链接渲染）
   *
   * - undefined 或空：渲染"为这个任务建群"按钮 + 不显示链接
   * - 有值：渲染"解散该群"按钮 + 显示飞书 applink "进入群"
   *
   * 通常从 task.context.larkPerTaskChatId 读出，由 LarkCliTaskNotifyHook
   * 透传给 buildTaskCard / updateTask。
   */
  perTaskChatId?: string;
  /**
   * ★ Task #4331：专属群名（可选，仅在渲染链接文本"进入群 XXX"时使用）
   *
   * 若未提供，默认显示"进入群"。
   */
  perTaskChatName?: string;
}

export interface StartTaskOptions {
  /** 飞书 chat ID (oc_xxx) */
  chatId: string;
  /** lark-cli profile（多 appId 场景用） */
  profile?: string;
  /** 任务元信息（栏位区块 + header 标题） */
  meta: TaskMeta;
  /** 首次渲染时的里程碑（通常一条 "Task 创建"） */
  milestones?: Milestone[];
}

export interface UpdateTaskOptions {
  /** 飞书 message_id（startTask 返回值） */
  messageId: string;
  /** 飞书 chat ID（仅用于诊断/日志，patch 不依赖它） */
  chatId?: string;
  /** lark-cli profile */
  profile?: string;
  status: CardStatus;
  /** 任务元信息（缺省时沿用 startTask 时缓存的那份） */
  meta?: TaskMeta;
  /**
   * 真实进度百分比（0-100）。
   *
   * ★ 只在调用方**确实知道**进度时传（禁止拿耗时估算假进度）。
   *   缺省时进度区渲染"进行中"而不是假百分比。
   */
  progress?: number;
  /** 本次新增的里程碑（会 append 到已有序列并去重） */
  milestones?: Milestone[];
  /** 本次新增的过程信息（会 append 到已有列表并去重） */
  processSteps?: ProcessStep[];
}

export interface FinishTaskOptions {
  messageId: string;
  chatId?: string;
  profile?: string;
  /**
   * 终态卡片状态
   *
   * ★ Task #4536 扩展：
   * - `completed` task.status = completed
   * - `failed`    task.status = failed / timeout
   * - `cancelled` task.status = cancelled（**不再**误标「失败」）
   * - `stopped`   task.status = paused（用户 stop / 暂停；不是终结，可 resume）
   */
  status: Exclude<CardStatus, "running">;
  meta?: TaskMeta;
  /** 终态补充说明（会作为最后一条里程碑 append） */
  finalStep?: string;
  progress?: number;
  /**
   * ★ Task #5384（CV R2 MINOR-5）：本次新增的过程步骤。
   *
   * 与 {@link UpdateTaskOptions.processSteps} 同义 —— 终态/暂停路径同样要能
   * 携带过程信息，否则「收尾前那几步」在 session 卡上会整段丢失
   * （task 卡路径原本也没有，但 session 卡有「执行动态」，不该丢）。
   */
  processSteps?: ProcessStep[];
  /**
   * 收尾里程碑的自定义标题（Task #4536 / xval round2 NIT 3）
   *
   * `pauseTask` 默认写「Task 已暂停」；archived 场景应传「Task 已归档」，
   * 否则归档任务的卡片会误显示"已暂停"。
   */
  pausedMilestoneTitle?: string;
  /**
   * 是否展开"执行动态"折叠面板（覆盖按 status 推导的默认值）
   *
   * ★ xval MINOR-2：`status` = "stopped" 时无法区分 task 的 paused（可 resume，
   *   非终态 → 折叠）与 archived（终态 → 展开）。调用方（知道原始 task.status
   *   的那层）显式传入即可覆盖。
   */
  expandTimeline?: boolean;
}

export interface StartTaskResult {
  messageId: string;
  /** pin 是否成功（失败不影响卡片可见性，但 trace 里可查） */
  pinned: boolean;
  /** pin 失败原因（诊断用） */
  pinError?: string;
}

export interface LarkCardPatchNotifierOptions {
  /** 启动时是否 pin（默认 true） */
  pinOnStart?: boolean;
  /**
   * ★ CV R3 M3：**session 卡持久层**（默认取进程单例）。
   *
   * 为什么不复用 task 卡持久层：`lark_card.task_id INTEGER PRIMARY KEY` 装不下
   * `session_xxx`。没有这张表时，「重启 + 无 task」的 session 会**又发一张卡**
   * （reviewer M3，属实）。
   *
   * 传 `null` 可显式关闭持久化（单测用，避免污染真实库）。
   */
  sessionCardStore?: LarkSessionCardStore | null;
  /**
   * 结束时是否 unpin（Task #5164 需求 2a：**默认 false**）
   *
   * 任务完成/暂停时不再自动取消置顶 —— pin 去留由用户手动决定。
   * 需要旧行为（自动 unpin）的调用方显式传 true。
   */
  unpinOnFinish?: boolean;
}

// ========================================================================
// Card 常量
// ========================================================================

const HEADER_TEMPLATE: Record<CardStatus, string> = {
  running: "blue",
  completed: "green",
  failed: "red",
  // stopped = 任务暂停（Task #4536：task.status="paused" 走这里）/ workflow stopped
  stopped: "grey",
  // Task #4536：任务取消（用户主动取消，非失败）
  cancelled: "grey",
  // Task #4540：硬删除（任务实体已不在库里）
  deleted: "grey",
  // Task #5164 需求 2b：待验证（活跃等待态，非终态）
  to_validate: "turquoise",
};

/** header.subtitle 的状态短语（用户验收样式：spinner: 'X' | <短语>） */
const STATUS_PHRASE: Record<CardStatus, string> = {
  running: "实时同步中",
  completed: "🎉 全部完成！",
  failed: "🚨 任务失败",
  stopped: "⏹️ 已停止",
  cancelled: "🚫 已取消",
  deleted: "🗑️ 已删除",
  // Task #5164 需求 2b：待验证
  to_validate: "🔍 待验证",
};

/** footer 的状态短语 */
const FOOTER_STATUS: Record<CardStatus, string> = {
  running: "🔄 进行中",
  completed: "✅ 完成",
  failed: "❌ 失败",
  stopped: "⏹️ 停止",
  cancelled: "🚫 取消",
  deleted: "🗑️ 删除",
  to_validate: "🔍 待验证",
};

/** 终态里程碑标题（Task #4536：区分完成 / 失败 / 取消 / 暂停） */
const FINAL_MILESTONE_TITLE: Record<CardStatus, string> = {
  running: "Task 进行中",
  completed: "Task 完成",
  failed: "Task 失败",
  stopped: "Task 已暂停",
  cancelled: "Task 已取消",
  deleted: "Task 已删除",
  // Task #5164 需求 2b：待验证（非终态，正常 patch 不写终态里程碑）
  to_validate: "Task 待验证",
};

/** "持续滚动"效果的轮换 emoji（每次 patch 换一个，让卡片看起来在动） */
const SPINNER_EMOJIS = ["⏳", "🔄", "🔃", "⌛", "⏰", "🔁"];

const PROGRESS_BAR_CELLS = 20;

export interface CardPayload {
  schema: "2.0";
  header: {
    title: { tag: "plain_text"; content: string };
    subtitle: { tag: "plain_text"; content: string };
    template: string;
  };
  body: { elements: Array<Record<string, any>> };
}

// ========================================================================
// Workflow 卡片类型（Part 2：复用 task 卡片骨架）
// ========================================================================

/**
 * workflow 运行元信息（卡片顶部"运行栏位"区块的数据源）
 *
 * ★ 与 {@link TaskMeta} 对应：task 卡片顶部是"任务栏位"，workflow 卡片顶部是
 *   "运行栏位"（workflow 名 / runId / workflowId / 触发输入摘要）。
 */
export interface WorkflowMeta {
  /** run 标识（== sessionId，engine 的 workflow:*.run 载荷提供） */
  runId: string;
  /** workflow 名称（人可读，用于卡片标题） */
  workflowName?: string;
  /** workflow 定义 id（可选） */
  workflowId?: string;
  /** 触发输入（before.run 提供）；渲染时会被 humanize，绝不输出 JSON 原文 */
  input?: unknown;
}

export interface StartWorkflowOptions {
  /** 飞书 chat ID (oc_xxx) */
  chatId: string;
  /** lark-cli profile（多 appId 场景用） */
  profile?: string;
  /** workflow 运行元信息（栏位区块 + header 标题） */
  meta: WorkflowMeta;
  /** DAG 节点总数 */
  totalNodes?: number;
  /** 已产出结果的节点数 */
  completedNodes?: number;
  /** 首次渲染时的里程碑（通常一条 "Workflow 启动"） */
  milestones?: Milestone[];
  /** 首次渲染时的过程记录 */
  processSteps?: ProcessStep[];
}

export interface UpdateWorkflowOptions {
  /** 飞书 message_id（startWorkflow 返回值） */
  messageId: string;
  /** 飞书 chat ID（仅用于诊断/日志，patch 不依赖它） */
  chatId?: string;
  /** lark-cli profile */
  profile?: string;
  /** 运行状态（缺省沿用上一次；默认为 running） */
  status?: WorkflowCardStatus;
  /** workflow 运行元信息（缺省时沿用 startWorkflow 时缓存的那份） */
  meta?: WorkflowMeta;
  /** 当前节点 id（渲染成"当前节点"） */
  currentNode?: string;
  /** 当前节点类型（agent / tool / ...） */
  currentNodeType?: string;
  /** 已产出结果的节点数（进度分子） */
  completedNodes?: number;
  /** DAG 节点总数（进度分母） */
  totalNodes?: number;
  /** 真实进度百分比（0-100）。缺省时由 completedNodes/totalNodes 推算 */
  progress?: number;
  /** 运行耗时（毫秒） */
  durationMs?: number;
  /** 失败原因 */
  error?: string;
  /** 本次新增的里程碑（append + 去重） */
  milestones?: Milestone[];
  /** 本次新增的过程信息（append + 去重） */
  processSteps?: ProcessStep[];
}

export interface FinishWorkflowOptions {
  messageId: string;
  chatId?: string;
  profile?: string;
  /** 终态：completed / failed / stopped */
  status: Extract<WorkflowCardStatus, "completed" | "failed" | "stopped">;
  meta?: WorkflowMeta;
  totalNodes?: number;
  completedNodes?: number;
  progress?: number;
  durationMs?: number;
  error?: string;
  /** 终态补充说明（会作为最后一条里程碑 append） */
  finalStep?: string;
}

// ========================================================================
// 格式化 helpers（导出便于单测）
// ========================================================================

/**
 * 格式化 ISO 8601 时间戳为人类可读的 HH:mm:ss（北京时间 UTC+8）
 *
 * cross-validation ⚠️ #5 修复：原实现直接显示 ISO 8601 字符串（如 "2026-10-15T01:42:05.000Z"）
 * 对用户不友好。改为显示 HH:mm:ss（中国用户视角，北京时间）。
 *
 * @param iso ISO 8601 字符串；无效输入返回原值（保持向后兼容）
 */
export function formatTimestampForDisplay(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    // 不是合法 ISO 8601 → 原样返回（让 caller 自己处理）
    return iso;
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * 把多行/带 markdown 标记的长文本压成**单行可读文本**（用于卡片里的行内栏位）
 *
 * 背景（实测问题）：agent 写的 task.description / milestoneDescription 常含
 * `## 标题`、`- 列表`、换行 —— 直接塞进卡片的一个 bullet 会把卡片结构撑坏
 * （标题级别会被飞书渲染成大标题，列表项和下一行黏在一起）。
 *
 * 处理：标题标记去掉、列表项转 "·"、换行转 " · "、压缩空白、超长截断。
 * 路径 / 命令 / 中文正文不受影响。
 */
export function sanitizeInlineText(text: string, maxLen = 300): string {
  if (!text) return "";
  const flat = text
    .replace(/\r\n?/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    // Task #5096 —— markdown 图片语法 `![alt](url)` 的 url（尤其 `@./file.png`
    // 这类本地引用）会被飞书卡片当成 image key → 230099 拒收整卡。
    // 有 alt 时保留 alt 作为可读占位，否则统一替换为 [图片]。
    // 链接语法 `[text](url)` 是合法超链接，不在此处理。
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
      alt.trim() ? `${alt.trim()}[图片]` : "[图片]"
    )
    .replace(/^\s*[-*+]\s+/gm, "· ")
    .replace(/^\s*\d+\.\s+/gm, "· ")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n+/g, " · ")
    .replace(/\s{2,}/g, " ")
    // 把连续分隔符压成一个（"标题 · · 第一项" → "标题 · 第一项"）
    .replace(/(?:\s*·\s*){2,}/g, " · ")
    .replace(/^(\s*·\s*)+/, "")
    .replace(/(\s*·\s*)+$/, "")
    .trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…`;
}

/**
 * 卡片 head 标题的**视觉宽度预算**（Task #4984）
 *
 * 飞书卡片 header.title 是单行 plain_text，超长会被截断/挤压布局。
 * 这里用「视觉宽度」而非字符数做预算：CJK 占 2 列、ASCII 占 1 列。
 */
export const HEAD_TITLE_MAX_WIDTH = 40;

/**
 * 判定一个 code point 是否是「宽字符」（占 2 个显示列）
 *
 * 覆盖范围（Task #4984）：
 * - CJK 统一表意文字 / 扩展 A / 兼容表意文字
 * - 日文假名、韩文谚文音节
 * - CJK 标点、全角标点、全角 ASCII
 * - 常见 emoji（属宽字符，虽然代理对本身只算 1 个 code point）
 */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 + 标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名 / CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji 区
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  );
}

/** 单个 code point 的视觉宽度（宽字符 2，其余 1） */
function charWidth(cp: number): number {
  return isWideChar(cp) ? 2 : 1;
}

/**
 * 判定一个字符是否是「标题分隔符」（可在其后安全断行）
 *
 * 覆盖空格类 + 中英文连接符类（+ = | ， ： 等）——
 * 避免出现 "relabel +…" 这种看起来被腰斩的尾巴。
 */
function isTitleSeparator(ch: string): boolean {
  return (
    ch === " " ||
    ch === "·" ||
    ch === "-" ||
    ch === "_" ||
    ch === "/" ||
    ch === "、" ||
    ch === "+" ||
    ch === "=" ||
    ch === "|" ||
    ch === "｜" ||
    ch === "," ||
    ch === "，" ||
    ch === ":" ||
    ch === "："
  );
}

/**
 * 截断卡片 head 用的任务名称（Task #4984）
 *
 * 策略（按用户诉求「head 要有任务名称，但别撑破布局」）：
 * 1. 先把多行压成单行（head 是单行 plain_text）
 * 2. **视觉宽度**预算：CJK 记 2 列、ASCII 记 1 列
 * 3. 不切半个 emoji —— 按 code point 遍历，代理对整体保留
 * 4. 不切半个英文单词 —— 尽量在空格/分隔符处断开
 * 5. 超长时补 "…" 后缀
 *
 * @param text 原始标题
 * @param maxWidth 视觉宽度预算（默认 {@link HEAD_TITLE_MAX_WIDTH}）
 */
export function truncateHeadTitle(
  text: string | undefined | null,
  maxWidth: number = HEAD_TITLE_MAX_WIDTH
): string {
  if (!text) return "";
  // 单行化：换行/多空白压成单个空格
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return flat;

  const points = Array.from(flat); // 按 code point 切（emoji 完整）
  // 「…」后缀占 1 宽度预算（它本身是窄字符）
  const budget = Math.max(1, maxWidth - 1);
  let width = 0;
  let endIndex = points.length; // 截断点（exclusive）
  for (let i = 0; i < points.length; i++) {
    const w = charWidth(points[i].codePointAt(0)!);
    if (width + w > budget) {
      endIndex = i;
      break;
    }
    width += w;
  }

  if (endIndex >= points.length) return flat; // 没超预算

  // ---- 截断点选择 --------------------------------------------------
  // 优先在**词边界**断开（不切半个英文单词）；找不到就用硬切点。
  let cut = endIndex;
  let cutAtBoundary = false;
  const minCut = Math.max(0, endIndex - 12);
  for (let i = endIndex - 1; i >= minCut; i--) {
    if (isTitleSeparator(points[i])) {
      cut = i;
      cutAtBoundary = true;
      break;
    }
  }

  // 回退后如果剩余内容太短（< 预算一半），宁可不回退（保留更多有效信息）
  let cutWidth = 0;
  for (let i = 0; i < cut; i++) cutWidth += charWidth(points[i].codePointAt(0)!);
  if (cutAtBoundary && cutWidth < budget / 2) {
    cut = endIndex;
    cutAtBoundary = false;
  }

  let sliced = points.slice(0, cut).join("").trimEnd();

  // ---- 尾部清理 ----------------------------------------------------
  // 1) 剥掉保留段尾部的连接符（"relabel +" 的 "+" 落在切点前一位），
  //    否则渲染成 "relabel +…"，看起来仍像被腰斩。
  sliced = sliced.replace(/[+=|｜]+$/, "").trimEnd();

  // 2) 硬切到半个英文单词时（如 "clea"），退到该词的起点。
  //    ⚠️ 必须**显式**找词起点，不能用懒惰正则 `(.*?)` ——
  //    懒惰量词会把最后一个完整词也吃掉（"清洗状态捷径 + relabel"
  //    → "清洗状态捷径 +"，单词丢失）。
  if (!cutAtBoundary) {
    let wordStart = sliced.length;
    for (let i = sliced.length - 1; i >= 0; i--) {
      const ch = sliced[i];
      if (ch === " " || ch === "·" || ch === "-" || ch === "_" || ch === "/") {
        wordStart = i + 1;
        break;
      }
      if (wordStart === sliced.length) wordStart = i;
    }
    // 只有当碎片确实是个**不完整**的英文词时才回退（纯数字/含中日韩字符时不动）
    const fragment = sliced.slice(wordStart);
    if (
      fragment.length > 0 &&
      /^[A-Za-z]+$/.test(fragment) &&
      wordStart > 0
    ) {
      sliced = sliced.slice(0, wordStart).trimEnd();
    }
  }

  return sliced + "…";
}

/** ISO 8601 时间串 → 北京时间 "YYYY-MM-DD HH:mm"（非 ISO 时原样返回） */
export function formatDateTimeForDisplay(value: string): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** 是否是 ISO 8601 日期时间串（用于 context 里的 created_at 之类） */
function looksLikeIsoDateTime(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);
}

/**
 * 渲染进度条（用户验收样式：▓ 填充 + ░ 空白 + 百分比）
 *
 * @param progress 0-100
 */
export function renderProgressBar(progress: number): string {
  const clamped = Math.max(0, Math.min(100, progress));
  const filled = Math.round((clamped / 100) * PROGRESS_BAR_CELLS);
  const bar = "▓".repeat(filled) + "░".repeat(PROGRESS_BAR_CELLS - filled);
  return `${bar} ${Math.round(clamped)}%`;
}

/**
 * 解析任务标题显示文本（cross-validation ⚠️ #4 修复）
 *
 * 优先级：
 * 1. opts.taskTitle（caller 明确提供）→ 原样使用
 * 2. opts.taskId + opts.title → "#<taskId> <title>"
 * 3. opts.taskId 单独 → "#<taskId>"
 * 4. 兜底 → "Task"（绝不暴露 chatId）
 */
export function resolveTaskTitleForDisplay(opts: {
  taskTitle?: string;
  taskId?: number | string;
  title?: string;
}): string {
  if (opts.taskTitle && opts.taskTitle.trim().length > 0) {
    return opts.taskTitle;
  }
  if (opts.taskId !== undefined && opts.title) {
    return `#${opts.taskId} ${opts.title}`;
  }
  if (opts.taskId !== undefined) {
    return `#${opts.taskId}`;
  }
  return "Task";
}

/**
 * 任务定位信息行（Task #2325 保留：项目 / worktree / 前序上下文）
 *
 * 旧实现把这些信息渲染在普通文本通知里；卡片化后放进卡片顶部一行，
 * 保证"飞书里一眼看出任务归属哪个项目 / 哪个 worktree / 关联哪个前序任务"。
 */
/**
 * 把任意值渲染成**人类可读文本**（绝不输出 JSON 原文）
 *
 * - string / number / boolean → 原样（超长截断）
 * - array  → 逐项 humanize 后用 "、" 连接
 * - object → 逐字段 "key: value" 用 " · " 连接（递归一层）
 *
 * ★ 用户要求：卡片里不要出现 JSON。
 */
export function humanizeValue(value: unknown, maxLen = 200): string {
  const truncate = (t: string): string =>
    t.length <= maxLen ? t : `${t.slice(0, maxLen)}…`;

  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    if (looksLikeIsoDateTime(value)) return formatDateTimeForDisplay(value);
    return truncate(sanitizeInlineText(value, maxLen));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return truncate(
      value
        .map((v) => humanizeValue(v, 80))
        .filter((t) => t.length > 0)
        .join("、")
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        const rendered = humanizeValue(v, 80);
        return rendered ? `${k}: ${rendered}` : "";
      })
      .filter((t) => t.length > 0);
    return truncate(entries.join(" · "));
  }
  return "";
}

/** context 里已知字段 → 人类可读标签（顶栏展示，其余字段按原 key 渲染） */
const CONTEXT_LABELS: Record<string, string> = {
  worktree_path: "🌿 Worktree",
  branch: "🌿 分支",
  created_at: "🕐 创建时间",
  prior_context: "📜 背景",
  project_path: "📂 项目",
  type: "🏷️ 类型",
  feature: "🏷️ 特性",
  goal: "🎯 目标",
  feishu_chat_id: "💬 飞书群",
  trigger_message_id: "✉️ 触发消息",
  trigger_sender_id: "👤 触发人",
  related_task: "🔗 关联任务",
  repo: "📦 仓库",
  commit: "🔖 Commit",
  session_id: "🧵 Session",
  worktree: "🌿 Worktree",
  larkPerTaskChatId: "🗂️ 任务群聊",
  larkPerTaskChatProfile: "🗂️ 群聊 Profile",
};

/** context 内部字段（纯机器用途，渲染出来只会干扰阅读 → 跳过） */
const CONTEXT_SKIP_KEYS = new Set([
  "larkPerTaskChatTaskId",
  "larkPerTaskChatCreatedAt",
]);

/**
 * 判断"执行动态"折叠面板在初始状态下是否**展开**
 *
 * ★ Task #4845：运行中默认折叠（避免刷屏），真终态自动展开
 *   —— 用户在任务结束时最关心的就是「最后做了什么」，
 *   不该还要再点一次折叠面板才能看到。
 *
 * ★ xval MINOR-2：`stopped`（= task.status=paused）**不展开**。
 *   paused 是可 resume 的高频非终态（max-iteration reminder / 用户 stop
 *   都会走 pauseTask），展开反而正是用户抱怨的"刷屏"场景。
 *   这里与仓库自身终态集合（lark-cli-task-notify-plugin.isTerminalTaskStatus）
 *   保持一致：completed / failed / cancelled / deleted 才算"收尾"。
 */
export function isTerminalStatusForTimeline(status: CardStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "deleted"
  );
}

/**
 * 判断 **workflow** 卡片的"执行动态"面板是否展开
 *
 * ★ xval MINOR-2：workflow 的 "stopped" 是**真终态**（run 结束 → 卡片 unpin、
 *   状态清除、不会 resume），与 task 侧 "stopped"（= paused，可 resume）语义相反。
 *   所以 workflow 不能复用 task 的判定：workflow 只要不是 running 就展开。
 */
export function isTerminalStatusForWorkflowTimeline(
  status: WorkflowCardStatus
): boolean {
  return status !== "running";
}

/**
 * 往 elements 追加一条分割线，但**跳过与上一个元素重复的 hr**
 *
 * ★ xval MINOR-1：空时间线时「详情面板后的 hr」与「进度前的 hr」会紧挨着，
 *   飞书渲染成两条分割线（视觉噪音）。这里统一在 append 边界做去重。
 */
function appendHr(elements: Array<Record<string, any>>): void {
  if (elements.length > 0 && elements[elements.length - 1].tag === "hr") return;
  elements.push({ tag: "hr" });
}

/**
 * 构造飞书卡片 2.0 的**折叠面板**（collapsible_panel）
 *
 * ★ Task #4845：用户反馈「这些是不是可以默认折叠起来，比较干扰阅读」
 *   —— 群里「📊 Task 实时更新」卡片满屏任务元信息 + 里程碑时间线，干扰群聊阅读。
 *
 * 飞书卡片 2.0 **原生**支持折叠面板（官方文档：
 *   open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel
 *   ），关键契约：
 *   - `tag: "collapsible_panel"`
 *   - `header.title.content` = 面板标题（折叠时唯一可见的文字）
 *   - `elements` = 面板内的子组件数组（markdown / hr / …）
 *   - `expanded` = 是否展开，**默认 false**（默认折叠）
 *
 * @param title   面板标题（折叠状态下用户看到的唯一文字）
 * @param elements 面板内子组件
 * @param expanded 是否默认展开（默认 false = 折叠）
 * @param elementId 面板唯一 id（JSON 2.0；同一张卡片内全局唯一）
 */
export function buildCollapsiblePanel(opts: {
  title: string;
  elements: Array<Record<string, any>>;
  expanded?: boolean;
  elementId?: string;
}): Record<string, any> {
  const panel: Record<string, any> = {
    tag: "collapsible_panel",
    expanded: opts.expanded ?? false,
    header: {
      title: {
        tag: "markdown",
        content: sanitizeInlineText(opts.title, 120),
      },
    },
    elements: opts.elements,
  };
  if (opts.elementId) panel.element_id = opts.elementId;
  return panel;
}

/**
 * 渲染"任务栏位"区块（用户验收要求的第一块）
 *
 * 顺序：任务 ID → 标题 → 描述 → 目标 → 父任务 → 优先级/类型 → 状态 → context 展开
 *
 * ★ context 是 task.context 的 JSON 字符串，这里会被**展开成可读 bullet**
 *   （已知字段用友好标签，未知字段用原 key），绝不直接输出 JSON。
 */
export function renderTaskInfoLines(meta: TaskMeta): string[] {
  const lines: string[] = [];

  if (meta.id !== undefined) lines.push(`- **🆔 任务 ID**：#${meta.id}`);
  if (meta.title) {
    lines.push(`- **📌 标题**：${sanitizeInlineText(meta.title, 120)}`);
  }
  if (meta.description) {
    lines.push(`- **📝 描述**：${sanitizeInlineText(meta.description, 300)}`);
  }
  if (meta.goals) {
    lines.push(`- **🎯 目标**：${sanitizeInlineText(meta.goals, 300)}`);
  }
  if (meta.parentTaskId) lines.push(`- **🔗 父任务**：#${meta.parentTaskId}`);
  if (meta.priority || meta.type) {
    lines.push(
      `- **⚡ 优先级 / 类型**：${meta.priority ?? "—"} / ${meta.type ?? "—"}`
    );
  }
  if (meta.currentStatus) {
    lines.push(`- **📶 当前状态**：${sanitizeInlineText(meta.currentStatus, 200)}`);
  }

  const project = realValue(meta.projectPath);
  if (project) lines.push(`- **📂 项目**：\`${sanitizeInlineText(project, 160)}\``);

  // context 展开（不输出 JSON）
  const contextLines = renderContextAsLines(meta.context);
  lines.push(...contextLines);

  return lines;
}

/** 过滤 "unknown" / 空值（task 未设置时 DB 里可能是字符串 "unknown"） */
function realValue(v?: string): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (t.length === 0 || t === "unknown" || t === "undefined" || t === "null") {
    return undefined;
  }
  return t;
}

/**
 * task.context(JSON 字符串) → 可读 bullet 行
 *
 * 坏 JSON / 非对象 → 返回空数组（渲染时安全跳过，不崩、不输出 JSON）。
 */
export function renderContextAsLines(context?: string): string[] {
  const raw = realValue(context);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const obj = parsed as Record<string, unknown>;
  const lines: string[] = [];

  // 已知字段优先（友好标签），未知字段排后面（原 key）
  const knownKeys = Object.keys(obj).filter(
    (k) => CONTEXT_LABELS[k] && !CONTEXT_SKIP_KEYS.has(k)
  );
  const otherKeys = Object.keys(obj).filter(
    (k) => !CONTEXT_LABELS[k] && !CONTEXT_SKIP_KEYS.has(k)
  );

  for (const k of knownKeys) {
    const rendered = humanizeValue(obj[k], 160);
    if (rendered) lines.push(`- **${CONTEXT_LABELS[k]}**：${rendered}`);
  }
  for (const k of otherKeys) {
    const rendered = humanizeValue(obj[k], 160);
    if (rendered) lines.push(`- **${k}**：${rendered}`);
  }

  return lines;
}

/**
 * 渲染里程碑序列（可变化）
 *
 * 样式：`- **HH:mm:ss** <title>` + 可选缩进说明行（markdown 列表，飞书渲染稳定）
 */
export function renderMilestones(milestones: Milestone[]): string {
  if (milestones.length === 0) {
    return "_（暂无里程碑）_";
  }
  return milestones
    .map((m) => {
      const ts = formatTimestampForDisplay(m.timestamp) || "—";
      const head = `- **${ts}** ${sanitizeInlineText(m.title, 120)}`;
      return m.description
        ? `${head}\n  - ${sanitizeInlineText(m.description, 300)}`
        : head;
    })
    .join("\n");
}

/**
 * 渲染过程信息 list（可变化）
 *
 * 样式：`- **HH:mm:ss → 现在** <title>` + 可选缩进说明行
 */
export function renderProcessSteps(steps: ProcessStep[]): string {
  if (steps.length === 0) {
    return "_（暂无过程记录）_";
  }
  return steps
    .map((s) => {
      const startTime = formatTimestampForDisplay(s.timestamp);
      const endTime = formatTimestampForDisplay(s.endTimestamp) || "现在";
      const range = startTime ? `${startTime} → ${endTime}` : endTime;
      const title = s.category ? `${s.title}（${s.category}）` : s.title;
      const head = `- **${range}** ${sanitizeInlineText(title, 120)}`;
      return s.description
        ? `${head}\n  - ${sanitizeInlineText(s.description, 300)}`
        : head;
    })
    .join("\n");
}

/**
 * ★ Task #5580 —— session 卡「任务列表」最多展示几个（用户定稿：最近 5 个）。
 *
 * 用户需求（2026-11-13）：一个 sub session 会被复用跑很多 task，卡片要能
 * 「罗列最近 5 个 + 展示任务总数」，再多就靠总数提示（不刷屏）。
 */
export const SESSION_TASK_LIST_MAX = 5;

/**
 * ★ Task #5580 —— 渲染 session 卡「任务列表」面板内容。
 *
 * ## 规则（用户定稿）
 * - `tasks` 按**最近优先**传入（新 → 旧），渲染层取前 `SESSION_TASK_LIST_MAX` 个
 *   —— 「最近 5 个」是渲染契约，调用方不必自己截断（少一处漂移点）。
 * - 超过 5 个 → 标题/首行给总数提示「共 N 个任务，最近 5 个：」
 * - 每个条目一个 `select_task` 按钮（点击 → 执行动态 / 任务里程碑切到该任务）
 *
 * @returns `{ title, elements }`，由调用方包进 collapsible_panel（`session_task_list`）
 */
export function renderSessionTaskList(
  sessionId: string,
  tasks: SessionCardTaskSummary[],
  taskTotal?: number,
): { title: string; elements: Array<Record<string, any>> } {
  const known = tasks.length;
  const total =
    typeof taskTotal === "number" && taskTotal > known ? taskTotal : known;
  const truncated = total > SESSION_TASK_LIST_MAX;
  // ★ CV P12：**排序收敛到渲染层** —— 5 条透传路径（start/update/
  //   applySessionGroupChange/applyTaskEvent/refresh）任一漏排都会让
  //   「最近 5 个」说谎且无报错。这里显式按 id 降序（新任务 id 更大，
  //   与装配点的 updatedAt 降序在主序上一致），再取前 N。
  //   ⚠️ 装配点仍按 updatedAt 排（更准），这里只是**兜底**保证单调性。
  const recentFirst = [...tasks].sort((a, b) => b.id - a.id);
  const ordered = recentFirst.slice(0, SESSION_TASK_LIST_MAX);

  const title = truncated
    ? `📋 任务列表（共 ${total} 个任务，最近 ${SESSION_TASK_LIST_MAX} 个）`
    : `📋 任务列表（${total}）`;

  const elements: Array<Record<string, any>> = [];
  if (truncated) {
    elements.push({
      tag: "markdown",
      content: `**共 ${total} 个任务，最近 ${SESSION_TASK_LIST_MAX} 个：**`,
    });
  }
  for (const t of ordered) {
    const label = t.title ? `#${t.id} ${t.title}` : `#${t.id}`;
    elements.push({
      tag: "button",
      text: {
        tag: "plain_text",
        content: `▶ ${sanitizeInlineText(label, 40)}`,
      },
      // 导航型操作，视觉上不抢建群按钮的重心
      type: "default",
      value: {
        action: "select_task",
        sessionId,
        taskId: String(t.id),
      },
    });
    const meta: string[] = [];
    if (t.status) meta.push(`🚦 ${sanitizeInlineText(t.status, 20)}`);
    if (typeof t.progress === "number") meta.push(`📊 ${Math.round(t.progress)}%`);
    if (meta.length > 0) {
      elements.push({ tag: "markdown", content: `　　${meta.join(" · ")}` });
    }
  }
  return { title, elements };
}

/** 单条里程碑渲染（用于去重比较） */
function milestoneKey(m: Milestone): string {
  return `${m.title}|${m.timestamp ?? ""}|${m.description ?? ""}`;
}

/**
 * 单条过程步骤渲染（用于去重比较）
 *
 * ★ Task #4889：key 必须能区分**同名但不同次**的步骤。
 *
 * 旧 key = `title|timestamp|endTimestamp|description` —— 不含 category，
 * 也不含来源。于是插件侧「同一个工具连调两次」会撞成同一个 key，
 * `mergeUnique` 把第二条**静默吞掉**，卡片上少一条动作。
 *
 * 新规则：
 *   - 有 `id` → 按 id 去重（生产方保证 id 唯一：工具调用序号等）
 *   - 无 `id` → 内容 key（补上 category + source，避免跨语义误撞）
 */
function processStepKey(s: ProcessStep): string {
  if (s.id) return `id:${s.id}`;
  return [
    s.title,
    s.timestamp ?? "",
    s.endTimestamp ?? "",
    s.description ?? "",
    s.category ?? "",
    s.source ?? "",
  ].join("|");
}

/**
 * ★ Task #4889 —— 按语义来源把过程步骤分成两组。
 *
 * - `operations` —— 真正的 task operation 记录（缺省 source 也归这里）
 * - `toolTraces` —— 工具调用轨迹
 *
 * 分区是**呈现层**的职责：语义（这条到底是不是一条操作记录）在生产方决定，
 * core 只负责不把两者混在一个区块里。
 */
export function partitionProcessSteps(steps: ProcessStep[]): {
  operations: ProcessStep[];
  toolTraces: ProcessStep[];
} {
  const operations: ProcessStep[] = [];
  const toolTraces: ProcessStep[] = [];
  for (const s of steps) {
    if (s.source === "tool-trace") toolTraces.push(s);
    else operations.push(s);
  }
  return { operations, toolTraces };
}

// ========================================================================
// Card Builder
// ========================================================================

/**
 * ★ Task #4889 —— 构造「执行动态」面板的元素（里程碑 / 操作记录 / 执行轨迹）。
 *
 * ## 为什么分区（用户反馈的根因）
 *
 * 旧实现把**两种语义**混装进一个「🔧 过程信息」区块：
 *   - 真正的 task operation 记录（title 是人写的里程碑标题）
 *   - 工具调用轨迹（title 是「执行命令」「记录进展」这类动作名）
 *
 * 底部又统一计「N 个过程」，于是用户读到的是「**每个工具调用都记了一条
 * 操作记录**」—— 而实际上那些只是工具轨迹。**这是呈现误导，不是语义错误。**
 *
 * 所以这里按 `source` 分区：
 *   - `📝 操作记录` —— 真正的 operation 记录
 *   - `🔧 执行轨迹（工具调用）` —— 工具调用轨迹
 *
 * 两区都非空才渲染对应区块；计数各自独立，绝不混成一个「N 个过程」。
 */
function buildTimelineElements(
  milestones: Milestone[],
  processSteps: ProcessStep[]
): {
  elements: Array<Record<string, any>>;
  opCount: number;
  toolCount: number;
} {
  const elements: Array<Record<string, any>> = [];
  const { operations, toolTraces } = partitionProcessSteps(processSteps);

  if (milestones.length > 0) {
    elements.push({ tag: "markdown", content: `## 🎯 里程碑序列` });
    elements.push({ tag: "markdown", content: renderMilestones(milestones) });
  }

  if (operations.length > 0) {
    if (elements.length > 0) elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `## 📝 操作记录` });
    elements.push({ tag: "markdown", content: renderProcessSteps(operations) });
  }

  if (toolTraces.length > 0) {
    if (elements.length > 0) elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: `## 🔧 执行轨迹（工具调用）`,
    });
    elements.push({
      tag: "markdown",
      content: renderProcessSteps(toolTraces),
    });
  }

  return {
    elements,
    opCount: operations.length,
    toolCount: toolTraces.length,
  };
}

/**
 * ★ Task #4889 —— 「执行动态」面板标题：里程碑 / 操作记录 / 执行轨迹 各自分区计数。
 *
 * 旧标题 `⏱️ 执行动态（N 里程碑 / M 过程）` 把两种语义合并成一个「M 过程」，
 * 用户读起来就是「M 条操作记录」。现在分区计数，语义边界在 UI 上说清楚。
 */
function buildTimelinePanelTitle(
  milestoneCount: number,
  opCount: number,
  toolCount: number
): string {
  const parts: string[] = [];
  if (milestoneCount > 0) parts.push(`${milestoneCount} 里程碑`);
  if (opCount > 0) parts.push(`${opCount} 操作记录`);
  if (toolCount > 0) parts.push(`${toolCount} 工具调用`);
  return `⏱️ 执行动态${parts.length > 0 ? `（${parts.join(" / ")}）` : ""}`;
}

/**
 * 构造 card JSON payload（Card 2.0 schema，用户验收样式 Task #4230 v2）
 *
 * 布局（严格按用户指定顺序）：
 * 1. header.title = 📊 Task 实时更新；header.subtitle = spinner + 状态 + 更新次数
 * 2. **任务栏位**：任务 ID / 标题 / 描述 / 目标 / 父任务 / 优先级·类型 / context（展开为 bullet）
 * 3. **里程碑序列**（可变化）
 * 4. **过程信息 list**（可变化）
 * 5. **progress 百分比**（最后一块）
 *
 * ★ 所有内容都是 markdown 可渲染文本，不出现 JSON 原文。
 */
export function buildTaskCard(opts: {
  status: CardStatus;
  meta: TaskMeta;
  milestones?: Milestone[];
  processSteps?: ProcessStep[];
  progress?: number;
  updateCount?: number;
  spinner?: string;
  /**
   * 是否展开"执行动态"折叠面板（覆盖按 status 推导的默认值）
   *
   * ★ xval MINOR-2：task.status=paused 与 archived 都映射成 CardStatus
   *   "stopped"，但语义不同：
   *   - paused  = 可 resume 的**非终态** → 时间线保持折叠（避免刷屏）
   *   - archived = **终态**（归档后不再有进展）→ 时间线应展开
   *   卡片状态本身无法区分二者，所以由调用方（知道原始 task.status 的那层）
   *   显式传 true/false 覆盖。
   *
   * 不传 → 按 status 推导（completed/failed/cancelled/deleted 展开，
   * running/stopped 折叠）。
   */
  expandTimeline?: boolean;
  /**
   * ★ Task #5360：sub-session 活性快照（用户点「🔄 刷新活性」后才有）
   *
   * ## 为什么是 `undefined` / `null` 三态
   *
   * - `undefined` —— 调用方**没查过**活性（首次发卡 / 普通 patch）：
   *   整个活性面板**不渲染**，卡片与改造前逐字节一致（零回归风险）。
   * - 非 undefined（含 `null`）—— 调用方**查过了**：
   *   渲染 `⚡ 子会话活性` 面板；`null` 表示"查了但没数据"，渲染「暂无数据」。
   *
   * 这样区分很重要：用户点刷新后如果什么都没有，"面板消失"会让人以为
   * 按钮没生效；"面板在但写暂无数据"才是诚实的反馈。
   */
  activity?: SubSessionActivity | null;
  /** ★ Task #5360：活性面板的时间基准（注入便于测试；缺省 `Date.now()`） */
  activityNow?: number;
  /** ★ Task #5360：任务是否已终态（决定活性档位报「已结束」而非「疑似停滞」） */
  activityTerminal?: boolean;
}): CardPayload {
  const status = opts.status ?? "running";
  const milestones = opts.milestones ?? [];
  const processSteps = opts.processSteps ?? [];
  const updateCount = opts.updateCount ?? 0;
  const spinner = opts.spinner ?? "";

  const elements: Array<Record<string, any>> = [];

  // ---- 1. 顶部按钮（Task #4331：动态建/解散专属群） ----
  //   - 无群 → button: "为这个任务建群"（type=primary）
  //   - 有群 → button: "解散该群"（type=danger）
  //   - value.action 标识操作类型，value.taskId 传给 callback handler
  const hasGroup = !!(opts.meta.perTaskChatId && opts.meta.perTaskChatId.length > 0);
  const taskIdForButton = opts.meta.id !== undefined ? String(opts.meta.id) : "";
  // ★ CV BLOCKER-1：task 卡也要带 sessionId（卡片主键是 session）
  const sessionIdForButton =
    typeof opts.meta.sessionId === "string" && opts.meta.sessionId.trim()
      ? opts.meta.sessionId
      : undefined;
  elements.push({
    tag: "button",
    text: {
      tag: "plain_text",
      content: hasGroup ? "解散该群" : "为这个任务建群",
    },
    type: hasGroup ? "danger" : "primary",
    value: {
      action: hasGroup ? "disband_group" : "create_group",
      taskId: taskIdForButton,
      // ★ Task #5390（CV R1 MAJOR-1）：建群按钮**也必须**带 sessionId。
      //
      //   否则用户点 task 卡的「为这个任务建群」时 event.actionValue.sessionId
      //   是 undefined，建群后要链到哪个 sub-session 就只能靠
      //   `resolveSessionIdByTask` 反查（内存 Map + 持久层兜底）——
      //   比"卡片自带 sessionId"脆弱一档，且 #5369 的 bug 正是因为
      //   target 取不到而静默 no-op。
      //
      //   与下方「🔄 刷新活性」按钮同源（sessionIdForButton），
      //   缺失时不写该键（handler 仍有 context / 反查兜底）。
      ...(sessionIdForButton ? { sessionId: sessionIdForButton } : {}),
    },
  });

  // ---- 1.2 刷新活性按钮（★ Task #5360） ----
  //
  // 用户诉求：「卡片新增「刷新」按钮（类似企微卡片的刷新按钮）：按下后展示该
  //   任务对应 subsession 的消息数 + 最近一条 msg（截断）——用来判断有无 LLM 推进」
  //
  // 设计要点：
  // - **独立按钮**，不动上面那个建群/解散群按钮（旧行为零变更）
  // - 位置紧跟其后（`elements[1]`）：旧测试断言 `elements[0]` 是群按钮仍成立
  // - 无 taskId 时不渲染（点下去也查不到东西，纯噪音）
  // - type=default（灰）而非 primary：这是辅助信息，不该抢群操作的视觉重心
  if (taskIdForButton) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "💬 会话查看" }, // ★ Task #5420：文案改名（action 名 refresh_activity 不动，存量卡兼容）
      type: "default",
      value: {
        action: "refresh_activity",
        taskId: taskIdForButton,
        // ★ CV BLOCKER-1 修复：refresh 一律走 session 主键路径（澄清 22:37），
        //   所以 task 卡**必须**把 sessionId 一并放进按钮 value ——
        //   否则用户点「🔄 刷新活性」会被 `pickCardSubject` 以
        //   「sessionId is required」直接拒绝（老 task 卡全废）。
        //
        //   sessionId 来源见下方 meta 说明；缺失时不写该键，
        //   handler 会走 task 兜底路径（见 handleRefreshActivityByTask）。
        ...(sessionIdForButton ? { sessionId: sessionIdForButton } : {}),
      },
    });
  }

  // ---- 1.5 下方链接（Task #4331：仅在有群时显示"进入群"） ----
  if (hasGroup) {
    const link = buildChatAppLink(opts.meta.perTaskChatId!);
    const label = opts.meta.perTaskChatName
      ? `📨 进入专属群：${sanitizeInlineText(opts.meta.perTaskChatName, 60)}`
      : "📨 进入专属群";
    elements.push({
      tag: "markdown",
      content: `[${label}](${link})`,
    });
    appendHr(elements);
  }

  // ---- 2. 任务栏位（★ Task #4845：收进默认折叠的「任务详情」面板） ----
  //   用户反馈「卡片信息量过大、干扰群聊阅读」→ 元信息默认收起，
  //   折叠状态下只留面板标题（一眼知道有详情），点开才看全文。
  const infoLines = renderTaskInfoLines(opts.meta);
  if (infoLines.length > 0) {
    elements.push(
      buildCollapsiblePanel({
        title: "📋 任务详情",
        elementId: "task_detail",
        elements: [{ tag: "markdown", content: infoLines.join("\n") }],
      })
    );
    appendHr(elements);
  }

  // ---- 2.5 子会话活性（★ Task #5360，用户点「🔄 刷新活性」后出现） ----
  //
  // 用户诉求：「按下后展示该任务对应 subsession 的消息数 + 最近一条 msg（截断）
  //   —— 用来判断有无 LLM 推进」
  //
  // 位置：`任务详情` 之后、`执行动态` 之前。
  // 信息层级 = 静态元信息 → 实时活性 → 历史时间线，符合"从概况到细节"。
  //
  // 三态语义（见 activity 入参注释）：
  //   undefined → 不渲染（普通 patch，零回归）
  //   null      → 渲染面板 + 「暂无数据」
  //   快照      → 渲染面板 + 3 行活性
  if (opts.activity !== undefined) {
    elements.push(
      buildCollapsiblePanel({
        title: "⚡ 子会话活性",
        elementId: "task_activity",
        // 用户刚点按钮要的就是这个 —— 默认展开，别再让多点一次
        expanded: true,
        elements: [
          {
            tag: "markdown",
            content: formatActivityLines(
              opts.activity ?? undefined,
              opts.activityNow ?? Date.now(),
              opts.activityTerminal ?? false,
            ).join("\n"),
          },
        ],
      })
    );
    appendHr(elements);
  }

  // ---- 3. 里程碑序列 + 操作记录 + 执行轨迹（★ Task #4845：收进「执行动态」面板） ----
  //   运行中默认折叠（不刷屏）；终态自动展开（用户不用点开就能看到结果）。
  //   ★ Task #4889：操作记录与工具轨迹**分区**呈现（语义边界在 UI 上说清楚）。
  const timeline = buildTimelineElements(milestones, processSteps);
  if (timeline.elements.length > 0) {
    elements.push(
      buildCollapsiblePanel({
        title: buildTimelinePanelTitle(
          milestones.length,
          timeline.opCount,
          timeline.toolCount
        ),
        elementId: "task_timeline",
        expanded:
          opts.expandTimeline ?? isTerminalStatusForTimeline(status),
        elements: timeline.elements,
      })
    );
  }

  // ---- 5. progress 百分比（最后一块）----
  appendHr(elements);
  const effectiveProgress =
    status === "completed" ? 100 : opts.progress;
  // ★ Task #4540：终态卡片不能再写「进行中」—— 否则同一条卡片里
  //   subtitle 说「🗑️ 已删除」、底部却说「进度：进行中」，自相矛盾。
  //   终态且无进度数字时，直接按状态给一句收尾说明。
  const isTerminalStatus = status !== "running";
  const terminalProgressText =
    status === "deleted"
      ? "任务已取消（删除），记录已归档"
      : status === "cancelled"
        ? "任务已取消"
        : status === "stopped"
          ? "任务已停止（可恢复）"
          : status === "failed"
            ? "任务失败"
            : "任务已完成";
  elements.push({
    tag: "markdown",
    content:
      effectiveProgress !== undefined
        ? `**📊 进度**：${renderProgressBar(effectiveProgress)}`
        : isTerminalStatus
          ? `**📊 进度**：${terminalProgressText}`
          : `**📊 进度**：进行中（第 ${updateCount} 次更新，尚未上报百分比）`,
  });

  // ★ Task #4984：head 区带任务名称 —— 用户反馈「head 不只是 task id，
  //   还需要有任务名称，否则不能很快 get 到这个任务要干啥」。
  //   形态：`#<id> <截断后的任务名称>`（id 在前便于定位，名称在后说明内容）。
  //   无 title 时降级为只有 id（不出现空的括号）。
  const taskIdLabel =
    opts.meta.id !== undefined ? `#${opts.meta.id}` : "任务";
  const taskTitleText = truncateHeadTitle(opts.meta.title);
  // ★ Task #4984 review MINOR-4：无 id + 占位 meta（title="任务"）时，
  //   taskIdLabel 与 taskTitleText 相同 → 「任务 任务」重复。
  //   名称与 id 标签相同（或拼接后重复）时不重复拼接。
  const taskLabel =
    taskTitleText && taskTitleText !== taskIdLabel
      ? `${taskIdLabel} ${taskTitleText}`
      : taskIdLabel;

  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: `📋 任务卡实时更新（${taskLabel}）` },
      subtitle: {
        tag: "plain_text",
        content:
          `spinner: '${spinner}' · 第 ${updateCount} 次更新 | ` +
          STATUS_PHRASE[status],
      },
      template: HEADER_TEMPLATE[status],
    },
    body: { elements },
  };
}

/**
 * ★ Task #5360（补充需求 22:31）—— 构造**无 task**（session-only）的卡片。
 *
 * ## 用户需求
 *
 * > 「有 sub-session 但无 task —— 也要能刷新看 subsession 情况」
 *
 * ## 与 `buildTaskCard` 的关系：**并列而非复用**
 *
 * 为什么不给 `buildTaskCard` 加一堆 `if (无 task)` 分支：
 * - task 卡有「建群/解散群」「任务详情（ID/目标/父任务/优先级）」「进度 %」
 *   —— 这些对 session 全都无意义，硬塞会渲染出一堆 `undefined` 占位
 * - 反过来 session 需要的「会话详情（sessionId / 所属 agent / 起止）」
 *   task 卡没有
 *
 * 所以是**两张卡**，但**共用**同一套零件：
 * `buildCollapsiblePanel` / `appendHr` / `formatActivityLines` /
 * `sanitizeInlineText` / `truncateHeadTitle`
 * —— 活性判定与文案口径因此与 task 卡**逐字一致**（不会出现同一个
 * session 在两张卡里颜色不同）。
 *
 * ## 按钮：刷新活性**始终有**；建群/解散群**仅在有 task 时**渲染
 *
 * - 刷新活性：session 主键，任何 session 卡都有（这是本次改造的核心）
 * - 建群/解散群：绑定在 task 上，无 task 时 `value.taskId` 无从填充 ——
 *   渲染一个点不动的按钮比不渲染更糟，所以有 task 才出。
 */
/** session 卡累计状态（notifier 内部 + patch 复用） */
export interface SessionCardState {
  title?: string;
  statusPhrase?: string;
  agentType?: string;
  startedAt?: string;
  elapsedText?: string;
  milestones: Milestone[];
  updateCount: number;
  lifecycle?: "running" | "completed" | "timeout" | "failed" | "stopped";
  profile?: string;
  sessionId?: string;
  /** ★ CV R5：上次的活性快照（patch 未传时沿用，避免擦掉消息数/最近消息） */
  activity?: SubSessionActivity | null;
  /** ★ Task #5420：上次的最近消息列表（patch 未传时沿用，避免擦面板） */
  recentMessages?: ActivityMessage[] | ToolCallView[];
  /**
   * ★ Task #5580：该 session 的全部 task 摘要（「🗂️ 任务列表」面板）。
   * 与 task / recentMessages 同语义：本次没传就沿用上一次（不擦面板）。
   */
  sessionTasks?: SessionCardTaskSummary[];
  /** ★ Task #5580：任务总数（tasks 被截断到 5 时用于「共 N 个任务」提示） */
  taskTotal?: number;
  /** ★ Task #5580：「📌 任务里程碑」区展示的是哪个任务 */
  selectedTask?: NonNullable<Parameters<typeof buildSessionCard>[0]["selectedTask"]>;
  /** ★ Task #5580：选中任务的里程碑 list */
  selectedTaskMilestones?: Milestone[];
  /**
   * ★ Task #5364 返工（BLOCKER-5）：该 session 内创建的 roy 任务（**可选增强**）。
   *
   * 用户 08:13 定稿第 2 点：「若该会话有任务相关信息 → 把原任务卡的信息渲染在
   * 这张子会话卡上（**合并**，不是并列）」。
   *
   * 上一版只把它当「刷新时的临时入参」传，首卡（startSessionCard）不传 ⇒
   * 生产上 task 卡链路照旧独立发一张，两张并列 —— 直接违背定稿。
   *
   * 现在纳入 state：里程碑式的 task 更新（进度/状态/操作记录）在 patch 时
   * **沿用上一次已知的 task 快照**，不会因为二次事件没带 task 就消失。
   */
  task?: NonNullable<Parameters<typeof buildSessionCard>[0]["task"]>;
  /** task 专属群 chatId（有群时渲染「进入专属群」/「解散该群」） */
  perTaskChatId?: string;
  perTaskChatName?: string;
}

export function buildSessionCard(opts: {
  /** sub-session id（卡片主键） */
  sessionId: string;
  /** 会话标题（自定义 agent 名 / 任务描述）；缺省显示 sessionId 截断 */
  title?: string;
  /** 状态短语（已运行 / 已结束 …）；缺省按 lifecycle 推导 */
  statusPhrase?: string;
  /**
   * ★ 澄清（22:37）：session 层的**生命周期**。
   *
   * 与 task 无关 —— 没建 task 的 sub-session 一样会 完成/超时/被停。
   * 缺省 `running`。
   */
  lifecycle?: "running" | "completed" | "timeout" | "failed" | "stopped";
  /** ★ 澄清（22:37）：task 专属群 chatId（有 task 且已建群时渲染「进入群」） */
  perTaskChatId?: string;
  /**
   * ★ 澄清（22:37）：该 session 内创建的 roy 任务（**可选增强**）。
   *
   * 有 → 卡片多一块「📋 任务信息」面板（taskId / title / 状态 / 进度 /
   * 操作记录），**原有 task 信息一个不少**；
   * 无 → 只显示 session 活性，卡片身份不变。
   */
  task?: {
    id: number;
    title?: string;
    status?: string;
    progress?: number;
    currentStatus?: string;
    /** 操作记录（里程碑形态，渲染成时间线） */
    milestones?: Milestone[];
    /** ★ CV MAJOR-5：其余元信息（用户要求「一个不少」） */
    priority?: string;
    parentTaskId?: number;
    goals?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  /**
   * ★ Task #5580：该 session 内**全部 task** 的摘要 list（最近优先）。
   *
   * 渲染规则（用户 2026-11-13 定稿）：
   * - ≤5 个 → 直接罗列
   * - >5 个 → 只罗列**最近 5 个** + 总数提示（「共 N 个任务，最近 5 个：」）
   * - 每条带 `select_task` 按钮（点击 → 执行动态切换到该任务）
   * - undefined → 不渲染面板（零噪音，与 task 区块同语义）
   */
  tasks?: SessionCardTaskSummary[];
  /** ★ Task #5580：任务总数（tasks 被截断到 5 时用于「共 N 个任务」提示） */
  taskTotal?: number;
  /**
   * ★ Task #5580：当前**选中**的任务（点 select_task 后切换到这里）。
   * undefined → 不渲染「任务里程碑」面板。
   *
   * ★ CV P3（已记录取舍）：**没有 null 清除路径** —— 选中态的生命周期绑定
   *   在任务存续上，任务删除/归档后由刷新把它从 `tasks` 列表里剔除（此时
   *   `selectedTask` 不再出现在任务列表里，用户自然会点别的任务）。
   *   若将来需要"取消选中"，把类型扩成 `| null` 并在 rememberSessionCard
   *   区分 `undefined`（沿用）/ `null`（清除）即可。
   */
  selectedTask?: SessionCardTaskSummary & {
    currentStatus?: string;
    priority?: string;
    parentTaskId?: number;
    goals?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  /**
   * ★ Task #5580：选中任务的里程碑 list（task_operation 的 milestone），
   * 渲染进「任务里程碑」面板，随 select_task 切换。
   */
  selectedTaskMilestones?: Milestone[];
  /** 所属 agent（subagentType），可选 */
  agentType?: string;
  /** 开始时间（ISO） */
  startedAt?: string;
  /** 已运行时长（人类可读，如 "12m"）—— 由调用方算好，避免本模块读时钟 */
  elapsedText?: string;
  /** 最近的活动里程碑（session 没有 task 时间线，用事件级的短列表） */
  milestones?: Milestone[];
  /** ★ 活性快照（与 task 卡同源渲染）。undefined = 不渲染；null = 暂无数据 */
  activity?: SubSessionActivity | null;
  /**
   * ★ Task #5420：最近消息列表（「💬 会话查看」面板）。
   *
   * ⚠️ 返工（2026-11-13 08:21）：面板改为展示**最近 5 条工具调用**
   * （工具名 + reason）。字段名保留 recentMessages（存量状态兼容，
   * state 沿用逻辑不动），但装配点现在装的是 ToolCallView[]。
   *
   * undefined = 不渲染面板（首卡零噪音）；
   * [] = 查了确实没有 → 面板显示「暂无工具调用」（诚实）。
   */
  recentMessages?:
    | ActivityMessage[]
    | import("./sub-session-activity").ToolCallView[];
  activityNow?: number;
  /** 更新计数（spinner 轮换 + "第 N 次更新"） */
  updateCount?: number;
}): CardPayload {
  const sessionId = opts.sessionId;
  const updateCount = opts.updateCount ?? 1;
  const spinner = SPINNER_EMOJIS[updateCount % SPINNER_EMOJIS.length];
  const elements: Array<Record<string, any>> = [];

  // ---- 1. 建群/解散群按钮（★ Task #5397：**无条件**渲染） ----
  //
  // ★★ 用户拍板（2026-11-12 15:35「做「无 task 也能建群」」）：
  //    改造前是 `if (taskIdNum > 0)` 才 push，代码注释自认「建群/解散群绑定在
  //    task 上，session 本身没有群的概念」⇒ **没有 task 的 sub-session 连按钮
  //    都不渲染**。用户明确推翻这条约束：sub-session 自己就该能建群、群里能
  //    读到自己的历史。
  //
  // 现在按「有无 task」分两条语义（能力不退化 + 新能力开出来）：
  //   - 有 task ⇒ 文案「为这个任务建群」，value 带 taskId（task 路径，行为不变）
  //   - 无 task ⇒ 文案「为本会话建群」，value **只有** sessionId（session-only）
  // 两条都由同一个 handler 按 actionValue 有没有 taskId 分发。
  const taskIdNum = opts.task?.id;
  const hasTaskId = typeof taskIdNum === "number" && taskIdNum > 0;
  const hasGroup = !!(opts.perTaskChatId && opts.perTaskChatId.length > 0);
  elements.push({
    tag: "button",
    text: {
      tag: "plain_text",
      content: hasGroup ? "解散该群" : hasTaskId ? "为这个任务建群" : "为本会话建群",
    },
    type: hasGroup ? "danger" : "primary",
    value: {
      action: hasGroup ? "disband_group" : "create_group",
      sessionId,
      // ★ 有 task 才带 taskId —— 它同时是 handler 的路径判据
      //   （有 → task 路径，无 → session-only 路径）。
      ...(hasTaskId ? { taskId: String(taskIdNum) } : {}),
    },
  });

  // ---- 1.5 已有群 ⇒ 渲染「进入群」链接（★ Task #5397，与 task 卡同源）----
  //
  // 无 task 的场景同样要有入口：用户点了「为本会话建群」之后必须能在卡上
  // 点进那个群（而不是只能去飞书聊天列表里翻）。
  if (hasGroup) {
    elements.push({
      tag: "markdown",
      content: `[📨 进入专属群](${buildChatAppLink(opts.perTaskChatId!)})`,
    });
  }

  elements.push({
    tag: "button",
    text: { tag: "plain_text", content: "💬 会话查看" }, // ★ Task #5420：文案改名（action 名 refresh_activity 不动，存量卡兼容）
    // ★ Task #5397：建群/解散群按钮现在恒为 primary（无条件渲染）⇒ 刷新按钮
    //   固定降为 default，视觉重心仍在群操作上（与改造前「有 task」时一致）。
    type: "default",
    value: {
      action: "refresh_activity",
      sessionId,
      // 有 task 时一并带上（刷新时用于回填 task 信息面板）
      ...(hasTaskId ? { taskId: String(taskIdNum) } : {}),
    },
  });

  // ---- 2. 会话详情面板 ----
  const infoLines: string[] = [];
  infoLines.push(`- **🆔 会话 ID**：${sanitizeInlineText(sessionId, 120)}`);
  if (opts.title) infoLines.push(`- **📝 标题**：${sanitizeInlineText(opts.title, 120)}`);
  if (opts.agentType) {
    infoLines.push(`- **🤖 执行 Agent**：${sanitizeInlineText(opts.agentType, 60)}`);
  }
  if (opts.startedAt) {
    infoLines.push(`- **🕐 开始时间**：${formatDateTimeForDisplay(opts.startedAt)}`);
  }
  if (opts.elapsedText) infoLines.push(`- **⏳ 已运行**：${opts.elapsedText}`);
  if (infoLines.length > 0) {
    elements.push(
      buildCollapsiblePanel({
        title: "📋 会话详情",
        elementId: "session_detail",
        elements: [{ tag: "markdown", content: infoLines.join("\n") }],
      }),
    );
    appendHr(elements);
  }

  // ---- 2.5 任务信息面板（★ 澄清 22:37：task 是**可选增强**，有才渲染） ----
  //
  // 用户明令「taskId、title、状态、进度、操作记录等原有信息一个不少」——
  // 所以这里不是简化展示，而是把 task 卡的**全部**关键字段搬过来：
  // ID / 标题 / 状态 / 进度条 / current_status / 优先级 / 父任务 / 目标 /
  // 创建+更新时间 / 操作记录时间线。
  // （建群/解散群按钮由上方按钮区按「有无 task」决定，不属于本面板。）
  const taskInfo = opts.task;
  // ★ CV P2（#5580）：`selectedTask` 就是 2.5 那个 task 时，2.7 会渲染同一份
  // 详情 ⇒ 卡片上出现两块一模一样的「任务信息」（高度翻倍 + 语义重复）。
  // 裁决：**选中态优先**，2.5 让位（selectedTask 是用户主动点出来的最新焦点）。
  const selectedDuplicatesBoundTask =
    taskInfo !== undefined &&
    opts.selectedTask !== undefined &&
    Number(opts.selectedTask.id) === Number(taskInfo.id);
  if (taskInfo && !selectedDuplicatesBoundTask) {
    const taskLines: string[] = [];
    taskLines.push(`- **🆔 任务 ID**：#${taskInfo.id}`);
    if (taskInfo.title) {
      taskLines.push(`- **📌 标题**：${sanitizeInlineText(taskInfo.title, 120)}`);
    }
    if (taskInfo.status) {
      taskLines.push(`- **🚦 状态**：${sanitizeInlineText(taskInfo.status, 40)}`);
    }
    if (typeof taskInfo.progress === "number") {
      taskLines.push(`- **📊 进度**：${renderProgressBar(taskInfo.progress)}`);
    }
    if (taskInfo.currentStatus) {
      taskLines.push(
        `- **📝 当前状态**：${sanitizeInlineText(taskInfo.currentStatus, 200)}`,
      );
    }
    // ★ CV MAJOR-5：用户明令「taskId、title、状态、进度、操作记录等原有信息
    //   一个不少」—— 这里补齐 task 卡的其余元信息字段。
    if (taskInfo.priority) {
      taskLines.push(`- **🔥 优先级**：${sanitizeInlineText(taskInfo.priority, 20)}`);
    }
    if (taskInfo.parentTaskId !== undefined) {
      taskLines.push(`- **🧩 父任务**：#${taskInfo.parentTaskId}`);
    }
    if (taskInfo.goals) {
      taskLines.push(`- **🎯 目标**：${sanitizeInlineText(taskInfo.goals, 200)}`);
    }
    if (taskInfo.createdAt) {
      taskLines.push(`- **🕐 创建时间**：${formatDateTimeForDisplay(taskInfo.createdAt)}`);
    }
    if (taskInfo.updatedAt) {
      taskLines.push(`- **🔄 更新时间**：${formatDateTimeForDisplay(taskInfo.updatedAt)}`);
    }
    elements.push(
      buildCollapsiblePanel({
        title: "📋 任务信息",
        elementId: "task_detail",
        elements: [{ tag: "markdown", content: taskLines.join("\n") }],
      }),
    );
    appendHr(elements);

    // task 的操作记录（时间线）—— 与 task 卡同一套渲染
    if (taskInfo.milestones && taskInfo.milestones.length > 0) {
      elements.push(
        buildCollapsiblePanel({
          title: `📌 操作记录（${taskInfo.milestones.length}）`,
          elementId: "task_timeline",
          expanded: false,
          elements: [
            { tag: "markdown", content: renderMilestones(taskInfo.milestones) },
          ],
        }),
      );
      appendHr(elements);
    }
  }

  // ---- 2.6 ★ Task #5580：任务列表面板（该 session 内所有 task） ----
  //
  // 用户需求（2026-11-13）：roy-bot 现在多次复用一个 sub session，一个
  // session 里有很多 task 生命周期 —— 只显示单个 task 信息不够。改为：
  //   - 罗列该 session 内全部 task（太多则最近 5 个 + 总数）
  //   - 每条一个 `select_task` 按钮，点了执行动态切到该任务
  //
  // 与 2.5 的「任务信息」（单 task 详情区块）**并存**：
  // 2.5 是「当前关注任务」的详情，2.6 是「这个会话干过哪些任务」的索引。
  const taskList = opts.tasks ?? [];
  if (taskList.length > 0) {
    const listResult = renderSessionTaskList(opts.sessionId, taskList, opts.taskTotal);
    elements.push(
      buildCollapsiblePanel({
        title: listResult.title,
        elementId: "session_task_list",
        // 任务列表是「导航」性质，默认展开（用户一眼看到有几个任务）
        expanded: true,
        elements: listResult.elements,
      }),
    );
    appendHr(elements);
  }

  // ---- 2.7 ★ Task #5580：选中任务的详情 + 任务里程碑区 ----
  //
  // 点 `select_task` 后切到这里：「任务详情」给身份，「任务里程碑」给进展。
  // 未选中 → 两个面板都不渲染（首卡零噪音）。
  if (opts.selectedTask) {
    const sel = opts.selectedTask;
    const selLines: string[] = [];
    selLines.push(`- **🆔 任务 ID**：#${sel.id}`);
    if (sel.title) selLines.push(`- **📌 标题**：${sanitizeInlineText(sel.title, 120)}`);
    if (sel.status) selLines.push(`- **🚦 状态**：${sanitizeInlineText(sel.status, 40)}`);
    if (typeof sel.progress === "number") {
      selLines.push(`- **📊 进度**：${renderProgressBar(sel.progress)}`);
    }
    if (sel.currentStatus) {
      selLines.push(`- **📝 当前状态**：${sanitizeInlineText(sel.currentStatus, 200)}`);
    }
    elements.push(
      buildCollapsiblePanel({
        title: "📋 任务信息",
        elementId: "session_selected_task_detail",
        elements: [{ tag: "markdown", content: selLines.join("\n") }],
      }),
    );
    appendHr(elements);

  }

  // ---- 3. 活性面板（与 task 卡**同源**，三态语义也相同） ----
  if (opts.activity !== undefined) {
    elements.push(
      buildCollapsiblePanel({
        title: "⚡ 子会话活性",
        elementId: "task_activity",
        expanded: true,
        elements: [
          {
            tag: "markdown",
            content: formatActivityLines(
              opts.activity ?? undefined,
              opts.activityNow ?? Date.now(),
              // ★ 澄清（22:37）：终态来自 **session 层生命周期**，与有无 task 无关。
              //   旧实现恒传 false ⇒ 超时/完成的 session 也显示 🔴「疑似停滞」。
              isSessionLifecycleTerminal(opts.lifecycle),
            ).join("\n"),
          },
        ],
      }),
    );
    appendHr(elements);
  }

  // ---- 3.5 最近工具调用面板（★ Task #5420「💬 会话查看」，返工版） ----
  //
  // 用户澄清（2026-11-13 08:21）：展示**工具名称 + reason**，非消息摘要。
  // undefined = 不渲染（首卡零噪音）；[] = 诚实显示「暂无工具调用」。
  // 标题只在面板 title 出现一次（修旧版 title + 首行双写）。
  if (opts.recentMessages !== undefined) {
    elements.push(
      buildCollapsiblePanel({
        title: "🔧 最近工具调用",
        elementId: "session_recent_messages",
        expanded: true,
        elements: [
          {
            tag: "markdown",
            content: formatRecentToolCallLines(
              opts.recentMessages as import("./sub-session-activity").ToolCallView[],
            ).join("\n"),
          },
        ],
      }),
    );
    appendHr(elements);
  }

  // ---- 4. 里程碑（session 没有 task 操作记录，只有事件级进展） ----
  const milestones = opts.milestones ?? [];
  if (milestones.length > 0) {
    elements.push(
      buildCollapsiblePanel({
        title: `📌 执行动态（${milestones.length}）`,
        elementId: "session_timeline",
        expanded: false,
        elements: [{ tag: "markdown", content: renderMilestones(milestones) }],
      }),
    );
  }

  // ---- 4.5 ★ Task #5580：任务里程碑区（在「执行动态」**下面**） ----
  //
  // 用户需求（2026-11-13 第 3 点）：「执行动态」下面新增「任务里程碑」区，
  // 展示**该任务**的里程碑 list（task_operation 的 milestone），也随点击任务切换。
  //
  // 与 2.7 的「任务信息」分工：那里是身份/状态，这里是**进展时间线**。
  // 未选中任务 → 不渲染（首卡零噪音）。
  if (opts.selectedTask) {
    const selMilestones = opts.selectedTaskMilestones ?? [];
    elements.push(
      buildCollapsiblePanel({
        title: `📌 任务里程碑（#${opts.selectedTask.id}，${selMilestones.length}）`,
        elementId: "session_task_milestones",
        expanded: selMilestones.length > 0,
        elements: [
          {
            tag: "markdown",
            content:
              selMilestones.length > 0
                ? renderMilestones(selMilestones)
                : "（该任务暂无里程碑）",
          },
        ],
      }),
    );
    appendHr(elements);
  }


  // header：`📊 子会话实时更新（<title 或 session 截断>）`
  const titleRaw = opts.title?.trim();
  const headLabel = titleRaw
    ? truncateHeadTitle(titleRaw)
    : truncateHeadTitle(sessionId);

  // ★ 澄清（22:37）：subtitle 与配色由 **session 生命周期**驱动 ——
  //   没建 task 的执行同样会有「已完成 / 已超时 / 已停止」。
  const lifecycle = opts.lifecycle ?? "running";
  const lifecyclePhrase =
    opts.statusPhrase ?? SESSION_LIFECYCLE_PHRASE[lifecycle];
  const headerTemplate =
    lifecycle === "running"
      ? HEADER_TEMPLATE.running
      : lifecycle === "completed"
        ? HEADER_TEMPLATE.completed
        : lifecycle === "stopped"
          ? HEADER_TEMPLATE.stopped
          : HEADER_TEMPLATE.failed;

  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: `💬 会话卡实时更新（${headLabel}）` },
      subtitle: {
        tag: "plain_text",
        content: `spinner: '${spinner}' · 第 ${updateCount} 次更新 | ${lifecyclePhrase}`,
      },
      template: headerTemplate,
    },
    body: { elements },
  };
}

/**
 * ★ 澄清（22:37）：session 层生命周期 → 是否终态。
 *
 * `running` 之外都算终态（完成/超时/失败/停止）—— 这正是用户第 4 点
 * 「超时、完成等生命周期事件也体现在卡片上（这是 subsession 层的）」。
 */
function isSessionLifecycleTerminal(
  lifecycle: "running" | "completed" | "timeout" | "failed" | "stopped" | undefined,
): boolean {
  return lifecycle !== undefined && lifecycle !== "running";
}

/**
 * ★ Task #5384：task 卡的 `CardStatus` → session 卡的 `lifecycle`。
 *
 * 用途：task 侧的 `updateTask` / `finishTask` / `pauseTask` 打到 session 卡上时，
 * 要把「任务状态」翻译成「卡片的生命周期短语」（header 第二行）。
 *
 * 映射理由：
 * - `to_validate`（待验证）是**活跃等待态**，仍算 running（不能变成终态配色）
 * - `cancelled` / `deleted` → stopped（用户主动结束，不是失败）
 * - `stopped` → stopped；`failed` → failed；`completed` → completed
 */
function cardStatusToSessionLifecycle(status: CardStatus | string | undefined):
  | "running"
  | "completed"
  | "timeout"
  | "failed"
  | "stopped" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
    case "cancelled":
    case "deleted":
    // ★ CV R1 MINOR-4：任务态若将来/上游传 "paused"/"archived"/"blocked"，
    //   语义都是「人主动停了」而不是「在跑」—— 显式归到 stopped，别落到 default。
    case "paused":
    case "archived":
    case "blocked":
      return "stopped";
    case "timeout":
      return "timeout";
    // running / to_validate / 未知 → 运行中（不能把待验证刷成终态）
    default:
      return "running";
  }
}

/** lifecycle → 中文短句（卡片 subtitle） */
const SESSION_LIFECYCLE_PHRASE: Record<
  "running" | "completed" | "timeout" | "failed" | "stopped",
  string
> = {
  running: "运行中",
  completed: "已完成",
  timeout: "已超时",
  failed: "已失败",
  stopped: "已停止",
};

/**
 * 生成"打开飞书群"的 app link（Task #4230 follow-up 修复）
 *
 * ★ 踩坑记录（用户实测反馈）：之前用的是
 *   `https://applink.larkoffice.com/client/chat/chatDetail?chat_id=<oc_xxx>`
 *   —— 这是 **Lark 国际版**域名 + 老路径，飞书客户端点进去打不开群。
 *
 * 正确格式（飞书客户端自己生成的就是这个，见 `lark-cli im +chat-list` 的
 * `chat_app_link` 字段）：
 *   `https://applink.feishu.cn/client/chat/open?openChatId=<oc_xxx>`
 *
 * @param chatId 飞书群 id（oc_xxx）
 * @param base applink 基址（默认飞书；Lark 国际版租户可传 applink.larksuite.com）
 */
export function buildChatAppLink(
  chatId: string,
  base: string = DEFAULT_APP_LINK_BASE
): string {
  return `${base}/client/chat/open?openChatId=${chatId}`;
}

/** 默认 applink 基址（飞书） */
export const DEFAULT_APP_LINK_BASE = "https://applink.feishu.cn";

// ========================================================================
// Workflow Card Builder（Part 2：复用 task 卡片骨架）
// ========================================================================

/** 状态 → 卡片里"状态"栏位的中文短语 */
const WORKFLOW_STATUS_LABEL: Record<WorkflowCardStatus, string> = {
  running: "🔄 运行中",
  completed: "✅ 已完成",
  failed: "🚨 已失败",
  stopped: "⏹️ 已停止",
  // Task #4536：CardStatus 新增 cancelled 后由 TS 强制补齐（workflow 暂不产出该状态）
  cancelled: "🚫 已取消",
  // Task #4540：同上（workflow 没有"删除"语义，仅满足 Record 完备性）
  deleted: "🗑️ 已删除",
};

/** workflow 卡片 header.subtitle 状态短语 */
const WORKFLOW_STATUS_PHRASE: Record<WorkflowCardStatus, string> = {
  running: "实时同步中",
  completed: "🎉 流程跑完！",
  failed: "🚨 流程失败",
  stopped: "⏹️ 流程已停止",
  cancelled: "🚫 流程已取消",
  deleted: "🗑️ 流程已删除",
};

/**
 * 格式化耗时为人类可读文本（毫秒 → ms / s / m）
 *
 * 例：900 → "900ms"；6500 → "6.5s"；2000 → "2s"；120000 → "2m"
 */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  }
  const m = ms / 60_000;
  return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
}

/** 由 completedNodes/totalNodes 推算百分比（无法推算返回 undefined） */
function deriveProgress(opts: {
  completedNodes?: number;
  totalNodes?: number;
  progress?: number;
}): number | undefined {
  if (opts.progress !== undefined) return opts.progress;
  if (
    typeof opts.completedNodes === "number" &&
    typeof opts.totalNodes === "number" &&
    opts.totalNodes > 0
  ) {
    return (opts.completedNodes / opts.totalNodes) * 100;
  }
  return undefined;
}

/**
 * 渲染"运行栏位"区块（workflow 名 / runId / 状态 / 节点进度 / 当前节点 / 耗时 /
 * 失败原因 / 触发输入摘要）
 *
 * ★ 所有内容都是 markdown 可渲染文本；触发输入经 humanizeValue 处理，绝不出现 JSON 原文。
 */
export function renderWorkflowInfoLines(
  meta: WorkflowMeta,
  extra: {
    status: WorkflowCardStatus;
    totalNodes?: number;
    completedNodes?: number;
    currentNode?: string;
    currentNodeType?: string;
    durationMs?: number;
    error?: string;
  }
): string[] {
  const lines: string[] = [];

  if (meta.workflowName) {
    lines.push(`- **🔄 工作流**：${sanitizeInlineText(meta.workflowName, 120)}`);
  }
  if (meta.runId) {
    lines.push(`- **🆔 Run ID**：\`${sanitizeInlineText(meta.runId, 120)}\``);
  }
  if (meta.workflowId) {
    lines.push(`- **🏷️ Workflow ID**：\`${sanitizeInlineText(meta.workflowId, 120)}\``);
  }
  lines.push(`- **📶 状态**：${WORKFLOW_STATUS_LABEL[extra.status]}`);

  if (typeof extra.totalNodes === "number" && extra.totalNodes > 0) {
    const done =
      typeof extra.completedNodes === "number" ? extra.completedNodes : 0;
    lines.push(`- **🧩 节点进度**：${done}/${extra.totalNodes}`);
  }
  if (extra.currentNode) {
    const type = extra.currentNodeType ? `（${extra.currentNodeType}）` : "";
    lines.push(
      `- **🧭 当前节点**：${sanitizeInlineText(extra.currentNode, 80)}${type}`
    );
  }
  const duration = formatDurationMs(extra.durationMs);
  if (duration) {
    lines.push(`- **⚡ 耗时**：${duration}`);
  }
  if (extra.error) {
    const label = extra.status === "stopped" ? "⏹️ 停止原因" : "🚨 失败原因";
    lines.push(`- **${label}**：${sanitizeInlineText(extra.error, 300)}`);
  }
  if (meta.input !== undefined && meta.input !== null) {
    const rendered = humanizeValue(meta.input, 200);
    if (rendered) {
      lines.push(`- **📥 触发输入**：${rendered}`);
    }
  }

  return lines;
}

/**
 * 构造 workflow 进展卡片（Card 2.0 schema，复用 task 卡片骨架）
 *
 * 布局（与 task 卡片对齐）：
 * 1. header.title = 🔄 Workflow 实时更新（<workflow 名>）
 * 2. **运行栏位**：工作流 / Run ID / Workflow ID / 状态 / 节点进度 / 当前节点 / 耗时 / 失败原因 / 触发输入
 * 3. **🎯 里程碑序列**
 * 4. **🔧 过程信息**
 * 5. **📊 进度**（最后一块；completed 强制 100%）
 */
export function buildWorkflowCard(opts: {
  status: WorkflowCardStatus;
  meta: WorkflowMeta;
  milestones?: Milestone[];
  processSteps?: ProcessStep[];
  progress?: number;
  completedNodes?: number;
  totalNodes?: number;
  currentNode?: string;
  currentNodeType?: string;
  durationMs?: number;
  error?: string;
  updateCount?: number;
  spinner?: string;
  /**
   * 是否展开"执行动态"折叠面板（覆盖按 status 推导的默认值）
   *
   * ★ xval MINOR-2：workflow 的 "stopped" 是**真终态**（run 结束、卡片 unpin、
   *   状态清除），与 task 的 paused（可 resume）语义不同 → workflow 侧
   *   stopped 必须展开时间线，否则用户看不到 run 停在哪一步。
   */
  expandTimeline?: boolean;
}): CardPayload {
  const status = opts.status ?? "running";
  const milestones = opts.milestones ?? [];
  const processSteps = opts.processSteps ?? [];
  const updateCount = opts.updateCount ?? 0;
  const spinner = opts.spinner ?? "";

  const elements: Array<Record<string, any>> = [];

  // ---- 2. 运行栏位（★ Task #4845：收进默认折叠的「任务详情」面板） ----
  const infoLines = renderWorkflowInfoLines(opts.meta, {
    status,
    totalNodes: opts.totalNodes,
    completedNodes: opts.completedNodes,
    currentNode: opts.currentNode,
    currentNodeType: opts.currentNodeType,
    durationMs: opts.durationMs,
    error: opts.error,
  });
  if (infoLines.length > 0) {
    elements.push(
      buildCollapsiblePanel({
        title: "📋 运行详情",
        elementId: "workflow_detail",
        elements: [{ tag: "markdown", content: infoLines.join("\n") }],
      })
    );
    appendHr(elements);
  }

  // ---- 3. 里程碑序列 + 操作记录 + 执行轨迹（★ Task #4845：收进「执行动态」面板） ----
  //   ★ Task #4889：与 task 卡片同一套分区渲染（操作记录 vs 工具调用轨迹）。
  const timeline = buildTimelineElements(milestones, processSteps);
  if (timeline.elements.length > 0) {
    elements.push(
      buildCollapsiblePanel({
        title: buildTimelinePanelTitle(
          milestones.length,
          timeline.opCount,
          timeline.toolCount
        ),
        elementId: "workflow_timeline",
        expanded:
          opts.expandTimeline ?? isTerminalStatusForWorkflowTimeline(status),
        elements: timeline.elements,
      })
    );
  }

  // ---- 5. 进度（最后一块）----
  const effectiveProgress =
    status === "completed"
      ? 100
      : deriveProgress({
          completedNodes: opts.completedNodes,
          totalNodes: opts.totalNodes,
          progress: opts.progress,
        });

  appendHr(elements);
  elements.push({
    tag: "markdown",
    content:
      effectiveProgress !== undefined
        ? `**📊 进度**：${renderProgressBar(effectiveProgress)}`
        : `**📊 进度**：进行中（第 ${updateCount} 次更新，尚未上报百分比）`,
  });

  const title = opts.meta.workflowName || opts.meta.runId || "workflow";

  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: `🔄 Workflow 实时更新（${sanitizeInlineText(title, 80)}）` },
      subtitle: {
        tag: "plain_text",
        content:
          `spinner: '${spinner}' · 第 ${updateCount} 次更新 | ` +
          WORKFLOW_STATUS_PHRASE[status],
      },
      template: HEADER_TEMPLATE[status],
    },
    body: { elements },
  };
}

// ========================================================================
// LarkCardPatchNotifier
// ========================================================================

/**
 * 串行化互斥锁（简单的 promise-chain mutex）
 *
 * 用于同一 notifier 实例上并发 patch 的串行化（避免飞书端并发覆盖）。
 * 失败不会被锁链污染。
 */
class MutexImpl {
  private chain: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain;
    const next = prev.then(() => fn());
    // swallow errors on chain so one failure doesn't poison the rest
    this.chain = next.catch(() => {});
    return next;
  }
}

/**
 * 卡片状态的对外快照（Task #4536）
 *
 * 用于持久化 / 重启恢复：`exportState` / `hydrateState` 的载荷类型。
 */
export interface CardStateSnapshot {
  chatId?: string;
  profile?: string;
  meta?: TaskMeta;
  startedAt?: string;
  updateCount?: number;
  spinnerIndex?: number;
  milestones?: Milestone[];
  processSteps?: ProcessStep[];
  progress?: number;
}

/** 单张卡片的内部状态（key = messageId） */
interface CardState {
  chatId: string;
  profile?: string;
  /** 任务元信息（栏位区块；updateTask 未传 meta 时沿用） */
  meta: TaskMeta;
  startedAt: string;
  updateCount: number;
  spinnerIndex: number;
  milestones: Milestone[];
  processSteps: ProcessStep[];
  progress?: number;
}

/** 单张 workflow 卡片的内部状态（key = messageId；与 CardState 并列） */
interface WorkflowCardState {
  chatId: string;
  profile?: string;
  meta: WorkflowMeta;
  startedAt: string;
  updateCount: number;
  spinnerIndex: number;
  milestones: Milestone[];
  processSteps: ProcessStep[];
  progress?: number;
  completedNodes?: number;
  totalNodes?: number;
  durationMs?: number;
  error?: string;
  status: WorkflowCardStatus;
}

/**
 * LarkCardPatchNotifier - 封装单卡片 patch 逻辑
 */
export class LarkCardPatchNotifier {
  private readonly options: Required<Omit<LarkCardPatchNotifierOptions, "sessionCardStore">>;
  private readonly mutexes = new Map<string, MutexImpl>();
  private readonly states = new Map<string, CardState>();

  /**
   * Part 2：workflow 卡片状态（key = messageId）
   *
   * 与 task 的 `states` 并列：两套卡片走**同一套** mutex / send / patch / pin /
   * unpin 基础设施，只是渲染的卡片与自持的时间线不同。
   */
  private readonly workflowStates = new Map<string, WorkflowCardState>();

  /**
   * ★ 补充需求（22:31）：**session 卡**的累计状态（key = messageId）。
   *
   * 与 `states`（task 卡）分开存：
   * - task 卡状态里的 `meta` 是 `TaskMeta`（含 goals/priority/progress）
   * - session 卡只有 `sessionId` + 少量展示字段
   * 混在一个 Map 里会让 `buildCardWithActivity` 取到 session 状态并当成
   * task meta 渲染（输出一堆 undefined 占位）。分开最省心。
   */
  private readonly sessionStates = new Map<string, SessionCardState>();

  /**  CV R4：session 卡状态别名（渲染 + patch 都需要） */

  /** ★ CV R3 M3：session 卡持久层（`null` = 显式关闭） */
  private readonly sessionStore?: LarkSessionCardStore;

  constructor(options: LarkCardPatchNotifierOptions = {}) {
    this.sessionStore =
      options.sessionCardStore === null
        ? undefined
        : (options.sessionCardStore ?? getSharedLarkSessionCardStore());
    this.options = {
      pinOnStart: true,
      // ★ Task #5164 需求 2a：任务完成**不再自动 unpin** ——
      //   pin 去留由用户手动决定（自动取消置顶会打断用户自己
      //   组织置顶区的意愿）。需要旧行为的调用方显式传 true。
      unpinOnFinish: false,
      // sessionCardStore 单独存字段，不进 options（它不是渲染配置）
      ...(({ sessionCardStore: _scs, ...rest }) => rest)(options),
    };
    // ★ Task #5591（真机复发）：**构造即回灌**。
    //
    // restoreSessionCardsFromStore() 此前全仓无生产调用方（仅测试引用）
    // ⇒ 重启 / 冷启动后 `sessionCardIds` 恒空 ⇒ task hook 一来
    // `upsertSessionCard` 查无卡 ⇒ 走 `startSessionCard` 再发一张
    // （用户看到「同一 session 2 条卡」）。
    //
    // 修法：有持久层时构造函数自动回灌 —— 生产（hook 默认构造 /
    // getSharedLarkCardNotifier / wiring）与测试（显式传 store）统一生效，
    // 不再依赖"某个调用方记得调 restore"。store 为空 / 回灌失败只 warn，
    // 绝不影响构造（见 restoreSessionCardsFromStore 内部 try/catch）。
    this.restoreSessionCardsFromStore();
  }

  /** 取（或创建）某 messageId 的 mutex —— 不同卡片互不阻塞 */
  private mutexFor(messageId: string): MutexImpl {
    let m = this.mutexes.get(messageId);
    if (!m) {
      m = new MutexImpl();
      this.mutexes.set(messageId, m);
    }
    return m;
  }

  /**
   * 发送初始卡片 → 拿到 messageId → pin（置顶）
   *
   * ★ Task #4230：pin 用 `im pins create --data '{"message_id":...}'`（旧实现传
   *   `--chat-id/--message-id` 是非法 flag，导致 pin 永远失败 → 用户"还是没有 pin"）。
   */
  @TracedAs("lark-card.startTask", {
    recordParams: true,
    recordResult: true,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      chatId: args[0]?.chatId,
      profile: args[0]?.profile,
      taskId: args[0]?.taskId,
    }),
    resultFilter: (r: StartTaskResult | undefined) => ({
      messageId: r?.messageId,
      pinned: r?.pinned,
    }),
  })
  async startTask(opts: StartTaskOptions): Promise<StartTaskResult> {
    const now = new Date().toISOString();
    const spinner = SPINNER_EMOJIS[0];
    const milestones: Milestone[] = opts.milestones?.length
      ? opts.milestones
      : [{ title: "Task 创建", timestamp: now }];

    const card = buildTaskCard({
      status: "running",
      meta: opts.meta,
      milestones,
      processSteps: [],
      updateCount: 1,
      spinner,
    });

    // 1. 发送初始卡片
    const stdout = await this.runLarkCli(
      this.buildSendCardArgs({ chatId: opts.chatId, profile: opts.profile, card }),
      "send"
    );

    const messageId = this.extractMessageId(stdout);
    if (!messageId) {
      throw new Error(
        `lark-cli +messages-send did not return message_id: ${stdout.slice(0, 500)}`
      );
    }

    // 2. 记录状态（后续 updateTask 累积里程碑/过程时间线）
    this.states.set(messageId, {
      chatId: opts.chatId,
      profile: opts.profile,
      meta: opts.meta,
      startedAt: now,
      updateCount: 1,
      spinnerIndex: 0,
      milestones,
      processSteps: [],
    });

    // 3. Pin（置顶）—— 失败非致命，但必须可观测（不再静默吞掉）
    let pinned = false;
    let pinError: string | undefined;
    if (this.options.pinOnStart) {
      try {
        await this.runLarkCli(
          this.buildPinArgs({ messageId, profile: opts.profile }),
          "pin"
        );
        pinned = true;
      } catch (pinErr) {
        pinError = (pinErr as Error).message;
        logger.warn(
          `Pin failed (non-fatal) for message ${messageId}: ${pinError}`
        );
      }
    }

    return { messageId, pinned, pinError };
  }

  /**
   * Patch 同一卡片（状态/进度/当前步骤 + 累积里程碑与过程时间线）
   *
   * ★ Task #4230：patch 用 `im messages patch --data '{"content":"<card JSON>"}'`
   *   （旧实现传 `--content` 是非法 flag → 秒失败 → 卡片永远停在初始态）。
   */
  @TracedAs("lark-card.updateTask", {
    recordParams: true,
    recordResult: false,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      messageId: args[0]?.messageId,
      profile: args[0]?.profile,
      status: args[0]?.status,
      taskId: args[0]?.taskId,
      progress: args[0]?.progress,
      newMilestones: args[0]?.milestones?.length ?? 0,
      newProcessSteps: args[0]?.processSteps?.length ?? 0,
    }),
  })
  async updateTask(opts: UpdateTaskOptions): Promise<void> {
    await this.mutexFor(opts.messageId).run(async () => {
      // ★ Task #5020（review round-4 MAJOR）—— 终态守卫。
      //
      // 位置很关键：必须在 **mutex 内部**、拿 state 之前判断。
      // 若只在调用方（hook）里做时序检查，一个已经通过检查、正排队等
      // mutex 的 updateTask 仍会在 finishTask 之后执行，把终态卡用空
      // state 重建回「进行中」。这里判断一次就把这条路彻底封死。
      if (this.finalisedCards.has(opts.messageId)) {
        logger.debug(
          `updateTask: message ${opts.messageId} 已是终态卡片，忽略迟到的更新`
        );
        return;
      }

      // ★ Task #5384：**session 卡归属守卫** —— 若这张卡其实是 session 卡
      //   （`startSessionCard` / `upsertSessionCard` 发的），task 侧的 update
      //   必须走 session 渲染器，绝不能落进下面的 `buildTaskCard` 占位分支。
      //   不加这道判断，`states.get()` 恒 undefined ⇒ 占位 meta:{title:"任务"}
      //   ⇒ session 卡被整卡覆盖降级（真机 12:31:23 就是这个）。
      if (this.sessionStates.has(opts.messageId)) {
        const card = this.applyTaskEventToSessionCard(opts.messageId, {
          ...(opts.milestones ? { milestones: opts.milestones } : {}),
          ...(opts.processSteps ? { processSteps: opts.processSteps } : {}),
          ...(opts.meta ? { meta: opts.meta } : {}),
          // ★ CV R1 MINOR-1：状态也要透传进「📋 任务信息」面板，
          //   否则 header 说「已完成」而面板还停在上一次的 active（同卡两处矛盾）。
          ...(opts.status ? { status: opts.status } : {}),
          // ★ CV R2 MINOR-1：**只在真的有 status 时**才推 lifecycle。
          //   否则 `cardStatusToSessionLifecycle(undefined)` 返回 "running"，
          //   会把已经由 session 侧推进到「已完成/已超时」的卡**翻回运行中**
          //   （delta.lifecycle 一旦有值，applyTaskEventToSessionCard 的
          //   carry-forward `?? state.lifecycle` 就被短路了）。
          ...(opts.status
            ? { lifecycle: cardStatusToSessionLifecycle(opts.status) }
            : {}),
          ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
        });
        await this.runLarkCli(
          this.buildPatchCardArgs({
            messageId: opts.messageId,
            profile: opts.profile,
            card,
          }),
          "patch",
        );
        return;
      }

      const state = this.states.get(opts.messageId) ?? {
        chatId: opts.chatId ?? "",
        profile: opts.profile,
        meta: opts.meta ?? { title: "任务" },
        startedAt: new Date().toISOString(),
        updateCount: 0,
        spinnerIndex: 0,
        milestones: [],
        processSteps: [],
      };

      // 累积时间线（append + 去重）
      const mergedMilestones = mergeUnique(
        state.milestones,
        opts.milestones ?? [],
        milestoneKey
      );
      const mergedSteps = mergeUnique(
        state.processSteps,
        opts.processSteps ?? [],
        processStepKey
      );

      const updateCount = state.updateCount + 1;
      const spinner = SPINNER_EMOJIS[updateCount % SPINNER_EMOJIS.length];

      const card = buildTaskCard({
        status: opts.status,
        meta: mergeTaskMeta(state.meta, opts.meta),
        progress: opts.progress ?? state.progress,
        milestones: mergedMilestones,
        processSteps: mergedSteps,
        updateCount,
        spinner,
      });

      await this.runLarkCli(
        this.buildPatchCardArgs({
          messageId: opts.messageId,
          profile: opts.profile ?? state.profile,
          card,
        }),
        "patch"
      );

      // 回写状态
      this.states.set(opts.messageId, {
        ...state,
        chatId: opts.chatId ?? state.chatId,
        profile: opts.profile ?? state.profile,
        meta: mergeTaskMeta(state.meta, opts.meta),
        updateCount,
        spinnerIndex: spinnerIndexFor(updateCount),
        milestones: mergedMilestones,
        processSteps: mergedSteps,
        progress: opts.progress ?? state.progress,
      });
    });
  }

  /**
   * 导出某张卡片的累积内容快照（Task #4536 / xval MAJOR 3）
   *
   * 供上层（`LarkCliTaskNotifyHook`）持久化到 store，让 roy-bot 重启后
   * 第一次 patch 仍能带上原里程碑 / 过程步骤 / 更新计数，而不是退回
   * "第 1 次更新 + 暂无里程碑"。
   *
   * 返回 `undefined` 表示本 notifier 没有该 messageId 的状态
   * （例如刚重启 —— 此时调用方应先用 {@link hydrateState} 灌入）。
   */
  exportState(messageId: string): CardStateSnapshot | undefined {
    const state = this.states.get(messageId);
    if (!state) return undefined;
    return {
      meta: state.meta,
      startedAt: state.startedAt,
      updateCount: state.updateCount,
      spinnerIndex: state.spinnerIndex,
      milestones: state.milestones,
      processSteps: state.processSteps,
      progress: state.progress,
      chatId: state.chatId,
      profile: state.profile,
    };
  }

  /**
   * 注入某张卡片的状态快照（Task #4536 / xval MAJOR 3）
   *
   * 用于**进程重启后**从持久层恢复卡片内容：之后 `updateTask` /
   * `pauseTask` 会基于这份快照继续累积，而不是从空白重建。
   *
   * ★ 幂等：已有 state 时不覆盖（内存里的比持久化的更新）。
   */
  hydrateState(messageId: string, snapshot: CardStateSnapshot): void {
    if (this.states.has(messageId)) return;
    this.states.set(messageId, {
      chatId: snapshot.chatId ?? "",
      profile: snapshot.profile,
      meta: snapshot.meta ?? { title: "任务" },
      startedAt: snapshot.startedAt ?? new Date().toISOString(),
      updateCount: snapshot.updateCount ?? 0,
      spinnerIndex: snapshot.spinnerIndex ?? 0,
      milestones: snapshot.milestones ?? [],
      processSteps: snapshot.processSteps ?? [],
      progress: snapshot.progress,
    });
  }

  /**
   * ★ Task #5020 —— 把时间线条目**并入内存态**，但**不发** lark-cli patch。
   *
   * ## 为什么需要
   *
   * `task:operation:after.create` 的 patch 频率受 `operationThrottleMs`
   * 约束（默认 5s），目的是别刷屏飞书。但**节流不该丢数据**：
   * 被节流的那条 operation 如果直接丢掉，它的里程碑既不上卡也不落库。
   *
   * 这个方法让「节流」与「数据完整性」解耦：
   *   - 被节流的 operation → `mergeTimelineState`（只进内存态，不 patch）
   *   - 下一次允许 patch → `updateTask` 把**累积后的**整条时间线 patch 出去
   *   - 任何时刻的 `exportState` 都能看到**全部**里程碑 → ledger 落库完整
   *
   * ## 与 `updateTask` 的区别
   *
   * `updateTask` 会**渲染并发送**卡片（一次 lark-cli 调用）；本方法**不碰飞书**，
   * 只动内存态。调用方负责决定何时真正 patch。
   *
   * @returns 是否真的并入了（state 不存在时返回 false —— 那张卡不是本 notifier 的）
   */
  mergeTimelineState(
    messageId: string,
    milestones: Milestone[] = [],
    processSteps: ProcessStep[] = []
  ): boolean {
    const state = this.states.get(messageId);
    if (!state) return false;
    state.milestones = mergeUnique(state.milestones, milestones, milestoneKey);
    state.processSteps = mergeUnique(state.processSteps, processSteps, processStepKey);
    return true;
  }

  /**
   * 暂停卡片（Task #4536：stop / archived）+ unpin，**保留**卡片状态与时间线
   *
   * ★ 为什么不能复用 `finishTask`（xval MAJOR 2 回归）：
   *   `finishTask` 末尾会 `states.delete(messageId)` —— 那是终态语义（卡片到此为止）。
   *   `paused` **不是**终态（可 resume），如果也删状态：
   *   1. resume 后 `updateTask` 从空 state 重建 → 里程碑 / 过程步骤 /
   *      "第 N 次更新" 全部丢失，卡片退回"第 1 次更新 + 暂无里程碑"；
   *   2. 卡片 action handler 的 fallback 也会把 paused 卡片重建成蓝色 running。
   *
   * 所以 pause 只做三件事：patch 成灰底「已暂停」、unpin、**保留 state**。
   * 只有 `unpinOnFinish` 为 true 时才 unpin（与 finishTask 一致）。
   */
  @TracedAs("lark-card.pauseTask", {
    recordParams: true,
    recordResult: false,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      messageId: args[0]?.messageId,
      profile: args[0]?.profile,
      taskId: args[0]?.taskId,
    }),
  })
  async pauseTask(opts: FinishTaskOptions): Promise<void> {
    await this.mutexFor(opts.messageId).run(async () => {
      // ★ Task #5384：session 卡归属守卫（暂停同样不得降级成 task 卡）
      if (this.sessionStates.has(opts.messageId)) {
        const now = new Date().toISOString();
        const pauseMilestone: Milestone = {
          title: opts.pausedMilestoneTitle ?? "Task 已暂停",
          timestamp: now,
          description: opts.finalStep,
        };
        const card = this.applyTaskEventToSessionCard(opts.messageId, {
          milestones: [pauseMilestone],
          ...(opts.processSteps ? { processSteps: opts.processSteps } : {}),
          ...(opts.meta ? { meta: opts.meta } : {}),
          // ★ CV R1 MINOR-3：暂停路径同样透传状态，与 updateTask 路径行为一致
          ...(opts.status ? { status: opts.status } : {}),
          // ★ CV R3 MINOR-1：同上（防御性条件化）
          ...(opts.status
            ? { lifecycle: cardStatusToSessionLifecycle(opts.status) }
            : {}),
          ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
          nowIso: now,
        });
        await this.runLarkCli(
          this.buildPatchCardArgs({
            messageId: opts.messageId,
            profile: opts.profile,
            card,
          }),
          "patch",
        );
        return;
      }

      const state = this.states.get(opts.messageId);
      const now = new Date().toISOString();
      const updateCount = (state?.updateCount ?? 0) + 1;
      const spinner = SPINNER_EMOJIS[updateCount % SPINNER_EMOJIS.length];

      const pauseMilestone: Milestone = {
        title: opts.pausedMilestoneTitle ?? "Task 已暂停",
        timestamp: now,
        description: opts.finalStep,
      };

      const card = buildTaskCard({
        status: opts.status,
        meta: mergeTaskMeta(state?.meta, opts.meta),
        // ★ 保留已有进度（不强行改成 100，也不清空）
        progress: opts.progress ?? state?.progress,
        milestones: mergeUnique(
          state?.milestones ?? [],
          [pauseMilestone],
          milestoneKey
        ),
        // ★ 保留已有过程时间线
        processSteps: state?.processSteps ?? [],
        updateCount,
        spinner,
        // ★ xval MINOR-2：archived（终态）展开时间线；paused（可 resume）保持折叠
        expandTimeline: opts.expandTimeline,
      });

      await this.runLarkCli(
        this.buildPatchCardArgs({
          messageId: opts.messageId,
          profile: opts.profile ?? state?.profile,
          card,
        }),
        "patch"
      );

      // ★ 回写 state（不删除！resume 后要继续累积）
      this.states.set(opts.messageId, {
        chatId: opts.chatId ?? state?.chatId ?? "",
        profile: opts.profile ?? state?.profile,
        meta: mergeTaskMeta(state?.meta, opts.meta),
        startedAt: state?.startedAt ?? now,
        updateCount,
        spinnerIndex: spinnerIndexFor(updateCount),
        milestones: mergeUnique(
          state?.milestones ?? [],
          [pauseMilestone],
          milestoneKey
        ),
        processSteps: state?.processSteps ?? [],
        progress: opts.progress ?? state?.progress,
      });
    });

    // unpin（非致命，与 finishTask 保持同一套契约）
    if (this.options.unpinOnFinish) {
      const state = this.states.get(opts.messageId);
      try {
        await this.runLarkCli(
          this.buildUnpinArgs({
            messageId: opts.messageId,
            profile: opts.profile ?? state?.profile,
          }),
          "unpin"
        );
      } catch (unpinErr) {
        logger.warn(
          `Unpin failed (non-fatal) for ${opts.messageId}: ${(unpinErr as Error).message}`
        );
      }
    }
    // ★ 刻意不 states.delete / mutexes.delete —— 卡片还活着，只是暂停
  }

  /**
   * 单独 pin 一条已存在的卡片消息（Task #4536）
   *
   * 用途：任务 **resume**（paused → active）后把卡片重新置顶，
   * 让 pin 状态与任务状态保持一致（stop 时 unpin，resume 时 re-pin）。
   *
   * ★ 与 `startTask` 里的 pin 走**同一套** lark-cli 契约：
   *   `im pins create --data '{"message_id":"om_xxx"}'`（绝不传 --chat-id/--message-id，
   *   那是非法 flag → unknown flag → pin 永远失败，Task #4230 的老坑）。
   *
   * 失败直接抛出，由调用方决定降级（pin 失败不应阻断卡片 patch）。
   */
  @TracedAs("lark-card.pinMessage", {
    recordParams: true,
    recordResult: false,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      messageId: args[0],
      profile: args[1],
    }),
  })
  async pinMessage(messageId: string, profile?: string): Promise<void> {
    await this.runLarkCli(this.buildPinArgs({ messageId, profile }), "pin");
  }

  /**
   * 单独 unpin 一条已存在的卡片消息（Task #4540）
   *
   * 与 {@link pinMessage} 配对。为什么需要它：`finishTask` / `pauseTask` 的
   * unpin 是"尽力而为"的副作用，且一旦 patch 抛错，unpin 那段可能整段跳过。
   * 而用户最在意的是「pin 别再挂着」—— 所以删除任务时额外补一次显式 unpin。
   *
   * 幂等：已 unpin 的消息再 delete 只会 warn（由 `buildUnpinArgs` 保证带 `--yes`）。
   */
  @TracedAs("lark-card.unpinMessage", {
    recordParams: true,
    recordResult: false,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      messageId: args[0],
      profile: args[1],
    }),
  })
  async unpinMessage(messageId: string, profile?: string): Promise<void> {
    await this.runLarkCli(this.buildUnpinArgs({ messageId, profile }), "unpin");
  }

  /**
   * 完成任务：patch final status（终态里程碑 → 进度 100%）+ unpin
   *
   * ★ Task #4230：unpin 需要 `--yes`（`im pins delete` 是 high-risk-write，
   *   旧实现漏了 --yes → unpin 静默失败）。
   */
  @TracedAs("lark-card.finishTask", {
    recordParams: true,
    recordResult: false,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      messageId: args[0]?.messageId,
      profile: args[0]?.profile,
      status: args[0]?.status,
      taskId: args[0]?.taskId,
    }),
  })
  async finishTask(opts: FinishTaskOptions): Promise<void> {
    await this.mutexFor(opts.messageId).run(async () => {
      // ★ Task #5384：session 卡归属守卫 —— 任务终态也必须体现在 **session 卡**上
      //   （用户第 4 点：完成/超时要落在子会话卡），不得用 buildTaskCard 覆盖降级。
      if (this.sessionStates.has(opts.messageId)) {
        const now = new Date().toISOString();
        const finalMilestone: Milestone = {
          title: FINAL_MILESTONE_TITLE[opts.status] ?? "Task 结束",
          timestamp: now,
          description: opts.finalStep,
        };
        const card = this.applyTaskEventToSessionCard(opts.messageId, {
          milestones: [finalMilestone],
          ...(opts.processSteps ? { processSteps: opts.processSteps } : {}),
          ...(opts.meta ? { meta: opts.meta } : {}),
          // ★ CV R1 MINOR-1：面板状态同步成终态（否则 header「已完成」、面板仍 active）
          ...(opts.status ? { status: opts.status } : {}),
          // ★ CV R3 MINOR-1：条件化，与 updateTask 防御一致（status 缺失时
          //   不能把卡刷成 running，否则与刚追加的终态里程碑自相矛盾）
          ...(opts.status
            ? { lifecycle: cardStatusToSessionLifecycle(opts.status) }
            : {}),
          progress: opts.status === "completed" ? 100 : opts.progress,
          nowIso: now,
        });
        await this.runLarkCli(
          this.buildPatchCardArgs({
            messageId: opts.messageId,
            profile: opts.profile,
            card,
          }),
          "patch",
        );
        // 终态守卫：之后的迟到 update 一律吞掉（与 task 卡同一套语义）。
        // 但**不删** sessionStates —— 用户点「🔄 刷新活性」仍需靠它重建卡片。
        this.finalisedCards.add(opts.messageId);
        return;
      }

      const state = this.states.get(opts.messageId);
      const now = new Date().toISOString();
      const updateCount = (state?.updateCount ?? 0) + 1;
      const spinner = SPINNER_EMOJIS[updateCount % SPINNER_EMOJIS.length];

      const finalMilestone: Milestone = {
        title: FINAL_MILESTONE_TITLE[opts.status] ?? "Task 结束",
        timestamp: now,
        description: opts.finalStep,
      };

      const card = buildTaskCard({
        status: opts.status,
        meta: mergeTaskMeta(state?.meta, opts.meta),
        progress:
          opts.status === "completed" ? 100 : opts.progress ?? state?.progress,
        milestones: mergeUnique(
          state?.milestones ?? [],
          [finalMilestone],
          milestoneKey
        ),
        processSteps: state?.processSteps ?? [],
        updateCount,
        spinner,
        // ★ xval MINOR-2：显式覆盖（调用方可区分 paused / archived）
        expandTimeline: opts.expandTimeline,
      });

      await this.runLarkCli(
        this.buildPatchCardArgs({
          messageId: opts.messageId,
          profile: opts.profile ?? state?.profile,
          card,
        }),
        "patch"
      );

      // ★ Task #5020（review round-5 MAJOR）—— 终态标记必须在 **mutex 内**、
      //   patch 成功之后立刻打，**不能**等到 unpin 之后。
      //
      //   原因：mutex 一旦释放，一个已排队的 `updateTask` 就能拿到锁并通过
      //   守卫。如果把标记放在 unpin 之后（unpin 是一次真实的 lark-cli 调用，
      //   可能耗时数百毫秒），中间就是一段能被迟到更新穿透的窗口 ——
      //   round-4 的竞态只是变窄，没有关闭。
      //
      //   现在标记与 `states.delete` 都落在同一个临界区内，语义是原子的：
      //   「完成 patch 一旦生效，这张卡对后续更新即刻不可写」。
      this.finalisedCards.add(opts.messageId);
    });

    // unpin（非致命）
    if (this.options.unpinOnFinish) {
      const state = this.states.get(opts.messageId);
      try {
        await this.runLarkCli(
          this.buildUnpinArgs({
            messageId: opts.messageId,
            profile: opts.profile ?? state?.profile,
          }),
          "unpin"
        );
      } catch (unpinErr) {
        logger.warn(
          `Unpin failed (non-fatal) for ${opts.messageId}: ${(unpinErr as Error).message}`
        );
      }
    }

    // 清理内存（避免泄漏）。
    // ★ Task #5020：`finalisedCards` 的写入已提前到 mutex 内（见上），
    //   这里只做内存回收。注意 **不要** 在这里 delete mutex 之前就
    //   允许迟到更新 —— 守卫在 mutex 内、读 state 之前，所以安全。
    this.states.delete(opts.messageId);
    this.mutexes.delete(opts.messageId);
  }

  /**
   * ★ Task #4339：只更新卡片的任务元信息（meta），**保留**已累积的
   * 里程碑 / 过程时间线 / 进度 / 更新次数。
   *
   * 用途：用户在卡片顶部点「为这个任务建群 / 解散该群」后，按钮需要翻面、
   * 群链接需要出现/隐藏，但**不能**把这张卡片的进展历史冲掉。
   *
   * 旧实现（handler 里裸调 `buildTaskCard` 只塞 1 条 "Task 创建" 里程碑）的
   * 后果：用户点一下按钮，卡片就退回"初始态"，之前几十次进展更新全没了。
   *
   * ★ 同时**会**同步更新内部 `state.meta` —— 否则下一次 `updateTask`
   *   会用旧 meta 重建卡片，把刚显示的群链接又抹掉。
   *
   * @param opts.clearPerTaskChat 「解散群」时必须传 true：
   *        `mergeTaskMeta` 会跳过 undefined/"" 值，**无法**用它清除字段，
   *        所以这里显式 delete 掉 `perTaskChatId` / `perTaskChatName`。
   * @returns 可直接提交给飞书 patch 的卡片；返回 `undefined` 表示本 notifier
   *          没有该 messageId 的状态（进程重启 / 卡片不是本 notifier 发的），
   *          caller 需自行 fallback 构建。
   */
  updateMetaAndBuildCard(
    messageId: string,
    meta: TaskMeta,
    opts: { clearPerTaskChat?: boolean } = {}
  ): CardPayload | undefined {
    // ★ Task #5384：session 卡归属守卫 —— 建群/解散群重建卡片时必须保持
    //   session 卡身份（否则用户点一次建群，卡就降级成 task 卡、刷新按钮消失）。
    if (this.sessionStates.has(messageId)) {
      return this.applyTaskEventToSessionCard(messageId, {
        meta,
        bumpUpdateCount: false,
        ...(opts.clearPerTaskChat ? { clearPerTaskChat: true } : {}),
        ...(meta.perTaskChatId ? { perTaskChatId: meta.perTaskChatId } : {}),
        ...(meta.perTaskChatName ? { perTaskChatName: meta.perTaskChatName } : {}),
      });
    }

    const state = this.states.get(messageId);
    if (!state) return undefined;

    state.meta = mergeTaskMeta(state.meta, meta);
    if (opts.clearPerTaskChat) {
      delete state.meta.perTaskChatId;
      delete state.meta.perTaskChatName;
    }

    return buildTaskCard({
      // 群建/解散不应改变任务状态语义，沿用 running
      status: "running",
      meta: state.meta,
      milestones: state.milestones,
      processSteps: state.processSteps,
      progress: state.progress,
      updateCount: state.updateCount,
      spinner: SPINNER_EMOJIS[state.spinnerIndex] ?? SPINNER_EMOJIS[0],
    });
  }

  /**
   * ★ Task #5360 — 用活性快照重建卡片（用户点「🔄 刷新活性」时调用）。
   *
   * ## 为什么需要这个专门方法（不复用 `updateMetaAndBuildCard`）
   *
   * `updateMetaAndBuildCard` 是给"群建/解散"用的：它只改 meta 再 rebuild。
   * 刷新活性要的是**同一张卡的累计状态 + 一份新活性快照**，且**绝不能**
   * 走 `updateTask`（那会 patch + updateCount+1，用户点 5 次刷新 = 时间线
   * 少 5 次"更新"预算，还把 spinner 转乱）。
   *
   * ## 返回 undefined 的语义
   *
   * notifier 没有该 messageId 的状态（进程重启后还没 hydrate）→ undefined。
   * 调用方（action handler）据此 fallback 重建卡片 —— 与
   * `buildCardAfterGroupChange` 完全同一套降级语义。
   */
  buildCardWithActivity(
    messageId: string,
    activity: SubSessionActivity | null,
    opts: { terminal?: boolean; now?: number } = {},
  ): CardPayload | undefined {
    const state = this.states.get(messageId);
    if (!state) return undefined;

    return buildTaskCard({
      status: "running",
      meta: state.meta,
      milestones: state.milestones,
      processSteps: state.processSteps,
      progress: state.progress,
      updateCount: state.updateCount,
      spinner: SPINNER_EMOJIS[state.spinnerIndex] ?? SPINNER_EMOJIS[0],
      activity,
      ...(opts.now !== undefined ? { activityNow: opts.now } : {}),
      ...(opts.terminal !== undefined ? { activityTerminal: opts.terminal } : {}),
    });
  }

  /**
   * ★ CV R4 BLOCKER：**给已存在的 session 卡发 patch**（生命周期推进时用）。
   *
   * ## 为什么必须有它（用户需求没被真正满足）
   *
   * 「超时、完成等生命周期事件也体现在卡片上」—— 但 `startSessionCard`
   * 每次都是 `messages-send` = **发一条新消息**。若每个生命周期都 start：
   * - 一个 session 会产出「启动卡 + 完成卡」**两张**（用户看到重复卡）
   * - 每张都被 pin ⇒ 置顶堆积
   * - 「一张卡承载整个生命周期」这个语义根本没实现
   *
   * 正确做法：`running` 发首卡，后续生命周期 **patch 同一张**。
   *
   * ## 返回值语义
   *
   * `false` = 本 notifier 没有该 session 的卡记录（重启未 hydrate / 从没发过）
   * ⇒ 调用方据此走 `startSessionCard` 发首卡。
   */
  async updateSessionCard(opts: {
    sessionId: string;
    chatId?: string;
    profile?: string;
    lifecycle: "running" | "completed" | "timeout" | "failed" | "stopped";
    /** 追加的里程碑（如「子会话完成」） */
    milestones?: Milestone[];
    activity?: SubSessionActivity | null;
    /** ★ Task #5364 返工：该 session 内的任务信息（渲染进**同一张** session 卡） */
    task?: Parameters<typeof buildSessionCard>[0]["task"];
    /** ★ Task #5580：该 session 内全部 task 的摘要列表（「🗂️ 任务列表」面板） */
    tasks?: SessionCardTaskSummary[];
    /**
     * ★ Task #5420：最近消息列表（「💬 会话查看」面板）。
     *
     * 补声明：方法体内一直读 `opts.recentMessages`（carry-forward 逻辑），
     * 但 opts 类型漏了这一项 ⇒ tsc 长期报 TS2339（存量缺陷，本次顺手修掉）。
     */
    recentMessages?: ActivityMessage[] | ToolCallView[];
    perTaskChatId?: string;
    perTaskChatName?: string;
  }): Promise<boolean> {
    const rec = this.findSessionCardBySessionId(opts.sessionId);
    if (!rec) return false;
    const { messageId, state } = rec;

    const mergedMilestones = mergeUnique(
      state.milestones,
      opts.milestones ?? [],
      milestoneKey,
    );
    const updateCount = state.updateCount + 1;

    const card = buildSessionCard({
      sessionId: opts.sessionId,
      title: state.title,
      statusPhrase: state.statusPhrase,
      agentType: state.agentType,
      startedAt: state.startedAt,
      elapsedText: state.elapsedText,
      milestones: mergedMilestones,
      lifecycle: opts.lifecycle,
      updateCount,
      // 本次传了用本次；没传就用 state 里上一次的快照（不擦掉用户要看的信息）
      ...(opts.activity !== undefined
        ? { activity: opts.activity }
        : state.activity !== undefined
          ? { activity: state.activity }
          : {}),
      // ★ Task #5364 返工（BLOCKER-5）：task 区块同样「本次优先、否则沿用」。
      //   否则第二次生命周期事件（不带 task）会把任务信息面板擦掉。
      ...(opts.task !== undefined
        ? { task: opts.task }
        : state.task !== undefined
          ? { task: state.task }
          : {}),
      // ★ Task #5420（CV MAJOR-1）：recentMessages 同 task/activity 的
      //   「本次优先、否则沿用」语义 —— 否则下一条 lifecycle patch
      //   会把「💬 会话查看」面板整块擦掉（#5364 BLOCKER-5 同类回归）。
      ...(opts.recentMessages !== undefined
        ? { recentMessages: opts.recentMessages }
        : state.recentMessages !== undefined
          ? { recentMessages: state.recentMessages }
          : {}),
      // ★ Task #5580：任务列表同样「本次优先、否则沿用」（不擦面板）
      ...(opts.tasks !== undefined
        ? { tasks: opts.tasks, taskTotal: opts.tasks.length }
        : state.sessionTasks !== undefined
          ? { tasks: state.sessionTasks }
          : {}),
      ...((opts.perTaskChatId ?? state.perTaskChatId)
        ? { perTaskChatId: (opts.perTaskChatId ?? state.perTaskChatId)! }
        : {}),
      ...((opts.perTaskChatName ?? state.perTaskChatName)
        ? { perTaskChatName: (opts.perTaskChatName ?? state.perTaskChatName)! }
        : {}),
    });

    await this.runLarkCli(
      this.buildPatchCardArgs({
        messageId,
        profile: opts.profile ?? state.profile,
        card,
      }),
      "patch",
    );

    // 回写状态（sessionId → 保留在 state 里，供下次查找）
    //
    // ★ CV R5 MAJOR 修复：**activity 也要持久化**。
    //   用户明确要求「无论有无 task，刷新（消息数 + 最近 msg）都体现在卡片上」。
    //   若终态事件不携带 activity、而 state 又不记，patch 出来的卡就**丢掉
    //   消息数/最近消息** —— 生命周期推进反而把用户要看的信息擦掉了。
    //   策略：本次传入则更新，未传则沿用上一次（有活性就用上一次的快照，
    //   比"什么都没有"更符合"最后已知状态"的语义）。
    this.sessionStates.set(messageId, {
      ...state,
      milestones: mergedMilestones,
      updateCount,
      lifecycle: opts.lifecycle,
      // ★ CV R3 M4 修复：**不要**把 null 塌成 undefined。
      //   null = 「查了，确实没有数据」→ 必须落 state，否则下一次自动 patch
      //   会用上一次的旧快照渲染（用户刚点刷新看到的最新事实被脏值覆盖）。
      //   undefined = 「本次没查」→ 才沿用 state。
      ...(opts.activity !== undefined ? { activity: opts.activity } : {}),
      ...(opts.task !== undefined ? { task: opts.task } : {}),
      // ★ Task #5580：任务列表落 state（否则后续 lifecycle patch 会擦面板）
      ...(opts.tasks !== undefined
        ? { sessionTasks: opts.tasks, taskTotal: opts.tasks.length }
        : {}),
      ...(opts.perTaskChatId ? { perTaskChatId: opts.perTaskChatId } : {}),
      ...(opts.perTaskChatName ? { perTaskChatName: opts.perTaskChatName } : {}),
    });
    this.sessionCardIds.set(opts.sessionId, messageId);
    // ★ Task #5364 返工：task → session 反向索引（旧 task 卡按钮/事件按 taskId 反查）
    if (typeof opts.task?.id === "number") {
      this.taskToSessionId.set(opts.task.id, opts.sessionId);
    }
    return true;
  }

  /** sessionId → messageId 映射（用于「patch 同一张卡」查找） */
  private readonly sessionCardIds = new Map<string, string>();

  /**
   * ★ Task #5364 返工：taskId → sessionId 反向索引。
   *
   * 用途（两处，都是「手里只有 taskId」的场景）：
   * 1. `LarkCliTaskNotifyHook` 收到 task 事件时要知道该 patch **哪张 session 卡**
   *    （一张卡的语义要求 task 更新写进 session 卡，而不是另发 task 卡）
   * 2. 旧 task 卡的「🔄 刷新活性」按钮 value 只有 taskId
   *    （`resolveSessionIdByTask` 端口的同步兜底）
   *
   * ⚠️ 内存索引（进程内）。进程重启后由 hook 层从 lark_card 表 hydrate 补齐。
   */
  private readonly taskToSessionId = new Map<number, string>();

  /** 按 sessionId 找这张卡的状态（找不到 → undefined） */
  private findSessionCardBySessionId(
    sessionId: string,
  ): { messageId: string; state: SessionCardState } | undefined {
    const messageId = this.sessionCardIds.get(sessionId);
    if (!messageId) return undefined;
    const state = this.sessionStates.get(messageId);
    if (!state) return undefined;
    return { messageId, state };
  }

  // ======================================================================
  // ★ Task #5384：**session 卡归属守卫**
  //
  // ## 真机 bug（2026-11-12 12:31，群 oc_xxxxxxxxxxxxxxxx）
  //
  // ```
  // 12:31:00 send  📊 子会话实时更新（真机验证卡片刷新活性） ← 有「🔄 刷新活性」
  // 12:31:18 patch 📊 子会话实时更新（…）                    ← 正常
  // 12:31:23 patch 📊 子会话实时更新（…）                    ← 正常
  // 12:31:23 patch 📊 Task 实时更新（任务）                   ← ★ 同一秒被降级
  // ```
  //
  // #5364 的设计是「一个 session 一张卡，task 更新写进这张 session 卡」
  // （`LarkCliTaskNotifyHook.patchSessionCardForTask` 就是这么做的）。但 notifier
  // 里 task 状态（`states`）与 session 状态（`sessionStates`）是**两张 Map**，
  // `updateTask` / `finishTask` / `pauseTask` / `updateMetaAndBuildCard` 只读
  // `states`，对「这个 messageId 其实是 session 卡」毫无感知 ⇒ `states.get()`
  // 落空 → 占位 `meta:{title:"任务"}` → `buildTaskCard()` 整卡重建 patch 同一
  // messageId ⇒ **session 卡被 task 卡渲染器覆盖降级**：标题变「任务」、
  // 「🔄 刷新活性」按钮物理消失、会话 ID 面板消失。
  //
  // 修法：所有「按 messageId patch」的 task 侧入口，先看这张卡是不是 session 卡；
  // 是 → 走 session 渲染器（保留卡身份 + 把 task 的里程碑/进度/状态并进面板）。
  // ======================================================================

  /** 这个 messageId 是否属于一张 **session 卡**（★ Task #5384 守卫入口）。 */
  isSessionCardMessage(messageId: string): boolean {
    return this.sessionStates.has(messageId);
  }

  /**
   * ★ Task #5602：这个 messageId 是否属于一张 **task 卡**。
   *
   * ## 为什么需要
   *
   * task 卡上的「💬 会话查看」按钮（action=refresh_activity）走
   * session 主键路径；`buildSessionCardWithActivity` 只查
   * `sessionStates` ⇒ task 卡查不到 ⇒ fallback `buildSessionCard`
   * 整卡重建 ⇒ **task 卡被 session 渲染器覆盖**（用户实测：
   * 「📋 任务卡」点一下变成「💬 会话卡」）。
   *
   * handler 据此把 refresh_activity 委托回 task 路径
   * （`handleRefreshActivity`，保持 task 卡身份渲染）。
   *
   * ## 判定来源（两处，覆盖两个生命周期）
   *
   * - 运行中：`states`（`startTask` / `hydrateState` 写入）
   * - 终态后：`finalisedCards`（`finishTask` 会 `states.delete`，
   *   但卡还在飞书里，用户仍可点按钮 —— #5020 终态守卫的集合
   *   恰好就是「曾是 task 卡」的权威记录）
   */
  isTaskCardMessage(messageId: string): boolean {
    return this.states.has(messageId) || this.finalisedCards.has(messageId);
  }

  /**
   * ★ Task #5384：把 **task 侧的更新**应用进 session 卡，返回可 patch 的卡片。
   *
   * 语义（保证「信息一个不少」且「卡身份不变」）：
   * - 卡身份：`buildSessionCard` 渲染 ⇒ header 恒为「📊 子会话实时更新（…）」，
   *   「🔄 刷新活性」按钮与「🆔 会话 ID」面板恒在。
   * - 信息不丢：本次里程碑并进执行动态；task 的 meta/status/progress
   *   合并进「📋 任务信息」面板（carry-forward，未传则沿用上一次）。
   * - 过程步骤（task 侧的 processSteps）没有独立面板，转成里程碑形态并入，
   *   宁可换一种展示也不能丢（用户看的是「发生了什么」）。
   */
  private applyTaskEventToSessionCard(
    messageId: string,
    delta: {
      milestones?: Milestone[];
      processSteps?: ProcessStep[];
      meta?: TaskMeta;
      status?: string;
      progress?: number;
      lifecycle?: SessionCardState["lifecycle"];
      perTaskChatId?: string;
      perTaskChatName?: string;
      clearPerTaskChat?: boolean;
      activity?: SubSessionActivity | null;
      nowIso?: string;
      /**
       * ★ CV R4 MINOR-2：是否推进 `updateCount`（默认推进）。
       *
       * `updateMetaAndBuildCard`（建群/解散群）是同步、无 mutex 的"只改群字段"
       * 路径，不该因为用户点一次建群就把"第 N 次更新"加一（否则与
       * updateTask/finishTask 的计数语义不一致，patch 失败时还会留下偏移）。
       */
      bumpUpdateCount?: boolean;
    },
  ): CardPayload {
    const state = this.sessionStates.get(messageId);
    // ★ CV R2 MINOR-4：不用非空断言 —— 安全性不该只靠「调用方都先 has()」。
    //   真取不到就明确抛错（这是编程错误，不是运行时数据问题）。
    if (!state) {
      throw new Error(
        `applyTaskEventToSessionCard: ${messageId} 不是 session 卡（调用方应先 isSessionCardMessage）`,
      );
    }
    const nowIso = delta.nowIso ?? new Date().toISOString();

    // 1) 执行动态：本次里程碑 + 过程步骤（转里程碑形态，避免信息丢失）
    const stepsAsMilestones: Milestone[] = (delta.processSteps ?? [])
      // ★ CV R2 MINOR-6：title 为空的过程步骤会让 milestoneKey 撞车（互相吞掉），
      //   直接跳过 —— 没有标题的步骤本来也没法在卡上表达。
      .filter((s) => typeof s.title === "string" && s.title.trim() !== "")
      .map((s) => ({
        title: s.title,
        ...(s.timestamp ? { timestamp: s.timestamp } : {}),
        ...(s.description ? { description: s.description } : {}),
      }));
    const mergedMilestones = mergeUnique(
      state.milestones ?? [],
      [...(delta.milestones ?? []), ...stepsAsMilestones],
      milestoneKey,
    );

    // 2) 任务信息面板：本次优先，否则沿用（carry-forward）
    const prevTask = state.task;
    const metaId = delta.meta?.id;
    const metaIdNum =
      typeof metaId === "number"
        ? metaId
        : typeof metaId === "string" && metaId.trim() !== ""
          ? Number(metaId)
          : undefined;
    const hasTaskDelta =
      delta.meta !== undefined ||
      delta.status !== undefined ||
      delta.progress !== undefined;
    // ★ CV R1 MINOR-5：纯 session 卡（从没带过 task）收到带 status 的 task 事件时，
    //   不能凭空渲染一个「#0」幽灵任务面板（噪音）。判据：要么有合法 task id，
    //   要么之前就有任务面板 —— 两者都不成立就**不渲染**面板。
    const hasValidTaskId =
      typeof metaIdNum === "number" && Number.isFinite(metaIdNum) && metaIdNum > 0;
    const shouldRenderTaskPanel = hasValidTaskId || prevTask !== undefined;
    const nextTask: SessionCardState["task"] | undefined =
      hasTaskDelta && shouldRenderTaskPanel
      ? {
          id:
            typeof metaIdNum === "number" && Number.isFinite(metaIdNum)
              ? metaIdNum
              : (prevTask?.id ?? 0),
          ...(delta.meta?.title ?? prevTask?.title
            ? { title: delta.meta?.title ?? prevTask?.title }
            : {}),
          ...(delta.status ?? prevTask?.status
            ? { status: delta.status ?? prevTask?.status }
            : {}),
          ...(delta.progress !== undefined || prevTask?.progress !== undefined
            ? { progress: delta.progress ?? prevTask?.progress }
            : {}),
          ...(delta.meta?.currentStatus ?? prevTask?.currentStatus
            ? { currentStatus: delta.meta?.currentStatus ?? prevTask?.currentStatus }
            : {}),
          ...(delta.meta?.priority ?? prevTask?.priority
            ? { priority: delta.meta?.priority ?? prevTask?.priority }
            : {}),
          ...(delta.meta?.parentTaskId !== undefined || prevTask?.parentTaskId !== undefined
            ? { parentTaskId: delta.meta?.parentTaskId ?? prevTask?.parentTaskId }
            : {}),
          ...(delta.meta?.goals ?? prevTask?.goals
            ? { goals: delta.meta?.goals ?? prevTask?.goals }
            : {}),
          ...(prevTask?.createdAt ? { createdAt: prevTask.createdAt } : {}),
          ...(prevTask?.updatedAt ? { updatedAt: prevTask.updatedAt } : {}),
          // ★ CV R2 MINOR-2：**不再**把 mergedMilestones 塞进任务面板 ——
          //   顶层「📌 执行动态」已经渲染了同一批里程碑，两边都放会让卡片
          //   长度翻倍且内容重复。任务面板只沿用历史遗留值（若有）。
          ...(prevTask?.milestones ? { milestones: prevTask.milestones } : {}),
        }
      : prevTask;

    const perTaskChatId = delta.clearPerTaskChat
      ? undefined
      : (delta.perTaskChatId ?? state.perTaskChatId);
    const perTaskChatName = delta.clearPerTaskChat
      ? undefined
      : (delta.perTaskChatName ?? state.perTaskChatName);

    const lifecycle = delta.lifecycle ?? state.lifecycle ?? "running";
    const bump = delta.bumpUpdateCount !== false;
    const updateCount = bump ? (state.updateCount ?? 1) + 1 : (state.updateCount ?? 1);

    const card = buildSessionCard({
      sessionId: state.sessionId ?? "",
      title: state.title,
      statusPhrase: state.statusPhrase,
      agentType: state.agentType,
      startedAt: state.startedAt,
      elapsedText: state.elapsedText,
      milestones: mergedMilestones,
      lifecycle,
      updateCount,
      ...(delta.activity !== undefined
        ? { activity: delta.activity }
        : state.activity !== undefined
          ? { activity: state.activity }
          : {}),
      // ★ Task #5420（CV MAJOR-1）：沿用 state 的最近消息（不擦面板）
      ...(state.recentMessages !== undefined
        ? { recentMessages: state.recentMessages }
        : {}),
      ...(nextTask !== undefined ? { task: nextTask } : {}),
      ...(perTaskChatId ? { perTaskChatId } : {}),
      ...(perTaskChatName ? { perTaskChatName } : {}),
    });

    // 3) 回写 session 状态（**不删**，刷新/自动同步仍可用）
    this.sessionStates.set(messageId, {
      ...state,
      milestones: mergedMilestones,
      updateCount,
      lifecycle,
      ...(nextTask !== undefined ? { task: nextTask } : {}),
      ...(perTaskChatId ? { perTaskChatId } : { perTaskChatId: undefined }),
      ...(perTaskChatName ? { perTaskChatName } : { perTaskChatName: undefined }),
      ...(delta.activity !== undefined ? { activity: delta.activity } : {}),
    });

    return card;
  }

  /**
   * ★ Task #5364 返工：登记 `taskId → sessionId` 映射（生产装配 / 持久层恢复用）。
   *
   * 为什么暴露成公开方法：hook 层的事件上下文里可能只有 taskId（`task:after.*`
   * 的 payload 不带 sub-session），而卡片更新必须落到 session 卡上。
   */
  bindTaskToSession(taskId: number, sessionId: string): void {
    if (!Number.isFinite(taskId) || taskId <= 0) return;
    if (typeof sessionId !== "string" || !sessionId.trim()) return;
    this.taskToSessionId.set(taskId, sessionId);
  }

  /**
   * ★ Task #5364 返工（BLOCKER-4 重启分支）：**认领**一张已存在的 session 卡。
   *
   * ## 为什么必须有
   *
   * `sessionCardIds` / `sessionStates` 是内存字段。进程重启后它们都是空的，
   * 此时若只靠 `getSessionCardMessageId()` 判断「有没有卡」，答案恒为"没有"
   * ⇒ `upsertSessionCard` 会走 `startSessionCard` 再发一张。
   * 于是**每次重启都会给同一个 session 多一张卡**（用户「一个 session 只有一张卡」
   * 的硬要求被静默破坏）。
   *
   * 本方法让调用方（hook 的 `restoreCardState`）用持久层里的权威 messageId
   * 把内存索引补回来 —— 之后的所有 patch 都会命中同一张卡。
   */
  @TracedAs("lark-card.adopt", {
    recordParams: true,
    paramFilter: (args) => ({ sessionId: args[0], messageId: args[1] }),
  })
  adoptSessionCard(
    sessionId: string,
    messageId: string,
    state?: Partial<SessionCardState>,
  ): void {
    if (!sessionId || !messageId) return;
    this.sessionCardIds.set(sessionId, messageId);
    this.rememberSessionCard(messageId, {
      sessionId,
      ...(state ?? {}),
    });
  }

  /** ★ CV R3 M3：把 session 卡写进持久层（失败只 warn，不阻断发卡） */
  private persistSessionCardRecord(
    sessionId: string,
    messageId: string,
    chatId: string,
    profile?: string,
  ): void {
    if (!this.sessionStore) return;
    try {
      const now = Date.now();
      const existing = this.sessionStore.get(sessionId);
      this.sessionStore.upsert({
        sessionId,
        messageId,
        chatId,
        ...(profile ?? existing?.profile
          ? { profile: profile ?? existing?.profile }
          : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    } catch (err) {
      logger.warn(
        `persistSessionCardRecord failed for ${sessionId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * ★ CV R3 M3：从持久层**回灌**全部已知 session 卡（启动时调用）。
   *
   * 语义：把 `lark_session_card` 里的 `sessionId → messageId` 灌回内存索引，
   * 让重启后的第一次 `upsertSessionCard` 走 **patch** 而不是 `startSessionCard`。
   *
   * @returns 回灌的条数（诊断用）
   */
  @TracedAs("lark-card.restore", { recordParams: false, recordResult: true })
  restoreSessionCardsFromStore(): number {
    if (!this.sessionStore) return 0;
    let n = 0;
    try {
      for (const rec of this.sessionStore.list()) {
        if (!rec.sessionId || !rec.messageId) continue;
        if (this.sessionCardIds.has(rec.sessionId)) continue;
        this.sessionCardIds.set(rec.sessionId, rec.messageId);
        // ★ 必须同时把**最小 state** 种进去：`updateSessionCard` 走
        //   `findSessionCardBySessionId()` → 它要求 `sessionStates` 里有这条
        //   messageId；只填 sessionCardIds 的话仍会判「无卡」→ 又发一张。
        //   （第一版回灌就漏了这一步，被 M3 的守门测试当场抓到。）
        if (!this.sessionStates.has(rec.messageId)) {
          this.sessionStates.set(rec.messageId, {
            ...(rec.profile ? { profile: rec.profile } : {}),
            sessionId: rec.sessionId,
            milestones: [],
            updateCount: 1,
          });
        }
        n += 1;
      }
    } catch (err) {
      logger.warn(
        `restoreSessionCardsFromStore failed: ${(err as Error).message}`,
      );
    }
    if (n > 0) {
      logger.info(`restoreSessionCardsFromStore: 回灌 ${n} 张 session 卡`);
    }
    return n;
  }

  // ======================================================================
  // ★ Task #5397：**session 卡的群状态变化**（建群 / 解散群）
  //
  // ## 为什么需要（用户拍板「做「无 task 也能建群」」）
  //
  // 改造前 session 卡**没有**建群按钮，所以「建群后 patch 卡片」只有 task
  // 路径一条（`updateMetaAndBuildCard` + `applyTaskEventToSessionCard`）。
  // 现在无 task 的卡也能建群 —— 但那条 task 路径要求 meta 里有 task 字段，
  // 无 task 时根本构造不出来。
  //
  // 本方法是**无 task 的对等物**：只改「群」字段（chatId / name），
  // 其余累计状态（标题 / 里程碑 / 活性 / updateCount）原样保留，
  // 并保证**卡身份不变**（仍是 session 卡，不是 task 卡）。
  // ======================================================================
  applySessionGroupChange(
    messageId: string,
    opts: {
      sessionId: string;
      /** 新群 chatId；缺省/空 ⇒ 视为「解散」，清掉卡上的群与链接 */
      perTaskChatId?: string;
      perTaskChatName?: string;
    },
  ): CardPayload | undefined {
    const state = this.sessionStates.get(messageId);
    if (!state) return undefined;

    // 落 state：否则下一次生命周期 patch 会把群链接擦掉（task 路径同款坑）。
    // ⚠️ 这里**不能**用 rememberSessionCard —— 它用 `??` 合并，永远清不掉
    //   已解散的群（undefined 会被旧值接管）。所以直接改 state 并 delete。
    const chatId = opts.perTaskChatId?.trim();
    if (chatId) {
      state.perTaskChatId = chatId;
      if (opts.perTaskChatName) state.perTaskChatName = opts.perTaskChatName;
    } else {
      delete state.perTaskChatId;
      delete state.perTaskChatName;
    }

    return buildSessionCard({
      sessionId: opts.sessionId,
      title: state.title,
      statusPhrase: state.statusPhrase,
      agentType: state.agentType,
      startedAt: state.startedAt,
      elapsedText: state.elapsedText,
      milestones: state.milestones,
      updateCount: state.updateCount,
      lifecycle: state.lifecycle,
      ...(state.activity !== undefined ? { activity: state.activity } : {}),
      // ★ Task #5420（CV MAJOR-1）：群变更重建也沿用最近消息（不擦面板）
      ...(state.recentMessages !== undefined
        ? { recentMessages: state.recentMessages }
        : {}),
      ...(state.task !== undefined ? { task: state.task } : {}),
      ...(state.perTaskChatId ? { perTaskChatId: state.perTaskChatId } : {}),
      ...(state.perTaskChatName ? { perTaskChatName: state.perTaskChatName } : {}),
    });
  }

  /** ★ Task #5364 返工：按 taskId 反查 sessionId（没有 → undefined，**不猜**）。 */
  getSessionIdByTask(taskId: number): string | undefined {
    if (!Number.isFinite(taskId)) return undefined;
    return this.taskToSessionId.get(taskId);
  }

  /** ★ Task #5364 返工：按 sessionId 查已发的卡 messageId（诊断 / 幂等断言用）。 */
  getSessionCardMessageId(sessionId: string): string | undefined {
    return this.sessionCardIds.get(sessionId);
  }

  /** ★ Task #5364 返工：该 session 卡当前的累计状态（**生产形状测试**断言用）。 */
  getSessionCardState(sessionId: string): SessionCardState | undefined {
    const messageId = this.sessionCardIds.get(sessionId);
    if (!messageId) return undefined;
    return this.sessionStates.get(messageId);
  }

  /**
   * ★ Task #5417：把原 session 的进展**双写**到关联群 session 的卡上。
   *
   * ## 设计（方案 A，用户定稿）
   *
   * 新群有自己的卡（session_id = 群 session id = chatId）。
   * 原 session 的进展事件 patch 原卡后，调用方用本方法把同一条
   * 进展同步到新群卡 —— 新群卡的 state **独立累积**（不是复制原卡），
   * 符合 #5364 单卡规格（每 session 每 chat 一张）。
   *
   * ## 语义
   *
   * - `findGroupSession` 未注入 / 反查不到群 / 群 session 就是原 session
   *   ⇒ no-op（返回 false，不报错）
   * - 新群还没有卡 ⇒ `upsertSessionCard` 会为群 session 发首卡
   *   （best-effort；发送失败向上抛，调用方 warn）
   * - 已有卡 ⇒ patch 同一张（不重发）
   *
   * @param originSessionId 原 session id
   * @param opts 与 upsertSessionCard 同形的增量（lifecycle/milestones/…）
   * @param findGroupSession 反查端口（SessionComponent.findGroupChatForSession）
   */
  async syncGroupCardFromOrigin(
    originSessionId: string,
    opts: {
      lifecycle?: "running" | "completed" | "timeout" | "failed" | "stopped";
      milestones?: Array<{ title: string; timestamp: string; description?: string }>;
      title?: string;
    },
    findGroupSession?: (
      sid: string,
    ) => Promise<{ chatId: string; aliasSessionId?: string } | undefined>,
  ): Promise<boolean> {
    if (!findGroupSession) return false;
    let chatId: string | undefined;
    try {
      const group = await findGroupSession(originSessionId);
      chatId = group?.chatId;
    } catch (err) {
      logger.warn(
        `syncGroupCardFromOrigin: findGroupChatForSession(${originSessionId}) 失败（跳过双写）: ` +
          `${(err as Error).message}`,
      );
      return false;
    }
    if (!chatId || chatId === originSessionId) return false;
    try {
      await this.upsertSessionCard({
        chatId,
        sessionId: chatId,
        lifecycle: opts.lifecycle ?? "running",
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.milestones ? { milestones: opts.milestones } : {}),
      });
      return true;
    } catch (err) {
      logger.warn(
        `syncGroupCardFromOrigin: 群卡同步失败（chatId=${chatId}）: ` +
          `${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * ★ CV R4：按 sessionId **复用或新建** session 卡（生命周期推进的正确入口）。
   *
   * - 已有卡 → patch（一张卡承载整个生命周期）
   * - 没有卡 → start（首卡 + pin）
   *
   * 这才是「生命周期事件体现在卡片上」的正确实现；调用方不该自己判断。
   */
  @TracedAs("lark-card.upsert", {
    recordParams: true,
    flattenParamFilter: true,
    paramFilter: (args) => {
      const o = args[0] ?? {};
      return {
        chatId: o.chatId,
        sessionId: o.sessionId,
        title: o.title,
        statusPhrase: o.statusPhrase,
        lifecycle: o.lifecycle,
      };
    },
  })
  async upsertSessionCard(opts: {
    chatId: string;
    profile?: string;
    sessionId: string;
    title?: string;
    statusPhrase?: string;
    agentType?: string;
    startedAt?: string;
    elapsedText?: string;
    milestones?: Milestone[];
    lifecycle: "running" | "completed" | "timeout" | "failed" | "stopped";
    activity?: SubSessionActivity | null;
    /** ★ Task #5364 返工（BLOCKER-5）：session 内的任务信息（合并渲染） */
    task?: Parameters<typeof buildSessionCard>[0]["task"];
    /** ★ Task #5580：该 session 内全部 task 的摘要列表（「🗂️ 任务列表」面板） */
    tasks?: SessionCardTaskSummary[];
    perTaskChatId?: string;
    perTaskChatName?: string;
  }): Promise<{ messageId: string; created: boolean }> {
    // ★ Task #5364 返工（真机竞态，被生产形状测试抓到）：
    //   `upsertSessionCard` 被 fire-and-forget 并发调用（EventHandler 对 session
    //   生命周期事件是 `void sendSessionLifecycleCard(event)`），两个事件同时进来
    //   时，都会先 `updateSessionCard` → 都返回 false（还没卡）→ **各发一张卡**。
    //
    //   这不是理论问题：本任务的端到端接线测试（session-wiring-real-5364）
    //   真实复现了「两个生命周期 → 2 张卡」。
    //
    //   修法：per-session 串行化。同一 session 的 upsert 必须排队，
    //   保证「检查 + 发卡」这段是原子的（不同 session 仍可并行）。
    const mutex = this.sessionUpsertMutexes.get(opts.sessionId) ?? new MutexImpl();
    this.sessionUpsertMutexes.set(opts.sessionId, mutex);
    const result = await mutex.run(async () => {
      const patched = await this.updateSessionCard(opts);
      if (patched) {
        const messageId = this.sessionCardIds.get(opts.sessionId)!;
        return { messageId, created: false };
      }
      const res = await this.startSessionCard(opts);
      return { messageId: res.messageId, created: true };
    });

    // ★ CV R3 m2：**终态**时释放 per-session 锁。
    //   长跑进程（ES 常驻）里 session 数单调增长，不释放就是无界内存泄漏。
    //   卡与 state 保留（刷新/自动同步仍可用），只丢这把"冷启动判断"的锁 ——
    //   终态之后不会再有新的 start，不需要它了。
    if (opts.lifecycle !== "running") {
      this.sessionUpsertMutexes.delete(opts.sessionId);
    }
    return result;
  }

  /**
   * ★ Task #5364 返工：per-session 的 upsert 串行化锁（见 upsertSessionCard 注释）。
   *
   * key = sessionId；只保护「读有没有卡 → 决定 start/update」这一段，
   * 不保护 patch 本身（那个有 `mutexFor(messageId)` 自己的锁）。
   */
  private readonly sessionUpsertMutexes = new Map<string, MutexImpl>();

  /**
   * ★ CV R3 BLOCKER-2：**首次发 session 卡**（无 task 的 sub-session 也要有卡）。
   *
   * 与 `startTask` 并列：同一个 notifier、同一套 send/pin 基础设施，
   * 只是渲染 `buildSessionCard` 且状态存进 `sessionStates`。
   *
   * 发完把 messageId 记进 `sessionStates`，之后 `buildSessionCardWithActivity`
   * 才能 patch 同一张卡（而不是每次刷新都 fallback 重建）。
   */
  async startSessionCard(opts: {
    chatId: string;
    profile?: string;
    sessionId: string;
    title?: string;
    statusPhrase?: string;
    agentType?: string;
    startedAt?: string;
    elapsedText?: string;
    milestones?: Milestone[];
    lifecycle?: "running" | "completed" | "timeout" | "failed" | "stopped";
    /** ★ CV R5：首卡也记下活性（后续 patch 未传时可沿用） */
    activity?: SubSessionActivity | null;
    /**
     * ★ Task #5364 返工（BLOCKER-5）：首卡就带上 task 区块。
     *
     * 上一版首卡不传 task ⇒ task 卡链路独立再发一张 ⇒ 两张并列。
     * 用户 08:13 定稿：**一张 session 卡**，task 信息是卡上的区块。
     */
    task?: Parameters<typeof buildSessionCard>[0]["task"];
    /** ★ Task #5580：该 session 内全部 task 的摘要列表（首卡就带上） */
    tasks?: SessionCardTaskSummary[];
    perTaskChatId?: string;
    perTaskChatName?: string;
  }): Promise<StartTaskResult> {
    const card = buildSessionCard({
      sessionId: opts.sessionId,
      title: opts.title,
      statusPhrase: opts.statusPhrase,
      agentType: opts.agentType,
      startedAt: opts.startedAt,
      elapsedText: opts.elapsedText,
      milestones: opts.milestones,
      lifecycle: opts.lifecycle,
      updateCount: 1,
      ...(opts.activity !== undefined ? { activity: opts.activity } : {}),
      ...(opts.task !== undefined ? { task: opts.task } : {}),
      ...(opts.tasks !== undefined
        ? { tasks: opts.tasks, taskTotal: opts.tasks.length }
        : {}),
      ...(opts.perTaskChatId ? { perTaskChatId: opts.perTaskChatId } : {}),
      ...(opts.perTaskChatName ? { perTaskChatName: opts.perTaskChatName } : {}),
    });

    const stdout = await this.runLarkCli(
      this.buildSendCardArgs({ chatId: opts.chatId, profile: opts.profile, card }),
      "send",
    );

    const messageId = this.extractMessageId(stdout);
    if (!messageId) {
      throw new Error(
        `lark-cli +messages-send did not return message_id: ${stdout.slice(0, 500)}`,
      );
    }

    // 记住累计状态，供后续刷新 patch 同一张卡（否则永远 fallback 重建）
    this.sessionCardIds.set(opts.sessionId, messageId);
    // ★ Task #5364 返工：task → session 反向索引（供旧 task 卡/事件按 taskId 反查）
    if (typeof opts.task?.id === "number" && opts.task.id > 0) {
      this.taskToSessionId.set(opts.task.id, opts.sessionId);
    }
    this.rememberSessionCard(messageId, {
      profile: opts.profile,
      sessionId: opts.sessionId,
      title: opts.title,
      statusPhrase: opts.statusPhrase,
      agentType: opts.agentType,
      startedAt: opts.startedAt,
      elapsedText: opts.elapsedText,
      milestones: opts.milestones ?? [],
      updateCount: 1,
      lifecycle: opts.lifecycle,
      ...(opts.activity !== undefined ? { activity: opts.activity } : {}),
      ...(opts.task !== undefined ? { task: opts.task } : {}),
      ...(opts.tasks !== undefined
        ? { sessionTasks: opts.tasks, taskTotal: opts.tasks.length }
        : {}),
      ...(opts.perTaskChatId ? { perTaskChatId: opts.perTaskChatId } : {}),
      ...(opts.perTaskChatName ? { perTaskChatName: opts.perTaskChatName } : {}),
    });

    // pin（与 task 卡同策略：失败不影响卡片可见性）
    let pinned = false;
    let pinError: string | undefined;
    if (this.options.pinOnStart) {
      try {
        await this.pinMessage(messageId, opts.profile);
        pinned = true;
      } catch (err) {
        pinError = (err as Error).message;
      }
    }

    // ★ CV R3 M3：**落库**（重启后靠它认领同一张卡，否则又发一张）。
    //   best-effort：持久化失败绝不影响发卡。
    this.persistSessionCardRecord(opts.sessionId, messageId, opts.chatId, opts.profile);

    return { messageId, pinned, ...(pinError ? { pinError } : {}) };
  }

  /**
   * ★ 补充需求（22:31）—— session-only 卡片按 messageId 重建（带活性）。
   *
   * 与 `buildCardWithActivity` 的区别：那个按 messageId 取 **task** 卡的
   * 累计状态；session 卡的状态另存一份（`sessionStates`），互不干扰。
   *
   * 返回 `undefined` = 本 notifier 没有这张 session 卡的状态（重启未 hydrate）
   * ⇒ 调用方 fallback 重建。session 卡没有 task 的 title/status 可丢，
   * 所以重建损失最小。
   */
  buildSessionCardWithActivity(
    messageId: string,
    sessionId: string,
    activity: SubSessionActivity | null,
    opts: {
      now?: number;
      /** ★ 澄清 22:37：session 层生命周期（完成/超时/停止） */
      lifecycle?: "running" | "completed" | "timeout" | "failed" | "stopped";
      /** ★ 澄清 22:37：关联 task 的增强信息（有则渲染任务面板） */
      task?: Parameters<typeof buildSessionCard>[0]["task"];
      /**
       * ★ Task #5420：最近消息列表（「💬 会话查看」面板）。
       * undefined = 本次没查（沿用 state 里的上次值，与 activity 同语义）。
       */
      recentMessages?: ActivityMessage[] | ToolCallView[];
      /**
       * ★ Task #5580：该 session 的全部 task 摘要（「🗂️ 任务列表」面板）。
       * undefined = 本次没查（沿用 state）；[] = 查了确实没有（不渲染面板）。
       */
      sessionTasks?: SessionCardTaskSummary[];
      /** ★ Task #5580：当前选中的任务（点 select_task 后的焦点） */
      selectedTask?: Parameters<typeof buildSessionCard>[0]["selectedTask"];
      /** ★ Task #5580：选中任务的里程碑（「📌 任务里程碑」区） */
      selectedTaskMilestones?: Milestone[];
    } = {},
  ): CardPayload | undefined {
    const state = this.sessionStates.get(messageId);
    if (!state) return undefined;

    const card = buildSessionCard({
      sessionId,
      title: state.title,
      statusPhrase: state.statusPhrase,
      agentType: state.agentType,
      startedAt: state.startedAt,
      elapsedText: state.elapsedText,
      milestones: state.milestones,
      updateCount: state.updateCount,
      activity,
      // 刷新时传入的 task/lifecycle 优先（它们是最新事实），
      // 其次回落到首次发卡时记住的值。
      ...(opts.lifecycle !== undefined
        ? { lifecycle: opts.lifecycle }
        : state.lifecycle !== undefined
          ? { lifecycle: state.lifecycle }
          : {}),
      // ★ Task #5364 返工（BLOCKER-5）：刷新时若端口没取到 task（读失败/无 task
      //   端口），**沿用首卡记住的 task** —— 否则用户点一次刷新就把任务信息
      //   面板擦掉了，正是「原有信息一个不少」的反例。
      ...(opts.task !== undefined
        ? { task: opts.task }
        : state.task !== undefined
          ? { task: state.task }
          : {}),
      ...(state.perTaskChatId ? { perTaskChatId: state.perTaskChatId } : {}),
      ...(state.perTaskChatName ? { perTaskChatName: state.perTaskChatName } : {}),
      // ★ Task #5420：本次查了用本次；没查沿用 state 里上次的（不擦面板）
      ...(opts.recentMessages !== undefined
        ? { recentMessages: opts.recentMessages }
        : state.recentMessages !== undefined
          ? { recentMessages: state.recentMessages }
          : {}),
      // ★ Task #5580：任务列表 / 选中任务 / 里程碑 —— 本次优先，否则沿用 state
      ...(opts.sessionTasks !== undefined
        ? { tasks: opts.sessionTasks }
        : state.sessionTasks !== undefined
          ? { tasks: state.sessionTasks }
          : {}),
      ...(state.taskTotal !== undefined ? { taskTotal: state.taskTotal } : {}),
      ...(opts.selectedTask !== undefined
        ? { selectedTask: opts.selectedTask }
        : state.selectedTask !== undefined
          ? { selectedTask: state.selectedTask }
          : {}),
      ...(opts.selectedTaskMilestones !== undefined
        ? { selectedTaskMilestones: opts.selectedTaskMilestones }
        : state.selectedTaskMilestones !== undefined
          ? { selectedTaskMilestones: state.selectedTaskMilestones }
          : {}),
      ...(opts.now !== undefined ? { activityNow: opts.now } : {}),
    });

    // ★ Task #5364 返工：刷新是「最新事实」的写入点 —— 把本次 task 快照也
    //   记回 state，下一次 patch（自动同步）才有得沿用。
    if (opts.task !== undefined) {
      this.rememberSessionCard(messageId, { task: opts.task });
      if (typeof opts.task.id === "number" && opts.task.id > 0) {
        this.taskToSessionId.set(opts.task.id, sessionId);
      }
    }
    // ★ Task #5420：recentMessages 同 activity 的三态语义 ——
    //   [] 也是确定事实（查了没有），要落 state；仅 undefined 不改。
    if (opts.recentMessages !== undefined) {
      this.rememberSessionCard(messageId, {
        recentMessages: opts.recentMessages,
      });
    }
    if (opts.lifecycle !== undefined) {
      this.rememberSessionCard(messageId, { lifecycle: opts.lifecycle });
    }
    // ★ Task #5580：任务列表 / 选中任务 / 里程碑同样是「最新事实」，落 state
    //   供后续 patch（自动同步 / 生命周期推进）沿用 —— 否则下一次 lifecycle
    //   事件会把任务列表面板与里程碑区擦掉。
    if (opts.sessionTasks !== undefined) {
      this.rememberSessionCard(messageId, {
        sessionTasks: opts.sessionTasks,
        taskTotal: opts.sessionTasks.length,
      });
    }
    if (opts.selectedTask !== undefined) {
      this.rememberSessionCard(messageId, { selectedTask: opts.selectedTask });
    }
    if (opts.selectedTaskMilestones !== undefined) {
      this.rememberSessionCard(messageId, {
        selectedTaskMilestones: opts.selectedTaskMilestones,
      });
    }
    // ★ CV R3 M4：**null 也要落 state**。
    //   `activity === null` 是「查了，确实没有数据」这一确定事实；不写进 state
    //   的话，下一次自动 patch 会沿用**上一次**的旧快照（用户刚点刷新看到的
    //   最新事实被脏值覆盖），正是 reviewer 指出的语义相反。
    //   仅 `undefined`（本次没查）才不改 state。
    if (activity !== undefined) {
      this.rememberSessionCard(messageId, { activity });
    }

    return card;
  }

  /**
   * ★ 补充需求（22:31）—— 记录 session 卡的累计状态（供 refresh 重建）。
   *
   * 只存渲染必需的最小字段，不存活性快照本身（活性每次刷新都要重读，
   * 缓存它会显示过期数据 —— 那正是用户点刷新要避免的）。
   */
  rememberSessionCard(
    messageId: string,
    state: {
      title?: string;
      statusPhrase?: string;
      agentType?: string;
      startedAt?: string;
      elapsedText?: string;
      milestones?: Milestone[];
      updateCount?: number;
      /** ★ 澄清 22:37：session 层生命周期 */
      lifecycle?: "running" | "completed" | "timeout" | "failed" | "stopped";
      /** ★ CV R4：patch 时要用 profile（多 appId）与 sessionId（反查） */
      profile?: string;
      sessionId?: string;
      /** ★ CV R5：上次的活性快照 */
      activity?: SubSessionActivity | null;
      /** ★ Task #5420：上次的最近消息列表 */
      recentMessages?: ActivityMessage[] | ToolCallView[];
      /** ★ Task #5580：session 内的任务列表 / 总数 / 选中任务 / 里程碑 */
      sessionTasks?: SessionCardTaskSummary[];
      taskTotal?: number;
      selectedTask?: NonNullable<Parameters<typeof buildSessionCard>[0]["selectedTask"]>;
      selectedTaskMilestones?: Milestone[];
      /** ★ Task #5364 返工：任务区块 + 专属群（合并渲染） */
      task?: NonNullable<Parameters<typeof buildSessionCard>[0]["task"]>;
      perTaskChatId?: string;
      perTaskChatName?: string;
    },
  ): void {
    const prev = this.sessionStates.get(messageId);
    this.sessionStates.set(messageId, {
      title: state.title ?? prev?.title,
      statusPhrase: state.statusPhrase ?? prev?.statusPhrase,
      agentType: state.agentType ?? prev?.agentType,
      startedAt: state.startedAt ?? prev?.startedAt,
      elapsedText: state.elapsedText ?? prev?.elapsedText,
      milestones: state.milestones ?? prev?.milestones ?? [],
      updateCount: state.updateCount ?? prev?.updateCount ?? 1,
      lifecycle: state.lifecycle ?? prev?.lifecycle,
      profile: state.profile ?? prev?.profile,
      sessionId: state.sessionId ?? prev?.sessionId,
      // ★ CV R5：activity 也要落盘（否则 patch 未传时无从沿用）
      // ★ CV R3 M4：state 里显式 null 也要写入（三态完整保留）
      activity:
        state.activity !== undefined ? state.activity : prev?.activity,
      // ★ Task #5420：recentMessages 同 activity 语义（[] 也是事实）
      recentMessages:
        state.recentMessages !== undefined
          ? state.recentMessages
          : prev?.recentMessages,
      // ★ Task #5364 返工：task 区块同样 carry-forward（一次带上，后续不丢）
      task: state.task ?? prev?.task,
      perTaskChatId: state.perTaskChatId ?? prev?.perTaskChatId,
      perTaskChatName: state.perTaskChatName ?? prev?.perTaskChatName,
      // ★ Task #5580：任务列表 / 总数 / 选中任务 / 里程碑 —— 同 carry-forward 语义
      sessionTasks:
        state.sessionTasks !== undefined ? state.sessionTasks : prev?.sessionTasks,
      taskTotal: state.taskTotal ?? prev?.taskTotal,
      selectedTask: state.selectedTask ?? prev?.selectedTask,
      selectedTaskMilestones:
        state.selectedTaskMilestones !== undefined
          ? state.selectedTaskMilestones
          : prev?.selectedTaskMilestones,
    });
  }

  /**
   * ★ Task #5020 —— 已经走到**真终态**的卡片（review round-4 MAJOR）。
   *
   * ## 为什么需要（结构性地堵住竞态，而不是靠时序检查）
   *
   * `finishTask` 结束后会 `states.delete(messageId)`。此时若有**另一个**
   * 已经通过前置检查、正在等 mutex 的 `updateTask` 排队进来，它会因为
   * 「state 不存在」而用空默认 state 重建卡片 → 把「已完成」刷回「进行中」
   * 且清空里程碑。
   *
   * 前置检查（`cardMessageIds` / ledger status）只能挡住**还没开始**的补发；
   * 已经进入 `mutexFor(messageId)` 队列的那一个挡不住。所以必须在
   * notifier 内部——也就是唯一串行化那一步——做终态守卫。
   *
   * 记 messageId 而不是 taskId：reopen 场景会发一张**新卡**（新 messageId），
   * 不会被旧 messageId 的终态记录误伤。
   */
  private finalisedCards = new Set<string>();

  /**
   * ★ Task #5182 follow-up：解除某张卡片的终态标记（reopen 用）。
   *
   * ## 为什么需要
   *
   * `finalisedCards` 守卫（Task #5020）会吞掉 finishTask 之后的
   * 一切 updateTask —— 这对「迟到的并发更新」是正确语义，但对
   * **reopen**（closed 卡片 + 任务重新激活 → 复用原卡）是错的：
   * reopen 本来就是要"复活"这张卡。真网取证（2026-11-08 18:00）：
   * reopenReuseCard 打了「已复用原卡」日志 + pin 成功，但 patch
   * 被守卫静默吞掉，卡片内容停在「已完成」。
   *
   * ## 行为
   *
   * - 从 finalisedCards 删除 messageId（守卫解除）
   * - 内存态不存在时从 exportState 快照恢复？—— 不，states 已被
   *   finishTask delete，快照无从取。调用方（reopenReuseCard）
   *   会经 mergeTimelineState/updateTask 的默认 state 重建时间线，
   *   并由 hook 层 hydrate（restoreCardState → hydrateState）补齐。
   * - 对未终结的卡是 no-op（finalisedCards 本就没有该 id）
   */
  unfinaliseCard(messageId: string): void {
    this.finalisedCards.delete(messageId);
  }

  /**
   * ★ Task #5182 follow-up：测试注入点 —— 替换 runLarkCli 的执行器。
   * 仅测试使用（生产路径不设置），避免真 spawn lark-cli。
   */
  testRunner?: (argv: string[], op: string) => Promise<string>;

  /** 诊断：当前跟踪中的卡片数（测试/自检用） */
  trackedCardCount(): number {
    return this.states.size;
  }

  /** 诊断：当前跟踪中的 workflow 卡片数（测试/自检用） */
  trackedWorkflowCardCount(): number {
    return this.workflowStates.size;
  }

  // ========================================================================
  // Workflow 生命周期（Part 2：复用同一套卡片基础设施）
  // ========================================================================

  /**
   * 发送 workflow 初始卡片 → 拿到 messageId → pin（置顶）
   *
   * 与 {@link startTask} 同构：同样的 send 参数契约、同样的 pin 参数契约、
   * 同样的"pin 失败非致命"语义。差别只在渲染的是 workflow 卡片。
   */
  @TracedAs("lark-card.startWorkflow", {
    recordParams: true,
    recordResult: true,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      chatId: args[0]?.chatId,
      profile: args[0]?.profile,
      runId: args[0]?.meta?.runId,
      totalNodes: args[0]?.totalNodes,
    }),
    resultFilter: (r: StartTaskResult | undefined) => ({
      messageId: r?.messageId,
      pinned: r?.pinned,
    }),
  })
  async startWorkflow(opts: StartWorkflowOptions): Promise<StartTaskResult> {
    const now = new Date().toISOString();
    const spinner = SPINNER_EMOJIS[0];
    const milestones: Milestone[] = opts.milestones?.length
      ? opts.milestones
      : [{ title: "Workflow 启动", timestamp: now }];
    const processSteps: ProcessStep[] = opts.processSteps ?? [];

    const card = buildWorkflowCard({
      status: "running",
      meta: opts.meta,
      milestones,
      processSteps,
      totalNodes: opts.totalNodes,
      completedNodes: opts.completedNodes ?? 0,
      updateCount: 1,
      spinner,
    });

    const stdout = await this.runLarkCli(
      this.buildSendCardArgs({ chatId: opts.chatId, profile: opts.profile, card }),
      "send"
    );

    const messageId = this.extractMessageId(stdout);
    if (!messageId) {
      throw new Error(
        `lark-cli +messages-send did not return message_id: ${stdout.slice(0, 500)}`
      );
    }

    this.workflowStates.set(messageId, {
      chatId: opts.chatId,
      profile: opts.profile,
      meta: opts.meta,
      startedAt: now,
      updateCount: 1,
      spinnerIndex: 0,
      milestones,
      processSteps,
      completedNodes: opts.completedNodes ?? 0,
      totalNodes: opts.totalNodes,
      status: "running",
    });

    let pinned = false;
    let pinError: string | undefined;
    if (this.options.pinOnStart) {
      try {
        await this.runLarkCli(
          this.buildPinArgs({ messageId, profile: opts.profile }),
          "pin"
        );
        pinned = true;
      } catch (pinErr) {
        pinError = (pinErr as Error).message;
        logger.warn(
          `Pin failed (non-fatal) for workflow message ${messageId}: ${pinError}`
        );
      }
    }

    return { messageId, pinned, pinError };
  }

  /**
   * Patch 同一张 workflow 卡片（状态/进度/当前节点 + 累积里程碑与过程时间线）
   *
   * 与 {@link updateTask} 同构（mutex 串行化、时间线 append+去重、spinner 轮换）。
   */
  @TracedAs("lark-card.updateWorkflow", {
    recordParams: true,
    recordResult: false,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      messageId: args[0]?.messageId,
      profile: args[0]?.profile,
      status: args[0]?.status,
      currentNode: args[0]?.currentNode,
      completedNodes: args[0]?.completedNodes,
      totalNodes: args[0]?.totalNodes,
      newMilestones: args[0]?.milestones?.length ?? 0,
      newProcessSteps: args[0]?.processSteps?.length ?? 0,
    }),
  })
  async updateWorkflow(opts: UpdateWorkflowOptions): Promise<void> {
    await this.mutexFor(opts.messageId).run(async () => {
      // ★ Task #5020（review round-5 MAJOR）—— workflow 卡片同样需要终态守卫。
      //   与 `updateTask` 完全同构：位置必须在 mutex 内、读 state 之前，
      //   否则一个已排队的迟到更新会在 `finishWorkflow` 清 state 之后
      //   用默认 state 把终态卡重建回 running。
      if (this.finalisedCards.has(opts.messageId)) {
        logger.debug(
          `updateWorkflow: message ${opts.messageId} 已是终态卡片，忽略迟到的更新`
        );
        return;
      }

      const state = this.workflowStates.get(opts.messageId) ?? {
        chatId: opts.chatId ?? "",
        profile: opts.profile,
        meta: opts.meta ?? { runId: opts.messageId },
        startedAt: new Date().toISOString(),
        updateCount: 0,
        spinnerIndex: 0,
        milestones: [],
        processSteps: [],
        status: "running" as WorkflowCardStatus,
      };

      const mergedMilestones = mergeUnique(
        state.milestones,
        opts.milestones ?? [],
        milestoneKey
      );
      const mergedSteps = mergeUnique(
        state.processSteps,
        opts.processSteps ?? [],
        processStepKey
      );

      const updateCount = state.updateCount + 1;
      const spinner = SPINNER_EMOJIS[updateCount % SPINNER_EMOJIS.length];
      const status = opts.status ?? state.status ?? "running";
      const completedNodes = opts.completedNodes ?? state.completedNodes;
      const totalNodes = opts.totalNodes ?? state.totalNodes;

      const card = buildWorkflowCard({
        status,
        meta: mergeWorkflowMeta(state.meta, opts.meta),
        progress: opts.progress ?? state.progress,
        completedNodes,
        totalNodes,
        currentNode: opts.currentNode,
        currentNodeType: opts.currentNodeType,
        durationMs: opts.durationMs ?? state.durationMs,
        error: opts.error ?? state.error,
        milestones: mergedMilestones,
        processSteps: mergedSteps,
        updateCount,
        spinner,
      });

      await this.runLarkCli(
        this.buildPatchCardArgs({
          messageId: opts.messageId,
          profile: opts.profile ?? state.profile,
          card,
        }),
        "patch"
      );

      this.workflowStates.set(opts.messageId, {
        ...state,
        chatId: opts.chatId ?? state.chatId,
        profile: opts.profile ?? state.profile,
        meta: mergeWorkflowMeta(state.meta, opts.meta),
        updateCount,
        spinnerIndex: spinnerIndexFor(updateCount),
        milestones: mergedMilestones,
        processSteps: mergedSteps,
        progress: opts.progress ?? state.progress,
        completedNodes,
        totalNodes,
        durationMs: opts.durationMs ?? state.durationMs,
        error: opts.error ?? state.error,
        status,
      });
    });
  }

  /**
   * 结束 workflow：patch 终态（completed 绿 / failed 红 / stopped 灰）→ unpin → 清理跟踪
   *
   * 与 {@link finishTask} 同构：终态里程碑 append、completed 强制 100%、
   * unpin 非致命、最后清理内存（避免泄漏）。
   */
  @TracedAs("lark-card.finishWorkflow", {
    recordParams: true,
    recordResult: false,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      messageId: args[0]?.messageId,
      profile: args[0]?.profile,
      status: args[0]?.status,
      runId: args[0]?.meta?.runId,
    }),
  })
  async finishWorkflow(opts: FinishWorkflowOptions): Promise<void> {
    await this.mutexFor(opts.messageId).run(async () => {
      const state = this.workflowStates.get(opts.messageId);
      const now = new Date().toISOString();
      const updateCount = (state?.updateCount ?? 0) + 1;
      const spinner = SPINNER_EMOJIS[updateCount % SPINNER_EMOJIS.length];

      const titleByStatus: Record<FinishWorkflowOptions["status"], string> = {
        completed: "Workflow 完成",
        failed: "Workflow 失败",
        stopped: "Workflow 停止",
      };
      const finalMilestone: Milestone = {
        title: titleByStatus[opts.status],
        timestamp: now,
        description: opts.finalStep,
      };

      const completedNodes = opts.completedNodes ?? state?.completedNodes;
      const totalNodes = opts.totalNodes ?? state?.totalNodes;

      const card = buildWorkflowCard({
        status: opts.status,
        meta: mergeWorkflowMeta(state?.meta, opts.meta),
        progress:
          opts.status === "completed"
            ? 100
            : opts.progress ?? state?.progress,
        completedNodes,
        totalNodes,
        durationMs: opts.durationMs ?? state?.durationMs,
        error: opts.error ?? state?.error,
        milestones: mergeUnique(
          state?.milestones ?? [],
          [finalMilestone],
          milestoneKey
        ),
        processSteps: state?.processSteps ?? [],
        updateCount,
        spinner,
      });

      await this.runLarkCli(
        this.buildPatchCardArgs({
          messageId: opts.messageId,
          profile: opts.profile ?? state?.profile,
          card,
        }),
        "patch"
      );

      // ★ Task #5020 —— 与 finishTask 同构：终态标记落在 mutex 内，
      //   与 terminal patch 原子生效，堵住「标记晚于临界区释放」的窗口。
      this.finalisedCards.add(opts.messageId);
    });

    // unpin（非致命）
    if (this.options.unpinOnFinish) {
      const state = this.workflowStates.get(opts.messageId);
      try {
        await this.runLarkCli(
          this.buildUnpinArgs({
            messageId: opts.messageId,
            profile: opts.profile ?? state?.profile,
          }),
          "unpin"
        );
      } catch (unpinErr) {
        logger.warn(
          `Unpin failed (non-fatal) for workflow ${opts.messageId}: ${(unpinErr as Error).message}`
        );
      }
    }

    // 清理内存（避免泄漏）
    this.workflowStates.delete(opts.messageId);
    this.mutexes.delete(opts.messageId);
  }

  // ========================================================================
  // Args 构建（独立可测）
  // ========================================================================

  /**
   * 构建 `im +messages-send` 的 args（卡片模式）
   *
   * 关键点（官方 lark-cli 文档 + 2026-10-15 tongzhuli profile 实测）：
   * - --msg-type interactive
   * - --content 是 **card JSON 字符串**（不包裹 {"content": "..."}）
   *   - post 格式才用 {"zh_cn":{"content":[[{"tag":"md","text":"..."}]]}} 包裹
   *   - interactive 卡片直接传 card JSON（header + body）
   *   - 误用 post 格式 → 飞书 API 报错 code 230099 / ext 200621 "parse card json err"
   * - --as bot（否则用 user 身份，bot 才能在群里发卡片）
   * - profile 注入到 args 头部
   */
  buildSendCardArgs(opts: {
    chatId: string;
    profile?: string;
    card: CardPayload;
  }): string[] {
    const args: string[] = [
      "im",
      "+messages-send",
      "--chat-id",
      opts.chatId,
      "--msg-type",
      "interactive",
      "--content",
      JSON.stringify(opts.card),
      "--as",
      "bot",
    ];

    if (opts.profile) {
      args.unshift("--profile", opts.profile);
    }

    return args;
  }

  /**
   * 构建 `im messages patch` 的 args
   *
   * ★ Task #4230 修复：patch **只**接受 `--data '{"content":"<card JSON 字符串>"}'`。
   *   传 `--content` 会报 `unknown flag "--content"`（秒失败）→ 卡片永远不更新。
   *   content 必须是 **JSON 序列化后的字符串**（second stringify）。
   */
  buildPatchCardArgs(opts: {
    messageId: string;
    profile?: string;
    card: CardPayload;
  }): string[] {
    const data = JSON.stringify({ content: JSON.stringify(opts.card) });

    const args: string[] = [
      "im",
      "messages",
      "patch",
      "--message-id",
      opts.messageId,
      "--data",
      data,
      "--as",
      "bot",
    ];

    if (opts.profile) {
      args.unshift("--profile", opts.profile);
    }

    return args;
  }

  /**
   * 构建 `im pins create` 的 args（置顶卡片）
   *
   * ★ Task #4230 修复：pins create **只**接受 `--data '{"message_id":"om_xxx"}'`。
   *   旧实现传 `--chat-id/--message-id` → `unknown flag "--chat-id"` → pin 永远失败。
   */
  buildPinArgs(opts: {
    messageId: string;
    profile?: string;
  }): string[] {
    const args: string[] = [
      "im",
      "pins",
      "create",
      "--data",
      JSON.stringify({ message_id: opts.messageId }),
      "--as",
      "bot",
    ];

    if (opts.profile) {
      args.unshift("--profile", opts.profile);
    }

    return args;
  }

  /**
   * 构建 `im pins delete` 的 args（取消置顶）
   *
   * ★ Task #4230 修复：pins delete 是 high-risk-write，**必须**带 `--yes`，
   *   否则 lark-cli 拒绝执行 → unpin 静默失败。
   */
  buildUnpinArgs(opts: {
    messageId: string;
    profile?: string;
  }): string[] {
    const args: string[] = [
      "im",
      "pins",
      "delete",
      "--message-id",
      opts.messageId,
      "--yes",
      "--as",
      "bot",
    ];

    if (opts.profile) {
      args.unshift("--profile", opts.profile);
    }

    return args;
  }

  // ========================================================================
  // lark-cli 调用（spawn）
  // ========================================================================

  /**
   * 调 lark-cli（spawn）并把 args/exit code 记进 span
   *
   * ★ Task #4230：加上 @TracedAs，让 `debug trace` 能直接看到
   *   send/patch/pin/unpin 每一步的真实 args + 退出码（旧版这些内部方法没有
   *   span，patch 失败只能在日志里翻，trace 树断在 lark-cli-task-notify.execute）。
   */
  @TracedAs("lark-card.runLarkCli", {
    recordParams: true,
    recordResult: true,
    flattenParamFilter: true,
    paramFilter: (args) => {
      const argv: string[] = args[0] ?? [];
      const op: string = args[1] ?? "unknown";
      return {
        op,
        argv: argv.join(" ").slice(0, 300),
        hasProfile: argv.includes("--profile"),
        msgType: valueAfter(argv, "--msg-type"),
        // 卡片内容不打全（trace 体太大），只记长度
        contentLength: (valueAfter(argv, "--content") ?? "").length,
        dataLength: (valueAfter(argv, "--data") ?? "").length,
      };
    },
    resultFilter: (r: string | undefined) => ({
      stdoutLength: (r ?? "").length,
    }),
  })
  private runLarkCli(argv: string[], op: string): Promise<string> {
    // ★ 测试注入点（Task #5182 follow-up）：runner 可被测试替换，
    //   避免真 spawn lark-cli（invalid receive_id / 真网副作用）。
    if (this.testRunner) {
      return this.testRunner(argv, op);
    }
    return new Promise((resolve, reject) => {
      if (process.env.ROY_HOOK_DEBUG === "1") {
        console.error(
          `[DEBUG LarkCardPatchNotifier.runLarkCli] op=${op} args=${JSON.stringify(argv).slice(0, 300)}`
        );
      }
      const proc = spawn("lark-cli", argv, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (process.env.ROY_HOOK_DEBUG === "1") {
          console.error(
            `[DEBUG LarkCardPatchNotifier.runLarkCli] op=${op} CLOSE code=${code} stdoutLen=${stdout.length} stderrLen=${stderr.length}`
          );
        }
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `lark-cli ${op} exited with code ${code}: ${sanitize(stderr || stdout)}`
            )
          );
        }
      });

      proc.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * 从 lark-cli +messages-send 响应里提取 message_id
   *
   * 响应格式：{"ok": true, "data": {"message_id": "om_xxx"}}
   */
  private extractMessageId(stdout: string): string | undefined {
    try {
      const obj = JSON.parse(stdout);
      const data = obj?.data ?? obj;
      const id =
        data?.message_id ??
        data?.messageId ??
        obj?.message_id ??
        obj?.messageId;
      return typeof id === "string" ? id : undefined;
    } catch {
      return undefined;
    }
  }
}

// ========================================================================
// 私有 helpers
// ========================================================================

/**
 * 合并任务元信息：新值优先，缺省沿用旧值
 *
 * 用于 updateTask 未传完整 meta 时（例如只补 progress）仍能保持栏位区块稳定。
 */
function mergeTaskMeta(base?: TaskMeta, incoming?: TaskMeta): TaskMeta {
  const merged: TaskMeta = { ...(base ?? {}) };
  if (!incoming) return merged;
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || v === null || v === "") continue;
    (merged as Record<string, unknown>)[k] = v;
  }
  return merged;
}

/**
 * 合并 workflow 运行元信息：新值优先，缺省沿用旧值
 *
 * 与 {@link mergeTaskMeta} 同理，保证 updateWorkflow 未传完整 meta 时
 * 栏位区块（workflow 名 / runId）稳定。
 */
function mergeWorkflowMeta(
  base?: WorkflowMeta,
  incoming?: WorkflowMeta
): WorkflowMeta {
  const merged: WorkflowMeta = { runId: base?.runId ?? incoming?.runId ?? "" };
  const assign = (src?: WorkflowMeta): void => {
    if (!src) return;
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || v === null || v === "") continue;
      (merged as unknown as Record<string, unknown>)[k] = v;
    }
  };
  assign(base);
  assign(incoming);
  return merged;
}

/** append + 去重（保持顺序：已有在前，新增在后） */
function mergeUnique<T>(
  base: T[],
  incoming: T[],
  keyOf: (item: T) => string
): T[] {
  const seen = new Set(base.map(keyOf));
  const merged = [...base];
  for (const item of incoming) {
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(item);
  }
  return merged;
}

/** updateCount → spinner 索引（跳过索引 0：初始卡已用过第一个 emoji） */
function spinnerIndexFor(updateCount: number): number {
  return updateCount % SPINNER_EMOJIS.length;
}

/** 取 args 中某 flag 的下一个值 */
function valueAfter(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

/**
 * 清洗 lark-cli 输出（去掉 _notice 升级提示等噪音，避免 error message 过长）
 */
function sanitize(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 500) return trimmed;
  return `${trimmed.slice(0, 500)}…`;
}

// ========================================================================
// ★ Task #5364 返工（BLOCKER-4/5/6）：进程级**共享 notifier 单例**
// ========================================================================

/**
 * ## 为什么必须有这个单例（真机事故复盘）
 *
 * `sessionCardIds` / `sessionStates` / `states` 都是 **notifier 实例字段**。
 * 只要「发首卡」和「后续 patch」不是同一个实例，就必然发生：
 *
 * ```
 * 事件 1（running）  → 实例 A：没有该 session 的卡 → startSessionCard 发**新卡**
 * 事件 2（completed）→ 实例 B：还是没有        → 又发**新卡**
 * ```
 *
 * 真机取证（2026-11-12 gonglin 群，单 session）：0813 定稿「一个 session 只有
 * 一张卡」，实测发出 **3 张**（2 张 session 卡 + 1 张 task 卡）。
 *
 * 根因是上一版靠 `env.getPluginInstance()/env._pluginInstances` 去「借」插件的
 * notifier —— 但生产 `Environment` **根本没有这两个属性**（全仓 grep 只有那
 * 一处引用、从无注入方）⇒ 每次调用都落 `?? new LarkCardPatchNotifier()`。
 *
 * ## 语义
 *
 * - **进程内唯一**：`LarkCliTaskNotifyHook` 默认构造、卡片 action handler、
 *   事件线程的 `sessionCardSender` 全部走这里取同一个实例
 * - 单测要隔离：显式传 `cardNotifier` 构造参数（既有 55 条测试都这么做），
 *   或者调用 {@link __resetSharedLarkCardNotifierForTest}
 */
/**
 * ★ Task #5580：session 卡任务列表的**单条摘要**（渲染层最小字段集）。
 *
 * 与 `SessionCardTaskPayload`（单 task 详情区块）的区别：
 * 列表条目只需要「点得动、认得出」—— id / 标题 / 状态 / 进度，
 * 不搬 goals / parentTaskId / createdAt 等重字段（点进详情再看）。
 */
export interface SessionCardTaskSummary {
  id: number;
  title?: string;
  status?: string;
  progress?: number;
}

/**
 * ★ Task #5364 返工：session 卡上「任务信息」区块的渲染载荷类型。
 *
 * 显式导出，避免调用方写 `Parameters<typeof buildSessionCard>[0]["task"]`
 * 这种又长又容易写错的类型（也确实被写错过一次：内联 import(...) 语法非法）。
 */
export type SessionCardTaskPayload = NonNullable<
  Parameters<typeof buildSessionCard>[0]["task"]
>;

let sharedNotifier: LarkCardPatchNotifier | undefined;

/**
 * 取进程级共享 notifier（首次调用时创建）。
 *
 * ⚠️ 只在**生产装配**里用。任何需要独立状态的场景（单测 / 多租户）都要
 * 显式 `new LarkCardPatchNotifier()` 并注入。
 */
export function getSharedLarkCardNotifier(): LarkCardPatchNotifier {
  if (!sharedNotifier) sharedNotifier = new LarkCardPatchNotifier();
  return sharedNotifier;
}

/** 测试钩子：丢弃单例（避免用例间状态串味）。 */
export function __resetSharedLarkCardNotifierForTest(): void {
  sharedNotifier = undefined;
}

/** 诊断：当前是否已有单例（不创建）。 */
export function hasSharedLarkCardNotifier(): boolean {
  return sharedNotifier !== undefined;
}
