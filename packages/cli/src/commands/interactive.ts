/**
 * @fileoverview Interactive Command — `roy-bot interactive` 的 opentui/Solid TUI。
 *
 * Task #2610 stage 4: implements the `interactive` subcommand as a yargs
 * CommandModule.
 *
 * Task #4278: TUI 从 Ink 迁到 **opentui/Solid**（`@opentui/core` +
 * `@opentui/solid`），入口见下方 `mountInteractiveScreen`。
 *
 * Task #2728: upgraded to support **streaming output** (streamHandleQuery)
 * and **full argument parity** with the `run` command:
 *   --session / --continue / --reasoning / --tool-calls / --tool-results
 *   --event-source (alias --es) / --agent (alias -a) / --default-agent-name (alias -dan)
 *
 * The streaming path reuses the shared `QueryExecutor` (same as
 * commands/run.ts) with `silent: true` so that stdout is suppressed and
 * chunks flow exclusively through the chunk callback into RunTui's
 * `useStreamingAccumulator`.
 *
 * Flag parity with the prototype `run` command (refs/imported/ink-tui-overhaul):
 *   --model           LLM model to use
 *   --system-prompt   System prompt override
 *   --workdir         Working directory (default cwd)
 *   --max-lines       Truncate each response to N lines (0 = unlimited)
 *   --no-markdown     Disable markdown rendering (raw output)
 *
 * Scope C note: this command is ADDED alongside the existing
 * `run` command (which still uses repl-ink.tsx). Range C
 * targets the full Ink TUI path, but the legacy run REPL
 * is preserved to avoid breaking streaming / ask_user / event sources
 * / multimodal workflows that are out of scope for the prototype.
 *
 * Task #4674: 本文件曾叫 `run.ts`（内容不变）。对调后**文件名 ↔ 注册命令名 ↔
 * 导出符号名**三者自洽：`commands/interactive.ts` 注册 `interactive`、导出
 * `RunCommand`（历史命名，public API 不变，见 packages/cli/src/index.ts）。
 * `commands/run.ts` 现在是 Ink REPL 链路，注册 `run`、导出 `InteractiveCommand`。
 * ⚠️ 符号重命名是后续独立 PR；本 PR 只搬家，行为零变化。
 */

import { CommandModule } from "yargs";
// Task #4278 片1（地基）: `roy-bot interactive` now mounts the **Solid**
// composition root through the opentui/solid reconciler instead of Ink.
// The `run` chain (commands/run.ts → ChatTui.tsx) keeps importing
// Ink from `tui/` untouched — see docs/tui-opentui-migration-plan.md §1.5.
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { mountInteractiveScreen } from "../tui-solid/mount.js";
import { createWheelInterceptor } from "../tui-solid/wheel-interceptor.js";
import { resolveFullscreenRendererOptions } from "../tui-solid/fullscreen-options.js";
import { setMarkdownEnabled } from "../render/markdown.js";
import { EnvironmentService } from "../services/environment.service";
import { OutputService } from "../services/output.service";
import { CliQuietModeService } from "../services/quiet-mode.service";
import { SessionManager } from "./shared/session-manager.js";
import { QueryExecutor } from "./shared/query-executor.js";
import type { StreamChunkEvent } from "../services/stream-output.service.js";
import { abortStream, resetStreamAbort } from "../services/stream-output.service.js";
import type { UsageLike } from "../tui/UsageFooter.js";
import type { ToolStreamEvent } from "../tui/tool-call.js";
import { startEventSources } from "./interactive-event-sources.js";
import { installStderrGuard, getRecentGuardedOutput } from "./shared/interactive-stderr-guard.js";
import {
  collectEventSourceSystemPrompts,
  joinResolvedSystemPrompts,
} from "./collect-event-source-system-prompts.js";
import {
  buildActAgentContext,
  validateActAgent,
  type ActAgentLookup,
} from "./act-agent-validation.js";
// ★ Task #4634：CLI --model / --fallback-model → AgentContext 的统一接线
import {
  buildModelAgentContext,
  withRuntimeModelOverride,
  checkFallbackModelArg,
  FALLBACK_MODEL_DESCRIBE,
  MODEL_DESCRIBE,
} from "./model-flags.js";
import { EventHandler } from "./shared/event-handler.js";
import { TaskEventHandler } from "./shared/task-event-handler.js";
import { EventMessageFormatter } from "./shared/event-message-formatter.js";
import { createEventHandlerForInteractive } from "./shared/event-handler-wiring.js";
// ★ Task #5036：终态回执附「查看任务卡片」链接（读 lark-cards.db → applink）
import { createCardUrlResolver } from "./shared/card-link-resolver.js";
// ★ Task #4588：lark 档 sink 要交回默认 sender（发真飞书），不能只进本地 TUI
import {
  sendLarkChatMarkdown,
  type SendLarkChatMarkdownOptions,
} from "./shared/telemetry-notice.js";
// ★ Task #4568：Ink TUI 入口也是一个 EventSource（cli-command）
import {
  emitCliTriggerEvent,
  toCliEnvEvent,
  formatTriggerEcho,
  writeTriggerEcho,
} from "./shared/cli-trigger-event.js";
import { registerShutdownHandlers } from "./lifecycle.js";
import { shutdownRunSteps } from "./run-shutdown.js";
import type {
  BaseEnvironment,
  SessionComponent,
} from "@ai-setting/roy-bot-core";

export interface RunOptions {
  /**
   * ★ Task #4568：`--quiet` / `--no-quiet`（yargs 全局 option）。
   * 只用于 triggerEventId 回显判定，不影响其它输出路径。
   */
  quiet?: boolean;
  model?: string;
  /**
   * Task #4623 — 兜底模型（`providerId/modelId`）。
   * 主模型 404/429/配额耗尽/5xx/超时/重试耗尽时，本次 run 自动降级；
   * default agent 与 sub agent 均生效。
   */
  fallbackModel?: string | string[];
  systemPrompt?: string;
  workdir?: string;
  maxLines?: string;
  markdown?: boolean;
  plugins?: string[];
  config?: string;
  env?: string;
  // Task #2728: interactive parity flags
  session?: string;
  continue?: boolean;
  reasoning?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
  eventSource?: string[];
  agent?: string;
  defaultAgentName?: string;
  /**
   * ★ Task #4588（交叉验证 ISSUE 4）：**仅供测试**注入 trigger event 的
   * EventStore 路径，避免单测往用户真实库（`~/.roy-bot/event-store.db`）写脏行。
   * 生产永远不设置（yargs 也没有对应 option）。
   */
  triggerEventDbPath?: string;
}

/**
 * `dispatchInteractiveNotice()` 的依赖注入口（便于行为测试，无需起 Ink）。
 *
 * 生产只传 `onNotice`（其余走默认值）；测试注入 `sendLark` / `writeFallback`
 * 来断言"谁被调了、谁没被调"。
 */
export interface InteractiveNoticeDeps {
  /** RunTui 的「仅显示」通道。`true` = 已接管并显示。 */
  onNotice?: (text: string) => boolean | undefined;
  /** lark 档投递。默认 `sendLarkChatMarkdown`（生产行为，必须一致）。 */
  sendLark?: (notice: SendLarkChatMarkdownOptions) => Promise<void> | void;
  /** 未 mount 时的兜底输出（默认 `console.log`）。 */
  writeFallback?: (text: string) => void;
}

/**
 * `dispatchInteractiveNotice()` 接收的 notice 形状。
 *
 * 直接复用 EventHandler 实际传下来的类型（`TelemetryNotice`）再补 `sink`，
 * 这样生产端 `telemetrySender: (notice) => dispatchInteractiveNotice(notice, ...)`
 * 天然类型兼容，无需 cast。
 */
export type InteractiveNoticeLike = SendLarkChatMarkdownOptions & {
  sink?: "lark" | "stdout";
};

/**
 * ★ Task #4588（交叉验证第二轮 ISSUE 6 根治）：Ink TUI 的通知**分派策略**。
 *
 * ## 为什么要抽成导出纯函数
 *
 * 这段分派原本是 `createEventHandlerForInteractive({ telemetrySender })` 里的
 * 内联闭包，而 `loadHandleQuery` 没导出 ⇒ 挂着 `new EnvironmentService()` 起不来
 * ⇒ 只能靠"读 run.ts 源码 + 字符串包含"来断言。交叉验证实测：那种源码断言
 * **能被轻易绕过**（在行尾注释或字符串字面量里塞上关键词就假绿），等于护栏失效，
 * ISSUE 1 的回归可以悄无声息地重新进来。
 *
 * 抽出来后就能**直接断言行为**：
 *   - `sink === 'stdout'` → 只调 onNotice，绝不碰 lark
 *   - 其它 / 缺省        → 只调 sendLark（发真飞书），绝不进本地 TUI
 *   - onNotice 未就绪    → 退回兜底输出，绝不静默丢弃
 *
 * ## 三条策略的依据
 *
 * 1. **非 stdout 必须交回 lark**（ISSUE 1）：EventHandler 的默认 sender 就是这么
 *    分派的（`event-handler.ts:448-456`）。无条件接管会让 `interactive --es <lark>`
 *    场景下的飞书通知与终态回执全部丢失，而 legacy `run` 又没覆盖过 sender ⇒
 *    两条命令行为分裂。
 * 2. **stdout 必须改道 onNotice**（本任务主修）：Ink 独占 stdout 整帧重绘，裸
 *    `console.log` 会被排队/错序，CLI 来源的通知在 TUI 里**必然看不见**。
 * 3. **未就绪必须兜底**（ISSUE 3）：`eventHandler.start()` 在 `render()` 之前，
 *    mount 前的通知真实存在；首版把兜底写成死代码（判据恒真），会静默丢弃。
 */
export async function dispatchInteractiveNotice(
  notice: InteractiveNoticeLike,
  deps: InteractiveNoticeDeps = {},
): Promise<void> {
  if (notice.sink !== "stdout") {
    const sendLark = deps.sendLark ?? sendLarkChatMarkdown;
    await sendLark(notice);
    return;
  }
  const handled = deps.onNotice?.(notice.text) === true;
  if (handled) return;
  const fallback = deps.writeFallback ?? ((text: string) => console.log(`\n${text}\n`));
  fallback(notice.text);
}

/**
 * `buildInteractiveEventHandlerOptions()` 的入参（即 EventHandler 需要的运行时依赖）。
 */
export interface InteractiveEventHandlerDeps {
  env: BaseEnvironment;
  sessionComponent: SessionComponent;
  /** RunTui 的「仅显示」通道（mount 后才有）。 */
  onNotice?: (text: string) => boolean | undefined;
  /** RunTui 的通知处理（会驱动 agent 再跑一轮）。 */
  onNotification?: (message: string, envEvent?: unknown) => Promise<void> | void;
  /** RunTui 的 idle 判据。 */
  isIdle?: () => boolean;
  /** 测试注入：替换真实 lark 投递。 */
  sendLark?: (notice: SendLarkChatMarkdownOptions) => Promise<void> | void;
  /**
   * ★ Task #5036：任务卡片 applink 解析器（终态回执里附「查看任务卡片」链接）。
   *
   * 缺省 ⇒ 用生产实现 `createCardUrlResolver()`（按需只读 `lark-cards.db`）。
   * 测试注入用它替换，避免真 spawn lark-cli。
   */
  resolveCardUrl?: (taskId: number) => Promise<string | undefined>;
}

/**
 * ★ Task #4588（交叉验证第三轮 ISSUE A 根治）：生产 EventHandler 的**接线**也抽成
 * 可测的导出函数。
 *
 * ## 为什么必须再抽一层（这是本轮最严重的问题）
 *
 * 上一轮我把"分派策略"抽成了 `dispatchInteractiveNotice()` 并用行为断言 —— 但
 * 交叉验证实测：**把生产端 `telemetrySender:` 整段删掉，10 个测试依然全绿**。
 * 因为测试只断言了纯函数本身，没有任何东西断言"生产端真的调用了它"。
 *
 * 这是同一类假绿的**更高一层复发**：护栏保护了策略，却把「策略 ↔ 生产接线」
 * 这一段裸露在外。而删掉接线的后果就是**本次修复的主目标直接回退**（通知退回
 * EventHandler 默认的 `console.log`，在 Ink 下看不见）。
 *
 * 抽成导出函数后，测试可以直接调用它并断言：
 *   - 返回值里**有** `telemetrySender`
 *   - 该 sender 对 `sink='stdout'` 通知会走 `onNotice`（而不是 console.log）
 *   - 该 sender 对 lark 通知会走 `sendLark`（而不是本地 TUI）
 *
 * ## 刻意只做参数构造（不 side effect）
 *
 * 本函数不 new 任何东西、不订阅事件、不写库 —— 纯数据进纯数据出，所以测试可以
 * 随意调。真正的 `createEventHandlerForInteractive()` 由调用方拿着返回值去调。
 */
export function buildInteractiveEventHandlerOptions(
  deps: InteractiveEventHandlerDeps,
): Parameters<typeof createEventHandlerForInteractive>[0] {
  return {
    env: deps.env,
    eventTypes: ["task.background.*", "event-source.event.*"],
    formatter: new EventMessageFormatter({ prefix: "[通知]" }),
    isIdle: deps.isIdle ?? (() => true),
    sessionComponent: deps.sessionComponent,
    telemetrySender: (notice) =>
      dispatchInteractiveNotice(notice, {
        onNotice: deps.onNotice,
        // 生产固定用真实 lark 投递；deps 存在的意义是让行为可测
        sendLark: deps.sendLark ?? sendLarkChatMarkdown,
      }),
    // ★ Task #5036：终态回执里附「查看任务卡片」链接（best-effort，失败只是没链接）
    resolveCardUrl: deps.resolveCardUrl ?? createCardUrlResolver(),
    onEvent: async (_message: string) => {
      // no-op — handled by onEventWithEnv
    },
    onEventWithEnv: async (formattedEvent) => {
      if (deps.onNotification) {
        await deps.onNotification(formattedEvent.message, formattedEvent.envEvent);
      }
    },
  };
}

/**
 * ★ Task #4588：为**用户轮**产出一条 CLI trigger event，并包成 EnvEvent。
 *
 * ## 为什么抽成共享 helper（而不是再写一份）
 *
 * Task #4568 给 run.ts 加了两条 query 通道（`handleQuery` one-shot +
 * `createStreamHandleQuery` streaming），但**只给 one-shot 那条加了 emit**。
 * 而 `RunTui.tsx:346` 的判据是 `if (streamHandleQuery)` —— 它恒真，
 * 所以 one-shot 的 emit 是**死代码**，生产上一行都没执行过。
 *
 * 真机铁证（Task #4588，traces.db traceId `01a1804b9a63ab21`）：
 * `delegate.deriveTriggerEventId` 与 `delegate.captureReplyChannel` 双双
 * `[undefined]` → notify event metadata 里没有 replyChannel/triggerEventId →
 * `resolveNoticeTarget()` 三级全 miss → 通知静默丢弃（用户感知"停住"）。
 *
 * ⇒ 这段逻辑**只能有一份**，否则下次加第三条通道照样漏。
 *
 * ## 判据为什么用「envEvent 是否存在」
 *
 * 结构性标志，不是比较 sessionId：
 *   - 用户键入：`RunTui.handleSubmit → executeQuery(msg)` ⇒ envEvent undefined
 *   - 通知自动处理：`RunTui.handleNotification → executeQuery(msg, envEvent)` ⇒ 有值
 *
 * 后者**绝不能**再 emit，否则 notify → agent → delegate → notify 无限套娃。
 * （Task #4568 曾把判据写成 `runSessionId === sessionId`，结果每轮 notify 都多写
 * 一条 trigger event —— 组2 测试就是防这个回归的护栏。）
 *
 * ## 为什么 await（而非 fire-and-forget）
 *
 * `triggerEventId` 必须在下游 `delegate_task` 之前就注入 EnvContext，否则
 * `deriveTriggerEventIdFromEnvContext()` 拿不到（断点 C）。代价 = 1 次
 * SQLite INSERT（实测亚毫秒级）。
 *
 * ## 永不抛
 *
 * `emitCliTriggerEvent()` 内部已 catch 全部异常并返回 null；本函数同样
 * 在 echo 失败时不抛 —— CLI 主流程（用户提问 → 得到回答）优先级高于可观测性。
 *
 * @returns 需要注入 EnvContext 的 `envEvent`；通知轮 / emit 失败 → undefined
 */
export async function emitUserTurnTrigger(opts: {
  /** 本轮触发事件。有值 = 通知轮 → 不 emit。 */
  envEvent?: unknown;
  message: string;
  sessionId: string;
  /** yargs 的 quiet 值（`--no-quiet` 时回显 triggerEventId） */
  quiet?: boolean;
  /**
   * ★ Task #4588（交叉验证 ISSUE 4）：EventStore 路径。
   *
   * 生产不传 → `~/.roy-bot/event-store.db`（与 lark 共用同一个库）。
   * **测试必须传 tmp 路径** —— 否则每跑一次单测就往用户真实库里写一条
   * `cli-query` trigger event（实测被污染 38 行）。
   */
  dbPath?: string;
}): Promise<{ envEvent: unknown } | undefined> {
  // 通知轮：原样透传由调用方负责，这里绝不伪造新 trigger event
  if (opts.envEvent) return undefined;

  const cliTrigger = await emitCliTriggerEvent({
    command: "interactive",
    query: opts.message,
    sessionId: opts.sessionId,
    ...(opts.dbPath ? { dbPath: opts.dbPath } : {}),
  });
  if (!cliTrigger) return undefined;

  // 用户拍板 ④：--no-quiet 时回显 triggerEventId（便于对 event_store.db 排查）
  const echo = formatTriggerEcho(cliTrigger.triggerEventId, {
    quiet: opts.quiet !== false,
  });
  if (echo) writeTriggerEcho(echo);

  return { envEvent: toCliEnvEvent(cliTrigger, opts.message) };
}

/**
 * Create an EnvironmentService-backed handleQuery closure (one-shot, no streaming).
 *
 * Mirrors the lifecycle used by createActCommand: instantiate the
 * service, call create() with options, then expose handle_query()
 * through a thin wrapper that returns the assistant text string.
 *
 * Kept for backward compatibility / fallback when streaming is unavailable.
 *
 * Task #2728 bugfix: also creates EventHandler (subagent notifications)
 * and TaskEventHandler (task.* console output), matching interactive.ts.
 */
async function loadHandleQuery(
  options: RunOptions,
  hooks?: {
    /** Called when a subagent/event-source notification arrives. */
    onNotification?: (message: string, envEvent?: unknown) => Promise<void> | void;
    /** Returns true when the agent is idle (not processing a query). */
    isIdle?: () => boolean;
    /**
     * ★ Task #4588：仅显示、不触发 agent 的通知出口（telemetry 用）。
     * @returns true = 已接管并显示；false/undefined = 未就绪，调用方需兜底
     */
    onNotice?: (text: string) => boolean;
  }
): Promise<{
  handleQuery: (message: string) => Promise<string>;
  envService: EnvironmentService;
  env: BaseEnvironment;
  sessionId: string;
  queryExecutor: QueryExecutor;
  agentContext: any;
  eventSourceSystemPrompt: string | undefined;
  sessionComponent: SessionComponent;
  eventHandler: EventHandler;
  taskEventHandler: TaskEventHandler;
  sessionManager: SessionManager;
}> {
  // Suppress noisy output during env creation
  const quiet = CliQuietModeService.getInstance().isQuiet();
  const output = new OutputService();
  output.configure({ quiet });
  const envService = new EnvironmentService(output);
  await envService.create({
    envName: options.env,
    configPath: options.config,
    workDir: options.workdir,
    loadPlugins: true,
    plugins: options.plugins,
    commandName: "interactive",
  });
  const env = envService.getEnvironment();
  if (!env) {
    throw new Error("Failed to create environment");
  }

  // Session management (Task #2728: reuse SessionManager like interactive)
  const sessionComponent = envService.getSession();
  if (!sessionComponent) {
    throw new Error("Failed to create session component");
  }
  const sessionManager = new SessionManager({
    sessionComponent,
    output,
    quiet: true,
  });
  const sessionResult = await sessionManager.init(
    options.session,
    options.continue
  );
  const sessionId = sessionResult.sessionId;

  // Query executor (silent=true so stdout is suppressed in Ink mode)
  const queryExecutor = new QueryExecutor({
    env,
    sessionComponent,
    output,
    quiet: true,
    silent: true,
  });

  // Agent validation (Task #2728: reuse act-agent-validation)
  let agentContext: any = undefined;
  if (options.agent && options.agent !== "default") {
    const agentComponent = env.getComponent("agent") as unknown as ActAgentLookup | undefined;
    const validation = validateActAgent(agentComponent, options.agent);
    if (!validation.valid) {
      output.error((validation as { message: string }).message);
      output.info("提示: roy-bot agents list");
      process.exit(1);
    }
    agentContext = buildActAgentContext(options.agent);
  }

  // Event source startup (Task #2728: reuse interactive-event-sources)
  let eventSourceSystemPrompt: string | undefined;
  const rawEventSourceIds = options.eventSource;
  const eventSourceIds: string[] = Array.isArray(rawEventSourceIds)
    ? rawEventSourceIds.filter((s) => !!s)
    : rawEventSourceIds
      ? [rawEventSourceIds]
      : [];

  if (eventSourceIds.length > 0) {
    const eventSourceComponent = env.getComponent("event-source") as any;
    if (!eventSourceComponent || typeof eventSourceComponent.startSource !== "function") {
      output.error("❌ 未找到事件源组件或 startSource 方法");
      output.info("请确保 EventSourceComponent 已正确注册");
      process.exit(1);
    }
    const summary = await startEventSources(eventSourceIds, eventSourceComponent, output);
    const preloadedPrompts = collectEventSourceSystemPrompts(eventSourceIds, eventSourceComponent);
    eventSourceSystemPrompt =
      preloadedPrompts.length > 0
        ? joinResolvedSystemPrompts(preloadedPrompts)
        : undefined;
    if (eventSourceIds.length === 1 && summary.failedCount > 0) {
      process.exit(1);
    }
  }

  // Initialize stream output config
  const llmComponent = envService.getLLM();
  queryExecutor.initStreamOutput(llmComponent ?? null);

  const handleQuery = async (message: string, envEvent?: unknown) => {
    // ★ Task #4568：用户输入（envEvent 为空）时 emit 一条 CLI trigger event。
    //
    //   判据用「envEvent 是否存在」——
    //     - 用户键入：RunTui.handleSubmit → executeQuery(message)         ⇒ envEvent undefined
    //     - 通知自动处理：RunTui.handleNotification → executeQuery(message, envEvent) ⇒ 有值
    //   后者**不能**再 emit，否则 notify → agent → delegate → notify 无限套娃。
    // ★ Task #4588：改用共享 helper（原来这段只服务 one-shot 通道，而
    //   RunTui 恒走 streaming 通道 ⇒ 这段在真机上从未执行过）。
    const triggerInjection = await emitUserTurnTrigger({
      envEvent,
      message,
      sessionId,
      quiet: options.quiet,
      // 与 createStreamHandleQuery 对称转发（交叉验证第二轮 nit A）：
      // 否则谁给 one-shot 路径写单测，仍会往真实库写脏行。
      ...(options.triggerEventDbPath ? { dbPath: options.triggerEventDbPath } : {}),
    });

    // ★ Task #4519: 把事件的 trace 上下文一并下传。
    //
    //   ES 层不再写进程级 globalContext，改为把 context 放进事件载荷
    //   (`envEvent.metadata.traceContext`)。RunTui 这条路径原来不传 traceId →
    //   若仍不读载荷，agent 侧 span 会变成「无父的新 trace」，与触发它的
    //   `lark-cli.handleEvent` 断开。这里显式取出并作为 traceId 传给 executor，
    //   保持 ES → agent 的链路完整。
    const eventTraceContext = (
      envEvent as { metadata?: { traceContext?: { traceId?: string } } } | undefined
    )?.metadata?.traceContext;
    const mergedContext = {
      ...agentContext,
      // ★ Task #4634：model / fallbackModel 统一由 buildModelAgentContext 产出
      ...buildModelAgentContext(options),
      eventSourceSystemPrompt,
      // Task #4418: 把触发事件透传下去，异常中断时才能定位 replyChannel 发失败说明。
      // ★ Task #4568：用户输入路径用 CLI trigger event 当 envEvent。
      ...(envEvent ? { envEvent } : triggerInjection ? triggerInjection : {}),
      metadata: {
        ...(agentContext?.metadata ?? {}),
        defaultAgentName: options.defaultAgentName,
      },
    };
    const result = await queryExecutor.execute(
      message,
      sessionId,
      {
        showReasoning: options.reasoning ?? true,
        showToolCalls: options.toolCalls ?? true,
        showToolResults: options.toolResults ?? false,
      },
      eventTraceContext?.traceId,
      mergedContext
    );
    return String(result ?? "");
  };

  // ========== Task #2728 bugfix: EventHandler + TaskEventHandler ==========
  // Bug 1: commands/interactive.ts must wire EventHandler (subagent notifications)
  // and TaskEventHandler (task.* console output) just like commands/run.ts.
  // Without EventHandler, subagent completion notifications (task.background.*)
  // and event-source messages (event-source.event.*) are silently dropped.

  // TaskEventHandler: subscribes to task.* events, prints to console.
  // Uses console.log directly (not OutputService) so it works even in quiet mode.
  const taskEventHandler = new TaskEventHandler({
    env,
    enabled: true,
  });

  // EventHandler: subscribes to task.background.* and event-source.event.*
  // Formats notifications and delivers them via the onEventWithEnv callback.
  // In run mode (no REPL), notifications are delivered to RunTui via the
  // onNotification hook, which displays them as history items and triggers
  // automatic agent processing when idle.
  //
  // Task #4042 ESPlugin v2 Phase 6 commit 3：用 createEventHandlerForInteractive 工厂函数
  // 替代裸 new EventHandler()，自动注入 eventStore + getHandlerForEsType，
  // 让 v2 path（chatId 来自 trigger event）在 run 模式生产路径上生效。
  // 直接 new EventHandler() 时 eventStore 是 optional 不传，
  // 等于 v2 path 在 run 模式生产路径上是 dead path（等价 #4035 修的 chatId 来源
  // 问题在生产上没真正生效）。
  // ★ Task #4588：接线参数由 `buildInteractiveEventHandlerOptions()` 构造 ——
  //   交叉验证第三轮 ISSUE A 指出"生产接线整段删掉测试仍全绿"，故把参数构造
  //   抽成导出纯函数，让测试能直接断言 telemetrySender 真的被接上。
  const eventHandler = createEventHandlerForInteractive(
    buildInteractiveEventHandlerOptions({
      env,
      sessionComponent,
      onNotice: hooks?.onNotice,
      onNotification: hooks?.onNotification,
      isIdle: hooks?.isIdle,
    }),
  );

  return {
    handleQuery,
    envService,
    env,
    sessionId,
    queryExecutor,
    agentContext,
    eventSourceSystemPrompt,
    sessionComponent,
    eventHandler,
    taskEventHandler,
    sessionManager,
  };
}

/**
 * Task #2728: Create a streaming query handler that feeds chunks into
 * RunTui's `useStreamingAccumulator` via the `onChunk` callback.
 *
 * This wraps the shared `QueryExecutor` (same as interactive.ts) and
 * adapts its `StreamChunkCallback` events (`llm.text`, `llm.reasoning`)
 * into simple string deltas for the Ink TUI.
 *
 * The QueryExecutor is configured with `silent: true` so it does NOT
 * write to stdout — all output flows through the chunk callback into
 * the React streaming region.
 *
 * @param queryExecutor  The shared QueryExecutor instance.
 * @param sessionId      Active session ID.
 * @param options        Run options (model, agent, reasoning, etc.)
 * @param agentContext   Pre-built agent context (from --agent validation).
 * @param eventSourceSystemPrompt  Preloaded --es system prompts.
 */
/** Task #4278 片6: optional reasoning-delta sink (thinking block). */
export type ReasoningDeltaCallback = (delta: string) => void;

export function createStreamHandleQuery(
  queryExecutor: QueryExecutor,
  sessionId: string,
  options: RunOptions,
  agentContext: any,
  eventSourceSystemPrompt: string | undefined,
  /**
   * ★ Task #5125 P7.2 —— 会话内模型热切换的 getter。
   *
   * 由调用方（`createRunCommand`）注入一个**闭包**，内容是
   * /model 弹窗最近一次选择的 `providerId/modelId`（未选择过
   * 则 undefined）。**每轮 execute 时实时求值** ⇒ 弹窗选择后
   * 下一条消息即用新模型，不重启。
   *
   * 优先级：本 override > 启动 `--model` flag > 内存层
   * `llm.defaultModel`（见 `withRuntimeModelOverride`）。
   */
  runtimeModel?: () => string | undefined
): (
  message: string,
  onChunk: (chunk: string) => void,
  onTool?: (event: ToolStreamEvent) => void,
  onUsage?: (usage: UsageLike) => void,
  /**
   * Task #4418: 触发本轮的 EnvEvent（subagent 通知 / 飞书消息）。
   * 用户手动输入时为 undefined —— 绝不能把上一轮的 replyChannel 串过来。
   */
  envEvent?: unknown,
  /**
   * Task #4278 片6: reasoning delta sink（thinking 块）。
   *
   * ⚠️ **必须放在最后**（Task #4278 交叉验证发现）。
   *
   * main 的 positional 契约是
   *   `(message, onChunk, onTool, onUsage, envEvent)`，
   * 而 `RunTui.tsx`（Ink）与 `interactive-notify-chain.test.ts`（main 原生护栏）
   * 都按这个顺序**位置传参**调用。
   *
   * 片6 最初把 `onReasoning` 插在 `onUsage` **之前** ⇒ main 的 5 位调用
   * `stream(msg, cb, undefined, undefined, notifyEvent)` 会把 `notifyEvent`
   * 塞进 `onUsage` 位、`envEvent` 实收 `undefined` ⇒
   *   ① 通知轮的 envEvent 被新 emit 的 trigger 覆盖（main 的组2 断言红）
   *   ② 通知轮往 event_store 多写 1 行（组9 断言红 → 无限套娃老坑复活）
   *   ③ `onUsage` 收不到 usage（main 的 run-usage-forward 断言红 → 缓存/token
   *      脚注功能整体失效）
   *
   * 这类缺陷**编译过、类型过**（worktree 内部自洽），只有跑 main 的护栏测试
   * 才暴露 ⇒ 所以 `onReasoning` 追加到末尾，**绝不插入既有参数中间**。
   */
  onReasoning?: ReasoningDeltaCallback
) => Promise<string> {
  return async (
    message: string,
    onChunk: (chunk: string) => void,
    onTool?: (event: ToolStreamEvent) => void,
    onUsage?: (usage: UsageLike) => void,
    envEvent?: unknown,
    onReasoning?: ReasoningDeltaCallback
  ) => {
    // ★ Task #4721 G2：新的一轮开始 ⇒ 清掉上一轮的 abort 标记。
    //
    // 为什么要清：`abortStream()`（无 scope）置的是**全局** flag，而
    // `run.ts` 的 `executeInternal` 每轮都会调 `resetStreamAbort()`。
    // 如果这里不清 ⇒ 用户 ESC 打断一轮之后，**后续每一轮**都会被
    // `isStreamAborted()` 判定为已中断 ⇒ 流式输出永远不出来。
    resetStreamAbort();

    // Wire the chunk callback: translate StreamChunkEvent → string delta
    // Task #4124: also forward tool.call / tool.result / tool.error as
    // ToolStreamEvents so the TUI can render opencode-style tool cards.
    queryExecutor.setChunkCallback((event: StreamChunkEvent) => {
      switch (event.type) {
        case "llm.text":
          // LLM text delta — the main streaming content
          if (event.delta) {
            onChunk(event.delta);
          } else if (event.content) {
            onChunk(event.content);
          }
          break;
        case "tool.call":
          onTool?.({
            kind: "call",
            id: event.toolId,
            name: event.toolName ?? "tool",
            args: event.toolArgs,
          });
          break;
        case "tool.result":
          onTool?.({
            kind: "result",
            id: event.toolId,
            name: event.toolName ?? "tool",
            output: event.toolResult,
          });
          break;
        case "tool.error":
          onTool?.({
            kind: "error",
            name: event.toolName ?? "tool",
            error: event.toolError,
          });
          break;
        case "llm.reasoning":
          // Task #4278 片6 (thinking block): forward reasoning deltas on a
          // **separate** channel. It must NOT go through onChunk — reasoning
          // would pollute the assistant reply. In silent mode the stdout
          // display is a no-op, so this callback is the TUI's only source.
          {
            const delta = event.delta ?? event.content;
            if (delta) onReasoning?.(delta);
          }
          break;
        case "llm.completed":
          // Task #4396: forward this call's cache/token usage so RunTui can
          // render a dim grey footer under the assistant message.
          // `event.usage` is undefined when the provider reports nothing —
          // in that case no footer is drawn.
          if (event.usage) {
            onUsage?.(event.usage);
          }
          break;
        default:
          break;
      }
    });

    // ★ Task #4588（本任务核心修复）：**streaming 通道也必须 emit trigger event**。
    //
    // ## Bug（真机 trace 铁证）
    //
    // `RunTui.tsx:346` 的判据是 `if (streamHandleQuery)`，而 commands/interactive.ts 把
    // `createStreamHandleQuery` 的结果传了进去 ⇒ 该判据**恒真** ⇒ 用户每次
    // 提交都走本函数，`handleQuery` 里的 emit 是**死代码**。
    //
    // 后果：`mergedContext` 里没有 `envEvent` → `buildRunEnvContext()` 得到
    // `replyChannel=undefined` / `envEvent=undefined` → `delegate_task`:
    //   - `deriveTriggerEventIdFromEnvContext()` → undefined
    //   - `captureReplyChannelSnapshot()`       → undefined
    // → `publishBackgroundEvent()` 的 metadata 只有
    //   `{source, trigger_session_id, env_name}`，**没有回复目标**
    // → `EventHandler.resolveNoticeTarget()` 三级全 miss → 通知静默丢弃。
    //
    // traces.db（traceId `01a1804b9a63ab21`）里这两条 span 的 result 都是
    // `[undefined]`，就是这条链的直接物证。
    const triggerInjection = await emitUserTurnTrigger({
      envEvent,
      message,
      sessionId,
      quiet: options.quiet,
      // 测试注入口（生产不设 ⇒ 走默认库）
      ...(options.triggerEventDbPath ? { dbPath: options.triggerEventDbPath } : {}),
    });

    // ★ Task #4519: 同 handleQuery —— 同样从事件载荷取出 trace 上下文，
    //   保证 RunTui 流式路径的 agent span 仍挂在触发它的 ES 根 span 下。
    const eventTraceContext = (
      envEvent as { metadata?: { traceContext?: { traceId?: string } } } | undefined
    )?.metadata?.traceContext;
    const mergedContext = {
      ...agentContext,
      // ★ Task #4634：model / fallbackModel 统一由 buildModelAgentContext 产出
      // ★ Task #5125 P7.2：会话内热切换 override（getter 实时求值）
      //   赢过启动 --model flag；未选择过 ⇒ 原样透传（零行为变化）。
      //   ⚠️ 只在 streaming 路径接线（RunTui 恒走本路径，one-shot 是死代码，
      //   见 Task #4588 注释）；one-shot handleQuery 保持原样。
      ...withRuntimeModelOverride(
        buildModelAgentContext(options),
        runtimeModel?.(),
      ),
      eventSourceSystemPrompt,
      // Task #4418: 同 handleQuery —— 异常中断时靠它定位 replyChannel。
      // ★ Task #4588：通知轮用原 envEvent（绝不覆盖），用户轮用新 emit 的 trigger。
      ...(envEvent ? { envEvent } : triggerInjection ? triggerInjection : {}),
      metadata: {
        ...(agentContext?.metadata ?? {}),
        defaultAgentName: options.defaultAgentName,
      },
    };

    const result = await queryExecutor.execute(
      message,
      sessionId,
      {
        showReasoning: options.reasoning ?? true,
        // Task #4124: the Ink TUI renders tool calls/results itself, so we
        // always emit the tool chunk events here (stdout is silenced via
        // silent:true on the QueryExecutor, so this does not double-print).
        // RunTui decides what to display via its own showTool* props.
        showToolCalls: true,
        showToolResults: true,
      },
      eventTraceContext?.traceId,
      mergedContext
    );
    return String(result ?? "");
  };
}

export function createRunCommand(): CommandModule<object, RunOptions> {
  return {
    command: "interactive",
    aliases: ["i", "repl"],
    describe: "Start an interactive conversation with the agent (opentui TUI)",
    builder: (yargs) =>
      yargs
        .option("model", {
          alias: "m",
          type: "string",
          describe: MODEL_DESCRIBE,
        })
        .option("fallback-model", {
          type: "string",
          describe: FALLBACK_MODEL_DESCRIBE,
        })
        // ★ Task #4724 review2 MINOR-1/MINOR-2：非法的显式兜底值
        //   在**参数解析阶段**就报错退出，不静默放行。
        .check(checkFallbackModelArg)
        .option("system-prompt", {
          alias: "s",
          type: "string",
          describe: "System prompt for the agent",
        })
        .option("workdir", {
          alias: "w",
          type: "string",
          describe: "Working directory",
          default: process.cwd(),
        })
        .option("max-lines", {
          type: "string",
          describe: "Truncate each response to N lines (0 = unlimited)",
          default: "500",
        })
        .option("markdown", {
          type: "boolean",
          describe: "Render markdown (default: true; --no-markdown for raw)",
          default: true,
        })
        .option("plugins", {
          alias: "p",
          type: "string",
          array: true,
          describe: "Enable plugins (e.g. tslsp, code-check)",
        })
        .option("config", {
          type: "string",
          describe: "Path to config file",
        })
        .option("env", {
          type: "string",
          describe: "Environment name",
        })
        // Task #2728: interactive parity flags
        .option("session", {
          type: "string",
          describe: "指定会话 ID（注: -s 已被 --system-prompt 占用）",
        })
        .option("continue", {
          alias: "c",
          type: "boolean",
          describe: "继续上次会话",
          default: false,
        })
        .option("reasoning", {
          alias: "r",
          type: "boolean",
          describe: "显示 AI 思考过程",
          default: true,
        })
        .option("tool-calls", {
          type: "boolean",
          describe: "显示工具调用",
          default: true,
        })
        .option("tool-results", {
          type: "boolean",
          describe: "显示工具执行结果",
          default: true,
        })
        .option("event-source", {
          alias: "es",
          type: "array",
          string: true,
          describe:
            "启动时一并启动的事件源 ID（可多次指定，支持 --es a --es b）",
        })
        .option("agent", {
          alias: "a",
          type: "string",
          describe: "指定使用的 agent (如 explore, general)",
        })
        .option("default-agent-name", {
          alias: "dan",
          type: "string",
          describe: "Default agent 名字（默认 Roy，可被覆盖）",
          default: "Roy",
        }),
    handler: async (argv) => {
      if (argv.markdown === false) {
        setMarkdownEnabled(false);
      } else {
        setMarkdownEnabled(true);
      }
      const maxLines = Number.parseInt(argv.maxLines ?? "500", 10);

      // Task #2728 bugfix: Shared state for event handler ↔ RunTui communication.
      // The EventHandler (created inside loadHandleQuery) needs to know:
      //   1. Whether the agent is idle (to decide when to process notifications)
      //   2. How to deliver notifications to RunTui (for display + auto-processing)
      // We use a mutable ref object that RunTui populates after mount.
      const runState: {
        isIdle: () => boolean;
        onNotification: (message: string, envEvent?: unknown) => Promise<void>;
        /**
         * ★ Task #4588：仅显示、不驱动 agent 的通知出口（telemetry 用）。
         * 默认 undefined —— mount 前不会有人发通知，EventHandler 的
         * telemetrySender 见此走 console.log 兜底。
         */
        onNotice?: (text: string) => boolean;
        /**
         * ★ Task #4721 G1：**历史区**滚轮回调。
         *
         * opentui 在 split-footer 下对 `y < renderOffset` 的指针直接丢弃 ⇒
         * 历史区的滚轮必须由 `prependInputHandlers` 拦下原始序列后转交。
         */
        onHistoryWheel?: (direction: "up" | "down" | "left" | "right") => void;
      } = {
        isIdle: () => true,  // default: idle (before RunTui mounts)
        onNotification: async () => {},  // default: no-op (before RunTui mounts)
      };

      // Task #2728: Load env + session + queryExecutor + agent + event sources
      // Bug 1 fix: pass hooks for EventHandler notification delivery
      const {
        handleQuery,
        envService,
        env,
        queryExecutor,
        sessionId,
        agentContext,
        eventSourceSystemPrompt,
        eventHandler,
        taskEventHandler,
        sessionManager: _sessionManager,
      } = await loadHandleQuery(argv, {
        isIdle: () => runState.isIdle(),
        onNotification: (msg, envEvent) => runState.onNotification(msg, envEvent),
        // ★ Task #4588：延迟到调用时再读 runState.onNotice —— RunTui 是
        //   render 之后才注册 handler 的，这里必须闭包读最新值。
        onNotice: (text) => runState.onNotice?.(text) === true,
      });

      // Task #3000: Register SIGINT/SIGTERM handlers BEFORE Ink render so
      // Ctrl-C during run triggers graceful cleanup (envService.dispose,
      // eventSource.stop, TempFileManager.cleanupAll, etc.) before exit.
      // commands/interactive.ts 自创建 envService → shouldDisposeEnvService=true.
      // The cleanup is awaited then process.exit(0).
      const shutdownHandle = registerShutdownHandlers(async () => {
        await shutdownRunSteps({
          lspManagerDispose: null,
          pluginAdapterDispose: null,
          stopEventHandler,
          stopTaskEventHandler,
          queryExecutor,
          env,
          envService,
          shouldDisposeEnvService: true,
          output: undefined,
          logger: undefined,
        });
      });

      // Task #2728: Create streaming handler
      // ★ Task #5125 P7.2 —— 会话内模型热切换。
      //
      // `runtimeModelOverride` 是 /model 弹窗最近一次选择
      // （`providerId/modelId`；未选择过 = undefined）。
      // 闭包 getter 由 `createStreamHandleQuery` **每轮实时求值**
      // ⇒ 选择后下一条消息即用新模型，不重启。
      let runtimeModelOverride: string | undefined;
      const applyRuntimeModelOverride = (provider: string, model: string) => {
        runtimeModelOverride = `${provider}/${model}`;
      };

      const streamHandleQuery = createStreamHandleQuery(
        queryExecutor,
        sessionId,
        argv,
        agentContext,
        eventSourceSystemPrompt,
        () => runtimeModelOverride
      );

      // Bug 1 fix: Start event handlers BEFORE rendering RunTui so that
      // notifications are captured from the very beginning.
      const stopEventHandler = eventHandler.start();
      const stopTaskEventHandler = taskEventHandler.start();

      // Task #4721（底部乱流兜底）：在 mount TUI **之前**接管 stderr。
      //
      // 为什么必须在这里：opentui 的 split-footer 模式下，**任何**未经捕获的
      // 终端写入都会落在当前光标位置 —— 而光标在动态区（footer）里 ⇒ 与 TUI
      // 重绘逐字符交错 ⇒ 底部残影（截图实证：`ig-ati-n 003 -tarting mig-ati-`）。
      //
      // core 侧只修了 `logMigration` 这一个已知来源（commit f679f3a2），
      // 这里兜住其余所有 stderr 写入（console.error / 第三方库裸写）。
      // 内容转 logger（只落盘）⇒ 诊断信息不丢，终端一个字节都不受污染。
      const restoreStderrGuard = installStderrGuard();

      // Task #4278 片1: create the opentui renderer, then mount the Solid
      // RunScreen. `screenMode: "split-footer"` is the R1-recommended mode
      // (片0 measured: no alternate screen; scrollback rows are write-once) —
      // 片4 will lift committed history into `writeToScrollback()`. For片1 the
      // history still lives inside the frame, which is enough to verify
      // "interactive starts and paints static content".
      // Task #4721 G1：历史区（终端上部）的**最后一行**（1-based）。
      //
      // split-footer 下：`renderOffset` = 终端高度 - footer 高度。
      // opentui 的 `processSingleMouseEvent`（`chunk-node-2rg7pskw.js:23293`）：
      //
      // ```js
      // if (mouseEvent.y < this.renderOffset) { return false; }  // y 是 **0-based**
      // ```
      //
      // ⇒ 0-based `y < renderOffset` 被丢弃 ⇒ **1-based row ≤ renderOffset**
      //   才是历史区 ⇒ 「历史区最后一行」= renderOffset（1-based）。
      //
      // ⚠️ 用**可变盒子**而不是直接读 `renderer.footerHeight` ——
      //   `renderer` 在下面才创建（TDZ），闭包里直接读会 ReferenceError。
      const footerHeightBox = { current: 12 };

      // ★ Task #4954 P0：全屏架构切换（alternate-screen）。
      // options 组合由纯函数 fullscreen-options.ts 锁死（TDD-1 5/5）。
      // 旧 split-footer + capture-stdout 组合退役：writeToScrollback
      // 强校验 split-footer ⇒ 历史承载已在 RunScreen 切 rows/scrollbox。
      const renderer: CliRenderer = await createCliRenderer({
        ...resolveFullscreenRendererOptions(),
        // ★ Task #4721 G1：拦截**历史区**的滚轮。
        //
        // ## 为什么必须在这里拦
        //
        // opentui 的 `processSingleMouseEvent`（`chunk-node-2rg7pskw.js:23293`）
        // 在 split-footer 下对 `mouseEvent.y < this.renderOffset` **直接
        // `return false`** ⇒ 指针落在**历史区**（终端上部，用户真正想滚的
        // 位置）时，事件**不会**派发给任何 renderable。
        //
        // 而 `handleStdinEvent`（`:23191-23197`）在 `processSingleMouseEvent`
        // 返回 false 时会走 `dispatchSequenceHandlers(event.raw)` ⇒ 我们注册
        // 的原始序列处理器能拿到**原始字节** ⇒ 自己解析 SGR 滚轮。
        //
        // ⇒ 动态区的滚轮仍由 opentui 原生 `onMouseScroll` 处理（不抢），
        //   历史区的滚轮由这里兜住 —— 两条路径最终调用**同一个** `applyWheel`。
        prependInputHandlers: [
          createWheelInterceptor({
            // ★ Task #4954 P0（DS review MAJOR-1 修复）：
            // alternate-screen 下**没有**「opentui 丢弃的历史区」
            // （整屏都是 renderable 树，scrollbox 原生接滚轮）⇒
            // isInHistoryArea 恒 false，拦截器永不消费事件，
            // 滚轮全部走 scrollbox 原生路径。
            // 旧 split-footer 判定（renderOffset）已无意义。
            isInHistoryArea: () => false,
            onHistoryWheel: (event) => {
              runState.onHistoryWheel?.(event.direction);
            },
          }),
        ],
      });

      let resolveExit: () => void = () => {};
      const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });

      await mountInteractiveScreen(renderer, {
        handleQuery,
        streamHandleQuery,
        model: argv.model,
        workdir: argv.workdir,
        maxLines,
        markdownEnabled: argv.markdown !== false,
        // Task #4124 (opencode-style tools): show tool cards; the detail
        // (output/error) follows the --tool-results flag (default on).
        showToolCalls: argv.toolCalls !== false,
        showToolResults: argv.toolResults !== false,
        onRegisterHandlers: (handlers: {
          onNotification: (message: string, envEvent?: any) => Promise<void>;
          /** ★ Task #4588：仅显示、不驱动 agent 的通知出口（telemetry 用） */
          onNotice?: (text: string) => boolean;
          isIdle: () => boolean;
          /** ★ Task #4721 G1：历史区滚轮（opentui 丢弃的那部分） */
          onHistoryWheel?: (direction: "up" | "down" | "left" | "right") => void;
        }) => {
          // Wire RunTui's notification handler + isIdle into the shared runState
          // so EventHandler can deliver notifications here.
          runState.onNotification = handlers.onNotification;
          runState.isIdle = handlers.isIdle;
          // ★ Task #4588：接上「仅显示」通道
          runState.onNotice = handlers.onNotice;
          // ★ Task #4721 G1：接上「历史区滚轮」通道
          runState.onHistoryWheel = handlers.onHistoryWheel;
        },
        // ★ Task #4954 P0：alternate-screen 无 footerHeight 概念
        //   （输入框锚定由 App.tsx 的 flex 层保证）。
        //   onFooterHeightChange prop 保留（RunScreen 仍会调），但
        //   这里**不再触** renderer.footerHeight setter（alt-screen 下无意义）。
        //   footerHeightBox 同步保留：wheel-interceptor 的历史区判定
        //   在 alt-screen 下由 scrollbox 原生滚动接管（P3 彻底清理）。
        onFooterHeightChange: (height: number) => {
          footerHeightBox.current = Math.max(1, height);
        },
        onExit: () => {
          // Solid/opentui has no `useApp().exit()`; the RunScreen signals
          // exit here and we tear the renderer down below.
          resolveExit();
        },
        // ★ Task #4721 G2（打断）：ESC / Ctrl-C ⇒ 中断当前这轮生成。
        //
        // 为什么必须在这里接线（而不是在 RunScreen 里）：RunScreen 是纯 UI
        // 层，它**不知道** agent / stream 的存在 ⇒ 只能通过 prop 把「打断」
        // 的决策交回给持有 `env` 的这一层（与 Ink 链路 `commands/run.ts` 的
        // `handleEscKey` 同构）。
        //
        // 三件事（顺序与 Ink 链路 `run.ts:1919-1946` 对齐）：
        //   1. agentComponent.abortAll() —— 中断 LLM 调用（含 delegate 子 agent）
        //   2. abortStream()            —— 停掉流式输出
        //   3. 下一轮开始时 resetStreamAbort() —— 让新一轮能正常输出
        onInterrupt: () => {
          try {
            const agentComponent = env.getComponent("agent") as
              | { abortAll?: () => void; abort?: (name: string) => void }
              | undefined;
            if (agentComponent?.abortAll) {
              agentComponent.abortAll();
            } else if (agentComponent?.abort) {
              agentComponent.abort("default");
            }
          } catch {
            /* abort 失败不应让 TUI 崩掉 */
          }
          abortStream();
        },
        // ★ Task #5125 P7.2 —— /model 热切换：持久化成功后由
        // RunScreen 调用。两件事（顺序重要）：
        //   1. 更新 runtimeModelOverride ⇒ 下一轮 context.model
        //      = 新模型（赢过启动 --model flag）；
        //   2. `configComponent.set("llm.defaultModel"/"defaultProvider")`
        //      ⇒ 内存层立即生效（ConfigComponent.set 语义：写内存 +
        //      触发 llm.* watcher + 异步持久化队列；persistToFile
        //      是 stub ⇒ 无重复落盘，config.jsonc 由 P7.1 的
        //      setDefaultModel 负责——同一来源，无双写）。
        //      LLMComponent 的 llm.* watcher（llm.ts:553）自动感知，
        //      每轮 resolveRequest 实时读内存层（llm.ts:619-632）。
        //   失败仅吞掉（catch）—— 通知行已经显示了成功/失败，
        //   内存层失败不应让 TUI 崩掉。
        onModelHotSwap: (provider: string, model: string) => {
          try {
            applyRuntimeModelOverride(provider, model);
            const configComponent = env.getComponent("config") as
              | { set?: (key: string, value: unknown) => Promise<void> }
              | undefined;
            if (configComponent?.set) {
              // ★ Task #5129 P7.3 F2 —— 内存层同样写**完整 id**
              //   （与 setDefaultModel 的文件写同格式）：多段模型名
              //   （org/model）裸 id 重启后会被 llm.resolveRequest
              //   误切 provider。runtimeModelOverride 路径已是
              //   `${provider}/${model}`，这里对齐。
              void configComponent
                .set("llm.defaultModel", `${provider}/${model}`)
                .catch(() => {});
              void configComponent
                .set("llm.defaultProvider", provider)
                .catch(() => {});
            }
          } catch {
            /* 内存层失败不应让 TUI 崩掉 */
          }
        },
      });

      try {
        await exitPromise;
      } finally {
        // Task #4278 片1 + #4954 P0: tear down the renderer before
        // exiting. alternate-screen 下 opentui destroy 会发
        // ESC[?1049l 恢复主屏（shell 历史回归）。
        try {
          if (!renderer.isDestroyed) renderer.destroy();
        } catch {
          /* best-effort teardown */
        }
        // Task #4721：还原 stderr 通道（守卫装在 mount 之前 ⇒ 必须还原，
        // 否则退出阶段的诊断信息会全部进日志文件而不是终端）。
        try {
          restoreStderrGuard();
        } catch {
          /* best-effort */
        }
        // ★ Task #4721（交叉验证 MINOR-1）：把守卫拦下的诊断信息**回放到终端**。
        //
        // 守卫在整个会话期间把 stderr/console 输出都吞进了日志文件 ⇒
        // 用户在终端里看不到任何诊断信息 ⇒ 出了问题无从排查。
        //
        // ⇒ 退出时（TUI 已销毁、终端已恢复）把**最近若干条**打回终端。
        //   放在 restoreStderrGuard() 之后 ⇒ 此时 console 已还原 ⇒ 能正常输出。
        try {
          const recent = getRecentGuardedOutput(20);
          if (recent.length > 0) {
            process.stderr.write(
              `\n── interactive 诊断（最近 ${recent.length} 条，完整内容见 app.log）──\n` +
                recent.map((line) => `  ${line}\n`).join(""),
            );
          }
        } catch {
          /* best-effort */
        }
        // Task #3000: 正常退出（REPL 自然关闭 / Ctrl-C）也走完整 shutdownRunSteps
        // 流程，确保 envService.dispose + EventSource.stop + TempFileManager 全清。
        // Removing the lifecycle signal handlers first so the cleanup here
        // doesn't double-trigger via SIGINT/SIGTERM (idempotency in case of races).
        shutdownHandle.dispose();
        await shutdownRunSteps({
          lspManagerDispose: null,
          pluginAdapterDispose: null,
          stopEventHandler,
          stopTaskEventHandler,
          queryExecutor,
          env,
          envService,
          shouldDisposeEnvService: true,
          output: undefined,
          logger: undefined,
        });
        process.exit(0);
      }
    },
  };
}

export const RunCommand = createRunCommand();
