/**
 * Timer EventSource Handler
 *
 * 周期性触发事件（默认 10 分钟），通过 rule-based 逻辑检查
 * BackgroundTaskManager：如果没有运行中的任务，则构造 selfReminder
 * 事件触发 agent 处理。
 *
 * 设计要点：
 * 1. 实现 EventSourceHandler / EventSourceInstance 接口
 * 2. 使用 setInterval 定时触发
 * 3. Rule-based 检查：过滤 status === "running" 的 BackgroundTask
 * 4. 同一实例维护固定 sessionId（格式：timer-{sourceId}-{processId}）
 * 5. 事件结构参考 LarkCliInstance
 */

import type {
  EventSourceConfig,
  EventSourceHandler,
  EventSourceInstance,
  EventSourceStatus,
  EventSourceEvent,
  EventSourceEventHandler,
} from "./types";
import type { BackgroundTask } from "../task/delegate/delegate-tool";
import { TracedAs } from "../log-trace/decorator";
import { createLogger } from "../log-trace/logger";

// =============================================================================
// 常量
// =============================================================================

/** 默认触发间隔：10 分钟 */
export const DEFAULT_TIMER_INTERVAL_MS = 10 * 60 * 1000;

/**
 * ★ Task #5409：每累计这么多次「被跳过的 tick」，打一条 debug 日志
 *
 * 为什么需要：跳过路径不再留 trace 后，靠 `debug trace --list` 就看不见
 * timer 在空转了。用固定间隔的汇总日志（默认每 20 次 ≈ 30s tick 下 10 分钟
 * 一条，schedule 模式更稀疏）保留"timer 活着且被 who 挡住"的可观测性，
 * 又不会像每条 tick 一条 trace 那样撑大 traces.db。
 */
const SKIPPED_TICK_LOG_EVERY = 20;

const timerLogger = createLogger("timer:event-source");

/** SelfReminder 消息内容 */
const SELF_REMINDER_MESSAGE = `[Timer Self-Reminder]
请读取最近 1 周处理的 task 信息，分析用户当前的工作目标和重点任务。
基于分析结果，自主构建有价值的任务来推进用户目标。

分析维度：
1. 最近完成的 task 类型和主题
2. 进行中的 task 状态和阻塞点
3. 用户的工作模式和偏好
4. 可以主动优化的领域

请根据分析结果，创建 1-3 个有价值的任务并执行。`;

// =============================================================================
// 类型定义
// =============================================================================

/**
 * 获取运行中任务的回调函数
 *
 * 返回的数组中，任何 status === "running" 的任务都会阻止本次触发。
 * 设计为回调而不是直接传入 BackgroundTaskManager，是为了：
 * 1. 保持 createInstance(config) 签名不变（不破坏 EventSourceHandler 接口）
 * 2. 便于测试时注入 mock
 */
export type GetRunningTasksFn = () => BackgroundTask[];

/**
 * ★ Task #5409：tick 的两种触发模式（写进 `timer.tick.fire` span 的 mode 属性）
 */
export type TimerFireMode = "interval" | "schedule";

/**
 * ★ Task #5409：tick 统计（跳过 / 触发计数）
 *
 * 为什么需要：修复后**空转 tick 不再留 trace**（原来每 30 秒一条 `timer.tick`，
 * 每天约 2880 条无价值 span，全部 0ms）。代价是「被跳过的 tick」在 trace 里
 * 不可见，无法再靠 `debug trace --list` 判断 timer 是否活着。
 *
 * 因此把可观测性改到**进程内计数器**：`getTickStats()` 可随时读取，
 * 另外每次真正 fire 的 span 上会带 `skippedSinceLastFire` —— 一眼看出
 * 「这个 timer 一直在跑，只是长期被 running 任务挡住」。
 */
export interface TimerTickStats {
  /** 累计真正 fire（构建并投递 SelfReminder 事件）的次数 */
  firedTicks: number;
  /** 累计被跳过的 tick 次数（有 running 任务 / 抛错 / 时刻不命中 / 当日去重） */
  skippedTicks: number;
  /** 距离上次 fire 之间被跳过的 tick 次数（fire 后归零） */
  skippedSinceLastFire: number;
}

/**
 * 用于注入 BackgroundTaskManager 的 options key
 */
export const TIMER_OPTIONS_KEY_GET_MANAGER = "getBackgroundTaskManager";

/** schedule 模式下的低频 tick 间隔（30 秒） */
export const SCHEDULE_TICK_INTERVAL_MS = 30 * 1000;

/** options key：多时刻配置 */
export const TIMER_OPTIONS_KEY_SCHEDULE = "schedule";
/** options key：显式指定事件路由到的 session（独立 session） */
export const TIMER_OPTIONS_KEY_SESSION_ID = "sessionId";
/** options key：schedule 模式下是否在有运行中后台任务时跳过 */
export const TIMER_OPTIONS_KEY_SKIP_WHEN_RUNNING = "skipWhenRunning";

// =============================================================================
// Schedule 类型 & 工具
// =============================================================================

/**
 * 单条 schedule 项
 *
 * - time: `HH:MM`（24 小时制，本地时区）
 * - prompt: 该时刻触发时注入的 prompt
 * - label: 可选标签（写入 event metadata.scheduleLabel，便于下游识别）
 * - sessionId: 可选，覆盖实例级 session（该时刻走独立 session）
 */
export interface TimerScheduleEntry {
  time: string;
  prompt: string;
  label?: string;
  sessionId?: string;
}

/** `HH:MM` 格式正则 */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * ★ Task #5409：`fireTick()` 的入参（object 形式，便于 paramFilter 取出全部字段）
 */
export interface TimerFireContext {
  /** 触发模式 */
  mode: TimerFireMode;
  /** timer 事件源 id（`this.config.id`）—— paramFilter 拿不到 this，故显式传入 */
  sourceId: string;
  /** 距上次 fire 被跳过的 tick 次数 */
  skippedSinceLastFire: number;
  /** schedule 模式的命中项 */
  entry?: TimerScheduleEntry;
}

/**
 * ★ Task #5409：构造 `timer.tick.fire` span 的属性（供 paramFilter 摊平到顶层）
 *
 * 出参键名就是 `debug trace` / `debug span` 里能直接看到的字段：
 * - `mode`：interval / schedule
 * - `sourceId`：timer 事件源 id（哪个 timer 触发的）
 * - `skippedSinceLastFire`：距上次 fire 被跳过的 tick 次数
 * - `scheduleTime` / `scheduleLabel`：schedule 模式的命中项
 */
export function buildFireSpanAttributes(ctx: TimerFireContext): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    mode: ctx.mode,
    sourceId: ctx.sourceId,
    skippedSinceLastFire: ctx.skippedSinceLastFire,
  };
  if (ctx.entry !== undefined) {
    attrs.scheduleTime = ctx.entry.time;
    if (ctx.entry.label !== undefined) attrs.scheduleLabel = ctx.entry.label;
  }
  return attrs;
}

/**
 * 校验 `HH:MM` 格式
 *
 * @returns 合法返回 true；非法返回 false
 */
export function isValidScheduleTime(time: unknown): time is string {
  return typeof time === "string" && TIME_PATTERN.test(time);
}

/**
 * 解析 options.schedule 为合法的 schedule 项数组
 *
 * 非法项被静默丢弃（validateConfig 负责报错），返回的数组只含合法项。
 *
 * @param raw 原始值（通常是 config.options.schedule）
 * @returns 合法 schedule 项数组；不是数组时返回空数组
 */
export function parseSchedule(raw: unknown): TimerScheduleEntry[] {
  if (!Array.isArray(raw)) return [];
  const result: TimerScheduleEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (!isValidScheduleTime(obj.time)) continue;
    if (typeof obj.prompt !== "string" || obj.prompt.trim().length === 0) continue;
    const entry: TimerScheduleEntry = {
      time: obj.time,
      prompt: obj.prompt,
    };
    if (typeof obj.label === "string" && obj.label.length > 0) {
      entry.label = obj.label;
    }
    if (typeof obj.sessionId === "string" && obj.sessionId.length > 0) {
      entry.sessionId = obj.sessionId;
    }
    result.push(entry);
  }
  return result;
}

/**
 * 校验 schedule 配置，返回错误列表（空数组 = 合法）
 *
 * 规则：
 * 1. schedule 必须是数组且非空
 * 2. 每项 time 必须是 `HH:MM`
 * 3. 每项 prompt 必须是非空字符串
 * 4. schedule 与 interval 互斥
 */
export function validateScheduleConfig(config: EventSourceConfig): string[] {
  const errors: string[] = [];
  const options = (config.options as Record<string, unknown> | undefined) ?? {};
  const raw = options[TIMER_OPTIONS_KEY_SCHEDULE];

  // 未配置 schedule → 走 interval 老路径，不做 schedule 校验
  if (raw === undefined || raw === null) return errors;

  if (!Array.isArray(raw)) {
    errors.push("Timer schedule must be an array of { time, prompt } entries");
    return errors;
  }
  if (raw.length === 0) {
    errors.push("Timer schedule must not be empty");
    return errors;
  }

  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      errors.push(`Timer schedule[${index}] must be an object`);
      return;
    }
    const obj = item as Record<string, unknown>;
    if (!isValidScheduleTime(obj.time)) {
      errors.push(
        `Timer schedule[${index}].time must be in HH:MM format (24-hour), got: ${String(obj.time)}`,
      );
    }
    if (typeof obj.prompt !== "string" || obj.prompt.trim().length === 0) {
      errors.push(`Timer schedule[${index}].prompt is required and must be a non-empty string`);
    }
  });

  // ★ Task #4815（DS review3）：重复的 time 必须拒绝。
  //   同一时刻配两项时 tickSchedule 只会触发第一项（后一项被静默忽略），
  //   用户以为两个时刻都会触发 → 实际少一次提醒。
  const seenTimes = new Set<string>();
  const duplicatedTimes = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const time = (item as Record<string, unknown>).time;
    if (!isValidScheduleTime(time)) continue;
    if (seenTimes.has(time)) {
      duplicatedTimes.add(time);
    }
    seenTimes.add(time);
  }
  if (duplicatedTimes.size > 0) {
    errors.push(
      `Timer schedule contains duplicate time entries: ${Array.from(duplicatedTimes).join(", ")}`,
    );
  }

  // schedule 与 interval 互斥
  if (config.interval !== undefined && config.interval !== null) {
    errors.push(
      "Timer schedule and interval are mutually exclusive: use schedule for fixed daily times, or interval for periodic triggering",
    );
  }

  return errors;
}

// =============================================================================
// TimerInstance
// =============================================================================

/**
 * Timer EventSourceInstance 实现
 *
 * 使用 setInterval 周期性触发事件，每次触发前通过 getRunningTasks
 * 检查是否有运行中的任务。
 */
export class TimerInstance implements EventSourceInstance {
  private readonly config: EventSourceConfig;
  private readonly interval: number;
  private readonly sessionId: string;
  private readonly getRunningTasks: GetRunningTasksFn;
  private readonly customPrompt?: string;

  /** schedule 模式：合法 schedule 项 */
  private readonly schedule: TimerScheduleEntry[];
  /** 是否处于 schedule 模式（配置了 schedule 键即为 true，即使全项非法） */
  private readonly scheduleMode: boolean;
  /** 非法 schedule 的告警是否已打印（只打一次，避免刷屏） */
  private invalidScheduleWarned = false;
  /** schedule 模式下实例级默认 session（跨重启稳定） */
  private readonly scheduleSessionId: string;
  /** schedule 模式下是否在有运行中后台任务时跳过 */
  private readonly skipWhenRunning: boolean;
  /** 已触发标记：`YYYY-MM-DD#HH:MM` → true（当日去重） */
  private readonly firedKeys = new Set<string>();
  /** ★ Task #5409：tick 统计（跳过/触发计数），替代原「每次都留 trace」的可观测性 */
  private firedTicks = 0;
  private skippedTicks = 0;
  private skippedSinceLastFire = 0;
  /** 可注入时钟（测试用） */
  private readonly now: () => number;

  private status: EventSourceStatus = "created";
  private timerId?: ReturnType<typeof setInterval>;
  private eventHandler?: EventSourceEventHandler;

  /**
   * @param config 事件源配置
   * @param getRunningTasks 可选的回调，用于获取当前所有后台任务。
   *                        测试时可直接传入；生产环境通过 config.options.getBackgroundTaskManager 注入。
   * @param now 可选的时钟注入（返回 epoch ms），测试用。
   */
  constructor(
    config: EventSourceConfig,
    getRunningTasks?: GetRunningTasksFn,
    now?: () => number,
  ) {
    this.config = config;
    this.now = now ?? (() => Date.now());

    const options = (config.options as Record<string, unknown> | undefined) ?? {};

    // ★ Task #4815：schedule 模式（多时刻固定时间）
    //   解析 options.schedule。
    //
    //   ★ review MINOR-1：**「未配置 schedule」与「配置了但全项非法」必须区分**。
    //     前者走老的 interval 路径（向后兼容）；
    //     后者保持 schedule 模式但不触发 —— 绝不能退化成 interval 模式
    //     去跑默认 SelfReminder（那是完全不相干的行为）。
    const rawSchedule = options[TIMER_OPTIONS_KEY_SCHEDULE];
    const scheduleConfigured = rawSchedule !== undefined && rawSchedule !== null;
    this.schedule = parseSchedule(rawSchedule);
    this.scheduleMode = scheduleConfigured;
    const isScheduleMode = this.scheduleMode;

    // ★ schedule 模式固定用低频 tick（30s）——即使 config.interval 有值也不采纳，
    //   因为 schedule 与 interval 互斥（validateConfig 会报错），这里做防御。
    this.interval = isScheduleMode
      ? SCHEDULE_TICK_INTERVAL_MS
      : typeof config.interval === "number" && config.interval > 0
        ? config.interval
        : DEFAULT_TIMER_INTERVAL_MS;

    // 同一实例内 sessionId 保持一致
    this.sessionId = `timer-${config.id}-${process.pid}`;

    // ★ schedule 模式的 trigger session：默认跨重启稳定（不含 pid），
    //   这样 EventHandler 的 trigger 维度缓存能跨进程复用同一 session。
    //   用户可通过 options.sessionId 显式指定已有 session。
    const explicitSessionId = options[TIMER_OPTIONS_KEY_SESSION_ID];
    this.scheduleSessionId =
      typeof explicitSessionId === "string" && explicitSessionId.length > 0
        ? explicitSessionId
        : `timer-${config.id}`;

    // schedule 模式默认**不**被后台运行任务挡掉（每日总结不应被跳过）；
    // 可通过 options.skipWhenRunning=true 显式开启。
    this.skipWhenRunning = options[TIMER_OPTIONS_KEY_SKIP_WHEN_RUNNING] === true;

    // 读取自定义 prompt（从 config.options.prompt）
    const optionsPrompt = options.prompt;
    if (typeof optionsPrompt === "string" && optionsPrompt.trim().length > 0) {
      this.customPrompt = optionsPrompt;
    }

    // 优先使用直接传入的回调，其次从 config.options 中提取
    if (getRunningTasks) {
      this.getRunningTasks = getRunningTasks;
    } else {
      const factory = options[
        TIMER_OPTIONS_KEY_GET_MANAGER
      ] as (() => { listTasks: () => BackgroundTask[] }) | undefined;

      if (typeof factory === "function") {
        const manager = factory();
        this.getRunningTasks = () => manager.listTasks();
      } else {
        // 没有提供 manager 时，默认无运行中任务（允许触发）
        this.getRunningTasks = () => [];
      }
    }
  }

  /** 当前是否为 schedule 模式 */
  private get isScheduleMode(): boolean {
    return this.scheduleMode;
  }

  async start(): Promise<void> {
    if (this.status === "running") return;

    this.timerId = setInterval(() => {
      this.tick();
    }, this.interval);

    this.status = "running";
  }

  async stop(): Promise<void> {
    if (this.timerId !== undefined) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }
    this.status = "stopped";
  }

  getStatus(): EventSourceStatus {
    return this.status;
  }

  /**
   * ★ Task #5409：读取 tick 统计（跳过 / 触发计数）
   *
   * 修复后空转 tick 不再落 trace，用这个计数器保留「timer 还活着」的可观测性：
   * - `firedTicks` 一直为 0 且 `skippedTicks` 持续增长 → 一直被 running 任务挡住
   * - 两者都不再增长 → tick 本身可能没在跑（`getStatus()` 应为 running）
   */
  getTickStats(): TimerTickStats {
    return {
      firedTicks: this.firedTicks,
      skippedTicks: this.skippedTicks,
      skippedSinceLastFire: this.skippedSinceLastFire,
    };
  }

  onEvent(handler: EventSourceEventHandler): void {
    this.eventHandler = handler;
  }

  offEvent(): void {
    this.eventHandler = undefined;
  }

  // ---------------------------------------------------------------------------
  // 内部逻辑
  // ---------------------------------------------------------------------------

  /**
   * 定时器 tick 回调
   *
   * Rule-based 检查：有 status === "running" 的后台任务时跳过本次触发
   *
   * ★ Task #5409：**入口不再挂 `@TracedAs`**。
   *
   * 原来 `@TracedAs("timer.tick")` 在入口就建 span，于是「有 running 任务 →
   * return」这种什么都没做的空转 tick 也会落一条 trace。生产实测每 30 秒一条、
   * 全部 0ms/ok，每天约 2880 条，是 traces.db 膨胀的增量来源之一。
   *
   * 现在只有**真正 fire 了 SelfReminder 事件**才记一条 `timer.tick.fire`
   * （见 `fireTick()`），跳过路径零 trace；跳过次数改由 `getTickStats()` 暴露。
   */
  private tick(): void {
    // ★ Task #4815：schedule 模式走独立分支（固定时刻命中 + 当日去重）
    if (this.isScheduleMode) {
      this.tickSchedule();
      return;
    }

    // Rule-based 检查
    let allTasks: BackgroundTask[];
    try {
      allTasks = this.getRunningTasks();
    } catch (error) {
      // 获取任务失败时安全跳过，不崩溃
      console.warn(`[TimerInstance] Failed to get running tasks, skipping tick: ${error}`);
      this.recordSkip();
      return;
    }

    const hasRunning = Array.isArray(allTasks) && allTasks.some((t) => t.status === "running");
    if (hasRunning) {
      // 有运行中任务，跳过本次触发
      this.recordSkip();
      return;
    }

    // 构建 SelfReminder 事件并投递（只有这里留 trace）
    this.fireTick({
      mode: "interval",
      sourceId: this.config.id,
      skippedSinceLastFire: this.skippedSinceLastFire,
    });
  }

  /**
   * ★ Task #5409：记录一次「被跳过」的 tick（零 trace）
   *
   * 可观测性走两条路：
   * 1. 进程内计数器（`getTickStats()`）—— 供 `/status` 类排查直接读
   * 2. 每累计 `SKIPPED_TICK_LOG_EVERY` 次打一条 debug 汇总日志 —— 供 app.log
   *    确认 timer 仍在跑（`log_trace.logging.level=debug` 时可见）
   */
  private recordSkip(): void {
    this.skippedTicks++;
    this.skippedSinceLastFire++;
    if (this.skippedTicks % SKIPPED_TICK_LOG_EVERY === 0) {
      timerLogger.debug(
        `[TimerInstance] ${this.config.id}: ${this.skippedTicks} ticks skipped ` +
          `(${this.skippedSinceLastFire} since last fire, mode=${this.isScheduleMode ? "schedule" : "interval"})`,
      );
    }
  }

  /**
   * ★ Task #5409：真正 fire 一次的**唯一入口** —— 事件构建 + 投递 + 1 条 trace
   *
   * 命名 `timer.tick.fire`（而不是保留 `timer.tick`）：trace 列表里一眼能看出
   * 「这条 span 代表 timer 真的触发了」，不再是「tick 发生了但可能什么都没做」。
   *
   * span 属性（经 paramFilter 摊平到顶层）：
   * - `mode`：interval / schedule
   * - `sourceId`：timer 事件源 id
   * - `skippedSinceLastFire`：距上次 fire 被跳过的次数 —— 长期被 running 任务
   *   挡住时这个数字会很大，是「空转但不留 trace」的可观测证据
   * - `scheduleTime` / `scheduleLabel`：schedule 模式下的命中项
   */
  @TracedAs("timer.tick.fire", {
    // 只要属性，不要 params/result 原始负载
    recordParams: true,
    recordResult: false,
    log: false,
    paramFilter: (args: unknown[]) =>
      buildFireSpanAttributes(args[0] as TimerFireContext),
    flattenParamFilter: true,
  })
  private fireTick(ctx: TimerFireContext): void {
    this.firedTicks++;
    this.skippedSinceLastFire = 0;

    const event = this.buildSelfReminderEvent(ctx.entry);
    this.eventHandler?.(event);
  }


  /**
   * ★ Task #4815：schedule 模式 tick
   *
   * 逻辑：
   * 1. 取当前本地时刻（HH:MM）与日期（YYYY-MM-DD）
   * 2. 找出与当前时刻匹配的 schedule 项
   * 3. 若该 `日期#时刻` 今日已触发 → 跳过（当日去重）
   * 4. schedule 模式默认**不**做 rule-based 跳过；
   *    仅当 options.skipWhenRunning=true 时才检查后台任务
   * 5. 命中 → 标记已触发 + 构建事件（prompt 取当次命中项）
   *
   * ★ Task #5409：入口不再挂 `@TracedAs`。只有真正命中并 fire 时才由
   * `fireTick()` 落一条 `timer.tick.fire`（mode=schedule）；未命中 / 当日已触发 /
   * 被 running 任务挡住 / schedule 全项非法 → 零 trace，只累加 `skippedTicks`。
   */
  private tickSchedule(): void {
    // ★ review MINOR-1：schedule 配置存在但没有任何合法项 —— 不触发任何事件，
    //   并告警一次（避免静默退化成 interval 模式乱跑默认 SelfReminder）。
    if (this.schedule.length === 0) {
      if (!this.invalidScheduleWarned) {
        this.invalidScheduleWarned = true;
        console.warn(
          `[TimerInstance] Timer ${this.config.id} has an invalid or empty schedule configuration; ` +
            `no events will be fired. Check options.schedule (expected [{ time: "HH:MM", prompt: "..." }]).`,
        );
      }
      this.recordSkip();
      return;
    }

    const now = new Date(this.now());
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const currentTime = `${hh}:${mm}`;
    const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    for (const entry of this.schedule) {
      if (entry.time !== currentTime) continue;

      const firedKey = `${dateKey}#${entry.time}`;
      if (this.firedKeys.has(firedKey)) {
        // 当日已触发过 → 去重跳过
        continue;
      }

      // rule-based：仅在显式开启时生效
      if (this.skipWhenRunning) {
        let hasRunning = false;
        try {
          const allTasks = this.getRunningTasks();
          hasRunning = Array.isArray(allTasks) && allTasks.some((t) => t.status === "running");
        } catch (error) {
          console.warn(`[TimerInstance] Failed to get running tasks, skipping tick: ${error}`);
          this.recordSkip();
          return;
        }
        if (hasRunning) {
          // 有运行中任务 → 不标记已触发（下次 tick 仍可触发）
          continue;
        }
      }

      // 标记已触发（当日去重）
      this.firedKeys.add(firedKey);
      this.pruneFiredKeys(dateKey);

      // 命中 → fire + 唯一一条 trace
      this.fireTick({
        mode: "schedule",
        sourceId: this.config.id,
        skippedSinceLastFire: this.skippedSinceLastFire,
        entry,
      });
      // 一个 tick 只触发一项（同一时刻不应有多项）
      return;
    }

    // 走到这里 = 本次 tick 什么都没 fire（时刻不命中 / 当日去重 / 被挡）
    this.recordSkip();
  }

  /**
   * 清理过期的去重标记（只保留当天的）
   *
   * 防止长期运行时 Set 无限增长（每天新增若干 key）。
   * 实现：只保留 `currentDateKey` 当天的标记。
   * 说明：跨天时昨天的 key 失去意义（dateKey 不同即不同 key），删掉是安全的。
   */
  private pruneFiredKeys(currentDateKey: string): void {
    if (this.firedKeys.size <= 32) return; // 小规模无需清理
    for (const key of this.firedKeys) {
      const datePart = key.split("#")[0];
      if (datePart !== currentDateKey) {
        this.firedKeys.delete(key);
      }
    }
  }

  /**
   * 构建 SelfReminder 事件
   *
   * 结构参考 LarkCliInstance.handleEvent() 输出的 EventSourceEvent
   *
   * ★ Task #4815：schedule 模式下
   *   - message 取命中 schedule 项的 prompt
   *   - metadata 注入 `trigger_session_id`（EventHandler 用它把事件路由到
   *     独立 session，而不是主会话）
   *   - metadata 注入 `scheduleLabel`（可选，便于下游识别是哪个时刻）
   *
   * @param entry 命中的 schedule 项；interval 模式不传
   *
   * ★ Task #5409：不再挂 `@TracedAs` —— 它只在 `fireTick()` 内部被调用一次，
   * 且 fireTick 已经有 `timer.tick.fire` span。原来这里再加一个装饰器，
   * 会让「一次 fire」落 2 条 span（实测 span 数交替 2/3 正是这个原因）。
   */
  private buildSelfReminderEvent(entry?: TimerScheduleEntry): EventSourceEvent {
    const timestamp = this.now();
    const message = entry?.prompt ?? this.customPrompt ?? SELF_REMINDER_MESSAGE;

    // ★ schedule 模式：注入 trigger_session_id（事件路由到独立 session）
    const triggerSessionId =
      entry !== undefined
        ? (entry.sessionId ?? this.scheduleSessionId)
        : undefined;

    const metadata: Record<string, unknown> = {
      source: "event-source",
      sourceId: this.config.id,
      sourceMessageType: "timer.selfReminder",
      // ⚠️ `sessionId` 是**定时器实例**标识（timer-{sourceId}-{pid}），
      //   仅用于日志/排查，**不参与事件路由**。
      //   真正的路由目标是下面的 `trigger_session_id`（跨重启稳定）。
      sessionId: this.sessionId,
    };

    if (triggerSessionId !== undefined) {
      metadata.trigger_session_id = triggerSessionId;
      // ★ Task #4815：声明「session 不存在就按该 ID 创建」——
      //   这样每日总结跑在独立 session，而不是 fallback 到 REPL 主会话。
      metadata.createSessionIfMissing = true;
    }
    if (entry?.label !== undefined) {
      metadata.scheduleLabel = entry.label;
    }
    if (entry !== undefined) {
      metadata.scheduleTime = entry.time;
    }

    return {
      id: `es-${this.config.id}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      type: "event-source.event.timer",
      timestamp,
      metadata,
      payload: {
        sourceId: this.config.id,
        sourceType: "timer",
        rawEvent: {
          type: "timer.selfReminder",
          triggeredAt: timestamp,
        },
        message,
        metadata: {
          eventType: "timer.selfReminder",
          sourceId: this.config.id,
          sourceType: "timer",
          timestamp,
        },
        timestamp,
      },
    };
  }
}

// =============================================================================
// TimerHandler
// =============================================================================

/**
 * Timer EventSourceHandler 实现
 */
export const timerHandler: EventSourceHandler = {
  type: "timer",

  validateConfig(config: EventSourceConfig): string[] {
    const errors: string[] = [];
    const { interval } = config;

    // ★ Task #4815：schedule 模式校验（格式 / prompt 必填 / 与 interval 互斥）
    errors.push(...validateScheduleConfig(config));

    // interval 缺失时使用默认值，不报错（schedule 模式下 interval 本就互斥）
    const hasSchedule = (config.options as Record<string, unknown> | undefined)?.[
      TIMER_OPTIONS_KEY_SCHEDULE
    ] !== undefined;

    if (!hasSchedule && interval !== undefined && interval !== null) {
      if (typeof interval !== "number" || !Number.isFinite(interval)) {
        errors.push("Timer interval must be a finite number");
      } else if (interval <= 0) {
        errors.push("Timer interval must be a positive number (milliseconds)");
      }
    }

    return errors;
  },

  createInstance(config: EventSourceConfig): EventSourceInstance {
    return new TimerInstance(config);
  },

  getOptions() {
    return [
      {
        name: "interval",
        description: `Timer interval in milliseconds (default: ${DEFAULT_TIMER_INTERVAL_MS} = 10 minutes). Mutually exclusive with schedule.`,
        required: false,
        type: "number" as const,
      },
      {
        name: "prompt",
        description: "Custom prompt message for SelfReminder events (replaces default message)",
        required: false,
        type: "string" as const,
      },
      {
        name: TIMER_OPTIONS_KEY_SCHEDULE,
        description:
          "JSON array of { time: 'HH:MM', prompt: string, label?: string, sessionId?: string } " +
          "for fixed daily trigger times (e.g. 10:00 / 17:00 / 20:00). Mutually exclusive with interval.",
        required: false,
        type: "string" as const,
      },
      {
        name: TIMER_OPTIONS_KEY_SESSION_ID,
        description:
          "Explicit session ID for timer events (schedule mode). Events are routed to this " +
          "session instead of the main REPL session.",
        required: false,
        type: "string" as const,
      },
    ];
  },
};
