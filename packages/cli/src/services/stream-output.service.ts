/**
 * @fileoverview Stream Output Service
 *
 * 处理 LLM 流式事件并输出到控制台
 */

import chalk from "chalk";
import type { EnvEvent } from "@ai-setting/roy-bot-core";
import { createLogger, TracedAs } from "@ai-setting/roy-bot-core";
import { MarkdownRenderer } from "../lib/markdown-renderer";

// 创建 logger
const logger = createLogger("stream-output");

// ============ ANSI 颜色定义 ============
//
// 3 档色阶 (Claude Code 风格):
//   - primary: 亮白，主文本/标题
//   - secondary: 中灰，二级信息/dim 文本
//   - accent: 暖红 (#ff6b6b)，高亮/状态点/装饰
//
// 同时保留旧 8 色 API（userInput/assistant/system/reasoning/toolCall/toolResult/error/progress）
// 保持向后兼容，不破坏现有 stream-output.service.test.ts。
export const COLORS = {
  // ====== 3 档色阶 (新 API，Task #2252) ======
  /** 亮白 — 主文本、标题、提示符 */
  primary: chalk.bold.whiteBright,
  /** 中灰 — dim 文本、二级信息 */
  secondary: chalk.gray,
  /** 暖红 (#ff6b6b) — 高亮、状态点、装饰 */
  accent: (s: string) => chalk.hex("#ff6b6b")(s),
  /** 暖红 bold — 强调标题（"What's new" / "Tips"） */
  accentBold: (s: string) => chalk.hex("#ff6b6b").bold(s),
  /** 暗灰（用于边框/分隔线） */
  muted: chalk.dim,

  // ====== 旧 8 色 (保持向后兼容) ======
  // 用户输入颜色 (cyan)
  userInput: chalk.cyan,
  userInputPrefix: chalk.cyan("❯"),

  // Assistant 输出颜色 (green)
  assistant: chalk.green,

  // 系统消息颜色 (yellow)
  system: chalk.yellow,

  // 思考过程颜色 (dim gray)
  reasoning: chalk.dim.gray,

  // 工具调用颜色 (magenta)
  toolCall: chalk.magenta,

  // 工具结果颜色 (blue)
  toolResult: chalk.blue,

  // 错误颜色 (red)
  error: chalk.red,

  // 进度/思考中颜色 (dim)
  progress: chalk.dim,
} as const;

// Abort 信号类型
export type AbortSignal = {
  aborted: boolean;
};

/**
 * 全局 abort 信号（用于流式输出中断）
 *
 * ★ Task #4486：per-run 并发后仍然是**全局兜底标记** ——
 * 无 scope 的 `abortStream()` / `resetStreamAbort()` 保持旧语义
 * （旧测试与 ESC 路径都直接读/写它）。
 */
export const streamAbortSignal: AbortSignal = {
  aborted: false,
};

/**
 * ★ Task #4486：per-run abort 标记集合，键是 runId / sessionId。
 *
 * 为什么需要：并发多 session 时，A run 结束调 `resetStreamAbort()` 会把
 * B run 的 abort 状态也清掉（或反过来 A 的 abort 打断 B 的输出）。
 * 现在每个 run 只清/置自己的 key。
 */
const abortedRuns: Set<string> = new Set();

/**
 * 重置 abort 信号
 *
 * @param scope ★ Task #4486: runId / sessionId
 *   - 传 scope → 只清该 run 的标记（单 run 结束只清自己）
 *   - 不传 → 只清**全局** abortAll 标记（ESC 后开新一轮的场景），
 *     **不动**其他 run 的 per-run 标记
 *
 * ⚠️ 收尾 review 修复：旧实现「无 scope = 连 `abortedRuns` 一起清空」会让
 *    并发时 session B 开新一轮就把 session A 的 abort 标记抹掉
 *    （`run.ts` 的 `executeInternal` 每轮都会调无 scope 版本）。
 *    要清空全部（测试 / shutdown）请用 `__resetAllStreamAbortForTest()`。
 */
export function resetStreamAbort(scope?: string): void {
  if (scope === undefined) {
    streamAbortSignal.aborted = false;
    return;
  }
  abortedRuns.delete(scope);
  // ★ Task #4515 (L3) 备注：scope 的取值是 **sessionId**，所以同一 session 若真
  //   出现两轮并发，新一轮的 reset 会把另一轮的 abort 标记一起清掉。
  //   #4514 复审判定为低危，且「修 H2 后自动消失」—— H2 已在本轮修复（lane 以
  //   sessionId 为 canonical key + claimSession 原子门禁），同 session 双跑不再
  //   可达。若将来引入"同 session 并行多 turn"，这里必须改成 per-turn runId。
}

/**
 * 请求 abort 流式输出
 *
 * @param scope ★ Task #4486: runId / sessionId
 *   - 传 scope → 只置该 run 的标记
 *   - 不传 → 全局 abort（ESC 的 abortAll 语义，向后兼容）
 */
export function abortStream(scope?: string): void {
  if (scope === undefined) {
    streamAbortSignal.aborted = true;
    return;
  }
  abortedRuns.add(scope);
}

/**
 * ★ Task #4486：查询某 run 是否被 abort。
 *
 * 语义（收尾 review 修复）：
 * - 该 run 自己的标记（`abortStream(scope)`）→ 停
 * - **全局 abortAll 标记（ESC / `/abort` 的 `abortStream()`）→ 也停**
 *   否则 ESC 对绑了 runId 的流完全失效（相对 main 的功能回归：
 *   main 没有 runId，所有流都读全局 `streamAbortSignal`）。
 * - 别的 run 被单独 abort → **不影响**本 run（per-run 隔离仍然成立）
 */
export function isStreamAborted(scope?: string): boolean {
  // 全局 abortAll 一票否决（ESC / /abort 的既有契约 = 中断所有）
  if (streamAbortSignal.aborted) return true;
  if (scope === undefined) return false;
  return abortedRuns.has(scope);
}

/**
 * ★ Task #4486：测试 / shutdown 用 —— 清空所有 abort 状态。
 */
export function __resetAllStreamAbortForTest(): void {
  streamAbortSignal.aborted = false;
  abortedRuns.clear();
}

/**
 * Usage 信息接口
 */
export interface UsageInfo {
  /** 模型名称 */
  model: string;
  /** Provider ID */
  providerId?: string;
  /** Prompt tokens */
  promptTokens?: number;
  /** Completion tokens */
  completionTokens?: number;
  /** Total tokens */
  totalTokens?: number;
  /** Anthropic prompt cache read tokens (cache_read_input_tokens).
   *  Captured from `metadata.usage.cacheRead` published by core's
   *  `extractUsageInfo` (I4 in review-cache-stability.md). */
  cacheRead?: number;
  /** Anthropic prompt cache write tokens (cache_creation_input_tokens).
   *  See {@link cacheRead} for semantics. */
  cacheWrite?: number;
  /** Cache-aware input denominator (promptTokens + cacheRead + cacheWrite),
   *  computed by core's `normalizeUsage()` (Task #4373). Used so the rendered
   *  hit rate reflects real input volume instead of the old
   *  `cacheRead/(cacheRead+cacheWrite)` which always looked like 100%. */
  promptTokensTotal?: number;
}

export interface StreamOutputOptions {
  /** 显示推理/思考过程 */
  showReasoning?: boolean;
  /** 显示工具调用 */
  showToolCalls?: boolean;
  /** 显示工具结果 */
  showToolResults?: boolean;
  /**
   * Task #2286: silent 模式
   *
   * silent=true 时禁用所有 stdout 写入（process.stdout.write / console.log），
   * 仅通过 chunk callback（setChunkCallback）输出。
   *
   * 用法:
   * - readline 路径: silent=false (默认) — 现有 stdout-only 行为，向后兼容
   * - ink REPL 路径: silent=true — ink 自己渲染 chunk，stdout 输出会造成重复
   *
   * silent 不影响 emitChunk — chunk callback 始终触发。
   * silent 不影响 logger.warn / logger.error — 这些走 logger 不走 stdout。
   */
  silent?: boolean;
}

/**
 * Task #2280: ink REPL 集成的 chunk 回调
 *
 * 让 StreamOutputService 在每个 LLM 事件触发时通知外部 ink REPL，
 * 由 ink REPL 决定如何 push 到自己的 React state。
 *
 * - 不传 = 现有 stdout-only 行为（向后兼容，不破坏 1238 个测试）
 * - 传了 = 同步触发 ink 渲染（独立于 stdout 输出）
 */
export interface StreamChunkEvent {
  type: "llm.text" | "llm.reasoning" | "llm.completed" | "tool.call" | "tool.result" | "tool.error";
  // llm.text / llm.reasoning
  delta?: string;
  content?: string;
  // llm.reasoning phase
  phase?: "end";
  // tool.*
  toolName?: string;
  toolId?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  toolError?: string;
  // llm.completed
  fullContent?: string;
  /**
   * Task #4396: usage of the LLM call that just completed.
   *
   * The interactive TUI renders a dim cache/token footer under every
   * assistant message, but it only ever sees StreamChunkEvents (it never
   * holds the StreamOutputService instance). Without this field, the usage
   * parsed by `handleCompleted()` was unreachable from the Ink layer.
   *
   * `undefined` means the provider reported no usage at all — the footer
   * then renders nothing rather than a misleading zero.
   */
  usage?: UsageInfo;
}
export type StreamChunkCallback = (event: StreamChunkEvent) => void;

/**
 * Task #4396: does this usage record carry at least one real number?
 *
 * `handleCompleted()` constructs a usage object whenever the event carries
 * a model name OR usage, so a model-only event produces `{model, providerId}`
 * with every counter undefined. The TUI footer must not render that.
 */
export function hasNumericUsage(
  usage: UsageInfo | undefined | null,
): usage is UsageInfo {
  if (!usage) return false;
  return (
    typeof usage.promptTokens === "number" ||
    typeof usage.completionTokens === "number" ||
    typeof usage.totalTokens === "number" ||
    typeof usage.cacheRead === "number" ||
    typeof usage.cacheWrite === "number" ||
    typeof usage.promptTokensTotal === "number"
  );
}

/**
 * 流式输出服务
 * 
 * 订阅 Environment 的 LLM 事件，流式输出文本到 stdout
 */
export class StreamOutputService {
  private fullText: string = "";
  private fullReasoning: string = "";
  private options: StreamOutputOptions;
  private usageInfo?: UsageInfo;
  private contextWindow?: number;
  private contextThreshold?: number;
  private isFirstText = true;  // 用于控制换行
  private reasoningStarted = false;  // 思考过程框是否已显示
  private thinkingPrinted = false;  // "[thinking...]" 是否已打印
  /** 未显示的推理缓冲区：当 reasoning-delta 到达时先缓存，
   *  在 text/tool/completed 时统一刷新（避免碎片化）。 */
  private reasoningBuffer: string = "";
  /** 增量 Markdown → ANSI 渲染器。处理每个文本 delta 的状态化转义。 */
  private markdownRenderer: MarkdownRenderer = new MarkdownRenderer();
  /** 框是否已被 text 关闭。关闭后不再显示后续 reasoning delta，
   *  因为相同内容会以 text 形式（绿色）输出。 */
  private reasoningClosedByText: boolean = false;
  /** Task #2280: 外部 chunk 回调（ink REPL 集成用）。undefined = 不触发。 */
  private chunkCallback: StreamChunkCallback | undefined = undefined;
  /** Task #2286: silent 模式 — true 时禁用所有 stdout 写入，仅 emitChunk。 */
  private silent: boolean = false;
  /**
   * ★ Task #4486: 只处理该 sessionId 的事件（undefined = 不过滤，向后兼容）。
   * 并发多 session 时，每个 QueryExecutor 实例只订阅/渲染自己的 session。
   */
  private sessionFilter: string | undefined = undefined;
  /**
   * ★ Task #4515 (M2 × H3): 是否接收"没有 sessionId"的事件。
   *
   * 为什么需要：M2 修正后 filter 语义是「只有带了 sessionId 且不匹配才丢」，
   * 于是**无 sessionId 的事件会通过所有 executor 的过滤** —— 主 executor 与
   * 每个 per-session executor 各渲染一份，反而造成新的重复渲染（交叉验证实测
   * 3 份）。M2 与 H3 组合后必须给"无归属事件"指定**唯一主人**。
   *
   * 语义：
   *   - `true`（默认，向后兼容）：接收无 sessionId 的事件
   *   - `false`：跳过无 sessionId 的事件（只有绑了 filter 的非主 executor 才设）
   */
  private acceptsSidelessEvents: boolean = true;
  /**
   * ★ Task #4486: 绑定的 runId（abort 隔离用）。
   * undefined = 走旧的全局 abort 语义。
   */
  private runId: string | undefined = undefined;

  constructor(options: StreamOutputOptions = {}) {
    this.options = options;
    this.silent = options.silent ?? false;
  }

  /**
   * 更新流式输出选项（订阅已建立后仍可刷新）
   */
  setOptions(options: StreamOutputOptions): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * 设置上下文窗口信息
   */
  setContextInfo(window: number, threshold: number): void {
    this.contextWindow = window;
    this.contextThreshold = threshold;
  }

  /**
   * Task #2280: 设置外部 chunk 回调（ink REPL 集成用）。
   * 传 undefined 等于关闭。
   * 注意：必须用 try/catch wrap 调用，因为外部 ink API 抛错不能影响 stdout 流。
   */
  setChunkCallback(cb: StreamChunkCallback | undefined): void {
    this.chunkCallback = cb;
  }

  /**
   * ★ Task #4486: 设置 session 过滤（undefined = 不过滤）。
   *
   * 事件 sessionId 提取顺序：`event.metadata.sessionId` → `event.payload.metadata.sessionId`。
   *
   * ★ Task #4515 (M2): 语义修正 —— 过滤开启时**只有"带了 sessionId 且不匹配"**
   * 的事件才被丢弃。取不到 sessionId 的事件照常处理：无法归属不等于不属于本
   * session（`llm.*` 的 sessionId 来自 `InvokeOptions.context.sessionId`，不是
   * 所有调用点都传；`tool.*` / `context.*` 同理）。旧实现"不匹配就丢"会把这类
   * 合法事件静默吞掉。
   */
  setSessionFilter(sessionId: string | undefined): void {
    this.sessionFilter = sessionId;
  }

  /**
   * ★ Task #4515 (M2 × H3): 设置是否接收"没有 sessionId"的事件。
   *
   * 没有 sessionId 的 llm.* / tool.* / context.* 无法归属到任何 session，
   * 只能有**一个** executor 渲染它，否则就是重复输出。约定：
   *   - 主 executor（REPL 用户输入用）→ true（它是无归属事件的兜底主人）
   *   - per-session executor           → false（只渲染自己 session 的）
   *
   * 默认 true，保持既有调用方行为不变。
   */
  setAcceptsSidelessEvents(accepts: boolean): void {
    this.acceptsSidelessEvents = accepts;
  }

  /**
   * ★ Task #4486: 绑定 runId（per-run abort 隔离用）。
   */
  setRunId(runId: string | undefined): void {
    this.runId = runId;
  }

  /**
   * Task #2280: 内部 helper — 触发外部 chunk 回调（带 try/catch 保护）
   */
  private emitChunk(event: StreamChunkEvent): void {
    if (!this.chunkCallback) return;
    try {
      this.chunkCallback(event);
    } catch (err) {
      // 外部回调出错不影响 stdout 流
      logger.warn("chunk callback failed", { error: String(err) });
    }
  }

  /**
   * Task #2286: writeStdout — silent 模式感知
   *
   * silent=true 时返回（不写 stdout），silent=false 时正常写。
   * 这是修复 ink REPL 模式下 stdout + chunk 双重输出导致重复 bug 的关键。
   */
  private writeStdout(text: string): void {
    if (this.silent) return;
    process.stdout.write(text);
  }

  /**
   * Task #2286: silent 模式的 console.log helper
   *
   * checkAbort 用 console.log 而不是 process.stdout.write。
   * 提供 logStdout 让所有 stdout 写入都能被 silent 控制。
   */
  private logStdout(message: string): void {
    if (this.silent) return;
    console.log(message);
  }

  /**
   * 检查是否已 abort
   */
  private checkAbort(): boolean {
    // ★ Task #4486: 绑了 runId 时只看自己的标记（不被别的 run 的 abort 打断）；
    //   没绑时保持旧的全局语义。
    const aborted =
      this.runId !== undefined ? isStreamAborted(this.runId) : streamAbortSignal.aborted;
    if (aborted) {
      // 输出 abort 提示（silent 模式下 ink REPL 自己显示 abort state）
      this.logStdout(`\n${COLORS.system("[已中断]")}\n`);
      return true;
    }
    return false;
  }

  /**
   * ★ Task #4486: 从事件里取 sessionId（顶层 metadata 优先，再 payload.metadata）。
   */
  private extractEventSessionId(event: EnvEvent): string | undefined {
    const fromMeta = (event as { metadata?: { sessionId?: unknown } })?.metadata?.sessionId;
    if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
    const fromPayload = (event as { payload?: { metadata?: { sessionId?: unknown } } })
      ?.payload?.metadata?.sessionId;
    if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload;
    return undefined;
  }

  /**
   * 处理环境事件
   */
  handleEvent(event: EnvEvent): void {
    // ★ Task #4486: session 过滤 —— 只渲染本 session 的事件。
    //   并发多 session 时，别的 session 的 llm.* / tool.* 不能混进本 ticker。
    //
    // ★ Task #4515 (M2): 只有"**带了 sessionId 且不匹配**"才丢弃。
    //   无 sessionId 的事件无法归属，照常处理（否则会把没有 context.sessionId
    //   的合法 llm.*/tool.*/context.* 事件静默吞掉）。
    if (this.sessionFilter !== undefined) {
      const eventSessionId = this.extractEventSessionId(event);
      if (eventSessionId === undefined) {
        // 无归属事件：只有"主人"渲染（否则 M2 × H3 会让所有 executor 各渲染一份）
        if (!this.acceptsSidelessEvents) return;
      } else if (eventSessionId !== this.sessionFilter) {
        return;
      }
    }

    // 检查 abort 信号
    if (this.checkAbort()) {
      return;
    }

    const { type, payload } = event;

    switch (type) {
      case "llm.start":
        this.handleStart(payload as { metadata?: { model?: string } });
        break;
        
      case "llm.text":
        this.handleText(payload as { delta?: string; content?: string });
        break;
        
      case "llm.reasoning":
        this.handleReasoning(payload as { content?: string; delta?: string; phase?: "end" });
        break;

      case "tool.call":
        this.handleToolCall(payload as {
          id?: string;
          name?: string;
          arguments?: Record<string, unknown>;
        });
        break;
        
      case "tool.result":
        this.handleToolResult(payload as { id?: string; name?: string; result?: { output?: unknown; error?: unknown } });
        break;
        
      case "tool.error":
        this.handleToolError(payload as { toolName?: string; error?: string });
        break;
        
      case "llm.completed":
        this.handleCompleted(payload as { content?: string; metadata?: unknown });
        break;
    }
  }

  /**
   * 处理开始事件
   */
  private handleStart(payload: { metadata?: { model?: string } }): void {
    // 新 LLM 调用开始：重置跨调用状态
    this.reasoningClosedByText = false;
    this.reasoningBuffer = "";
    this.fullReasoning = "";
    this.isFirstText = true;
    this.reasoningStarted = false;
    this.thinkingPrinted = false;

    if (payload.metadata?.model) {
      // 可选：显示模型信息
      // process.stderr.write(`\n[Using model: ${payload.metadata.model}]\n`);
    }
  }

  /**
   * 清除 "[thinking...]" 占位
   * 注意：清空整行而非仅 20 字符，处理 trace 前缀情况
   */
  private clearThinkingPlaceholder(): void {
    if (!this.thinkingPrinted) {
      this.thinkingPrinted = true;
      // 清空整行（80 字符足够覆盖 trace prefix + [thinking...]）
      this.writeStdout("\r" + " ".repeat(80) + "\r");
    }
  }

  /**
   * 刷新推理缓冲区：将累积的 reasoningBuffer 一次性写入输出框。
   * 在 text/tool/completed 到达时自动调用，确保推理内容被一次性显示，
   * 避免第一个 reasoning-delta 只有几个字符就打开框导致的碎片化。
   */
  private flushReasoningBuffer(): void {
    if (!this.reasoningBuffer) return;
    if (this.reasoningStarted) return;

    this.clearThinkingPlaceholder();
    this.reasoningStarted = true;
    this.writeStdout("\n\n" + COLORS.reasoning("┌─ 思考过程 ─") + "\n");
    this.writeStdout(COLORS.reasoning(this.reasoningBuffer));
    this.reasoningBuffer = "";
  }

  /**
   * 关闭思考过程框
   *
   * 先刷新缓冲，再关闭框。
   * 分隔符宽度根据 fullReasoning 长度自适应（8-40 字符）。
   */
  private closeReasoningBlock(): void {
    // 先刷新缓冲（如果有）
    this.flushReasoningBuffer();

    if (this.reasoningStarted) {
      const len = this.fullReasoning.length;
      const dividerWidth = len === 0 ? 8 : Math.max(8, Math.min(40, len));
      this.writeStdout(COLORS.reasoning("\n└" + "─".repeat(dividerWidth) + "\n"));
      this.reasoningStarted = false;
    }
  }

  /**
   * Check if a text delta is truly empty (undefined / null / "").
   *
   * Pure-whitespace deltas (e.g. " ", "\n") are NOT empty — they are
   * legitimate token-boundary content from streaming LLMs and must be
   * preserved to avoid `viaJSONL` / `functioncall` / `returnvalue`
   * style concatenation bugs (Task #2237).
   *
   * An empty string is treated as a no-op so we don't break the
   * "empty text delta must not close the reasoning block" invariant
   * established in Task #2193.
   */
  private isEmptyDelta(text: string | undefined | null): boolean {
    return text === undefined || text === null || text === "";
  }

  /**
   * 处理文本事件
   */
  @TracedAs("stream.handle-text", {
    recordParams: true,
    recordResult: false,
    paramFilter: (args: any[]) => ({
      "payload.delta.length": args[0]?.delta?.length ?? 0,
      "payload.content.length": args[0]?.content?.length ?? 0,
    }),
  })
  private handleText(payload: { delta?: string; content?: string }): void {
    this.clearThinkingPlaceholder();

    const text = payload.delta ?? payload.content ?? "";
    if (this.isEmptyDelta(text)) return;

    // text 到达时关闭 reasoning 块，确保文字输出在块外部。
    this.closeReasoningBlock();
    // reasoning 框已被 text 关闭，后续 reasoning delta 不再显示
    // （相同内容会以 text 形式输出为绿色）
    this.reasoningClosedByText = true;

    // 如果是第一个文本块，先换行
    if (this.isFirstText) {
      this.writeStdout("\n");
      this.isFirstText = false;
    }

    // ★ NEW: route through MarkdownRenderer for ANSI styling
    // (handles headings, bold/italic, inline code, fenced code blocks,
    //  lists, blockquotes, links — see packages/cli/src/lib/markdown-renderer.ts).
    // push() returns the prefix safe to emit now; we feed the assistant
    // color wrapper around it for visual consistency with non-markdown output.
    const rendered = this.markdownRenderer.push(text);
    this.writeStdout(COLORS.assistant(rendered));
    this.fullText += text;  // keep raw text for getFullText() / usage

    // Task #2280: 通知 ink REPL（如果注册了 chunkCallback）
    // Task #2286: silent 模式下也触发（ink REPL 需要）
    this.emitChunk({
      type: "llm.text",
      delta: text,
    });
  }

  /**
   * 处理思考过程事件
   * 
   * 策略：
   * - 框已打开 → 流式输出（即时写）
   * - 框未打开但缓冲足够 → 刷新缓冲打开框（流式开始）
   * - 框未打开且缓冲不足 → 继续累积（防碎片）
   * - 框已被 text 关闭 → 丢弃（相同内容会以绿色 text 输出）
   */
  private handleReasoning(payload: { content?: string; delta?: string; phase?: "end" }): void {
    // phase: "end" 来自 AI SDK 的 reasoning-end 事件，之后还有 text-delta，
    // 不在此处关闭 reasoning 块。块会在 text / tool / completed 时自动关闭。
    if (payload.phase === "end") return;

    if (!this.options.showReasoning) return;

    const delta = payload.delta ?? this.extractReasoningDelta(payload.content);
    if (!delta) return;

    // 累积到 fullReasoning（用于最终统计和分隔符宽度计算）
    this.fullReasoning += delta;

    // 框已被 text 关闭 → 静默累积（不在打开框）。
    // 内容已经以绿色 text 形式输出，避免重复 + 颜色混乱。
    // 仅在 handleStart 重置时才能再次显示 reasoning。
    if (this.reasoningClosedByText) return;

    // 框已打开 → 流式输出
    if (this.reasoningStarted) {
      this.writeStdout(COLORS.reasoning(delta));
    } else {
      // 累积到缓冲区
      this.reasoningBuffer += delta;

      // 缓冲足够 → 刷新缓冲打开框，开始流式输出
      if (this.reasoningBuffer.length >= 15) {
        this.flushReasoningBuffer();
      }
    }

    // Task #2280: 通知 ink REPL（如果注册了 chunkCallback）
    //
    // Task #4278 片6 回归修复：emitChunk 必须**无条件**执行。此前它在
    // `reasoningStarted` 的 early-return 之后 → 只有第一条 delta 会被 emit
    // （第一条 ≥15 字符 flush 后 reasoningStarted=true，后续 delta 全被吞），
    // TUI 的「thinking 展开区」因此只能看到前 ~15 字符。silent 模式下 stdout
    // 分支是 no-op，所以 emit 是 TUI 拿到完整 reasoning 的唯一通道。
    this.emitChunk({
      type: "llm.reasoning",
      delta,
    });
  }

  /**
   * 从累积 content 中提取增量（兼容旧事件格式）
   */
  private extractReasoningDelta(content?: string): string {
    if (!content) return "";
    if (content.startsWith(this.fullReasoning)) {
      return content.slice(this.fullReasoning.length);
    }
    return "";
  }

  /**
   * 处理工具调用事件（agent executeTool 发布）
   */
  private handleToolCall(payload: {
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  }): void {
    if (!this.options.showToolCalls) return;

    const name = payload.name ?? "unknown";

    this.clearThinkingPlaceholder();
    this.closeReasoningBlock();

    this.writeStdout(
      "\n" + COLORS.toolCall(`🔧 [Tool] ${name} call`) + "\n"
    );

    // Task #2280: 通知 ink REPL
    this.emitChunk({
      type: "tool.call",
      toolName: name,
      toolId: payload.id,
      toolArgs: payload.arguments,
    });
  }

  /**
   * 处理工具执行结果
   */
  private handleToolResult(payload: {
    id?: string;
    name?: string;
    result?: { output?: unknown; error?: unknown };
  }): void {
    if (!this.options.showToolResults) return;

    // 在输出 tool result 前关闭 reasoning 块
    this.closeReasoningBlock();

    const name = payload.name ?? "unknown";
    const result = payload.result?.output ?? payload.result?.error ?? "无输出";
    this.writeStdout(
      "\n" + COLORS.toolResult(`📤 ${name}: ${String(result).substring(0, 200)}`) + "\n"
    );

    // Task #2280: 通知 ink REPL
    // Task #4124: 带上 toolId，方便 ink TUI 把结果匹配回对应的 tool.call。
    this.emitChunk({
      type: "tool.result",
      toolName: name,
      toolId: payload.id,
      toolResult: payload.result?.output,
    });
  }

  /**
   * 处理工具执行错误
   */
  private handleToolError(payload: { toolName?: string; error?: string }): void {
    if (!this.options.showToolCalls && !this.options.showToolResults) return;

    // 在输出工具错误前关闭 reasoning 块
    this.closeReasoningBlock();

    this.writeStdout(
      "\n" + COLORS.error(`❌ ${payload.toolName ?? "unknown"}: ${payload.error ?? "unknown error"}`) + "\n"
    );

    // Task #2280: 通知 ink REPL
    this.emitChunk({
      type: "tool.error",
      toolName: payload.toolName,
      toolError: payload.error,
    });
  }

  /**
   * 处理完成事件
   */
  private handleCompleted(payload: { content?: string; metadata?: unknown }): void {
    // 完成时输出换行
    this.writeStdout("\n");

    this.closeReasoningBlock();

    // 提取 usage 信息
    const metadata = payload.metadata as {
      model?: string;
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        promptTokensTotal?: number;
      };
    } | undefined;

    if (metadata?.model || metadata?.usage) {
      let modelName = metadata.model || "";
      let providerId: string | undefined;

      // 解析 model 名称（格式：provider/model 或 model）
      if (modelName.includes("/")) {
        const parts = modelName.split("/");
        providerId = parts[0];
        modelName = parts[parts.length - 1];
      }

      this.usageInfo = {
        model: modelName,
        providerId,
        promptTokens: metadata.usage?.promptTokens,
        completionTokens: metadata.usage?.completionTokens,
        totalTokens: metadata.usage?.totalTokens,
        // F1: propagate cacheRead/cacheWrite so REPL can render 💰 Cache line
        cacheRead: metadata.usage?.cacheRead,
        cacheWrite: metadata.usage?.cacheWrite,
        promptTokensTotal: metadata.usage?.promptTokensTotal,
      };

      // 打印 usage 日志
      const logData: Record<string, unknown> = {
        promptTokens: this.usageInfo.promptTokens,
        completionTokens: this.usageInfo.completionTokens,
        totalTokens: this.usageInfo.totalTokens,
        cacheRead: this.usageInfo.cacheRead,
        cacheWrite: this.usageInfo.cacheWrite,
        promptTokensTotal: this.usageInfo.promptTokensTotal,
      };

      // 添加 context 信息（如果已设置）
      if (this.contextWindow !== undefined) {
        logData.contextWindow = this.contextWindow;
        if (this.contextThreshold !== undefined) {
          logData.contextThreshold = this.contextThreshold;
          // 计算使用率
          if (this.usageInfo.totalTokens && this.contextWindow) {
            const usageRate = (this.usageInfo.totalTokens / this.contextWindow * 100).toFixed(1);
            logData.usageRate = `${usageRate}%`;
          }
        }
      }

      logger.info(`[LLM] ${modelName}`, logData);
    }

    // Task #2280: notify ink REPL (completed event).
    // Task #4396: carry the usage so the TUI can render a per-message
    // cache/token footer. `handleCompleted()` builds `usageInfo` whenever
    // *either* model or usage is present, so a model-only payload yields an
    // all-undefined object; emitted as-is it would look like "usage
    // reported but empty". Collapse that to `undefined` so the footer
    // degrades to nothing instead of a fake row of zeros.
    this.emitChunk({
      type: "llm.completed",
      fullContent: payload.content ?? this.fullText,
      usage: hasNumericUsage(this.usageInfo) ? this.usageInfo : undefined,
    });
  }

  /**
   * 获取完整文本
   */
  getFullText(): string {
    return this.fullText;
  }

  /**
   * 获取 usage 信息
   */
  getUsageInfo(): UsageInfo | undefined {
    return this.usageInfo;
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.fullText = "";
    this.fullReasoning = "";
    this.reasoningBuffer = "";
    this.usageInfo = undefined;
    this.isFirstText = true;
    this.reasoningStarted = false;
    this.reasoningClosedByText = false;
    this.thinkingPrinted = false;
    // 保留 contextInfo，因为它是配置信息，不需要每次重置
  }
}
