/**
 * @fileoverview Task Plugins Module
 */

export { TaskTagPlugin } from "./task-tag-plugin";

// Laya 决策插件（Task #4467/#4620）—— 本地 Laya 服务做 task_create 合理性检测
export {
  LayaDecisionPlugin,
  createLayaDecisionPlugin,
  LAYA_REUSE_THRESHOLD,
  type LayaDecisionPluginOptions,
} from "./laya-decision-plugin";
export {
  createAutoTaskPlugin,
  type AutoTaskPluginConfig,
} from "./auto-task-plugin";

// TaskOpWatermarkPlugin（Task #5081）— sub-agent 感知任务操作记录：
// agent:after.tool 水位比对 + 共享 meta-protocol 注入 user role 提醒
export {
  createTaskOpWatermarkPlugin,
  TaskOpWatermarkPlugin,
  TASK_OP_WATERMARK_MAX_REMINDERS,
  TASK_OP_WATERMARK_MESSAGE_LIMIT,
  TASK_OP_WATERMARK_AUDIT_INTERVAL,
  type TaskOpWatermarkPluginConfig,
} from "./task-op-watermark-plugin";

// ─────────────────────────────────────────────────────────────────────────
// 完成判定（goal check）—— 一等公共 API（Task #5035）
//
// 背景：`LayaCompletionPlugin`（Task #4760）一直是 `export class`，但
// **没有**从本桶转出。roy-bot 自己进程内通过 `environment.ts` 调
// `registerLayaCompletionTaskHook(taskComponent)` 注册（挂
// `task:after.complete`）；而外部宿主（即 MCP task server 的宿主）拿到的
// 只是 `TaskStoreBackend`（`TaskBackend` 契约），**没有 hook 链** ——
// 于是 `task:after.complete` 不触发，判定不跑，MCP 驱动的 agent 自己调
// `task_complete` 时**完全没有任何验收**。
//
// 而且 `env/task/plugins/laya-completion-plugin` 这个**文件路径**不在
// package `exports` 映射里（只发布 `dist/<a>/index.js` 与
// `dist/<a>/<b>/index.js`），外部宿主连 import 都解析不到 —— 只能反射
// 私有字段或复刻语义，正是 Task #4619 要消除的反模式。
//
// 现在判定能力是一等公共 API：宿主拿 `createLayaCompletionPlugin` /
// `LayaCompletionPlugin`，自己把 `TaskBackend` 适配成判定需要的 4 个方法，
// 在 `task_complete` 之后跑一次；`TASK_COMPLETION_HINT_ANCHOR` +
// `buildCompletionHint` 用来把 FAIL 分支的提示回传给 agent。
//
// ⚠️ 纯导出，**零行为变化** —— 实现逻辑一行没动。
// ─────────────────────────────────────────────────────────────────────────
export {
  LayaCompletionPlugin,
  createLayaCompletionPlugin,
  registerLayaCompletionTaskHook,
  buildCompletionHint,
  renderCompletionState,
  buildCompletionQuestion,
  LAYA_COMPLETION_THRESHOLD,
  type LayaCompletionPluginOptions,
} from "./laya-completion-plugin";

// hint 锚点（`TASK_COMPLETION_HINT`）—— 与 `complete-tool.ts` / default
// prompt 共用同一常量（Task #4834 F3 同源），宿主不要让文案漂移。
export {
  TASK_COMPLETION_HINT_ANCHOR,
  TASK_COMPLETE_ITEM_BY_ITEM,
  TASK_COMPLETE_VERIFY_DUTY,
  TASK_COMPLETE_ACCEPTANCE,
} from "../tools/completion-copy";

// 判定用的 port 契约（宿主可注入自己的实现 / 复用 roy 的 auth.json）
export type {
  DecisionPort,
  DecisionRequest,
  DecisionAnswer,
  DecisionResponse,
} from "./decision-port";

// `workflow-extractor-agent.ts` now only contains utility functions used by
// TaskTagPlugin (formatExtractorInput / parseExtractorOutput / WORKFLOW_EXTRACTOR_PROMPT
// alias). The agent itself is registered as a built-in agent via
// AgentRegistry.registerWorkflowExtractAgent() — see `agent/agent-registry.ts`.
export {
  WORKFLOW_EXTRACTOR_PROMPT,
  formatExtractorInput,
  formatExtractorInputFromDescription,
  parseExtractorOutput,
} from "./workflow-extractor-agent";

// LarkCli 任务通知插件（直接实现 Hook 接口）
export {
  LarkCliTaskNotifyHook,
  createLarkCliTaskNotifyHook,
  type TaskNotifyConfig,
  NotifyType,
} from "./lark-cli-task-notify-plugin";

// Wecom 任务通知插件（Task #5193，直接实现 Hook 接口）
//
// ★ 与 LarkCliTaskNotifyHook 关系（避免双发）：
// - LarkCliTaskNotifyHook: 只在 lark 事件上下文发卡片
// - WecomTaskNotifyHook: 只在 wecom 事件上下文发 markdown
// 两者都靠 extractWecomFields / isLarkEvent 判定事件源，互斥不双发。
export {
  WecomTaskNotifyHook,
  createWecomTaskNotifyHook,
  extractWecomFields,
  buildWecomTaskCard,
  WecomNotifyType,
  type WecomTaskNotifyConfig,
  type WecomMilestone,
} from "./wecom-task-notify-plugin";
export {
  createWecomCardStateStore,
  createMemoryWecomCardStore,
  MemoryWecomCardStateStore,
  SqliteWecomCardStateStore,
  getDefaultWecomCardDbPath,
  type WecomCardState,
  type WecomCardStateStore,
} from "./wecom-card-state-store";

// PerTaskGroupChatPlugin - 每 task 一个独立飞书群聊（Task #3945）
//
// ★ 与 LarkCliTaskNotifyPlugin 关系（避免双发问题，P0-3）：
// - LarkCliTaskNotifyPlugin: 发到主聊天框
// - PerTaskGroupChatPlugin: 发到 task 群聊
// 两种 plugin 都监听 task:after.update，配置 event-source 时只启用其中一个：
//   --plugins "PerTaskGroupChatPlugin"          # 推荐方式 A
//   --plugins "LarkCliTaskNotifyPlugin"         # 保留主聊天框
export {
  PerTaskGroupChatPlugin,
  createPerTaskGroupChatPlugin,
  type PerTaskGroupConfig,
} from "./per-task-group-chat-plugin";

// ─────────────────────────────────────────────────────────────────────────
// 卡片渲染器 —— 一等公共 API（Task #4619）
//
// 背景：这些导出在 `lark-card-patch-notifier.ts` 里**早就是具名导出**，但
// 该文件不是可解析的子路径（package `exports` 只发布 `dist/<a>/index.js`
// 与 `dist/<a>/<b>/index.js`），桶里也没有转出。于是每个外部宿主（opencode
// / claude / codex 插件）都只能：
//
//   1. 反射 hook 实例的**私有** `.cardNotifier` 字段
//   2. 手工镜像 `Milestone` / `ProcessStep` / `TaskMeta` 三个类型
//
// 现在渲染器从桶里直接可达，宿主只做「形状翻译 + IO 绑定」。
//
// ⚠️ 保持这里与 `lark-card-patch-notifier.ts` 的导出一致：任何新增的
//    具名导出都应在此转出，否则外部宿主会再次被迫绕路。
// ─────────────────────────────────────────────────────────────────────────
export {
  // 卡片渲染器本体（宿主可直接 new，不必再借 hook 当工厂）
  LarkCardPatchNotifier,
  type LarkCardPatchNotifierOptions,

  // 纯渲染函数（无 IO，可在任何宿主里单测）
  buildTaskCard,
  buildWorkflowCard,
  renderProgressBar,
  renderMilestones,
  renderProcessSteps,
  renderTaskInfoLines,
  renderContextAsLines,
  renderWorkflowInfoLines,
  formatTimestampForDisplay,
  formatDateTimeForDisplay,
  formatDurationMs,
  sanitizeInlineText,
  humanizeValue,
  resolveTaskTitleForDisplay,
  buildChatAppLink,
  DEFAULT_APP_LINK_BASE,

  // 卡片数据结构（宿主需要它们来组装自己的 payload）
  type CardStatus,
  type WorkflowCardStatus,
  type Milestone,
  type ProcessStep,
  type TaskMeta,
  type WorkflowMeta,
  type CardPayload,
  type StartTaskOptions,
  type UpdateTaskOptions,
  type FinishTaskOptions,
  type StartTaskResult,
  type StartWorkflowOptions,
  type UpdateWorkflowOptions,
  type FinishWorkflowOptions,
} from "./lark-card-patch-notifier";

// ─────────────────────────────────────────────────────────────────────────
// 卡片账本 —— 一等公共 API (Task #4860)
//
// 背景：账本（`lark-cards.db`，taskId → messageId）是 core 卡片 hook 的
// **幂等机制**：同一 task 的第二个发卡方（另一个进程 / 重启后的 hook）
// 通过它认领同一张卡，而不是再发一张。
//
// Task #4860 之前它**没有**被导出 —— 插件的 daemon 侧卡片端口因此无法
// 写这份账本，于是：
//   1. daemon 卡与 MCP hook 卡互不知情 → **同一个 task 两张卡**
//      （实测见插件仓 scripts/probe-double-card.mjs）；
//   2. 外部宿主若要写账本，只能对着 core 的私有 schema 手写 SQL ——
//      正是 Task #4619 移除的「在插件里复刻 roy 语义」的反模式。
//
// 现在账本是公共 API，插件直接复用 core 的同一套工厂（同 schema、同路径
// 解析、同 busy_timeout 策略），不重写任何语义。
// ─────────────────────────────────────────────────────────────────────────
export {
  createLarkCardStateStore,
  getDefaultLarkCardDbPath,
  MemoryLarkCardStateStore,
  SqliteLarkCardStateStore,
  type LarkCardState,
  type LarkCardRecordStatus,
  type LarkCardStateStore,
} from "./lark-card-state-store";

// 注：RoyPluginTaskShow / TaskShowPlugin 的实现见独立 plugin 仓
//     https://github.com/<org>/roy-plugin-task-show （npm: roy-plugin-task-show）
//     它是 env.notify API 的 production consumer；本仓（roy-bot）只提供
//     host 框架能力（NotificationChannel 抽象 + EventBus 默认通道 + PluginEnv.notify）。
