/**
 * @fileoverview Task #4552 (A1) — 后台任务 telemetry 进展提示（纯 IM 直发）
 *
 * ## 用户明令的方案（飞书群 2026-10-26 16:59）
 *
 * > 「任务 process 通知时间就不送到 agent 进行处理了，只是通过找到 triggerEvent
 * >   发一个进展的提示消息给到飞书就行了，否则太费 token 也引发任务说的问题」
 *
 * ## 这条链路要解决的问题（trace 实证）
 *
 * `task.background.started` / `task.background.progress` 两类**中间态
 * telemetry** 以前走「老 formatter → 进 lane → 完整 agent run」：
 *
 * 1. 心跳带 `replyChannel.chatId` → `laneKeyFor()` 把它归到**群那条 lane**
 * 2. 该 lane 与用户真实消息共用，且严格 FIFO 串行
 * 3. 每次心跳 = 一次完整 agent run（实测几分钟到十几分钟）
 * 4. Task #4547 共 12 条心跳 = 12 次 run → 用户消息排队
 *
 * 实测后果（trace `151a2374558501c014d9042321835e5a`，12856 spans）：
 * - 入站延迟 13:42→14min、13:58→18.4min、14:29→**21.5min**
 * - lane 占用 313 run-minutes / 210 分钟墙钟（>100% 饱和）
 * - 用户 16:14「后台任务在干嘛呢」、16:34「回答我呀」被饿死
 *
 * ## A1 = 从**源头**消灭（不是排队优化）
 *
 * 这两类事件**完全不进 lane**：
 * - ❌ 不 `claimSession`、不建/不复用 session
 * - ❌ 不触发任何 agent run（token 的主因）
 * - ✅ 只做一件事：反查 triggerEvent 拿 chatId + profile，spawn `lark-cli`
 *   发一条**一句话**进展提示
 *
 * ⚠️ A0（lane 内三级优先级）已被用户判定不够（心跳依然跑 agent、依然烧
 * token），且从未进入 main —— 本实现不含任何 A0 兜底残留。
 *
 * ## 复用现成零件（先读再选，不新造轮子）
 *
 * - `resolveEffectiveChat()`（per-task-group-chat-plugin）是 **task → chat** 的
 *   权威解析，但它绑定 Plugin 实例 + config + taskGetter。本模块的上下文是
 *   「一条 EnvEvent」而非「一个 Task」，故就地实现**同一套字段读取规则**：
 *     metadata.replyChannel → metadata.chatId → triggerEventId 反查 EventStore
 * - `LarkCliNotificationChannel.spawnLarkMessage` / `error-reply.spawnLarkReply`
 *   的 args 拼装与**硬超时**语义在此沿用。不直接 import 它们：前者绑
 *   EnvContext + @deprecated，后者绑失败回复语义（含去重表、限制规则），
 *   复用会把两套无关状态拖进来。

 * ## 本模块**不**负责
 *
 * - 判定「哪些事件是 telemetry」的调用点（在 EventHandler 里）
 * - 失败处理（best-effort：调用方 swallow，这里只 reject 让调用方能 log）
 */

import { spawn } from "node:child_process";
import { normalizeLarkAtMentions } from "@ai-setting/roy-bot-core/env/lark-mention-utils";
import { deriveIdempotencyKey } from "@ai-setting/roy-bot-core/env/event-source/idempotency-key";
// ★ Task #5036：提示消息嵌入「跳到任务卡片」的可点击链接
import { appendCardLinkLine } from "./card-message-link";

// ============================================================================
// 事件类型白名单
// ============================================================================

/**
 * 「还在跑」的中间态 telemetry 事件。
 *
 * ⚠️ 这个集合是**白名单**，且刻意保持极小（2 个）。任何新增成员都会让对应
 * 事件从「agent 参与」降级为「只发一条 IM」—— 必须是深思熟虑的决定，不能
 * 因为「顺手」而扩大。
 *
 * 为什么 `ask_user` 绝不能进来：它需要 agent 渲染问题正文 + 规则提示并
 * 等待用户答复，直发一条消息等于把双向交互降级成单向广播。
 *
 * 为什么终态（completed / failed / timeout / stopped）绝不能进来：它们是
 * 结果，需要 agent 读结果、组织回复、必要时续接 sub-session
 * （回归护栏见 event-handler-telemetry-notice.test.ts 第 3 组）。
 */
export const TELEMETRY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task.background.started",
  "task.background.progress",
]);

/** 判定事件类型是否为 telemetry（started / progress）。 */
export function isTelemetryEvent(type: string | undefined): boolean {
  if (!type) return false;
  return TELEMETRY_EVENT_TYPES.has(type);
}

// ============================================================================
// 终态规则回执（rule-based terminal notice）
// ============================================================================

/**
 * 终态「规则回执」事件白名单。
 *
 * ## 与 TELEMETRY_EVENT_TYPES 的唯一区别：发完之后要不要继续跑 agent
 *
 * - telemetry（started / progress）：直发后 **return** —— 不进 lane、不跑 agent。
 * - rule notice（completed / timeout）：直发**且继续** enqueue —— agent 仍要读
 *   子任务结果、组织总结、续接 sub-session。
 *
 * 两者共用同一套发送器（目标解析 / `--as bot` / 幂等键 / 5s 硬超时），
 * 见 `EventHandler.sendNotice`。这里不重复造轮子，只区分「发什么」和「后续干什么」。
 *
 * ## 为什么只有 completed / timeout
 *
 * - `failed`：已有 `notifyReactFailure` 失败回执链路，再加一条容易双发。
 * - `stopped`：本机 sessions.db 实测存在 20s 内重复 publish（Task #4558
 *   09:58:55 + 09:59:15、Task #4553 18:00:46 + 18:01:58），直发会变成两条
 *   重复消息。要启用得先按 (taskId, type) 做时间去重。
 *
 * ⚠️ 与 telemetry 白名单一样，这里是**深思熟虑的白名单**，不是「顺手加一个」。
 */
export const RULE_NOTICE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task.background.completed",
  "task.background.timeout",
]);

/** 判定事件类型是否需要「直发回执 + 继续跑 agent」。 */
export function isRuleNoticeEvent(type: string | undefined): boolean {
  if (!type) return false;
  return RULE_NOTICE_EVENT_TYPES.has(type);
}

// ============================================================================
// ★ CV BLOCKER-2 — sub-session 生命周期事件（无 task 的执行）
// ============================================================================

/**
 * sub-session 生命周期事件（`task.background.session_started`）。
 *
 * ## 语义（用户澄清 22:37 第 4 点）
 *
 * > 「**超时、完成等生命周期事件也体现在卡片上**（这是 subsession 层的）」
 *
 * 一个 sub-agent 可能**没建 task**，但它依然会 运行→完成/超时/失败/停止。
 * 这些事实由本事件承载，交给卡片层发/更新 **session 卡**。
 *
 * ## 为什么不能按 telemetry 处理（必须单独判定）
 *
 * telemetry 是「文本提示」且被本次改造下线；本事件要的是**卡片**。
 * 若混进 telemetry 白名单，card 模式下会被静默丢弃 ⇒ 无 task 的 session
 * 永远看不到生命周期。
 *
 * ## 为什么不能进 agent lane
 *
 * 它没有 task 可读、没有结果可总结 —— 进 lane 只会白烧一次完整 LLM 回合
 * （#4552 已就同类问题定过调）。
 */
export const SESSION_LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task.background.session_started",
]);

/** 判定是否为 sub-session 生命周期事件。 */
export function isSessionLifecycleEvent(type: string | undefined): boolean {
  if (!type) return false;
  return SESSION_LIFECYCLE_EVENT_TYPES.has(type);
}

// ============================================================================
// ★ Task #5360 — 文本投递策略（卡片化改造后是否还直发文本）
// ============================================================================

/**
 * 文本投递模式。
 *
 * ## 背景（Task #5360 用户需求）
 *
 * > 「去掉通知类文本消息（如「⏱️ 后台任务运行中 20m」「✅ 已完成 36m」这类
 * >   rule-based 直发的状态推送文本），改为**全部用卡片消息承载**」
 *
 * ## 为什么做成开关而不是删代码
 *
 * 1. `telemetrySender` 是 `EventHandler` 的**通用注入端口**，三处实现的语义
 *    完全不同：`run.ts`（daemon，真发飞书）、`chat-event-handler.ts`（写 stderr
 *    notice）、`interactive.ts`（写 stderr notice）。后两者本来就没发文本气泡。
 * 2. `buildTelemetryNoticeText` / `buildTerminalNoticeText` 有 100+ 行测试
 *    锁定文案行为，删掉 = 拆掉整张测试网。
 * 3. CLI 本地（`sink: "stdout"`）**没有卡片可发**，文本是唯一输出。
 * 4. 生产出问题需要一行配置回滚，不能靠 revert 一个 commit。
 *
 * - `"card"`（默认）—— 卡片承载；**只有** `sink === "stdout"` 时仍发文本
 * - `"text"` —— 逐字保留改造前行为（回滚开关）
 */
export type NoticeTextDelivery = "auto" | "card" | "text";

/**
 * 文本投递模式默认值。
 *
 * ★ Task #5360 补充需求（20:54）：从 `"card"` 改为 `"auto"`。
 *
 * - `"auto"`（默认）—— 按 **per-ES 配置** `statusNotifications` 解析：
 *   `true` ⇒ 发文本（旧行为）；`false`/缺省 ⇒ 静默（卡片承载）。
 *   语义等价于原 `"card"` 的默认效果（因为 ES 缺省就是 false），但把
 *   控制权交给了用户在 `~/.roy-bot/event-sources.json` 里的配置。
 * - `"card"` / `"text"` —— 保留为**强制覆盖**，用于测试与应急一键回滚。
 */
export const DEFAULT_NOTICE_TEXT_DELIVERY: NoticeTextDelivery = "auto";

/**
 * 判定这次是否应该**直发文本**。
 *
 * @param delivery 当前模式（`"card"` / `"text"`）
 * @param sink     投递目标（`"lark"` = 真发 IM；`"stdout"` = CLI 本地；
 *                 `undefined` 按历史默认走 lark 语义）
 *
 * ## 唯一例外：`sink === "stdout"`
 *
 * CLI 本地/REPL 没有飞书卡片这个概念（卡片由 `lark-cli` 发，本地没有卡片可显示）。
 * 若在 stdout 模式也压制文本，本地用户会**完全看不到后台任务进展**——
 * 这是功能倒退，不是需求。所以 stdout 永远发文本。
 *
 * ## 为什么 `undefined` 走 lark 语义
 *
 * 改造前 `telemetrySender` 的 `sink` 是可选字段，缺省实现是
 * `sendLarkChatMarkdown`（真发飞书）。为保持"缺省 = 旧行为"的语义，
 * `undefined` 按 lark 处理 ⇒ card 模式下不发文本。
 */
export function shouldDeliverNoticeText(
  delivery: NoticeTextDelivery | undefined,
  sink: "lark" | "stdout" | undefined,
  /**
   * ★ Task #5360 补充需求：`"auto"` 模式下由调用方解析出的 per-ES 开关。
   *
   * `undefined` / `false` ⇒ 不发文本；`true` ⇒ 发（逐字旧行为）。
   * 其他 delivery 取值下本参数被忽略（强制覆盖优先）。
   */
  statusNotifications?: boolean,
): boolean {
  // ★ 最高优先级：CLI 本地（stdout）没有卡片可发，文本是唯一可见输出。
  //   这条在**所有**模式（含 "card" 强制静默）下都成立 —— 否则本地用户
  //   会完全失去后台任务进展可见性，那是功能倒退不是需求。
  if (sink === "stdout") return true;

  // 强制覆盖
  if (delivery === "text") return true;
  if (delivery === "card") return false;

  // "auto"（含 undefined 缺省）：按 per-ES 配置
  return statusNotifications === true;
}

// ============================================================================
// 格式化
// ============================================================================

/** 标题最大显示宽度（心跳不许刷屏）。 */
const MAX_TITLE_CHARS = 40;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 把毫秒时长压成**极简**的人类可读形式：`2h16m` / `45m` / `1d2h`。
 *
 * 为什么不用中文「2 小时 16 分钟」：这条消息每 20 分钟发一次，越短越好；
 * 且用户是拿它跟「预计 17:23 超时」做比对的，紧凑更好扫。
 *
 * 负数 / NaN / Infinity → `0m`（防御：`startedAt` 可能来自时钟回拨或字段缺失，
 * 绝不能渲染出 `-1m` 或 `NaNm`）。
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHour = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (totalHour < 24) {
    return min === 0 ? `${totalHour}h` : `${totalHour}h${min}m`;
  }
  const day = Math.floor(totalHour / 24);
  const hour = totalHour % 24;
  return hour === 0 ? `${day}d` : `${day}d${hour}h`;
}

/** `HH:MM`（本地时区，补零）。 */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * timeout 时长标签：`5h` / `30m` / `1h30m`。
 *
 * 用户看到「timeout 5h」能立刻理解这个任务被允许跑多久，配合「预计 17:23
 * 超时」就知道当前处于什么阶段（这正是本次报障的另一半：用户 16:40 以为
 * "超时了该有结论"，实际离 5h timeout 还有 40 分钟）。
 */
export function formatTimeoutLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  return formatElapsed(ms);
}

function truncateTitle(raw: string): string {
  // ★ Task #5036 (DS review m1)：标题**必须单行**。
  //
  // `description` 来自 task 标题，可能是 LLM 生成的含换行文本。以前只 trim()，
  // 于是提示文案的「标题行」被换行切成多行 —— `appendCardLinkLine` 按首个
  // `\n` 插链接时会插进「」中间，正文割裂。
  // 这里把所有空白（含 \n / \t / 连续空格）压成单空格，从根上消灭该形态。
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length <= MAX_TITLE_CHARS) return s;
  return `${s.slice(0, MAX_TITLE_CHARS)}…`;
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * telemetry payload 里本模块关心的字段（结构化最小子集）。
 *
 * ★ 与 `delegate-tool.ts` 的 `BackgroundTaskStartedPayload` /
 * `BackgroundTaskProgressPayload` 保持同步（那两个类型已补 startedAt /
 * timeoutMs —— 否则「预计超时」永远渲染不出来，见 A1 的实现说明）。
 */
interface TelemetryPayloadLike {
  backgroundTaskId?: string;
  description?: string;
  progressMessage?: string;
  associatedTaskId?: number;
  startedAt?: number;
  timeoutMs?: number;
  /** 终态 payload（BackgroundTaskCompletedPayload）才有的字段 */
  executionTimeMs?: number;
  error?: string;
  result?: string;
}

/**
 * 生成进展提示文案。
 *
 * 形态（progress）：
 * ```
 * 🔄 Task #4547「调研 airport 本体生成」后台运行中
 * 已跑 2h16m，预计 17:23 超时（timeout 5h）
 * ```
 *
 * 形态（started）：同上但换成「已启动」，且不带「已跑」（刚启动报 0m 是噪音）。
 *
 * 硬要求（见 telemetry-notice.test.ts）：
 * - 含 Task id + 标题 + 已跑时长 + **预计超时绝对时间**
 * - 不含任何 agent 指令（老 formatter 里的「请调用 task_get」是给主 agent
 *   看的，直接漏到飞书群里对用户毫无意义）
 * - 不含 subSessionId / backgroundTaskId 等内部标识（有 Task #N 时）
 * - 字段缺失时降级，绝不渲染 `undefined` / `NaN`
 */
export function buildTelemetryNoticeText(
  type: string,
  payload: TelemetryPayloadLike | undefined,
  /** 注入"当前时间"（默认 `Date.now()`）。测试用它把「已跑 N」变成确定性断言。 */
  now: number = Date.now(),
): string {
  const p = payload ?? {};

  const taskId = pickNumber(p.associatedTaskId);
  const bgId = pickString(p.backgroundTaskId);
  const desc = truncateTitle(pickString(p.description) ?? "后台任务");

  // Task #N 优先（用户认知里的标识），否则退到 backgroundTaskId，
  // 两者都没有就完全省略 —— 绝不渲染 "Task #undefined"。
  let label: string;
  if (taskId !== undefined) label = `Task #${taskId}`;
  else if (bgId) label = bgId;
  else label = "后台任务";

  const head =
    type === "task.background.started"
      ? `🔔 ${label}「${desc}」已启动`
      : `🔄 ${label}「${desc}」后台运行中`;

  // 时长相（progress 才有意义；刚启动时报「已跑 0m」是噪音）
  const parts: string[] = [];
  const startedAt = pickNumber(p.startedAt);
  const timeoutMs = pickNumber(p.timeoutMs);

  if (type !== "task.background.started" && startedAt !== undefined) {
    parts.push(`已跑 ${formatElapsed(now - startedAt)}`);
  }
  // ★ 绝对时间而非「还剩 N 小时」：心跳每 20 分钟一条，相对值一直在变，
  //   绝对时间是稳定锚点（用户可以直接对上表）。
  if (startedAt !== undefined && timeoutMs !== undefined) {
    parts.push(
      `预计 ${formatClock(startedAt + timeoutMs)} 超时（timeout ${formatTimeoutLabel(timeoutMs)}）`,
    );
  }

  let text = head;
  if (parts.length > 0) text += `\n${parts.join("，")}`;

  // 子代理主动汇报的进度（task_update 的 progressMessage）—— 有就附一行
  const progressMessage = pickString(p.progressMessage);
  if (progressMessage) text += `\n${progressMessage}`;

  return text;
}

/**
 * 从 timeout 事件的 error 文案里抠出 timeout 时长。
 *
 * `BackgroundTaskCompletedPayload` 目前**不带** `timeoutMs`（只有 started /
 * progress 带），但 error 是 `Task execution timeout after 7200000ms`。
 * 与其改 payload schema 让所有消费端跟着变，不如在这里解析一次（纯函数，好测）。
 *
 * 解析不出来 → undefined（文案降级为不带 timeout）。
 */
export function parseTimeoutMsFromError(error: string | undefined): number | undefined {
  if (!error) return undefined;
  const m = error.match(/timeout after\s+(\d+)\s*ms/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 生成**终态回执**文案（completed / timeout）。
 *
 * 与 `buildTelemetryNoticeText` 的分工：
 *   - telemetry = 「还在跑」的进展心跳（每 20 分钟一条）
 *   - 本条 = 任务生命周期结束时的**一句话回执**，保证即使 agent 忘了调
 *     lark-cli，用户也能在群里看到终态
 *
 * 硬要求：
 * - **绝不放 `result` 正文**（子 agent 完整输出可能几十 KB，放回执会刷屏，
 *   且与 agent 随后发的「增量总结」重复）
 * - 只报事实（Task / 标题 / 耗时 / timeout），不承诺 agent 一定回复
 * - 字段缺失一律降级，绝不渲染 `undefined` / `NaN` / `Task #undefined`
 *
 * 形态：
 * ```
 * ⏱️ Task #4561「修50GB traces.db性能问题」已超时（跑了 2h0m，timeout 2h）
 * 助手随后补充结论。
 *
 * ✅ Task #4449「画ontology图并发飞书」已完成（耗时 3h12m）
 * 助手随后补充交付摘要。
 * ```
 */
export interface BuildTerminalNoticeOptions {
  /**
   * ★ Task #5036：任务卡片的飞书 applink（`client/chat/open?openChatId=&position=`）。
   *
   * 缺省 / 空串 ⇒ **不附链接**（零痕迹降级，与改动前文案逐字一致）。
   * 由调用方异步解析后注入 —— 本函数保持纯函数（好测、无 IO）。
   */
  cardUrl?: string;
}

export function buildTerminalNoticeText(
  type: string,
  payload: TelemetryPayloadLike | undefined,
  options?: BuildTerminalNoticeOptions,
): string {
  const cardUrl = options?.cardUrl;
  const p = payload ?? {};

  const taskId = pickNumber(p.associatedTaskId);
  const bgId = pickString(p.backgroundTaskId);
  const desc = truncateTitle(pickString(p.description) ?? "后台任务");

  // 与 buildTelemetryNoticeText 同一套 label 规则：优先用户认知里的 Task #N
  let label: string;
  if (taskId !== undefined) label = `Task #${taskId}`;
  else if (bgId) label = bgId;
  else label = "后台任务";

  const elapsedMs = pickNumber(p.executionTimeMs);
  const elapsed = elapsedMs !== undefined ? formatElapsed(elapsedMs) : undefined;

  if (type === "task.background.timeout") {
    const timeoutMs = pickNumber(p.timeoutMs) ?? parseTimeoutMsFromError(p.error);
    const parts: string[] = [];
    if (elapsed) parts.push(`跑了 ${elapsed}`);
    if (timeoutMs !== undefined) parts.push(`timeout ${formatTimeoutLabel(timeoutMs)}`);

    const head = `⏱️ ${label}「${desc}」已超时`;
    return appendCardLinkLine(
      parts.length > 0
        ? `${head}（${parts.join("，")}）\n助手随后补充结论与下一步选项。`
        : `${head}\n助手随后补充结论与下一步选项。`,
      cardUrl,
    );
  }

  if (type === "task.background.completed") {
    const head = `✅ ${label}「${desc}」已完成`;
    return appendCardLinkLine(
      elapsed
        ? `${head}（耗时 ${elapsed}）\n助手随后补充交付摘要。`
        : `${head}\n助手随后补充交付摘要。`,
      cardUrl,
    );
  }

  // 兜底：未来把 failed / stopped 加进白名单时，先给一个中性文案
  // （不冒充「完成」，也不承诺结论）
  const bgStatus = type.replace("task.background.", "");
  return appendCardLinkLine(
    `ℹ️ ${label}「${desc}」${bgStatus}${elapsed ? `（耗时 ${elapsed}）` : ""}`,
    cardUrl,
  );
}

// ============================================================================
// lark-cli args 拼装 + 直发（最小实现 + 硬超时）
// ============================================================================

/**
 * 直发硬超时（毫秒）。
 *
 * ★ 这不是「优化」而是**正确性要求**：本函数在事件订阅回调里被 await。
 *   lark-cli 一旦卡住（网络 / 长轮询 / 二进制异常），没有超时会让回调永不
 *   settle → 后续所有事件（含用户真实消息）都排不上。比「这条提示没发出去」
 *   糟得多。
 *
 * 与 `error-reply.ts` 的 DEFAULT_REPLY_TIMEOUT_MS (5s) 同源结论。
 */
const DEFAULT_SEND_TIMEOUT_MS = 5_000;

/** 飞书 `im +messages-send --idempotency-key` 的硬上限（字符数）。 */
const MAX_IDEMPOTENCY_KEY_LEN = 50;

/**
 * 派生 telemetry 通知的幂等键（≤ 50 字符）。
 *
 * **复用** `core/env/event-source/idempotency-key.ts` 的 `deriveIdempotencyKey`
 * （PerTaskGroupChatPlugin / LarkCliTaskNotifyHook 用的同一套规则），不重造。
 * 这里只负责"用什么做 hash 来源"这层语义决策。
 *
 * 为什么用 `event.id` 而不是文案 hash：
 *   心跳文案在整点会完全相同（连续两条都可能是「已跑 2h」），按文案 hash
 *   会把**不同的**心跳压成一条 → 用户看不到后续进展。
 *
 * 为什么带上 chatId：
 *   同一后台任务可能同时通知多个群（postProcessNotifyEvent 镜像），
 *   同一 event.id 在不同 chat 是**不同**的消息，不能互相去重。
 *
 * 长度：`roy-` + ≤16 位 base36 ≈ 21 字符，远低于飞书 50 上限；
 * `buildLarkSendArgs` 里还会再截断一次（双保险）。
 */
export function deriveTelemetryIdempotencyKey(
  eventId: string | undefined,
  chatId: string,
): string {
  return deriveNoticeIdempotencyKey("telemetry", eventId, chatId);
}

/**
 * 派生**终态回执**的幂等键（≤ 50 字符）。
 *
 * 与 telemetry 用**不同 namespace**：同一个 event.id 在两种链路里是不同消息
 * （虽然实践中互斥，但留出隔离避免将来白名单交叉时互相压掉）。
 */
export function deriveRuleNoticeIdempotencyKey(
  eventId: string | undefined,
  chatId: string,
): string {
  return deriveNoticeIdempotencyKey("rule", eventId, chatId);
}

/**
 * 幂等键公共实现。
 *
 * 用 `event.id` 而不是文案 hash：
 *   - 同一事件被重复投递（lark-cli 重投 / 进程重启重放）→ 同一 key → 飞书侧去重
 *   - 不同事件即使文案相同（整点心跳）→ 不同 key → 用户能看到后续进展
 *
 * 带上 chatId：同一事件可能同时通知多个群，跨群不能互相去重。
 */
export function deriveNoticeIdempotencyKey(
  namespace: string,
  eventId: string | undefined,
  chatId: string,
): string {
  // 缺失 event.id 时用时间戳 + 随机兜底 —— 宁可多发一条，也不能让所有缺 id
  // 的事件共用同一个 key 而被飞书压成一条（会丢掉真正的后续进展）。
  const anchor = pickString(eventId) ?? `ts-${Date.now()}-${Math.random()}`;
  return deriveIdempotencyKey([namespace, anchor, chatId]);
}

export interface BuildLarkSendArgsInput {
  chatId: string;
  text: string;
  /** lark-cli profile（多 appId 场景必需，否则 99992361 open_id cross app） */
  profile?: string;
  /** 幂等键（飞书侧去重，≤ 50 字符，超长自动截断） */
  idempotencyKey?: string;
}

/**
 * 拼 `lark-cli im +messages-send` 参数。
 *
 * 约定与 `LarkCliNotificationChannel.spawnLarkMessage` /
 * `error-reply.spawnLarkReply` 一致：
 * - `--profile <name>` **前置**
 * - markdown 模式（走 `normalizeLarkAtMentions`：飞书只认 `<at ...></at>`，
 *   自闭合 `<at .../>` 不会触发通知）
 * - **必须显式 `--as bot`**（见下）
 *
 * ## ★ A1 BLOCKING 修复（Task #4552，2026-10-26 真实 E2E 实测）
 *
 * 原实现**刻意不加** `--as bot`，注释理由是「send 到 chat 用默认身份即可；
 * 显式 --as bot 在部分 profile 下会因 bot 不在会话里报 230002」。
 *
 * **该顾虑在本 profile（default）实测不成立**：
 *   - `--as bot` 成功，返回 `identity: "bot"`
 *   - `im +chat-members-list` 显示 bot 确实在群里
 *
 * 而不加时默认身份是 **user（开发者本人）**。`lark-cli event consume
 * im.message.receive_v1` 只看「是不是 user 发的消息」→ 我们刚发的提示被
 * **同一个 consumer 当作用户消息回灌**，又跑一次完整 agent run。
 *
 * 实测铁证（本机 E2E 报告 `reports/4552-a1-real-e2e.md` §6（`reports/` 被 .gitignore 忽略，未入库））：
 * - `event-store.db` 11 条事件里 **5 条是回灌**（45%），**4 条 telemetry
 *   提示全部回灌**
 * - 时序：提示 `create_time 19:35:58.257` → 回声事件 `19:35:58.631`（**374ms**）
 * - 回声 trace `01a177fef0904b9dc43d1848880fef21`：5582ms / 188 spans /
 *   含 `agent.component.run` + `invokeLLM`
 *
 * 净效果：token 一点没省、消息量翻倍、lane 饥饿原封不动，且有正反馈风险。
 *
 * ## 为什么选「无条件 `--as bot`」而不是「先试 bot 失败降级 user」
 *
 * 降级路径看着更"安全"，但在这条链路上有三个致命问题：
 * 1. **降级就等于回灌**。user 身份发出去必然被 consumer 吃回来（本 bug 本体），
 *    降级静默发生 = 偷偷把 bug 放回来。
 * 2. **延迟翻倍**。5s 硬超时 + 失败重试 ⇒ 最坏 10s，而这条链路是
 *    fire-and-forget 的心跳直发，卡 10s 会拖慢事件订阅回调。
 * 3. **掩盖配置问题**。230002 说明 bot 不在会话里 —— 那是**需要修**的状态
 *    （bot 该被拉进群），不是该绕过的东西。失败就 log，让问题暴露。
 *
 * 所以：**失败就 reject → 调用方 swallow + log**（`sendTelemetryNotice` 已有
 * 这层），绝不静默降级成 user 身份。若真遇到 230002，正确修法是把 bot 拉进群。
 *
 * ## 与同仓对照（Task #4557 后已**全仓对齐**，且有一致性测试兜底）
 *
 * 本模块当初（A1，Task #4552）抄的是 `lark-cli-notification-channel.ts` /
 * `error-reply.ts` 里**漏 flag 的那一支**（`+messages-reply` 带 `--as bot`、
 * `+messages-send` 不带）。Task #4557 已把那两处的 `+messages-send` 补齐，
 * 并把 `event-source-handlers.ts` 的身份从变量收窄成字面量，于是
 * `packages/{core,cli}/src` 里**全部 9 个** `+messages-*` 发送点位
 * （`+messages-send` **6 个点位 / 5 个文件**、`+messages-reply`
 * **3 个点位 / 3 个文件**）现在都在 args 里带**字面量** `"--as", "bot"`：
 *
 *   - `packages/core/src/env/error-reply.ts`（send 1 + reply 1；send 的 chatId
 *     分支是**真实可达**路径：失败回执）
 *   - `packages/core/src/env/plugin/lark-cli-notification-channel.ts`
 *     （send 1 + reply 1；`@deprecated` 但 opt-in 可启用）
 *   - `packages/core/src/env/event-source/event-source-handlers.ts`
 *     （通用发送器：reply 1 + send 2，分别对应 chatId / userId；Task #4557 把
 *     `as` 参数删了，三处 push 写死字面量 bot）
 *   - `packages/core/src/env/task/plugins/lark-card-patch-notifier.ts`（send 1，卡片）
 *   - 本模块（send 1，telemetry 直发）
 *
 * （数字由 AST 精确统计，2026-10-27 实测；口径 = 源码里完整的命令名字面量）
 *
 * 该契约由 `packages/core/src/env/lark-send-identity-consistency.test.ts`
 * **自动扫描**源码断言（不再依赖人肉 grep）—— 以后新增发送路径忘带 flag
 * 会直接测试变红。**白名单已清空**（曾经豁免过 event-source-handlers，
 * 但那条豁免的兜底被交叉验证证明是漏的，已通过收窄类型彻底移除）。
 *
 * ## 防御纵深
 *
 * 主修之外，`event-handler.ts` 入口还有一层 `self-echo-filter`
 * （只按 sender 身份拦 bot/app，**绝不按文案前缀**）—— 见该模块注释。
 */
export function buildLarkSendArgs(input: BuildLarkSendArgsInput): string[] {
  const { chatId, text, profile, idempotencyKey } = input;

  const args = [
    "im",
    "+messages-send",
    "--chat-id",
    chatId,
    "--markdown",
    normalizeLarkAtMentions(text),
    // ★ A1 BLOCKING 修复：显式 bot 身份，否则默认 user → 被自己的 consumer 回灌
    "--as",
    "bot",
  ];

  if (idempotencyKey) {
    args.push(
      "--idempotency-key",
      idempotencyKey.slice(0, MAX_IDEMPOTENCY_KEY_LEN),
    );
  }
  if (profile) args.unshift("--profile", profile);

  return args;
}

export interface SendLarkChatMarkdownOptions {
  chatId: string;
  text: string;
  /** lark-cli profile（多 appId 场景必需，否则 99992361） */
  profile?: string;
  /** 幂等键（≤ 50 字符） */
  idempotencyKey?: string;
  timeoutMs?: number;
}

/**
 * `lark-cli im +messages-send --chat-id <id> --markdown <text>`（带硬超时）。
 *
 * reject 的语义：调用方**必须** swallow（best-effort）。
 */
export function sendLarkChatMarkdown(
  options: SendLarkChatMarkdownOptions,
): Promise<void> {
  const { chatId, text, profile, idempotencyKey } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;

  if (!chatId) {
    return Promise.reject(new Error("sendLarkChatMarkdown: empty chatId"));
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const args = buildLarkSendArgs({ chatId, text, profile, idempotencyKey });

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("lark-cli", args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 进程可能已退出 */
      }
      finish(new Error(`lark-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // 不要让这个定时器把进程留住
    (timer as { unref?: () => void }).unref?.();

    proc.on("close", (code: number | null) => {
      if (code === 0) finish();
      else finish(new Error(`lark-cli exited with code ${code}: ${stderr}`));
    });
    proc.on("error", (err: Error) => finish(err));
  });
}

// ============================================================================
// 目标解析
// ============================================================================

/**
 * 直发目标（chatId 必填；profile / sink 可选）。
 *
 * ★ Task #4568：`sink` 让「CLI 触发」的后台任务通知能落到 stdout 而不是
 * spawn `lark-cli`。缺省（undefined）= 老行为 = 走 lark-cli。
 *
 * 为什么叫 `sink` 而不是 `channel`：`chatId` 已经承担了"往哪发"的语义，
 * `sink` 只决定"用哪种发送器"，两者正交。
 */
export interface TelemetryNoticeTarget {
  chatId: string;
  profile?: string;
  /**
   * 投递方式：
   *   - `'stdout'` → `console.log`（CLI 触发路径）
   *   - `'lark'`   → `spawn lark-cli`（显式声明，与缺省等价）
   *   - 缺省       → 走 `sendLarkChatMarkdown`（**向后兼容，现有测试零改动**）
   */
  sink?: "lark" | "stdout";
}

/**
 * 从事件 metadata 直接取目标（不做 IO）。
 *
 * 顺序：`metadata.replyChannel.chatId`（`publishBackgroundEvent` 写入的
 * delegate 时刻快照）→ `metadata.chatId`（部分 ES 生产端直接写顶层）。
 *
 * profile 同理：`replyChannel.profile` → `metadata.profile`。
 */
export function targetFromEventMetadata(
  metadata: Record<string, unknown> | undefined,
): TelemetryNoticeTarget | undefined {
  if (!metadata) return undefined;

  const replyChannel = metadata.replyChannel as
    | { chatId?: unknown; profile?: unknown; params?: { sink?: unknown } }
    | undefined;

  const chatId = pickString(replyChannel?.chatId) ?? pickString(metadata.chatId);
  if (!chatId) return undefined;

  const profile = pickString(replyChannel?.profile) ?? pickString(metadata.profile);

  // ★ Task #4568（必做项）：从 `params.sink` 读出 CLI 的投递方式。
  //
  // 探针 D 实测：`replyChannel.params` 能完好穿过
  //   `_captureReplyChannelSnapshot()`（delegate-tool.ts:2668，整份保留 params）
  //   → `task.replyChannel.params`
  //   → `publishBackgroundEvent()` 写进 `event.metadata.replyChannel.params`
  // 但本函数**只取 chatId/profile，把整个 params 丢掉** —— 于是 sink 在这里断链：
  //   EventHandler 不知道是 CLI 触发 → 仍然 spawn `lark-cli ... --chat-id cli:xxx`
  //   → lark-cli 报 "invalid chat_id" → 被 swallow → **静默丢弃**（正是用户报障）。
  //
  // 顶层 `metadata.sink` 是兜底：`targetFromTriggerEvent()` 反查 EventStore 时，
  // 有些 handler 只把 sink 写顶层（cliCommandHandler 两处都写）。
  const sinkRaw =
    pickString(replyChannel?.params?.sink) ?? pickString(metadata.sink);
  // 白名单收窄：不认识的取值一律不透出（不猜、不降级到 stdout）
  const sink: "lark" | "stdout" | undefined =
    sinkRaw === "stdout" ? "stdout" : sinkRaw === "lark" ? "lark" : undefined;

  return {
    chatId,
    ...(profile ? { profile } : {}),
    // ★ 关键：sink 缺省时**不写这个 key**，保证 `toEqual({chatId})` 这类
    //   现有断言（1206 行 telemetry/rule-notice 测试）继续成立。
    ...(sink ? { sink } : {}),
  };
}

/**
 * 从 EventStore 反查 trigger event 拿目标。
 *
 * 这是 `replyChannel` 快照缺失时的兜底（老 delegate 路径 / 跨进程重启等）。
 * 与 `per-task-group-chat-plugin.resolveEffectiveChat()` 的 EventStore 分支
 * 同一套字段读取规则（`metadata.replyChannel.chatId` → `metadata.chatId`）。
 *
 * 任何异常 / 查不到 → undefined（调用方据此静默丢弃）。
 */
export async function targetFromTriggerEvent(
  eventStore: { getEventById: (id: string) => Promise<unknown> } | null | undefined,
  triggerEventId: string | undefined,
): Promise<TelemetryNoticeTarget | undefined> {
  if (!eventStore || !triggerEventId) return undefined;

  let persisted: unknown;
  try {
    persisted = await eventStore.getEventById(triggerEventId);
  } catch {
    return undefined;
  }
  if (!persisted || typeof persisted !== "object") return undefined;

  const metadata = (persisted as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return undefined;

  return targetFromEventMetadata(metadata as Record<string, unknown>);
}
