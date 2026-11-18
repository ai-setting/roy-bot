/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview App — Solid root component for the `roy-bot interactive` TUI.
 *
 * Forked from `tui/App.tsx` (Ink/React) for Task #4278 (片1 地基; 片2 layout).
 *
 * Composition (mirrors the Ink App):
 *   ┌──────────────────────────────────────┐
 *   │  Header banner                        │
 *   │  history (static region)              │
 *   │  Spinner   when status=thinking       │
 *   │  streaming markdown when streaming    │
 *   │  live tool cards                      │
 *   │  ──────────────────────────────────── │
 *   │  StatusBar                            │
 *   └──────────────────────────────────────┘
 *
 * ⚠️ 片2 measured fixes:
 *   1. **Eager `<Show>` children.** bun's Solid JSX transform builds the child
 *      element *before* `<Show>` decides, so `<ToolCall info={item.tool!}/>`
 *      used to run with `tool === undefined` for every non-tool row
 *      (`TypeError: … 'props.info.name'`). Conditional children now use the
 *      **function** form (`{() => …}`), which restores laziness. See ToolCall.
 *   2. **Border styles.** Ink's `borderStyle="round"` is opentui's `"rounded"`;
 *      Ink's default is a *square* border and opentui's default is `"single"`,
 *      which is why the banner looked "rounded" for free in 片1.
 *   3. **Colours** go through `fg()` so the NO_COLOR `""` sentinel never becomes
 *      magenta.
 *
 * ⚠️ 片6 (Task #4278) — **thinking block is clickable**:
 *   The `status === "thinking"` row is now a `<ThinkingBlock>`: clicking it
 *   (opentui `onMouseUp`) toggles an expanded region that streams the model's
 *   reasoning text. Keyboard fallback: `t`. The expanded region is part of the
 *   **dynamic footer** (not history), so it never breaks the 片4 write-once
 *   scrollback contract.
 *
 * ⚠️ R1 (`<Static>` replacement) is **not** in this file — history still lives
 * inside the frame here; 片4 lifts committed rows into
 * `renderer.writeToScrollback()` (`screenMode: "split-footer"`), which is the
 * mode `commands/interactive.ts` already creates. Keeping the two concerns separate
 * makes "layout is correct" verifiable in isolation.
 */

import { createSignal, For, Show } from "solid-js";
import { TextAttributes, type KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { Markdown } from "./Markdown.js";
import { Spinner } from "./Spinner.js";
import { StatusBar } from "./StatusBar.js";
import { ToolCall } from "./ToolCall.js";
import { createScrollAcceleration, type ScrollAcceleration } from "./scroll.js";
import {
  computeScrollbarVisible,
  resolveScrollbarColors,
  resolveScrollbarPadding,
  resolveViewportPaddingRight,
} from "./scrollbar.js";
import type { ToolCallInfo } from "../tui/tool-call.js";
import { fg, useTuiThemeReactive } from "./theme.js";

export type Role = "user" | "assistant" | "tool" | "usage";

export interface HistoryItem {
  role: Role;
  content: string;
  /** opencode-style tool card payload (when role === "tool"). */
  tool?: ToolCallInfo;
  /** Marks a block continuing the same assistant message (no repeated heading). */
  continuation?: boolean;
  /** Stable identifier for reconciliation. */
  id?: string;
}

export type AppStatus = "idle" | "thinking" | "streaming";

export interface AppProps {
  /** Completed messages to render in the static region. */
  history: HistoryItem[];
  /** Current dynamic state. */
  status: AppStatus;
  /** Model identifier for the status bar. */
  model?: string;
  /** Working directory for the status bar. */
  workdir?: string;
  /** Live streaming text (shown only when status=streaming). */
  streamingText?: string;
  /** Tool calls currently executing (dynamic region). */
  liveTools?: ToolCallInfo[];
  /** Token count for the status bar. */
  tokenCount?: number;
  /**
   * Task #4278 片6 — accumulated model reasoning text, revealed by clicking
   * the "Agent is thinking…" row.
   */
  thinkingText?: string;
  /** Error banner (shown under the input row). */
  errorMessage?: string;
  /** ★ Task #4954 P1：状态栏左段标签（Build / esc interrupt）。
   *  ⚠️ 命名不得叫 status——App.status 是 AppStatus 契约
   *  （thinking/streaming 分支依赖），DS review 抓到撞车。 */
  statusLabel?: string;
  /** ★ Task #4954 P1：状态栏右段快捷键提示（单一来源）。 */
  hint?: string;
  /**
   * ★ Task #4721 G1（滚动）：根节点接收**滚轮**事件。
   *
   * opentui 的滚轮事件只派发给 `hitTest` 命中的 renderable
   * （chunk-node-2rg7pskw.js:23313-23325），命中不到就**直接吞掉** ⇒
   * 必须有一个节点**常驻**地声明 `onMouseScroll`。
   *
   * 挂在**根 box** 上：命中子节点时 opentui 会向 parent 冒泡
   * （:12347）⇒ 无论滚轮落在哪儿，根节点都是最终接收者。
   */
  onMouseScroll?: (event: { scroll?: { direction?: string; delta?: number } }) => void;
  /**
   * ★ Task #5041 P3 Phase 1：scrollbox 的**滚轮步进**加速器。
   *
   * opentui 0.6.6 默认用 `LinearScrollAccel`（`tick()` 恒返回 1）⇒ 1 行/档，
   * 回看长对话历史时非常慢。本 prop 传入自定义实现（默认 3 行/档，
   * 对齐 opencode 的 `CustomSpeedScroll(3)`）。
   *
   * ⚠️ 不传 ⇒ 退回 opentui 默认（1 行/档）。
   */
  scrollAcceleration?: ScrollAcceleration;
  /**
   * ★ Task #5041 P3 Phase 1：**scrollbox 实例**的回调钩子。
   *
   * 用途：
   *   - 生产侧：`RunScreen` 需要它来读 `scrollTop` / 调 `scrollTo`
   *     （sticky 自动跟随、跳到底等）；
   *   - 测试侧：让集成测试拿到**确定的那个** scrollbox 实例
   *     （而不是遍历全局注册表去猜）。
   */
  onScrollboxRef?: (node: ScrollBoxRenderable) => void;
  /** Optional input slot rendered under the transcript while idle. */
  children?: unknown;
}

/**
 * ★ Task #5041 P3 Phase 1：模块级的**默认**滚轮步进加速器。
 *
 * 放在模块作用域（而非组件体内）⇒ 整个进程共用一个实例 ⇒
 * 多个 `<App>` 挂载时也不会各自新建；且 opentui 的 `scrollAccel` 引用稳定。
 */
const defaultScrollAcceleration = createScrollAcceleration();

const ROLE_PREFIX: Record<Role, string> = {  // Task #4994 (P4): plain-text role tags. The emoji prefixes
  // (👤/🤖/🔧) rendered inconsistently across terminal fonts —
  // opencode's own labels are text (`Build` / `You`), and the
  // plan §P4 mandates text tags with colour carrying the role.
  user: "You",
  assistant: "Agent",
  tool: "Tool",
  // Task #4396: the usage footer row has **no** heading — it renders as a
  // bare dim grey line under the assistant message (matches main's Ink port,
  // where `role: "usage"` renders `<UsageFooter/>` without a RoleLabel).
  usage: "",
};

function RoleLabel(props: { role: Role }) {
  const theme = useTuiThemeReactive();
  const color = () =>
    props.role === "user"
      ? theme.user
      : props.role === "assistant"
        ? theme.assistant
        : theme.tool;
  return (
    <text style={{ fg: fg(color()), attributes: TextAttributes.BOLD }}>
      {ROLE_PREFIX[props.role]}
    </text>
  );
}

/**
 * Task #4994 (P4) — the user message block, opencode
 * UserMessage parity (packages/tui .../index.tsx `UserMessage`):
 *
 *   - a **left rail** (`border=["left"]`, coloured with the
 *     user hue) marking the block;
 *   - a **raised panel background** (`theme.backgroundPanel`)
 *     separating the user's words from assistant output;
 *   - the RoleLabel row + indented body inside.
 */
export function UserMessageBlock(props: { content: string }) {
  const theme = useTuiThemeReactive();
  return (
    <box
      style={{
        flexDirection: "column",
        marginBottom: 1,
      }}
      border={["left"]}
      borderColor={fg(theme.borderUser)}
      backgroundColor={fg(theme.backgroundPanel)}
    >
      <box style={{ marginLeft: 2 }}>
        <RoleLabel role="user" />
      </box>
      <box style={{ marginLeft: 2 }}>
        <text style={{ fg: fg(theme.text) }}>{props.content}</text>
      </box>
    </box>
  );
}

export function HistoryEntry(props: { item: HistoryItem }) {
  const theme = useTuiThemeReactive();

  // Task #4396: usage is a standalone dim grey footer row — its own history
  // item, because committed history is write-once (a row already committed
  // can never be repainted). Mirrors the Ink port's `role: "usage"` branch:
  // a bare dim line with **no** role heading.
  //
  // Implemented as an early return rather than another `<Show>` level: the
  // Solid `<Show>` overloads in this repo are typed against the ROOT tsconfig
  // (React JSX), so each extra nesting level adds a TS2769 (pre-existing
  // category in this file — see the 11 baseline errors). An early return keeps
  // the JSX depth unchanged.
  if (props.item.role === "usage") {
    return (
      <box style={{ flexDirection: "column", marginBottom: 1 }}>
        <box style={{ marginLeft: 2 }}>
          <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
            {props.item.content}
          </text>
        </box>
      </box>
    );
  }

  return (
    // ⚠️ children MUST be functions here (片2 fix — see file header).
    <Show
      when={props.item.role === "tool"}
      fallback={() => (
        <Show
          when={props.item.role === "user"}
          fallback={() => (
            <box style={{ flexDirection: "column", marginBottom: 1 }}>
              <Show when={!props.item.continuation}>{() => <RoleLabel role="assistant" />}</Show>
              <box style={{ marginLeft: 2 }}>
                <Markdown text={props.item.content} />
              </box>
            </box>
          )}
        >
          {() => (
            // Task #4994 (P4): user messages render as a
            // rail + panel block (opencode UserMessage parity).
            <UserMessageBlock content={props.item.content} />
          )}
        </Show>
      )}
    >
      {() => (
        <Show
          when={props.item.tool}
          fallback={() => (
            <box style={{ flexDirection: "column", marginBottom: 1 }}>
              <RoleLabel role="tool" />
              <box style={{ marginLeft: 2 }}>
                <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
                  {props.item.content}
                </text>
              </box>
            </box>
          )}
        >
          {() => <ToolCall info={props.item.tool!} />}
        </Show>
      )}
    </Show>
  );
}

/**
 * Task #4278 片6 — the clickable "thinking" row + its expandable reasoning body.
 *
 * Owns its own `expanded` signal so the toggle is local (a click never has to
 * round-trip through RunScreen). The **same `<box>` that carries `onMouseUp`**
 * also renders the whole row, so the entire row is the click target — matching
 * the PoC that was verified against a real pty (Task #4278 片0).
 *
 * Keyboard fallback (`t`) is registered on the global key bus via
 * `useKeyboard`, mirroring the PoC's `renderer.keyHandler`. It stays active for
 * as long as the block is mounted (i.e. while `status === "thinking"`).
 */
export function ThinkingBlock(props: {
  /** Streamed reasoning text (may still be growing). */
  text?: string;
}) {
  const theme = useTuiThemeReactive();
  const [expanded, setExpanded] = createSignal(false);

  const toggle = () => setExpanded((v) => !v);

  // Keyboard fallback: `t` toggles, matching the PoC + the inline hint.
  useKeyboard((key: KeyEvent) => {
    if (key.name === "t" && !key.ctrl && !key.meta) toggle();
  });

  const hasText = () => (props.text ?? "").length > 0;

  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      {/* Whole row is the click target (mouse) — 片0 PoC-verified pattern. */}
      <box onMouseUp={toggle} style={{ flexDirection: "row" }}>
        <Spinner label="Agent is thinking..." />
        <text style={{ fg: fg(theme.muted), attributes: TextAttributes.DIM }}>
          {expanded() ? "  ▾ (click to collapse · t)" : "  ▸ (click to expand · t)"}
        </text>
      </box>

      <Show when={expanded()}>
        {() => (
          <box style={{ flexDirection: "column", marginLeft: 2 }}>
            <Show
              when={hasText()}
              fallback={() => (
                <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>（waiting for reasoning…）</text>
              )}
            >
              {() => (
                <text style={{ fg: fg(theme.muted) }}>{props.text ?? ""}</text>
              )}
            </Show>
          </box>
        )}
      </Show>
    </box>
  );
}

export function App(props: AppProps) {
  const theme = useTuiThemeReactive();
  const liveTools = () => props.liveTools ?? [];
  /**
   * ★ Task #5041 P3 Phase 1：scrollbox 的滚轮步进加速器。
   *
   * 在组件体内创建**一次**（Solid 的函数体只跑一次）⇒ 实例稳定，
   * 不会每次重渲染都换对象（换对象会重置 opentui 的 `scrollAccel` 引用）。
   *
   * 显式传 `props.scrollAcceleration` 时以调用方为准（便于测试注入）。
   */
  const scrollAcceleration = () => props.scrollAcceleration ?? defaultScrollAcceleration;

  // -----------------------------------------------------------------
  // ★ Task #5077 P3 Phase 2：滚动条（对齐 opencode 双通道滚动的视觉通道）
  //
  // opentui `<scrollbox>` 支持内建纵向滚动条，但默认关闭。
  // 对齐 opencode routes/session/index.tsx:1508-1517：
  //   viewportOptions={{ paddingRight: 1 }}
  //   verticalScrollbarOptions={{ paddingLeft: 1, trackOptions: {…} }}
  //
  // - 内容不足一屏时 opentui 原生隐藏
  //   （ScrollBarRenderable.recalculateVisibility：
  //    scrollSize <= viewportSize ⇒ visible=false）⇒ 无需手动开关。
  // - 内容高度是 renderable 的运行时状态，App 层拿不到
  //   响应式信号 ⇒ `computeScrollbarVisible` 不在渲染路径里
  //   调用（那是测试/守卫用的），这里交给 opentui 原生行为。
  // -----------------------------------------------------------------
  const scrollbarPadding = resolveScrollbarPadding();
  // Task #5086 P5：滚动条配色走 token（`backgroundElement` 底 / `borderActive` 前景）。
  // NO_COLOR 模式下 token 是 "" —— **不能**把 "" 传给 opentui
  // （parseColor("") → 品红 + 每帧 "Invalid hex color" 告警，DS r3 MAJOR-1）。
  // 这里传 undefined，让 resolveScrollbarColors 内部回落到 dark 默认常量。
  const scrollbarColors = resolveScrollbarColors({
    backgroundColor: theme.backgroundElement || undefined,
    foregroundColor: theme.borderActive || undefined,
  });
  // 让位量随滚动条间距走（1 列），内容不会压到滚动条列。
  const viewportPaddingRight = resolveViewportPaddingRight(scrollbarPadding);

  return (
    <box
      style={{ flexDirection: "column", backgroundColor: fg(theme.background) }}
      onMouseScroll={props.onMouseScroll}
      // ★ Task #4721 G1（滚动）：让根节点**可获焦**。
      //
      // ## 为什么必须 focusable
      //
      // opentui 的滚轮派发（`chunk-node-2rg7pskw.js:23313-23325`）：
      //
      // ```js
      // if (mouseEvent.type === "scroll") {
      //   const maybeRenderableId = this.hitTest(mouseEvent.x, mouseEvent.y);
      //   const maybeRenderable = Renderable.renderablesByNumber.get(maybeRenderableId);
      //   const fallbackTarget = this._currentFocusedRenderable … focused ? … : null;
      //   const scrollTarget = maybeRenderable ?? fallbackTarget;
      //   if (scrollTarget) { …sendMouseEvent(scrollTarget, event) }
      //   return true;                       // ← 无 target 时**直接吞掉**
      // }
      // ```
      //
      // 而 `hitTest` 用的是 **scene 坐标**：split-footer 模式下 scene 只有
      // **footer 高度**（12 行）那么高 ⇒ 终端**底部**的指针（真实用户滚动的
      // 位置）换算成 scene 行号后**超出 scene** ⇒ **miss** ⇒ 事件被吞掉。
      //
      // ⇒ 唯一能让滚轮「在任何位置都有效」的办法是走 **fallback 分支**：
      // 让承载 `onMouseScroll` 的节点成为 **focused renderable**。
      //
      // `focused` 是 opentui/solid 支持的 prop（solid reconciler 的
      // `setProperty` 对它调 `node.focus()`）；`focusable` 必须先置 true，
      // 否则 `focus()` 会直接 return（`Renderable.focus()` 第一行就检查
      // `this._focusable`）。
      focusable
      focused
    >
      {/* ★ Task #4954 P0：消息区 = scrollbox（flexGrow=1 占满），底部区 flexShrink=0 沉底。
          对齐 opencode routes/session/index.tsx:1501-1580 的三段式：
            <box flexGrow=1><scrollbox>…rows…</scrollbox></box>
            <box flexShrink=0>…Jump/Status…</box>
            <box flexShrink=0>…Composer…</box>
          alternate-screen 全屏接管后 renderer 不再有 footerHeight 概念，
          「输入框锚定」完全由 flex 层保证。 */}
      <box flexGrow={1} minHeight={0} style={{ flexDirection: "column" }}>
        <scrollbox
          flexGrow={1}
          minHeight={0}
          stickyScroll
          stickyStart="bottom"
          // ★ Task #5041 P3 Phase 1：滚轮每档 3 行（默认 opentui 是 1 行）。
          //   `tick()` 的返回值 **就是** 最终滚动行数（opentui 的 MouseParser
          //   恒发 `delta: 1` ⇒ scrollAmount = 1 × tick()）。
          scrollAcceleration={scrollAcceleration()}
          // ★ Task #5077 P3 Phase 2：右侧滚动条（opencode 同款配色 + 让位）。
          viewportOptions={{ paddingRight: viewportPaddingRight }}
          verticalScrollbarOptions={{
            paddingLeft: scrollbarPadding,
            trackOptions: {
              backgroundColor: scrollbarColors.backgroundColor,
              foregroundColor: scrollbarColors.foregroundColor,
            },
          }}
          // ★ Task #5041 P3 Phase 1：把 scrollbox 实例交给调用方
          //   （生产：RunScreen 读 scrollTop / 调 scrollTo；
          //     测试：断言真实的滚动行为，不用遍历全局注册表去猜）。
          ref={(node: ScrollBoxRenderable) => props.onScrollboxRef?.(node)}
        >
          {/* Header banner 保持在 scrollbox 首行（对话长了往上滚仍可见历史起点） */}
          <box
            style={{
              flexDirection: "row",
              borderStyle: "rounded",
              borderColor: fg(theme.primary),
              paddingX: 1,
              marginBottom: 1,
            }}
          >
            <text style={{ fg: fg(theme.primary), attributes: TextAttributes.BOLD }}>
              🚀 Roy Agent
            </text>
            <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}> — interactive TUI</text>
          </box>

          {/* History rows（P0：替代 write-once scrollback） */}
          <For each={props.history}>{(item) => <HistoryEntry item={item} />}</For>

          {/* Dynamic region — 片6: clickable thinking block */}
          <Show when={props.status === "thinking" || (props.status === "streaming" && !!props.thinkingText)}>
            {() => <ThinkingBlock text={props.thinkingText} />}
          </Show>
          <Show when={props.status === "streaming"}>
            {() => (
              <Show
                when={props.streamingText}
                fallback={() => (
                  <box style={{ marginBottom: 1 }}>
                    <Spinner label="Generating response..." />
                  </box>
                )}
              >
                {() => (
                  <box style={{ flexDirection: "column", marginBottom: 1 }}>
                    <RoleLabel role="assistant" />
                    <box style={{ marginLeft: 2 }}>
                      <Markdown text={props.streamingText ?? ""} />
                    </box>
                  </box>
                )}
              </Show>
            )}
          </Show>

          {/* Live (running) tool cards */}
          <Show when={liveTools().length > 0}>
            {() => (
              <box style={{ flexDirection: "column" }}>
                <For each={liveTools()}>{(tool) => <ToolCall info={tool} />}</For>
              </box>
            )}
          </Show>
        </scrollbox>
      </box>

      {/* 底部区（flexShrink=0 常驻沉底）：状态栏 + 输入框 + 错误 */}
      <box flexShrink={0} style={{ flexDirection: "column" }}>
        <StatusBar model={props.model} workdir={props.workdir} tokenCount={props.tokenCount} status={props.statusLabel} hint={props.hint} />

        {/* Input slot (RunScreen passes the prompt / working hint here) */}
        {props.children as never}

        <Show when={props.errorMessage}>
          {() => (
            <box style={{ marginTop: 1 }}>
              <text style={{ fg: fg(theme.error) }}>{`⚠ ${props.errorMessage}`}</text>
            </box>
          )}
        </Show>
      </box>
    </box>
  );
}

export default App;
