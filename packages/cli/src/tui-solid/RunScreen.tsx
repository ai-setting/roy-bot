/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview RunTuiSolid — Solid composition root for `roy-bot interactive`.
 *
 * Port of `RunTui.tsx` (Ink/React) to `@opentui/solid` for Task #4278 (片1 地基).
 *
 * The conversation loop (streaming accumulation, tool-card lifecycle, slash
 * dispatch, notification wiring) is a faithful port; only the surface that was
 * framework-specific changed:
 *
 *   React                               Solid
 *   ----------------------------------- ------------------------------------
 *   useState / useRef                   createSignal / mutable box
 *   useCallback                         plain closures
 *   useApp().exit()                     onExit prop (caller destroys renderer)
 *   useStdout().rows                    process.stdout.rows / renderer.height
 *
 * Scope note (片1): this file is the *mount* target. It deliberately keeps the
 * same three exported surfaces RunTui exposes (`RunScreen`-equivalent + the
 * handler registration contract) so `commands/interactive.ts` only has to swap the
 * import + render call, nothing else.
 */

import { createSignal, For, Show } from "solid-js";
import { TextAttributes, type KeyEvent, ScrollBoxRenderable } from "@opentui/core";
// Task #4278 片4: `writeSolidToScrollback` is the Solid-native equivalent of
// Ink's <Static> — it renders a Solid subtree once into the terminal's
// scrollback (write-once, never repainted), which is what keeps committed
// history from flickering/replaying as the dynamic footer ticks.
import { useKeyboard } from "@opentui/solid";
import { App, TextInput, HistoryEntry, type HistoryItem } from "./index.js";
import { useStreamingAccumulator } from "./use-streaming-accumulator.js";
import { createScrollViewport } from "./scroll-viewport.js";
import { isDescendantOf, scrollLinesForWheelEvent } from "./scroll.js";
import { routeScrollKey, applyScrollKey, type ScrollableLike } from "./scroll-commands.js";
import { selectHistoryWindow } from "./scrollback-replay.js";
import {
  formatToolOutput,
  type ToolCallInfo,
  type ToolStreamEvent,
} from "../tui/tool-call.js";
import { renderMarkdown, truncateForTerminal } from "../render/markdown.js";
import {
  dispatchSlashCommand,
  CLEAR_SENTINEL,
  type SlashContext,
} from "../slash.js";
// Task #4396: the usage footer (cache/token one-liner).
// ⚠️ Import the **pure** module `tui/usage-format.ts`, NOT `tui/UsageFooter.tsx`:
//   the latter does `import { Text } from "ink"` at top level, so importing it
//   would drag **React + Ink** into the opentui path — violating the fork's
//   documented policy ("Shared *pure* modules (no JSX / no React) are re-used
//   in place rather than forked"). Every other shared module `tui-solid/`
//   imports (`tui/tool-call.ts`, `tui/theme.ts`, `tui/scrollback.ts`) has
//   zero imports for exactly this reason.
import { formatMetaLine, type UsageLike } from "../tui/usage-format.js";
// Task #5109 P7 —— 斜杠命令注册表（interactive 版）。
import { interactiveSlashCommands } from "./interactive-slash-commands.js";
import { findSlashCommand } from "./slash-registry.js";
// Task #5116 P7.1 —— 配置弹窗（/connect / /model）。
import { Dialog } from "./Dialog.js";
import {
  dialogReducer,
  initialDialogState,
  parseModelDialogId,
  modelDialogBadge,
  CONNECT_FORM_FIELDS,
  type DialogState,
  type DialogListItem,
} from "./dialog-state.js";
import {
  readAuthProviders,
  resolveUserConfigDir,
  upsertAuthProvider,
  redactApiKey,
  readModelsFromConfig,
  setDefaultModel,
} from "./app-config-io.js";

export interface RunTuiSolidProps {
  handleQuery: (message: string) => Promise<string>;
  /**
   * Task #4278 片6 + #4588：streaming 变体的签名。
   *
   * ⚠️ **positional 顺序必须与 `commands/interactive.ts` 的 `createStreamHandleQuery`
   * 完全一致**（也就是 main 的契约）：
   *   `(message, onChunk, onTool, onUsage, envEvent, onReasoning)`
   *
   * 片6 最初把 `onReasoning` 插在 `onUsage` 之前 ⇒ main 的 Ink 调用点与
   * main 原生护栏测试 `interactive-notify-chain.test.ts` 全部参数错位
   * （envEvent 落进 onUsage 位 / usage 收不到）⇒ 通知链路静默失效 +
   * usage 脚注消失。详见 interactive.ts 里 `createStreamHandleQuery` 的注释。
   */
  streamHandleQuery?: (
    message: string,
    onChunk: (chunk: string) => void,
    onTool?: (event: ToolStreamEvent) => void,
    onUsage?: (usage: UsageLike) => void,
    envEvent?: unknown,
    onReasoning?: (delta: string) => void
  ) => Promise<string>;
  model?: string;
  workdir?: string;
  maxLines: number;
  markdownEnabled: boolean;
  showToolCalls?: boolean;
  showToolResults?: boolean;
  onExit?: () => void;
  /**
   * ★ Task #4721 G2（打断）：用户按下 ESC / Ctrl-C 时回调。
   *
   * ## 为什么需要这个出口
   *
   * opentui 路径**原本完全没有**打断链路（`commands/interactive.ts` grep
   * `escape|abortAll|abortStream` = 0 命中）。而 Ink 链路
   * （`commands/run.ts:897-906` → `handleEscKey`）有。
   *
   * 更关键：流式期间 `<TextInput>` 被 `<Show>` **卸载** ⇒ 那一刻
   * **没有任何键盘处理器注册** ⇒ ESC 无人监听。
   *
   * ⇒ 这里注册**常驻**的 `useKeyboard`（不随 status 挂载/卸载），
   * 并把「打断什么」的决策交给调用方（`commands/interactive.ts` 才有
   * `env.getComponent("agent")` 的 abortAll 能力）。
   */
  onInterrupt?: () => void;
  /**
   * ★ Task #5125 P7.2 —— /model 热切换出口。
   *
   * 用户在 /model 弹窗选中模型后，RunScreen 自己只做**持久化**
   * （写 config.jsonc，P7.1 既有）；「内存层生效」需要 `env` /
   * `configComponent` 的持有者（`commands/interactive.ts`）来
   * 完成 ⇒ 经由本回调把 `(provider, model)` 交回调用方。
   *
   * 调用方实现：更新 `runtimeModelOverride` 闭包（下一轮
   * context.model = 新模型）+ `config.set("llm.defaultModel"/"defaultProvider")`
   * （内存层立即生效，LLMComponent watcher 自动感知）。
   *
   * 持久化失败时 RunScreen 仍会调本回调吗？——不会：
   * 失败 ⇒ 只显示错误通知，**不**切内存层（持久化与内存层
   * 保持一致，避免「文件里还是旧模型、会话却换了」的漂移）。
   */
  onModelHotSwap?: (provider: string, model: string) => void | Promise<void>;
  /**
   * ★ Task #5125 P7.2 —— 配置目录根的可注入点。
   *
   * P7.1 的配置 IO（`app-config-io.ts`）全部接受显式 `homeDir`
   * 参数——「纯函数 + 显式依赖」是同一理念。
   * ★ Task #5129 P7.3：生产不传时走 **resolveUserConfigDir()**
   * （XDG 优先 → home 回退，与 boot 读侧同源——M1 修复）；
   * 测试传 mkdtemp 临时目录（显式值 = 测试家目录，仍拼
   * `.roy-bot`）。
   */
  homeDir?: () => string;
  /**
   * ★ Task #4954 P0（DS MINOR-D）：prop 契约保留，语义已退役。
   *
   * split-footer 时代它驱动 `renderer.footerHeight` 动态增高
   * （防裁剪/叠印）；alternate-screen 下没有 footerHeight 概念
   * （App.tsx flex 层负责锚定），调用方（interactive.ts）只记账不触 renderer。
   * P3 清理时与 scrollViewport/requestRender 一起移除。
   *
   * @param height 期望的动态区高度（行）——仅记账用途
   */
  onFooterHeightChange?: (height: number) => void;
  onRegisterHandlers?: (handlers: {
    onNotification: (message: string, envEvent?: any) => void | Promise<void>;
    /**
     * ★ Task #4588（端口到 opentui/Solid）：仅显示、不触发 agent 的通知出口。
     *
     * `true` = 已接管并显示；`false`/`undefined` = 未就绪，调用方需兜底。
     * `commands/interactive.ts` 的 `dispatchInteractiveNotice` 用 `=== true` 判定。
     */
    onNotice?: (text: string) => boolean;
    isIdle: () => boolean;
    /**
     * ★ Task #4721 G1：**历史区**的滚轮（opentui 不派发的那部分）。
     *
     * opentui 的 `processSingleMouseEvent` 在 split-footer 下对
     * `y < renderOffset` 的指针**直接 return false** ⇒ 历史区的滚轮根本
     * 走不到任何 renderable ⇒ 只能由 `commands/interactive.ts` 用
     * `prependInputHandlers` 拦下原始序列后转交到这里。
     *
     * @param direction 滚轮方向
     */
    onHistoryWheel?: (direction: "up" | "down" | "left" | "right") => void;
  }) => void;
}

export function RunScreenSolid(props: RunTuiSolidProps) {
  // ★ Task #5129 P7.3 M1（DS review）——生产默认必须与 boot
  //   读侧**同一解析**：resolveUserConfigDir()（XDG 优先 →
  //   home 回退），而不是裸 os.homedir()。否则设了
  //   XDG_CONFIG_HOME 的用户 boot 读 XDG 配置、弹窗读写
  //   ~/.roy-bot —— M1 原 bug 复现（reviewer 实测确认）。
  //   prop 仅用于测试注入（显式目录 = 测试的显式家目录）。
  const homeDir = () => props.homeDir?.() ?? resolveUserConfigDir();

  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [maxLines, setMaxLines] = createSignal(props.maxLines);
  const [userHistory, setUserHistory] = createSignal<string[]>([]);
  const [liveTools, setLiveTools] = createSignal<ToolCallInfo[]>([]);

  const showToolCalls = () => props.showToolCalls ?? true;
  const showToolResults = () => props.showToolResults ?? true;

  // Footer-height budget (read live so resize is picked up).
  const maxTailLines = () => Math.max(4, (process.stdout.rows ?? 24) - 12);
  const stream = useStreamingAccumulator({ maxTailLines: maxTailLines() });

  const counters = {
    user: 0,
    assistant: 0,
    processing: 0,
    historyId: 0,
  };
  const liveRef: Array<{ key: string; startedAt: number; info: ToolCallInfo }> = [];
  let toolSeq = 0;

  const syncLiveTools = () => setLiveTools(liveRef.map((t) => t.info));

  // ---------------------------------------------------------------------
  // ★ Task #4721 G1 — 滚动视口（鼠标滚轮上下滚动历史输出）
  //
  // ## 根因
  //
  // opentui 的滚轮事件**只**派发给 `hitTest` 命中的 renderable
  // （chunk-node-2rg7pskw.js:23313-23325），而 `tui-solid/` 全目录
  // grep `onMouseScroll` = 0 命中 ⇒ 滚轮无处可去 ⇒ **滚不动**。
  //
  // ## 为什么需要「自管视口」
  //
  // 历史输出是 **write-once scrollback**（片4），**不在 renderable 树里**
  // ⇒ 树里任何节点都滚不到它；opentui 也没有公开的「回滚 scrollback
  // 视口」API ⇒ 只能自己记一个回退量，并在回退时把对应历史行**重新渲染
  // 进 frame**（见下面的 `scrollbackLines` + `visibleHistory`）。
  //
  // ## 事件怎么拿到
  //
  // 根 `<box>` 挂**常驻**的 `onMouseScroll`：
  //   - 命中根节点 ⇒ 直接收到；
  //   - 命中子节点 ⇒ opentui 的 `processMouseEvent` 会**向 parent 冒泡**
  //     （chunk-node-2rg7pskw.js:12347）⇒ 根节点照样收到。
  // ⇒ 无论滚轮落在哪儿，根节点都是最终接收者。
  // ---------------------------------------------------------------------
  /**
   * ★ Task #4721 G1 的自管视口 —— **P3 Phase 1 后已是遗留物**。
   *
   * 实际的滚动接管者现在是 **scrollbox**（`stickyScroll + stickyStart="bottom"`
   * + `scrollAcceleration` 3 行步进），见 `App.tsx`。
   * 本对象只保留 `scroll-viewport.ts` 的**纯函数单测契约**
   * （不再驱动任何渲染；`applyWheel` 也不再读它的状态）。
   */
  const scrollViewport = createScrollViewport();
  /**
   * ★ Task #5041 P3 Phase 1：**消息区 scrollbox 的实例**。
   *
   * 用途：
   *   - `applyWheel` 需要它才能对消息区做相对滚动（`scrollBy`）；
   *   - 判定「滚轮事件是否已被 scrollbox 原生处理」需要比较事件 target
   *     与它的祖先链（见 `isDescendantOf`）。
   *
   * 由 App 的 `onScrollboxRef` 回调填充（挂载后即有值）。
   */
  let scrollbox: ScrollBoxRenderable | undefined;
  /**
   * ★ Task #4721 G1：历史副本（scrollback 不可读 ⇒ 自己留一份）。
   * 供「往上滚时把历史重新渲染进 frame」用。
   */
  const historyBuffer: HistoryItem[] = [];

  // ---------------------------------------------------------------------
  // ★ Task #4721 G2 — 打断链路（ESC / Ctrl-C）
  //
  // ## 为什么要「常驻」而不是挂在 TextInput 上
  //
  // 流式期间 `<TextInput>` 被 `<Show when={status === "idle"}>` **卸载**
  // ⇒ 那一刻**没有任何键盘处理器注册** ⇒ ESC 无人监听 ⇒ 用户无法打断。
  //
  // 而把 handler 挂在 TextInput 上也不对：TextInput 的 Ctrl-C 语义是
  // `onCancel → doExit`（**退出整个程序**），用户想停的只是**当前这一轮**。
  //
  // ## 两段式 Ctrl-C
  //
  //   第一次 Ctrl-C ⇒ 打断当前流（不清空输入框）
  //   第二次 Ctrl-C ⇒ 退出整个程序（沿用 Ink 链路的直觉）
  //
  // idle 时 ESC 什么也不做（不误伤正常输入）。
  // ---------------------------------------------------------------------
  /**
   * ★ Task #4721（交叉验证 MAJOR-2 修复）：**每一轮各自持有**自己的状态。
   *
   * ## 为什么不能是组件级的 `let`
   *
   * G3 让输入框**常驻** ⇒ 用户可以在流式期间**提交下一轮** ⇒ 两轮并发。
   * 若状态是组件级的（`let turnInterrupted`）：
   *
   *   轮 A 流式中 → 用户提交 B（B 的 `executeQuery` 把 `turnInterrupted`
   *   重置为 false、把 `turnProcessingReleased` 重置为 false）→ ESC →
   *   `triggerInterrupt` 释放一次名额（2→1）→ **A 的 finally** 执行
   *   `releaseProcessing()`（此时标志已被 B 重置）⇒ 又减一次（1→0）→
   *   **B 的 finally** 因标志已置位而不再减 ⇒ `counters.processing`
   *   **永久失配**（B 还在跑，但 `isIdle()` 为 true）。
   *
   *   同理 A 的 finally 里 `turnInterrupted = false` 会**清掉 B 的打断标记**
   *   ⇒ B 后续 chunk 不再被丢弃 ⇒ 用户以为打断了却仍在输出。
   *
   * ## 现在的做法
   *
   * 每个 `executeQuery` 调用创建**自己的** turn 对象（普通对象，不是 signal），
   * 只被那一轮的闭包捕获 ⇒ 跨轮**物理上不可能**互相影响。
   */
  interface TurnState {
    /** 本轮是否已被用户打断。 */
    interrupted: boolean;
    /** 本轮的「处理中」名额是否已经释放（幂等保护）。 */
    processingReleased: boolean;
  }

  /** 当前**活跃**的轮次集合（可能有多个并发）。 */
  const activeTurns = new Set<TurnState>();

  /** 释放某轮的「处理中」名额（幂等）。 */
  const releaseProcessing = (turn: TurnState) => {
    if (turn.processingReleased) return;
    turn.processingReleased = true;
    counters.processing = Math.max(0, counters.processing - 1);
  };

  /**
   * 打断当前流：把状态拉回 idle，并通知调用方去 abort agent / stream。
   *
   * ⚠️ 打断**所有**活跃轮次（用户按 ESC 的语义是「停掉现在这轮生成」，
   *   而并发轮次在用户视角都是「正在生成」）。
   */
  const triggerInterrupt = () => {
    for (const turn of activeTurns) {
      turn.interrupted = true;
      // 立刻把动态区切回 idle —— 输入框重新出现（锚定问题的前提，见 G3）。
      stream.finish();
      // 立刻释放「处理中」名额 ⇒ isIdle() 立刻为 true（见 releaseProcessing 注释）。
      releaseProcessing(turn);
    }
    props.onInterrupt?.();
  };

  // 常驻键盘处理器（不随 status 挂载/卸载 ⇒ 流式期间也活着）。
  //
  // ⚠️ 这里**只**处理 ESC，不处理 Ctrl-C ——
  //   Ctrl-C 由 `<TextInput>` 的 `useKeyboard` 处理（G3 之后 TextInput 常驻，
  //   它**总是**能收到 Ctrl-C）⇒ 统一走 `onCancel` 这一个出口，
  //   避免「两个 handler 都响应同一个 Ctrl-C」⇒ 打断 + 退出同时发生。
  // ★ Task #5109 P7 —— 斜杠面板打开状态（抑制 ESC 打断）。
  const [slashPaletteOpen, setSlashPaletteOpen] = createSignal(false);
  // ★ Task #5109 P7（DS r2 MINOR-2）—— 「本次按键是否已被输入框消费」。
  //
  // useKeyboard 没有消费语义 ⇒ 同一个 Escape 会被所有 handler 各看一遍。
  // 之前靠「注册顺序侥幸正确」；现在由 TextInput 显式通知消费，
  // RunScreen **延迟到微任务**再判定 ⇒ 那时所有 handler 都已跑完
  // ⇒ 与注册顺序**无关**。
  let consumedGeneration = 0;
  // ★ Task #5109 P7 —— interactive 斜杠命令注册表。
  const slashCommands = interactiveSlashCommands({
    model: props.model,
    // ★ Task #5302：/es 需要配置目录（event-sources.json 与 config.jsonc 同目录）
    homeDir: () => props.homeDir?.() ?? resolveUserConfigDir(),
  });

  // ---------------------------------------------------------------------
  // ★ Task #5116 P7.1 —— 配置弹窗（/connect + /model）。
  //
  // 状态：
  //   - dialogState() = DialogState | null（null = 关闭）
  //   - 弹窗数据（providers/models）在打开时**快照**读一次（IO）。
  //
  // 键盘：TextInput 挂 keyGate —— 弹窗开着 ⇒ 输入框不消费任何键；
  // 弹窗自己的 useKeyboard（下方）处理 ↑↓/Enter/Esc/字符。
  // ---------------------------------------------------------------------
  const [dialogState, setDialogState] = createSignal<DialogState | null>(null);
  /** 弹窗列表数据（打开时快照）。 */
  const [dialogItems, setDialogItems] = createSignal<DialogListItem[]>([]);
  /** 提交中的提示（写 IO 是异步的）。 */
  const [dialogBusy, setDialogBusy] = createSignal(false);

  // ★ Task #5129 P7.3 F3 —— 状态栏 model 跟随热切换。
  //   props.model 是启动时一次性传入（argv.model 恒不变）；
  //   热切换后状态栏若仍显示旧值，与通知行「当前会话已生效」
  //   视觉自相矛盾（#5125 DS review M4）。runtimeModel 以
  //   props.model 为初值，/model 选择成功后更新。
  const [runtimeModel, setRuntimeModel] = createSignal(props.model);

  const closeDialog = () => {
    setDialogState(null);
    setDialogItems([]);
  };

  /** 读取 auth.json providers → 列表项（脱敏 key）。 */
  const openConnectDialog = async () => {
    const read = await readAuthProviders(homeDir());
    const items: DialogListItem[] = read.providers.map((p) => ({
      id: p.name,
      label: p.name,
      detail: p.apiKey ? redactApiKey(p.apiKey) : "(no key)",
    }));
    setDialogItems(items);
    setDialogState(initialDialogState("connect"));
  };

  /** 读取 config.jsonc 模型 → 列表项。 */
  const openModelDialog = async () => {
    const read = await readModelsFromConfig(homeDir());
    const items: DialogListItem[] = [];
    for (const m of read.models) {
      items.push({
        id: `${m.provider}/${m.model}`,
        label: m.model,
        detail: m.provider,
        // ★ Task #5138 P7.4 —— 当前全局 default（llm.defaultModel）
        //   高亮优先；provider 级 default 兜底（modelDialogBadge 纯函数，
        //   可单测 —— 见 dialog-state.ts）。
        badge: modelDialogBadge(m),
      });
    }
    setDialogItems(items);
    setDialogState(initialDialogState("model"));
  };

  // ★ P7.1 —— 弹窗键盘处理（弹窗打开时独占）。
  //
  // 放在 TextInput 的 useKeyboard **之前**注册不成问题：
  // TextInput 有 keyGate（弹窗开着 ⇒ 输入框直接 return），
  // 与 P7 的注册顺序解耦纪律一致。
  useKeyboard((key: KeyEvent) => {
    const dlg = dialogState();
    if (!dlg) return;
    // 弹窗消费 ESC ⇒ 通知（微任务判定知道「本次 Esc 被弹窗吃掉」）。
    const consume = () => {
      consumedGeneration += 1;
    };

    if (dlg.mode === "form") {
      if (key.name === "escape") {
        consume();
        closeDialog();
        return;
      }
      if (key.name === "return" || key.name === "tab") {
        consume();
        const r = dialogReducer(dlg, { type: key.name === "return" ? "next-field" : "next-field" }, 0);
        if (r.outcome.kind === "form-submitted") {
          void submitConnectForm(r.outcome);
        } else {
          setDialogState(r.state);
        }
        return;
      }
      if (key.name === "backspace") {
        consume();
        setDialogState(dialogReducer(dlg, { type: "field-backspace" }, 0).state);
        return;
      }
      const text = key.sequence && key.sequence.length >= 1 && !key.ctrl && !key.meta
        ? key.sequence
        : "";
      if (text && text.charCodeAt(0) >= 0x20) {
        consume();
        setDialogState(dialogReducer(dlg, { type: "field-input", text }, 0).state);
      }
      return;
    }

    // list 模式
    if (key.name === "escape") {
      consume();
      closeDialog();
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      consume();
      setDialogState(dialogReducer(dlg, { type: "up" }, dialogItems().length).state);
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      consume();
      setDialogState(dialogReducer(dlg, { type: "down" }, dialogItems().length).state);
      return;
    }
    if (key.name === "return") {
      consume();
      const r = dialogReducer(dlg, { type: "select" }, dialogItems().length);
      if (r.outcome.kind === "item-selected") {
        const item = dialogItems()[dlg.selectedIndex];
        if (!item) return;
        if (dlg.kind === "model") {
          void selectDefaultModel(item);
        } else {
          // connect 列表 Enter = 新增表单入口。
          setDialogState({ ...dlg, mode: "form", fieldIndex: 0, fields: { name: "", apiKey: "", baseURL: "" } });
        }
      }
      return;
    }
  });

  /** /connect 表单提交：写 auth.json（失败 ⇒ 通知行）。 */
  const submitConnectForm = async (form: { name: string; apiKey: string; baseURL: string }) => {
    setDialogBusy(true);
    try {
      const r = await upsertAuthProvider(homeDir(), form);
      closeDialog();
      if (r.ok) {
        handleNotice(`✓ provider "${form.name}" ${r.created ? "added to" : "updated in"} ~/.roy-bot/auth.json`);
      } else {
        handleNotice(`⚠ ${r.error}`);
      }
    } finally {
      setDialogBusy(false);
    }
  };

  /** /model 选择：持久化 config.jsonc + 内存层热切换（失败 ⇒ 通知行）。 */
  const selectDefaultModel = async (item: DialogListItem) => {
    // ★ Task #5129 P7.3 F2 —— parseModelDialogId：只按第一个
    //   "/" 切一次，其余整体为 model（OpenRouter 风格
    //   provider/org/model 不再被截断）。
    const parsed = parseModelDialogId(item.id);
    if (!parsed) return;
    const { provider, model } = parsed;
    setDialogBusy(true);
    try {
      const r = await setDefaultModel(homeDir(), provider, model);
      closeDialog();
      if (r.ok) {
        // ★ Task #5125 P7.2：持久化成功 ⇒ 内存层立即生效
        //  （调用方更新 runtimeModelOverride + config.set）。
        await props.onModelHotSwap?.(provider, model);
        // ★ P7.3 F3：状态栏立即跟随新模型。
        setRuntimeModel(`${provider}/${model}`);
        handleNotice(`✓ default model → ${model} (${provider})（当前会话已生效）`);
      } else {
        handleNotice(`⚠ ${r.error}`);
      }
    } finally {
      setDialogBusy(false);
    }
  };

  useKeyboard((key: KeyEvent) => {
    if (key.name !== "escape") return;
    // idle 时 ESC 什么也不做（不误伤正常输入）。
    if (stream.status() === "idle") return;
    // ★ Task #5109 P7 —— 斜杠面板打开时，ESC 只关面板，不打断流式。
    if (slashPaletteOpen()) return;
    const seen = consumedGeneration;
    // 微任务：等所有 handler 跑完（TextInput 若消费了本次 ESC 会 +1）。
    queueMicrotask(() => {
      // ★ Task #5109 P7（DS r2 MINOR-2）—— 面板已消费本次 ESC ⇒ 不打断。
      if (consumedGeneration !== seen) return;
      if (stream.status() === "idle") return;
      if (slashPaletteOpen()) return;
      triggerInterrupt();
    });
  });

  /**
   * ★ Task #5077 P3 Phase 2：**键盘滚动**通道（对齐 opencode 双通道滚动）。
   *
   * ## 键位（对齐 opencode `config/keybind.ts:181-188`）
   *
   * | 语义     | 键位                              | 行为               |
   * |----------|-----------------------------------|--------------------|
   * | 翻半屏   | `pageup`/`pagedown`、`ctrl+alt+b/f` | 半视口            |
   * | 翻¼屏    | `ctrl+alt+u/d`、`ctrl+u/d`        | ¼ 视口             |
   * | 走一行   | `ctrl+alt+y/e`                     | 1 行               |
   * | 跳顶     | `ctrl+g`                           | 顶部（关粘底）     |
   * | 跳底     | `ctrl+alt+g`                       | 底部（恢复粘底）   |
   *
   * ## 为什么 home/end 不收
   *
   * 本仓 `<TextInput>` 把 home/end 用于**行内光标跳转**
   * （TextInput.tsx:122-129）—— 用户在输入框打字时按 home/end
   * 是想移动光标，不是滚历史 ⇒ 这两个键归输入框。
   *
   * ## 为什么**不**在这里 return
   *
   * `useKeyboard` 的回调没有「消费」语义（不像 DOM 的 preventDefault），
   * 未命中的键必须**继续**流给 TextInput 的处理器 ⇒ 命中才处理，
   * 未命中什么都不做（`routeScrollKey` 返回 undefined 即放行）。
   */
  useKeyboard((key: KeyEvent) => {
    const command = routeScrollKey(key);
    if (!command) return; // 未命中 ⇒ 放行（TextInput 继续处理）
    // scrollbox 还没挂上（首帧之前）⇒ 无处可滚，静默忽略。
    if (!scrollbox) return;
    applyScrollKey(command, scrollbox as unknown as ScrollableLike);
  });

  /**
   * `<TextInput>` 的 Ctrl-C 出口（**单一真相源**）。
   *
   * - **流式中** ⇒ 打断当前这一轮（**不是**退出整个程序）。
   * - **空闲时** ⇒ 退出整个程序（沿用 Ink 链路的直觉）。
   */
  const handleCancel = () => {
    if (stream.status() === "idle") {
      doExit();
      return;
    }
    triggerInterrupt();
  };

  // ---------------------------------------------------------------------
  // Task #4278 片4 — split-footer history (R1 落地)
  //
  // Before: committed history lived in the reactive `history` signal, so
  // every dynamic-region repaint (streaming tick, spinner, live tool cards)
  // re-rendered the *entire* transcript in-frame → flicker + replay.
  //
  // Now: each committed message is rendered **once** into the terminal
  // scrollback via `writeSolidToScrollback(renderer, () => <HistoryEntry/>)`.
  // It leaves the reactive tree immediately, so dynamic ticks cannot touch it
  // (write-once semantics — the Ink `<Static>` analogue). This requires
  // `screenMode: "split-footer"`, which `commands/interactive.ts` already sets.
  // ---------------------------------------------------------------------


  /**
   * ★ Task #4721 G1：让动态区高度**跟着内容长**。
   *
   * ## 为什么
   *
   * split-footer 模式给动态区一个**固定**高度（`commands/interactive.ts` 里
   * `footerHeight: 12`）。回退历史时动态区会多出「提示行 + 回退的历史」⇒
   * 内容超出 12 行 ⇒ opentui **裁剪顶部** ⇒ 底部的提示/输入框与上一行
   * **重叠**（实测 PNG 证据 `04-scrolled-back.png`：提示行与 StatusBar 的
   * workdir 尾字叠印在一起）⇒ **制造出新的「底部乱流」**。
   *
   * ## 做法
   *
   * `renderer.footerHeight` 是公开可写的 setter（opentui 会重算几何并重绘）。
   * 这里按「基线高度 + 回退行数（上限封顶）」请求新的高度。
   */
  // ★ Task #4954 P0（DS MINOR-4）：alternate-screen 下无 footerHeight，
  //   syncFooterHeight 全链退役（P3 彻底清理时连同 prop 一起删）。
  //   保留 no-op 是为了让 onFooterHeightChange prop 契约不破
  //   （interactive.ts 侧仍在监听；alt-screen 下它只记账，不触 renderer）。

  // ★ Task #4954 P0：历史承载 = **响应式 rows**（scrollbox 数据源）。
  //
  // ## 为什么放弃 writeSolidToScrollback
  //
  // alternate-screen 下 `renderer.writeToScrollback` 会 **throw**
  // （强校验 `screenMode==="split-footer" && externalOutputMode==="capture-stdout"`，
  // opentui chunk-node 实现）⇒ 旧链路整体不可用。
  //
  // ## 新契约（对齐 opencode routes/session/index.tsx:1501-1560）
  //
  // 历史消息渲染进 scrollbox 树（`<For each={historyRows()}>`），
  // scrollbox `stickyScroll + stickyStart="bottom"` 跟随最新；
  // 输入框 `flexShrink=0` 常驻沉底（App.tsx 布局层）。
  //
  // historyBuffer（数组）保留：仅作为 P3 滚动接管前的数据源备份
  // 与 scrollback-replay 单测的契约输入。
  const [historyRows, setHistoryRows] = createSignal<HistoryItem[]>([]);

  const commitHistory = (item: HistoryItem) => {
    historyBuffer.push(item);
    setHistoryRows((h) => [...h, item]);
    // ★ Task #4721 G1 语义保留：用户往上翻时新内容不拽回底部。
    // ★ Task #5041 P3 Phase 1：这个语义现在由 **scrollbox 的 stickyScroll**
    //   原生承担（用户手动上滚 ⇒ `_hasManualScroll` ⇒ sticky 脱离底部）。
    //   这里的 `notifyContentAppended()` 只维护自管视口的**纯函数契约**
    //   （scroll-viewport.ts 的单测仍覆盖它）⇒ 保留但不再驱动渲染。
    scrollViewport.notifyContentAppended();
  };

  const pushAssistant = (content: string, continuation: boolean) => {
    commitHistory({ role: "assistant", content, id: `h${++counters.historyId}`, continuation });
  };
  const pushUser = (content: string) => {
    commitHistory({ role: "user", content, id: `h${++counters.historyId}` });
  };
  const pushTool = (content: string) => {
    commitHistory({ role: "tool", content, id: `h${++counters.historyId}` });
  };
  const commitTool = (info: ToolCallInfo) => {
    commitHistory({ role: "tool", content: "", tool: info, id: `h${++counters.historyId}` });
  };

  const width = () => process.stdout.columns ?? 80;

  /**
   * Task #4588：`envEvent` 必须一路传到 `streamHandleQuery`。
   *
   * ## 为什么这是「静默失效」而不是「报错」
   *
   * `emitUserTurnTrigger()` 用「`envEvent` 是否存在」判定用户轮 vs 通知轮：
   *   - 用户轮（envEvent undefined）→ emit 一条 trigger event（正确）
   *   - 通知轮（envEvent 有值）   → **绝不** emit（否则 notify → agent →
   *     delegate → notify 无限套娃）
   *
   * opentui 端口最初**从不传** envEvent ⇒ 通知轮也被当成用户轮 ⇒ 每轮通知
   * 都往 event_store 白写一条 trigger event，且 mergedContext.envEvent 被
   * 新 trigger 覆盖 ⇒ 上游 replyChannel 丢失 ⇒ 通知静默丢弃（无任何报错）。
   *
   * Ink 版 `RunTui.tsx` 的 `executeQuery(message, envEvent)` 就是这么做的，
   * 这里对齐。
   */
  const executeQuery = async (message: string, envEvent?: unknown) => {
    counters.processing += 1;
    // ★ Task #4721（交叉验证 MAJOR-2 修复）：**每一轮独立的**状态对象。
    //
    // 之前是组件级的 `let turnInterrupted` / `let turnProcessingReleased`
    // ⇒ 两轮并发时会互相清标记（详见 TurnState 的注释）。
    //
    // 现在：每轮创建自己的对象，只被那一轮的闭包捕获 ⇒ 跨轮物理上不可能
    // 互相影响。
    const turn: TurnState = { interrupted: false, processingReleased: false };
    activeTurns.add(turn);
    // Task #4278 片6 bugfix: the Solid port never called `stream.start()`, so
    // `status` never became "thinking" — the clickable thinking row could not
    // appear at all. (The React RunTui.tsx does this at line ~185.)
    stream.start();
    let assistantBlocks = 0;
    const pushAssistantBlock = (content: string) => {
      pushAssistant(content, assistantBlocks > 0);
      assistantBlocks += 1;
    };

    // Task #4396: usage of the LLM call that produced this assistant message.
    // The Ink port keeps it in a pending slot and flushes it as its own
    // transcript row once the turn settles.
    // Task #4994 (P4): the row carries the full meta line
    // (`Build · <model> · <duration>s · <tok/s> · cache …`),
    // so the turn is timed here and the model label rides along.
    const turnStartedAt = Date.now();
    let pendingUsage: UsageLike | undefined;
    const attachUsageToTurn = (usage: UsageLike) => {
      pendingUsage = usage;
    };
    const flushUsageFooter = () => {
      const usage = pendingUsage;
      pendingUsage = undefined;
      const durationMs = Date.now() - turnStartedAt;
      const text = formatMetaLine(
        { agent: "Build", model: props.model },
        usage,
        durationMs,
      );
      if (!text) return;
      // ★ role 必须是 "usage"（main 的 `tui/App.tsx` 用的就是这个）——
      //   它渲染成**不带标题的暗色脚注行**。若复用 "tool" 角色，会多出一个
      //   「Tool」标题行，与 main 的观感不一致。
      //   P4 起行内容是 opencode AssistantFooter 元信息
      //   （agent/model/时长/tok/s/cache）。
      commitHistory({
        role: "usage",
        content: text,
        id: `h${++counters.historyId}`,
      });
    };

    const findLiveIndex = (event: ToolStreamEvent): number => {
      if (event.id) {
        const byId = liveRef.findIndex((t) => t.key === event.id);
        if (byId >= 0) return byId;
      }
      return liveRef.findIndex((t) => t.info.name === event.name);
    };

    const handleToolEvent = (event: ToolStreamEvent) => {
      if (event.kind === "call") {
        const pending = stream.flushPending();
        if (pending.trim()) pushAssistantBlock(pending);
        const key = event.id ?? `${event.name}#${++toolSeq}`;
        liveRef.push({
          key,
          startedAt: Date.now(),
          info: { name: event.name, args: event.args, status: "running" },
        });
        syncLiveTools();
        return;
      }

      const idx = findLiveIndex(event);
      const entry = idx >= 0 ? liveRef[idx] : undefined;
      const durationMs = entry ? Date.now() - entry.startedAt : undefined;
      const info: ToolCallInfo =
        event.kind === "error"
          ? {
              name: event.name,
              args: entry?.info.args,
              status: "error",
              error: event.error ?? "tool failed",
              durationMs,
            }
          : {
              name: event.name,
              args: entry?.info.args,
              status: "completed",
              output: showToolResults() ? formatToolOutput(event.output) : undefined,
              durationMs,
            };
      if (idx >= 0) {
        liveRef.splice(idx, 1);
        syncLiveTools();
      }
      commitTool(info);
    };

    const settleLiveTools = (status: ToolCallInfo["status"], error?: string) => {
      if (liveRef.length === 0) return;
      for (const t of [...liveRef]) {
        commitTool({
          ...t.info,
          status,
          ...(error ? { error } : {}),
          durationMs: Date.now() - t.startedAt,
        });
      }
      liveRef.length = 0;
      syncLiveTools();
    };

    try {
      let responseText: string;
      if (props.streamHandleQuery) {
        responseText = await props.streamHandleQuery(
          message,
          (chunk) => {
            // ★ Task #4721 G2：被打断后**丢弃后续 chunk** ——
            //   否则「打断」只切了 UI 状态，LLM 的尾巴还会继续往动态区灌。
            if (turn.interrupted) return;
            stream.append(chunk);
            const stable = stream.drainStable();
            if (stable) pushAssistantBlock(stable);
          },
          showToolCalls() ? handleToolEvent : undefined,
          // Task #4396: usage sink (cache/token footer).
          attachUsageToTurn,
          // Task #4588: 触发事件必须透传 —— 通知轮靠它避免重复 emit。
          envEvent,
          // Task #4278 片6: reasoning deltas feed the clickable thinking block.
          (delta) => {
            if (turn.interrupted) return;
            stream.appendReasoning(delta);
          }
        );
        // ★ Task #4721 G2：被打断 ⇒ 不再提交尾巴（那是被用户明确放弃的内容）。
        if (!turn.interrupted) {
          const tail = stream.finish(responseText);
          if (tail.trim()) pushAssistantBlock(tail);
          flushUsageFooter();
        }
      } else {
        // ⚠️ The one-shot fallback does NOT take an envEvent (its signature is
        //   `handleQuery(message)`), so a notification round reaching this
        //   branch would arrive with envEvent === undefined — and
        //   `emitUserTurnTrigger` would then treat it as a USER turn and emit a
        //   spurious trigger event (the nesting guard would misfire).
        //
        //   Unreachable today: `commands/interactive.ts` always constructs
        //   `streamHandleQuery`, so this branch is dead code. Kept as a
        //   fallback for safety; the comment records the constraint so nobody
        //   later "fixes" it by adding a bogus envEvent argument.
        responseText = await props.handleQuery(message);
        stream.finish();
        const rendered = props.markdownEnabled
          ? renderMarkdown(responseText, { width: width() })
          : responseText;
        pushAssistantBlock(truncateForTerminal(rendered, maxLines()));
      }
      settleLiveTools("completed");
      counters.assistant += 1;
    } catch (err) {
      // ★ Task #4721 G2：被用户打断后，`streamHandleQuery` 抛出 abort 错误是
      //   **预期行为**（不是故障）⇒ 不要把它渲染成红色 Error 行，
      //   也不要给用户一个「出错了」的假象。
      if (turn.interrupted) {
        pushTool("⏹ 已打断");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        stream.fail(err instanceof Error ? err : new Error(msg));
        settleLiveTools("error", msg);
        setErrorMessage(msg);
        pushTool(`❌ Error: ${msg}`);
      }
    } finally {
      // ★ Task #4721（交叉验证 MAJOR-2 修复）：释放**本轮**的名额。
      //
      // 幂等由 `turn.processingReleased` 保证（打断时已释放过 ⇒ 不会重复减）。
      // ⚠️ 只清**本轮**的状态 ⇒ 不会误清并发轮次的打断标记。
      releaseProcessing(turn);
      activeTurns.delete(turn);
      // 打断标记随轮次对象一起消失 ⇒ 不需要额外重置。
    }
  };

  const doExit = () => {
    props.onExit?.();
  };

  const handleNotification = async (message: string, envEvent?: any) => {
    pushTool(`📢 ${message}`);
    // ★ Task #4588：envEvent 必须转发给 executeQuery —— 通知轮靠它判定
    //   「不要重复 emit trigger event」。丢了它 ⇒ 每轮通知都白写一条
    //   trigger event（无限套娃）+ mergedContext.envEvent 被覆盖。
    //   Ink 版 RunTui.tsx:470 的 `executeQueryRef.current(message, envEvent)`
    //   就是这么做的，这里对齐。
    await executeQuery(message, envEvent);
  };

  const isIdle = () => counters.processing === 0;

  /**
   * ★ Task #4588（端口到 opentui/Solid）：**仅显示、不驱动 agent** 的通知通道。
   *
   * ## 为什么必须有它
   *
   * EventHandler 的 telemetry 事件（`task.background.started` / `.progress`）
   * 语义是「只发一条提示，不进 lane、不跑 agent」。它们原本走
   * `telemetrySender` 的默认分支 `console.log` —— 但 opentui 独占 stdout 做
   * 整帧重绘，裸 `console.log` 会被排队/错序（Ink 链路实测打在 `/exit` 之后）。
   *
   * ## 为什么不复用 onNotification
   *
   * 那会触发 agent 再跑一轮 —— 等于把 telemetry 从「一条提示」升级成「一次
   * agent run」，直接违反 `TELEMETRY_EVENT_TYPES` 的白名单设计（而且会无限套娃）。
   *
   * ## 与 Ink 版 `RunTui.tsx` 的差异
   *
   * Ink 版用 `setHistory` 把通知塞进**响应式 history**；opentui 版的历史是
   * **write-once scrollback**（片4），所以这里走 `pushTool`（= `commitHistory`）
   * —— 语义等价（都进历史、都只显示一次），但不会在动态区 repaint 时被重放。
   *
   * ## 契约（重要）
   *
   * 必须 `return true` 表示「已接管并显示」：`commands/interactive.ts` 的
   * `dispatchInteractiveNotice` 用 `=== true` 判定；返回 undefined 会让同一条
   * 通知既画进 TUI **又**额外 `console.log` 一次。
   */
  const handleNotice = (text: string): boolean => {
    // 加 📢 前缀与普通通知行（handleNotification）视觉一致，
    // 避免两种通知在 TUI 里长得不一样却都挂 🔧 Tool 标签。
    pushTool(`📢 ${text}`);
    return true;
  };

  /**
   * ★ Task #5041 P3 Phase 1：处理一次滚轮（**两条路径共用**）。
   *
   * - **动态区**的滚轮 ⇒ opentui 原生 `onMouseScroll` 调这里；
   * - **历史区**的滚轮 ⇒ opentui 直接丢弃（`processSingleMouseEvent` 对
   *   `y < renderOffset` 返回 false）⇒ 由 `commands/interactive.ts` 用
   *   `prependInputHandlers` 拦原始序列后调这里。
   *
   * 两条路径走**同一段逻辑** ⇒ 行为完全一致。
   *
   * ## P3 Phase 1 之后：不再短路，而是**转调 scroll 模块**
   *
   * 旧行为（Task #4954 P0）：alternate-screen 下滚动由 scrollbox 原生接管，
   * 这里 `void direction` 短路 —— 滚轮事件到了却什么都不做（死代码）。
   *
   * 现在：把方向换算成**行数**（`scrollLinesForWheelEvent`），
   * 再对 scrollbox 做**相对滚动**（`scrollBy`）。
   *
   * ⚠️ **为什么不会与 scrollbox 原生滚动重复**：
   * 原生路径（scrollbox 自己的 `onMouseEvent`）已经滚过了；这里再滚一次
   * 就会**翻倍**。而根节点的 `onMouseScroll` 与 scrollbox 的处理在
   * opentui 里是**冒泡**关系（`processMouseEvent` 向 parent 冒泡）⇒
   * 同一个滚轮事件会**先**被 scrollbox 处理、**再**冒泡到根节点。
   *
   * ⇒ 因此这里必须**区分「谁已经处理过」**：
   * 只有当事件**没有**被 scrollbox 处理（即 scrollbox 不在事件路径上）
   * 才由我们补滚。用 `event.target` 判定（`MouseEvent.target` 是
   * 命中的 renderable，opentui 在 `sendMouseEvent` 时设置）。
   */
  const applyWheel = (
    direction: "up" | "down" | "left" | "right",
    /** 该滚轮事件的原始 target（opentui `MouseEvent.target`）——用于判定是否已被 scrollbox 处理。 */
    target?: unknown,
  ) => {
    // scrollbox 在事件路径上 ⇒ 它已经原生滚过了 ⇒ 不重复滚。
    if (scrollbox && target && isDescendantOf(target, scrollbox)) return;

    const lines = scrollLinesForWheelEvent({ direction });
    if (lines === 0) return;
    // scrollbox 还没挂上（首帧之前）⇒ 无处可滚。
    if (!scrollbox) return;
    scrollbox.scrollBy(direction === "up" ? -lines : lines);
  };

  // Register handlers once, synchronously at construction time (Solid components
  // run their body once, so this is the analogue of React's mount effect — and
  // it happens *before* any notification can be delivered because interactive.ts wires
  // the handlers after calling `render`).
  props.onRegisterHandlers?.({
    onNotification: handleNotification,
    onNotice: handleNotice,
    isIdle,
    onHistoryWheel: applyWheel,
  });

  const handleSubmit = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    // ★ Task #5109 P7 —— 斜杠命令走注册表（interactive 版）。
    const slashMatch = findSlashCommand(slashCommands, trimmed);
    if (slashMatch) {
      const result = slashMatch.spec.run(slashMatch.args);
      // ★ Task #5116 P7.1 —— 配置弹窗。
      if (result.kind === "open-dialog") {
        pushUser(trimmed);
        if (result.dialog === "connect") {
          await openConnectDialog();
        } else {
          await openModelDialog();
        }
        return;
      }
      if (result.kind === "exit") {
        pushUser(trimmed);
        pushTool("👋 Goodbye!");
        doExit();
        return;
      }
      if (result.kind === "handled") {
        if (result.message === CLEAR_SENTINEL) {
          setHistoryRows([]);
          setUserHistory([]);
          counters.user = 0;
          counters.assistant = 0;
          setErrorMessage(null);
          return;
        }
        pushUser(trimmed);
        pushTool(result.message);
        return;
      }
      if (result.kind === "unknown") {
        pushUser(trimmed);
        pushTool(`⚠ ${result.message}`);
        return;
      }
      if (result.kind === "set-max-lines") {
        setMaxLines(result.value);
        pushUser(trimmed);
        pushTool(`max-lines set to ${result.value}`);
        return;
      }
      // result.kind === "pass" 不应出现在注册表匹配里（注册表只匹配 /xxx）。
      // 但保留分支以防未来扩展。
    }

    // 非斜杠命令 → 走原有 run REPL 分发器（向后兼容 /history /workdir /max-lines）。
    const slashCtx: SlashContext = {
      model: props.model,
      workdir: props.workdir,
      maxLines: maxLines(),
      userTurnCount: counters.user,
      assistantTurnCount: counters.assistant,
    };
    const result = dispatchSlashCommand(trimmed, slashCtx);

    if (result.kind === "exit") {
      pushUser(trimmed);
      pushTool("👋 Goodbye!");
      doExit();
      return;
    }
    if (result.kind === "handled") {
      if (result.message === CLEAR_SENTINEL) {
        setHistoryRows([]);
        setUserHistory([]);
        counters.user = 0;
        counters.assistant = 0;
        setErrorMessage(null);
        return;
      }
      pushUser(trimmed);
      pushTool(result.message);
      return;
    }
    if (result.kind === "unknown") {
      pushUser(trimmed);
      pushTool(`⚠ ${result.message}`);
      return;
    }
    if (result.kind === "set-max-lines") {
      setMaxLines(result.value);
      pushUser(trimmed);
      pushTool(`max-lines set to ${result.value}`);
      return;
    }

    // result.kind === "pass" — treat as chat message
    setErrorMessage(null);
    pushUser(trimmed);
    setUserHistory((uh) => [trimmed, ...uh]);
    counters.user += 1;
    await executeQuery(trimmed);
  };

  return (
    <>
    <App
      history={historyRows()}
      status={stream.status()}
      model={runtimeModel()}
      workdir={props.workdir}
      streamingText={stream.streamingText()}
      thinkingText={stream.thinkingText()}
      liveTools={liveTools()}
      errorMessage={errorMessage() ?? undefined}
      // ★ Task #4954 P1：状态栏单一 hint 来源。
      //   idle → statusLabel="Build" + hint="ctrl+c exit"；
      //   working → statusLabel="esc interrupt" + hint=""（右段留空）。
      //   ⚠️ DS MINOR-3 设计注记：working 的 "esc interrupt"
      //   放**左段 statusLabel**（状态语义=当前可做的事），
      //   是有意设计；P2 若需右段提示可并行传 hint。
      statusLabel={stream.status() === "idle" ? "Build" : "esc interrupt"}
      hint={stream.status() === "idle" ? "ctrl+c exit" : ""}
      // ★ Task #5041 P3 Phase 1：滚轮 → **scrollbox 相对滚动**。
      //
      // 两条路径走**同一段逻辑**（`applyWheel`）：
      //   - **动态区**（scrollbox 内）⇒ opentui 原生滚动**已经**发生
      //     （scrollbox 自己的 `onMouseEvent` 处理过）⇒ 本回调是**冒泡**过来的
      //     ⇒ `applyWheel` 靠 `event.target` 判定后**不再重复滚**；
      //   - **历史区** ⇒ opentui 丢弃 ⇒ 由 `commands/interactive.ts` 的
      //     `prependInputHandlers` 拦截原始序列后调 `applyWheel`（target 为空
      //     ⇒ 由我们补滚）。
      onMouseScroll={(event: any) => {
        const direction = event?.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        applyWheel(direction, event?.target);
      }}
      // ★ Task #5041 P3 Phase 1：抓住消息区 scrollbox 的实例。
      onScrollboxRef={(node: ScrollBoxRenderable) => {
        scrollbox = node;
      }}
    >
      {/* ★ Task #4721 G3（锚定）：**输入框常驻**，不再随 status 挂载/卸载。
       *
       * ## 为什么
       *
       * 原来这里是：
       *   <Show when={status === "idle"}>  <TextInput/>  </Show>
       *   <Show when={status !== "idle"}> ⠿ working…      </Show>
       * ⇒ **流式期间 `<TextInput>` 被卸载** ⇒ 输入框**整个消失**（不是漂移），
       *   用户只看到 `⠿ working…` 那一行 ⇒ 「输入框无法锚定到底部」。
       *
       * 现在：**输入框永远挂载**，且永远是动态区的**最后一行** ⇒ 恒贴底、
       * 恒可见。
       *
       * ## 为什么提示在输入框**上面**
       *
       * 「working…」提示必须排在输入框**之前**，否则输入框就不是最后一行
       * ⇒ 「贴底」不成立。提示只占 1 行 ⇒ 流式态下输入框比空闲态低 1 行，
       * 那是**新增内容**造成的正常位移（且输入框始终可见）。
       *
       * ⚠️ 为什么不用一个 `<Show>` 包住两者？
       *   `when={stream.status() === "idle"}` 里的 `status()` 在 Bun 内置
       *   （急求值）JSX 转换下是**创建时求值一次**的静态 boolean ⇒ 用它做
       *   条件挂载 = 输入框在第一帧之后再也不出现。拆成两个独立分支后，
       *   每个分支各自求值一次，切换交给 Solid 运行时。
       */}
      {/* ★ Task #5116 P7.1 —— 输入框（children 槽，App 底部区）。 */}
      <box style={{ marginTop: 1 }}>
        <TextInput
          label="You"
          prefix="👤"
          placeholder="Type a message…"
          history={userHistory()}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          slashCommands={slashCommands}
          // ★ Task #5116 P7.1 —— 弹窗打开 ⇒ 输入框让位（不消费任何键）。
          keyGate={() => dialogState() !== null}
          onSlashCommand={(cmd) => {
            void handleSubmit(cmd);
          }}
          onSlashPaletteChange={(open) => {
            setSlashPaletteOpen(open);
          }}
          onKeyConsumed={() => {
            consumedGeneration += 1;
          }}
        />
      </box>
    </App>
      {/* ★ Task #5116 P7.1 —— 配置弹窗（`<App>` 的**兄弟节点** ⇒
          absolute 相对全屏根容器定位，见下方根因注释）。
       *
       * ## 为什么（真终端黑屏根因，Task #5116 定音）
       *
       * 弹窗原来作为 App 的 children 传入 ⇒ 落进 App 底部区的
       * `<box flexShrink={0}>`（实测 geo=[0,29,100,3]，高 3 行）。
       * Dialog 的 `position:absolute` 是**相对该父容器**定位的：
       * y 偏移把它推到 geo=[20,31,60,5] —— y 31 起、屏幕仅 32 行
       * ⇒ 弹窗 5 行**全部在屏幕外**。（Solid 树里 Dialog 及其内部
       * Show 全部执行了——纯布局问题，不是响应式断点。）
       *
       * 修复（复刻 opencode DialogProvider 结构，app.tsx:425）：
       * 弹窗作为 `<App>` 的兄弟节点渲染。
       */}
      <Show when={dialogState()}>
        {(dlg) => (
          <Dialog
            title={dlg().kind === "connect"
              ? (dlg().mode === "form" ? "Add a provider" : "Connect a provider")
              : "Select default model"}
            visible={true}
            items={dlg().mode === "form" ? [] : dialogItems()}
            selectedIndex={dlg().selectedIndex}
            hint={dlg().mode === "form"
              ? "Enter next/submit · Esc cancel"
              : "↑↓ move · Enter select · Esc close"}
            form={dlg().mode === "form"
              ? { mode: "form", fieldIndex: dlg().fieldIndex, fields: dlg().fields }
              : undefined}
          />
        )}
      </Show>
    </>
  );
}

export default RunScreenSolid;
