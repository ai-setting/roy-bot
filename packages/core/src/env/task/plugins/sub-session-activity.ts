/**
 * @fileoverview Task #5360 — sub-session 活性（liveness）公共纯函数层
 *
 * ## 用户需求（2026-11-11 20:50）
 *
 * > 「卡片新增「刷新」按钮（类似企微卡片的刷新按钮）：按下后展示该任务对应
 * >   subsession 的消息数 + 最近一条 msg（截断）—— 用来判断有无 LLM 推进」
 *
 * ## 为什么需要这一层
 *
 * 飞书卡片（`lark-card-action-handler`）和企微卡片（`wecom-card-action-handler`）
 * 都要展示同一份活性数据。如果两边各写一份：
 *
 * - liveness 阈值（5min / 20min）会漂移 → 同一个任务在两个渠道显示不同颜色
 * - 截断规则会漂移 → 一边切词一边不切
 * - `taskId → subSessionId` 反查会漂移 → 一边查得到一边查不到
 *
 * 所以**判定逻辑全部纯函数**放这里，两侧只负责渲染（飞书 markdown / 企微 quote）。
 *
 * ## 数据从哪来（不新造轮子）
 *
 * `BackgroundTaskManager.getSubSessionActivity(bgProcessId)`（delegate-tool.ts:2406）
 * 早就存在，此前只被 `query_background_process` 工具消费（Task #4720 Fix B）。
 * 它内部读 `session.messageCount` / `session.updatedAt`，任何失败返回 undefined
 * （不抛）—— 本模块沿用这一语义。
 *
 * 本模块**不**直接依赖 SessionComponent / BackgroundTaskManager 的类型：
 * 用最小结构端口（`SubSessionActivityPorts`），便于单测注入假实现，
 * 也避免 core 内部循环依赖。
 */


// ============================================================================
// 内部：单行扁平化
// ============================================================================

/**
 * 把多行文本压成单行（卡片 markdown 的一个 bullet 里不能有裸换行）。
 *
 * ## 为什么不用 `lark-card-patch-notifier` 的 `sanitizeInlineText`
 *
 * 本模块被 `lark-card-patch-notifier` **反向 import**（`buildTaskCard` 渲染
 * 活性面板要用 `formatActivityLines`）。若这里再 import 回去就成环：
 *
 * ```
 * lark-card-patch-notifier → sub-session-activity → lark-card-patch-notifier
 * ```
 *
 * ESM 的循环 import 在"模块顶层就求值"时会拿到 `undefined`，虽然本场景
 * 是函数体内调用（时机安全），但**依赖这个时机是脆的**：以后任何人把
 * `sanitizeInlineText` 改成 const 箭头函数或加模块级副作用就会炸。
 *
 * ⇒ 本模块保持**叶子**（零项目内依赖），自带一份够用的扁平化。
 *
 * 与 `sanitizeInlineText` 的差异（刻意简化）：不剥离 markdown 标题/图片/
 * 粗体标记。这里处理的是**别人写的一句话聊天消息**，不是我们自己拼的
 * 结构化内容 —— 保留原样更忠实，且不会有"消息里的 `#` 被吃掉"这类意外。
 */
function flattenInline(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n+/g, " · ")
    .replace(/\s{2,}/g, " ")
    .replace(/(?:\s*·\s*){2,}/g, " · ")
    .replace(/^(\s*·\s*)+/, "")
    .replace(/(\s*·\s*)+$/, "")
    .trim();
}

// ============================================================================
// 类型
// ============================================================================

/** sub-session 活性快照（飞书 / 企微 / CLI 统一形状） */
export interface SubSessionActivity {
  /** sub-session id（仅诊断用，不渲染给用户） */
  subSessionId: string;
  /** 消息总数（`session.messageCount`） */
  messageCount: number;
  /** 最后写入时间（ms epoch） */
  updatedAt: number;
  /** 最近一条有内容的消息（已截断） */
  lastMessage?: ActivityMessage;
}

/** 最近一条消息（已截断） */
export interface ActivityMessage {
  /** 角色（user / assistant / tool / system …） */
  role: string;
  /** 已截断的正文 */
  content: string;
  /** 消息时间戳（ms epoch，可选） */
  timestamp?: number;
}

/**
 * ★ Task #5420 返工：装配点传入消息的**最小**结构。
 *
 * 为什么不直接用 `SessionMessage`：装配点（event-source-handlers.ts）
 * 拿到的 session store 消息可能带 parts（新格式：content=""，正文在
 * parts），这里只需要 role/content/parts 三个字段，收窄依赖面。
 */
export interface SessionMessageLite {
  role?: string;
  content?: string;
  timestamp?: number;
  /** 新格式消息正文（content 为空时从这里提取） */
  parts?: Array<Record<string, unknown>>;
}

/**
 * 活性档位。
 *
 * ★ 阈值理由（不是拍脑袋）：`task.lastUpdatedAt` 的**心跳周期就是 20 分钟**
 *   （见 delegate-tool.ts 里 "subSessionUpdatedAt / 不再依赖缩短心跳" 的注释）。
 *   也就是说，一个**健康**的长时间任务最多 20 分钟没有新消息。所以：
 *   - `< 5min`  → 明显在跑（一轮 ReAct 通常几分钟）
 *   - `5~20min` → 还在心跳窗口内，但当前这一轮比较久 → 慢
 *   - `≥ 20min` → 连心跳窗口都超了 → 疑似停滞（该看 trace 了）
 */
export type ActivityLevel = "active" | "slow" | "stalled" | "terminal" | "unknown";

/** liveness 判定结果 */
export interface ActivityLiveness {
  level: ActivityLevel;
  /** 单字符信号灯：🟢 / 🟡 / 🔴 / ⚪ / ❔ */
  dot: string;
  /** 档位短语（"活跃" / "缓慢" / "疑似停滞" / "已结束" / "未知"） */
  label: string;
  /** 多久之前（"3 分钟前" / "刚刚"）；updatedAt 缺失时 undefined */
  agoText?: string;
}

/** 活跃档位阈值（毫秒） */
export const ACTIVITY_ACTIVE_MS = 5 * 60 * 1000;
export const ACTIVITY_SLOW_MS = 20 * 60 * 1000;

/** 最近消息正文的默认截断长度 */
export const DEFAULT_ACTIVITY_MESSAGE_MAX = 200;

// ============================================================================
// 纯函数：相对时间
// ============================================================================

/**
 * 把「多久之前」渲染成中文短语。
 *
 * - 负数 / NaN / 未来时间 → "刚刚"（时钟回拨不该渲染 "−3 分钟前"）
 * - < 60s → "刚刚"
 * - < 60min → "N 分钟前"
 * - < 24h → "N 小时前"
 * - 其它 → "N 天前"
 */
export function formatAgo(updatedAt: number | undefined, now: number): string | undefined {
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) return undefined;
  const diff = now - updatedAt;
  if (!Number.isFinite(diff) || diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** `20:47:12` 形态的钟点（本地时间，卡片窄，不要日期） */
export function formatClockTime(ts: number | undefined): string | undefined {
  if (ts === undefined || !Number.isFinite(ts)) return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ============================================================================
// 纯函数：liveness 判定
// ============================================================================

/**
 * 判定活性档位。
 *
 * @param activity 活性快照（undefined = 拿不到数据）
 * @param now      当前时间（注入便于测试）
 * @param terminal 该任务是否已终态（终态任务永远不是 "stalled"，是 "已结束"）
 */
export function resolveActivityLiveness(
  activity: SubSessionActivity | undefined,
  now: number,
  terminal = false,
): ActivityLiveness {
  if (!activity) {
    return { level: "unknown", dot: "❔", label: "未知" };
  }

  const agoText = formatAgo(activity.updatedAt, now);

  // 终态任务：哪怕 40 分钟没写入也是正常（任务本来就该停）
  if (terminal) {
    return { level: "terminal", dot: "⚪", label: "已结束", agoText };
  }

  const updatedAt = activity.updatedAt;
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) {
    // 有快照但没时间戳 → 只有消息数可信，档位判不了
    return { level: "unknown", dot: "❔", label: "未知", agoText };
  }

  const age = now - updatedAt;
  // 时钟回拨 / 未来时间：当作活跃（宁可乐观，也不要把正在跑的任务报成停滞）
  if (!Number.isFinite(age) || age < ACTIVITY_ACTIVE_MS) {
    return { level: "active", dot: "🟢", label: "活跃", agoText };
  }
  if (age < ACTIVITY_SLOW_MS) {
    return { level: "slow", dot: "🟡", label: "缓慢", agoText };
  }
  return { level: "stalled", dot: "🔴", label: "疑似停滞", agoText };
}

// ============================================================================
// 纯函数：截断
// ============================================================================

/**
 * 截断最近消息正文。
 *
 * 为什么不用 `String.slice`：卡片上出现「半个单词 + …」很难读
 * （企微侧已有同款踩坑记录，见 wecom-card-builder 的 `clipWord`）。
 *
 * 策略（与 `clipWord` 对齐但不复用 —— 那个是 wecom 私有且带 CJK 交界逻辑）：
 * 1. 先 `flattenInline` 压平换行 / 折叠空白（卡片是单行渲染）
 * 2. 有空格 → 回退到最后一个空格边界
 * 3. 否则硬截（CJK 无空格，硬截是正确的；不该给中文塞省略号断词）
 */
export function truncateActivityMessage(
  text: string | undefined,
  max: number = DEFAULT_ACTIVITY_MESSAGE_MAX,
): string {
  if (!text) return "";
  const flat = flattenInline(text);
  if (!flat) return "";
  if (flat.length <= max) return flat;

  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // 只在"空格位置靠后"时才回退，否则会为了不切词砍掉一半内容
  if (lastSpace > max * 0.6) return `${cut.slice(0, lastSpace).trimEnd()}…`;
  return `${cut}…`;
}

// ============================================================================
// 纯函数：渲染（两个渠道各自的形状）
// ============================================================================

/**
 * 渲染成飞书 markdown 行（`⚡ 子会话活性` 面板正文）。
 *
 * ## 输出形态
 *
 * 有数据：
 * ```
 * 🟢 活跃（3 分钟前有写入） · 消息数 128 条
 * 🕐 最近写入：20:47:12
 * 💬 最近消息：[assistant] 已定位到 wecom-card-builder.ts:485 …
 * ```
 *
 * 无数据（**绝不返回空数组** —— 否则用户分不清"没数据"和"按钮没生效"）：
 * ```
 * ❔ 暂无数据（子会话已归档或未落盘）
 * ```
 */
export function formatActivityLines(
  activity: SubSessionActivity | undefined,
  now: number,
  terminal = false,
): string[] {
  const live = resolveActivityLiveness(activity, now, terminal);

  if (!activity) {
    return ["❔ 暂无数据（子会话已归档或未落盘）"];
  }

  const headParts: string[] = [];
  const agoPhrase = live.agoText ? `（${live.agoText}有写入）` : "";
  headParts.push(`${live.dot} ${live.label}${agoPhrase}`);
  headParts.push(`消息数 ${activity.messageCount} 条`);

  const lines: string[] = [headParts.join(" · ")];

  const clock = formatClockTime(activity.updatedAt);
  if (clock) lines.push(`🕐 最近写入：${clock}`);

  const last = activity.lastMessage;
  if (last && last.content) {
    const role = last.role ? `[${last.role}] ` : "";
    lines.push(`💬 最近消息：${role}${last.content}`);
  } else {
    lines.push("💬 最近消息：（暂无文本消息）");
  }

  return lines;
}

/**
 * 渲染成企微 `quote_area`（`{title, text}`）。
 *
 * ## 为什么是 quote_area 而不是 horizontal_content_list
 *
 * 企微 `horizontal_content_list` 协议上限 **6 条**（`MAX_HORIZONTAL_ROWS`），
 * 进展/更新卡的 6 条已被「状态 + 5 条时间线」占满。把活性塞进去必然挤掉
 * 时间线 = 违反用户「之前展示的信息一个都不能少」。
 *
 * ## 为什么 text 是单行
 *
 * `quote_area.quote_text` 真网实证只渲染 ~2 行（见 wecom-card-builder 头注释里
 * Task #5203 的取证）。所以压成 1~2 行短文本，完整消息截断到 80 字。
 *
 * @returns `{title, text, overflow}` —— `overflow=true` 时调用方应把 text
 *          降级到 `sub_title_text`（见 buildWecomCardUpdateFrame）
 */
export function formatActivityQuote(
  activity: SubSessionActivity | undefined,
  now: number,
  terminal = false,
): { title: string; text: string; overflow: boolean } {
  const live = resolveActivityLiveness(activity, now, terminal);

  if (!activity) {
    return {
      title: "⚡ 子会话活性",
      text: "❔ 暂无数据（子会话已归档或未落盘）",
      overflow: false,
    };
  }

  const agoPhrase = live.agoText ? `（${live.agoText}有写入）` : "";
  const head = `${live.dot} ${live.label}${agoPhrase} · 消息数 ${activity.messageCount} 条`;

  const last = activity.lastMessage;
  const role = last?.role ? `[${last.role}] ` : "";
  const body = last?.content
    ? `${role}${truncateActivityMessage(last.content, 80)}`
    : "（暂无文本消息）";

  const text = `${head}\n💬 ${body}`;

  // 企微 quote_text 官方建议 ≤112 字；超了就让调用方降级到 sub_title_text
  const overflow = text.length > 112;

  return { title: "⚡ 子会话活性", text, overflow };
}

// ============================================================================
// 纯函数：taskId → subSessionId 反查
// ============================================================================

/** `listTasks()` 返回元素的**最小**结构（不依赖 BackgroundTask 全量类型） */
export interface BackgroundTaskLite {
  id: string;
  subSessionId: string;
  associatedTaskId?: number;
}

/**
 * 在后台任务表里按 roy 任务号反查 `{bgProcessId, subSessionId}`。
 *
 * ## 为什么要这个反查（而不是直接读 task.context）
 *
 * `task.background.*` 事件 payload 里 `backgroundTaskId` / `subSessionId` /
 * `associatedTaskId` 三个 id 齐全 —— 但那是**事件 payload**，不是持久层。
 * 卡片回调（`card.action.trigger`）只带回 `messageId` + `action.value.taskId`，
 * **没有** backgroundTaskId。而 `lark_card` / `wecom_cards` 表都只按 taskId 索引。
 *
 * 所以必须从 `BackgroundTaskManager.listTasks()` 反查。命中率：
 * - 活跃任务：100%（在 `tasks` Map 里）
 * - 已终结任务：也在（`listTasks()` 返回 `tasks ∪ terminalTasks`，
 *   delegate-tool.ts 注释已证）—— 所以「点已完成任务卡片的刷新」也能拿到
 * - 进程重启后：内存表空 → undefined → 卡片渲染「暂无数据」（不抛、不阻断 patch）
 *
 * 多命中时取**最后一个**（`listTasks()` 是 Map 插入序，同 taskId 的复用
 * sub-session 场景下，越晚的越新鲜）。
 */
export function findBackgroundTaskByAssociatedTaskId(
  tasks: readonly BackgroundTaskLite[] | undefined,
  taskId: number,
): BackgroundTaskLite | undefined {
  if (!tasks || tasks.length === 0) return undefined;
  if (!Number.isFinite(taskId)) return undefined;

  let found: BackgroundTaskLite | undefined;
  for (const t of tasks) {
    if (!t || typeof t.subSessionId !== "string" || !t.subSessionId) continue;
    if (t.associatedTaskId === taskId) found = t;
  }
  return found;
}

// ============================================================================
// ★ 补充需求（22:31）：session-only 路径（无 task 也能刷新）
// ============================================================================

/**
 * session-only 活性 probe 的端口。
 *
 * ## 与 `createActivityProbe` 的区别（为什么不能复用）
 *
 * `createActivityProbe(taskId)` 走的是
 * ```
 * taskId → findBackgroundTaskByAssociatedTaskId → bgTask.subSessionId → 活性
 * ```
 * 这条链**必须先有 task**（`associatedTaskId` 来自 task 表）。而本次需求是
 * 「有 sub-session 但**无** task」—— 那条链的第一环就不存在。
 *
 * 所以新增一条**直达**路径：调用方已经把 sessionId 拿在手里，直接读 store。
 *
 * ## 共用部分（刻意复用，避免阈值漂移）
 *
 * 拿到的 `{messageCount, updatedAt, lastMessage}` 之后，仍走同一套
 * `resolveActivityLiveness` / `formatActivityLines` / `formatActivityQuote`
 * —— 两个渠道、两种主键的卡片，颜色与文案口径必须完全一致。
 */
export interface SessionActivityPorts {
  /** 读 session 元信息（`sessionComponent.get()`）；缺失/抛错 ⇒ undefined */
  getSession?: (
    sessionId: string,
  ) =>
    | Promise<{ messageCount?: number; updatedAt?: number } | null | undefined>
    | { messageCount?: number; updatedAt?: number }
    | null
    | undefined;
  /**
   * ★ CV BLOCKER-3：读该 session 的**生命周期**（哪个后台任务在跑它、状态如何）。
   *
   * 这是「超时/完成/停止体现在卡片上」的唯一可信来源 —— 不能靠 task.status
   * （没 task 就没有），也不能硬写 false。装配点实现：
   * `sessionId → BackgroundTaskManager.listTasks() 里 subSessionId 命中 → status`
   * （running/pending → running；completed/timeout/failed/stopped 直接映射）。
   *
   * 不注入 / 抛错 / 找不到 → 视为 `running`（乐观：宁可显示在跑，
   * 也不要凭空宣布结束）。
   */
  getLifecycle?: (
    sessionId: string,
  ) =>
    | Promise<SessionLifecycle | undefined>
    | SessionLifecycle
    | undefined;
  /** 读最近一条消息（`getMessages(id, {offset:-1, limit:1})`） */
  getLastMessage?: (
    sessionId: string,
  ) => Promise<ActivityMessage | undefined> | ActivityMessage | undefined;
  // ★ CV BLOCKER-1（#5420）：这里**故意不声明** loadSessionMessages ——
  //   该端口属于 CardActionPorts（lark-card-action-handler），不属于
  //   probe 入参。此前误声明在此，导致装配时嵌进 probe 入参被静默
  //   丢弃（同名可选字段骗过了 excess-property 检查）。
}

/**
 * 造 `sessionId → ActivityProbeResult` 的异步 probe（无 task 场景）。
 *
 * ## 全链路 best-effort（与 task 路径同一纪律）
 *
 * - `getSession` 缺失 / 返回空 / 抛错 ⇒ `{activity: undefined}`（渲染「暂无数据」）
 * - `getLastMessage` 抛错 ⇒ activity 保留（只是没有最近消息）
 * - **永不抛**：刷新卡片绝不能因为取数失败而失败
 *
 * ## 为什么 `messageCount` 允许缺省
 *
 * `sessionComponent.get()` 在部分存储实现下可能不带 `messageCount`
 * （旧行 / memory 后端）。此时用 0 起步而不是报错 —— 卡片仍能显示
 * 「最近消息 + 最后写入时间」，那才是判断 LLM 有无推进的关键信号。
 */
export function createSessionActivityProbe(
  ports: SessionActivityPorts,
): (sessionId: string) => Promise<ActivityProbeResult> {
  return async (sessionId: string): Promise<ActivityProbeResult> => {
    if (!sessionId) return { activity: undefined, terminal: false };

    let session: { messageCount?: number; updatedAt?: number } | null | undefined;
    try {
      session = await ports.getSession?.(sessionId);
    } catch {
      session = undefined;
    }
    if (!session) return { activity: undefined, terminal: false };

    let lastMessage: ActivityMessage | undefined;
    try {
      lastMessage = await ports.getLastMessage?.(sessionId);
    } catch {
      lastMessage = undefined;
    }

    // ★ CV BLOCKER-3 修复：生命周期由**跑这个 session 的后台任务**决定，
    //   与「有没有 task」无关（用户澄清第 4 点）。
    //   旧实现硬写 `terminal: false` ⇒ 无 task 的 session 永远显示「运行中」，
    //   超时/完成无法表达，直接违背用户明令。
    let lifecycle: SessionLifecycle = "running";
    try {
      lifecycle = (await ports.getLifecycle?.(sessionId)) ?? "running";
    } catch {
      lifecycle = "running";
    }

    return {
      lifecycle,
      terminal: lifecycle !== "running",
      activity: {
        subSessionId: sessionId,
        messageCount:
          typeof session.messageCount === "number" ? session.messageCount : 0,
        updatedAt:
          typeof session.updatedAt === "number" ? session.updatedAt : Number.NaN,
        ...(lastMessage ? { lastMessage } : {}),
      },
    };
  };
}

// ============================================================================
// 组合：probe 工厂（飞书 / 企微装配点共用同一个实现）
// ============================================================================

/**
 * probe 依赖的最小端口集。
 *
 * 全部 optional：任一缺失只降级（返回 undefined），绝不抛 —— 与
 * `getSubSessionActivity` 既有语义一致。
 */
export interface SubSessionActivityPorts {
  /** 列后台任务（`BackgroundTaskManager.listTasks()`） */
  listBackgroundTasks?: () => readonly BackgroundTaskLite[] | undefined;
  /** 读 sub-session 消息数 + 最后写入时间（`getSubSessionActivity`） */
  getSubSessionActivity?: (
    bgProcessId: string,
  ) => Promise<{ messageCount: number; updatedAt: number } | undefined> | { messageCount: number; updatedAt: number } | undefined;
  /** 读最近一条消息（`sessionComponent.getMessages(id, {offset:-1, limit:1})`） */
  getLastMessage?: (
    subSessionId: string,
  ) => Promise<ActivityMessage | undefined> | ActivityMessage | undefined;
  /** 该任务是否终态（决定 liveness 是否报 "已结束" 而不是 "疑似停滞"） */
  isTerminalTask?: (taskId: number) => Promise<boolean> | boolean;
}

/** session 层生命周期（★ CV BLOCKER-3：比 boolean 更有表达力） */
export type SessionLifecycle =
  | "running"
  | "completed"
  | "timeout"
  | "failed"
  | "stopped";

/** probe 返回的完整活性快照（含生命周期，供渲染层用） */
export interface ActivityProbeResult {
  activity?: SubSessionActivity;
  /** 是否终态（便于老调用方继续用布尔判断） */
  terminal: boolean;
  /**
   * ★ CV BLOCKER-3：具体生命周期。
   *
   * 为什么不能只有 `terminal: boolean`：用户明令「超时、完成等生命周期事件
   * 也要体现在卡片上」—— 单一布尔把 timeout / failed / stopped 全压成
   * 「已完成」，用户看不出到底是哪种结束。有 task 时可由 task.status 映射，
   * **无 task 时必须由本字段承载**。
   *
   * 缺省（不传）⇒ 由 `terminal` 推导（true→completed / false→running）。
   */
  lifecycle?: SessionLifecycle;
}

/**
 * 造一个 `taskId → ActivityProbeResult` 的异步 probe。
 *
 * ## 全链路 best-effort
 *
 * 每一步都 try/catch 后降级：
 * - `listBackgroundTasks` 缺失/抛错 → 返回 `{activity: undefined}`（渲染「暂无数据」）
 * - 反查不到 bg 任务 → 同上
 * - `getSubSessionActivity` 抛错/undefined → 仍返回 activity（messageCount=0，
 *   updatedAt 用 `Date.now()` 兜底会让 liveness 假报"活跃"，所以此时**返回 undefined**）
 * - `getLastMessage` 抛错 → activity 保留，只是没有 `lastMessage`
 *
 * ⇒ 卡片 patch 永远不会因为活性取数失败而失败。
 */
export function createActivityProbe(
  ports: SubSessionActivityPorts,
): (taskId: number) => Promise<ActivityProbeResult> {
  return async (taskId: number): Promise<ActivityProbeResult> => {
    let terminal = false;
    try {
      terminal = (await ports.isTerminalTask?.(taskId)) ?? false;
    } catch {
      terminal = false;
    }

    let task: BackgroundTaskLite | undefined;
    try {
      task = findBackgroundTaskByAssociatedTaskId(
        ports.listBackgroundTasks?.(),
        taskId,
      );
    } catch {
      task = undefined;
    }

    if (!task) return { activity: undefined, terminal };

    let stats: { messageCount: number; updatedAt: number } | undefined;
    try {
      stats = await ports.getSubSessionActivity?.(task.id);
    } catch {
      stats = undefined;
    }
    if (!stats) return { activity: undefined, terminal };

    let lastMessage: ActivityMessage | undefined;
    try {
      lastMessage = await ports.getLastMessage?.(task.subSessionId);
    } catch {
      lastMessage = undefined;
    }

    return {
      terminal,
      activity: {
        subSessionId: task.subSessionId,
        messageCount: stats.messageCount ?? 0,
        updatedAt: stats.updatedAt,
        ...(lastMessage ? { lastMessage } : {}),
      },
    };
  };
}

/**
 * 把一条 `SessionMessage` 归一化成 `ActivityMessage`（截断 + 角色提取）。
 *
 * 供两侧装配点在 `getLastMessage` 端口实现里复用，避免两份截断逻辑。
 *
 * ★ CV MINOR-2（#5420）：空 content **不再返回 undefined** ——
 *   tool 角色消息常把 payload 放 parts、content 为空，此前被
 *   装配点 filter 掉 ⇒ 「最新 5 条」排不满、与事实不符。
 *   现在保留消息、content 用占位「（无文本内容）」，
 *   条数与库内事实一致。原语义（活性面板的 lastMessage）
 *   不受影响：那里拿到空占位同样可读。
 */
export function toActivityMessage(
  msg:
    | {
        role?: string;
        content?: string;
        timestamp?: number;
        parts?: Array<Record<string, unknown>>;
      }
    | undefined,
  max: number = DEFAULT_ACTIVITY_MESSAGE_MAX,
): ActivityMessage | undefined {
  if (!msg) return undefined;
  // ★ Task #5420 返工：content 空（新格式正文在 parts）时，
  //   从 parts 提取正文 —— TextPart.content 拼接；tool 角色的
  //   ToolResultPart.output 也算正文（活性面板 lastMessage 同样受益）。
  let text = msg.content;
  if (!text || text.length === 0) {
    const textParts: string[] = [];
    for (const part of msg.parts ?? []) {
      if (part?.type === "text" && typeof part.content === "string") {
        textParts.push(part.content);
      } else if (
        part?.type === "tool-result" &&
        typeof part.output === "string"
      ) {
        textParts.push(part.output);
      }
    }
    if (textParts.length > 0) text = textParts.join(" ");
  }
  // ★ CV MINOR-2（#5420）：空 content → 占位（不再丢弃整条消息）。
  //   但**仅在 max 参数显式传入时**（即「会话查看」逐条列表场景）；
  //   默认调用（活性面板 lastMessage）保持原语义：空 → undefined。
  const content = truncateActivityMessage(text, max);
  if (!content) {
    if (max === DEFAULT_ACTIVITY_MESSAGE_MAX) return undefined;
    return {
      role: typeof msg.role === "string" ? msg.role : "unknown",
      content: "（无文本内容）",
      ...(typeof msg.timestamp === "number" ? { timestamp: msg.timestamp } : {}),
    };
  }
  return {
    role: typeof msg.role === "string" ? msg.role : "unknown",
    content,
    ...(typeof msg.timestamp === "number" ? { timestamp: msg.timestamp } : {}),
  };
}
// ============================================================================
// ★ Task #5364 返工：后台任务状态 → session 生命周期（两个装配点共用）
// ============================================================================

/**
 * 把 `BackgroundTaskManager.listTasks()` 里那条任务的 status 映射成 session 生命周期。
 *
 * 为什么单独抽出来并导出：飞书（`event-source-handlers.ts`）与企微
 * （`wecom-cli-handler.ts`）两个装配点都要做同一件事，各写一份必然漂移 ——
 * 同一个 session 在飞书显示「已完成」、企微显示「运行中」是最糟的体验。
 *
 * 未知/缺失 → `running`（乐观：宁可显示还在跑，也不要凭空宣布结束）。
 */
export function mapBgTaskStatusToSessionLifecycle(
  status: string | undefined,
): SessionLifecycle {
  switch (status) {
    case "completed":
      return "completed";
    case "timeout":
    case "timed_out":
      return "timeout";
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "cancelled":
    case "canceled":
    case "aborted":
      return "stopped";
    default:
      // running / pending / undefined / 任何未知值
      return "running";
  }
}

// ============================================================================
// ★ Task #5420：「💬 会话查看」—— 最近 5 条消息渲染（名称=role + reason）
// ============================================================================

/** 最近消息默认条数（用户拍板：A 五条） */
export const RECENT_MESSAGE_LIMIT = 5;

/** 每条消息内容（reason）的截断长度（卡片窄，5 条 × 100 字不撑爆） */
export const RECENT_MESSAGE_MAX = 100;

/**
 * role → 展示名称。
 *
 * session store 里**没有真实发送者名**，只有 role —— 用户拍板
 * 「名称（发送者，session 消息取 role user/assistant）」，
 * 所以名称 = role 的友好映射。未知 role 原样标注（不猜）。
 */
export function recentMessageRoleLabel(role: string | undefined): string {
  switch (role) {
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    case "tool":
      return "工具";
    case "system":
      return "系统";
    default:
      return role && role.length > 0 ? role : "未知";
  }
}

/**
 * 把最近消息列表渲染成卡片 markdown 行。
 *
 * ## 形态（★ Task #5420 返工：标题去重 + 工具名/reason）
 *
 * ```
 * - 👤 用户：先完成工具改造吧…
 * - 🤖 助手：task_create：建返工任务…
 * ```
 *
 * 标题只出现在面板 title（「💬 最近消息」）一处；
 * 列表首行**不再**重复「最近消息（最新 N 条）：」
 * （用户实测截图：标题重复两次）。
 *
 * ## 三态语义
 *
 * - 5 条 → 5 行
 * - 不足 5 条 → 实际条数（诚实显示）
 * - 0 条 / undefined → 单行「暂无消息」（不渲染空面板假象）
 *
 * 每条内容复用 `truncateActivityMessage`（flattenInline 单行化 +
 * 词边界截断），与活性面板同口径，不漂移。
 */
export function formatRecentMessageLines(
  messages: ActivityMessage[] | undefined,
  max: number = RECENT_MESSAGE_MAX,
): string[] {
  if (!messages || messages.length === 0) {
    return ["暂无消息"];
  }
  return messages.map((m) => {
    const label = recentMessageRoleLabel(m?.role);
    const body = truncateActivityMessage(m?.content, max) || "（无文本内容）";
    return `- ${label}：${body}`;
  });
}

// ============================================================================
// ★ Task #5420 返工（2026-11-13 08:21 用户澄清）：
//    「💬 会话查看」→ 最近 5 条**工具调用**（工具名 + reason）
// ============================================================================

/** 一条工具调用的展示形态 */
export interface ToolCallView {
  /** 工具名（ToolCallPart.toolName） */
  toolName: string;
  /** 调用意图（ToolCallPart.arguments.reason，#5422 注入）；旧调用可能没有 */
  reason?: string;
}

/**
 * 从 session 消息列表提取**工具调用**（tool-call part）。
 *
 * ## 真实结构（生产 sessions.db 勘察，#5420 返工）
 *
 * assistant 消息 `parts` 含 ToolCallPart：
 * `{type:'tool-call', toolName, arguments, toolCallId, state}`。
 * reason 是 #5422 注入的必填参数（`arguments.reason`）；
 * `arguments` 可能是对象或 JSON 字符串（两种都兼容）。
 *
 * ## 降级
 *
 * - 非工具消息（text/user/tool-result）→ 跳过
 * - 无 reason 的旧调用 / arguments 解析失败 → `reason: undefined`
 *   （保留该调用，渲染层显示「—」；不抛）
 */
export function extractToolCallsFromMessages(
  messages:
    | Array<{
        role?: string;
        content?: string;
        timestamp?: number;
        parts?: Array<Record<string, unknown>>;
      }>
    | undefined,
): ToolCallView[] {
  const calls: ToolCallView[] = [];
  for (const msg of messages ?? []) {
    for (const part of msg?.parts ?? []) {
      if (part?.type !== "tool-call") continue;
      const toolName =
        typeof part.toolName === "string" ? part.toolName : undefined;
      if (!toolName) continue;
      let args: Record<string, unknown> | undefined;
      if (typeof part.arguments === "string") {
        try {
          const parsed: unknown = JSON.parse(part.arguments);
          if (parsed && typeof parsed === "object") {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          // JSON 字符串解析失败 → 无 reason（降级）
        }
      } else if (part.arguments && typeof part.arguments === "object") {
        args = part.arguments as Record<string, unknown>;
      }
      const reason =
        typeof args?.reason === "string" && args.reason.trim().length > 0
          ? args.reason.trim()
          : undefined;
      calls.push({ toolName, ...(reason ? { reason } : {}) });
    }
  }
  return calls;
}

/**
 * 把工具调用列表渲染成卡片 markdown 行（★ #5420 返工）。
 *
 * ## 形态（用户澄清 08:21：展示工具名称和 reason）
 *
 * ```
 * 🔧 最近工具调用（最新 5 条）：
 * - bash：查看目录结构
 * - read_file：读源码定位根因
 * ```
 *
 * ## 三态语义（与旧 formatRecentMessageLines 同纪律）
 *
 * - 有调用 → 标题（**只出现一次**，修旧版标题双写）+ 每行「工具名：reason」
 * - 无 reason 的旧调用 → 「—」
 * - 0 条 / undefined → 单行「暂无工具调用」（不渲染空面板假象）
 */
export function formatRecentToolCallLines(
  calls: ToolCallView[] | undefined,
  max: number = RECENT_MESSAGE_MAX,
): string[] {
  // ★ 标题去重（#5420 返工）：标题「🔧 最近工具调用」只在面板
  //   title 一处；列表首行不再重复（用户实测截图双写）。
  if (!calls || calls.length === 0) {
    return ["暂无工具调用"];
  }
  return calls.map((c) => {
    const reason = truncateActivityMessage(c?.reason, max) || "—";
    return `- ${c?.toolName ?? "未知"}：${reason}`;
  });
}
