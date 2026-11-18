/**
 * @fileoverview Task #4576 — `chat` 的 EventHandler + TaskEventHandler
 *
 * ## 修的是什么
 *
 * `chat.ts` 此前 **0 处 EventHandler**（`grep -c` 实测）。`interactive.ts`（32 处）和
 * `run.ts` 都有完整 handler 链路，只有 `chat` 没有。后果：
 *
 * ```
 * chat 触发的 delegate → 后台任务 publish task.background.*
 *   → 无订阅方 → rule-based 通知无落点、agent 无接管
 *   → 只能靠 chat.ts 自己轮询 listTasks() 等任务结束（#4571 的临时方案）
 * ```
 *
 * ## ⚠️ 但只加 EventHandler 是不够的（本任务揭穿的隐藏前置条件）
 *
 * `chat` 的 agent 轮**不 emit trigger event**（`emitCliTriggerEvent` 只在
 * run/interactive 里调），于是：
 *
 * ```
 * delegate 时刻 _captureReplyChannelSnapshot() 读 getEnvContext()?.replyChannel
 *   → chat 从未注入 envEvent ⇒ replyChannel = undefined
 *   → notify event 无 replyChannel、无 triggerEventId
 *   → EventHandler.resolveNoticeTarget() 三级全 miss
 *       (metadata.replyChannel → metadata.chatId → triggerEventId 反查)
 *   → sendRuleNotice() 首行 return { error: "no-target" }
 *   → 事件照旧进 lane 跑 agent，但**用户一条通知也看不到**
 * ```
 *
 * ⇒ 本模块只负责 handler；trigger event 注入在 `chat.ts` 里做（照抄 #4568
 *   在 run.ts 的写法）。两件事缺一不可。
 *
 * ## 四个设计决策（详见 /tmp/chat-event-handler-design.md）
 *
 * | Q | 决策 |
 * |---|---|
 * | Q1 生命周期 | session 之后、首个 query 之前起；`finally` 里先 `stop()` 再 `exit(0)` |
 * | Q2 lane | 不做额外设计；注入真实 `isIdle`/`isSessionIdle`（M1 修正：原"会死锁"的理由不成立） |
 * | Q3 输出 | 一律走注入的 `notice`（生产 = stderr），**绝不 `console.log`**（Ink 独占 stdout 整帧重绘） |
 * | Q4 event 进 agent | 接受「1 用户轮 + N 通知轮」，但 N 有**硬上界**（默认 1），超界明确告知 |
 */

import type { BaseEnvironment } from "@ai-setting/roy-bot-core";

import { EventHandler } from "./event-handler";
import { TaskEventHandler } from "./task-event-handler";
import { EventMessageFormatter } from "./event-message-formatter";
import { createEventHandlerForInteractive } from "./event-handler-wiring";

/**
 * 通知轮（event → agent）的默认上界。
 *
 * ## 为什么必须有上界（Q4 的核心）
 *
 * chat 是**一次性命令**，无人在旁交互。若通知轮可以无限触发：
 * - 烧钱：每轮都是完整 LLM run
 * - 丢输出：进程随时会被 `exit(0)` 带走，后面的轮次白跑
 * - 套娃：通知轮里再 delegate → 又一条 notify event → 又一轮
 *
 * ## 为什么「没有 replyChannel」不足以阻断套娃
 *
 * 直觉上以为「chat 的通知轮不 emit trigger event ⇒ 下一层通知没 replyChannel ⇒
 * 链路自然断」。**这个推断是错的**：`handleEvent` 里 `sendRuleNotice()` 返回后
 * **继续 `enqueue`** —— 规则回执发不出去 ≠ 事件不进 lane。所以套娃照样能继续，
 * 只是每层都"悄悄跑、悄悄没通知"。必须有显式上界。
 *
 * ## 为什么默认是 1 而不是 0
 *
 * 用户目标 ③「部分 event 能进 agent 处理得到 response」。设 0 就等于
 * 退化成"只通知不进 agent"，目标落空。设 1 能覆盖「任务完成 → agent 读结果
 * 组织总结」这个主场景，又不至于套娃。
 */
export const MAX_CHAT_NOTIFY_ROUNDS_DEFAULT = 1;

/** 覆盖通知轮上界的环境变量名 */
export const MAX_CHAT_NOTIFY_ROUNDS_ENV = "ROY_AGENT_CHAT_MAX_NOTIFY_ROUNDS";

/**
 * 上界的**硬上限**（交叉验证 L1）。
 *
 * 为什么需要：`Number("1e9")` 是有限非负数，原实现会原样接受 → 上界形同虚设，
 * 与 docstring 里「不放行任意大值」自相矛盾（xval 实测 `1e9` → 1000000000）。
 *
 * 为什么是 10：chat 是一次性命令，10 轮已经是"极其反常"的量级（正常 1 轮够用）；
 * 再大只会烧钱且用户看不到（进程随时会退）。超出即夹紧到 10，**不静默忽略**
 * （env 里写了 999 的用户应当得到 10，而不是"没生效"或"真的跑 999 轮"）。
 */
export const MAX_CHAT_NOTIFY_ROUNDS_CAP = 10;

/**
 * 从环境变量读取通知轮上界。
 *
 * 语义：
 * - 未设置 / 空串      → 默认值（1）
 * - `"0"`              → 0（合法：完全不让 event 进 agent，只做 rule-based 通知）
 * - 合法非负整数       → 该值
 * - 负数 / 非数字 / NaN → 默认值（**不猜、不放行任意大值**）
 */
export function readMaxChatNotifyRoundsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MAX_CHAT_NOTIFY_ROUNDS_ENV];
  if (raw === undefined || raw.trim() === "") return MAX_CHAT_NOTIFY_ROUNDS_DEFAULT;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return MAX_CHAT_NOTIFY_ROUNDS_DEFAULT;
  // ★ 交叉验证 L1：夹紧到硬上限（`1e9` 这类"有限但荒谬"的值必须收住）
  return Math.min(Math.floor(parsed), MAX_CHAT_NOTIFY_ROUNDS_CAP);
}

/** chat 订阅的事件类型（与 run.ts / interactive.ts 逐字一致） */
export const CHAT_EVENT_TYPES = [
  "task.background.*",
  "event-source.event.*",
] as const;

export interface CreateChatEventHandlersOptions {
  /** 环境实例（用于 subscribeAll） */
  env: BaseEnvironment;
  /** SessionComponent（供 EventHandler 解析 `cli:<sid>` → 原 session） */
  sessionComponent: unknown;
  /**
   * 通知 / 通知轮回复的落点。
   *
   * 生产环境传 `(t) => process.stderr.write(t + "\n")`。
   * 为什么不是 stdout：Ink 独占 stdout 做整帧重绘，运行期裸写会被覆盖或错序
   * （Task #4568 的 `writeTriggerEcho` 已为此专门绕道 stderr）。
   */
  notice: (text: string) => void;
  /**
   * 通知轮的 agent 调用。
   *
   * 必须是**能接 envEvent** 的那条路径（chat.ts 里同一闭包），否则
   * replyChannel / trace 上下文断链。
   *
   * @param message  格式化后的通知文案
   * @param envEvent 原始 EnvEvent（透传给 `handle_query` 的 context）
   */
  runAgentTurn: (message: string, envEvent?: unknown) => Promise<string>;
  /** EventStore db 路径（测试注入 tmpdir；生产走默认 ~/.roy-bot/event-store.db） */
  dbPath?: string;
  /** 通知轮上界（默认读 env → 再默认 1） */
  maxNotifyRounds?: number;
  /**
   * chat 的空闲判据（**当前有没有 chat 自己那一轮在跑**）。
   *
   * 默认 `() => true`（保守：假设空闲，不阻塞）—— 仅作降级兜底。
   * 生产由 `chat.ts` 注入真实的「轮次计数是否归零」判据。
   *
   * ⚠️ 交叉验证 M1 修正：原实现写死 `() => true` 并声称"注入真判据会自己等
   * 自己 → 死锁"。**这个理由不成立** —— `waitForIdle()` 在 lane **出队前**只
   * 检查一次，而 chat 自己那一轮从不在 lane 里记账，所以真判据不会造成自等。
   *
   * 不注入真判据的真实后果是：通知轮可能在用户轮**还在跑**时就并发启动，
   * 两轮同时写同一个 session（历史交错、抢占 provider 配额）。
   */
  isIdle?: () => boolean;

  /**
   * ★ 交叉验证 M1：per-session 门禁（与 `run.ts` 的用法对齐）。
   *
   * 语义 = 「这个 session 现在能不能起新一轮」。chat 只有一条 lane / 一个
   * session，所以判据就是「chat 自己那一轮是否在跑」：
   *   - 在跑 → 返回 false → 通知轮排队等（不并发写同一 session）
   *   - 空闲 → 返回 true  → 通知轮立刻开始
   *
   * 不传时回落 `isIdle`（EventHandler 的既有行为）。
   */
  isSessionIdle?: (sessionId: string) => boolean;

  /**
   * 探针用的 session id（仅供 `getIsSessionIdle()` 回读）。
   *
   * 生产不用传；测试传一个固定值即可断言门禁真的被问到。
   */
  sessionIdForIdleCheck?: string;
}

export interface ChatEventHandlers {
  eventHandler: EventHandler;
  taskEventHandler: TaskEventHandler;
  /** 停止两个 handler（幂等，可重复调用） */
  stop: () => void;
  /** 已经跑过的通知轮数 */
  getNotifyRounds: () => number;
  /** handler 是否还有积压 / 处理中的事件（供 `waitForBackgroundTasks` 组合等待） */
  isBusy: () => boolean;
  /** 已订阅的事件类型（测试可断言与 run/interactive 对齐） */
  getEventTypes: () => readonly string[];
  /** 注入的 isIdle 结果（测试断言 `isIdle()` 恒 true） */
  getIsIdle: () => boolean;
  /**
   * 回读注入的 isSessionIdle 结果。
   *
   * 未注入 → `undefined`；已注入 → 调用它的返回值（这样测试能真正检测
   * 回归，而不是断言一个恒定的 `undefined`）。
   */
  getIsSessionIdle: () => unknown;
  isStoreDegraded: () => boolean;
}

/**
 * 为一次 `chat` 调用创建 EventHandler + TaskEventHandler。
 *
 * 返回的 `stop()` **幂等**：`chat.ts` 的 `finally` 与正常收尾都可能调它。
 */
export function createChatEventHandlers(
  options: CreateChatEventHandlersOptions,
): ChatEventHandlers {
  const { env, notice } = options;
  const maxNotifyRounds =
    options.maxNotifyRounds ?? readMaxChatNotifyRoundsFromEnv();

  let notifyRounds = 0;
  let stopped = false;

  // --------------------------------------------------------------------------
  // TaskEventHandler：订阅 task.*，走 logger（默认写文件，不污染 stdout/stderr）
  // --------------------------------------------------------------------------
  const taskEventHandler = new TaskEventHandler({ env, enabled: true });
  const stopTaskEventHandler = taskEventHandler.start();

  // --------------------------------------------------------------------------
  // EventHandler
  // --------------------------------------------------------------------------
  // ★ 交叉验证 L5：EventStore 打不开时**降级**，不让 chat 启动失败。
  //
  //   `createEventHandlerForInteractive` → `getOrCreateEventStore()` 会
  //   `mkdirSync` + `new EventStoreImpl(...)`（同步 DDL），**没有 try/catch**。
  //   而 `emitCliTriggerEvent` 是刻意"永不抛"的 —— 对比之下这条路径更脆弱：
  //   store 不可写（磁盘满 / 权限 / 只读 fs）会让 `roy-bot chat` 直接起不来，
  //   而它改造前是能正常跑的（只是没有通知）。
  //
  //   降级策略：用 no-op handler 顶替。用户轮照常问答，只是没有通知链路
  //   （与改造前行为一致），并在 stderr 明确说明原因 —— 不假装一切正常。
  let eventHandler: EventHandler;
  let storeDegraded = false;
  try {
    eventHandler = createEventHandlerForInteractive({
    env,
    // ★ 交叉验证 N3：必须把 dbPath 透传下去。
    //
    //   不透传时 `createEventHandlerForInteractive` 永远用默认
    //   `~/.roy-bot/event-store.db` —— 于是 L5 的降级分支在生产上只在
    //   "默认路径也不可写"时才可达，而**测试传的 dbPath 完全无效**
    //   （E5 变成了同义反复，检测不出任何回归）。
    ...(options.dbPath ? { dbPath: options.dbPath } : {}),
    eventTypes: [...CHAT_EVENT_TYPES],
    formatter: new EventMessageFormatter({ prefix: "[通知]" }),
    sessionComponent: options.sessionComponent as never,
    // ★ Q2（交叉验证 M1 修正）：注入真实的 isIdle + isSessionIdle，
    //   让通知轮**不与用户轮并发**跑同一个 session。
    //
    //   原实现写死 `() => true` 并声称"注入真判据会死锁"—— xval 指出该理由
    //   不成立：`waitForIdle()` 在 lane **出队前**只查一次，而 chat 自己那一轮
    //   从不在 lane 里记账，所以真判据不会自等。
    //
    //   不注入的真实代价：后台任务常常在用户轮**还在写回复**时就完成（delegate
    //   立即返回，子任务 1s 内结束），通知轮会立刻并发启动 → 两轮同时
    //   `env.handle_query` 写同一 session（历史交错 + 抢 provider 配额）。
    isIdle: options.isIdle ?? (() => true),
    ...(options.isSessionIdle ? { isSessionIdle: options.isSessionIdle } : {}),

    // ★ Q3：通知一律走 notice（stderr），不 spawn lark-cli。
    //
    //   默认分派的 `sink === 'stdout'` 分支是 `console.log` —— 在 chat 的 Ink
    //   会话里会被帧重绘覆盖。而 `sink === 'lark'` 会 spawn lark-cli 拿
    //   `cli:<sid>` 这种合成 chatId 去发，必然 invalid chat_id 再静默。
    //   两条都不通，所以完全接管：只写 notice。
    telemetrySender: async (n) => {
      notice(n.text);
    },

    // required by EventHandlerOptions，实际用 onEventWithEnv
    onEvent: async () => {},

    onEventWithEnv: async (formatted) => {
      // ---- Q4：上界拦截 --------------------------------------------------
      if (notifyRounds >= maxNotifyRounds) {
        // 绝不静默：用户必须知道"为什么这条通知之后没动静了"
        notice(
          `⚠️ 本次 chat 的通知轮已达上限（${maxNotifyRounds} 轮），` +
            `后续事件不再交给 agent 处理。`,
        );
        notice(
          "  如需持续接管后台任务通知，请改用 `roy-bot run`（REPL，常驻）" +
            " 或 `roy-bot interactive`。",
        );
        return;
      }

      notifyRounds++;

      // ---- 通知轮：交给 agent，回复打到 notice ---------------------------
      //
      // 为什么回复不走 Ink：此时 Ink 已被 `waitUntilExit()` 卸载
      //（ChatTui 拿到首轮回复就 `setTimeout(exit,100)`），再想 setHistory
      // 已经没有人接收 —— 直接写 notice 才不会丢。
      try {
        const answer = await options.runAgentTurn(
          formatted.message,
          formatted.envEvent,
        );
        if (answer && answer.trim().length > 0) {
          notice(`\n🤖 [通知 → agent]\n${answer}\n`);
        }
      } catch (err) {
        // ★ 不吞：上一条通知轮失败要明示，且绝不影响后续事件处理
        //   （EventHandler 自身有 try/catch 兜底，但兜底只会 console.error，
        //    在 chat 的 stderr 语义下不如这里直说清晰）
        notice(
          `⚠️ 处理后台任务通知时 agent 报错：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    });
  } catch (err) {
    // ★ 交叉验证 L5：降级而不是崩。
    storeDegraded = true;
    notice(
      `⚠️ 无法初始化事件存储（${err instanceof Error ? err.message : String(err)}）—— ` +
        `本次 chat 不会收到后台任务通知。问答功能不受影响。`,
    );
    // no-op handler：形状满足下游调用（getQueueLength + stop）
    eventHandler = {
      getQueueLength: () => 0,
      start: () => () => {},
      stop: () => {},
    } as unknown as EventHandler;
  }

  const stopEventHandler = eventHandler.start();

  return {
    eventHandler,
    taskEventHandler,
    stop: () => {
      if (stopped) return;
      stopped = true;
      // ★ 交叉验证 L3：`stop()` 只在 exit 前调用，不 await in-flight 轮次 ——
      //   所以注释里"防止被 SIGTERM 腰斩"的说法是**过度承诺**，已改。
      //   但队列里"还没开始"的通知确实会被 `lanes.clear()` 静默丢弃，必须告知。
      try {
        const pending = eventHandler.getQueueLength();
        if (pending > 0) {
          // ★ 交叉验证 N7：`getQueueLength()` 含 in-flight，所以措辞不能只说
          //   "未处理"（正在处理的那条也会被算进去）。
          notice(`⚠️ 还有 ${pending} 条通知未处理完（进程即将退出）。`);
        }
      } catch {
        // 查询失败不影响停止流程
      }
      try {
        stopEventHandler();
      } catch {
        // stop 本身不该抛；即便抛也不允许阻止进程退出
      }
      try {
        eventHandler.stop();
      } catch {
        // 同上
      }
      try {
        stopTaskEventHandler();
      } catch {
        // 同上
      }
      try {
        taskEventHandler.stop();
      } catch {
        // 同上
      }
    },
    getNotifyRounds: () => notifyRounds,
    isBusy: () => !stopped && eventHandler.getQueueLength() > 0,
    getEventTypes: () => CHAT_EVENT_TYPES,
    /** ★ 交叉验证 L5：事件存储是否降级（true = store 打不开，通知链路不可用） */
    isStoreDegraded: () => storeDegraded,
    getIsIdle: () => (options.isIdle ?? (() => true))(),
    // ★ 交叉验证 L6：原来硬返回 undefined —— 那是**同义反复**的测试，
    //   检测不出"有人把 isSessionIdle 注进来"的回归。现在真实回读注入值。
    getIsSessionIdle: () =>
      options.isSessionIdle
        ? options.isSessionIdle(options.sessionIdForIdleCheck ?? "")
        : undefined,
  };
}
