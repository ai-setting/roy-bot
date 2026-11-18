/**
 * @fileoverview ink-based REPL (Task #2279, #2280)
 *
 * 用 ink v5.2.1 (React 18) 重写 REPL，替代 Node.js readline。
 * 解决 readline v20 的两个限制：
 * 1. bracketed paste 内容中的 \n 仍触发 enter 事件
 * 2. Alt+Enter 字节序列（ESC+CR）解析不可靠
 *
 * ink v5 的 <TextInput> 组件原生支持：
 * - bracketed paste mode（自动 wrap 内容到单行）
 * - Alt+Enter 通过 useInput hook（key.meta + key.return）
 *
 * 设计：保留所有 buildXxx 纯函数（buildWelcomeCard/buildStatusBar 等），
 * 新的 React 组件只是渲染层，不影响现有单元测试。
 *
 * Task #2280: 增加 onReady ref API（让外部代码能 push 流式 chunks / 设置 mode）
 *   - REPLInkApi 通过 onReady 暴露给 interactive.ts
 *   - 外部 stream-output service 可以在每个 chunk 到达时调用 api.appendAssistantDelta
 *   - 外部 /exit /clear /compact 等 slash command 通过 onCommand 路由
 *
 * Task #2290: 重写 MultilineInput 为 uncontrolled (内部 useState 维护 buffer+cursor)
 *   - 解决 3 个 bug:
 *     1. 每字符全屏刷新 — MultilineInput 内部 state，父 REPLInk 不再因每次按键重渲染
 *     2. Alt+Enter 多行输入失败 — 自己用 useInput 区分 Alt+Enter (插 \n) vs Enter (提交)
 *        不再依赖 ink-text-input (它在 key.return=true 时无差别触发 onSubmit, 不支持 Alt+Enter)
 *     3. 无 markdown 渲染 — 新增 markdown-renderer.tsx 自实现简单 markdown 渲染器
 *        assistant role 走 markdown 解析
 */

import * as React from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import { COLORS } from "../services/stream-output.service";
// Task #2613: 不再直接 import ./ui/status-bar 和 ./ui/welcome-card
// - REPLMode / StatusBarContext 类型在 repl-ink.tsx 内联定义 (避免 ./ui/ 依赖)
// - WelcomeCardContext 类型从 ../tui/welcome-card re-export
import { renderWelcomeCard, type WelcomeCardContext } from "../tui/welcome-card";
import {
  filterCommands,
  type Command,
} from "./ui/commands-registry";
import { SlashCommandPopup, clampSelectedIndex } from "./ui/slash-command-popup";
import { createLogger } from "@ai-setting/roy-bot-core";
// Task #2610 (range C): use the new Ink-friendly Markdown wrapper that
// delegates to render/markdown.ts (marked + cli-highlight). The legacy
// commands/markdown-renderer.tsx (self-implemented React tree) is
// replaced in this commit.
import { Markdown } from "../tui/Markdown.js";
// Task #2613: 接入新 Ink 状态栏组件（替代旧 buildStatusBar 字符串函数）
import { StatusBar } from "../tui/StatusBar.js";
// Task #4396: dim grey cache/token footer under every assistant message.
// User requirement: "在每个Agent消息的后面添加上这个cache和token信息已灰色颜色展示出来"
import { UsageFooter, type UsageLike } from "../tui/UsageFooter.js";
// Task #2657 (continuation): bound the dynamic region to the terminal
// viewport so Ink's `outputHeight >= rows` overflow path never fires
// for ordinary keypresses or short streaming deltas.
import {
  computeDynamicTailBounds,
  renderBoundedAssistant,
  renderBoundedPlain,
  type DynamicTailBounds,
} from "./ui/dynamic-tail";

/**
 * Task #2657 (continuation) R2: MarkdownBounded — render markdown with a
 * row budget so the dynamic region never grows past the available
 * terminal height. The static history is preserved (Ink <Static>),
 * but the last message is rendered as a single bounded <Text> node
 * that may not exceed the viewport.
 */
const MarkdownBounded: React.FC<{
  text: string;
  bounds: DynamicTailBounds;
  width: number;
}> = React.memo(({ text, bounds, width }) => {
  const out = renderBoundedAssistant(text, bounds, width);
  if (!out) {
    return null;
  }
  return <Text>{out}</Text>;
});

/**
 * Task #2613: REPL 模式状态机类型（从 ui/status-bar.ts 内联）
 *
 * 背景: AC1 要求 repl-ink.tsx 不再 import `./ui/status-bar`。
 * 把 REPLMode 类型在此内联；ui/status-bar.ts 中的定义保持原样供其他模块使用。
 */
export type REPLMode =
  | "ready"
  | "thinking"
  | "executing"
  | "error"
  | "compact"
  | "shutdown";

/**
 * Task #2613: 状态栏上下文类型（从 ui/status-bar.ts 内联）
 *
 * 与 ui/status-bar.ts 中的定义保持同步。如未来 ui/status-bar.ts 字段变化，
 * 这里也需要同步更新（或迁移到一个独立的 types 文件）。
 */
export interface StatusBarContext {
  mode: REPLMode;
  /** 额外的状态信息（如当前正在执行的工具名） */
  detail?: string;
  /** 是否在 batch/agent 模式 */
  isAgentMode?: boolean;
  /** Task #2262: token 使用情况（input/output），可选 */
  tokens?: {
    input: number;
    output: number;
  };
  /** Task #2262: 当前 git 分支名，可选 */
  gitBranch?: string;
  /** Task #2262: 当前工作目录（绝对路径），会自动缩略显示 */
  cwd?: string;
  /** Task #2264 P1: model 简短名（如 "M3"），作为独立段显示 */
  model?: string;
}

const inkLogger = createLogger("repl-ink");

/**
 * 单条消息（user 输入 或 agent 回复）
 *
 * Task #2657 R2 v2: messages now carry a stable `id` so React / Ink can
 * use a real identity for keys and Static. The previous `role-i-length`
 * derived key collided when content length was the same across two
 * messages, causing false identity matches. The id is assigned by
 * `withMessageId` (below) when a REPLMessage is constructed. To keep
 * the construction sites short, `id` is optional in this interface and
 * is filled in by `withMessageId` / by the reducers in REPLInk.
 */
export interface REPLMessage {
  /** Stable, unique id assigned at message creation. Required for Static keys. */
  id?: string;
  role:
    | "user"
    | "assistant"
    | "system"
    | "tool"
    | "tool_result"
    | "reasoning"
    /** Task #4396: standalone dim grey cache/token footer row. */
    | "usage";
  content: string;
  /** Task #2279: 流式响应状态 */
  streaming?: boolean;
  /** tool name（role=tool/tool_result） */
  toolName?: string;
  /**
   * Task #2311 Plan B: 标记是否为 welcome card (history[0])。
   * 设为 "welcome" 的消息用 buildWelcomeCard 渲染（多行 box-drawing），
   * 不走 ❯ / ● prefix 也不走 markdown。
   * 这样 welcome card 作为消息历史第一条永久存在，用户可滚动查看完整 logo。
   */
  kind?: "welcome";
  /**
   * Task #4396: usage of the LLM call that produced this assistant message.
   *
   * Populated via `REPLInkApi.attachUsage()` when the `llm.completed` chunk
   * event arrives (the event now carries `StreamChunkEvent.usage`). Rendered
   * as a dim grey footer underneath the message body so the user can see the
   * cache hit rate / token counts of *that* call.
   *
   * `undefined` for non-assistant roles and for providers that report no
   * usage — the footer then renders nothing.
   */
  usage?: UsageLike;
}

// Task #2657 R2 v2: stable message id allocator. Using a module-level
// counter gives every newly created REPLMessage a unique, monotonically
// increasing id. The counter is local to this module so it survives
// re-renders but resets on module reload. We accept id collisions across
// module reloads (e.g. after a hot reload) because React will remount
// the entire subtree in that case.
let _msgIdCounter = 0;
function nextMessageId(): string {
  _msgIdCounter += 1;
  // Combine a high-resolution timestamp with the counter so id is
  // unique even across test fixtures that reset the counter.
  return `m-${Date.now().toString(36)}-${_msgIdCounter.toString(36)}`;
}

/**
 * Assign a stable id to a freshly constructed message. Existing
 * messages (loaded from initialMessages) keep their id or get one if
 * missing. All reducer / append sites in REPLInk route new messages
 * through this helper so the Static keys remain unique across the
 * session.
 */
export function withMessageId(msg: REPLMessage): REPLMessage {
  if (msg.id) return msg;
  return { ...msg, id: nextMessageId() };
}

/**
 * 外部调用方（interactive.ts）使用的 ink REPL API
 *
 * 通过 onReady 回调暴露，让外部代码能 push 流式 chunks / 设置 mode 等。
 */
export interface REPLInkApi {
  /** 追加一条 user 消息（onSubmit 内部已用，外部可手动追加 system 等） */
  appendMessage: (msg: REPLMessage) => void;
  /** 追加一个 assistant 流式 chunk（累积到当前 streaming message） */
  appendAssistantDelta: (delta: string) => void;
  /** 结束当前 streaming message（标记 streaming=false） */
  finishAssistantStream: () => void;
  /**
   * Task #4396: attach cache/token usage to the most recent assistant
   * message so the TUI renders a dim grey footer under it.
   *
   * Call this right after `finishAssistantStream()` when the
   * `llm.completed` chunk event arrives with `usage`. Safe no-op when there
   * is no assistant message to attach to.
   */
  attachUsage: (usage: UsageLike | undefined | null) => void;
  /** 设置 status bar mode（ready/thinking/executing） */
  setMode: (mode: REPLMode) => void;
  /** 设置 status bar 上下文（cwd/gitBranch/model） */
  setStatusBarCtx: (ctx: Partial<StatusBarContext>) => void;
  /** 清空所有消息（/clear 用） */
  clearMessages: () => void;
  /** 主动退出 ink（/exit 用） */
  exit: () => void;
  /** 触发 /compact（外部接收 onCommand） */
  triggerCompact: () => void;
  /**
   * Task #2312 T-B: 设置 MultilineInput 的 buffer 内容
   * 用于 / 弹窗选中命令时补全输入框 (例如选中 /help → 输入框变成 "/help ")
   * 外部可调用此 API 让输入框的内容变化 (例如 /paste 选中某命令)
   */
  setInputBuffer: (value: string) => void;
  /**
   * Task #2312 T-B: 获取 MultilineInput 的当前 buffer
   * 外部可读取当前输入 (例如判断输入是否包含 / 以决定是否显示弹窗)
   */
  getInputBuffer: () => string;
}

/**
 * ink REPL 的 props
 */
export interface REPLInkProps {
  /** 启动上下文（model/cwd/version/sessionTitle） */
  initialContext: WelcomeCardContext;
  /** 用户提交时调用的回调（已移除 ❯ 前缀和 trim） */
  onSubmit: (input: string) => void | Promise<void>;
  /** 初始消息历史（从 REPL 启动前的状态恢复） */
  initialMessages?: REPLMessage[];
  /** 初始 mode（"ready" / "thinking" / "executing"） */
  initialMode?: REPLMode;
  /** 初始 status bar ctx */
  initialStatusBarCtx?: Partial<StatusBarContext>;
  /**
   * Task #2280: 当组件 mount 后立即调用，传入 REPLInkApi。
   * 外部用 ref 持有 api 对象，调用 api.appendAssistantDelta(chunk) 等。
   */
  onReady?: (api: REPLInkApi) => void;
  /**
   * Task #2280: 当用户输入以 / 开头时被调用，参数是不含 / 的 command 字符串。
   * 外部 (interactive.ts) 负责路由到具体 handler (exit/help/clear/compact 等)。
   * 如果 handler 返回 true 表示已处理；返回 false 表示 unknown command。
   */
  onCommand?: (cmd: string) => Promise<boolean> | boolean;
  /**
   * Task #2294: 当用户按下 ESC 键时被调用（用于触发 cascade stop 中断 in-flight execution）。
   * 外部 (interactive.ts) 通常传入 () => this.handleEscKey()。
   * 如果 callback 返回 rejected Promise，错误会被 logger.warn 记录但不会 crash ink REPL。
   */
  onEscape?: () => void | Promise<void>;
}

/**
 * ink REPL 主组件
 */
export function REPLInk(props: REPLInkProps): React.ReactElement {
  const {
    initialContext,
    onSubmit,
    initialMessages = [],
    initialMode = "ready",
    initialStatusBarCtx = {},
    onReady,
    onCommand,
    onEscape,
  } = props;
  const { exit: appExit } = useApp();

  // 状态
  // Task #2290: 不再有 buffer state — MultilineInput 改成 uncontrolled, 内部维护 buffer+cursor
  // 父组件只持有 messages / mode / statusBarCtx (这些是真正需要在父组件层管理的状态)
  // Task #2311 Plan B: messages 数组的第一条永远是 welcome card（Claude Code 风格）。
  // - 启动时 messages[0] = welcome card（含完整 pixel logo）
  // - 用户提交第一条 query 后，messages[0] 仍然是 welcome card（不会被替换/compact）
  // - 用户可滚动终端 scrollback 看到完整 welcome card
  // - /clear 命令保留 messages[0] (welcome card) — 类似 Claude Code /clear
  // Task #2657 R2 v2: assign stable ids at construction so Static keys
  // are real identities, not derived role-i-length hashes.
  const [messages, setMessages] = React.useState<REPLMessage[]>(() => [
    withMessageId({
      role: "system",
      kind: "welcome",
      content: renderWelcomeCard(initialContext),
    }),
    ...initialMessages.map(withMessageId),
  ]);
  const [mode, setMode] = React.useState<REPLMode>(initialMode);
  const [statusBarCtx, setStatusBarCtxState] =
    React.useState<StatusBarContext>({
      mode: initialMode,
      cwd: initialStatusBarCtx.cwd ?? initialContext.cwd,
      gitBranch: initialStatusBarCtx.gitBranch,
      model: initialStatusBarCtx.model ?? initialContext.model,
    });

  // Task #2312 T-B: / 命令弹窗状态
  // - inputValue: 当前 MultilineInput buffer (由 onChange 同步, 父组件用来判断是否显示弹窗)
  // - popupIndex: 当前选中项索引 (Up/Down 调整)
  // - filteredCmds: 当前过滤后的命令列表 (派生值, useMemo 计算)
  //
  // Task #2333: 借鉴 opencode 模式 (REPORT.md)
  // - popupIndex state 仍然存在, 但不再是 "父级主动管理"
  // - 弹窗自己 useState 管理 active state (opencode `useFilteredList` 模式)
  // - 弹窗自己 useInput 处理 ↑/↓/Enter/Esc (opencode `Autocomplete` 模式)
  // - 弹窗通过 onIndexChange 通知父级 (向后兼容)
  // - 父级 useInput 不再处理弹窗键 → 父级 re-render 不影响弹窗 active
  const [inputValue, setInputValue] = React.useState<string>("");
  const [popupIndex, setPopupIndex] = React.useState<number>(0);
  // 派生: 当前是否显示弹窗 (输入以 / 开头 + 过滤后至少 1 条命令)
  // - 规则: "/<no-space>" 才显示 (例如 "/he", "/he " 不显示因为有空格)
  // - 过滤后无匹配也不显示 (SlashCommandPopup 内部也会 null-render, 这里提前短路避免多余 render)
  const filteredCmds = React.useMemo<Command[]>(() => {
    // 只在输入以 / 开头 (且不含空格/换行) 时尝试过滤
    if (!/^\/\S*$/.test(inputValue)) return [];
    return filterCommands(inputValue);
  }, [inputValue]);
  const showPopup = filteredCmds.length > 0;
  // 每次过滤结果变化时, 重置 popupIndex 到 0 (避免选中越界)
  // Task #2333: 弹窗内部也会自己重置 (双重保护)
  React.useEffect(() => {
    setPopupIndex(0);
  }, [filteredCmds]);
  // popupIndex 钳到 [0, filteredCmds.length-1] 范围
  const safePopupIndex = clampSelectedIndex(popupIndex, filteredCmds.length);

  // Task #2333: 弹窗回调 — opencode 模式
  // - 用户选中命令 (Enter/Tab) → 补全输入框
  // - 用户按 Esc 关闭弹窗 → 清空 buffer 前缀
  // - 弹窗 active 变化 → 同步 popupIndex state (向后兼容)
  const handlePopupSelect = React.useCallback((cmd: Command) => {
    multilineInputRef.current?.setBuffer(cmd.cmd + " ");
    setInputValue(cmd.cmd + " ");
  }, []);
  const handlePopupClose = React.useCallback(() => {
    // 关闭弹窗: 把 inputValue 设为不带 / 前缀的状态
    // Claude Code 的做法: Esc 仅隐藏弹窗, 用户继续输入时再次显示
    const current = multilineInputRef.current?.getBuffer() ?? "";
    const stripped = current.replace(/^\/+/, "");
    multilineInputRef.current?.setBuffer(stripped);
    setInputValue(stripped);
  }, []);
  const handlePopupIndexChange = React.useCallback((idx: number) => {
    setPopupIndex(idx);
  }, []);

  // useRef 用于存 streaming message 的索引（避免重新查找）
  const streamingIndexRef = React.useRef<number>(-1);

  // Task #2309: stale stream 检测 — 防御性修复
  // 背景 (Bug 2 — Task #2303 引入的回归):
  // - abortStream() 只设 streamAbortSignal.aborted=true, REPLInk 内部状态
  //   (pendingDeltaRef / streamingIndexRef) 不受影响
  // - 旧 streaming message 残留 streaming=true, 新 delta 追加到旧 message
  // - 防御: 跟踪 lastFlushTsRef (上次 flushStreamingDelta 完成的时间戳),
  //        如果距离上次 flush > STALE_STREAM_THRESHOLD_MS, 把旧 message 标记为 finished
  //        然后开始新 message
  // 同时保留 interactive.ts handleEscKey 调 finishAssistantStream 的显式修复
  const lastFlushTsRef = React.useRef<number>(0);
  const STALE_STREAM_THRESHOLD_MS = 1000; // 1 秒没新 chunk flush 视为 stale

  // Task #2293 (合并 main): ref 指向 MultilineInput, 让父 useInput 收到 Esc 后能调 clearBuffer()
  // MultilineInput 自己不处理 Esc (避免拦截父级 onEscape cascade)
  const multilineInputRef = React.useRef<MultilineInputRef | null>(null);

  // Task #2303: ESC dedup ref — ink useInput 让父+子的 inputHandler 都收到同一 ESC 事件,
  // 如果两者都调 onEscape, 会触发 2 次 cascade stop. 用 lastEscapeTsRef 在 100ms 窗口内去重.
  const lastEscapeTsRef = React.useRef<number>(0);

  // Task #2292: Streaming throttle — buffer 多个 delta 到 pendingDeltaRef,
  // 50ms 内合并为 1 次 setMessages, 避免 streaming 时每秒全屏重绘 20+ 次
  const pendingDeltaRef = React.useRef<string>("");
  const throttleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Task #2319: 标记 "当前 streaming session 的首段 delta 是否已 flush".
  // - true:  下一次 appendAssistantDelta 首次进入 throttle=null 分支时, 立即同步 flush (避免 50ms 硬延迟)
  // - false: 走原本的 setTimeout(50ms) throttle 合并 (避免 streaming 时全屏重绘)
  // finishAssistantStream 时重置为 true, 让下一次 assistant 响应也能首段立即出现.
  const isFirstDeltaInStreamRef = React.useRef<boolean>(true);

  const flushStreamingDelta = React.useCallback((): void => {
    const delta = pendingDeltaRef.current;
    pendingDeltaRef.current = "";
    throttleTimerRef.current = null;
    if (!delta) return;
    setMessages((msgs) => {
      // 找到最近一个 streaming 的 assistant message
      let idx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === "assistant" && msgs[i]!.streaming) {
          idx = i;
          break;
        }
      }
      // Task #2309 (Bug 2): stale stream 检测
      // 如果找到 streaming message, 但距离上次 flush 已经超过阈值,
      // 说明 stream 已被 abort (或长时间没新 chunk) 但没调 finishAssistantStream.
      // 把旧 message 标记为 finished, 然后开新 message.
      if (idx !== -1 && Date.now() - lastFlushTsRef.current > STALE_STREAM_THRESHOLD_MS) {
        const updated = [...msgs];
        updated[idx] = { ...updated[idx]!, streaming: false };
        idx = -1;
      }
      if (idx === -1) {
        streamingIndexRef.current = msgs.length;
        return [...msgs, withMessageId({ role: "assistant", content: delta, streaming: true })];
      }
      // 追加到现有的 streaming message (新引用 → React.memo MessageView 重新渲染)
      const updated = [...msgs];
      updated[idx] = { ...updated[idx]!, content: updated[idx]!.content + delta };
      return updated;
    });
    // 记录本次 flush 时间戳, 用于下次 stale 检测
    lastFlushTsRef.current = Date.now();
  }, []);

  // 清理 timer on unmount
  React.useEffect(() => {
    return () => {
      if (throttleTimerRef.current !== null) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
    };
  }, []);

  // Task #2280: 暴露 REPLInkApi 给外部
  // 每次 render 时更新 api 引用指向最新 state（不重新触发 effect）
  const apiRef = React.useRef<REPLInkApi | null>(null);
  React.useEffect(() => {
    // 一次性创建 api（mount 后）
    const api: REPLInkApi = {
      appendMessage: (msg) => {
        setMessages((msgs) => [...msgs, withMessageId(msg)]);
      },
      appendAssistantDelta: (delta) => {
        if (!delta) return;
        // Task #2292: throttle — 50ms 内合并多个 delta
        pendingDeltaRef.current += delta;
        if (throttleTimerRef.current === null) {
          // Task #2319: 首段 chunk 立即同步 flush (不再 setTimeout 50ms),
          // 避免用户输入 query 后 assistant 第一段文字要等 50ms 才出现.
          // 后续 delta (throttleTimerRef.current !== null) 走原本的 setTimeout(50) 合并,
          // 所以 streaming 全屏重绘优化仍生效.
          if (isFirstDeltaInStreamRef.current) {
            isFirstDeltaInStreamRef.current = false;
            flushStreamingDelta();
          } else {
            throttleTimerRef.current = setTimeout(flushStreamingDelta, 50);
          }
        }
      },
      finishAssistantStream: () => {
        // Task #2292: 结束前先 flush pending delta, 否则最后几个 chunk 会丢失
        if (throttleTimerRef.current !== null) {
          clearTimeout(throttleTimerRef.current);
          throttleTimerRef.current = null;
          flushStreamingDelta();
        }
        setMessages((msgs) => {
          let idx = -1;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]!.role === "assistant" && msgs[i]!.streaming) {
              idx = i;
              break;
            }
          }
          if (idx === -1) return msgs;
          const updated = [...msgs];
          updated[idx] = { ...updated[idx]!, streaming: false };
          return updated;
        });
        streamingIndexRef.current = -1;
        // Task #2319: 重置首段标志 — 下一次新 assistant 响应也能首段立即 flush
        isFirstDeltaInStreamRef.current = true;
      },
      // Task #4396: commit this call's usage as its OWN message row.
      //
      // Not attached to the previous assistant message: Ink's <Static> only
      // appends (a committed row is never repainted), and "the last assistant
      // message" is not a reliable target — a later turn's usage would rewrite
      // an earlier turn's footer. Appending a dedicated row is both paint-able
      // and naturally per-turn correlated.
      attachUsage: (usage) => {
        if (!usage) return;
        setMessages((msgs) => [
          ...msgs,
          withMessageId({ role: "usage", content: "", usage }),
        ]);
      },
      setMode: (newMode) => {
        setMode(newMode);
        setStatusBarCtxState((ctx) => ({ ...ctx, mode: newMode }));
      },
      setStatusBarCtx: (ctx) => {
        setStatusBarCtxState((s) => ({ ...s, ...ctx }));
      },
      clearMessages: () => {
        // Task #2311 Plan B: /clear 保留 messages[0] (welcome card)
        // - 保留启动画面 + 完整 pixel logo
        // - 用户看到的是 "welcome card + 空白输入区"，类似 Claude Code /clear
        setMessages([
          withMessageId({
            role: "system",
            kind: "welcome",
            content: renderWelcomeCard(initialContext),
          }),
        ]);
      },
      exit: () => {
        appExit();
      },
      triggerCompact: () => {
        // 触发 onCommand 路由
        if (onCommand) {
          Promise.resolve(onCommand("compact")).catch(() => {
            // 忽略错误（由 onCommand 自己处理）
          });
        }
      },
      // Task #2312 T-B: 弹窗选中命令时调用, 让 MultilineInput buffer 变成 "<cmd> "
      setInputBuffer: (value: string) => {
        multilineInputRef.current?.setBuffer(value);
        // 同步更新父组件 inputValue state (确保弹窗立即响应, 避免下个 render 才生效)
        setInputValue(value);
        // 选中命令后, 用户可能要继续输参数 (例如 "/model sonnet"), 弹窗保持可见
        // 如果 value 不再以 / 开头 (例如 /help 之外被选中后变成别的), 弹窗会自动收起
      },
      // Task #2312 T-B: 外部读 MultilineInput 当前 buffer
      getInputBuffer: () => {
        return multilineInputRef.current?.getBuffer() ?? "";
      },
    };
    apiRef.current = api;
    onReady?.(api);
  }, [appExit, onCommand, onReady]);

  // Task #2303: ESC dedup wrapper — 100ms 窗口内只调一次 onEscape.
  // 背景: 修复后 MultilineInput 子 useInput 同步调 onEscape + 父 useInput 也调 onEscape,
  //       两个 listener 都会收到同一 ESC 事件, 造成 onEscape 调 2 次.
  //       用 lastEscapeTsRef 时间戳去重 (100ms 远大于单次事件处理耗时).
  // 错误处理: 用 Promise.resolve().then().catch() 链, 防止 onEscape 抛错或返回 rejected
  //          promise 时 crash ink REPL (与修复前 Task #2294 hotfix 行为一致).
  const handleEscapeCascade = React.useCallback(() => {
    const now = Date.now();
    if (now - lastEscapeTsRef.current < 100) {
      // 在 dedup 窗口内, 说明 MultilineInput 已经处理过, 跳过
      return;
    }
    lastEscapeTsRef.current = now;
    if (onEscape) {
      Promise.resolve()
        .then(() => onEscape())
        .catch((err: unknown) => {
          inkLogger.warn(`[REPLInk] onEscape failed: ${err}`);
        });
    }
  }, [onEscape]);

  // Task #2290 + #2303: 父 useInput 处理 3 类事件:
//   1. ESC 兜底 — MultilineInput 子层已优先拦截 (避免父 listener 空窗期漏掉),
//                父级作为双保险, 走 handleEscapeCascade (100ms dedup)
//   2. Ctrl+C — 退出
//   3. Ctrl+D — 退出 (EOF)
//
// Task #2333: 弹窗键 (↑/↓/Enter/Tab/Esc) 不再在父 useInput 处理
//   - 弹窗自己 useInput({ isActive: filtered.length > 0 }) 处理
//   - 父 useInput 不知道弹窗存在, 不会双重触发
//   - 借鉴 opencode Autocomplete 模式
//
// MultilineInput 内部自己用 useInput 处理 Alt+Enter / Enter / Backspace / 光标移动等.
// 因为 useInput 是按 mount 顺序执行的, MultilineInput 子 useInput 在父 useInput 之后 render,
// 子先注册, 子先收到 key 事件 (除非父通过 dedup 阻止 double-fire).
  useInput((_input, key) => {
    // Task #2333: 弹窗激活时, 父 useInput 不处理任何键
    // - 弹窗自己 useInput 处理 ↑/↓/Enter/Tab/Esc
    // - 弹窗通过 onSelect/onClose 回调通知父级
    // - 父 useInput 只让 MultilineInput 接收字符输入 (return 让事件继续传递给子 useInput)
    // 注意: useInput 不能 "return" 事件给其他 listener (Ink 内部会全部触发)
    //   所以 showPopup 时父级需要主动吞掉弹窗键
    if (showPopup) {
      // 弹窗激活: 父级只处理 Ctrl+C/D (退出) 和其他父级专属键
      // 弹窗相关的键 (↑/↓/Enter/Tab/Esc) 由弹窗自己 useInput 处理
      if (key.escape || key.upArrow || key.downArrow || key.tab) {
        // 弹窗 useInput 会处理, 父级跳过
        // 但 useInput 不能阻止事件传播, 所以这里 return 不起作用
        // 解决方案: MultilineInput 子 useInput 应该也跳过来避免双触发
        return;
      }
      if (key.return && !key.meta && !key.shift && !key.ctrl) {
        // Enter 由弹窗 useInput 处理选中
        return;
      }
      // 其他键 (字符输入, Backspace 等) 让 MultilineInput 处理
      // 父级不抢键
    }

    // Task #2303: ESC 兜底 — 子 MultilineInput 已优先拦截直接调 onEscape.
    // 父级这里作为双保险, 万一 MultilineInput 未挂载仍能工作.
    // 100ms dedup 防止子+父双触发.
    // 注意: showPopup 时已经在上面 return 了, 这里只处理弹窗关闭的情况
    if (key.escape) {
      multilineInputRef.current?.clearBuffer();
      handleEscapeCascade();
    }
    // Ctrl+C 退出
    if (key.ctrl && (key as any).c === true) {
      // 让外部 onCommand("exit") 处理（统一 shutdown 流程）
      if (onCommand) {
        Promise.resolve(onCommand("exit")).catch(() => {
          appExit();
        });
      } else {
        appExit();
      }
    }
    // Ctrl+D (EOF) 退出
    if (key.ctrl && (key as any).d === true) {
      if (onCommand) {
        Promise.resolve(onCommand("exit")).catch(() => {
          appExit();
        });
      } else {
        appExit();
      }
    }
  });

  // Task #2290: 处理 Enter 提交（MultilineInput 内部在用户按 Enter 时调用, 传整个 buffer）
  // 注意: MultilineInput 内部已经 trim 过 buffer 判空, 但我们这里再防御一次
  // Task #2292: useCallback 包装 — 防止 messages 变化时 MultilineInput 重新接收新 onSubmit 引用
  const handleSubmit = React.useCallback(async (value: string): Promise<void> => {
    if (!value || value.trim() === "") {
      // 空输入：跳过
      return;
    }
    // slash command 路由
    if (value.startsWith("/")) {
      const cmd = value.slice(1).trim();
      if (onCommand) {
        const handled = await onCommand(cmd);
        if (handled) {
          // MultilineInput 收到 onSubmit 完成 promise 后会自己清空 buffer
          return;
        }
      }
      // unknown slash command — 仍然显示
      setMessages((msgs) => [
        ...msgs,
        withMessageId({ role: "system", content: `[未知命令: ${value}]` }),
      ]);
      return;
    }
    // 添加到消息历史
    setMessages((msgs) => [...msgs, withMessageId({ role: "user", content: value })]);
    // 触发外部回调
    try {
      await onSubmit(value);
    } catch (err) {
      // 错误处理：添加到消息历史显示
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((msgs) => [
        ...msgs,
        withMessageId({ role: "system", content: `[Error] ${msg}` }),
      ]);
    }
  }, [onCommand, onSubmit]);

  // Task #2333: 借鉴 opencode scrollbox 模式 — static items 引用绝对稳定
  // - 依赖只到 [messages.length - 1]（不含 streaming 那条）
  // - 当最后一条（streaming）变化时，staticItems reference 不变
  // - 只有真正新增消息时（length-1 变化），staticItems 才重新计算
  // - 这样 Ink <Static> 的 items prop 引用稳定 → Static 不重渲
  // - 类似 opencode 用 WeakMap 缓存 measurements 的效果
  const staticItems = React.useMemo<REPLMessage[]>(() => {
    if (messages.length <= 1) return [];
    return messages.slice(0, -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意只用 length-1 触发
  }, [messages.length <= 1 ? 0 : messages.length - 1]);

  // Task #2657 (continuation) R2: bound the dynamic region to the visible
  // terminal viewport so the Ink "outputHeight >= rows" overflow path
  // (which writes clearTerminal + fullStaticOutput + output) never fires
  // for ordinary keypresses or short streaming deltas. The dynamic
  // region is the last message (committed or streaming); if it is taller
  // than the available rows, we render a height-bounded copy through
  // MarkdownBounded and Ink keeps the static history intact.
  const tailMsg = messages.length > 0 ? messages[messages.length - 1]! : null;
  const terminalWidth = process.stdout.columns ?? 80;
  const terminalHeight = process.stdout.rows ?? 24;
  const dynamicTailBounds: DynamicTailBounds = React.useMemo(
    () => computeDynamicTailBounds(terminalHeight, 12, showPopup),
    [terminalHeight, showPopup],
  );
  // Task #2657 R2 v2: Static items also need a height budget. Without
  // it, when a previously-bounded long tail moves into Static (because
  // a new message is appended), it is rendered in full and the
  // accumulated output height may exceed stdout.rows, re-triggering
  // Ink's `clearTerminal + fullStaticOutput + output` overflow path.
  // Static items get a slightly larger per-message budget because they
  // are not interactively updated, but they must still stay under the
  // viewport so the accumulated output never overflows.
  const staticTailBounds: DynamicTailBounds = React.useMemo(
    () => computeDynamicTailBounds(
      terminalHeight,
      // reserve a tiny bit more chrome for the tail slot + safety
      12,
      showPopup,
    ),
    [terminalHeight, showPopup],
  );
  // Stable identity: when neither the message reference nor its role
  // changes, the React tree below sees the same key/msg, so React.memo
  // can skip the re-render. When the content grows (streaming delta) the
  // msg reference changes but the key stays stable across appends
  // because the last message slot is keyed by its position, not by its
  // hash, so Ink does not remount it on every delta.
  const tailKey = messages.length > 0
    ? (tailMsg?.id ?? `tail-${messages.length - 1}`)
    : "tail-empty";

  // 状态栏 — Task #2613: 替换旧 buildStatusBar() 字符串函数为 Ink <StatusBar> 组件
  // - mode 段不再显示 (tui/StatusBar 是 minimal 设计, 只有 model/workdir/tokenCount/exit hint)
  // - gitBranch 暂不渲染 (tui/StatusBar 不支持, 未来可在 App.tsx 扩展)
  // - shortModel 复用 ui/status-bar.shortModelName() 保持 model 名截断逻辑
  const statusBarModel = shortModel(statusBarCtx.model);
  const statusBarWorkdir = statusBarCtx.cwd;

  return (
    <Box flexDirection="column">
      {/* Task #2317 + Task #2333: 消息历史用 Ink <Static> 包裹 — 历史永不 re-render。
         - 渲染策略: staticItems (= messages.slice(0, -1), useMemo 缓存) 进入 Static
         - <Static> 只 render 新追加的 item (Ink 内部用 index 跟踪已渲染长度)
         - 这样用户输入时, 历史消息完全不刷新 → 输入框之外的区域不闪烁
         - 最后一条消息 (可能是 streaming assistant) 走正常渲染, 让 streaming throttle 更新
         - Task #2333: staticItems 依赖只到 [length-1] — streaming 变化时 reference 不变
         - Task #2657 R2: 使用内容派生 key 避免因长尾触发的 full clear
       */}
      {staticItems.length > 0 ? (
        <Static items={staticItems}>
          {(msg, i) => (
            <MessageView
              key={msg.id ?? `h-${msg.role}-${i}-${msg.content.length}`}
              msg={msg}
              terminalWidth={terminalWidth}
              tailBounds={staticTailBounds}
            />
          )}
        </Static>
      ) : null}
      {tailMsg ? (
        <MessageView
          key={tailKey}
          msg={tailMsg}
          terminalWidth={terminalWidth}
          tailBounds={dynamicTailBounds}
        />
      ) : null}

      {/* 状态栏 — Task #2613: 新 Ink <StatusBar> 组件 */}
      <Box flexDirection="column" marginTop={1}>
        <StatusBar model={statusBarModel} workdir={statusBarWorkdir} />
      </Box>

      {/* Task #2312 T-B: / 命令弹窗 (输入框上方, 仅当输入以 / 开头时显示) */}
      {/* Task #2333: 借鉴 opencode Autocomplete 模式
          - 弹窗自己 useState/useInput 管理 active state 和键盘事件
          - 父级通过 onSelect/onClose 接收弹窗事件
          - 父级 popupIndex state 保留 (向后兼容, 也可移除)
       */}
      {showPopup ? (
        <Box marginBottom={0}>
          <SlashCommandPopup
            query={inputValue}
            selectedIndex={safePopupIndex}
            onIndexChange={handlePopupIndexChange}
            onSelect={handlePopupSelect}
            onClose={handlePopupClose}
          />
        </Box>
      ) : null}

      {/* 输入区 (Task #2290: MultilineInput 改成 uncontrolled, 父组件不传 value) */}
      {/* Task #2303: 传 onEscape 给 MultilineInput, 子层直接拦截 ESC (不依赖父 listener 顺序).
          用 handleEscapeCascade 而非原始 onEscape — 提供 dedup 保护避免子+父双触发.
          Task #2312 T-B: 加 popupActive + onChange 让父组件感知弹窗状态和 buffer 变化. */}
      <Box flexDirection="column">
        <Text>{COLORS.muted("─".repeat(40))}</Text>
        <MultilineInput
          ref={multilineInputRef}
          onSubmit={handleSubmit}
          onEscape={handleEscapeCascade}
          popupActive={showPopup}
          onChange={setInputValue}
        />
        <Text>{COLORS.muted("─".repeat(40))}</Text>
      </Box>
    </Box>
  );
}

/**
 * Task #2290: MultilineInput — 完全重写为 uncontrolled 组件
 *
 * 解决 3 个 bug:
 * 1. **每字符全屏刷新** — 内部维护 buffer+cursor, 父组件不参与, 每次按键只重渲染
 *    MultilineInput 自己 (Ink 重绘范围小)
 * 2. **Alt+Enter 多行输入失败** — 之前依赖 ink-text-input, 但 ink-text-input@6.0.0 在
 *    useInput 中 `if (key.return) { onSubmit(value); return; }` 无差别触发,
 *    不区分普通 Enter 和 Alt+Enter (key.meta).
 *    修复: 自己用 useInput 处理键盘事件, 区分 Alt/Shift/Ctrl+Enter (插 \n) vs Enter (提交)
 * 3. **不支持粘贴多行内容** — 之前的 MultilineInput 依赖 TextInput 单行渲染,
 *    现在直接用 input 字符串 (ink useInput 会把整个粘贴内容作为 input 字符串传入)
 *
 * 设计:
 * - `buffer` 是完整的多行文本 (含 \n)
 * - `cursor` 是 buffer 中的字符位置 (0..buffer.length)
 * - 渲染: 按 \n split, 每行一个 Box, 第一行 ❯ (红), 续行 ... (灰)
 * - 最后一行在 cursor 位置渲染 inverse 字符表示光标
 * - 提交后 MultilineInput 内部清空 buffer + cursor
 */
/**
 * Task #2292: MultilineInput — uncontrolled 多行可编辑 input 组件
 *
 * 解决 bug:
 * - Task #2289: 提交传整个 buffer (不只是最后一行)
 * - Task #2290: MultilineInput 改 uncontrolled, 父组件不再因按键重渲染
 * - Task #2291: Backspace 兼容 \x7f
 * - Task #2292: 所有行都可编辑 (cursor 在哪行哪列渲染 inverse 光标),
 *                Up/Down arrow 处理行间 cursor 跳转 (保持列位置但截断到该行长度)
 *
 * 设计:
 * - `buffer` 是完整的多行文本 (含 \n)
 * - `cursor` 是 buffer 中的字符位置 (0..buffer.length)
 * - 渲染: 按 \n split, 每行一个 Box, 第一行 ❯ (红), 续行 ... (灰)
 * - cursor 所在行渲染 inverse 字符表示光标, 其他行纯文本
 * - 提交后 MultilineInput 内部清空 buffer + cursor
 *
 * Task #2292: React.memo 包一下 — 父组件 messages 变化时不重渲染
 * (useCallback handleSubmit 配合确保 onSubmit 引用稳定)
 */
/**
 * Task #2293 (合并 main): MultilineInputRef — 父组件能调 imperative methods
 * (例如父 useInput 收到 Esc 时调 clearBuffer, 触发 onEscape cascade)
 *
 * Task #2312 T-B: 新增 getBuffer/setBuffer — 父组件读/写输入框内容
 * - getBuffer: 父组件读当前 buffer (例如弹窗逻辑判断 buffer 是否以 / 开头)
 * - setBuffer: 父组件写 buffer (例如 / 弹窗选中命令后补全输入框为 "/help ")
 */
export interface MultilineInputRef {
  /** 清空 buffer 和 cursor */
  clearBuffer: () => void;
  /** 读取当前 buffer (父组件用) */
  getBuffer: () => string;
  /** 设置 buffer (父组件用, 例如弹窗选中命令时补全) */
  setBuffer: (value: string) => void;
}

/**
 * Task #2292: MultilineInput — uncontrolled 多行可编辑 input 组件
 *
 * 解决 bug:
 * - Task #2289: 提交传整个 buffer (不只是最后一行)
 * - Task #2290: MultilineInput 改 uncontrolled, 父组件不再因按键重渲染
 * - Task #2291: Backspace 兼容 \x7f
 * - Task #2292: 所有行都可编辑 (cursor 在哪行哪列渲染 inverse 光标),
 *                Up/Down arrow 处理行间 cursor 跳转 (保持列位置但截断到该行长度)
 * - Task #2293: forwardRef + clearBuffer API, 让父 REPLInk 收到 Esc 后能清空
 *               (且不拦截 Esc, 让父 useInput 处理 onEscape cascade)
 *
 * 设计:
 * - `buffer` 是完整的多行文本 (含 \n)
 * - `cursor` 是 buffer 中的字符位置 (0..buffer.length)
 * - 渲染: 按 \n split, 每行一个 Box, 第一行 ❯ (红), 续行 ... (灰)
 * - cursor 所在行渲染 inverse 字符表示光标, 其他行纯文本
 * - 提交后 MultilineInput 内部清空 buffer + cursor
 * - React.memo 包装 + forwardRef 让父组件可以 imperative 调 clearBuffer
 *
 * Task #2303: 子 useInput 在 key.escape 入口直接调 onEscape + return,
 *             不依赖父 useInput listener 顺序 (父 handler 是 inline 函数,
 *             每次 render 重建 → ink effect 反复 remove/re-add → 存在空窗期,
 *             ESC 在空窗期到达时只触发子 handler, 父 onEscape 永远漏调).
 *             父 useInput 保留 ESC 兜底作为双保险 (REPLInk 用 lastEscapeTsRef 去重).
 */
export const MultilineInput = React.memo(React.forwardRef<MultilineInputRef, {
  onSubmit: (v: string) => void | Promise<void>;
  placeholder?: string;
  /**
   * Task #2312 T-B: 弹窗是否处于激活状态 (用户输入 / 时为 true)
   * 当弹窗激活时:
   * - Enter 不会触发 onSubmit (让父组件用弹窗逻辑选中命令)
   * - Alt+Enter 仍然插入 \n (多行 / 命令不常用, 但保持一致性)
   */
  popupActive?: boolean;
  /**
   * Task #2312 T-B: 父组件订阅 buffer 变化的回调
   * - 每次 buffer 变化时调用 (字符插入/删除/弹窗补全都触发)
   * - 父组件用这个状态决定是否显示 / 命令弹窗
   */
  onChange?: (value: string) => void;
  /**
   * Task #2303: 子组件直接拦截 ESC, 不依赖父 useInput listener 顺序.
   * 父用 handleEscapeCascade (100ms dedup 保护避免子+父双触发)
   */
  onEscape?: () => void;
}>(function MultilineInput(props, ref) {
  const { onSubmit, placeholder, popupActive, onChange, onEscape } = props;
  // 每次 render 都重建, // (多行编辑器) buffer 状态 + cursor 位置
  //       ink effect 依赖 [inputHandler] 会反复 remove/re-add listener,
  //       父 listener 在 re-render 间隙可能不在 internal_eventEmitter 列表里.
  //       ESC 在此空窗期到达时只触发子 handler, 而子 handler 因 key.meta=true
  //       (ink 把 Esc 也算 meta) 而 return, 导致父 onEscape 永远漏调.
  // 修复: 子 useInput 同步调 onEscape + return, 跳过后面所有 meta 拦截逻辑.
  //       父 useInput 保留 ESC 兜底作为双保险 (REPLInk 用 lastEscapeTsRef 去重).

  // Task #2290: uncontrolled MultilineInput 内部 useState 维护 buffer + cursor
  const [buffer, setBuffer] = React.useState("");
  const [cursor, setCursor] = React.useState(0);

  // Task #2312 T-B: 每次 buffer 变化通知父组件 (via onChange)
  // 用 useEffect 监听 buffer 变化, 避免在每个 setBuffer 调用点都手动调 onChange
  //
  // Task #2350: 加 popupActive 门控 — 只在 popup 激活 OR buffer 以 / 开头时通知父级
  // 根因 (Bug): 普通字符 (abc, hello) 输入时也调 onChange → 父级 setInputValue
  //             → 父级 REPLInk 重新渲染 → ink 重新绘制整个屏幕 (包括 Static 区域)。
  //             用户感受到"整个消息历史从第一条重新滚动渲染"。
  // 修复: 加 popupActive 到门控条件 —
  //   - buffer.startsWith('/') || popupActive → 通知父级 (保持 popup 行为, Task #2320)
  //   - 普通字符 → 不通知父级 (新逻辑, 完全在 MultilineInput 内部处理)
  // 父级只在以下场景需要 buffer 同步:
  //   1. 弹窗需要 filterCommands(inputValue) 来过滤命令列表
  //   2. inputValue 用于派生 showPopup / filteredCmds
  // 普通字符场景父级不依赖 buffer, 所以不需要通知。
  React.useEffect(() => {
    if (popupActive || buffer.startsWith("/")) {
      onChange?.(buffer);
    }
  }, [buffer, onChange, popupActive]);

  // Task #2293: 暴露 clearBuffer imperative method (父 useInput 收到 Esc 时调用)
  // Task #2312 T-B: 新增 getBuffer/setBuffer (弹窗补全用)
  React.useImperativeHandle(ref, () => ({
    clearBuffer: () => {
      setBuffer("");
      setCursor(0);
    },
    getBuffer: () => {
      return buffer;
    },
    setBuffer: (value: string) => {
      setBuffer(value);
      setCursor(value.length);
    },
  }), [buffer]);

  useInput((input, key) => {
    // Task #2303: ESC 在子组件层拦截, 直接调 onEscape (同步链路)
    // 不依赖父 useInput listener 顺序 — 父 listener 在 streaming re-render 期间
    // 可能正好被 remove, 此空窗期到达的 ESC 只触发子 handler.
    if (key.escape) {
      // 清空 buffer (与父 clearBuffer 行为一致)
      setBuffer("");
      setCursor(0);
      // 同步调 onEscape — 让上层 (interactive.handleEscKey) 立即收到信号
      if (onEscape) {
        try {
          onEscape();
        } catch (err) {
          inkLogger.warn(`[MultilineInput] onEscape failed: ${err}`);
        }
      }
      return; // 不插入字符, 不让后续 meta 拦截逻辑误触
    }

    // Alt+Enter / Shift+Enter / Ctrl+Enter — 插入 \n (不提交)
    if (key.return && (key.meta || key.shift || key.ctrl)) {
      setBuffer((b) => {
        const newBuf = b.slice(0, cursor) + "\n" + b.slice(cursor);
        // 用 setTimeout 把 cursor 更新推后到下一帧, 避免与 setBuffer 批处理冲突
        setTimeout(() => setCursor(cursor + 1), 0);
        return newBuf;
      });
      return;
    }

    // Enter (无任何修饰键) — 提交
    if (key.return) {
      // Task #2312 T-B: 弹窗激活时, Enter 用于选中命令, 不提交
      // 父 useInput 会处理 Enter 逻辑 (选中当前 popupIndex 的命令)
      if (popupActive) {
        return;
      }
      if (buffer.trim() === "") {
        // 空 buffer, 跳过 (与父组件 handleSubmit 一致)
        return;
      }
      // 提交当前 buffer, 异步等待 onSubmit 完成后再清空 (让父组件先把消息加进去)
      // 注意: 用 IIFE 包 try/catch 处理同步抛错的情况
      (async () => {
        try {
          await Promise.resolve(onSubmit(buffer));
        } catch {
          // 即便 onSubmit 同步/异步抛错, 也清空 buffer (避免 stuck 在错误输入)
        }
        setBuffer("");
        setCursor(0);
      })();
      return;
    }

    // Task #2291: Backspace 兼容 \x7f (DEL)
    // 现代终端的 Backspace 键发的是 \x7f (DEL, 0x7f) — 不是 \b (BS, 0x08)。
    // ink 的 parseKeypress 把 \x7f 识别为 key.delete, \b 识别为 key.backspace。
    // 因此把 key.backspace 和 key.delete 都走 "删除光标前一个字符" 逻辑。
    // 真正的 forward-delete (删光标后) 可以用 Ctrl+D (但会被父 useInput 拦截退出, 不行)
    // 或者将来再加专门的 Meta+Backspace 之类的组合。
    if ((key.backspace || key.delete) && cursor > 0) {
      setBuffer((b) => b.slice(0, cursor - 1) + b.slice(cursor));
      setCursor((c) => c - 1);
      return;
    }

    // Left arrow — 光标左移
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }

    // Right arrow — 光标右移
    if (key.rightArrow) {
      setCursor((c) => Math.min(buffer.length, c + 1));
      return;
    }

    // Task #2292: Up arrow — 光标跳到上一行 (保持列位置但不超过上一行长度)
    if (key.upArrow) {
      const curLines = buffer.length === 0 ? [""] : buffer.split("\n");
      let curRow = 0;
      let curCol = 0;
      let p = 0;
      for (let i = 0; i < curLines.length; i++) {
        const lLen = (curLines[i] ?? "").length;
        if (cursor <= p + lLen) {
          curRow = i;
          curCol = cursor - p;
          break;
        }
        p += lLen + 1;
      }
      if (curRow > 0) {
        // 计算上一行的起始位置和长度
        let prevStart = 0;
        for (let i = 0; i < curRow - 1; i++) {
          prevStart += (curLines[i] ?? "").length + 1;
        }
        const prevLen = (curLines[curRow - 1] ?? "").length;
        // 列位置不超过上一行长度 (但允许在行末 — col == prevLen 表示 \n 之前)
        const newCol = Math.min(curCol, prevLen);
        setCursor(prevStart + newCol);
      }
      return;
    }

    // Task #2292: Down arrow — 光标跳到下一行
    if (key.downArrow) {
      const curLines = buffer.length === 0 ? [""] : buffer.split("\n");
      let curRow = 0;
      let curCol = 0;
      let p = 0;
      for (let i = 0; i < curLines.length; i++) {
        const lLen = (curLines[i] ?? "").length;
        if (cursor <= p + lLen) {
          curRow = i;
          curCol = cursor - p;
          break;
        }
        p += lLen + 1;
      }
      if (curRow < curLines.length - 1) {
        // 计算下一行的起始位置和长度
        let nextStart = 0;
        for (let i = 0; i <= curRow; i++) {
          nextStart += (curLines[i] ?? "").length + 1;
        }
        const nextLen = (curLines[curRow + 1] ?? "").length;
        const newCol = Math.min(curCol, nextLen);
        setCursor(nextStart + newCol);
      }
      return;
    }

    // Home — 光标移到行首
    if (key.ctrl && input === "a") {
      // 找到当前光标所在行的行首
      const beforeCursor = buffer.slice(0, cursor);
      const lastNewline = beforeCursor.lastIndexOf("\n");
      setCursor(lastNewline === -1 ? 0 : lastNewline + 1);
      return;
    }

    // End — 光标移到行尾
    if (key.ctrl && input === "e") {
      // 找到当前光标所在行的行尾
      const afterCursor = buffer.slice(cursor);
      const nextNewline = afterCursor.indexOf("\n");
      setCursor(nextNewline === -1 ? buffer.length : cursor + nextNewline);
      return;
    }

    // Ctrl+U — 清空当前行 (光标位置到行首)
    if (key.ctrl && input === "u") {
      const beforeCursor = buffer.slice(0, cursor);
      const lastNewline = beforeCursor.lastIndexOf("\n");
      const afterCursor = buffer.slice(cursor);
      const nextNewline = afterCursor.indexOf("\n");
      // 当前行的范围: [lastNewline+1, cursor + nextNewline) 或 [0, cursor+nextNewline)
      const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
      const lineEnd = nextNewline === -1 ? buffer.length : cursor + nextNewline;
      const newBuf = buffer.slice(0, lineStart) + buffer.slice(lineEnd);
      setBuffer(newBuf);
      setCursor(lineStart);
      return;
    }

    // Ctrl+K — 删除到行尾 (从光标到行尾)
    if (key.ctrl && input === "k") {
      const afterCursor = buffer.slice(cursor);
      const nextNewline = afterCursor.indexOf("\n");
      const cutEnd = nextNewline === -1 ? buffer.length : cursor + nextNewline;
      const newBuf = buffer.slice(0, cursor) + buffer.slice(cutEnd);
      setBuffer(newBuf);
      return;
    }

    // Task #2292: Up/Down arrow 已在上面单独处理 — 不再 noop

    // Ctrl+C / Ctrl+D — 留给父 useInput 处理 (MultilineInput 不拦截)
    if (key.ctrl && ((key as any).c === true || (key as any).d === true)) {
      return;
    }

    // 忽略单独的 ctrl/meta 修饰键 (无 input 字符串)
    if (key.ctrl || key.meta) {
      return;
    }

    // 普通字符插入 (包括粘贴多字符 — ink useInput 把整段粘贴作为 input 传入)
    if (input && input.length > 0) {
      // 把粘贴内容里的 \n 转成多行 (处理 bracketed paste)
      // 注意: bracketed paste 通常 \n 已被 escape, 这里保险起见再做一次
      const safeInput = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      setBuffer((b) => b.slice(0, cursor) + safeInput + b.slice(cursor));
      setCursor((c) => c + safeInput.length);
    }
  });

  // === 渲染 ===
  // Task #2292: 所有行都可编辑 — cursor 在哪一行哪一列, 就在那一行渲染 inverse 光标
  const lines = buffer.length === 0 ? [""] : buffer.split("\n");

  // 计算每行在 buffer 中的起始位置
  const lineStarts: number[] = [0];
  for (let li = 0; li < lines.length - 1; li++) {
    lineStarts.push(lineStarts[li]! + (lines[li] ?? "").length + 1); // +1 for \n
  }

  // 计算 cursor 在哪一行哪一列
  let cursorRow = 0;
  let cursorCol = 0;
  {
    let p = 0;
    for (let i = 0; i < lines.length; i++) {
      const lLen = (lines[i] ?? "").length;
      if (cursor <= p + lLen) {
        cursorRow = i;
        cursorCol = cursor - p;
        break;
      }
      p += lLen + 1;
    }
  }

  // placeholder 模式: 空 buffer + 有 placeholder
  const showPlaceholder = buffer.length === 0 && placeholder;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const isFirst = i === 0;
        const isCursorRow = i === cursorRow;
        const prefixEl = (
          <Text color={isFirst ? "red" : "gray"}>
            {isFirst ? "❯ " : "... "}
          </Text>
        );

        // 在 cursor 行: 渲染 inverse 光标
        if (isCursorRow) {
          const beforeCursor = line.slice(0, cursorCol);
          let atCursor: string;
          let afterCursor: string;

          if (showPlaceholder) {
            // placeholder 模式: 占位字符
            atCursor = placeholder?.[0] ?? " ";
            afterCursor = ""; // placeholder 后面的部分单独渲染
          } else {
            atCursor = line[cursorCol] ?? " "; // 行末时是空格
            afterCursor = line.slice(cursorCol + 1);
          }

          return (
            <Box key={i}>
              {prefixEl}
              <Text>{beforeCursor}</Text>
              <Text inverse={!showPlaceholder}>
                {atCursor}
              </Text>
              {showPlaceholder ? (
                <Text color="gray">{placeholder?.slice(1) ?? ""}</Text>
              ) : (
                <Text>{afterCursor}</Text>
              )}
            </Box>
          );
        }

        // 非 cursor 行: 纯文本 (但每行都有自己的渲染框, 视觉上独立)
        return (
          <Box key={i}>
            {prefixEl}
            <Text>{line}</Text>
          </Box>
        );
      })}
    </Box>
  );
}));

/**
 * 单条消息渲染
 *
 * Task #2292: MessageView 包 React.memo — msg 引用不变就不重渲染
 * streaming 时只 streaming 那条 message 引用变化, 其他历史消息保持稳定
 */
const MessageView = React.memo(function MessageView({
  msg,
  terminalWidth,
  tailBounds,
}: {
  msg: REPLMessage;
  /** Optional terminal width override; defaults to stdout.columns or 80. */
  terminalWidth?: number;
  /** Optional dynamic-tail bounds; when provided, the assistant content
   * is rendered through MarkdownBounded so its visible height fits the
   * viewport. Task #2657 (continuation) R2. */
  tailBounds?: DynamicTailBounds;
}): React.ReactElement {
  // Task #2311 Plan B: welcome card (messages[0]) 走特殊渲染路径
  // - 多行内容（含 box-drawing 边框 + pixel logo）
  // - 不带 ❯ / ● prefix
  // - 直接用 <Text> 输出 buildWelcomeCard 完整字符串
  // 这样 messages[0] 就是 history 的第一条, 用户滚动可见完整 logo
  if (msg.kind === "welcome") {
    return (
      <Box flexDirection="column">
        <Text>{msg.content}</Text>
      </Box>
    );
  }

  // Task #4396: standalone dim grey cache/token footer row.
  if (msg.role === "usage") {
    return (
      <Box flexDirection="column" marginLeft={2}>
        <UsageFooter usage={msg.usage} />
      </Box>
    );
  }

  let prefix: string;
  let color: string;
  // Task #2291: 内容色 — 与 prefix 区分
  // user: 整段红色 (prefix + 内容都是红) — 让用户输入明显是红色
  // assistant: 内容默认色 (markdown 内部已经用颜色区分), prefix 绿色
  // 其他 role: 内容用对应色
  let contentColor: string | undefined;
  switch (msg.role) {
    case "user":
      prefix = "❯";
      color = "red";
      contentColor = "red";
      break;
    case "assistant":
      prefix = "●";
      color = "green";
      contentColor = undefined; // 默认色 — markdown 自己用颜色
      break;
    case "tool":
      prefix = "🔧";
      color = "magenta";
      contentColor = "magenta";
      break;
    case "tool_result":
      prefix = "↪";
      color = "blue";
      contentColor = "blue";
      break;
    case "reasoning":
      prefix = "💭";
      color = "gray";
      contentColor = "gray";
      break;
    case "system":
    default:
      prefix = "ℹ";
      color = "yellow";
      contentColor = "yellow";
      break;
  }
  const displayContent =
    msg.role === "tool" || msg.role === "tool_result"
      ? `${msg.toolName ?? "tool"}: ${msg.content}`
      : msg.content;

  const width = terminalWidth ?? process.stdout.columns ?? 80;

  // Task #2290: assistant role 走 markdown 渲染
  if (msg.role === "assistant") {
    // Task #2657 (continuation) R2: when the caller supplies tail bounds,
    // render the markdown through MarkdownBounded so the dynamic region
    // never overflows the terminal height. For stable (committed)
    // history, the caller passes no bounds, so the full content is
    // rendered (and lives in Ink <Static>).
    const body = tailBounds ? (
      <MarkdownBounded text={displayContent} bounds={tailBounds} width={width} />
    ) : (
      <Markdown text={displayContent} />
    );
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="green" bold>{prefix} </Text>
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          {body}
          {msg.streaming ? <Text color="gray">▌</Text> : null}
        </Box>
      </Box>
    );
  }

  // 其他 role — Task #2291: 内容也用对应颜色增强区分
  // Task #2657 R2: when called for the tail slot, also bound the height
  // so a long user/tool/system message cannot overflow the viewport.
  if (tailBounds) {
    return (
      <Box>
        <Text color={color} bold>{prefix} </Text>
        <Text color={contentColor}>
          {renderBoundedPlain(displayContent, tailBounds, width)}
          {msg.streaming ? "▌" : ""}
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color={color} bold>{prefix} </Text>
      <Text color={contentColor}>
        {displayContent}
        {msg.streaming ? "▌" : ""}
      </Text>
    </Box>
  );
});

/**
 * 短 model 名
 */
function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const last = model.split("-").pop() ?? model;
  return last.length <= 6 ? last : last.slice(0, 6);
}

/**
 * 启动 ink REPL（在 interactive.ts 中调用）
 */
export async function renderInkREPL(props: REPLInkProps): Promise<void> {
  const ink = await import("ink");
  const { waitUntilExit } = ink.render(React.createElement(REPLInk, props));
  await waitUntilExit();
}
