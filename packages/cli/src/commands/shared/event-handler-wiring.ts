/**
 * Task #4042 ESPlugin v2 Phase 6: Production wiring helpers
 *
 * 把 EventStore + getHandlerForEsType 接到 interactive.ts / run.ts 的
 * EventHandler 构造上，让 v2 链路在生产路径上生效。
 *
 * 解决的问题：
 *   - Phase 1-5 实现的 EventStore / getHandlerForEsType 参数在 EventHandler 上是
 *     可选的，向后兼容。但 commands/interactive.ts + commands/run.ts 实际创建 EventHandler
 *     时没传这两个参数，所以 v2 链路在生产路径上是 dead path（永远走 fallback
 *     到 replyChannel.chatId，等价于 #4035 chatId 来源问题在生产上没真正生效）。
 *
 * 设计：
 *   - getOrCreateEventStore(dbPath)：进程内单例，同 dbPath 复用同一 EventStore
 *     实例（多事件源共享同一个 db 时不会重复打开 + 重复初始化）
 *   - getHandlerForEsTypeForEnv(env)：从 env.getComponent("event-source") 取
 *     handler，封装 try/catch + 兼容性检查（组件不存在/没 getHandler 方法时
 *     安全返回 undefined，不抛错）
 *   - createDefaultEventStoreDbPath()：默认 ~/.roy-bot/event-store.db
 *     （与 ConfigComponent / EventSourceComponent 用同一目录）
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  type BaseEnvironment,
  type EventSourceHandler,
  EventStoreImpl,
  type EventStore,
  setSharedEventStore,
} from "@ai-setting/roy-bot-core";
// ★ Task #5360（补充需求）：状态通知开关解析（per-ES statusNotifications）
import {
  inferChannelFromEvent,
  resolveStatusNotificationsFromEvent,
} from "./status-notifications";
import {
  LarkCardPatchNotifier,
  getSharedLarkCardNotifier,
  type SessionCardTaskPayload,
} from "@ai-setting/roy-bot-core/env/task/plugins/lark-card-patch-notifier";
// ★ Task #5360：企微 session 卡（用户明令「企微也是这个逻辑」）
import { createWecomSessionCardSender } from "@ai-setting/roy-bot-core/env/event-source/wecom-session-card-sender";
import { sendWecomTemplateCard } from "@ai-setting/roy-bot-core/env/event-source/wecom-respond-registry";
// ★ Task #5364（B 方案）：session 卡持久层 —— 生命周期事件只写它、刷新时读它
import {
  getSharedWecomSessionCardStore,
  __resetSharedWecomSessionCardStoreForTest,
  type WecomSessionCardStore,
} from "@ai-setting/roy-bot-core/env/task/plugins/wecom-session-card-store";
import { EventHandler, type EventHandlerOptions } from "./event-handler";
// ★ Task #5459：自身 bot 身份解析（self-echo 门禁的 selfBotIds 来源）
import { getCachedSelfBotIds, warmSelfBotIdentities } from "./self-bot-identity";

// ============================================================================
// EventStore 单例
// ============================================================================

/**
 * 进程内 EventStore 单例缓存。
 *
 * key = dbPath（绝对路径归一化），value = EventStore 实例。
 *
 * 为什么用单例：
 *   - 同一进程可能有多个事件源 / 多个 EventHandler 引用同一 db
 *   - EventStore 内部持有 sqlite 连接 + prepared statements
 *   - 重复 new 会重复打开 db + 重复 prepare，浪费资源 + 增加 fd 占用
 */
const storeCache: Map<string, EventStore> = new Map();

/**
 * 获取或创建 EventStore 单例。
 *
 * 行为：
 *   - 相同 dbPath（大小写敏感） → 返回同一实例
 *   - 不同 dbPath → 各自独立实例
 *   - 父目录不存在时自动创建（与 EventSourceComponent 配置一致）
 *
 * @param dbPath  SQLite 数据库绝对路径
 */
export function getOrCreateEventStore(dbPath: string): EventStore {
  const normalized = normalizeDbPath(dbPath);
  let store = storeCache.get(normalized);
  if (store) return store;

  // 确保父目录存在
  ensureParentDir(normalized);

  store = new EventStoreImpl({ dbPath: normalized });
  storeCache.set(normalized, store);
  // ★ Task #4042 ESPlugin v2 P0: 注册到 core 级共享单例，让同进程的
  // delegate_task tool（在 core 层）也能用同一个 EventStore 校验 triggerEventId。
  setSharedEventStore(store);
  return store;
}

/**
 * 清空单例缓存（仅用于测试）。
 *
 * 注意：清空后旧实例的 close() 由调用方负责（这里不强行 close，
 * 避免影响尚在运行的 EventHandler）。生产代码不应调用。
 */
export function resetEventStoreCacheForTest(): void {
  storeCache.clear();
  // ★ 同时清空 core 级共享单例，避免测试间串味。
  setSharedEventStore(null);
}

/**
 * 路径归一化：去掉尾部斜杠 + 解析 .. 等。
 * 用 realpathSyncSync 不行（文件可能不存在），改用简单 normalize。
 */
function normalizeDbPath(dbPath: string): string {
  // 处理 ~ 展开
  const expanded = dbPath.startsWith("~")
    ? join(homedir(), dbPath.slice(1).replace(/^\//, ""))
    : dbPath;
  return expanded;
}

function ensureParentDir(dbPath: string): void {
  const parent = join(dbPath, "..");
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

// ============================================================================
// getHandlerForEsTypeForEnv
// ============================================================================

/**
 * 从 env 构造 getHandlerForEsType 回调。
 *
 * 行为：
 *   - env.getComponent("event-source") 存在 + 有 getHandler 方法 → 直接代理
 *   - 组件不存在 / 没 getHandler / getComponent 抛错 → 返回的 getter 永远返回 undefined
 *     （不抛错，让 EventHandler 走老 formatter 路径）
 *
 * 这是 EventHandler.getHandlerForEsType 的标准实现。
 */
export function getHandlerForEsTypeForEnv(
  env: BaseEnvironment,
): (esType: string) => EventSourceHandler | undefined {
  let component: unknown = null;
  try {
    component = env.getComponent?.("event-source") ?? null;
  } catch {
    // getComponent 抛错：视为无组件
    component = null;
  }

  const hasGetHandler =
    component !== null &&
    component !== undefined &&
    typeof (component as { getHandler?: unknown }).getHandler === "function";

  return (esType: string): EventSourceHandler | undefined => {
    if (!hasGetHandler) return undefined;
    try {
      const h = (component as { getHandler: (t: string) => EventSourceHandler | undefined })
        .getHandler(esType);
      return h ?? undefined;
    } catch {
      return undefined;
    }
  };
}

// ============================================================================
// 默认 dbPath
// ============================================================================

/**
 * 返回默认 EventStore db 路径：~/.roy-bot/event-store.db
 *
 * 与 EventSourceComponent 的 configPath（~/.roy-bot/event-sources.json）
 * 共享同一目录，便于运维定位。
 */
export function createDefaultEventStoreDbPath(): string {
  return join(homedir(), ".roy-bot", "event-store.db");
}

// ============================================================================
// createEventHandlerForInteractive — production wiring factory
// ============================================================================

/**
 * production wiring factory 的入参。
 *
 * 与 EventHandlerOptions 完全兼容 + 多了 dbPath（默认 ~/.roy-bot/event-store.db）。
 * dbPath 可选：测试场景用 tmpDir 路径，生产场景不传走默认。
 */
export interface CreateEventHandlerForInteractiveOptions
  extends Omit<EventHandlerOptions, "eventStore" | "getHandlerForEsType"> {
  /**
   * EventStore db 路径。
   * 不传：用 createDefaultEventStoreDbPath()（~/.roy-bot/event-store.db）。
   * 测试场景：用 mkdtempSync 创建的 tmpDir 路径，避免污染真实配置。
   */
  dbPath?: string;
}

/**
 * 创建 production EventHandler（带 v2 wiring）。
 *
 * 行为：
 *   - 自动注入 eventStore = getOrCreateEventStore(dbPath ?? default)
 *   - 自动注入 getHandlerForEsType = getHandlerForEsTypeForEnv(env)
 *   - 不接受调用方传 eventStore / getHandlerForEsType（防 drift）
 *
 * 这是 commands/interactive.ts + commands/run.ts 应该调用的工厂函数。
 * 直接 new EventHandler({...}) 缺这两个参数 → v2 path 永远走不到 = #4035
 * bug 等价问题在生产路径上没真正生效。
 */
export function createEventHandlerForInteractive(
  options: CreateEventHandlerForInteractiveOptions,
): EventHandler {
  const dbPath = options.dbPath ?? createDefaultEventStoreDbPath();
  const eventStore = getOrCreateEventStore(dbPath);
  const getHandlerForEsType = getHandlerForEsTypeForEnv(options.env);

  // ★ Task #4515 (M4): 解析 maxConcurrentSessions 的环境通路。
  //
  //   背景：设计文档 §3/§4 一直宣称「运行时软回滚：maxConcurrentSessions: 1」，
  //   但该参数此前**零调用方**（既没 CLI flag 也没 config/env）→ 软回滚物理上
  //   不可执行。这里补 env 通路；放在 factory 而不是各调用点，commands/interactive.ts
  //   与 commands/run.ts 两条生产路径自动生效，不会漏接。
  //
  //   优先级：显式传参 > env > EventHandler 默认值（代码 > 环境）。
  const maxConcurrentSessions =
    options.maxConcurrentSessions ?? readMaxConcurrentSessionsFromEnv();

  // ★ Task #5360（补充需求）：状态通知开关解析器（per-ES `statusNotifications`）。
  //
  // ## 为什么在这里接（而不是各调用点）
  //
  // 与 #4515 / #4035 / #5036 同一接线纪律：**只改 factory**，
  // `run.ts`（daemon）/ `interactive.ts` / `chat-event-handler.ts` 三条生产
  // 路径自动生效，不会漏接一个就整条链路失效。
  //
  // ## 为什么读 `list()` 而不是缓存
  //
  // 每次事件都读一遍 ES 配置列表：`list()` 是内存数组（`EventSourceComponent.sources`），
  // 零 IO；且用户可能中途改 `event-sources.json` —— 读最新的才对"之后派生的任务"
  // 生效（已经派生出去的任务走 replyChannel 快照，不受影响，这正是快照优先的意义）。
  //
  // ⚠️ 不覆盖调用方显式传入的同名端口（测试注入口优先）。
  const resolveStatusNotifications =
    options.resolveStatusNotifications ??
    ((event) => {
      // 懒取 ES 配置列表：env 不可用 / 组件未注册时退化为空数组 ⇒ 解析为 false
      let sources: Array<{ id: string; type: string; statusNotifications?: unknown }> = [];
      try {
        const es = (options.env as { getComponent?: (n: string) => unknown } | undefined)
          ?.getComponent?.("event-source") as
          | { list?: () => Array<{ id: string; type: string; statusNotifications?: unknown }> }
          | undefined;
        sources = es?.list?.() ?? [];
      } catch {
        sources = [];
      }
      return resolveStatusNotificationsFromEvent(
        event,
        sources,
        inferChannelFromEvent(event),
      );
    });

  // ★ CV R3 BLOCKER-2：把 sub-session 生命周期事件接到卡片层（**真接线**）。
  //
  // 上一版只有 EventHandler 的端口定义、没有装配点 ⇒ 无 task 的 session
  // 端到端仍然没有卡（reviewer 判定 B2「NOT FIXED end-to-end」，成立）。
  //
  // 实现策略：
  // - 复用插件已实例化并共享的 `LarkCardPatchNotifier`（同一进程内同一实例，
  //   sessionStates 才连续 —— 否则每次刷新都 fallback 重建）
  // - 找不到共享 notifier ⇒ 退化为新建一个（卡片仍会发，只是拿不到累计状态）
  const sessionCardSender =
    options.sessionCardSender ??
    (async (event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const sessionId =
        typeof payload.subSessionId === "string" ? payload.subSessionId : undefined;
      if (!sessionId) return;

      const rc = (event.metadata as Record<string, unknown> | undefined)
        ?.replyChannel as
        | { type?: string; chatId?: string; profile?: string }
        | undefined;

      // ★ CV R4 BLOCKER 修复：**渠道判定**。
      //
      // session 卡是 `lark-cli im +messages-send --msg-type interactive` 发的。
      // 若企微来源的 sub-session 也用这条路径，就是拿企微 userid 当飞书
      // chatId 发卡 —— 要么报错、要么发到错误的地方。
      // 所以只处理**能确认是飞书**的事件；企微侧的 session 卡由企微自己的
      // 卡片链路负责（`inferChannelFromEvent` 已有同一套判定逻辑）。
      const channel = inferChannelFromEvent(event);
      // ★ Task #5360：企微走**自己的** session 卡 sender（用户明令「企微也是这个逻辑」）。
      //   飞书 = lark-cli 子进程发 interactive 卡；企微 = WS aibot_send_msg 帧。
      //   按渠道分流，顺带杜绝「企微 userid 当飞书 chatId 发」的错渠道问题。
      if (channel === "wecom-cli") {
        await getWecomSessionCardSender()(event);
        return;
      }

      if (channel !== "lark-cli") return;

      // ★ Task #5580（续）：`emitSessionCard` 开关 —— 与 task 卡的
      //   `emitTaskCard`（LarkCliTaskNotifyPlugin 配置）对称。
      //
      //   配置位置：`handleRule.pluginConfig.LarkCliTaskNotifyPlugin.emitSessionCard`
      //   （与 emitTaskCard 同一处，用户一个地方管两张卡）。
      //
      //   读取方式：按 `metadata.sourceId` 命中 ES 配置（与
      //   `pickStatusNotificationsFromSources` 同一套命中语义）；
      //   未命中 sourceId / 配置缺失 / 值不是严格 false ⇒ 默认发卡。
      //
      //   语义矩阵：
      //     emitTaskCard=true,  emitSessionCard=true  → 两卡并存（默认）
      //     emitTaskCard=true,  emitSessionCard=false → 只发任务卡
      //     emitTaskCard=false, emitSessionCard=true  → 只发 session 卡
      //     emitTaskCard=false, emitSessionCard=false → 都不发
      const emitSessionCard = resolveEmitSessionCard(options.env, event);
      if (emitSessionCard === false) {
        // 静默跳过（不发卡就是可观察结果；wiring 无 logger 依赖）
        return;
      }

      const chatId = rc?.chatId;
      if (!chatId) return; // 没有投递目标 ⇒ 丢弃（不回 agent lane）

      // ★ Task #5364 返工：单例**必存在**，不再 `?? new`（那正是发多卡的根因）
      const notifier = getSharedCardNotifier(options.env) ?? getSharedLarkCardNotifier();

      const lifecycleRaw = payload.lifecycle;
      const lifecycle =
        lifecycleRaw === "completed" ||
        lifecycleRaw === "timeout" ||
        lifecycleRaw === "failed" ||
        lifecycleRaw === "stopped" ||
        lifecycleRaw === "running"
          ? lifecycleRaw
          : "running";

      const description =
        typeof payload.description === "string" ? payload.description : undefined;

      // ★ Task #5364 返工（BLOCKER-5）：把该 session 里的 task 一并渲染进
      //   **同一张** session 卡（用户 08:13「合并，不是并列」）。
      //
      // task 来源（两条都试，任一命中即可）：
      // 1. 事件 payload 的 `associatedTaskId`（delegate 时刻写入）
      // 2. task_operation 表按 sessionId 反查（子会话自己 task_create 时写过）
      const taskIdFromPayload =
        typeof payload.associatedTaskId === "number" &&
        payload.associatedTaskId > 0
          ? payload.associatedTaskId
          : undefined;
      const taskInfo = await loadTaskForSessionCard(
        options.env,
        taskIdFromPayload,
        sessionId,
      );

      // ★ Task #5397：**本会话已有群** ⇒ 首卡就渲染「进入专属群」+「解散该群」。
      //
      //   改造前 session 卡根本没有群的概念（按钮都不渲染），所以这一路缺失
      //   没人发现。现在无 task 也能建群 ⇒ 首卡必须知道"这个会话有群了没"，
      //   否则用户重启后看到的是「为本会话建群」（与实际不符，且点下去会走进
      //   幂等保护直接返回已有群 —— 卡片状态长期错位）。
      // ⚠️ CV 5397 M1：**只在没有 task 时**用会话反查（metadata.linkedFromSessionId）的群。
      //   task 路径的群真源是 `task.context.larkPerTaskChatId`（由
      //   `patchSessionCardForTask` 写进 state）。两边都传会形成双真相源 ——
      //   一旦不一致（task 建过一个群、session 又被 session-only 建过另一个），
      //   卡片会显示错的那个，点「解散」还散错群。所以 task 存在时交给 task 路径。
      const groupChatId = pickGroupChatIdForSessionCard({
        hasTask: taskInfo !== undefined,
        fromAlias: await loadGroupChatForSessionCard(options.env, sessionId),
      });

      // ★ Task #5580：「🗂️ 任务列表」—— 该 session 关联的全部 task（最近优先）。
      //   best-effort：读不到 ⇒ 不渲染面板（绝不影响发卡）。
      const sessionTasks = await loadSessionTasksForCard(options.env, sessionId);

      // ★ CV R4：**upsert** 而不是每次 start —— 否则一个 session 会产出
      //   「启动卡 + 完成卡」两张，且每张都被 pin（置顶堆积），
      //   而「一张卡承载整个生命周期」才是用户要的语义。
      await notifier.upsertSessionCard({
        chatId,
        ...(rc?.profile ? { profile: rc.profile } : {}),
        sessionId,
        ...(description ? { title: description } : {}),
        ...(typeof payload.subagentType === "string"
          ? { agentType: payload.subagentType }
          : {}),
        lifecycle,
        ...(taskInfo ? { task: taskInfo } : {}),
        // ★ Task #5580：首卡就带任务列表（否则用户要先点刷新才看得到）
        ...(sessionTasks.length > 0 ? { tasks: sessionTasks } : {}),
        ...(groupChatId ? { perTaskChatId: groupChatId } : {}),
        milestones: [
          {
            title:
              lifecycle === "running"
                ? "子会话启动"
                : `子会话${lifecycle === "completed" ? "完成" : lifecycle === "timeout" ? "超时" : lifecycle === "stopped" ? "停止" : "失败"}`,
            timestamp: new Date().toISOString(),
          },
        ],
      });

      // ★ Task #5417：**双写** —— 原 session 进展同步到关联群 session 的卡。
      //   方案 A：新群有自己的卡（sessionId=chatId）；这里把同一条
      //   生命周期进展再 upsert 到群卡上（无群 / 反查失败 ⇒ no-op）。
      //   best-effort：syncGroupCardFromOrigin 内部已吞错，这里不 try。
      {
        const groupChat = await loadGroupChatForSessionCard(options.env, sessionId);
        if (groupChat) {
          await notifier.syncGroupCardFromOrigin(
            sessionId,
            {
              lifecycle,
              ...(description ? { title: description } : {}),
              milestones: [
                {
                  title:
                    lifecycle === "running"
                      ? "子会话启动"
                      : `子会话${lifecycle === "completed" ? "完成" : lifecycle === "timeout" ? "超时" : lifecycle === "stopped" ? "停止" : "失败"}`,
                  timestamp: new Date().toISOString(),
                },
              ],
            },
            // ★ CV 5417 MINOR-1：保持 API 契约 —— 回调自己按 sid 反查
            async (sid) => {
              const c = await loadGroupChatForSessionCard(options.env, sid);
              return c ? { chatId: c } : undefined;
            },
          );
        }
      }
    });

  // ★ Task #5459：self-echo 门禁的自身身份解析器（按 profile）。
  //
  // ## 为什么必须在 factory 接
  //
  // `isSelfEchoEvent` 的「第 0 步 = senderId ∈ selfBotIds → 丢弃」是群聊
  // 放行后的**自循环闸门**（没有它，A/B 两个 bot 会无限互相回灌）。
  // 但生产 wiring 历史上从未注入 selfBotIds（恒 []）⇒ 闸门失效。
  // 与 #4035 / #4515 / #5036 / #5360 同一接线纪律：**只改 factory**，
  // run.ts（daemon）/ interactive.ts / chat-event-handler.ts 三条生产路径
  // 自动生效。
  //
  // 覆盖调用方显式传入的 resolver（测试注入口优先）。
  // 热路径：**同步**读缓存（本地 config 的 appId + 已预热的 bot open_id）。
  // 绝不在这里 spawn lark-cli —— 门禁每条事件都跑，不能有 ~1s 的网络等待。
  const resolveSelfBotIds =
    options.selfEchoFilter?.resolveSelfBotIds ??
    ((profile: string | undefined) => getCachedSelfBotIds(profile));

  // 预热：首次见到某 profile 时后台补 `bot open_id`（幂等、fire-and-forget）。
  const warmSelfBotIds =
    options.selfEchoFilter?.warmSelfBotIds ??
    ((profile: string | undefined) => {
      void warmSelfBotIdentities(profile);
    });

  return new EventHandler({
    ...options,
    ...(maxConcurrentSessions !== undefined ? { maxConcurrentSessions } : {}),
    resolveStatusNotifications,
    sessionCardSender,
    eventStore,
    getHandlerForEsType,
    selfEchoFilter: {
      ...options.selfEchoFilter,
      resolveSelfBotIds,
      warmSelfBotIds,
    },
  });
}

/** 环境变量名：同时并行处理的 session 上限（= 文档里的软回滚开关） */
export const MAX_CONCURRENT_SESSIONS_ENV = "ROY_AGENT_MAX_CONCURRENT_SESSIONS";

/**
 * ★ Task #4515 (M4): 从环境变量读取 `maxConcurrentSessions`。
 *
 * 语义：
 *   - 未设置 / 空串 / 非数字 / < 1  → undefined（交给 EventHandler 用默认值 4）
 *   - 合法正数（含小数）→ 向下取整，且至少为 1
 *
 * 为什么不在这里直接兜底成 4：把"默认值"的定义留在 EventHandler 一处，
 * 避免两个地方各写一个默认值后 drift。
 */
export function readMaxConcurrentSessionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env[MAX_CONCURRENT_SESSIONS_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;

  return Math.max(1, Math.floor(parsed));
}

/**
 * ★ CV R3：取插件共享的 `LarkCardPatchNotifier`（找不到 → undefined）。
 *
 * 为什么必须共享同一实例：`sessionStates` 存在 notifier 实例里；每次 new
 * ⇒ 刷新永远 fallback 重建 ⇒ 丢 title/agent/startedAt 且 updateCount 停在 1。
 */
function getSharedCardNotifier(env: unknown): LarkCardPatchNotifier | undefined {
  // ★ Task #5364 返工（BLOCKER-4 的**真正**根因修复）。
  //
  // ## 上一版为什么永远返回 undefined
  //
  // 它去 `env.getPluginInstance()` / `env._pluginInstances` 借插件的 notifier，
  // 但生产 `Environment` **根本没有这两个属性**（全仓 grep 只有本文件一处引用，
  // 从无注入方）⇒ 每次都落调用点的 `?? new LarkCardPatchNotifier()`。
  //
  // 后果（真机取证 om_x100b60647b4948a0cffa204045ecc22 等 3 张卡）：
  // `sessionCardIds` / `sessionStates` 是**实例**字段，实例每事件重建 ⇒ 恒空
  // ⇒ `upsertSessionCard` 恒走 `startSessionCard` ⇒ **一个 session 发 3 张卡**。
  //
  // ## 现在
  //
  // 直接取**进程单例**（与 `LarkCliTaskNotifyHook` 默认构造的那个是同一个对象），
  // 不再依赖任何"借"的约定。`env` 参数保留是为了签名兼容与将来注入扩展。
  void env;
  return getSharedLarkCardNotifier();
}

/**
 * ★ Task #5364 返工（BLOCKER-5）：按 session 取要渲染进 session 卡的 task 信息。
 *
 * ## 为什么需要（用户 08:13 定稿）
 *
 * 「若该会话有任务相关信息 → 把原任务卡的信息渲染在这张子会话卡上」。
 * 上一版这里什么都不传 ⇒ 首卡只有会话信息，task 卡链路照旧独立发一张 ⇒ 两张并列。
 *
 * ## 数据来源（都失败 → undefined，卡片仍发）
 *
 * 1. `associatedTaskId`（事件 payload，delegate 时刻写入，最准）
 * 2. `task_operation.session_id` 反查（子会话自己 task_create 时写过）
 *
 * ⚠️ 只读：不 updateTask、不改 context（刷新/发卡都不该有副作用）。
 */
/**
 * ★ Task #5580 —— 读该 session 的**全部 task**（最近优先，供「🗂️ 任务列表」面板）。
 *
 * 与 `loadTaskForSessionCard` 的区别：那个取「当前关注的那一个 task」的完整
 * 详情（含 goals/时间线），本函数取「这个会话干过哪些任务」的**轻量索引**
 * （id / 标题 / 状态 / 进度），用于列表渲染与切换按钮。
 *
 * 数据源：`taskComponent.getTaskIdsBySessionId(sessionId)`（按
 * task_operation.session_id 反查）+ 逐个 `getTask`。
 *
 * 任何失败 ⇒ 返回 []（面板不渲染），绝不阻断发卡。
 */
/**
 * ★ Task #5580（续）—— 读 `emitSessionCard` 开关。
 *
 * ## 配置位置
 *
 * 与 `emitTaskCard` 同一处：
 * `handleRule.pluginConfig.LarkCliTaskNotifyPlugin.emitSessionCard`。
 *
 * ## 命中语义（与 `pickStatusNotificationsFromEvents` 一致）
 *
 * 1. `metadata.sourceId` 命中某个 ES 源 ⇒ 用该源的值
 *    （**命中即返回**，显式配置永远优先）
 * 2. 未命中 sourceId ⇒ 找"lark-cli 渠道恰好 1 个源"时用它的值
 * 3. 多源 / 零源 / 值不是严格 `false` ⇒ 默认发卡（undefined ≠ false）
 *
 * ## 为什么默认 true
 *
 * 与 `emitTaskCard` 对称：开关是**回滚阀**，不是灰度开关 ——
 * 不配置 = 现状（发卡），显式 `false` 才关。
 */
function resolveEmitSessionCard(
  env: unknown,
  event: { metadata?: unknown },
): boolean | undefined {
  try {
    const es = (env as { getComponent?: (n: string) => unknown })
      ?.getComponent?.("event-source") as
      | {
          list?: () => Array<{
            id: string;
            type: string;
            handleRule?: {
              pluginConfig?: Record<
                string,
                Record<string, unknown> | undefined
              >;
            };
          }>;
        }
      | undefined;
    const sources = es?.list?.() ?? [];
    if (sources.length === 0) return undefined;

    const readValue = (src: {
      handleRule?: { pluginConfig?: Record<string, Record<string, unknown> | undefined> };
    }): boolean | undefined => {
      const v = src.handleRule?.pluginConfig?.["LarkCliTaskNotifyPlugin"]
        ?.emitSessionCard;
      return v === undefined ? undefined : v === false ? false : undefined;
    };

    const metadata = (event?.metadata ?? {}) as Record<string, unknown>;
    const sourceId =
      typeof metadata.sourceId === "string" ? metadata.sourceId : undefined;
    if (sourceId) {
      const hit = sources.find((src) => src?.id === sourceId);
      if (hit) return readValue(hit);
    }

    // 单源推断：lark-cli 渠道恰好 1 个源
    const larkSources = sources.filter((src) => src?.type === "lark-cli");
    if (larkSources.length === 1) return readValue(larkSources[0]);

    return undefined;
  } catch {
    return undefined;
  }
}

async function loadSessionTasksForCard(
  env: unknown,
  sessionId: string,
): Promise<
  Array<{ id: number; title?: string; status?: string; progress?: number }>
> {
  try {
    const taskComponent = (env as { getComponent?: (n: string) => unknown })
      ?.getComponent?.("task") as
      | {
          getTask?: (id: number) => Promise<unknown> | unknown;
          getTaskIdsBySessionId?: (sid: string) => Promise<number[]>;
        }
      | undefined;
    if (!taskComponent?.getTask || !taskComponent.getTaskIdsBySessionId) return [];
    const ids = await taskComponent.getTaskIdsBySessionId(sessionId);
    if (!Array.isArray(ids) || ids.length === 0) return [];

    const items: Array<{
      id: number;
      title?: string;
      status?: string;
      progress?: number;
      _ts: number;
    }> = [];
    const toTs = (v: unknown): number => {
      if (typeof v !== "string") return 0;
      const n = Date.parse(v);
      return Number.isFinite(n) ? n : 0;
    };
    for (const id of ids) {
      try {
        const raw = (await taskComponent.getTask(id)) as
          | {
              id?: number;
              title?: string;
              status?: string;
              progress?: number;
              updated_at?: string;
              updatedAt?: string;
            }
          | undefined;
        if (!raw || typeof raw.id !== "number") continue;
        items.push({
          id: raw.id,
          ...(raw.title ? { title: raw.title } : {}),
          ...(raw.status ? { status: String(raw.status) } : {}),
          ...(typeof raw.progress === "number" ? { progress: raw.progress } : {}),
          _ts: toTs(raw.updated_at ?? raw.updatedAt),
        });
      } catch {
        /* 单个 task 读失败 → 跳过 */
      }
    }
    // **最近优先**：updatedAt 降序，同值 id 降序（新任务 id 更大）
    items.sort((a, b) => b._ts - a._ts || b.id - a.id);
    return items.map(({ _ts: _ignored, ...rest }) => rest);
  } catch {
    return [];
  }
}

async function loadTaskForSessionCard(
  env: unknown,
  taskIdFromPayload: number | undefined,
  sessionId: string,
): Promise<SessionCardTaskPayload | undefined> {
  try {
    const taskComponent = (env as { getComponent?: (n: string) => unknown })
      ?.getComponent?.("task") as
      | {
          getTask?: (id: number) => Promise<unknown> | unknown;
          getTaskIdBySessionId?: (sid: string) => Promise<number | undefined>;
          listOperations?: (opts: {
            taskId: number;
            limit?: number;
          }) => Promise<unknown[] | undefined>;
        }
      | undefined;
    if (!taskComponent?.getTask) return undefined;

    let taskId = taskIdFromPayload;
    if (taskId === undefined) {
      try {
        taskId = await taskComponent.getTaskIdBySessionId?.(sessionId);
      } catch {
        taskId = undefined;
      }
    }
    if (taskId === undefined) return undefined;

    const raw = (await taskComponent.getTask(taskId)) as
      | {
          id?: number;
          title?: string;
          status?: string;
          progress?: number;
          current_status?: string;
          priority?: string;
          goals_and_expected_deliverables?: string;
          goals?: string;
          parent_task_id?: number | null;
          created_at?: string;
          createdAt?: string;
          updated_at?: string;
          updatedAt?: string;
        }
      | undefined;
    if (!raw) return undefined;

    // 操作记录（时间线）—— 用户明令「操作记录等原有信息一个不少」
    let milestones:
      | Array<{ title: string; timestamp: string; description?: string }>
      | undefined;
    try {
      const ops = await taskComponent.listOperations?.({ taskId, limit: 20 });
      if (Array.isArray(ops) && ops.length > 0) {
        milestones = ops
          .map((op) => {
            const o = op as {
              milestoneTitle?: string;
              actionTitle?: string;
              milestoneDescription?: string;
              actionDescription?: string;
              timestamp?: string;
            };
            const title = o.milestoneTitle ?? o.actionTitle;
            if (!title) return undefined;
            return {
              title,
              timestamp: o.timestamp ?? new Date().toISOString(),
              ...(o.milestoneDescription ?? o.actionDescription
                ? { description: o.milestoneDescription ?? o.actionDescription }
                : {}),
            };
          })
          .filter((m): m is { title: string; timestamp: string; description?: string } =>
            m !== undefined,
          )
          .slice(-10);
        if (milestones.length === 0) milestones = undefined;
      }
    } catch {
      milestones = undefined;
    }

    return {
      id: typeof raw.id === "number" ? raw.id : taskId,
      ...(raw.title ? { title: raw.title } : {}),
      ...(raw.status ? { status: raw.status } : {}),
      ...(typeof raw.progress === "number" ? { progress: raw.progress } : {}),
      ...(raw.current_status ? { currentStatus: raw.current_status } : {}),
      ...(raw.priority ? { priority: raw.priority } : {}),
      ...(typeof raw.parent_task_id === "number" && raw.parent_task_id > 0
        ? { parentTaskId: raw.parent_task_id }
        : {}),
      ...(raw.goals_and_expected_deliverables || raw.goals
        ? { goals: raw.goals_and_expected_deliverables ?? raw.goals }
        : {}),
      ...(raw.created_at || raw.createdAt
        ? { createdAt: raw.created_at ?? raw.createdAt }
        : {}),
      ...(raw.updated_at || raw.updatedAt
        ? { updatedAt: raw.updated_at ?? raw.updatedAt }
        : {}),
      ...(milestones ? { milestones } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * ★ Task #5397（CV 5397 M1）—— session 卡首渲时「群 chatId」的**唯一**取值裁决。
 *
 * 为什么必须"裁决"而不是"都传"：
 *
 * | 情形 | 群的**真源** | 传入会话反查的结果会怎样 |
 * |---|---|---|
 * | 有 task | `task.context.larkPerTaskChatId`（task 路径写进 state） | 若有另一个 session-only 群 ⇒ 卡片显示错群、点「解散」散错群 |
 * | 无 task | 会话反查 `metadata.linkedFromSessionId`（Task #5403） | 没有别的来源，必须用 |
 *
 * 所以：**有 task 时一律交给 task 路径**（返回 undefined），无 task 才用
 * 会话反查。这样两个真相源永不打架。
 */
export function pickGroupChatIdForSessionCard(opts: {
  hasTask: boolean;
  fromAlias?: string;
}): string | undefined {
  if (opts.hasTask) return undefined;
  const chatId = opts.fromAlias?.trim();
  return chatId ? chatId : undefined;
}

/**
 * ★ Task #5397：读「本会话的群」（session 卡首渲用）。
 *
 * 数据源：`SessionComponent.findGroupChatForSession(sessionId)` —— 走
 * metadata `linkedFromSessionId` 反查（Task #5403，JSON1 抽取，零 schema 变更；
 * 已废弃的 `linked_to` 列不再参与）。
 *
 * 读不到（端口缺失 / 抛错 / 没有群）⇒ undefined ⇒ 卡片渲染「为本会话建群」
 * （这是正确形态）。**绝不**因为读群失败而让整个发卡流程失败。
 */
async function loadGroupChatForSessionCard(
  env: unknown,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const sessionComponent = (env as { getComponent?: (n: string) => unknown })
      ?.getComponent?.("session") as
      | {
          findGroupChatForSession?: (
            sid: string,
          ) => Promise<{ chatId: string; aliasSessionId?: string } | undefined>;
        }
      | undefined;
    if (typeof sessionComponent?.findGroupChatForSession !== "function") return undefined;
    const r = await sessionComponent.findGroupChatForSession(sessionId);
    const chatId = r?.chatId;
    return typeof chatId === "string" && chatId.trim() ? chatId.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ★ Task #5360：企微 session 卡 sender 单例（用户明令「企微也是这个逻辑」）。
 *
 * `sendCard` 直接调**生产**发送函数 `sendWecomTemplateCard`（WS aibot_send_msg
 * 直发 template_card）—— 这就是真接线，不是 mock。
 *
 * 为什么单例：sender 无状态，但避免每条事件重复构造闭包。
 */
let wecomSessionCardSenderSingleton: ((event: any) => Promise<void>) | null = null;

/**
 * ★ Task #5364（B 方案）：session 卡持久层**进程内单例**。
 *
 * 为什么必须单例：
 * - sender 需要 `get(sessionId)` 判断「是否已发过卡」⇒ 只有一张卡
 * - 刷新链路（`WecomCliInstance.loadSessionCardState`）需要读**同一个** store
 *   才能看到 sender 写进去的最新生命周期
 *
 * 两个不同实例 = 刷新永远读到空 ⇒ 卡片永远停在「运行中」。
 */
let wecomSessionCardStoreSingleton: WecomSessionCardStore | null = null;

/** 取（并在首次调用时创建）session 卡持久层单例。 */
export function getWecomSessionCardStore(): WecomSessionCardStore {
  if (!wecomSessionCardStoreSingleton) {
    // ★ 必须用 core 侧共享单例：企微刷新端口（wecom-cli-handler）也读它。
    //   两处各建一个实例 = sender 写 A、刷新读 B ⇒ 卡片永远「运行中」。
    wecomSessionCardStoreSingleton = getSharedWecomSessionCardStore();
  }
  return wecomSessionCardStoreSingleton;
}

function getWecomSessionCardSender(): (event: any) => Promise<void> {
  if (!wecomSessionCardSenderSingleton) {
    wecomSessionCardSenderSingleton = createWecomSessionCardSender({
      // ★ Task #5364：注入持久层 ⇒ 后续 lifecycle 只落库、不发卡
      store: getWecomSessionCardStore(),
      sendCard: async (input) => {
        const r = await sendWecomTemplateCard({
          sourceId: input.sourceId,
          chatId: input.chatId,
          chatType: input.chatType,
          card: input.card,
        });
        return { ok: r.ok, ...(r.ok ? {} : { error: r.error }) };
      },
    });
  }
  return wecomSessionCardSenderSingleton;
}

/**
 * 测试钩子：重置企微 sender 单例（避免跨用例串状态）。
 *
 * ★ Task #5364：**必须连 store 一起重置**。
 *
 * B 方案下 sender 的「是否已发过卡」判定完全依赖 store。只重置 sender
 * 而留着 store ⇒ 下一个用例的 first lifecycle 事件会看到「已有记录」而被
 * 正确判定为「不重发」—— 但对该用例来说它期望的是首发卡，于是测试变成
 * 「跨用例串状态」的假红。
 *
 * 这不是测试妥协：生产里 sender 与 store 本来就是同一生命周期（进程级
 * 单例），重置 sender 而不重置 store 反而是不一致的状态。
 */
export function __resetWecomSessionCardSenderForTest(): void {
  wecomSessionCardSenderSingleton = null;
  __resetSharedWecomSessionCardStoreForTest();
  wecomSessionCardStoreSingleton = null;
}

/**
 * 测试钩子：重置企微 session 卡持久层单例。
 *
 * ★ 必须与 sender 一起重置 —— 否则第二个用例会拿到上一个用例的 store，
 *   看到「已有记录」⇒ 一张卡都不发（测试假红/假绿）。
 */
export function __resetWecomSessionCardStoreForTest(): void {
  __resetSharedWecomSessionCardStoreForTest();
  wecomSessionCardStoreSingleton = null;
  wecomSessionCardSenderSingleton = null;
}
