/**
 * @fileoverview Task #5203 — 企微真卡片（template_card）构造器
 *
 * ## 为什么存在
 *
 * #5193 用 markdown 模拟进展卡片（wecom-cli msg_type 无 template_card）。
 * Task #5202 官方文档实锤：aibot WS 长连接协议**原生支持** template_card
 * （aibot_send_msg 直发 + aibot_respond_update_msg 更新）——
 * wecom-cli 只是没封装，走 WecomWsBridge 直发即可。
 *
 * ## 协议依据（官方文档取证，Task #5202/#5203）
 *
 * - 主动推送（101463）：`{cmd:"aibot_send_msg", headers:{req_id},
 *   body:{chatid, chat_type, msgtype:"template_card", template_card:{...}}}`
 *   chat_type：1 单聊（userid）/ 2 群聊 / 0 兼容
 * - 模板卡片类型（101032）：
 *   - text_notice：main_title / emphasis_content 必填，card_action 必填
 *   - button_interaction：main_title / button_list / task_id 必填，
 *     button_list ≤6，按钮 key 最长 1024 字节不可重复
 *   - task_id：同一个机器人不能重复，只能由数字字母和 "_-@" 组成，≤128 字节
 * - 卡片更新（101463）：`{cmd:"aibot_respond_update_msg",
 *   headers:{req_id:事件回调透传}, body:{response_type:"update_template_card",
 *   template_card:{...}}}` — 仅适用于 template_card_event，5 秒内回复；
 *   template_card.task_id 须与回调收到的 task_id 一致
 * - 按钮点击回调：template_card_event，event.event_key = 按钮 key
 *
 * ## task_id 策略
 *
 * 企微的 task_id 是「同一张卡的标识」（更新时用），而我们的任务
 * 生命周期会**多次发卡**（每次进展一张新卡，企微无主动 patch）。
 * ⇒ 发卡时用 `newWecomCardTaskId(taskId)`（带序号/时间戳，保证不重复）；
 *   更新时必须用**回调里带回的 task_id**（buildWecomCardUpdateFrame 的
 *   taskId 参数 = 回调解析出的原始 task_id）。
 *
 * @see wecom-ws-bridge.ts（帧发送）
 * @see wecom-task-notify-plugin.ts（hook 接线）
 */

// ★ Task #5360：活性渲染（纯函数叶子模块；企微/飞书共用同一套 liveness 判定，
//   避免两渠道阈值漂移 —— 见 sub-session-activity.ts 头注释）
import {
  formatActivityQuote,
  type SubSessionActivity,
} from "../task/plugins/sub-session-activity";

/** 企微侧活性入参别名（与飞书侧同名类型，语义一致） */
export type WecomActivityLike = SubSessionActivity;

// ========================================================================
// 常量
// ========================================================================

/** 标准按钮动作 key（回调 event_key 据此分发） */
export const WecomCardActionKey = {
  /** 查看详情（刷操作时间线） */
  VIEW: "task_view",
  /** 标记完成 */
  MARK_DONE: "task_mark_done",
  /** 重新打开 */
  REOPEN: "task_reopen",
  /**
   * ★ Task #5360：刷新 sub-session 活性（消息数 + 最近一条消息）。
   *
   * ## 为什么与 VIEW 分成两个按钮（而不是把活性塞进「刷新详情」）
   *
   * 企微 `horizontal_content_list` 协议上限 **6 条**（`MAX_HORIZONTAL_ROWS`），
   * 而进展/更新卡的 6 条已经被「状态 + 5 条操作时间线」占满。把活性挤进去
   * 必然挤掉操作时间线 —— 直接违反用户「之前展示的信息一个都不能少」。
   *
   * 所以：`task_view` 管时间线（旧语义零变更），`task_refresh_activity`
   * 管活性（走 quote_area，不占 horizontal 预算）。
   */
  REFRESH_ACTIVITY: "task_refresh_activity",
  /**
   * ★ Task #5419：建**关联飞书群**（对齐飞书 #5403/#5397）。
   *
   * 用户 2026-11-13：「另外也有按钮进行飞书建群哈，功能跟飞书一样，
   * 建关联飞书群，建完可以展示或者发一条企微消息带上飞书群跳转链接哈」
   *
   * ## 为什么企微卡可以有「飞书群」按钮
   *
   * wecom-card-builder 旧注释（#5360）说「企微侧本来就没有 per-task
   * 群概念」—— 那指的是**企微群**。#5403 之后建群的目标是
   * **飞书群**（群 session 独立 + 注入背景事件），与企微群概念
   * 正交：企微只是「遥控器」，群在飞书侧。
   */
  CREATE_LARK_GROUP: "task_create_lark_group",
} as const;

export type WecomCardActionKey =
  (typeof WecomCardActionKey)[keyof typeof WecomCardActionKey];

/** 企微按钮 style：1 默认蓝 / 2 次要灰 / 3 / 4 强调（官方 1~4） */
export type WecomButtonStyle = 1 | 2 | 3 | 4;

// ========================================================================
// 类型（对齐官方 101032 结构体）
// ========================================================================

export interface WecomCardButton {
  text: string;
  style?: WecomButtonStyle;
  key: string;
}

export interface WecomHorizontalContent {
  keyname: string;
  value: string;
  type?: 0 | 1;
  url?: string;
}

export interface WecomMilestoneLite {
  title: string;
  timestamp: string;
  description?: string;
}

/** text_notice 卡片结构（只声明我们用到的字段） */
export interface WecomTextNoticeCard {
  card_type: "text_notice";
  main_title: { title: string; desc?: string };
  emphasis_content: { title: string; desc: string };
  sub_title_text?: string;
  horizontal_content_list: WecomHorizontalContent[];
  quote_area: {
    type?: number;
    title: string;
    quote_text: string;
  };
  card_action: { type: number; url?: string };
}

/** button_interaction 卡片结构（只声明我们用到的字段） */
export interface WecomButtonInteractionCard {
  card_type: "button_interaction";
  main_title: { title: string; desc?: string };
  sub_title_text?: string;
  horizontal_content_list?: WecomHorizontalContent[];
  quote_area?: {
    type?: number;
    title: string;
    quote_text: string;
  };
  button_list: WecomCardButton[];
  card_action?: { type: number; url?: string };
  /** ★ 必填：同一机器人不能重复；更新时须与回调一致 */
  task_id: string;
}

// ========================================================================
// task_id 生成
// ========================================================================

/**
 * 任务的稳定 task_id 前缀：`roy-task-<taskId>`。
 *
 * 用途：
 * - 发卡时作为 `newWecomCardTaskId` 的前缀（可从回调 task_id 反解任务号）
 * - 更新时**不能**用它（发卡用的是带序号的全量 id）——
 *   更新帧的 task_id 必须原样用回调带回的值
 */
export function wecomCardTaskIdForTask(taskId: number): string {
  return `roy-task-${taskId}`;
}

/**
 * ★ 补充需求（22:31）：**session 卡**的稳定 task_id 前缀。
 *
 * 与 `roy-task-` 并列 —— 回调时用它区分「这张卡挂在 task 上」还是
 * 「挂在 sub-session 上」。两种前缀互不包含（`roy-task-` vs `roy-session-`），
 * 反解无歧义。
 */
export const ROY_SESSION_PREFIX = "roy-session-";

/**
 * 造 session 卡的稳定 task_id。
 *
 * ## 格式（★ 澄清 22:37：session 是主键，task 是附加值）
 *
 * ```
 * roy-session-<sessionId>                ← 无关联 task
 * roy-session-<sessionId>@task-<taskId>  ← 有关联 task
 * ```
 *
 * 用 `@task-` 而不是再嵌前缀：企微 task_id 字符集限定「数字字母和 `_-@`」，
 * `@` 合法；且 `roy-session-` 与 `roy-task-` 本来就互斥，反解无歧义。
 *
 * ⚠️ 反解时**只取 sessionId 部分**（task 段仅用于诊断/未来扩展）——
 * 刷新永远读 session store，这是本次澄清的核心。
 */
export function wecomCardTaskIdForSession(
  sessionId: string,
  taskId?: number,
): string {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) throw new Error("wecomCardTaskIdForSession: sessionId is required");
  const base = `${ROY_SESSION_PREFIX}${id}`;
  if (typeof taskId === "number" && Number.isSafeInteger(taskId) && taskId > 0) {
    return `${base}${WECOM_SESSION_TASK_SEP}${taskId}`;
  }
  return base;
}

/** session 卡 task_id 里「附加 task 段」的分隔符 */
export const WECOM_SESSION_TASK_SEP = "@task-";

let cardSeq = 0;

/**
 * 生成一张新卡的 task_id：`roy-task-<taskId>-<seq>-<rand>`。
 *
 * 协议硬约束：同一机器人不能重复 → 加序号 + 随机后缀。
 * 字符集：数字字母和 "_-@"（官方 101032）。
 */
export function newWecomCardTaskId(taskId: number): string {
  cardSeq = (cardSeq + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${wecomCardTaskIdForTask(taskId)}-${cardSeq}-${rand}`;
}

// ========================================================================
// text_notice 进展卡
// ========================================================================

/** ISO 时间 → 本地可读（YYYY-MM-DD HH:mm） */
function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function clip(text: string | undefined, max: number): string {
  if (!text) return "";
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * ★ Task #5275：milestone_title → horizontal 行短 value。
 *
 * 真网截图实证：value 塞长标题在窄卡（~240px）单行渲染
 * 末尾被截（「待验证（to_validate）：Task…」）。
 * 官方建议 value ≤30 字 —— 但「截到 30 字 + …」观感仍差。
 *
 * 短化策略（语义首段优先）：
 * ① 取第一个全角冒号「：」前的短语（「待验证（to_validate）：…」
 *    →「待验证」；「返工完成：commit…」→「返工完成」）
 * ② 无冒号 → 原样（短标题不截）
 * ③ 兜底：仍超 30 字 → clipWord 截断（不切词）
 */
function shortMilestoneValue(text: string | undefined): string {
  if (!text) return "";
  const t = text.trim();
  const colonIdx = t.indexOf("：");
  const head =
    colonIdx > 0 && colonIdx <= 20 ? t.slice(0, colonIdx).trim() : t;
  if (head.length <= MAX_HORIZONTAL_VALUE) return head;
  return clipWord(head, MAX_HORIZONTAL_VALUE);
}

/**
 * 按上限裁剪且**不切单词**（Task #5203 截断修复）。
 *
 * 真网实证：quote_area/horizontal 长文本被客户端截断成
 * 「Task complete d」这种切词产物。裁剪时回退到最后一个
 * 单词边界（空格/标点），保证不出现半个英文单词。
 *
 * DS review（Task #5203）MINOR 修复：
 * 原实现只回退到「最后一个空格」，注释却声称回退到
 * 「空格 / CJK↔ASCII 交界」——无空格长串（如
 * `SupercalifragilisticexpialidociousExtraLong`）会被硬切
 * 成半个单词 + 省略号。现改为：
 * ① 有空格 → 回退到最后一个空格边界（不切词）
 * ② 无空格但存在 CJK↔ASCII 交界 → 回退到该交界
 * ③ 无任何可回退边界（纯 ASCII 长串）→ 硬截但**不接省略号**
 *    （宁可少一个字，也不出现「半个单词 + …」）
 */
function clipWord(text: string | undefined, max: number): string {
  if (!text) return "";
  const t = text.trim();
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1); // 留 1 位给省略号
  // ① 回退到最后一个空格边界（不切词）
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > max * 0.4) return `${cut.slice(0, lastSpace).trimEnd()}…`;
  // ② 回退到最后一个 CJK↔ASCII 交界（避免把英文词与中文黏在一起切开）
  const cjkBoundary = findCjkAsciiBoundary(cut);
  if (cjkBoundary > max * 0.4) return `${cut.slice(0, cjkBoundary).trimEnd()}…`;
  // ③ 纯 ASCII 长串：无边界可退 → 硬截且不接省略号（避免半个单词 + …）
  return cut.slice(0, max - 1);
}

/**
 * 找最后一个「CJK 字符 ↔ ASCII 字母数字」交界位置（即该字符的起始下标）。
 * 无交界返回 -1。
 */
function findCjkAsciiBoundary(text: string): number {
  const isCjk = (ch: string) => /[一-鿿぀-ヿ가-힯]/.test(ch);
  const isAsciiAlnum = (ch: string) => /[A-Za-z0-9]/.test(ch);
  for (let i = text.length - 1; i > 0; i--) {
    const prev = text[i - 1];
    const cur = text[i];
    if (isCjk(prev) !== isAsciiAlnum(cur) && (isCjk(cur) !== isAsciiAlnum(prev))) {
      // 仅在「CJK ↔ ASCII」这一种交界上回退
      if ((isCjk(prev) && isAsciiAlnum(cur)) || (isAsciiAlnum(prev) && isCjk(cur))) {
        return i;
      }
    }
  }
  return -1;
}

/** quote_area 时间线最多行数（防超长，官方 sub_title 建议 ≤112 字） */
const MAX_TIMELINE_LINES = 8;

/** horizontal_content_list 时间线行数（协议上限 6，含「状态」行） */
const MAX_HORIZONTAL_ROWS = 6;

/** HorizontalContent.value 官方建议 ≤26 字 */
const MAX_HORIZONTAL_VALUE = 26;

/** HorizontalContent.keyname 官方建议 ≤5 字 */
const MAX_HORIZONTAL_KEYNAME = 5;

/**
 * 构造 text_notice 进展卡（任务状态一览）。
 *
 * 信息密度对齐 #5193 markdown 卡：标题+进度+状态+时间线+最新操作。
 */
export function buildWecomTextNoticeCard(input: {
  taskId: number;
  title: string;
  statusLabel: string;
  progress: number;
  description?: string;
  changeSummary?: string;
  milestones: WecomMilestoneLite[];
  /** 终态（completed/cancelled/…）→ sub_title_text 收尾文案 */
  terminal?: boolean;
}): WecomTextNoticeCard {
  const progressPct = `${Math.max(0, Math.min(100, Math.round(input.progress ?? 0)))}%`;

  // 时间线（最新在最后 → 渲染时倒序，最新在上）
  const sorted = [...input.milestones].slice(-MAX_TIMELINE_LINES).reverse();

  // ★ Task #5203 截断修复：时间线主体走 horizontal_content_list
  //   （真网实证 quote_area 只渲染 ~2 行且切词）。horizontal 官方
  //   上限 6 条、keyname ≤5 字、value ≤26 字。
  // ★ Task #5275：value 短化（语义首段），完整内容挪 sub_title_text。
  const timelineRows = sorted
    .slice(0, MAX_HORIZONTAL_ROWS - 1) // 留 1 行给「状态」
    .map((m) => ({
      keyname: formatTs(m.timestamp).slice(11), // HH:mm（≤5 字）
      value: shortMilestoneValue(m.title),
    }));

  const horizontal: WecomHorizontalContent[] = [
    { keyname: "状态", value: clip(input.statusLabel, MAX_HORIZONTAL_VALUE) },
    ...timelineRows,
  ];

  const latest = sorted[0];

  // quote_area 只留 1 行（最新一条），不再塞多行时间线
  const quoteLine = latest
    ? `${formatTs(latest.timestamp)} — ${clipWord(latest.title, 80)}${
        latest.description ? `：${clipWord(latest.description, 80)}` : ""
      }`
    : "";

  // ★ Task #5275：sub_title_text（官方建议 ≤160 字）承载
  //   最新一条的完整标题——横向行短化后，长内容在这里
  //   仍可见（窄卡下 sub_title_text 可换行渲染）。
  const latestSummary =
    latest && latest.title
      ? `${formatTs(latest.timestamp)} ${clip(latest.title, 140)}`
      : undefined;

  const subTitle = input.terminal
    ? `任务${input.statusLabel.replace(/^[^\u4e00-\u9fa5A-Za-z]*/, "")} · 详见会话`
    : latestSummary;

  return {
    card_type: "text_notice",
    main_title: {
      title: `📋 Task #${input.taskId} · ${clip(input.title, 60)}`,
      desc: clip(input.description, 80) || undefined,
    },
    emphasis_content: {
      title: progressPct,
      desc: "进度",
    },
    sub_title_text: subTitle,
    horizontal_content_list: horizontal,
    // ★ Task #5203 真网实证：quote_area.type=1（带 url 引用样式）
    //   要求同时给 url，否则 errcode 42028「Template_Card Missing Url」。
    //   我们不带 url → 用 type:0（纯引用文本）。
    quote_area: {
      type: 0,
      title: "最新进展",
      quote_text: quoteLine || "（暂无操作记录）",
    },
    // card_action.type=1（跳 url）同样要求 url；type:0 = 无跳转
    card_action: { type: 0 },
  };
}

// ========================================================================
// button_interaction 交互卡
// ========================================================================

/** 按钮列表协议上限 */
const MAX_BUTTONS = 6;

/** 按钮文案建议 ≤10 字（官方建议，超长截断） */
const MAX_BUTTON_TEXT = 10;

/**
 * 构造 button_interaction 交互卡（可点击按钮更新状态）。
 *
 * @param input.taskId 用于生成 task_id（回调据此反解任务）
 * @param input.buttons 超过 6 个时只取前 6 个（协议上限）
 */
export function buildWecomButtonInteractionCard(input: {
  taskId: number;
  title: string;
  statusLabel: string;
  progress: number;
  description?: string;
  changeSummary?: string;
  milestones?: WecomMilestoneLite[];
  buttons: WecomCardButton[];
  /** 已有的 task_id（更新场景复用；发新卡时不传自动生成） */
  cardTaskId?: string;
}): WecomButtonInteractionCard {
  const notice = buildWecomTextNoticeCard({
    taskId: input.taskId,
    title: input.title,
    statusLabel: input.statusLabel,
    progress: input.progress,
    description: input.description,
    changeSummary: input.changeSummary,
    milestones: input.milestones ?? [],
  });

  const buttons = (input.buttons ?? [])
    .slice(0, MAX_BUTTONS)
    .map((b) => ({
      text: clip(b.text, MAX_BUTTON_TEXT),
      style: b.style ?? 1,
      key: b.key,
    }));

  return {
    card_type: "button_interaction",
    main_title: notice.main_title,
    sub_title_text: notice.sub_title_text,
    horizontal_content_list: notice.horizontal_content_list,
    quote_area: notice.quote_area,
    button_list: buttons,
    // 官方 CardAction 定义：type=1 表示「跳转 url」且 url 必填；
    // type=0（或不填）表示「不是链接」。
    // 本卡是纯按钮交互（点击走 template_card_event 回调，不做整卡跳转），
    // 因此必须用 type=0 —— 真网实证 type=1 缺 url 会报 42028。
    card_action: { type: 0 },
    task_id: input.cardTaskId ?? newWecomCardTaskId(input.taskId),
  };
}

// ========================================================================
// ★ Task #5360：session 卡（企微侧「以 sub-session 为基底」）
// ========================================================================

/** session 层生命周期（与飞书侧同义） */
export type WecomSessionLifecycle =
  | "running"
  | "completed"
  | "timeout"
  | "failed"
  | "stopped";

/**
 * ★ Task #5364（DS review R1 MAJOR-2）—— **刷新帧**用的生命周期。
 *
 * 比 `WecomSessionLifecycle` 多一个 `unknown`：刷新时若持久层没有该
 * session 的记录（进程重启 / store 读失败 / 更早版本发的卡），我们
 * **不知道**它是什么状态。此时必须如实说「未知」而不是乐观地报
 * 「运行中」—— 后者会和活性侧的 🔴 疑似停滞 同时出现在一张卡上，
 * 给用户两个互相矛盾的信号。
 */
export type WecomSessionUpdateLifecycle = WecomSessionLifecycle | "unknown";

/** lifecycle → 状态文案（与飞书 SESSION_LIFECYCLE_PHRASE 一致，避免两渠道口径漂移） */
const WECOM_SESSION_LIFECYCLE_PHRASE: Record<WecomSessionUpdateLifecycle, string> = {
  running: "运行中",
  completed: "已完成",
  timeout: "已超时",
  failed: "已失败",
  stopped: "已停止",
  unknown: "状态未知",
};

/** 卡片 main_title 标题截断（`📊 子会话 · <标题>` 总长受控） */
const MAX_SESSION_TITLE = 100;

/**
 * ★ Task #5360（用户明令「企微也是这个逻辑」）—— 构造**企微 session 卡**。
 *
 * ## 与 task 卡的关系：并列，共用零件
 *
 * 不复用 `buildWecomButtonInteractionCard` 的原因：那个签名是
 * `taskId: number`（必填）+ `buildWecomTextNoticeCard` 的进度百分比语义，
 * session 没有 task 号也没有「进度 %」。硬塞会渲染出 `Task #0` / `0%` 这类噪音。
 *
 * 共用的是：`WecomButtonInteractionCard` 结构、按钮裁剪、`formatActivityQuote`
 * （⇒ 活性阈值与文案与飞书/企微 task 卡**完全一致**，不会出现同一个
 * session 在两个渠道颜色不同）。
 *
 * ## 主键
 *
 * `task_id = roy-session-<sessionId>[@task-<n>]` —— 回调时
 * `parseRoySessionId` 反解出干净的 sessionId，刷新走 session 主键路径。
 *
 * ## 建群按钮（★ Task #5419 更新）
 *
 * #5360 时企微侧没有建群按钮（当时建群目标是企微群，确实没有）。
 * #5403 之后建群目标改为**飞书群**（独立群 session + 背景事件），
 * 企微卡只是遥控入口 —— 用户 2026-11-13 明令「也有按钮进行飞书
 * 建群哈，功能跟飞书一样」。故 session 卡无条件渲染「建飞书群」。
 */
export function buildWecomSessionCard(input: {
  /** ★ 主键：sub-session id */
  sessionId: string;
  /** session 层生命周期（★ 与有无 task 无关） */
  lifecycle?: WecomSessionLifecycle;
  /** 会话标题（描述 / agent 名）；缺省用 sessionId 截断 */
  title?: string;
  /** 所属 agent（subagentType） */
  agentType?: string;
  /** 开始时间（ISO） */
  startedAt?: string;
  /** 已运行时长（人类可读） */
  elapsedText?: string;
  /**
   * ★ 该 session 内创建的 task（可选增强）。
   * 有 → 卡上多一行任务信息；无 → 只显示 session 活性。
   */
  task?: {
    id: number;
    title?: string;
    status?: string;
    progress?: number;
  };
  /** 活性快照。undefined = 不渲染；null = 暂无数据 */
  activity?: WecomActivityLike | null;
  activityNow?: number;
  /** 执行动态（会话级里程碑） */
  milestones?: WecomMilestoneLite[];
}): WecomButtonInteractionCard {
  const lifecycle: WecomSessionLifecycle = input.lifecycle ?? "running";
  const statusLabel = WECOM_SESSION_LIFECYCLE_PHRASE[lifecycle];
  const terminal = lifecycle !== "running";

  // ---- main_title：`📊 子会话 · <title 或 sessionId 截断> · <状态>` ----
  const headRaw = input.title?.trim() || input.sessionId;
  const head = clip(headRaw, MAX_SESSION_TITLE);
  const titleParts = [`📊 子会话`, head, statusLabel];

  // ---- horizontal_content_list：会话 + 可选 task 信息 ----
  //
  // 企微协议建议 value ≤26 字、行数 ≤6。这里最多 5 行（留余量）。
  const rows: WecomHorizontalContent[] = [];
  rows.push({ keyname: "会话", value: clip(input.sessionId, MAX_HORIZONTAL_VALUE) });
  if (input.agentType) {
    rows.push({ keyname: "Agent", value: clip(input.agentType, MAX_HORIZONTAL_VALUE) });
  }
  if (input.elapsedText) {
    rows.push({ keyname: "已运行", value: clip(input.elapsedText, MAX_HORIZONTAL_VALUE) });
  }
  // ★ 可选 task 增强（用户要求「有 task 就把信息同步进卡片」）
  if (input.task) {
    rows.push({
      keyname: "任务",
      value: clip(
        `#${input.task.id}${input.task.title ? ` ${input.task.title}` : ""}`,
        MAX_HORIZONTAL_VALUE,
      ),
    });
    if (input.task.status) {
      rows.push({
        keyname: "任务状态",
        value: clip(input.task.status, MAX_HORIZONTAL_VALUE),
      });
    }
  }

  // ---- 活性：与 task 卡同源（formatActivityQuote）----
  //
  // 三态：undefined 不渲染 / null 暂无数据 / 快照渲染。
  let quoteArea: { type?: number; title: string; quote_text: string } | undefined;
  let subTitle: string | undefined;
  if (input.activity !== undefined) {
    const q = formatActivityQuote(
      input.activity ?? undefined,
      input.activityNow ?? Date.now(),
      // ★ 终态由 session 生命周期决定（没 task 的执行一样会超时/完成）
      terminal,
    );
    if (q.overflow) {
      subTitle = q.text.replace(/\n/g, " · ");
    } else {
      quoteArea = { type: 0, title: q.title, quote_text: q.text };
    }
  } else if (input.milestones && input.milestones.length > 0) {
    // 没有活性时用最近一条执行动态占位（不占 quote 预算以免与活性冲突）
    const latest = input.milestones[input.milestones.length - 1];
    subTitle = clipWord(latest.title, 60);
  }

  return {
    card_type: "button_interaction",
    main_title: {
      title: titleParts.join(" · "),
    },
    sub_title_text: subTitle,
    horizontal_content_list: rows,
    ...(quoteArea ? { quote_area: quoteArea } : {}),
    button_list: [
      {
        text: "刷新活性",
        style: 1,
        key: WecomCardActionKey.REFRESH_ACTIVITY,
      },
      // ★ Task #5419：建关联飞书群（对齐飞书 #5397「无条件渲染」）
      {
        text: "建飞书群",
        style: 1,
        key: WecomCardActionKey.CREATE_LARK_GROUP,
      },
    ],
    // 纯按钮交互（不做整卡跳转）⇒ type=0，避免 type=1 缺 url 报 42028
    card_action: { type: 0 },
    // ★ 主键：roy-session-<sid>[@task-<n>]
    task_id: wecomCardTaskIdForSession(input.sessionId, input.task?.id),
  };
}

// ========================================================================
// WS 帧：主动推送（aibot_send_msg）
// ========================================================================

/**
 * 构造 aibot_send_msg 直发 template_card 帧。
 *
 * @param input.chatType "single"（chat_type=1，chatid=userid）|
 *                      "group"（chat_type=2，chatid=群 chatid）
 */
export function buildWecomSendCardFrame(input: {
  chatId: string;
  chatType: "single" | "group";
  card: WecomTextNoticeCard | WecomButtonInteractionCard;
  /** 显式 req_id（缺省自动生成 aibot_send_msg_ 前缀） */
  reqId?: string;
}): { cmd: string; headers: { req_id: string }; body: Record<string, unknown> } {
  const reqId =
    input.reqId && input.reqId.trim()
      ? input.reqId.trim()
      : `aibot_send_msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    cmd: "aibot_send_msg",
    headers: { req_id: reqId },
    body: {
      chatid: input.chatId,
      chat_type: input.chatType === "group" ? 2 : 1,
      msgtype: "template_card",
      template_card: input.card,
    },
  };
}

// ========================================================================
// WS 帧：卡片更新（aibot_respond_update_msg）
// ========================================================================

/** 更新卡 main_title 标题截断上限（clip 60 字 + …，实际 ≤61 字符） */
const MAX_UPDATE_TITLE = 60;

/**
 * ★ Task #5273：更新卡 main_title 渲染。
 *
 * - 全量：`📋 Task #<n> · <title> · <statusLabel>`
 * - 只有标题：`📋 <title> · <statusLabel>`
 * - 只有任务号：`📋 Task #<n> · <statusLabel>`
 * - 缺省：`📋 <statusLabel>`（向后兼容旧调用方）
 *
 * ★ CV-m1（Task #5273 返工）：段间分隔符只在「前段存在」时追加，
 *   不再出现 `📋 · <title>` / `Task #5 ·` 悬挂分隔符。
 */
function buildUpdateMainTitle(
  statusLabel: string,
  taskNumber?: number,
  taskTitle?: string,
): string {
  const segments: string[] = [];
  if (taskNumber !== undefined && Number.isFinite(taskNumber)) {
    segments.push(`Task #${taskNumber}`);
  }
  if (taskTitle) {
    segments.push(clip(taskTitle, MAX_UPDATE_TITLE));
  }
  segments.push(statusLabel);
  return segments.length > 1
    ? `📋 ${segments.join(" · ")}`
    : `📋 ${statusLabel}`;
}

/**
 * 构造 aibot_respond_update_msg 更新帧（按钮点击后 5 秒窗口内）。
 *
 * ★ 协议硬约束：
 * - req_id 必须**原样透传** template_card_event 回调帧的 req_id
 * - template_card.task_id 必须与回调收到的 task_id 一致
 *   （回调的 task_id 是发卡时的全量 id，不是 roy-task-<n> 前缀）
 *
 * @param input.taskId 回调解析出的**原始** task_id（原样回填）
 */
export function buildWecomCardUpdateFrame(input: {
  reqId: string;
  /** 回调带回的原始 task_id（原样回填，不做转换） */
  taskId: string;
  statusLabel: string;
  note?: string;
  /** 更新后的按钮列表（如把「标记完成」换成「已确认」） */
  buttonOverrides?: WecomCardButton[];
  /**
   * ★ Task #5203 时间线详情：操作记录（milestones + processSteps）
   * 渲染成 quote_area 引用文本（每行一条，最新在上）。
   */
  timeline?: WecomMilestoneLite[];
  /**
   * ★ Task #5273：任务标题（可选）。
   *
   * 用户反馈更新卡缺任务号/标题 → main_title 从
   * `📋 ${statusLabel}` 升级为
   * `📋 Task #<n> · <title> · ${statusLabel}`（缺省字段自动省略，
   * 向后兼容旧调用方）。
   */
  taskTitle?: string;
  /** ★ Task #5273：roy 任务号（可选，与 taskTitle 配对渲染） */
  taskNumber?: number;
  /**
   * ★ Task #5360：sub-session 活性（用户点「刷新活性」时传入）。
   *
   * - `undefined` → 不渲染活性（普通 view / mark_done，行为与改造前一致）
   * - `null`      → 渲染「暂无数据」（用户点过了，必须有反馈）
   * - 快照        → 渲染信号灯 + 消息数 + 最近消息
   */
  activity?: WecomActivityLike | null;
  /** ★ Task #5360：活性时间基准（注入便于测试；缺省 Date.now()） */
  activityNow?: number;
  /** ★ Task #5360：任务是否终态（决定报「已结束」而非「疑似停滞」） */
  activityTerminal?: boolean;
}): {
  cmd: string;
  headers: { req_id: string };
  body: Record<string, unknown>;
} {
  const reqId = (input.reqId ?? "").trim();
  if (!reqId) {
    throw new Error(
      "buildWecomCardUpdateFrame: req_id is required " +
        "(update must reference the template_card_event frame)",
    );
  }
  const buttons = (input.buttonOverrides ?? [])
    .slice(0, MAX_BUTTONS)
    .map((b) => ({
      text: clip(b.text, MAX_BUTTON_TEXT),
      style: b.style ?? 1,
      key: b.key,
    }));

  // ★ Task #5203 截断修复：时间线走 horizontal_content_list
  //   （真网实证 quote_area 只渲染 ~2 行且切词）。
  //   协议上限：6 条、keyname ≤5 字、value ≤26 字。
  // ★ Task #5275：value 短化（语义首段），与进展卡同策略。
  const sorted = [...(input.timeline ?? [])].reverse();
  const timelineRows = sorted
    .slice(0, MAX_HORIZONTAL_ROWS)
    .map((m) => ({
      keyname: formatTs(m.timestamp).slice(11), // HH:mm（≤5 字）
      value: shortMilestoneValue(m.title),
    }));
  const total = sorted.length;
  let subTitle =
    total > 0
      ? total > MAX_HORIZONTAL_ROWS
        ? `共 ${total} 条操作记录，显示最近 ${MAX_HORIZONTAL_ROWS} 条（最新在顶部）`
        : `共 ${total} 条操作记录（最新在顶部）`
      : undefined;

  // ---- ★ Task #5360：sub-session 活性 ----
  //
  // 用户诉求：「企微卡片同步新增：subsession 消息数 + 最近 msg（截断展示）」
  //
  // ## 位置选型：quote_area 优先，超限降级到 sub_title_text
  //
  // | 候选 | 结论 |
  // |------|------|
  // | `horizontal_content_list` | ❌ 协议上限 6 条已被「状态 + 时间线」占满，
  //   塞进去必然挤掉时间线 → 违反「旧信息一个都不能少」 |
  // | `main_title.desc` | ❌ 那是 note（本轮动作说明），挤掉会丢语义 |
  // | **`quote_area`** | ✅ 本帧当前未使用，官方 schema 里 optional，语义是
  //   "引用一段补充说明"，正合适 |
  // | `sub_title_text` | 兜底（官方建议 ≤112~160 字，与"共 N 条操作记录"共用） |
  //
  // ## 为什么必须代码内降级（不能只写在文档）
  //
  // `aibot_respond_update_msg` 的 `quote_area` 渲染能力未经真网验证（Task #5203
  // 只验证过 `text_notice` 的 quote_area）。若真网不渲染，用户点按钮 = 无反馈。
  // 所以：活性渲染出来超长就落 sub_title_text，绝不两条都不放。
  let quoteArea:
    | { type?: number; title: string; quote_text: string }
    | undefined;
  if (input.activity !== undefined) {
    const q = formatActivityQuote(
      input.activity ?? undefined,
      input.activityNow ?? Date.now(),
      input.activityTerminal ?? false,
    );

    if (q.overflow) {
      // 超长 → 不塞 quote（企微会切词），把活性压成一行接在 sub_title 里。
      // 时间线统计行保留在最前（旧信息优先）。
      const oneLine = q.text.replace(/\n/g, " · ");
      subTitle = subTitle ? `${subTitle}\n${oneLine}` : oneLine;
      quoteArea = undefined;
    } else {
      quoteArea = { type: 0, title: q.title, quote_text: q.text };
    }
  }

  return {
    cmd: "aibot_respond_update_msg",
    headers: { req_id: reqId },
    body: {
      response_type: "update_template_card",
      template_card: {
        card_type: "button_interaction",
        // ★ Task #5273：main_title 补任务号+标题
        //（缺省时回落为原 `📋 ${statusLabel}`，向后兼容）
        main_title: {
          title: buildUpdateMainTitle(
            input.statusLabel,
            input.taskNumber,
            input.taskTitle,
          ),
          desc: input.note ? clip(input.note, 80) : undefined,
        },
        sub_title_text: subTitle,
        horizontal_content_list: timelineRows,
        ...(quoteArea ? { quote_area: quoteArea } : {}),
        button_list: buttons,
        task_id: String(input.taskId),
      },
    },
  };
}

// ========================================================================
// ★ Task #5364：session 卡「刷新帧」（B 方案：按钮驱动更新）
// ========================================================================

/** 刷新帧 main_title 里会话标题的截断上限 */
const MAX_SESSION_UPDATE_HEAD = 40;

/**
 * ★ Task #5364（用户 2026-11-12 08:34 拍板 B）——
 * 构造 **session 卡的更新帧**（`aibot_respond_update_msg`）。
 *
 * ## 为什么需要它（B 方案的落点）
 *
 * 企微协议：`aibot_respond_update_msg` 只能在 `template_card_event` 回调的
 * 5 秒窗口内、用回调带回的 `req_id` 发。生命周期事件没有 req_id ⇒ **无法主动
 * patch**。所以「一张卡承载整个生命周期」只能靠**用户点按钮把窗口打开**。
 *
 * ⇒ 这张帧必须在**一次渲染里装齐全部信息**（这是用户唯一能看到的最新快照）：
 *
 * | 信息 | 来源 | 为什么不能省 |
 * |------|------|--------------|
 * | 生命周期状态 | store.lifecycle | 用户要知道「跑完了没 / 是超时还是失败」 |
 * | 会话详情（id/agent/已运行） | store + startedAt | 首次发卡时的信息，刷新不能擦掉 |
 * | 任务增强（Task #id/title/status） | store.associatedTaskId → task | 有 task 时后端不再发 task 卡，信息必须在这 |
 * | 操作记录（milestones 时间线） | store.milestones | 「这一路发生了什么」 |
 * | 活性（消息数 + 最近 msg） | 实时 probe | 判断 LLM 有没有真在推进 |
 *
 * ## 与 `buildWecomSessionCard`（首发帧）的关系
 *
 * 同一套排版口径（生命周期文案表 / 行裁剪 / `formatActivityQuote`），
 * 但它是**整卡替换**（update 帧的 schema 要求），所以这里重新组装一份，
 * 而不是复用首发卡的返回值 —— 首发卡是 `aibot_send_msg` 的 body 形状。
 *
 * @param input.reqId 回调带回的 req_id（**必须**，缺失直接抛）
 * @param input.cardTaskId 回调带回的原始 `template_card.task_id`（原样回填）
 */
export function buildWecomSessionUpdateFrame(input: {
  reqId: string;
  /** 回调带回的原始 task_id（协议要求原样回填） */
  cardTaskId: string;
  sessionId: string;
  lifecycle: WecomSessionUpdateLifecycle;
  /** 会话标题（缺省用 sessionId 截断） */
  title?: string;
  agentType?: string;
  /** 开始时间（ISO）；用于算「已运行」 */
  startedAt?: string;
  /** 已运行时长（优先用调用方算好的；缺省由 startedAt + now 推导） */
  elapsedText?: string;
  /** 关联 roy 任务（可选增强） */
  task?: {
    id: number;
    title?: string;
    status?: string;
    progress?: number;
  };
  /** 累积操作记录（最新在后；渲染时反转成最新在顶部） */
  milestones?: WecomMilestoneLite[];
  /**
   * ★ Task #5419：该 session 已关联的**飞书群** chatId。
   *
   * 有 ⇒ horizontal 加一行「飞书群」（applink 跳转），
   * 建群后按钮翻面语义由 handler 控制（幂等命中不重复建）。
   */
  perTaskChatId?: string;
  /** ★ CV 5419 MAJOR-3：建群失败提示（渲染进 sub_title） */
  errorHint?: string;
  /** 活性快照。undefined = 不渲染；null = 暂无数据（用户点了必须有反馈） */
  activity?: WecomActivityLike | null;
  /** 时间基准（注入便于测试） */
  now?: number;
}): {
  cmd: string;
  headers: { req_id: string };
  body: Record<string, unknown>;
} {
  const reqId = (input.reqId ?? "").trim();
  if (!reqId) {
    throw new Error(
      "buildWecomSessionUpdateFrame: req_id is required " +
        "(update must reference the template_card_event frame)",
    );
  }

  const now = input.now ?? Date.now();
  const lifecycle = input.lifecycle;
  const statusLabel = WECOM_SESSION_LIFECYCLE_PHRASE[lifecycle];
  const terminal = lifecycle !== "running";

  // ---- main_title：`📊 子会话 · <title 或 sid> · <状态>` ----
  const headRaw = input.title?.trim() || input.sessionId;
  const head = clip(headRaw, MAX_SESSION_UPDATE_HEAD);
  const mainTitle = `📊 子会话 · ${head} · ${statusLabel}`;

  // ---- horizontal_content_list（协议上限 6 行）----
  //
  // 优先级（信息不丢 + 协议合规的折中）：
  //   1. 状态（生命周期，永远有）
  //   2. 会话（sessionId，身份）
  //   3. Agent（若有）
  //   4. 已运行（若有时间基准）
  //   5. 任务（若有）
  //   6.~ 操作记录（剩余预算）
  //
  // 超预算时**先牺牲操作记录行数**（它的完整历史仍在 store 里，
  // 且 quote/sub_title 里有「共 N 条」的提示），绝不牺牲状态/身份/任务。
  const rows: WecomHorizontalContent[] = [];
  rows.push({
    keyname: clip("状态", MAX_HORIZONTAL_KEYNAME),
    value: clip(statusLabel, MAX_HORIZONTAL_VALUE),
  });
  rows.push({
    keyname: clip("会话", MAX_HORIZONTAL_KEYNAME),
    value: clip(input.sessionId, MAX_HORIZONTAL_VALUE),
  });
  if (input.agentType) {
    rows.push({
      keyname: clip("Agent", MAX_HORIZONTAL_KEYNAME),
      value: clip(input.agentType, MAX_HORIZONTAL_VALUE),
    });
  }
  const elapsed =
    input.elapsedText ?? formatElapsedText(input.startedAt, now, terminal);
  if (elapsed) {
    rows.push({
      keyname: clip("已运行", MAX_HORIZONTAL_KEYNAME),
      value: clip(elapsed, MAX_HORIZONTAL_VALUE),
    });
  }
  if (input.task) {
    rows.push({
      keyname: clip("任务", MAX_HORIZONTAL_KEYNAME),
      value: clip(
        `#${input.task.id}${input.task.title ? ` ${input.task.title}` : ""}`,
        MAX_HORIZONTAL_VALUE,
      ),
    });
  }
  // ★ Task #5419：已关联飞书群 ⇒ 渲染群跳转行（对齐飞书「进入专属群」）。
  //   优先级：群行 > 任务状态行（群链接是用户可点的行动入口）。
  if (input.perTaskChatId) {
    rows.push({
      keyname: clip("飞书群", MAX_HORIZONTAL_KEYNAME),
      value: clip(input.perTaskChatId, MAX_HORIZONTAL_VALUE),
    });
  }
  // ★ Task #5419：任务状态（预算允许时才渲染）
  if (input.task?.status && rows.length < MAX_HORIZONTAL_ROWS) {
    rows.push({
      keyname: clip("任务状态", MAX_HORIZONTAL_KEYNAME),
      value: clip(input.task.status, MAX_HORIZONTAL_VALUE),
    });
  }

  // ---- 操作记录（最新在顶部；用剩余预算） ----
  const sorted = [...(input.milestones ?? [])].reverse();
  const remaining = Math.max(0, MAX_HORIZONTAL_ROWS - rows.length);
  const timelineRows = sorted.slice(0, remaining).map((m) => ({
    keyname: clip(formatTs(m.timestamp).slice(11), MAX_HORIZONTAL_KEYNAME), // HH:mm
    value: shortMilestoneValue(m.title),
  }));
  const totalMs = sorted.length;
  const droppedMs = totalMs - timelineRows.length;

  // ---- 活性（quote_area 优先，超限降级 sub_title） ----
  let quoteArea:
    | { type?: number; title: string; quote_text: string }
    | undefined;
  let subTitle: string | undefined;
  if (input.activity !== undefined) {
    const q = formatActivityQuote(
      input.activity ?? undefined,
      input.now ?? Date.now(),
      terminal,
    );
    if (q.overflow) {
      subTitle = q.text.replace(/\n/g, " · ");
    } else {
      quoteArea = { type: 0, title: q.title, quote_text: q.text };
    }
  }

  // 操作记录被裁剪时在 sub_title 里说明（信息透明度优先于排版整洁）
  if (droppedMs > 0) {
    const hint = `共 ${totalMs} 条操作记录，显示最近 ${timelineRows.length} 条`;
    subTitle = subTitle ? `${hint} · ${subTitle}` : hint;
  }

  // ★ CV 5419 MAJOR-3：建群失败提示（用户点了必须有可见反馈）
  if (input.errorHint) {
    subTitle = subTitle
      ? `${input.errorHint} · ${subTitle}`
      : input.errorHint;
  }

  return {
    cmd: "aibot_respond_update_msg",
    headers: { req_id: reqId },
    body: {
      response_type: "update_template_card",
      template_card: {
        card_type: "button_interaction",
        main_title: { title: mainTitle },
        ...(subTitle ? { sub_title_text: subTitle } : {}),
        horizontal_content_list: [...rows, ...timelineRows],
        ...(quoteArea ? { quote_area: quoteArea } : {}),
        button_list: [
          {
            text: "刷新活性",
            style: 1,
            key: WecomCardActionKey.REFRESH_ACTIVITY,
          },
          // ★ Task #5419：建群按钮在更新帧里也要保留（整卡替换 schema）
          {
            text: "建飞书群",
            style: 1,
            key: WecomCardActionKey.CREATE_LARK_GROUP,
          },
        ],
        // 纯按钮交互（不做整卡跳转）⇒ type=0，避免 type=1 缺 url 报 42028
        card_action: { type: 0 },
        // ★ 协议硬约束：必须与回调带回的 task_id 完全一致
        task_id: String(input.cardTaskId),
      },
    },
  };
}

/**
 * 由开始时间算「已运行」文案（`1h23m` / `45m`）。
 *
 * 终态时同样的格式（不写「已结束」——状态行已经表达了），避免两处语义重复。
 * 无 startedAt / 解析失败 → undefined（不渲染该行）。
 */
function formatElapsedText(
  startedAt: string | undefined,
  now: number,
  _terminal: boolean,
): string | undefined {
  if (!startedAt) return undefined;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return undefined;
  const ms = Math.max(0, now - start);
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return "<1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}
