/**
 * @fileoverview Run Command — `roy-bot run` 的 Ink REPL（别名 `i` / `repl`）。
 *
 * 交互式多轮对话命令 - 复用 act 逻辑
 *
 * 提供 REPL 风格的多轮对话体验
 *
 * 特性：
 * - 用户输入与 Assistant 输出颜色区分
 * - Esc 按键：中断流式输出 + 恢复输入（执行中有效，空闲时无操作）
 * - Ctrl+C：任何时候都退出程序
 * - /abort 命令：中断流式输出（与 Esc 等效）
 *
 * Task #4674: 本文件曾叫 `interactive.ts`（内容不变）。对调后**文件名 ↔ 注册命令名
 * ↔ 导出符号名**三者自洽：`commands/run.ts` 注册 `run`、导出 `InteractiveCommand`
 * （历史命名，public API 不变，见 packages/cli/src/index.ts）。
 * `commands/interactive.ts` 现在是 opentui/Solid 链路，注册 `interactive`。
 * ⚠️ 符号重命名是后续独立 PR；本 PR 只搬家，行为零变化。
 */

import { CommandModule } from "yargs";
import * as readline from "readline";
import chalk from "chalk";
import { BaseEnvironment } from "@ai-setting/roy-bot-core";
import { EnvironmentService } from "../services/environment.service";
import { OutputService } from "../services/output.service";
import { SessionManager } from "./shared/session-manager";
import { QueryExecutor } from "./shared/query-executor";
import { EventMessageFormatter } from "./shared/event-message-formatter";
import { createEventHandlerForInteractive } from "./shared/event-handler-wiring";
// ★ Task #5036：终态回执附「查看任务卡片」链接（daemon 走的就是本文件）
import { createCardUrlResolver } from "./shared/card-link-resolver";
// ★ Task #4568：把 CLI 入口也变成一个 EventSource（cli-command）
import {
  emitCliTriggerEvent,
  toCliEnvEvent,
  formatTriggerEcho,
  writeTriggerEcho,
} from "./shared/cli-trigger-event";
import { hasActiveDescendants } from "./shared/esc-active-descendant";
import { CliQuietModeService } from "../services/quiet-mode.service";
import { 
  COLORS,
  abortStream, 
  resetStreamAbort 
} from "../services/stream-output.service";
import { createLogger, getTracerProvider, setStdoutStrictMode, type ContentPart, type SpanContext } from "@ai-setting/roy-bot-core";
import { InputHandler } from "./input-handler";
import { startEventSources } from "./interactive-event-sources";
import {
  collectEventSourceSystemPrompts,
  joinResolvedSystemPrompts,
  type ResolvedEventSourcePrompt,
} from "./collect-event-source-system-prompts";
import {
  parseOptionsFromQuery,
  formatAskUserOutput,
  parseUserInput,
  ASK_USER_TIMEOUT_MS,
  isAskUserTimeoutSentinel,
  type AskUserErrorInfo,
} from "./shared/ask-user-handler";
import {
  createAskUserTimeoutSentinel,
  withAskUserTimeoutRace,
} from "./shared/ask-user-timeout";

// ============================================================================
// Re-export ask_user timeout helpers from ask-user-timeout
// （保持向后兼容：旧代码/测试可能通过 `interactive.ASK_USER_TIMEOUT_MS` 引用）
// ============================================================================

export {
  ASK_USER_TIMEOUT_MS,
  ASK_USER_TIMEOUT_SENTINEL_PREFIX,
  isAskUserTimeoutSentinel,
  createAskUserTimeoutSentinel,
} from "./shared/ask-user-timeout";
import { shutdownInteractiveSteps } from "./interactive-shutdown";
import { registerShutdownHandlers } from "./lifecycle";
// ★ Task #5117 (M1): headless 摘要渲染器（[event]/[result]/[lifecycle]/[fatal]）
import { RunHeadlessSummary } from "./run-headless-summary";
// ★ Task #5117 (M1): headless 事件分发器（N7 语义平移）
import { HeadlessDispatcher } from "./run-headless-dispatch";

// AskUserError 类型（从 core 导入）
import { AskUserError, cascadeStopSessionTree } from "@ai-setting/roy-bot-core";
// Task #4418: React 中断必须反馈到飞书（规则表 + 去重，见 core/env/error-reply.ts）
import { notifyReactFailure } from "@ai-setting/roy-bot-core/env/error-reply";
import {
  buildActAgentContext,
  validateActAgent,
  type ActAgentLookup,
} from "./act-agent-validation";
// ★ Task #4634：CLI --model / --fallback-model → AgentContext 的统一接线
import {
  buildModelAgentContext,
  checkFallbackModelArg,
  FALLBACK_MODEL_DESCRIBE,
  MODEL_DESCRIBE,
} from "./model-flags";
// F1: format the cache / usage one-liner after each LLM call
import { formatCacheLine } from "./shared/usage-formatter";
// Task #2252: UI 改造（欢迎卡 / 输入槽位 / 状态栏 / 状态点）
import {
  printWelcomeCard,
  printSlotTopBorder,
  printSlotBottomBorder,
  printStatusBarHint,
  buildStatusBarForREPL,
  detectGitBranch,
  shortModelName,
  type REPLMode,
} from "./ui";
import { getPackageVersion } from "../lib/version";

// 创建 cli 模块日志器
const logger = createLogger("cli:interactive");

export interface InteractiveOptions {
  session?: string;
  continue?: boolean;
  config?: string;
  reasoning?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
  eventSource?: string;  // 启动时一并启动的事件源 ID
  plugins?: string[];   // 启用的 coder 插件列表，如 ["lsp", "linter", "typecheck"]
  model?: string;       // 使用的模型
  // ★ Task #4634：兜底模型（providerId/modelId）
  fallbackModel?: string | string[];
  defaultAgentName?: string;  // 默认 agent 名字（替换 default prompt 里的 {{agent_name}} 占位符）
}

// yargs 参数别名映射
export interface ParsedInteractiveOptions {
  session?: string;
  continue?: boolean;
  config?: string;
  reasoning?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
  eventSource?: string;
  plugins?: string[];
  model?: string;
  // ★ Task #4634：兜底模型（providerId/modelId）
  fallbackModel?: string | string[];
  defaultAgentName?: string;  // 默认 agent 名字
}

interface REPLStatus {
  sessionId: string;
  sessionTitle: string;
  messageCount: number;
  tokenCount: number;
}

interface REPLOptions {
  sessionId: string;
  sessionTitle: string;
  // Task #2252: 可选 — 用于欢迎卡显示后端模型名
  model?: string;
  // Task #2252: 可选 — 用于欢迎卡显示版本号
  version?: string;
  // P2: 接受 string (text-only) 或 ContentPart[] (多模态)
  onExecute: (message: string | ContentPart[], traceId?: string, agentContext?: any) => Promise<string>;
  /**
   * F1 (review-cache-stability.md): invoked after every successful `onExecute`
   * with the most recent LLM usage info. REPL uses this to render the
   * `💰 Cache: read X / write Y (...)` line so users can observe cache
   * effectiveness in interactive mode.
   *
   * Optional for backwards compatibility — older callers (tests, mocks)
   * that don't supply this callback still work.
   */
  onAfterExecute?: (usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | null) => void | Promise<void>;
  onStatus: () => REPLStatus | Promise<REPLStatus>;
  onSwitchSession: (sessionId: string) => Promise<{ sessionId: string; sessionTitle: string }>;
  onCompact: () => Promise<void>;
  onShutdown: () => Promise<void>;  // shutdown 回调，用于清理资源
  /**
   * Optional renderer override used by integration tests. Production callers
   * omit this and startInk() dynamically imports renderInkREPL. Supplying a
   * renderer keeps the real startInk/REPLInk callback chain testable without
   * globally mocking the repl-ink module (which would race with parallel Bun
   * test files).
   */
  inkRenderer?: (props: import("./repl-ink").REPLInkProps) => Promise<void>;
  /**
   * Task #2280: 启用 ink REPL (v5) 替代 readline。
   *
   * 启用后：
   * - Alt+Enter 真正可用（ink <TextInput> + useInput hook）
   * - bracketed paste 真正可用（ink 原生处理 \x1b[200~...\x1b[201~）
   * - 流式响应通过 React state 集成（chunk callback）
   * - 启动 escape hatch: ROY_AGENT_NO_INK=1（即使 useInk=true 也走 readline）
   *
   * 默认 false（保持向后兼容 1238 个现有测试）。
   * 真正的生产入口在 interactive.ts handler 闭包里显式 useInk: true。
   */
  useInk?: boolean;
  /**
   * Task #2280: ink REPL 集成的 chunk 回调。
   * 让 external 代码（interactive.ts）能 push 每个 LLM chunk 到 ink state。
   */
  onChunk?: (event: import("../services/stream-output.service").StreamChunkEvent) => void;
}

// 用户输入提示符（带颜色）
// Task #2264 P0: 改用 COLORS.accent (暖红) 贯穿品牌色，与欢迎卡 / 状态点统一。
// 短前缀让 readline 反复输出时不影响布局。
const USER_PROMPT = COLORS.accent("❯ ");

/**
 * Task #1967: ask_user 等待超时（默认 2 分钟）
 *
 * 一旦 ask_user 工具触发，REPL 会把 `isExecuting=true` 持续保持。
 * 如果用户 2 分钟内不回答：
 *   - 飞书/事件源消息因为 `EventHandler.waitForIdle()` 死循环而无法处理
 *   - 主 session 永久占用
 *
 * 超时后会：
 *   - 移除 `rl.on('line', ...)` 监听器
 *   - 清理 `setTimeout` 句柄
 *   - 返回一个 sentinel 字符串给调用方，让上层决定如何处理
 *   - 主 session 重新可处理消息
 *
 * 默认值 = 120000ms（生产要求），导入自 shared/ask-user-handler。
 * 可通过 `REPL.askUserTimeoutMs` 或 `promptUser(question, options, errorInfo, { timeoutMs })` 注入更短的值。
 *
 * sentinel 格式：`__ASK_USER_TIMEOUT__:<json>`
 */

/**
 * REPL - 简化的 REPL 实现
 */
export class REPL {
  /**
   * readline Interface 实例。
   * Task #2280: ink REPL 路径下为 null（startInk 不创建）。
   * 所以声明为 optional — 现有代码用 this.rl.xxx 都加可选链保护。
   */
  private rl: readline.Interface | null;
  private options: REPLOptions;
  /**
   * ★ Task #4486: 执行态按 session 隔离。
   *
   * 原实现是单布尔 `isExecuting`，只要有任何一轮 agent 在跑，状态栏 / 输入
   * 提示 / ESC 判定全都当"忙"。per-session 并发后必须按 session 分别跟踪：
   * - 同一个 session 仍视为忙（该 session 的后续消息要排队）
   * - 不同 session 互不影响
   *
   * `isExecuting` 保留为**派生 getter**（是否有任何 session 计数 > 0），
   * 给状态栏 / 输入提示 / ESC cascade 等"全局视角"继续使用。
   *
   * ★ Task #4515 (H2b): 从 `Set<string>` 改为 `Map<string, number>` **引用计数**。
   *
   *   原因：Set 无法表达"同一 session 有两轮在跑"—— 两次 mark 后 size 仍为 1，
   *   第一轮结束就 `delete` → 门禁提前打开、状态栏误翻 ready、ESC 判定失效。
   *   虽然 H2 根治后"同 session 双跑"理论上不该发生，但用户打字 + 事件并发、
   *   ESC 竞态、失败重试等路径仍可能双重 mark，因此引用计数是防御性必需。
   */
  private executingSessions: Map<string, number> = new Map();
  /**
   * ★ Task #4486: `isExecuting = true` 的 setter 兼容路径使用的占位 session key。
   * 只用于"旧布尔语义"的测试替身；真实执行路径用实际 sessionId。
   */
  private static readonly LEGACY_SESSION_KEY = "__legacy_isExecuting__";
  /** Task #2252: 当前 REPL 模式（用于底部状态栏） */
  private replMode: REPLMode = "ready";
  // Task #2264 P1: 状态栏上下文（cwd/gitBranch/model 启动时探测一次缓存）
  private statusBarCtx: { cwd?: string; gitBranch?: string; model?: string } = {};
  // Task #2278: Alt+Enter 标志 — keypress 中设为 true，line handler 检查后清除
  // readline 无法"撤销"已触发的 line 事件，只能在 line handler 里跳过提交
  private isAltEnterPending = false;
  private commandRegistry: Map<string, () => Promise<void>> = new Map();
  private isShuttingDown = false;
  private env: BaseEnvironment | null = null;
  private inputHandler: InputHandler;
  /** Task #2245 — last ESC press timestamp (for force-stop double-press detection) */
  private lastEscPressTime: number = 0;
  /** Task #2245 — force-stop window: 2s (second press within window → force=true) */
  private static readonly FORCE_STOP_WINDOW_MS = 2000;
  /** keypress listener 引用，用于 shutdown 清理 */
  private keypressHandler?: (str: string, key: readline.Key) => void;
  /** Task #2278: process.stdin 'data' listener 引用，用于 Alt+Enter 兜底 */
  private dataHandler?: (chunk: Buffer) => void;

  // ========================================================================
  // Task #2280: ink REPL 集成字段
  // ========================================================================
  /** ink REPL API（onReady 时设置）。startInk() 期间非 null。 */
  inkApi: import("./repl-ink").REPLInkApi | null = null;
  /** 当前 chunk 回调（透传到 queryExecutor.setChunkCallback）。
   *  startInk() 期间有效，shutdown 时清空（避免后续事件触发到已关闭的 ink api）。 */
  inkChunkCallback:
    | import("../services/stream-output.service").StreamChunkCallback
    | null = null;
  /**
   * Task #2280: 外部注入的 QueryExecutor 引用。
   *  startInk 用它来 setChunkCallback — 透传 LLM chunks 到 ink REPL。
   *  用 any 类型避免对 QueryExecutor 的具体 import 产生循环依赖。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _queryExecutor: any = null;

  // P2: 多模态 attach 状态
  // sessionManager 由外部 (interactive.ts handler) 注入,供 /attach /list /clear /paste 使用
  sessionManager: SessionManager | null = null;
  // Task #1766: sessionComponent 由外部 (interactive.ts handler) 注入，
  // 用于 ensureActiveSession helper 让 EventHandler 和 REPL 共享同一个 active session。
  // 用 Pick<SessionComponent, ...> 只声明 REPL 实际用到的最小方法子集，
  // 避免触发 SessionComponent 完整接口的 deep type 推断（接口很大）。
  sessionComponent: Pick<import("@ai-setting/roy-bot-core").SessionComponent, "getActiveSessionId"> | null = null;
  // /attach <path> 解析后的 path,通过这个临时字段传给 command handler
  // (避免把 path 塞进 commandRegistry 闭包)
  lastAttachPath: string | undefined = undefined;
  /**
   * F1: most recent LLM usage info, populated by `setLastUsage()` after
   * each successful `onExecute`. Used to render the `💰 Cache: ...` line
   * via the `onAfterExecute` hook. `null` when no usage has been reported
   * yet (e.g. provider doesn't support cache fields).
   */
  private lastUsage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | null = null;

  /**
   * Task #1967: ask_user 超时时长（毫秒）。
   *
   * 默认 = ASK_USER_TIMEOUT_MS（120000ms / 2 分钟，生产要求）。
   * 测试可通过构造后直接赋值注入更短时间，避免真实等待 2 分钟。
   */
  askUserTimeoutMs: number = ASK_USER_TIMEOUT_MS;

  /**
   * F1: store the latest usage info so the `onAfterExecute` hook can read it.
   * The outer handler wires this up to `queryExecutor.getLastUsage()` after
   * each `onExecute` returns.
   */
  setLastUsage(usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | null): void {
    this.lastUsage = usage;
  }

  constructor(options: REPLOptions, env?: BaseEnvironment) {
    this.options = options;
    this.env = env ?? null;
    this.inputHandler = new InputHandler();

    // 注册默认命令
    this.registerDefaultCommands();

    // Task #2280: ink 路径不创建 readline（避免占用 stdin 与 ink 冲突）
    if (options.useInk === true) {
      this.rl = null;
    } else {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: USER_PROMPT,
        historySize: 100,
        // Task #2276: terminal: true 启用 bracketed paste mode (现代终端标准)
        // 让 readline 自己管理 raw mode，避免与 keypress listener 冲突
        // 多行 paste 不再因为内部 \n 自动提交，整体作为一条消息
        terminal: true,
      });
    }
  }

  /**
   * 设置环境引用（用于获取 AgentComponent 等组件）
   */
  setEnvironment(env: BaseEnvironment): void {
    this.env = env;
  }

  /**
   * 执行优雅关闭
   * 调用 onShutdown 回调并关闭 readline
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    // 恢复 TTY raw mode（防止后续 stdin.read 触发 EIO）
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode?.(false);
      } catch {
        // 忽略：某些环境 stdin 已被关闭
      }
    }

    // 移除 keypress 监听器（避免后续事件触发 EIO）
    if (this.keypressHandler) {
      try {
        process.stdin.removeListener("keypress", this.keypressHandler);
      } catch {
        // 忽略
      }
      this.keypressHandler = undefined;
    }

    // Task #2278: 移除 data 监听器（Alt+Enter 兜底）
    if (this.dataHandler) {
      try {
        process.stdin.removeListener("data", this.dataHandler);
      } catch {
        // 忽略
      }
      this.dataHandler = undefined;
    }

    // Task #2278: 关闭 bracketed paste mode（恢复 terminal 默认状态）
    if (process.stdout.isTTY) {
      try {
        process.stdout.write("\x1b[?2004l");
      } catch {
        // 忽略
      }
    }

    // Task #2280: 清空 ink chunk callback（避免后续事件触发）
    this.inkChunkCallback = null;

    // 关闭 readline（不再接受输入）
    // ink 路径下 this.rl 不存在（startInk 没创建），用可选链
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        // 忽略
      }
    }

    // 调用 shutdown 回调执行清理
    await this.options.onShutdown();
  }

  private registerDefaultCommands(): void {
    this.commandRegistry.set("exit", async () => {
      await this.shutdown();
      process.exit(0);
    });
    this.commandRegistry.set("quit", async () => {
      await this.shutdown();
      process.exit(0);
    });
    this.commandRegistry.set("q", async () => {
      await this.shutdown();
      process.exit(0);
    });

    this.commandRegistry.set("help", async () => this.printHelp());
    this.commandRegistry.set("h", async () => this.printHelp());

    this.commandRegistry.set("status", async () => this.printStatus());
    this.commandRegistry.set("st", async () => this.printStatus());

    // P2: 旧的 /clear 行为是 console.clear
    // 新的多模态 /clear 同时清空 attach 列表
    // (为了避免破坏现有用户,console.clear 行为保留)
    this.commandRegistry.set("clear", async () => {
      console.clear();
      this.printHeader();
      // Task #2264 bugfix: printHeader 只画欢迎卡，redrawInputArea 画完整输入区
      this.redrawInputArea();
      // Task #2354: ink 模式下 this.rl === null（ink 自己管 prompt），
      // 不调 readline.prompt，避免 TypeError: null is not an object
      // 与 executeInternal finally `if (this.rl) this.rl.prompt(true)` 风格一致
      if (this.rl) {
        this.rl.prompt(true);
      }
      // P2: 同时清空 attach 列表
      this.sessionManager?.clearAttachments();
    });
    this.commandRegistry.set("cls", async () => {
      console.clear();
      this.printHeader();
      this.redrawInputArea();
      // Task #2354: 同 /clear，ink 模式跳过 rl.prompt
      if (this.rl) {
        this.rl.prompt(true);
      }
      this.sessionManager?.clearAttachments();
    });

    this.commandRegistry.set("sessions", async () => {
      this.printSessionsHelp();
    });
    this.commandRegistry.set("s", async () => this.printSessionsHelp());

    this.commandRegistry.set("compact", async () => {
      await this.options.onCompact();
    });
    this.commandRegistry.set("c", async () => {
      await this.options.onCompact();
    });

    // ========================================================================
    // P2: 多模态 slash commands
    // ========================================================================
    this.commandRegistry.set("attach", async () => {
      // 实际参数解析在 handleLine 中,这里不重复解析
      // 通过全局 lastSlashPath 传递
      const path = this.lastAttachPath;
      this.lastAttachPath = undefined;
      if (!path) {
        console.log(`\n${COLORS.error("用法: /attach <path|url>")}`);
        return;
      }
      try {
        await this.sessionManager!.attachImage(path);
        const list = this.sessionManager!.listAttachments();
        console.log(`\n${COLORS.system(`📎 已添加 (共 ${list.length} 张)`)}`);
      } catch (err) {
        console.log(`\n${COLORS.error("❌ 附加失败: " + (err instanceof Error ? err.message : String(err)))}`);
      }
    });

    this.commandRegistry.set("list", async () => {
      const list = this.sessionManager?.listAttachments() ?? [];
      if (list.length === 0) {
        console.log(`\n${COLORS.system("📎 当前没有 attach 图片 (使用 /attach <path> 添加)")}`);
        return;
      }
      console.log(`\n${COLORS.system(`📎 当前 attach 列表 (${list.length} 张):`)}`);
      list.forEach((p, i) => {
        if (p.type === "image") {
          const desc = typeof p.image === "string" ? p.image : `<buffer ${(p.image as any).byteLength ?? 0} bytes>`;
          console.log(`  ${i + 1}. ${desc}`);
        }
      });
    });

    this.commandRegistry.set("paste", async () => {
      const { readClipboardImage } = await import("./shared/clipboard-helper");
      const result = await readClipboardImage();
      if (!result) {
        console.log(`\n${COLORS.error("❌ 剪贴板中没有图片,或剪贴板工具不可用")}`);
        return;
      }
      // 把 buffer 存到 /tmp 并 attach
      const tmpPath = `/tmp/roy-paste-${Date.now()}.${result.mime.split("/")[1] || "png"}`;
      try {
        const fs = await import("node:fs/promises");
        await fs.writeFile(tmpPath, result.buffer);
        await this.sessionManager!.attachImage(tmpPath);
        const list = this.sessionManager!.listAttachments();
        console.log(`\n${COLORS.system(`📎 已粘贴 (共 ${list.length} 张): ${tmpPath}`)}`);
      } catch (err) {
        console.log(`\n${COLORS.error("❌ 粘贴失败: " + (err instanceof Error ? err.message : String(err)))}`);
      }
    });

    // 中断当前请求
    this.commandRegistry.set("abort", async () => {
      if (this.isExecuting) {
        console.log(`\n${COLORS.system("[正在中断...]")}`);
        
        // 1. 中断所有 Agent（包括 delegate_task 的子 agent）
        if (this.env) {
          const agentComponent = this.env.getComponent("agent") as any;
          if (agentComponent?.abortAll) {
            agentComponent.abortAll();
            logger.debug("[/abort] AgentComponent.abortAll() called");
          } else if (agentComponent?.abort) {
            agentComponent.abort("default");
            logger.debug("[/abort] AgentComponent.abort('default') called (fallback)");
          }
        }
        
        // 2. 中断流式输出显示
        //    ★ Task #4486 收尾 review 修复：同 ESC —— 除全局 flag 外，
        //    给每个正在执行的 session 单独打标记，避免下一轮 turn 的
        //    无 scope `resetStreamAbort()` 把中断状态清掉后流"复活"。
        abortStream();
        for (const sid of this.getExecutingSessionIds()) {
          abortStream(sid);
        }

        // 3. ★ Task #4486: /abort 语义 = 中断全部会话 → 清空所有 session 占用
        this.abortAllExecutingSessions();
        
        console.log(`${COLORS.system("[已中断，可以继续输入]")}`);
      } else {
        console.log(`\n${COLORS.system("[没有正在执行的请求]")}`);
      }
    });
  }

  /**
   * Task #2280: 启动 REPL。
   *
   * 分支逻辑：
   * - useInk=true → startInk()
   * - 其他 → startReadline() (原 readline 实现，向后兼容)
   *
   * 注意：useInk 决策（escape hatch + isTTY 检查）由 handler 闭包提前计算，
   * 这里不再重复检查 — 避免非 TTY 模式下 useInk=true 走到 readline 路径导致
   * this.rl === null 抛错的 bug（Task #2281 fix）。
   */
  async start(): Promise<void> {
    if (this.options.useInk === true) {
      return this.startInk();
    }
    return this.startReadline();
  }

  /**
   * Task #2280: ink REPL 启动路径。
   *
   * 用 ink v5 + React 18 替代 readline 解决：
   * - Alt+Enter（ink useInput hook 检测 key.meta + key.return）
   * - bracketed paste（ink <TextInput> 原生处理 \x1b[200~...\x1b[201~）
   *
   * 架构：
   * - renderInkREPL() 启动 ink 渲染
   * - onReady(api) 暴露 REPLInkApi 给外部
   * - onCommand(cmd) 路由 slash command
   * - onSubmit(message) 走 onExecute（与 readline 路径相同的 contract）
   * - onChunk 回调（通过 options.onChunk → StreamOutputService）push 流式 chunks
   *
   * 与 readline 路径的关键差异：
   * - 不创建 this.rl（readline Interface）
   * - 不注册 keypress / data 监听（ink 自己处理）
   * - shutdown 改为调 ink api.exit()
   */
  private async startInk(): Promise<void> {
    // 主动启用 bracketed paste mode（与 readline 路径一致）
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?2004h");
    }

    // 探测 status bar 上下文（与 readline 路径一致）
    let statusBarCtx: { cwd?: string; gitBranch?: string; model?: string } = {};
    try {
      const gitBranch = detectGitBranch();
      const cwd = process.cwd();
      const model = shortModelName(this.options.model);
      statusBarCtx = { cwd, gitBranch, model };
    } catch {
      // 探测失败不致命
    }
    this.statusBarCtx = statusBarCtx;

    // 准备 welcome card context
    const initialContext = {
      model: this.options.model ?? "unknown",
      cwd: statusBarCtx.cwd ?? process.cwd(),
      version: this.options.version ?? "0.0.0",
      sessionTitle: this.options.sessionTitle,
    };

    // 引用：保持 ink api 在 onSubmit / onCommand 闭包外可访问
    let inkApiRef: import("./repl-ink").REPLInkApi | null = null;

    // 启动 ink 渲染。生产环境走默认动态 import；集成测试可注入
    // ink-testing-library renderer，而不必全局 mock repl-ink 模块。
    const renderInkREPL = this.options.inkRenderer ??
      (await import("./repl-ink")).renderInkREPL;
    return new Promise<void>((resolve) => {
      // 包装 onChunk（来自 StreamOutputService）→ 调 ink api
      // 当 user 提交后 onExecute 触发，StreamOutputService 的 emitChunk 会
      // 通过 options.onChunk 传到这里
      const onChunk = (event: import("../services/stream-output.service").StreamChunkEvent) => {
        if (!inkApiRef) return;
        switch (event.type) {
          case "llm.text":
            inkApiRef.appendAssistantDelta(event.delta ?? "");
            break;
          case "llm.completed":
            inkApiRef.finishAssistantStream();
            // Task #4396: attach this call's cache/token usage so the TUI
            // renders a dim grey footer under the assistant message.
            // `event.usage` is undefined when the provider reports nothing,
            // in which case attachUsage is a no-op and no footer is drawn.
            if (event.usage) {
              inkApiRef.attachUsage(event.usage);
            }
            break;
          case "tool.call":
            inkApiRef.appendMessage({
              role: "tool",
              content: event.toolArgs ? JSON.stringify(event.toolArgs) : "",
              toolName: event.toolName,
            });
            break;
          case "tool.result":
            inkApiRef.appendMessage({
              role: "tool_result",
              content:
                typeof event.toolResult === "string"
                  ? event.toolResult.substring(0, 200)
                  : JSON.stringify(event.toolResult ?? "").substring(0, 200),
              toolName: event.toolName,
            });
            break;
          case "tool.error":
            inkApiRef.appendMessage({
              role: "system",
              content: `[tool error] ${event.toolName ?? "?"}: ${event.toolError ?? ""}`,
            });
            break;
          case "llm.reasoning":
            // 推理内容不展开（保持 stdout 路径的简单显示）
            break;
        }
      };

      // 把 onChunk 暴露给外部 closure（queryExecutor 通过这个调）
      // 实际机制：interactive.ts handler 在 useInk=true 时调
      //   repl.inkChunkCallback = onChunk;
      //   queryExecutor.setChunkCallback(repl.inkChunkCallback);
      this.inkChunkCallback = onChunk;

      // Task #2280: 透传 chunk callback 到 queryExecutor
      // 这样 StreamOutputService 的 emitChunk 会触发 onChunk → inkApiRef.appendAssistantDelta
      if (this._queryExecutor && typeof this._queryExecutor.setChunkCallback === "function") {
        this._queryExecutor.setChunkCallback(onChunk);
      }

      // 启动 ink
      renderInkREPL({
        initialContext,
        initialMode: "ready",
        initialStatusBarCtx: statusBarCtx,
        onReady: (api) => {
          inkApiRef = api;
          // 暴露给其他方法（shutdown 等）
          this.inkApi = api;
        },
        onSubmit: async (input) => {
          // Task #2297 follow-up: ink REPL 路径必须把 this.isExecuting 置 true，
          // 否则 handleEscKey() 的 `canCascade = isExecuting || hasActiveDescendant`
          // 守卫会把 ESC 当作 idle no-op 处理，abortAll/cascadeStopSessionTree 永远不被调用。
          // readline 路径通过 executeInternal() (run.ts:1109) 设置此标志，但 ink 路径
          // 绕过 executeInternal 直接调 this.options.onExecute(input)。
          // ★ Task #4486: 用 per-session 标记（ink 单会话 → 用 REPL 默认 session）
          const inkSessionId = this.options.sessionId;
          this.markSessionExecuting(inkSessionId, true);
          // 进入 executing 状态
          inkApiRef?.setMode("executing");
          // 走 onExecute（与 readline 路径相同 contract）
          try {
            await this.options.onExecute(input);
            inkApiRef?.setMode("ready");
            // 调 onAfterExecute（F1 cache line）
            if (this.options.onAfterExecute) {
              try {
                await this.options.onAfterExecute(this.lastUsage);
              } catch (hookError) {
                logger.warn("onAfterExecute hook failed (ink path)", { error: String(hookError) });
              }
            }
          } catch (err) {
            inkApiRef?.setMode("ready");
            const msg = err instanceof Error ? err.message : String(err);
            inkApiRef?.appendMessage({ role: "system", content: `[Error] ${msg}` });
            throw err;
          } finally {
            // Task #2297 follow-up: finally 块保证 isExecuting 一定被重置（即便 ESC 已把它置回 false）。
            // ★ Task #4486: 只释放本 session（ESC 走 abortAllExecutingSessions 已清空，这里是幂等兜底）
            this.markSessionExecuting(inkSessionId, false);
          }
        },
        onCommand: async (cmd) => {
          return this.handleInkCommand(cmd, inkApiRef);
        },
        // Task #2294 hotfix: 桥接 ink REPL ESC → interactive.handleEscKey()
        // 之前 ink REPL 按 ESC 只清空 buffer，从不触发 cascade stop，导致无法中断 in-flight execution
        onEscape: () => this.handleEscKey(),
      }).then(async () => {
        // ink 退出后调 shutdown
        await this.shutdown();
        resolve();
      }).catch(async (err) => {
        logger.error("ink REPL render failed", { error: String(err) });
        await this.shutdown();
        resolve();
      });
    });
  }

  /**
   * Task #2280: 处理 ink REPL 收到的 slash command。
   *
   * 与 readline 路径共享 commandRegistry 逻辑。
   * 返回 true 表示已处理；false 表示 unknown command。
   */
  private async handleInkCommand(
    cmdInput: string,
    inkApi: import("./repl-ink").REPLInkApi | null,
  ): Promise<boolean> {
    // cmdInput 不含前导 / — 例如 "help" / "exit" / "clear" / "compact"
    const [cmd] = cmdInput.split(/\s+/);
    const commandName = cmd.toLowerCase();

    // 路由到 commandRegistry
    const handler = this.commandRegistry.get(commandName);
    if (!handler) {
      // unknown command
      inkApi?.appendMessage({
        role: "system",
        content: `[未知命令: /${commandName}] 输入 /help 查看所有命令`,
      });
      return false;
    }

    try {
      await handler();
      // 切回 ready
      inkApi?.setMode("ready");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      inkApi?.appendMessage({
        role: "system",
        content: `[命令失败: /${commandName}] ${msg}`,
      });
      return true;
    }
  }

  /**
   * Task #2280: 启动 readline REPL (原实现，Task #2278 bugfix 后的版本)。
   * 保留为 fallback — 当 useInk=false / !isTTY / ROY_AGENT_NO_INK=1 时使用。
   */
  private async startReadline(): Promise<void> {
    // Task #2278 P0: 主动启用 bracketed paste mode
    // terminal: true 让 readline 接受 bracketed paste，但不会主动发送启用序列
    // 真实 terminal（macOS Terminal/iTerm/xterm）默认启用；PTY/script 默认不启用
    // 主动发送确保所有环境（真实 TTY、expect、script）都能识别多行 paste
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?2004h");
    }

    this.printHeader();

    // Task #2264 P0: 启动后立即显示初始 prompt（让用户看到 ❯ 提示符）
    // readline.createInterface 只设置 prompt 属性，不会自动显示
    // Task #2264 bugfix: 用 redrawInputArea() 保证第一次 prompt 时也有完整输入区
    this.redrawInputArea();
    // Task #2354: 防御性守卫 — 极端 case 下 readline.createInterface 可能返回 null
    // （shutdown race / 测试 mock）。与 executeInternal finally `if (this.rl)` 风格一致
    if (this.rl) {
      this.rl.prompt(true);
    }

    // Task #2276: 不再手动 setRawMode，readline 自己管理（terminal: true 后）
    // 设置 Esc 按键监听
    readline.emitKeypressEvents(process.stdin);

    // Task #2278 bugfix: 重新启用 setRawMode(true)
    // terminal: true + emitKeypressEvents 不足以让 ESC 字节通过 PTY 到 readline。
    // 终端 driver 在 cooked mode 下会"吃" ESC 字节（尝试解析为 escape sequence 失败）。
    // 启用 raw mode 后所有字节直通：
    //   - Alt+Enter (ESC + \r) 不被拆开，能触发 data handler
    //   - Bracketed paste markers (ESC[200~...ESC[201~) 不被吃，readline 能识别 paste
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(true);
    }

    // 监听 keypress 事件（保存引用便于 shutdown 时清理）
    this.keypressHandler = (str: string, key: readline.Key) => {
      // 保护：shutdown 中不应处理 keypress
      if (this.isShuttingDown) return;

      // Task #2276: Alt+Enter 从"提交"改成"插入换行"
      // 对齐 Claude Code / Codex — Enter 提交，Alt+Enter 换行（多行编辑）
      // readline 会把多行 buffer 一起作为单条 line 事件
      // Task #2278 bugfix: 多条件兜底（key.meta 不可靠时用 str 检测 ESC 字符）
      // 由于 readline keypress 之后会立即触发 line 事件（不可取消），
      // 这里用 isAltEnterPending 标志让 line handler 跳过本次提交，
      // 然后 rl.write("\n") 在下一次 prompt 之前插入换行
      if (key.name === "return" && (key.meta || str === "\x1b" || str.includes("\x1b"))) {
        this.isAltEnterPending = true;
        // 延迟插入换行（line event 之后），用 setImmediate 跳出当前事件循环
        setImmediate(() => {
          this.rl.write("\n");
          this.isAltEnterPending = false;
        });
        return;
      }

      // Esc 按键: key.name === "escape"
      if (key.name === "escape") {
        // Task #2245 — Codex v2 P1 fix: attach .catch to the voided
        // promise so sync throws inside handleEscKey (e.g. if
        // agentComponent.abortAll throws) don't become unhandled
        // rejections. Without this, Node 22+ would terminate the
        // process on any sync throw that bypassed the inner try/catch.
        void this.handleEscKey().catch((err: unknown) => {
          logger.warn(`[Esc] handleEscKey failed: ${err}`);
        });
      }
    };
    process.stdin.on("keypress", this.keypressHandler);

    // Task #2278 bugfix: 加 process.stdin 'data' 监听作为 Alt+Enter 兜底
    // 跨终端通用：识别 \x1b\r (macOS Terminal/iTerm/xterm/Linux) 和
    //              \x1b[13;5~ (iTerm2 alt mode)
    // 之前 keypress handler 不可靠（meta 检测有时失败）
    this.dataHandler = (chunk: Buffer) => {
      if (this.isShuttingDown) return;
      const data = chunk.toString("utf8");
      // Alt+Enter 模式：\x1b\r (ESC + CR) 或 \x1b[13;5~ (modified key)
      if (data === "\x1b\r" || data.startsWith("\x1b\r") || data === "\x1b[13;5~") {
        this.rl.write("\n");
      }
    };
    process.stdin.on("data", this.dataHandler);

    // 返回 Promise，等待 REPL 真正关闭才 resolve
    return new Promise<void>((resolve) => {
      this.rl.on("line", async (line) => {
        // Task #2278: Alt+Enter 触发后，readline 立即发射 line 事件（不可取消）
        // 跳过提交，让 isAltEnterPending 在 setImmediate 中插入换行
        if (this.isAltEnterPending) {
          // 保持 flag 状态 — keypress handler 的 setImmediate 会重置
          return;
        }
        await this.handleLine(line.trim());
      });

      this.rl.on("close", () => {
        console.log("\n再见！👋\n");
        resolve();
      });
    });
  }

  private async handleLine(line: string): Promise<void> {
    // 保护：shutdown 中不应继续处理输入
    if (this.isShuttingDown) {
      return;
    }

    // Task #2276: Enter = 提交（主路径）
    // readline 的 line 事件在用户按 Enter 时触发。
    // 多行 Alt+Enter 通过 rl.write("\n") 插入换行，readline 把整段作为单条 line（含 \n）。
    // 多行 paste 通过 bracketed paste mode 整体作为单条 line（含 \n）。
    //
    // 因此这里直接处理 line（不再 push 到 buffer 等 Alt+Enter）。
    // 保留 buffer 检查是 slash command 的特殊场景（确保非累积场景下第一个字符 / 仍是命令）。

    // 空行静默忽略（避免空消息触发 LLM 调用）
    if (line.trim() === "") {
      this.updatePrompt();
      return;
    }

    // 快捷命令（以 / 开头）
    if (line.startsWith("/") && this.inputHandler.getBuffer() === "") {
      // P2: 解析带参数的 slash command (如 /attach <path>)
      // 把 path 暂存到 lastAttachPath 给 /attach handler 用
      const { parseSlashCommand } = await import("./shared/slash-commands");
      const slash = parseSlashCommand(line);
      if (slash?.type === "attach") {
        this.lastAttachPath = slash.path;
      }
      await this.handleCommand(line.slice(1));
      this.inputHandler.reset();
      this.updatePrompt();
      return;
    }

    // 普通消息（Task #2276: Enter 直接提交，不再累积 buffer）
    // 注意：line 可能含 \n（来自 Alt+Enter 或 paste），handleMessage 会作为完整消息发送
    this.inputHandler.reset();
    await this.handleMessage(line);
    this.updatePrompt();
  }

  /**
   * Task #2264 bugfix: 每次 re-prompt 前重画完整输入区
   * 
   * 之前只 printSlotBottomBorder() + rl.prompt(true)，导致第二轮之后
   * 顶部边框和状态栏消失，只剩孤立的 ❯ prompt。
   * 
   * 现在每次都打印 [顶部边框 → 状态栏 → 底部边框]，
   * 然后让 readline 输出 ❯ prompt。
   * 保证多轮对话下输入区持续可见。
   */
  private redrawInputArea(): void {
    if (!process.stdout.isTTY) return;
    // 用缓存的 statusBarCtx 重新打印 status bar（保持与 printHeader 一致）
    printSlotTopBorder();
    printStatusBarHint({
      cwd: this.statusBarCtx.cwd,
      gitBranch: this.statusBarCtx.gitBranch,
      model: this.statusBarCtx.model
        ? shortModelName(this.statusBarCtx.model)
        : undefined,
    });
    printSlotBottomBorder();
  }

  /**
   * 更新 readline 提示符
   *
   * Task #2264 P0: 在 rl.prompt(true) 之前打印输入区底部边框，
   * 让 ❯ 持续显示在顶边-底边-❯ 循环结构中。
   *
   * Task #2264 bugfix: 现在用 redrawInputArea() 同时重画顶部边框和状态栏，
   * 让多轮对话下输入区持续可见。
   */
  private updatePrompt(): void {
    // Task #2274 P0: 强制使用 ❯ 作为 prompt 字符，避免第 2/3 轮变 ...
    // 根因：InputHandler.pushLine() 后没 reset，getPrompt() 返回 continuation prompt
    // 多行能力仍保留：用户可用 Alt+Enter 进入多行编辑（readline 自己管理）
    // Task #2354: ink 模式下 this.rl === null（ink 自己管 prompt），
    // 守卫 setPrompt + prompt 两个调用，避免 TypeError
    if (this.rl) {
      this.rl.setPrompt(COLORS.accent("❯ "));
      // 重画完整输入区 [顶边 → 状态栏 → 底边]
      this.redrawInputArea();
      this.rl.prompt(true);
    } else {
      // ink 模式仍需要 redraw UI（让输入区可见）
      this.redrawInputArea();
    }
  }

  /**
   * Task #2276: finishInput 已废弃（之前 Alt+Enter 调用以提交 buffer）
   * 现在 Enter 直接提交（readline line 事件），Alt+Enter 插入换行
   * 整个方法删除 — 无调用方，保留会增加维护成本
   */

  private async handleCommand(input: string): Promise<void> {
    const [cmd] = input.split(/\s+/);
    const command = this.commandRegistry.get(cmd.toLowerCase());

    if (command) {
      await command();
    } else {
      console.log(`\n${COLORS.error("❓ 未知命令: /" + cmd + "}")}`);
      this.printHelp();
    }
  }

  private async handleMessage(message: string): Promise<void> {
    // ★ Task #4486: 用户输入只受**同一个 session** 的占用约束。
    //   原来的全局 isExecuting 会让"别的会话在跑"也挡住你打字，并发化后不成立。
    const inputSessionId = this.options.sessionId;
    if (!this.isSessionIdle(inputSessionId)) {
      console.log(`\n${COLORS.system("⏳ 上一次请求尚未完成，请稍候...")}\n`);
      return;
    }

    // Task #1766: 确保有 active session
    // 极端情况下兜底（sessionManager.init() 在启动时已 setActiveSession），
    // 这里再检查一次避免被边缘 case 破坏。
    await this.ensureActiveSession();

    // P2: 多模态拼装
    // - 0 张图 → 保持 string (backward compat, 避免 microtask 开销)
    // - ≥1 张图 → ContentPart[] (text first, then attachments)
    const payload: string | ContentPart[] = this.sessionManager
      ? await this.sessionManager.getQueryPayload(message)
      : message;

    await this.executeInternal(payload, { showPrompt: false });
  }

  /**
   * Task #1766: 确保有 active session
   *
   * SessionManager.init() 在 interactive 启动时已经做过 setActiveSession，
   * 但每次入口（用户输入/event 处理）再确认一次，避免被边缘 case 破坏。
   * 如果 active session 丢失，兜底调 sessionManager.init() 重新初始化。
   */
  private async ensureActiveSession(): Promise<void> {
    if (!this.sessionComponent) return;
    try {
      const activeId = this.sessionComponent.getActiveSessionId();
      if (!activeId && this.sessionManager) {
        // 兜底：极端情况下补一个
        await this.sessionManager.init(undefined, false);
      }
    } catch (error) {
      console.error(`[REPL] Failed to ensure active session:`, error);
    }
  }

  /**
   * 处理事件消息（来自 EventHandler）
   * 显示为用户输入，并执行 agent
   */
  async handleEventMessage(message: string): Promise<void> {
    // 显示事件消息（带颜色）
    // 显示事件消息（带颜色）
    console.log(`\n${COLORS.system("[通知] ❯ " + message.replace(/\n/g, "\n" + COLORS.system("[通知] ❯ ")))}\n`);
    await this.executeInternal(message, { showPrompt: true });
  }

  /**
   * 处理事件消息（包含完整 EnvEvent，用于构建 pluginEnabled）
   */
  async handleEventMessageWithEnv(formattedEvent: { message: string; envEvent: any; eventSessionId?: string; chatId?: string }): Promise<void> {
    const { message, envEvent, eventSessionId } = formattedEvent;

    // Task #3147 — 标准 notify event 流程
    //
    // task.background.ask_user 不再 special-case，跟其他 task.background.* 事件
    // 一样走下面的「显示 → executeInternal」路径：formatter 已把 query + subSessionId
    // + rule-based hints 渲染成消息，主 agent 收到后用 ask_user tool 把问题展示给
    // 用户，拿到用户答复后通过 delegate_task(subagent_type, sub_session_id, ...)
    // 复用 sub-session 续传（无需 resume function）。
    //
    // 显示事件消息（带颜色）
    console.log(`\n${COLORS.system("[通知2] ❯ " + message.replace(/\n/g, "\n" + COLORS.system("[通知2] ❯ ")))}\n`);

    // Task #1766: 确保有 active session
    // event 路径入口再确认一次（让 EventHandler 和 REPL 共享同一个 active session）
    await this.ensureActiveSession();
    
    // 从 envEvent.metadata 提取 pluginEnabled
    // 优先使用已经构建好的 pluginEnabled（来自 event-source-handlers.ts 的修复）
    const sourceId = envEvent.metadata?.sourceId;
    let pluginEnabled = envEvent.metadata?.pluginEnabled as Record<string, boolean> | undefined;
    let plugins = envEvent.metadata?.plugins as string[] | undefined;
    
    // 如果 pluginEnabled 未构建（兼容旧代码），则从 plugins 构建
    if (!pluginEnabled || Object.keys(pluginEnabled).length === 0) {
      pluginEnabled = {};
      for (const pluginName of (plugins || [])) {
        const key = `${sourceId}:${pluginName}`;
        pluginEnabled[key] = true;
      }
    }
    
    // 提取 handleRule.agent（从 envEvent metadata 中由 event-source-handlers 注入）
    const agentFromEvent = envEvent.metadata?.agent as string | undefined;

    // Task #3058: 处理 replyChannel fallback（notify event 修复）
    //
    // - lark/bounty event (event-source.event.*)：metadata 有 replyChannel
    //   → 直接用，并更新 lastReplyChannel 作为后续 task.background.* 的兜底
    // - task.background.* event：metadata 没有 replyChannel（BackgroundTaskManager
    //   不知道 IM 来源）
    //   → fallback 用 lastReplyChannel，让父 agent 处理通知后能回复到原 IM 会话
    //
    // 不能直接 mutate 原始 envEvent（EventHandler 可能有其他订阅者），
    // 所以用浅拷贝 envEvent + 浅拷贝 metadata 注入 replyChannel。
    let envEventForAgent = envEvent;
    const eventReplyChannel = envEvent?.metadata?.replyChannel;
    // ★ #4108 P1-a（+ #4038）：lastReplyChannel 由"单值缓存"改为"按 chatId 缓存"。
    //   单值时多群并发切换会 last-write-wins，fallback 会命中别的群（串会话）。
    //   这里优先按本次事件的 chatId 精确取回该群的 replyChannel；取不到再用
    //   全局兜底（保持旧行为，兼容无 chatId 的事件）。
    const eventChatId =
      (eventReplyChannel as { chatId?: string } | undefined)?.chatId ??
      formattedEvent.chatId ??
      (envEvent as { payload?: { replyChannel?: { chatId?: string } } })?.payload
        ?.replyChannel?.chatId;

    if (eventReplyChannel) {
      // 本次事件有 replyChannel → 更新缓存（全局 + per-chat）
      this.lastReplyChannel = eventReplyChannel;
      const rcChatId = (eventReplyChannel as { chatId?: string }).chatId;
      if (rcChatId) this.rememberReplyChannelForChat(rcChatId, eventReplyChannel);
    } else {
      // 本次事件没有 replyChannel → 优先按 chatId 取回该群的，再退全局兜底
      const fallbackChannel =
        (eventChatId ? this.lastReplyChannelByChat?.get(eventChatId) : undefined) ??
        this.lastReplyChannel;
      if (fallbackChannel) {
        // 注入到 envEvent.metadata，让 agent-component._run 通过
        // envEvent.metadata.replyChannel 拿到，进而把回复路由到原 IM 会话
        envEventForAgent = {
          ...envEvent,
          metadata: {
            ...(envEvent?.metadata ?? {}),
            replyChannel: fallbackChannel,
          },
        };
      }
    }

    // ★ Task #4486: agentContext 显式传给 executeInternal，不再写 this.currentAgentContext
    //   （单槽在并发多 session 时会被后一个事件覆盖 → envEvent / replyChannel 串味）。
    const agentContext = {
      agentType: agentFromEvent,
      pluginEnabled,
      envEvent: envEventForAgent,
      plugins,
      // EventSource Shared Session: 传递事件共享 session ID
      eventSessionId: eventSessionId,
      // Phase B.11+ P1-3 修复: 把 EventSource systemPrompt 透传给 query-executor，
      // 它会把 systemPrompt 移到 context.metadata.systemPrompt，
      // 由 AgentComponent._run 追加到 LLM system message。
      // 之前缺失导致：user 在 event-sources.json 配置的 systemPrompt 永远不到 LLM。
      systemPrompt: envEvent.metadata?.systemPrompt as string | undefined,
      // ★ Task #5333：渠道专用工具放行名单（channelOnly 工具可见性）
      //   ES handler 写入 evt.metadata.extendTools → AgentContext.extendTools
      //   → AgentComponent.getAvailableTools 放行 channelOnly 工具。
      extendTools: envEvent.metadata?.extendTools as string[] | undefined,
    };

    // 执行（显式传参：sessionId 决定 per-session 占用与下游路由）
    await this.executeInternal(message, {
      showPrompt: true,
      sessionId: eventSessionId,
      agentContext,
    });
  }

  /**
   * Task #3058 / #4108 P1-a: replyChannel 缓存
   *
   * 用于 subagent notify event (task.background.*) 触发新一轮 query 时，
   * 把上一次的 lark/bounty IM replyChannel 注入到 envEvent.metadata，
   * 让 agent 处理通知后的回复能路由回原 IM 会话。
   *
   * ★ #4108 P1-a 修复：新增 per-chatId 缓存（lastReplyChannelByChat），
   *   多群并发时按事件 chatId 精确取回，避免单值缓存 last-write-wins 串会话。
   *   lastReplyChannel 保留为"无 chatId 事件"的全局兜底（向后兼容）。
   */
  private lastReplyChannel: any = undefined;
  /** chatId → replyChannel（带上限的 LRU）；见 rememberReplyChannelForChat */
  private lastReplyChannelByChat: Map<string, any> = new Map();
  /** per-chat replyChannel 缓存上限（超过则淘汰最旧） */
  private static readonly REPLY_CHANNEL_CHAT_CACHE_MAX = 100;

  /**
   * 记录指定 chatId 的 replyChannel（LRU，超过上限淘汰最旧）。
   */
  private rememberReplyChannelForChat(chatId: string, channel: any): void {
    // 懒初始化（防御 Object.create(prototype) 构造的测试替身）
    if (!this.lastReplyChannelByChat) this.lastReplyChannelByChat = new Map();
    if (this.lastReplyChannelByChat.has(chatId)) {
      this.lastReplyChannelByChat.delete(chatId);
    }
    this.lastReplyChannelByChat.set(chatId, channel);
    while (this.lastReplyChannelByChat.size > REPL.REPLY_CHANNEL_CHAT_CACHE_MAX) {
      const oldest = this.lastReplyChannelByChat.keys().next().value;
      if (oldest === undefined) break;
      this.lastReplyChannelByChat.delete(oldest);
    }
  }

  /**
   * 检查是否正在执行
   *
   * 注意：EventSource 预加载的 systemPrompt 不属于 REPL instance 状态。
   * 它是 per-invocation 状态，存放在 `createInteractiveCommand` 返回的
   * handler 闭包中的 `eventSourceSystemPrompts` (let 变量) 里。
   * (Phase 3)
   */
  isIdle(): boolean {
    return !this.anySessionBusy();
  }

  /** ★ Task #4515 (H2b): 是否有任何 session 的引用计数 > 0 */
  private anySessionBusy(): boolean {
    for (const count of this.execSet().values()) {
      if (count > 0) return true;
    }
    return false;
  }

  /**
   * ★ Task #4486: 懒初始化 executingSessions。
   *
   * 为什么需要：测试大量用 `Object.create(REPL.prototype)` 造替身，
   * **类字段初始化器不会执行**，executingSessions 会是 undefined。
   * （本文件里 lastReplyChannelByChat 已有同类防御，保持一致风格。）
   */
  private execSet(): Map<string, number> {
    if (!this.executingSessions) this.executingSessions = new Map();
    return this.executingSessions;
  }

  /**
   * ★ Task #4486: `isExecuting` 派生值（全局视角：是否有任何 session 在跑）。
   *
   * 兼容旧语义：状态栏 / 输入提示 / ESC cascade 继续读它。
   * per-session 判定请用 isSessionIdle()。
   *
   * setter 仅为**向后兼容**保留（大量既有测试用 `repl.isExecuting = false`
   * 模拟执行态；真实执行路径已全部改用 markSessionExecuting）：
   * - `= true`  → 给一个 legacy 占位 session，让全局视角"忙"
   * - `= false` → 清空所有 session（旧布尔语义 = 全部空闲）
   */
  get isExecuting(): boolean {
    return this.anySessionBusy();
  }

  set isExecuting(executing: boolean) {
    if (!executing) {
      this.execSet().clear();
      return;
    }
    this.execSet().set(REPL.LEGACY_SESSION_KEY, 1);
  }

  /**
   * ★ Task #4486: 标记某 session 进入 / 退出执行态（幂等）。
   */
  markSessionExecuting(sessionId: string, executing: boolean): void {
    const counts = this.execSet();
    if (executing) {
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
      return;
    }
    const current = counts.get(sessionId) ?? 0;
    if (current <= 1) {
      // 归零（或本就没有）→ 移除；多余的 unmark 不会变负数
      counts.delete(sessionId);
    } else {
      counts.set(sessionId, current - 1);
    }
  }

  /**
   * ★ Task #4486: 某 session 是否空闲（供 EventHandler 做 per-session 门禁）。
   *
   * ★ Task #4515 (H2b): 引用计数为 0 才算空闲。
   */
  isSessionIdle(sessionId: string): boolean {
    return (this.execSet().get(sessionId) ?? 0) <= 0;
  }

  /**
   * ★ Task #4486: 当前正在执行的 session id 列表（诊断 / 状态栏用）。
   *
   * ★ Task #4515 (H2b): 只列引用计数 > 0 的（Map 里可能出现 0 值条目）。
   */
  getExecutingSessionIds(): string[] {
    const ids: string[] = [];
    for (const [sid, count] of this.execSet().entries()) {
      if (count > 0) ids.push(sid);
    }
    return ids;
  }

  /**
   * ★ Task #4486: 清空所有 session 的占用（ESC / /abort 的 abortAll 语义）。
   *
   * 注意这是**全局中断**：ESC 与 /abort 的既有契约就是"中断所有 Agent
   * （包括 delegate_task 的子 agent）"，所以这里确实要清空。
   * 单个 run 正常结束只调 markSessionExecuting(自己, false)。
   */
  abortAllExecutingSessions(): void {
    this.execSet().clear();
  }

  /**
   * Task #2252: 设置当前 REPL 模式（用于底部状态栏）
   *
   * 状态栏会立即重新打印（在 TTY 模式下），用户能看到 mode 切换的反馈。
   */
  setMode(mode: REPLMode, detail?: string): void {
    this.replMode = mode;
    this.printStatusBar(detail);
  }

  /**
   * Task #2252: 打印底部状态栏到 stdout（在 TTY 模式下）。
   *
   * 非 TTY / quiet 模式跳过，避免污染管道 / 日志。
   */
  printStatusBar(detail?: string): void {
    if (!process.stdout.isTTY) return;
    if (CliQuietModeService.getInstance().isQuiet()) return;
    // 用 \r + clear 回到行首再写（避免在多行流中插入额外的换行）
    if (process.stdout.isTTY) {
      process.stdout.write("\r\u001B[2K");
    }
    // Task #2264 P1: 状态栏运行时也展示 cwd/gitBranch/model 上下文（不只有 mode）
    console.log(
      buildStatusBarForREPL({
        mode: this.replMode,
        model: this.statusBarCtx.model,
        cwd: this.statusBarCtx.cwd,
        gitBranch: this.statusBarCtx.gitBranch,
        detail,
      }),
    );
  }

  /**
   * 执行消息并显示结果（内部实现）
   *
   * ★ Task #4486: 执行态按 session 隔离。
   *
   * `options` 显式携带本次执行的 sessionId 与 agentContext（原来是
   * `this.currentAgentContext` 单槽 + 全局 isExecuting 布尔）。单槽在多 session
   * 并发时会被后一个事件覆盖，导致前一个事件拿到别人的 envEvent / replyChannel。
   *
   * 兼容：两个字段都可省略。
   * - `sessionId` 省略 → 回落 `options.sessionId`（REPL 默认会话）
   * - `agentContext` 省略 → 空对象（普通用户输入的语义）
   */
  async executeInternal(
    message: string | ContentPart[],
    options: {
      showPrompt: boolean;
      /** ★ Task #4486: 本次执行归属的 session（per-session 占用 + 下游路由） */
      sessionId?: string;
      /** ★ Task #4486: 本次执行的 agentContext（替代 currentAgentContext 单槽） */
      agentContext?: any;
    }
  ): Promise<void> {
    const execSessionId = options.sessionId ?? this.options.sessionId;
    // ★ Task #4515 (M6): mark 挪到下面主 try 的**第一行**（原实现在 try 之前）。
    //
    //   原实现里 mark 与 try 之间还有 tracer 获取 / 建根 span / console 输出等
    //   可能抛错的准备工作，抛错时 finally 不执行 → `executingSessions` 永久留着
    //   本 session：同 session 门禁永久关闭（后续消息永远等不到）、
    //   `waitForIdle` 为该 lane 无时限自旋、状态栏卡在 executing。
    //   放进 try 首行后，"mark 一定发生 → finally 一定释放"成为结构性保证。

    // ★ Task #4486: agentContext 显式传参（不再读写 currentAgentContext 单槽）。
    //   同时把本次 sessionId 注入 eventSessionId —— 下游 query-executor /
    //   handleEventMessageWithEnv 都通过它决定 effectiveSessionId。
    const agentContext = {
      ...options.agentContext,
      eventSessionId: options.agentContext?.eventSessionId ?? execSessionId,
    };

    // 重置 abort 信号（★ Task #4486 Phase 3 会改 per-run，这里暂时保留全局）
    resetStreamAbort();
    
    // 使用 OTelTracer 创建 span
    // 关键：在调用 onExecute 之前建立 trace 作用域，这样装饰器创建的 span 也能继承 traceId
    const provider = getTracerProvider();
    const tracer = provider.getTracer("roy-tracer");

    // 检测是否已有上游 trace context。
    //
    // ★ Task #4519 (V3 修复)：优先从**事件载荷**取，而不是进程级单槽。
    //
    //   旧实现只读 `provider.getGlobalContext()` —— 那是进程级单槽，由 ES 层的
    //   `setGlobalContext()` 写入。`processStreamWith` 在一个 chunk 内同步
    //   dispatch 多行时，多次写入依次覆盖、**后写者赢**，于是多个 chat 的 run
    //   全部读到最后一行的 traceId（#4518 E2E 实测：3 个并发 chat 共用 1 个
    //   traceId，串行也复现 ⇒ 状态残留而非并发竞争）。
    //
    //   现在 ES 层把 context 放进 `evt.metadata.traceContext` 显式下传，
    //   这里按「载荷 > 进程级单槽」的优先级读取：
    //     - 载荷存在 → 用它（per-event 隔离，正确父子关系）
    //     - 载荷不存在 → 回落旧行为（兼容非 ES 路径 / 老调用方 / 跨进程）
    //
    //   ⚠️ 保留回落是刻意的向后兼容措施：`interactive.ts`(RunTui)、`act.ts`、
    //   workflow、TRACEPARENT 跨进程等路径不经过 ES 载荷，必须继续工作。
    const payloadTraceContext = (
      (agentContext as { envEvent?: { metadata?: { traceContext?: unknown } } } | undefined)
        ?.envEvent?.metadata as { traceContext?: SpanContext } | undefined
    )?.traceContext;
    const existingContext: SpanContext | undefined =
      payloadTraceContext ?? provider.getGlobalContext();


    // ★ Task #4515 (H1-b): 根 span 必须在**本 run 的 ALS 作用域内**创建。
    //
    //   修复前：startSpan() 在作用域外调用 → 读写 provider 的**进程级**
    //   tracerContexts 表。并发两个 run 时第二个 run 的 startSpan 会继承
    //   第一个 run 的 currentContext（traceId 相同 / parentSpanId 串味），
    //   而且两轮结束时都会往进程级表里留残留。
    //
    //   现在：整段「建根 span + onExecute + end」都在 withGlobalContext
    //   作用域内，每次 run 拿到自己那张 map（H1 主修复的 ALS 机制）。
    // 明确可能未赋值：作用域内建 span 前若抛错，catch/finally 需要能安全处理
    let rootSpan: ReturnType<typeof tracer.startSpan> | undefined;
    let traceId: string | undefined;

    // 本次 run 的 trace context：ES 事件路径有上游 context 时复用它（子 span），
    // 否则用自己新建的根 span（其 spanContext 在作用域内 startSpan 后才可知，
    // 所以先占位，作用域内再回填）。
    let runTraceContext: any = existingContext;

    try {
      // ★ Task #4515 (M6): 占用标记放在 try 首行 —— 与下面的 finally 严格配对。
      this.markSessionExecuting(execSessionId, true);
      // Task #2252: 更新底部状态栏到 "executing" 模式
      this.setMode("executing");

      // ★ Task #4515 (H1-b): 作用域内先建根 span，再执行 onExecute。
      //   作用域用的 context：有上游就复用，没有就先用 undefined 开作用域
      //   （等价"本次 run 没有父 trace"），根 span 建好后再把它作为
      //   runTraceContext 传给 onExecute 内部使用。
      await provider.withGlobalContext(runTraceContext, async () => {
        if (existingContext) {
          // ES 事件路径：复用 traceId，创建子 span
          rootSpan = tracer.startSpan("interactive.execute", {
            parent: existingContext,
          });
          traceId = existingContext.traceId; // 复用 ES 的 traceId
        } else {
          // 用户输入路径：创建新根 span（作用域内 → 独立 trace）
          rootSpan = tracer.startSpan("interactive.execute");
          traceId = rootSpan.spanContext.traceId;
          runTraceContext = rootSpan.spanContext;
        }

        // 显示 trace id 给用户
        console.log(`${COLORS.system("[Trace] " + traceId)}`);

        // 显示思考中提示
        console.log(`${COLORS.progress("[thinking...]")}`);

        // 传递 trace id 和 agentContext 给 onExecute
        await this.options.onExecute(message, traceId, agentContext);
      });
      // 注意：流式输出已在 QueryExecutor.subscribeToEvents -> StreamOutputService 中处理
      // 不需要再次打印返回值，避免重复输出

      // F1: invoke the post-execute hook so the outer handler can render
      // the 💰 Cache: read X / write Y (...) line. Wrapped in try/catch so
      // a formatter failure never breaks the REPL loop.
      if (this.options.onAfterExecute) {
        try {
          await this.options.onAfterExecute(this.lastUsage);
        } catch (hookError) {
          logger.warn("onAfterExecute hook failed", { error: String(hookError) });
        }
      }
    } catch (error) {
      // 处理 AskUserError - 转换为用户交互
      const askUserError = this.parseAskUserError(error);
      if (askUserError) {
        // 处理 ask_user 交互
        await this.handleAskUserInteraction(askUserError);
      } else {
        // 其他错误，直接显示
        console.error(`\n${COLORS.error("❌ 执行失败: " + error)}\n`);
        // 标记 span 为错误
        rootSpan?.setAttribute("error", String(error));

        // ★ Task #4418：不允许沉默。
        //
        // QueryExecutor 内部已有兜底，但这里兜住「还没走到 QueryExecutor 就失败」
        // 的路径（agentContext 组装 / plugin 加载 / REPL 包装层）。同一 messageId
        // 会被去重层吸收，不会重复发送；ask_user 由规则表跳过。
        try {
          await notifyReactFailure({
            error,
            envEvent: (agentContext as { envEvent?: unknown } | undefined)?.envEvent,
            sessionId: (agentContext as { eventSessionId?: string } | undefined)?.eventSessionId,
          });
        } catch (notifyErr) {
          console.error(`[#4418] 失败说明回飞书异常:`, notifyErr);
        }
      }
    } finally {
      // 结束 span。
      //
      // ★ Task #4515 (H1-c): end() 必须在**本 run 的 trace 作用域内**执行。
      //   `span.end()` → `handleSpanEnd()` 会"恢复父上下文"并写回
      //   `tracer.currentContext`。作用域外写的是**进程级**表 → 下一轮 run 的
      //   播种快照会继承它（实测：下一轮复用上一轮的 traceId）。
      //   用 `runInGlobalContextSync` 把写入落回本 run 那张（随后丢弃的）表里。
      //   ⚠️ 不要用 "catch 里再 end() 一次" 兜底 —— 那会 double-end
      //   （双重 storage.save + 双重 handleSpanEnd）。end() 抛错时直接吞掉，
      //   它只影响可观测性，不应影响 REPL 收尾。
      try {
        provider.runInGlobalContextSync(runTraceContext, () => rootSpan?.end());
      } catch (endErr) {
        logger.warn("root span end failed (ignored)", { error: String(endErr) });
      }
      
      // ★ Task #4486 Phase 3: 不再清理全局 context。
      //   本次 run 的 context 只活在 withGlobalContext 的 ALS 作用域里，
      //   作用域退出即自动失效；并发 run 之间互不影响。
      //   （旧行为 setGlobalContext(existingContext/undefined) 会连带清掉
      //    其他并发 run 的父上下文。ES 路径的 rootSpan 由 ES 自己 end。）
      
      // ★ Task #4486: 只释放自己这个 session 的占用（不误清别人）
      this.markSessionExecuting(execSessionId, false);
      // Task #2252: 恢复底部状态栏到 "ready" 模式（仅当全局都空闲时才切 ready）
      if (this.isIdle()) {
        this.setMode("ready");
      }
      // 如果是事件消息，需要恢复 prompt
      if (options.showPrompt) {
        // Task #2264 P0 + bugfix: 重画完整输入区（顶部边框 + 状态栏 + 底部边框）
        this.redrawInputArea();
        // Task #2339: ink 模式下 this.rl === null（ink 自己管 prompt），
        // 不调 readline.prompt，避免 TypeError: null is not an object
        // 与 interactive.ts shutdown 块 `if (this.rl) this.rl.close()` 风格一致
        if (this.rl) {
          this.rl.prompt(true);
        }
      }
    }
  }

  // ==================== AskUserError 处理 ====================

  /**
   * 解析错误，提取 AskUserError 信息
   */
  private parseAskUserError(error: unknown): AskUserErrorInfo | null {
    // 1. 直接是 AskUserError 实例
    if (error instanceof AskUserError) {
      return {
        query: error.query,
        sessionId: error.sessionId,
        agentSessionId: error.agentSessionId,
        nodeId: error.nodeId,
        nodeType: error.nodeType,
      };
    }

    // 2. Error 对象有 name = 'AskUserError'
    if (error instanceof Error && (error as any).name === 'AskUserError') {
      const askError = error as any;
      return {
        query: askError.query,
        sessionId: askError.sessionId,
        agentSessionId: askError.agentSessionId,
        nodeId: askError.nodeId,
        nodeType: askError.nodeType,
      };
    }

    // 3. 错误字符串包含 __ASK_USER_ERROR__: 前缀
    if (error instanceof Error) {
      const errorStr = error.message;
      const prefix = '__ASK_USER_ERROR__:';
      if (errorStr.includes(prefix)) {
        try {
          const jsonPart = errorStr.substring(errorStr.indexOf(prefix) + prefix.length);
          const parsed = JSON.parse(jsonPart);
          return {
            query: parsed.query,
            sessionId: parsed.sessionId,
            agentSessionId: parsed.agentSessionId,
            nodeId: parsed.nodeId,
            nodeType: parsed.nodeType,
          };
        } catch {
          // JSON 解析失败，忽略
        }
      }
    }

    return null;
  }

  /**
   * 处理 ask_user 交互
   * 
   * 流程：
   * 1. 格式化输出，展示问题和选项（类似 agent text 的样式）
   * 2. 设置等待状态，等待用户输入
   * 3. 用户输入后，自动触发下一轮 agent（不手动添加到 session，因为 tool result 已在 session 中）
   * 
   * 注意：不需要 addUserMessage，agent 会自动加载 session 上下文，包括之前保存的 tool result
   */
  private async handleAskUserInteraction(errorInfo: AskUserErrorInfo): Promise<void> {
    const { question, options } = parseOptionsFromQuery(errorInfo.query);

    // 显示格式化的问题（类似 agent text 的样式）
    console.log(formatAskUserOutput({ ...errorInfo, query: question, options }));

    // 等待用户输入（带 timeout，超时返回 sentinel 字符串）
    const userResponse = await this.promptUser(question, options, errorInfo);

    // Task #1967: 超时分支
    // 不要把 sentinel 当作用户回复送往下一轮 agent，
    // 否则会污染对话上下文，并让 isExecuting 维持占用。
    // 主 session 应立即回到可处理消息的状态。
    if (isAskUserTimeoutSentinel(userResponse)) {
      console.log(
        chalk.dim(
          `\n  请直接输入新指令继续，或使用 /abort 中断当前工作流。`,
        ),
      );
      // 不调用 executeInternal —— 让外层 executeInternal 的 finally
      // 块清理 isExecuting 并恢复 prompt。
      return;
    }

    // 显示用户响应
    console.log(COLORS.userInput(`❯ ${userResponse.replace(/\n/g, "\n" + COLORS.userInput("❯ "))}`));

    // 自动触发下一轮 agent
    // 注意：不需要手动 addUserMessage
    // - tool result（问题和选项）已在 session 中
    // - user response 会作为新消息被 agent react 捕获并添加到 session
    // - agent 会自动加载 session 上下文继续执行
    await this.executeInternal(userResponse, { showPrompt: false });
  }

  // ============================================================================
  // Task #3147 — handleSubagentAskUserCascade 已移除
  //
  // task.background.ask_user 事件现在走标准 notify 流程（与 task.background.completed 一致）：
  //   1. EventMessageFormatter 渲染 payload.hints 为 [🤖 Agent 操作提示] 块
  //   2. handleEventMessageWithEnv → executeInternal 把消息喂给主 agent LLM
  //   3. LLM 用 ask_user tool 把 query 展示给用户并等答复
  //   4. 拿到答复后 LLM 用 delegate_task(subagent_type, sub_session_id, prompt)
  //      复用 sub-session 让 sub-agent 继承之前消息历史继续推进。
  // ============================================================================

  /**
   * 提示用户输入
   *
   * Task #1967: 新增 timeout 支持（默认 120000ms）。
   * - 用户在 timeout 之前正常输入：原流程不变
   * - 用户未在 timeout 内响应：resolve 一个 sentinel 字符串，
   *   调用方应使用 `isAskUserTimeoutSentinel()` 识别并跳过链式 agent 调用。
   * - 用户回复与 timeout 竞态：用 `resolved` flag 保证 resolve 恰好一次。
   *
   * 测试可通过 options.timeoutMs 注入更短时间，避免真实等待 120 秒。
   *
   * @param question  显示给用户的问题文本
   * @param options   可选列表（如 ask_user 提供）
   * @param errorInfo 可选 AskUserError 信息，用于构造超时 sentinel
   * @param opts      内部选项（timeoutMs 等）
   */
  private promptUser(
    question: string,
    options?: string[],
    errorInfo?: AskUserErrorInfo,
    opts?: { timeoutMs?: number },
  ): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? this.askUserTimeoutMs ?? ASK_USER_TIMEOUT_MS;
    return new Promise((resolve) => {
      // Task #2264 P0 + bugfix: 重画完整输入区（顶部边框 + 状态栏 + 底部边框）
      // Task #2354: ink 模式下 this.rl === null（ink 自己管 prompt），
      // 守卫 setPrompt + prompt 两个调用，避免 TypeError: null is not an object
      if (this.rl) {
        this.rl.setPrompt(COLORS.accent("❯ "));
        this.redrawInputArea();
        this.rl.prompt(true);
      } else {
        // ink 模式仍需要 redraw UI（让输入区可见）
        this.redrawInputArea();
      }

      // 共享的"接收用户输入后如何结束 promise"的逻辑
      const finishWithUserInput = (input: string) => {
        const trimmedInput = input.trim();

        // 忽略空输入：递归重新提示（保留 timeout）
        if (!trimmedInput) {
          console.log(chalk.yellow("⚠️ 输入不能为空，请重新输入\n"));
          // 已经 race winner 处理完了, 递归时不再共享 timer
          this.promptUser(question, options, errorInfo, opts).then(resolve);
          return;
        }

        // 解析用户输入
        const parsed = parseUserInput(trimmedInput, options);

        if (parsed.type === "option" && options) {
          const selectedOption = options[parsed.value as number];
          console.log(chalk.green(`✓ 您选择了: ${selectedOption}\n`));
          resolve(selectedOption);
        } else {
          console.log(chalk.green(`✓ 您的回答: ${parsed.value}\n`));
          resolve(parsed.value as string);
        }
      };

      // Task #2377: ink 模式下 this.rl === null（ink 自己管 prompt），
      // 守卫 withAskUserTimeoutRace 避免 TypeError: null is not an object (evaluating 'rl.on')
      // 与 Task #2354 / #2339 / #2281 / #2368 其它 5 处 `if (this.rl)` 守卫风格一致。
      // ink 模式 ask_user 交互暂未实现，立即 resolve 一个 sentinel 让 caller
      // （handleAskUserInteraction）走优雅分支，不调用 executeInternal。
      if (this.rl) {
        withAskUserTimeoutRace({
          rl: this.rl,
          timeoutMs,
          onLine: (input) => {
            finishWithUserInput(input);
          },
          onTimeout: () => {
            console.log(
              chalk.yellow(
                `\n⏱ ask_user 超时：${timeoutMs}ms 内未收到回应，已自动解除等待。`,
              ),
            );

            // 返回 sentinel 让上层知道用户没应答
            resolve(
              createAskUserTimeoutSentinel(errorInfo, timeoutMs, {
                source: "repl",
                question,
              }),
            );
          },
        });
      } else {
        // ink 模式: 立即 resolve sentinel 让 caller 优雅处理
        // （复用 Task #1967 sentinel + isAskUserTimeoutSentinel 基础设施）
        resolve(
          createAskUserTimeoutSentinel(errorInfo, timeoutMs, {
            source: "repl",
            question,
          }),
        );
      }
    });
  }

  // ==================== SIGINT 处理 ====================

  /**
   * 处理 SIGINT 信号（Ctrl+C）
   * 
   * 行为：
   * - 多行输入中：取消当前输入，重置状态
   * - 正在执行：退出程序
   * - 空闲状态：退出程序
   * 
   * 与 Esc 的区别：
   * - Esc：中断 LLM 调用 + 停止流式输出 + 恢复 prompt（继续执行）
   * - Ctrl+C：退出程序，或取消多行输入
   */
  handleSigint(): void {
    if (this.isShuttingDown) {
      return;
    }

    // 多行输入状态下，取消输入而不是退出
    if (this.inputHandler.getPrompt() !== USER_PROMPT) {
      console.log("\n\n" + COLORS.system("[已取消多行输入]"));
      this.inputHandler.reset();
      this.updatePrompt();
      return;
    }

    // 正在执行时，退出程序
    if (this.isExecuting) {
      console.log("\n\n收到中断信号，正在清理...");
      this.shutdown()
        .then(() => process.exit(0))
        .catch(() => process.exit(0));
      return;
    }

    // 空闲状态，退出程序
    console.log("\n\n再见！👋\n");
    this.shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
  }

  /**
   * 处理 Esc 按键 - 中断流式输出
   *
   * Esc 行为：
   * - 正在执行时：中断底层 LLM 调用 + 停止流式输出 + 恢复 prompt
   * - 空闲时：不做任何操作
   *
   * 与 Ctrl+C 的区别：
   * - Esc 只在执行时有效，空闲时不退出
   * - Ctrl+C 在空闲时会退出程序
   *
   * Task #2245 — Codex P1-3: now async to await the cascade stop. The
   * call site uses `void this.handleEscKey()` since keypress handlers
   * can't be async.
   */
  async handleEscKey(): Promise<void> {
    if (this.isShuttingDown) {
      logger.debug("[Esc] handler entered (isShuttingDown=true) → early return");
      return;
    }

    // Task #2255 — detect whether the parent session tree has any active
    // background task or workflow descendant. This is independent of
    // `isExecuting` because delegate_task children keep running after the
    // parent LLM has returned (`isExecuting=false`).
    //
    // We compute this BEFORE the idle guard so we can arm force-detection
    // correctly when there is an active descendant (see RED-6 / RED-7).
    const mainSessionIdEarly = this.options.sessionId;
    const hasActiveDescendant = mainSessionIdEarly
      ? hasActiveDescendants(this.env, mainSessionIdEarly)
      : false;

    // Observability — always log handler entry + decision reason so that
    // "user pressed ESC but nothing happened" can be diagnosed from
    // traces / debug logs without instrumenting the user's terminal.
    logger.debug(
      `[Esc] handler entered: isExecuting=${this.isExecuting} ` +
      `hasActiveDescendant=${hasActiveDescendant} ` +
      `lastEscPressTime=${this.lastEscPressTime}`,
    );

    // Task #2245 — BL-2 fix: only ARM force-detection on a real
    // executing→ESC transition. Task #2255 extends this: when the parent
    // has an active descendant, the first ESC within the window arms
    // force-detection so a subsequent ESC within FORCE_STOP_WINDOW_MS
    // can upgrade to force=true.
    const now = Date.now();
    const isExecuting = this.isExecuting;
    const canCascade = isExecuting || hasActiveDescendant;
    const force =
      canCascade &&
      this.lastEscPressTime > 0 &&
      now - this.lastEscPressTime < REPL.FORCE_STOP_WINDOW_MS;

    if (canCascade) {
      // Arm force-detection: only on real cascade→ESC transition
      // (executing OR active descendant).
      this.lastEscPressTime = now;
    }

    // Idle path with NO active descendant: no-op. (Force escalation from
    // a prior idle→idle double-press is intentionally NOT supported —
    // it would combine with forceStopAll's cross-parent semantics to nuke
    // unrelated background tasks.)
    if (!canCascade) {
      logger.debug(
        "[Esc] idle no-op: isExecuting=false, no active descendant",
      );
      return;
    }

    // canCascade === true path (original graceful ESC behavior + cascade)
    // 1. 中断所有 Agent（包括 delegate_task 的子 agent）
    if (this.env) {
      const agentComponent = this.env.getComponent("agent") as any;
      if (agentComponent?.abortAll) {
        agentComponent.abortAll();
        logger.debug("[Esc] AgentComponent.abortAll() called");
      } else if (agentComponent?.abort) {
        agentComponent.abort("default");
        logger.debug("[Esc] AgentComponent.abort('default') called (fallback)");
      }
    }

    // 2. 停止流式输出
    //
    // ★ Task #4486 收尾 review 修复：除了全局 flag，还要给**每个正在执行的
    //   session** 单独打标记。原因：绑了 runId 的流（事件驱动 turn）虽然会被
    //   全局 flag 一票否决，但下一轮 `executeInternal` 会调无 scope 的
    //   `resetStreamAbort()` 清掉全局 flag —— 此时被 ESC 中断的流会"复活"
    //   继续渲染。逐个 session 打标记让中断跨 turn 持续有效。
    abortStream();
    for (const sid of this.getExecutingSessionIds()) {
      abortStream(sid);
    }

    // Task #2309: 立即标记当前 streaming 消息为完成, 防止新 delta 追加到旧 message.
    //
    // 背景 (Bug 2 — Task #2303 引入的回归):
    // - abortStream() 只设 streamAbortSignal.aborted=true, StreamOutputService 后续 handleEvent
    //   会丢弃新事件, 但 REPLInk 的 pendingDeltaRef / streamingIndexRef 不受影响
    // - 若旧 message 仍标记 streaming=true, 新 agent 开始的 delta 会被 flushStreamingDelta
    //   "找到旧 streaming message → 追加到旧 message" — 输出"接着"中断位置继续追加
    // - 修复: 在 abortStream 后立即调 inkApi.finishAssistantStream()
    //   - flush pending delta (旧 message 接收最后的内容)
    //   - 标记旧 message 为 streaming=false
    //   - 重置 streamingIndexRef, 让新 delta 创建新 message
    //
    // 防御: 用 try/catch wrap, ink REPL 路径可能 inkApi 为 null (readline 路径)
    if (this.inkApi && typeof this.inkApi.finishAssistantStream === "function") {
      try {
        this.inkApi.finishAssistantStream();
      } catch (err) {
        logger.warn("[Esc] finishAssistantStream failed", { error: String(err) });
      }
    }

    // 3. Task #2245 — cascade stop 整个 session tree（delegate_task + workflow_run 嵌套）
    // Task #2245 — Codex P1-3: await the cascade (with a hard 5s timeout
    // fallback) so REPL doesn't reset isExecuting=false before the cascade
    // settles. Without this, a *new* execution could start while the
    // in-flight cascade is still draining — the cascade would race
    // against the new command's tasks. The 5s timeout is a UX
    // compromise: most cascades complete in < 1s, but we cap so a
    // stuck workflow engine doesn't block REPL forever.
    //
    // Task #2245 — Codex v2 P1 fix: wrap the timer in a controlled
    // handle and clear it on success/failure. Without `clearTimeout`,
    // the timer would keep running and trigger an unhandled rejection
    // (Node 22+ terminates the process by default). It would also
    // block graceful process exit for 5s after every successful Esc.
    const mainSessionId = this.options.sessionId;
    if (this.env && mainSessionId) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          cascadeStopSessionTree(this.env, mainSessionId, { force }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("cascade timeout 5s")),
              5000,
            );
          }),
        ]);
        logger.info(
          `[Esc] cascade stop force=${result.force} tasks=${result.stoppedTaskIds.length} workflows=${result.stoppedWorkflowSessionIds.length} errors=${result.errors.length}`,
        );
      } catch (err: unknown) {
        // Task #2245 — Codex P1-3: surface cascade failure via logger
        // (still fire-and-forget at the user level, but the catch
        // is now visible in the source code and traceable).
        logger.warn(`[Esc] cascade stop failed: ${err}`);
      } finally {
        // Always clear the timeout handle to prevent it from firing
        // after a successful/failed resolution (avoids unhandled
        // rejection and unblocks graceful exit).
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    // 4. 重置状态 — only reset if it was true (Task #2255).
    // When we cascaded purely due to active descendant (isExecuting was
    // already false), don't touch it.
    // ★ Task #4486: ESC = abortAll 语义 → 清空所有 session 占用
    if (isExecuting) {
      this.abortAllExecutingSessions();
    }
    // Task #2252: 恢复底部状态栏 (ink REPL UI hook, integrated from main)
    this.setMode("ready");

    // 5. 恢复 prompt — refresh so the user sees "ready for input" again.
    // Task #2264 P0 + bugfix: 重画完整输入区（顶部边框 + 状态栏 + 底部边框）
    //   ink REPL UI hook, integrated from main.
    // Task #2368: ink 模式下 this.rl === null（ink 自己管 prompt），
    // 守卫整个 try/catch 块，避免 TypeError: null is not an object。
    // 与 Task #2354 其它 5 处 if (this.rl) 守卫风格一致。
    // try/catch 保留在 if 内部，用于防御 readline shutdown race。
    if (this.rl) {
      try {
        this.redrawInputArea();
        this.rl.prompt(true);
      } catch {
        // best-effort: prompt may fail if readline is mid-close during shutdown
      }
    }
  }

  private printHeader(): void {
    // Task #2252: 用欢迎卡（Claude Code 风格）替代旧的 ╔══╗ 标题。
    // 包含：模型名 / cwd / version / sessionTitle / 像素 logo / Tips / What's new
    // 旧标题保留作为 fallback 路径（--quiet 模式或非 TTY）。
    // Task #2252 bugfix: quiet 检查会阻止欢迎卡（因为 quiet 默认 true）
    // 欢迎卡是视觉装饰不是日志，应该始终显示。
    // Fallback 只在非 TTY 时触发（管道/重定向场景）。
    // Task #2264 bugfix: 移除了 printHeader 里的 [顶边 + 状态栏] 打印，
    // 让 redrawInputArea() 统一负责输入区，避免与 redrawInputArea() 重复
    // （也保证 /clear /cls 命令后 redrawInputArea 一致触发）。
    if (process.stdout.isTTY) {
      const modelName = this.options.model ?? "default";
      const cwd = process.cwd();
      const sessionTitle = this.options.sessionTitle;
      const version = this.options.version ?? "1.0.0";

      // 探测 git 分支（同步，1s 超时，失败返回 undefined）
      // Task #2264 P1: 把探测结果缓存到 statusBarCtx 给 redrawInputArea 用
      this.statusBarCtx.gitBranch = detectGitBranch(cwd);
      this.statusBarCtx.cwd = cwd;
      this.statusBarCtx.model = modelName;

      // 只打印欢迎卡
      printWelcomeCard({
        model: modelName,
        cwd,
        version,
        sessionTitle,
      });
      return;
    }
    // 旧 fallback（非 TTY：管道/重定向）
    console.log(chalk.bold("\n╔══════════════════════════════════════════════════╗"));
    console.log(chalk.bold("║          ") + chalk.green.bold("roy-bot") + chalk.bold(" Interactive Mode") + chalk.bold("              ║"));
    console.log(chalk.bold("╚══════════════════════════════════════════════════╝\n"));
    console.log(`${chalk.dim("会话:")} ${this.options.sessionTitle}`);
    console.log(`${chalk.dim("输入 ")} ${COLORS.userInput("/help")} ${chalk.dim("查看可用命令")}\n`);
  }

  private printHelp(): void {
    console.log(`
${chalk.bold("╭")}${chalk.dim("─".repeat(49))}${chalk.bold("╮")}
${chalk.bold("│")} ${chalk.bold("快捷命令")}                                     ${chalk.bold("│")}
${chalk.bold("├")}${chalk.dim("─".repeat(49))}${chalk.bold("├")}
${chalk.bold("│")}  ${COLORS.userInput("/help")}, ${COLORS.userInput("/h")}    显示帮助                           ${chalk.bold("│")}
${chalk.bold("│")}  ${COLORS.userInput("/status")}, ${COLORS.userInput("/st")}  显示状态                           ${chalk.bold("│")}
${chalk.bold("│")}  ${COLORS.userInput("/sessions")}, ${COLORS.userInput("/s")} 切换会话                          ${chalk.bold("│")}
${chalk.bold("│")}  ${COLORS.userInput("/compact")}, ${COLORS.userInput("/c")} 压缩上下文                         ${chalk.bold("│")}
${chalk.bold("│")}  ${COLORS.userInput("/abort")}      中断当前流式输出                  ${chalk.bold("│")}
${chalk.bold("│")}  ${COLORS.userInput("/clear")}, ${COLORS.userInput("/cls")} 清屏                              ${chalk.bold("│")}
${chalk.bold("│")}  ${COLORS.userInput("/exit")}, ${COLORS.userInput("/q")}   退出                               ${chalk.bold("│")}
${chalk.bold("├")}${chalk.dim("─".repeat(49))}${chalk.bold("├")}
${chalk.bold("│")} ${chalk.bold("多行输入")}                                      ${chalk.bold("│")}
${chalk.bold("├")}${chalk.dim("─".repeat(49))}${chalk.bold("├")}
${chalk.bold("│")}  输入多行内容后，Alt+Enter 结束输入。       ${chalk.bold("│")}
${chalk.bold("│")}  Ctrl+C 可取消多行输入。                   ${chalk.bold("│")}
${chalk.bold("╰")}${chalk.dim("─".repeat(49))}${chalk.bold("╯")}
`);
  }

  private async printStatus(): Promise<void> {
    const status = await this.options.onStatus();
    console.log(`
${chalk.bold("╭")}${chalk.dim("─".repeat(49))}${chalk.bold("╮")}
${chalk.bold("│")}  ${chalk.bold("会话状态")}                                    ${chalk.bold("│")}
${chalk.bold("├")}${chalk.dim("─".repeat(49))}${chalk.bold("├")}
${chalk.bold("│")}  ${chalk.dim("会话:")} ${status.sessionTitle.padEnd(35)} ${chalk.bold("│")}
${chalk.bold("│")}  ${chalk.dim("ID:")} ${status.sessionId.padEnd(37)} ${chalk.bold("│")}
${chalk.bold("│")}  ${chalk.dim("消息:")} ${String(status.messageCount).padEnd(34)} ${chalk.bold("│")}
${chalk.bold("│")}  ${chalk.dim("Token:")} ${String(status.tokenCount).padEnd(33)} ${chalk.bold("│")}
${chalk.bold("╰")}${chalk.dim("─".repeat(49))}${chalk.bold("╯")}
`);
  }

  private printSessionsHelp(): void {
    console.log(`
${chalk.bold("╭")}${chalk.dim("─".repeat(49))}${chalk.bold("╮")}
${chalk.bold("│")}  ${chalk.bold("切换会话")}                                    ${chalk.bold("│")}
${chalk.bold("├")}${chalk.dim("─".repeat(49))}${chalk.bold("├")}
${chalk.bold("│")}  退出当前交互模式后，使用以下命令切换会话：    ${chalk.bold("│")}
${chalk.bold("│")}                                                 ${chalk.bold("│")}
${chalk.bold("│")}  ${COLORS.userInput("roy-bot sessions list")}    列出所有会话          ${chalk.bold("│")}
${chalk.bold("│")}  ${COLORS.userInput("roy-bot sessions use <id>")} 切换到指定会话       ${chalk.bold("│")}
${chalk.bold("│")}                                                 ${chalk.bold("│")}
${chalk.bold("│")}  或直接指定会话启动：                           ${chalk.bold("│")}
${chalk.bold("│")}  ${COLORS.userInput("roy-bot interactive -s <session-id>")}            ${chalk.bold("│")}
${chalk.bold("╰")}${chalk.dim("─".repeat(49))}${chalk.bold("╯")}
`);
  }
}

/**
 * 构建 `interactive`（注册名 `run`）每轮的 AgentContext。
 *
 * ★ Task #4634：抽成纯函数是为了可测 —— 原先这段逻辑埋在 REPL 的
 *   `onExecute` 闭包里（要起真实 env + 挂 Ink 才能跑），单测根本够不着。
 *   抽出来后 `model` / `fallbackModel` 的接线规则可以被直接断言。
 *
 * 字段优先级（**从低到高**，后者覆盖前者）：
 * 1. `currentAgentContext` —— `--agent` 选中的 agent
 * 2. `modelFlags` —— `--model` / `--fallback-model`（Task #4634）
 * 3. `turnAgentContext` —— 本轮临时传入的 agentContext
 * 4. `cliTrigger` 的 envEvent —— Task #4568 的 CLI trigger event
 *
 * ⚠️ `turnAgentContext` 排在 model 之后：它是「本轮临时覆盖」，
 *   语义上应该比全局 flag 更强（与改动前 `...agentContext` 的位置一致）。
 */
export function buildInteractiveMergedContext(params: {
  currentAgentContext?: any;
  turnAgentContext?: any;
  modelFlags?: { model?: string; fallbackModel?: string | string[] };
  cliTrigger?: any;
  eventSourceSystemPrompt?: string;
  defaultAgentName?: string;
  /** 本轮消息（用于生成 CLI trigger event 的 payload） */
  message?: string | unknown;
}): any {
  const {
    currentAgentContext,
    turnAgentContext,
    modelFlags,
    cliTrigger,
    eventSourceSystemPrompt,
    defaultAgentName,
    message,
  } = params;

  return {
    ...currentAgentContext,  // 当前选中的 agent
    // ★ Task #4634：model / fallbackModel 统一由 buildModelAgentContext 产出
    //   （--model override + --fallback-model 兜底）
    ...buildModelAgentContext(modelFlags ?? {}),
    ...turnAgentContext,         // 用户输入中的 agent
    // ★ Task #4568：CLI 也是一个 EventSource —— 把 envEvent 注入
    //   agentContext，下游 buildRunEnvContext() 会把它写进 EnvContext，
    //   于是 deriveTriggerEventIdFromEnvContext() / captureReplyChannelSnapshot()
    //   都能拿到值（断点 A/B/C 同时修复）。
    ...(cliTrigger
      ? {
          envEvent: toCliEnvEvent(
            cliTrigger,
            typeof message === "string" ? message : "",
          ),
        }
      : {}),
    // Phase 3: 注入到 query-executor 读取的字段
    eventSourceSystemPrompt,
    // ✅ 透传 default agent name（替换 default prompt 里的 {{agent_name}} 占位符）
    metadata: {
      ...(currentAgentContext?.metadata ?? {}),
      ...(turnAgentContext?.metadata ?? {}),
      defaultAgentName,
    },
  };
}

/**
 * 创建 InteractiveCommand
 * 
 * @param externalEnvService - 外部传入的 EnvironmentService（可选）
 *        如果传入，三方可以在自己的代码中获取 env 实例并调用 publishEvent 等接口
 * @returns yargs CommandModule
 * 
 * @example
 * // 三方集成示例
 * import { createInteractiveCommand, EnvironmentService } from "@ai-setting/roy-bot-cli";
 * 
 * const envService = new EnvironmentService();
 * await envService.create({ /* config *\/ });
 * 
 * const env = envService.getEnvironment();
 * // 三方可以调用 env.publishEvent() 等接口
 * 
 * const InteractiveCommand = createInteractiveCommand(envService);
 * // 使用 yargs 注册并执行命令
 */
export function createInteractiveCommand(
  externalEnvService?: EnvironmentService
): CommandModule<object, InteractiveOptions> {
  return {
    command: "run",
    // ★ Task #5117 (M1) Q4：describe 与 headless 形态对齐（原「交互式模式」失真）。
    // ★ Q2 (B1)：别名 `i` / `repl` 不再挂在 run 上 —— interactive.ts 注册
    //   `i` / `repl` → interactive（零学习成本迁移），run 只剩 headless 一条路。
    describe: "headless 事件源守护模式（需 --es；交互对话请用 interactive / chat）",

    builder: (yargs) =>
      yargs
        .option("session", {
          alias: "s",
          describe: "指定会话 ID",
          type: "string",
        })
        .option("continue", {
          alias: "c",
          describe: "继续上次会话",
          type: "boolean",
          default: false,
        })
        .option("config", {
          alias: "C",
          describe: "配置文件路径",
          type: "string",
        })
        .option("reasoning", {
          alias: "r",
          describe: "显示 AI 思考过程",
          type: "boolean",
          default: true,
        })
        .option("tool-calls", {
          describe: "显示工具调用",
          type: "boolean",
          default: true,
        })
        .option("tool-results", {
          describe: "显示工具执行结果",
          type: "boolean",
          default: false,
        })
        .option("event-source", {
          alias: "es",
          describe: "启动时一并启动的事件源 ID（可多次指定，支持 --es a --es b）",
          type: "array",
          string: true,
        })
        .option("plugin", {
          alias: "p",
          describe: "启用 plugin (tslsp, pylsp, mdlsp, lsp, code-check, reminder, memory, task-tag)",
          type: "array",
          string: true,
        })
        .option("agent", {
          alias: "a",
          describe: "指定使用的 agent (如 explore, general)",
          type: "string",
        })
        .option("model", {
          describe: MODEL_DESCRIBE,
          type: "string",
        })
        // ★ Task #4634：兜底模型（providerId/modelId）。
        //   主模型 404/429/额度耗尽/5xx/超时/重试耗尽时，本次 run 自动降级；
        //   default agent 与 sub agent 均生效（与 `act` / `interactive` 语义一致）。
        .option("fallback-model", {
          describe: FALLBACK_MODEL_DESCRIBE,
          type: "string",
        })
        // ★ Task #4724 review2 MINOR-1/MINOR-2：非法的显式兜底值
        //   在**参数解析阶段**就报错退出，不静默放行。
        .check(checkFallbackModelArg)
        .option("default-agent-name", {
          alias: "dan",
          describe: "Default agent 名字（默认 Roy，可被覆盖）",
          type: "string",
          default: "Roy",
        }),

    async handler(args) {
      // ========== 0. 无 --es 校验（★ Task #5117 M1 Q1/§3.7） ==========
      // run = headless ES 守护命令：ES 是唯一输入源与常驻理由。
      // 无 --es 直接报错退出（原行为是 EXIT=0 静默空转，不诚实）。
      // 交互能力有专用命令：interactive（TUI）/ chat（单次）。
      const rawEsGuard = args.eventSource as string[] | string | undefined;
      const esGuardIds: string[] = Array.isArray(rawEsGuard)
        ? rawEsGuard.filter((s) => !!s)
        : rawEsGuard
          ? [rawEsGuard]
          : [];
      if (esGuardIds.length === 0) {
        process.stderr.write(
          "roy-bot run 需要至少一个 --es <id>（headless 事件源守护模式）。\n" +
          "  交互式对话请用：roy-bot interactive\n" +
          "  单次对话请用：roy-bot chat \"你的问题\"\n"
        );
        process.exit(2);
      }

      // ★ Task #5117 (M1 §4.1-4)：stdout 归协议、stderr 归诊断。
      // core logger 的 info/warn/error 从此全部走 stderr（logger.ts:504）。
      // 该开关此前生产路径从未接线（log-migration.ts:68 自陈）。
      setStdoutStrictMode(true);

      // ========== 1. 初始化（复用 act） ==========
      CliQuietModeService.getInstance().setQuiet(true);
      const output = new OutputService();
      // ★ Task #5117 M3-review MINOR-1：headless 下 OutputService
      //   必须 quiet —— 否则 output.info/success（插件加载 / ES
      //   systemPrompt 预载 / LSP 预热等分支）默认写 stdout，污染
      //   [event]/[result]/[lifecycle]/[fatal] 协议流。
      //   error/warn 走 stderr 不受影响。
      output.configure({ quiet: true });

      // 如果有外部传入的 envService，使用它；否则内部创建
      const shouldDisposeEnvService = !externalEnvService;
      const envService = externalEnvService ?? new EnvironmentService(output);

      // Phase 3: EventSource 预加载的 systemPrompt (per-invocation state).
      // 注意：必须是 handler 闭包内的 `let`，不是 class field，
      // 因为 `async handler(args)` 是普通方法（非 arrow），Yargs 调用时
      // `this === {}` — 把字段放到 this 上一定会 undefined。
      // (兼容无 --es 场景: 默认 [] 不会让 .length 报错)
      let eventSourceSystemPrompts: ResolvedEventSourcePrompt[] = [];

      // ========== 1.5 Plugin 参数解析（与 act.ts 保持一致）==========
      // coder-harness 插件名称集合（支持新旧两种命名）
      // 旧命名: lsp (统一 LSP)
      // 新命名: tslsp, pylsp, mdlsp (语言特定 LSP)
      const CODER_HARNESS_PLUGINS = new Set([
        "lsp",           // 统一 LSP（兼容旧命名）
        "code-check",    // 外部命令检查
        "reminder",      // 迭代提醒
        // 语言特定 LSP（phase-3 新增）
        "tslsp",         // TypeScript LSP
        "pylsp",        // Python LSP
        "mdlsp",        // Markdown LSP
        "ontologylsp",  // Typed Markdown Ontology (ontology-harness)
      ]);
      
      // 确保 plugins 是数组（yargs 在单个值时可能返回字符串）
      const rawPlugins = args.plugin;
      const pluginNames: string[] = Array.isArray(rawPlugins)
        ? rawPlugins
        : rawPlugins
          ? [rawPlugins]
          : [];

      // 分离 coder-harness 插件和 component plugins
      const coderPluginNames: string[] = [];
      const componentPluginNames: string[] = [];

      for (const plugin of pluginNames) {
        const name = plugin.split(":")[0];
        if (CODER_HARNESS_PLUGINS.has(name)) {
          coderPluginNames.push(plugin);
        } else {
          componentPluginNames.push(plugin);
        }
      }

      // ★ Task #5117 (M1)：headless 摘要渲染器 —— 声明在 try 外，
      //   catch 路径的 [fatal] 行也能输出。
      const headlessSummary = new RunHeadlessSummary();
      // ★ M3-review MINOR-2：esStartResults 与摘要渲染器一起声明在
      //   try 外 —— registerShutdownHandlers 的 cleanup 闭包会读它；
      //   若留在 try 内（ES 启动段），启动早期收信号会 TDZ。
      const esStartResults: { id: string; success: boolean }[] = [];
      try {
        // 创建环境（如果有外部传入的 envService，跳过创建）
        // 注意：必须把 coderPluginNames 一起传过去，否则 EnvironmentService.loadPlugins()
        // 不会注册 tslsp/pylsp/mdlsp/lsp/code-check/reminder 等 coder-harness 插件，
        // 也就不会注册 tool:after.execute hook，onAfterTool 永远不会被触发。
        if (!externalEnvService) {
          await envService.create({ 
            configPath: args.config,
            plugins: [...componentPluginNames, ...coderPluginNames],
            loadPlugins: true,
            commandName: "run",
            // ★ Task #5117 (M1)：headless 下压住 EnvironmentService
            //   的 console 输出（如 "Registered commands-prompt Hook"），
            //   stdout 只留摘要协议。
            quiet: true,
          });
        }
        
        const env = envService.getEnvironment();
        if (!env) {
          output.error("Failed to create environment");
          process.exit(1);
        }
        const sessionComponent = envService.getSession();
        if (!sessionComponent) {
          output.error("Failed to create session component");
          process.exit(1);
        }

        // 初始化 SummaryAgent（复用 act 逻辑）
        const llmComponent = envService.getLLM();
        const promptComponent = env.getComponent("prompt") as any;
        void promptComponent;

        // 初始化流式输出服务（导入 COLORS 和 abort 函数）
        const { COLORS: STREAM_COLORS, resetStreamAbort: resetStream } = await import("../services/stream-output.service");

        // ========== 2. Session 管理（复用 SessionManager） ==========
        const sessionManager = new SessionManager({
          sessionComponent,
          output,
          quiet: true,
        });

        const sessionResult = await sessionManager.init(args.session, args.continue);
        const { sessionId, sessionTitle } = sessionResult;
        // compact agent 已内置注册（compact / compact-hint），无需外部初始化

        // ★ Task #5117 (M1)：headless 模式 silent 恒为 true ——
        //   StreamOutputService 不写 stdout（stdout 只出摘要行），
        //   仅 emitChunk（chunkCallback 也无需注册，事件轮的最终文本
        //   由下方摘要行输出）。
        const queryExecutor = new QueryExecutor({
          env,
          sessionComponent,
          output,
          quiet: true,
          silent: true,
        });

        /**
         * ★ Task #4486 Phase 3: per-session QueryExecutor 池。
         *
         * 单实例的问题是 `streamService` 只有一个，并发多 session 时
         *   - `setChunkCallback` 被后来的会话覆盖
         *   - 流式输出混进同一个 ticker（A 的 llm.text 渲染到 B）
         *   - `streamService.reset()` 互相清掉对方的全文/usage
         *
         * 一个 session 一个 executor，各自绑 session 作用域（session 过滤 +
         * per-run abort）。上限 16，超出按 LRU 淘汰并 dispose。
         */
        const MAX_SESSION_EXECUTORS = 16;
        const sessionExecutors = new Map<string, QueryExecutor>();
        /**
         * ★ Task #4486 收尾 review 修复：跟踪哪些 session 的 turn 正在跑。
         *
         * 为什么不用 `repl.isSessionIdle()`：`getSessionExecutor` 位于 yargs
         * handler 内，`this` 在这里不可靠（本文件已有注释：Yargs 调用 handler
         * 时 `this === {}`，class field 不可见）。所以在这个闭包里自己记。
         */
        const runningTurns = new Set<string>();
        const getSessionExecutor = (sid: string | undefined): QueryExecutor => {
          // 没有 session → 用主实例（向后兼容单会话路径）
          if (!sid) return queryExecutor;
          const cached = sessionExecutors.get(sid);
          if (cached) {
            // LRU: 命中后挪到末尾
            sessionExecutors.delete(sid);
            sessionExecutors.set(sid, cached);
            return cached;
          }
          // ★ Task #4486 Phase 3: 事件驱动的 turn 一律 silent 渲染
          //   （流式 chunk 不写 stdout，完成时整段提交），避免多会话并发时
          //   stdout 行互相穿插。ink 路径本来就是 silent，不受影响。
          const created = new QueryExecutor({
            env,
            sessionComponent,
            output,
            quiet: true,
            silent: true,
          });
          created.initStreamOutput(llmComponent);
          created.setSessionScope(sid);
          // ★ Task #4515 (M2 × H3): per-session executor **不是**"无 sessionId
          //   事件"的主人 —— 否则 M2 修完（无 sid 事件不再被丢）之后，一个无归属
          //   的 llm.* 会被主 executor + 每个 per-session executor 各渲染一份。
          //   主人是主 executor（见 QueryExecutor.execute 的默认 true）。
          created.setAcceptsSidelessEvents(false);
          // ★ Task #5117 (M1)：headless 下不注册 chunk callback
          //   （silent 渲染，stdout 只出摘要行）
          sessionExecutors.set(sid, created);
          while (sessionExecutors.size > MAX_SESSION_EXECUTORS) {
            // ★ Task #4486 收尾 review 修复：跳过**正在执行**的 session。
            //   旧实现无条件淘汰最旧的那个，可能 dispose 掉一个还在跑的
            //   executor —— dispose() 会 unsubscribe 事件，导致该会话的流式
            //   输出被静默吞掉（LLM 继续跑，用户只看到半截/空回复）。
            //   全都在跑时允许临时超限（宁可内存多占一点，也别丢输出）。
            let victim: string | undefined;
            for (const key of sessionExecutors.keys()) {
              if (!runningTurns.has(key)) {
                victim = key;
                break;
              }
            }
            if (victim === undefined) break;
            const evicted = sessionExecutors.get(victim);
            sessionExecutors.delete(victim);
            try {
              evicted?.dispose();
            } catch {
              // dispose 失败不影响主流程
            }
          }
          return created;
        };
        const disposeSessionExecutors = () => {
          for (const ex of sessionExecutors.values()) {
            try {
              ex.dispose();
            } catch {
              // ignore
            }
          }
          sessionExecutors.clear();
        };

        // ========== 3.x Agent 验证（复用 act 逻辑） ==========
        // 校验 --agent 指定的 agent 是否存在
        let currentAgentContext: any = undefined;
        if (args.agent && args.agent !== "default") {
          const agentComponent = env.getComponent("agent") as ActAgentLookup | undefined;
          const validation = validateActAgent(agentComponent, args.agent);
          if (!validation.valid) {
            output.error(validation.message);
            output.info("提示: roy-bot agents list");
            process.exit(1);
          }
          currentAgentContext = buildActAgentContext(args.agent);
          output.info(`Agent: ${args.agent}`);
        }

        // 初始化流式输出配置（设置 context window 信息）
        queryExecutor.initStreamOutput(llmComponent);

        // ========== 3.5 Coder-harness 插件加载（lsp/linter/typecheck）==========
        // 延迟加载 coder-harness 以避免影响 CLI 基础功能
        let pluginAdapterDispose: (() => Promise<void>) | null = null;
        let lspManagerDispose: (() => Promise<void>) | null = null;
        let memoryPluginDispose: (() => Promise<void>) | null = null;
        // MemoryPlugin 实例（用于 shutdown 时访问）
        let memoryPluginInstance: any = null;

        // Coder-harness 插件加载（lsp/linter/typecheck）
        // coder-harness 插件已通过 EnvironmentService.loadPlugins() 加载
        // 这里只需要处理 LSP 预热（如果需要）
        if (coderPluginNames.length > 0) {
          try {
            // 过滤有效的插件名称
            const enabledPlugins = coderPluginNames.filter(
              (p) => CODER_HARNESS_PLUGINS.has(p.split(":")[0])
            );
            if (enabledPlugins.length > 0) {
              console.log(`已启用插件: ${enabledPlugins.join(", ")}`);
              output.success(`✅ 已启用插件: ${enabledPlugins.join(", ")}`);
            }

            // ========== 3.6 Memory Plugin 加载 ==========
            // MemoryPlugin 已在 EnvironmentService 中创建并传入 MemoryComponent
            // 这里只需要注册到 AgentComponent 的 Hook 系统
            if (coderPluginNames.includes("memory")) {
              try {
                // 从 EnvironmentService 获取已创建的 MemoryPlugin 实例
                const memoryPluginInstance = (envService as any).getMemoryPlugin?.();
                
                if (memoryPluginInstance) {
                  // 注册到 AgentComponent（使用 default agent）
                  const agentComponent = env.getComponent("agent") as any;
                  if (agentComponent?.registerPlugin) {
                    // 确保 default agent 存在（可能在 queryExecutor.execute 之前调用）
                    if (!agentComponent.getAgent("default")) {
                      agentComponent.registerAgent("default", { type: "primary" });
                    }
                    
                    // 创建符合 Plugin 接口的对象
                    const pluginWrapper = {
                      name: memoryPluginInstance.name,
                      version: "1.0.0",
                      hooks: memoryPluginInstance.hooks,
                      execute: async (ctx: any) => {
                        await memoryPluginInstance.execute(ctx);
                        return { continue: true };
                      },
                    };
                    agentComponent.registerPlugin("default", pluginWrapper);
                    output.success("✅ Memory 插件已注册到 Agent");
                  }
                  
                  // 设置 dispose 函数
                  memoryPluginDispose = async () => {
                    if (memoryPluginInstance) {
                      memoryPluginInstance.prepareShutdown();
                      if (memoryPluginInstance.hasPendingTasks()) {
                        console.log("💾 正在保存记忆，请稍候...");
                        await memoryPluginInstance.waitForCompletion();
                      }
                      await memoryPluginInstance.dispose();
                      console.log("💾 记忆已保存完毕");
                    }
                  };
                } else {
                  output.warn("⚠️ Memory 插件未在 EnvironmentService 中初始化");
                }
              } catch (error) {
                output.warn(`⚠️ Memory 插件加载失败: ${error}`);
              }
            }

            // ========== 3.7 LSP Plugin 加载 ==========
            // 如果启用了 LSP 插件，预热 LSP 服务器
            if (coderPluginNames.includes("lsp")) {
              try {
                // 加载 LSP 配置
                const { createLSPConfigLoader } = await import("@ai-setting/roy-bot-coder-harness");
                const configLoader = createLSPConfigLoader();
                const lspConfig = configLoader.load();

                output.info("正在预热 LSP 服务器...");
                if (lspConfig.preload) {
                  output.info("📋 使用配置文件中的预加载设置");
                }
                const lspManager = createGlobalLSPManager({
                  idleTimeout: lspConfig.idleTimeout ?? 300000,
                  maxConnections: lspConfig.maxConnections ?? 10,
                  autoDownload: lspConfig.autoInstall ?? false,
                  preloadLanguages: lspConfig.preloadLanguages,
                });
                // 注册 shutdown handler 确保进程退出时清理
                lspManager.registerShutdownHandler();
                // 保存 dispose 函数以便在退出时调用
                lspManagerDispose = () => lspManager.dispose();
                // 预热所有服务器（异步，不阻塞）
                if (lspConfig.preload || coderPluginNames.includes("lsp")) {
                  lspManager.prewarm().then(() => {
                    output.success("✅ LSP 服务器预热完成");
                  }).catch((err: Error) => {
                    output.warn(`⚠ LSP 预热部分失败: ${err.message}`);
                  });
                }
              } catch (error) {
                output.warn(`⚠ LSP 预热失败: ${error}`);
              }
            }
          } catch (error) {
            output.error(`❌ 加载 coder-harness 插件失败: ${error}`);
          }
        }

        // ========== 4. Headless 主循环（★ Task #5117 M1，替代 REPL） ==========
        // 方案 §4.2：不再构造 REPL（P1/P2/P15 删除 Ink + readline 分支），
        // 事件处理语义平移到 HeadlessDispatcher（N7 不变项逐条保留）。
        // stdin 不读、不 createInterface；进程常驻由 ES 自身句柄撑住（修 D2）。
        /** F1: 最近一轮 LLM usage（headless 下仅记录，摘要行已含 tokens） */
        let lastTurnUsage: ReturnType<QueryExecutor["getLastUsage"]> = null;
        const dispatcher = new HeadlessDispatcher({
          sessionId,
          summary: headlessSummary,
          execute: async (message: string | ContentPart[], traceId?: string, agentContext?: any) => {
            // ★ Task #4486 Phase 3: 本轮的 session（事件驱动时来自事件，用户输入时是 REPL 默认）
            const runSessionId: string | undefined = agentContext?.eventSessionId;
            // 每次执行前重置**本 run** 的 abort 信号（不误清其他并发 run）
            resetStreamAbort(runSessionId);
            // Phase 3: 在 agentContext 里注入 --es 预加载的 systemPrompt(s)。
            // 每次 invoke LLM（普通对话 + event dispatch）都生效。
            // 必须是闭包变量 eventSourceSystemPrompts，不能用 this —
            // 因为 Yargs 调用 handler 时 this === {}，class field 不可见。
            // (兼容：默认 []，未传 --es 时直接走 undefined 分支)
            const preloadedPrompts = eventSourceSystemPrompts;
            const eventSourceSystemPrompt = preloadedPrompts.length > 0
              ? joinResolvedSystemPrompts(preloadedPrompts)
              : undefined;
            // ★ Task #4568：CLI 入口 emit trigger event。
            //
            // ## 判据为什么是「agentContext.envEvent 为空」而不是比较 sessionId
            //
            // 最初写的是 `!runSessionId || runSessionId === sessionId`，**这是错的**：
            //
            //   - 用户键入：handleUserQuery → executeInternal(payload, {showPrompt:false})
            //     —— agentContext 是 undefined（见 interactive.ts:1059）
            //   - 通知驱动：handleEventMessageWithEnv → executeInternal(message, {
            //       agentContext: { envEvent: envEventForAgent, ... } })
            //     —— envEvent **一定有值**（见 interactive.ts:1182）
            //
            //   而 `eventSessionId` 在两条路径上**都是同一个 REPL session**
            //   （EventHandler 缓存命中 / ensureActiveSession 复用）。
            //   交叉验证探针实测：通知驱动 turn 上 `runSessionId === sessionId` 为 **true**
            //   ⇒ 原来的判据把通知轮误判成用户轮 ⇒ **每轮 notify 都多写一条 trigger event**。
            //
            //   这不只是"多写一行"：`toCliEnvEvent()` 会把**新的 triggerEventId** 注入
            //   EnvContext，若 agent 在这轮里再 delegate，新任务的 notify 会指向一个
            //   "由通知产生"的 trigger event，debug 时链路语义含混。
            //
            //   ⇒ 判据改用**结构性标志**：本轮的 agentContext 里有没有 envEvent。
            //     有 = 本轮是"处理某个已有事件"，不该再伪造一个新事件。
            //
            // ## 为什么 await（而不是 fire-and-forget）
            //
            //   triggerEventId 必须在下游 delegate_task 之前就注入 EnvContext，
            //   否则 deriveTriggerEventIdFromEnvContext() 拿不到（断点 C）。
            //   代价 = 1 次 SQLite INSERT（实测亚毫秒级）。
            const isUserTurn = !agentContext?.envEvent;
            const cliTrigger = isUserTurn
              ? await emitCliTriggerEvent({
                  command: "run",
                  query: typeof message === "string" ? message : "",
                  sessionId: runSessionId ?? sessionId,
                })
              : null;

            // 用户拍板 ④：--no-quiet 时回显 triggerEventId（便于对 event_store.db 排查）
            //
            // ⚠️ 读 `args.quiet` 而**不是** `CliQuietModeService.isQuiet()`：
            //   本 handler 启动时无条件 `setQuiet(true)`（第 2206 行，为压住
            //   内部噪声），服务单例永远是 true，读它等于永不回显。
            //   `args.quiet` 是 yargs 全局 option，`--no-quiet` / `--noquiet`
            //   已被 quietModeMiddleware 归一化成 `quiet === false`。
            if (cliTrigger) {
              const echo = formatTriggerEcho(cliTrigger.triggerEventId, {
                quiet: args.quiet !== false,
              });
              // ⚠️ 真机验证发现：原来这里用 console.log，在 Ink 模式下会被
              //   Ink 接管终端的重绘吞掉/错序（实测 `[Trigger]` 打在了 `/exit`
              //   **之后**）。改用 writeTriggerEcho() 走统一的输出去向。
              if (echo) writeTriggerEcho(echo);
            }

            // 合并全局和临时的 agentContext
            const mergedContext = buildInteractiveMergedContext({
              currentAgentContext,
              turnAgentContext: agentContext,
              // ★ Task #4634（交叉验证 MINOR 1）：只传 model / fallbackModel
              //   两个字段，不把整个 yargs argv 塞进来（依赖面收窄）。
              modelFlags: { model: args.model, fallbackModel: args.fallbackModel },
              cliTrigger,
              eventSourceSystemPrompt,
              defaultAgentName: args.defaultAgentName,
              message,
            });
            // EventSource Shared Session: 如果事件处理提供了共享 session ID，使用它代替 REPL session
            const effectiveSessionId = mergedContext.eventSessionId ?? sessionId;
            // ★ Task #4486 Phase 3: 事件驱动的会话（≠ REPL 默认会话）用专属
            //   silent executor 隔离渲染；用户输入仍走主 executor（保持原交互体验）。
            const isEventDrivenTurn = !!runSessionId && runSessionId !== sessionId;
            const exec = isEventDrivenTurn
              ? getSessionExecutor(effectiveSessionId)
              : queryExecutor;
            // ★ Task #4486 收尾 review 修复：标记该 session 的 turn 正在跑，
            //   让 executor 池的 LRU 淘汰跳过它（否则可能 dispose 掉正在用的
            //   executor，把流式输出静默吞掉）。
            runningTurns.add(effectiveSessionId);
            try {
              const result = await exec.execute(message, effectiveSessionId, {
                showReasoning: args.reasoning,
                showToolCalls: args.toolCalls,
                showToolResults: args.toolResults,
              }, traceId, mergedContext);
              // ★ Task #5117 (M1) P10：stdout 只出摘要行 —— 完整回复走
              //   replyChannel（飞书等 IM），不再 console.log 全文/流式。
              void result;
              // F1: 最近 usage（[result] 行由 dispatcher.executeWithSummary 输出）
              lastTurnUsage = exec.getLastUsage();
              return result;
            } finally {
              runningTurns.delete(effectiveSessionId);
            }
          },
        });

        // Task #3000: 注册 SIGTERM handler（之前 interactive 模式完全没处理 SIGTERM）
        // ★ Task #5117 (M1)：headless 下 SIGINT 也直接走 graceful shutdown
        // （registerShutdownHandlers 同时注册两者；P12 剥离 REPL 的 Ctrl+C 语义）。
        registerShutdownHandlers(async () => {
          await shutdownInteractiveSteps({
            memoryPluginDispose: memoryPluginDispose,
            memoryPluginInstance: memoryPluginInstance,
            lspManagerDispose: lspManagerDispose,
            pluginAdapterDispose: pluginAdapterDispose,
            eventHandler: eventHandler,
            queryExecutor: queryExecutor,
            env: env,
            envService: envService,
            shouldDisposeEnvService: shouldDisposeEnvService,
            output: output,
            logger: logger,
            console: console,
          });
          // ★ M1：停机摘要（在 process.exit(0) 之前、cleanup 完成后输出）。
          //   shutdownInteractiveSteps 已把运行中的 ES 全部 stop。
          for (const r of esStartResults) {
            if (r.success) headlessSummary.lifecycleStopped(r.id);
          }
        });

        // ========== 5. EventHandler（事件驱动自动响应） ==========
        // Task #4042 ESPlugin v2 Phase 6 commit 2: 用 createEventHandlerForInteractive 工厂函数
        // 替代裸 new EventHandler()，自动注入 eventStore + getHandlerForEsType，
        // 让 v2 path（chatId 来自 trigger event）在生产路径上生效。
        // 直接 new EventHandler() 时 eventStore 是 optional 不传，
        // 等于 v2 path 在生产路径上是 dead path（等价 #4035 修的 chatId 来源
        // 问题在生产上没真正生效）。
        const eventHandler = createEventHandlerForInteractive({
          env,
          // ★ Task #5036：终态回执里附「📌 查看任务卡片」链接，直达卡片消息。
          //
          //   ★ 为什么必须在**这里**接（DS review BLOCKER B1）：
          //     `cli.ts` 里 `InteractiveCommand`（run.ts）才是 `roy-bot run`
          //     —— daemon 用的事件订阅命令。只改 `interactive.ts` 的话，用户
          //     在飞书收到的回执**永远不会**带链接，功能等于没上。
          //
          //   best-effort：库不存在 / 无该卡记录 / 查询失败 ⇒ undefined ⇒
          //   不附链接，绝不影响回执本身（解析器内部已吞掉所有异常）。
          resolveCardUrl: createCardUrlResolver(),
          eventTypes: ["task.background.*", "event-source.event.*"],  // 只监听任务事件和事件源的实际消息事件
          formatter: new EventMessageFormatter({ prefix: "[通知]" }),
          isIdle: () => !dispatcher.isBusy(),
          // ★ Task #4486: per-session 门禁 —— 同一 session 的消息串行，
          //   不同 session 的消息并行（不再被别的会话的执行挡住）。
          isSessionIdle: (sid: string) => dispatcher.isSessionIdle(sid),
          // EventSource Shared Session: 传入 sessionComponent 让 bounty-im 和 lark-cli 共享 session
          sessionComponent,
          // onEvent is required by EventHandlerOptions; we use onEventWithEnv below
          // for richer context (envEvent metadata / agent / pluginEnabled).
          onEvent: async (_message: string) => {
            // no-op — handled by onEventWithEnv
          },
          onEventWithEnv: async (formattedEvent) => {
            // 传递完整事件信息，包含 EnvEvent 用于构建 pluginEnabled
            // ★ Task #5117 (M1)：事件语义平移到 dispatcher（N7 不变）
            await dispatcher.handleEventMessageWithEnv(formattedEvent, {
              ensureActiveSession: async () => {
                // Task #1766: 确保有 active session（原 REPL.ensureActiveSession）
                try {
                  const activeId = sessionComponent.getActiveSessionId();
                  if (!activeId) {
                    await sessionManager.init(undefined, false);
                  }
                } catch (error) {
                  console.error(`[headless] Failed to ensure active session:`, error);
                }
              },
            });
          },
        });
        
        // 启动事件监听
        const stopEventHandler = eventHandler.start();

        // ========== 6. EventSource 启动（支持多个） ==========
        // args.eventSource 是 array（Yargs 自动把单值包装为 array）
        const rawEventSourceIds = args.eventSource as string[] | string | undefined;
        const eventSourceIds: string[] = Array.isArray(rawEventSourceIds)
          ? rawEventSourceIds.filter((s) => !!s)
          : rawEventSourceIds
            ? [rawEventSourceIds]
            : [];
        // ★ Task #5117 (M1)：启动结果（供主循环输出 [lifecycle] es-started）
        //   （声明已上移到 try 外，见 M3-review MINOR-2）
        if (eventSourceIds.length > 0) {
          const eventSourceComponent = env.getComponent("event-source") as any;

          if (!eventSourceComponent || typeof eventSourceComponent.startSource !== "function") {
            output.error(`❌ 未找到事件源组件或 startSource 方法`);
            output.info(`请确保 EventSourceComponent 已正确注册`);
            process.exit(1);
          }

          const summary = await startEventSources(eventSourceIds, eventSourceComponent, output);
          // ★ Task #5117 (M1)：留引用给主循环输出 [lifecycle] es-started
          esStartResults.push(...summary.results);

          // Phase 3: collect & preload systemPrompts for all started event sources.
          // 让 LLM 在所有 invoke (普通对话 + event dispatch) 中都看到这些 prompt。
          // 必须是 handler 闭包变量 (per-invocation)，不能用 this。
          eventSourceSystemPrompts = collectEventSourceSystemPrompts(eventSourceIds, eventSourceComponent);
          if (eventSourceSystemPrompts.length > 0) {
            output.info(`📦 Preloaded ${eventSourceSystemPrompts.length} event-source systemPrompt(s)`);
          }

          // 如果是单值且失败，保持向后兼容（process.exit）
          // 多值时，single failure 不会 block 其他
          if (eventSourceIds.length === 1 && summary.failedCount > 0) {
            // 单值：保留原有的 fail-fast 行为
            process.exit(1);
          }
        }

        // ========== 7. 信号处理 + headless 主循环（★ Task #5117 M1 §4.2）==========
        // P12：SIGINT 不再有 REPL 的多行取消/再见语义 —— SIGINT/SIGTERM
        // 都直接走 graceful shutdown（registerShutdownHandlers 已同时注册
        // 两者，lifecycle.ts:126），无需额外 SIGINT handler。
        //
        // P14：不再 await repl.start()（readline line/close 循环）。
        // 进程常驻由 ES 自身句柄撑住（lark-cli 子进程 / timer setInterval），
        // 不依赖 readline（顺带修 D2：timer-only ES 不再秒退）。
        for (const r of esStartResults) {
          if (r.success) headlessSummary.lifecycleStarted(r.id);
        }

        // 等待 shutdown 信号（SIGTERM/SIGINT → registerShutdownHandlers
        // 的 cleanup：停 ES + 输出 [lifecycle] es-stopped → process.exit(0)）。
        // es-stopped 摘要在 cleanup 尾部、process.exit(0) 之前输出
        // （见上方 registerShutdownHandlers 闭包）。
        await new Promise<void>(() => {
          // 永不 resolve —— 由 signal handler 调 process.exit 结束进程。
          // 事件循环由 ES 句柄（lark-cli 子进程 / timer setInterval）撑住；
          // 若所有 ES 都退出（极端场景），进程自然退出，finally 兜底。
        });
      } catch (error) {
        headlessSummary.fatal(`启动失败: ${error}`);
        throw error;
      } finally {
        // 只在内部创建 envService 时才 dispose
        if (shouldDisposeEnvService) {
          await envService.dispose();
        }
      }
    },
  };
}

/**
 * InteractiveCommand - 交互式命令（默认实例，用于 CLI）
 * 
 * 核心复用：
 * - SessionManager: Session 管理
 * - QueryExecutor: 查询执行
 * - REPL: 交互循环
 */
export const InteractiveCommand = createInteractiveCommand();
