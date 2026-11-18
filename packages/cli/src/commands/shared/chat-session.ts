/**
 * @fileoverview Task #4571 — `chat` 命令的 session 创建（替代硬编码 "cli-chat"）
 *
 * ## 修的是什么
 *
 * `chat.ts` 之前直接：
 * ```typescript
 * env.handle_query(message, { sessionId: "cli-chat" });   // ← 从未 create
 * ```
 * 而 `BackgroundTaskManager.createTask()` 第一步就要：
 * ```typescript
 * const parentSession = await sessionComponent.get(parentSessionId);
 * if (!parentSession) throw new Error(`Parent session not found: ${parentSessionId}`);
 * ```
 * ⇒ `chat` 里任何 `delegate_task` **必然失败**，agent 只能回一句
 * 「Parent session not found: cli-chat」。
 *
 * ## 方案 B（用户 2026-10-27 明确选择）
 *
 * ```typescript
 * const sessionId = await env.createSession()
 * handle_query(message, { sessionId })
 * ```
 * 即：先 create 出**真实** session，再用它的 id。
 *
 * ## Q1：session 生命周期 —— 保留，不删
 *
 * | 选项 | 判断 |
 * |---|---|
 * | a) 用完就删 | ❌ 删了之后 `roy-bot sessions get <id>` 查不到，trace / 审计断链；后台任务的 `parentSessionId` 会指向已删 session（`query_background_process` 复盘时拿不到上下文） |
 * | **b) 保留** | ✅ **采用**。可追溯；清理交给现成能力：`roy-bot sessions delete --older-than N` / `sessions list` |
 * | c) 临时 session + TTL | ⚠️ 现在没有 TTL 机制，要新造一套定时清理，超出本 bug 范围 |
 *
 * 为什么不删的**额外**理由：chat 是**一次性命令**，一次调用一个 session。
 * `sessions delete --older-than` 已能清，不需要在热路径上做删除
 * （删除还会跟后台任务的生命周期打架 —— 任务还没跑完，父 session 先被删了）。
 *
 * ⚠️ **体积实测修正**（交叉验证 MEDIUM #3）：
 *   本注释最初写「每个 ~几百字节」，**错得很离谱**。对真实
 *   `~/.local/share/roy-bot/sessions.db` 实测：
 *
 *   ```
 *   cli-chat sessions: 19，avg metadata bytes: 59,293
 *   最新一条 cli-chat session: metadataBytes = 102,390
 *   ```
 *
 *   原因：chat 一旦有了**真实** session，`AgentComponent._run` 会把
 *   `metadata.cacheSnapshot`（= **整份 system prompt**）写进 session 行
 *   （`packages/core/src/env/agent/agent-component.ts:2465-2473`）。
 *   ⇒ 每次 chat ≈ **102 KB**，比原估大 ~250 倍；本地库已 3.3 GB。
 *
 *   `sessions delete --older-than N`（`commands/sessions/delete.ts:128-143`）
 *   确实能清，但**不级联删 message 行**（实测已有 10,556 条孤儿）。
 *   ⇒ 清理是必须的运维动作，不是可选项（见报告「遗留」）。
 *
 * ## Q2：title / metadata
 *
 * - **title**：`CLI chat · <消息摘要>`。摘要 40 字符截断 + 多行压单行。
 *   为什么带摘要而不是只用时间：`sessions list` 里一眼能看出这条会话是问什么的
 *   （chat 是一次性会话，光看时间戳完全无法区分）。
 * - **metadata.created_by = "cli-chat"**：标记来源，便于按来源筛选/批量清理
 *   （`act` / `run` / ES 各自有不同的 created_by 语义）。
 * - **metadata.chatMessage**：原始 query（截断），让 `sessions grep` 可追溯。
 *
 * ## Q3：run / interactive 有没有同样问题 —— **没有**
 *
 * 已核实（`commands/interactive.ts` / `commands/run.ts`）：
 * ```typescript
 * const sessionResult = await sessionManager.init(args.session, args.continue);
 * const { sessionId, sessionTitle } = sessionResult;
 * ```
 * `SessionManager.init()`（`session-manager.ts:91`）内部就是
 * `sessionComponent.create({ title })` + `setActiveSession()` —— **真实 session**。
 *
 * 全仓 `grep 'sessionId: "' packages/cli/src/commands/*.ts | grep -v test`
 * 只剩 `chat.ts:60` 一处硬编码（本次修的就是它）。
 * `act.ts:357` 也是 `sessionComponent.create(...)`。
 */

/** `metadata.created_by` 的取值（标记会话来源，便于筛选/清理） */
export const CHAT_SESSION_CREATED_BY = "cli-chat";

/**
 * title 里「消息摘要」部分的最大字符数。
 *
 * 40 是经验值：够认出「这条会话在问什么」，又不至于把 title 撑到一行显示不下。
 * 加上前缀/后缀后整体远低于 session store 的实用上限（128）。
 */
export const CHAT_SESSION_TITLE_MAX_CHARS = 40;

/** 整个 title 的硬上限（防御：避免超长消息撑爆 UI / DB 索引） */
const CHAT_SESSION_TITLE_HARD_CAP = 128;

/** title 前缀（区分 chat 与 act/run/ES 产生的会话） */
const CHAT_SESSION_TITLE_PREFIX = "CLI chat";

/**
 * chat 需要的最小 SessionComponent 形状。
 *
 * 刻意只声明 `create` —— 这样测试可以传极简 mock，且将来 SessionComponent
 * 接口扩张也不会打断这里。
 */
export interface ChatSessionComponentLike {
  create(options?: {
    id?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; title?: string }>;
}

export interface CreateChatSessionOptions {
  /** 用户原始 query（用于 title 摘要 + metadata 留档） */
  message: string;
}

export interface CreateChatSessionResult {
  /** 真实 session id（可直接作为 `handle_query` 的 sessionId） */
  sessionId: string;
  /** 生成的 title（便于日志） */
  title: string;
}

/**
 * 把用户 query 压成一行 title 摘要。
 *
 * - 多行 → 单行（title 里有换行会破坏 `sessions list` 的表格对齐）
 * - 超长 → 截断 + `…`
 * - 空 / 纯空白 → 兜底 `CLI chat`（不留空字符串）
 */
export function buildChatSessionTitle(message: string): string {
  const oneLine = (message ?? "").replace(/\s+/g, " ").trim();

  if (!oneLine) {
    // 兜底：至少要能认出是 chat 会话
    return `${CHAT_SESSION_TITLE_PREFIX} · (空消息)`;
  }

  const summary =
    oneLine.length > CHAT_SESSION_TITLE_MAX_CHARS
      ? `${oneLine.slice(0, CHAT_SESSION_TITLE_MAX_CHARS)}…`
      : oneLine;

  const title = `${CHAT_SESSION_TITLE_PREFIX} · ${summary}`;

  // 防御：即便摘要 + 前缀仍超硬上限（极端 CJK 场景），再切一刀
  return title.length > CHAT_SESSION_TITLE_HARD_CAP
    ? title.slice(0, CHAT_SESSION_TITLE_HARD_CAP - 1) + "…"
    : title;
}

/**
 * 为一次 `chat` 调用创建**真实** session。
 *
 * @throws 当 `sessionComponent` 不可用 / 没有 `create` / `create` 本身失败
 *         —— **绝不回退到硬编码 `"cli-chat"`**，那正是原始 bug。
 */
export async function createChatSession(
  sessionComponent: ChatSessionComponentLike | undefined,
  options: CreateChatSessionOptions,
): Promise<CreateChatSessionResult> {
  if (!sessionComponent || typeof sessionComponent.create !== "function") {
    throw new Error(
      "[chat] cannot create session: sessionComponent is unavailable " +
        "(env.getComponent('session') returned nothing). " +
        "Without a real session, delegate_task would fail with " +
        `"Parent session not found".`,
    );
  }

  const title = buildChatSessionTitle(options.message);

  let session: { id: string; title?: string };
  try {
    session = await sessionComponent.create({
      title,
      metadata: {
        created_by: CHAT_SESSION_CREATED_BY,
        // 留档原始 query（截断到 title 摘要量级即可，完整内容在消息表里）
        chatMessage:
          (options.message ?? "").replace(/\s+/g, " ").trim().slice(0, CHAT_SESSION_TITLE_MAX_CHARS) ||
          undefined,
      },
    });
  } catch (err) {
    // 明确报错，不静默降级：
    //   降级成硬编码 id 会把"Parent session not found"这个 bug 又放回来，
    //   而且更难查（用户看到的是 delegate 报错，而不是 session 创建失败）。
    throw new Error(
      `[chat] failed to create chat session: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!session || typeof session.id !== "string" || session.id.length === 0) {
    throw new Error(
      "[chat] sessionComponent.create() returned no usable id; " +
        "delegate_task would fail with \"Parent session not found\".",
    );
  }

  return { sessionId: session.id, title: session.title ?? title };
}

// ============================================================================
// Q4：后台任务等待（chat 是单次命令，不等就会被 process.exit 掐死）
// ============================================================================

/**
 * `BackgroundTaskManager` 的最小形状（只声明这里用到的）。
 *
 * 刻意不用完整类型：`listTasks()` 返回的 `BackgroundTask` 有十几个字段，
 * 这里只需要 `status` —— 用结构化最小接口便于测试注入。
 */
export interface BackgroundTaskManagerLike {
  listTasks(): Array<{ status: string }>;
}

/**
 * 仍在跑的状态集合（其它状态都算"已结束"）。
 *
 * ⚠️ `awaiting-user` **刻意排除**（交叉验证 MEDIUM 的延伸）。
 *
 * 语义依据：`chat` 是**一次性命令**（问一句、拿答案、退）。若 sub-agent
 * 通过 `ask_user` 停下来等人回答，chat 根本**没有渠道**把问题交给用户
 * （它是单轮 TUI，`ChatTui` 拿到回答就 exit）。所以：
 *   - 把它算"未结束" ⇒ 必然白等满 30s 然后被 kill（保证 30s 卡顿）
 *   - 把它算"已结束" ⇒ 立即退出，符合"不可回答"的事实
 * 选后者，并在 chat.ts 的超时/退出提示里说明这种任务需要常驻命令。
 */
const ACTIVE_TASK_STATUSES = new Set(["pending", "running"]);

/**
 * 「暂停等用户输入」的状态。
 *
 * 不算"仍在跑"（没有进程活着，`delegate-tool.ts:1493` 在 sub-agent 回合
 * **结束后**才写这个状态，sub-session 保留待续跑），但也**绝不能**当成
 * "已完成"报给用户 —— 交叉验证 MEDIUM #1。
 */
const AWAITING_USER_STATUSES = new Set(["awaiting-user"]);

/**
 * ★ 交叉验证 MEDIUM-1（round 3）：**失败的**终态。
 *
 * 为什么必须单独识别：`ACTIVE_TASK_STATUSES` 只有 `pending|running`，所以
 * `failed` / `timeout` / `stopped` **既不算未结束、也不算 awaiting-user**。
 *
 * 门禁放宽到 `hasAnyTask`（N1 修复）之后，这类任务会**进入**等待块；若结局
 * 归类成 `settled`，`chat.ts` 的 else 分支就会打印「✅ 后台任务已完成」——
 * 而任务是失败的。这正是 L2 那一类"撒谎"，只是从另一个方向被 N1 重新打开。
 */
const FAILED_TASK_STATUSES = new Set(["failed", "timeout", "stopped"]);

/**
 * ★ 交叉验证 NEW-4（round 4）：**证明成功**的终态白名单。
 *
 * 为什么需要：原实现把 `settled` 定义成"排除法"—— 只要不属于
 * {pending,running} ∪ {awaiting-user} ∪ {failed,timeout,stopped} 就算成功。
 * 于是任何**未知/新增**状态（例如 `cancelled`、或字段缺失时 `t?.status`
 * 为 undefined）都会被报成「✅ 后台任务已完成」。
 *
 * 改成"证明法"：只有所有任务都明确是 `completed` 才算成功；其余一律不报成功。
 * 宁可说"未能确认"，不可假装成功。
 */
const SUCCESS_TASK_STATUSES = new Set(["completed"]);

/** `listTasks()` 查询结果（区分"真的没有"与"查不出来"） */
export interface UnfinishedTasksProbe {
  /** 是否还有未结束任务 */
  unfinished: boolean;
  /** 是否有任务停在 awaiting-user（暂停等输入，既非运行也非完成） */
  awaitingUser?: boolean;
  /**
   * ★ 交叉验证 N1（M2 外层修复）：`listTasks()` 里**是否还存在任何任务记录**。
   *
   * ## 为什么要单独一个字段（`unfinished` 不够）
   *
   * `BackgroundTaskManager` 里 `task.status = "completed"` **早于**
   * `publishBackgroundEvent(COMPLETED)`，中间还夹着
   * `await resolveAssociatedTaskIdBySubSession(...)`（一次 DB 往返）。
   * 于是存在一个毫秒级窗口：
   *
   * ```
   * t0  status = "completed"                 ← unfinished 立刻变 false
   * t1  await resolveAssociatedTaskId…        ← 窗口
   * t2  publishBackgroundEvent → pushEnvEvent  （handleEvent 不 await）
   * t3  await sendRuleNotice → await formatEvent → enqueue  ← 队列才非空
   * ```
   *
   * 在 [t0, t3) 内：`unfinished === false` **且** `getQueueLength() === 0`
   * —— 两路同时报"没事了"，外层门禁跳过整个等待块 → `exit(0)` → 通知丢失。
   *
   * `hasAnyTask` 用「记录是否还在」而不是「状态是否活跃」来判，能跨过这个窗口：
   * 任务一旦被 `listTasks()` 看到过，就有理由进等待块（等待有 30s 上限，不会挂）。
   */
  hasAnyTask?: boolean;
  /**
   * ★ 交叉验证 MEDIUM-1：是否有任务停在失败终态（failed / timeout / stopped）。
   *
   * 与 `hasAnyTask` 配合：进得了等待块（有记录），但结局必须报"未成功"，
   * 不能报"已完成"。
   */
  failed?: boolean;
  /**
   * 查询本身是否失败。
   *
   * ★ 交叉验证 MEDIUM：原实现 `catch { return false }` 把"查询炸了"当作
   *   "没有任务"，于是 chat.ts 会**静默跳过等待** —— 又回到"后台任务被
   *   process.exit 掐死"的原始 bug，而且连提示都没有。
   *   现在把失败明确暴露给调用方，由它决定怎么告知用户。
   */
  queryFailed: boolean;
  /** 失败原因（queryFailed 时带） */
  error?: string;
  /**
   * ★ 交叉验证 NEW-4：是否**被证明**为全部成功完成（所有任务都明确 `completed`）。
   *
   * 与 `!unfinished` 的区别：后者是"没有活跃任务"（排除法 —— 未知状态、
   * 字段缺失都会通过），前者是"确实成功了"（证明法）。
   *
   * chat.ts 只在 `settledByProof === true` 时才报「✅ 后台任务已完成」。
   */
  settledByProof?: boolean;
}

/** 探测后台任务是否未结束（带查询失败标记） */
export function probeUnfinishedTasks(
  manager: BackgroundTaskManagerLike | undefined,
): UnfinishedTasksProbe {
  if (!manager || typeof manager.listTasks !== "function") {
    // manager 缺失 ≠ 查询失败：chat 没有 delegate 时就是这种情况，属正常
    return { unfinished: false, queryFailed: false };
  }
  try {
    const tasks = manager.listTasks();
    const unfinished = tasks.some((t) => ACTIVE_TASK_STATUSES.has(t?.status));
    const awaitingUser = tasks.some((t) => AWAITING_USER_STATUSES.has(t?.status));
    return {
      unfinished,
      awaitingUser,
      hasAnyTask: tasks.length > 0,
      failed: tasks.some((t) => FAILED_TASK_STATUSES.has(t?.status)),
      // ★ NEW-4：证明法 —— 剩下的每个任务都必须**明确**是 completed。
      //
      //   ⚠️ 空列表保持 `true`（`[].every()` 语义）：这沿用 #4571 的既有契约
      //   「真的没任务 → settled」（`chat-session.test.ts` ★ MEDIUM#1 锁着它），
      //   不能为了修"未知状态误报"而把这个正常场景一起改坏。
      //   实际影响面也有限：chat.ts 的外层门禁要求 `hasAnyTask`，零任务时根本
      //   不会进等待块，「✅ 已完成」也就不会被打出来。
      settledByProof:
        !unfinished &&
        !awaitingUser &&
        tasks.every((t) => SUCCESS_TASK_STATUSES.has(t?.status)),
      queryFailed: false,
    };
  } catch (err) {
    return {
      unfinished: false,
      queryFailed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 是否还有未结束的后台任务。
 *
 * ⚠️ 这是 `probeUnfinishedTasks().unfinished` 的便捷包装。
 * **需要区分"查询失败"的调用方请用 `probeUnfinishedTasks()`** ——
 * 本函数在查询失败时也返回 false（与历史行为一致），单看它无法区分。
 */
export function hasUnfinishedTasks(
  manager: BackgroundTaskManagerLike | undefined,
): boolean {
  return probeUnfinishedTasks(manager).unfinished;
}

export interface WaitForBackgroundTasksOptions {
  /** 轮询间隔（默认 500ms） */
  pollIntervalMs?: number;
  /** 最长等待（默认 30s）—— 超过就放弃，绝不让 CLI 无限挂住 */
  timeoutMs?: number;
  /** 每轮回调（用于打印进度 / 测试断言） */
  onTick?: (elapsedMs: number) => void;
  /** 用于测试注入的 sleep（默认 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 用于测试注入的时钟（默认 Date.now） */
  now?: () => number;
  /**
   * ★ Task #4576（Q1）：额外忙碌判据。
   *
   * ## 为什么 `listTasks()` 不够
   *
   * `chat` 现在也起了 EventHandler（Task #4576）。EventHandler 的
   * **通知轮 agent run 不注册成 background task** —— 它只是一次普通的
   * `handle_query`。所以 `listTasks()` 完全看不见它：
   *
   * ```
   * t0  delegate 启动后台任务         ← listTasks() 能看到 ✔
   * t1  后台任务 completed            ← listTasks() 变空
   * t2  EventHandler 收到 completed   ← 开始跑通知轮 agent
   * t3  probe 返回「没有任务了」      ← ❌ 但 agent 轮还在跑！
   * t4  process.exit(0)               ← 通知轮被腰斩，输出丢失
   * ```
   *
   * 传入 `() => eventHandler.getQueueLength() > 0` 就能把 t2–t3 这段等住。
   *
   * ## 为什么不传时的行为**完全不变**
   *
   * 返回 `undefined` 时退化成「只看 listTasks()」，与 Task #4571 的实现逐字
   * 一致 —— 老调用方 / 老测试零改动。
   */
  isExtraBusy?: () => boolean;
  /**
   * ★ Task #4576（交叉验证 M2）：判定「全清」前需要**连续空闲**的时长。
   *
   * ## 为什么需要（首发探测的竞态）
   *
   * `BackgroundTaskManager` 里 `task.status = "completed"` 早于
   * `publishBackgroundEvent(COMPLETED)`，中间还夹着
   * `await this.resolveAssociatedTaskIdBySubSession(...)`。所以存在一个几毫秒
   * 的窗口：**任务已探测为"结束"，但通知事件还没进 handler 队列**。
   *
   * ```
   * t0  task.status = "completed"          ← probe 开始报"没有任务"
   * t1  await resolveAssociatedTaskId…     ← 窗口（事件尚未 publish）
   * t2  publishBackgroundEvent(COMPLETED)  ← 事件才到
   * t3  handleEvent → await sendRuleNotice → await formatEvent → enqueue
   * ```
   *
   * 若调用方的探测正落在 t0–t2，`unfinished === false` 且
   * `getQueueLength() === 0` **同时成立** ⇒ 判定"没事了" ⇒ `exit(0)`
   * ⇒ 通知丢失（正是本任务要交付的那条通知）。
   *
   * ⇒ 要求「连续 settleMs 都空闲」才返回 `settled`，把窗口跨过去。
   *
   * 默认 `0`（不额外等待）—— 保证既有调用方行为**逐字不变**（测试 F3 锁）。
   *
   * ⚠️ 交叉验证 LOW-4：该判据只在**轮询边界**求值，因此实际保证的空闲窗口是
   * `max(settleMs, pollIntervalMs)`。默认 `pollIntervalMs = 500`，所以传 300 的
   * 真实保证窗口是 500ms。想精确控制就同时调小 `pollIntervalMs`。
   */
  settleMs?: number;
}

/**
 * 等待结束时后台任务的**结局**（三方态，交叉验证 MEDIUM #1）。
 *
 * - `settled`：真的没有活跃任务了 → 可以报"已完成"
 * - `awaiting-user`：有任务停在 `ask_user`（sub-session 保留待续跑，但
 *   **没有进程在跑**）→ chat **不能**说"已完成"，它只是被暂停了
 * - `timeout`：有任务仍在 pending/running 且已超时 → 必须说真话
 * - `unknown`：查询失败，不知道还剩什么
 *
 * 为什么必须区分：`awaiting-user` 若与 `settled` 合并，chat 会打印
 * 「✅ 后台任务已完成」—— 而任务其实是**暂停等输入**，chat 又没有渠道
 * 让它继续。那正是本 commit 自己写的原则要消灭的"假装成功"。
 */
export type BackgroundWaitOutcome =
  | "settled"
  | "awaiting-user"
  | "timeout"
  | "unknown"
  /** ★ 交叉验证 MEDIUM-1：有任务失败/超时/被停止 —— 绝不能报"已完成" */
  | "failed";

export interface WaitForBackgroundTasksResult {
  /** 是否等到全部结束（false = 超时 / 查询失败） */
  finished: boolean;
  /** 实际等待时长 */
  waitedMs: number;
  /** 结束时是否仍有活跃任务 */
  stillRunning: boolean;
  /**
   * 结局（三方态）。`finished === true` **不一定**等于"成功完成" ——
   * 可能是 `awaiting-user`。调用方必须按 outcome 渲染文案。
   */
  outcome?: BackgroundWaitOutcome;
  /**
   * 轮询期间 `listTasks()` 是否抛过异常。
   *
   * true 表示"我们不知道还有没有任务"，调用方必须**如实告知**用户
   * 而不是假装等到了。交叉验证 MEDIUM。
   */
  queryFailed?: boolean;
  error?: string;
  /**
   * ★ Task #4576：`finished === false` 且**只剩 handler 忙碌**（后台任务其实
   * 早已全部结束）。
   *
   * 为什么必须区分：超时收尾时若 `stillRunning === false` 但 handler 队列
   * 非空，文案不能写「后台任务未结束」—— 那是撒谎。真实情况是「后台任务都
   * 结束了，但接管它们的 agent 轮还没跑完」。
   */
  stillBusyOnly?: boolean;
  /** ★ 交叉验证 MEDIUM-1：后台任务里有失败终态（failed / timeout / stopped） */
  failed?: boolean;
  /**
   * ★ 交叉验证 NEW-4：是否**被证明**为全部成功完成（所有任务都明确 `completed`）。
   *
   * 与 `!unfinished` 的区别：后者是"没有活跃任务"（排除法，未知状态也会通过），
   * 前者是"确实成功了"（证明法）。chat.ts 只在 `settledByProof` 时报「已完成」。
   */
  settledByProof?: boolean;
}

/** 默认最长等待 30s（覆盖典型 5–15s 的 CLI 小任务，又不至于让用户以为卡死） */
export const DEFAULT_CHAT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * 等 `chat` 期间启动的后台任务全部结束。
 *
 * ## 为什么需要它（Q4 的实测证据）
 *
 * `chat` 是**一次性命令**：`ChatTui` 拿到 agent 的最终回复后
 * `setTimeout(() => exit(), 100)`，`chat.ts` 接着 `process.exit(0)`。
 *
 * 真机实测时序（Task #4571）：
 * ```
 * 20:47:57  task.background.started   ← 后台任务刚启动
 * 20:48:00  chat-fixed.log 写入完毕   ← 进程 process.exit(0)
 * （无 completed / timeout / failed）  ← 任务被掐死，从未跑到终态
 * ```
 *
 * ⇒ 用户看到「已委托，完成后通知你」，但那句话永远是假的：
 *   进程没了，既不会有通知，子 agent 也被一起带走。
 *
 * ## 为什么用「有限等待」而不是「无限等待」
 *
 * - 无限等待 = CLI 可能挂住几十分钟，用户以为卡死（比提前退出更糟）
 * - 30s 覆盖典型 CLI 小任务；超时后**明确告知**「任务仍在后台，用
 *   `query_background_process` 查」，把不确定性交给用户而不是静默
 * - 单次命令语义上就该有界
 *
 * ## 为什么轮询 listTasks 而不是订阅事件
 *
 * `chat` 目前**没有 EventHandler**（`grep -c EventHandler chat.ts` = 0），
 * 订阅 `task.background.*` 需要新起一套 handler 生命周期。轮询
 * `listTasks()` 是 O(N) 内存读、500ms 一次，代价可忽略，且不用引入
 * EventHandler / lane / session 解析那一整套复杂度。
 */
export async function waitForBackgroundTasks(
  manager: BackgroundTaskManagerLike | undefined,
  options: WaitForBackgroundTasksOptions = {},
): Promise<WaitForBackgroundTasksResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHAT_WAIT_TIMEOUT_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // ★ 用 performance.now()（单调时钟）而不是 Date.now()：
  //   NTP 回拨会让 `now() - startedAt` 变成负数，循环判定永远为真 ⇒ 无限等待。
  //   交叉验证 LOW 项；`performance.now()` 单调递增，不受墙钟调整影响。
  const now =
    options.now ??
    (typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now());

  const startedAt = now();

  // ★ Task #4576：额外忙碌判据（EventHandler 的通知轮 agent run）。
  //   缺省恒 false ⇒ 行为与 Task #4571 完全一致。
  const extraBusy = options.isExtraBusy ?? (() => false);

  // 没有 manager / 一开始就没有活跃任务 **且没有 extra busy** → 立即返回。
  //
  // ★ Task #4576 关键修正：早期返回也必须看 extraBusy。
  //   否则「query 秒回、后台任务尚未注册进 listTasks()、但 handler 队列已有
  //   事件」这条路径会 0ms 返回，紧跟着 process.exit(0) 把通知轮掐死 ——
  //   正是本参数要消灭的东西。测试 C4 锁死这条。
  // ★ Task #4576（M2）：全清判定的稳定性窗口
  // ★ 交叉验证 N5：`Math.max(0, NaN)` 是 NaN，会让 `now()-clearSince >= NaN`
  //   永远为 false ⇒ 等待必然跑满 timeoutMs。非有限值一律归一为 0。
  const rawSettle = options.settleMs ?? 0;
  const settleMs = Number.isFinite(rawSettle) ? Math.max(0, rawSettle) : 0;

  const initial = probeUnfinishedTasks(manager);
  const initialExtraBusy = safeExtraBusy(extraBusy);
  if (!initial.unfinished && !initialExtraBusy && settleMs === 0) {
    return {
      finished: !initial.queryFailed,
      waitedMs: 0,
      stillRunning: false,
      outcome: initial.queryFailed
        ? "unknown"
        : initial.awaitingUser
          ? "awaiting-user"
          : initial.failed
            ? "failed"
            : initial.settledByProof
              ? "settled"
              : "unknown",
      ...(initial.queryFailed ? { queryFailed: true, error: initial.error } : {}),
      ...(initial.failed ? { failed: true } : {}),
    };
  }

  /**
   * 「当前是否全清」+「何时开始的」。
   *
   * 返回 `clearSince === null` 表示此刻不清（有任务 / handler 忙）。
   */
  const checkClear = (
    currentNow: number,
    clearSince: number | null,
  ): number | null => {
    const p = probeUnfinishedTasks(manager);
    const busy = safeExtraBusy(extraBusy);
    if (p.unfinished || busy) return null;
    return clearSince ?? currentNow;
  };

  let clearSince: number | null = checkClear(now(), null);

  while (now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    const elapsed = now() - startedAt;
    options.onTick?.(elapsed);

    clearSince = checkClear(now(), clearSince);
    if (clearSince !== null && now() - clearSince >= settleMs) {
      const probe = probeUnfinishedTasks(manager);
      // 查询失败也算"停止等待"，但要把 fact 报出去（由调用方提示）
      return {
        finished: !probe.queryFailed,
        waitedMs: elapsed,
        stillRunning: false,
        outcome: probe.queryFailed
          ? "unknown"
          : probe.awaitingUser
            ? "awaiting-user"
            : probe.failed
              ? "failed"
              : probe.settledByProof
                ? "settled"
                : "unknown",
        ...(probe.queryFailed ? { queryFailed: true, error: probe.error } : {}),
        ...(probe.failed ? { failed: true } : {}),
      };
    }
  }

  // ★ 超时收尾也必须用 probe（交叉验证 MEDIUM #2）：
  //   原实现用 `hasUnfinishedTasks()` —— 那是 `catch → false` 的吞异常包装。
  //   若"最后这次探测"恰好抛错，`stillRunning` 会变成 false，
  //   调用方就走进"✅ 已完成"分支 —— **既超时又查询失败，却报成功**。
  const final = probeUnfinishedTasks(manager);
  const finalExtraBusy = safeExtraBusy(extraBusy);
  return {
    finished: false,
    waitedMs: now() - startedAt,
    stillRunning: final.unfinished,
    // ★ 交叉验证 N2：超时收尾也必须保留 awaiting-user 语义。
    //
    //   原实现无条件 `outcome: "timeout"`，于是 chat.ts 的判断链
    //   （unknown → awaiting-user → stillBusyOnly → stillRunning → else）
    //   全部落到 else，打印「✅ 后台任务已完成」——
    //   而任务其实停在等用户输入。L2 的谎只是被从一处挪到了另一处。
    outcome: final.queryFailed
      ? "unknown"
      : final.awaitingUser
        ? "awaiting-user"
        : // ★ MEDIUM-1：失败终态优先于 "timeout"（否则 chat 会当成成功）
          final.failed
          ? "failed"
          : "timeout",
    ...(final.queryFailed ? { queryFailed: true, error: final.error } : {}),
    // ★ Task #4576：只剩 handler 忙 ⇒ 调用方要换说法（不是「任务未结束」）
    //
    //   ⚠️ 交叉验证 L2：`!final.unfinished` 在**任务停在 awaiting-user** 时也为
    //   true（它既不算 unfinished 也不算 completed）。那样 chat.ts 会打印
    //   「后台任务已全部结束」—— 又是撒谎。所以 awaiting-user 时必须排除，
    //   交给上层的 `outcome === "awaiting-user"` 分支说实话。
    //   ★ 交叉验证 NEW-1：`failed` 也必须排除，否则失败事实会被
    //   「已全部结束，但通知 agent 未完成」这句话吞掉（用户永远不知道任务挂了）。
    ...(!final.unfinished && !final.awaitingUser && !final.failed && finalExtraBusy
      ? { stillBusyOnly: true }
      : {}),
    ...(final.failed ? { failed: true } : {}),
  };
}

/**
 * ★ Task #4576：安全调用 `isExtraBusy`。
 *
 * 外部判据（`eventHandler.getQueueLength()`）理论上不该抛，但它跑在**轮询
 * 热路径**里。一次异常把整个等待打断，就等于回到「进程提前退出」的原始 bug。
 * ⇒ 异常一律视为「不忙」（宁可少等，不可抛）。
 */
function safeExtraBusy(isExtraBusy: () => boolean): boolean {
  try {
    return isExtraBusy() === true;
  } catch {
    return false;
  }
}
