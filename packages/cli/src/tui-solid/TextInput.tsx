/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview TextInput — Solid single-line input with history navigation.
 *
 * Forked from `tui/TextInput.tsx` (Ink/React) for the `roy-bot interactive`
 * chain (Task #4278, 片1). The Ink original was renamed to
 * `tui/TextInput.compat.tsx` in Task #4688 (it had become an orphan).
 *
 * The editing state machine (`editReducer` / `splitAtCursor` in
 * `tui-solid/text-input-editing.ts`, a 片3 fork of `tui/text-input-editing.ts`).
 * the React/Ink rendering + input plumbing:
 *
 *   Ink                                    opentui/solid
 *   -------------------------------------- ------------------------------------
 *   useReducer(editReducer)                createStore / createSignal + reducer
 *   useInput((input, key) => …)            useKeyboard((key: KeyEvent) => …)
 *   key.return / key.backspace/leftArrow…  key.name === "return" / "backspace" …
 *   <Text inverse>▌</Text>                 <text style={{ bg, attributes: INVERSE }}>
 *
 * KeyEvent mapping notes (measured from @opentui/core parse.keypress):
 *   - Enter      → name === "return"
 *   - Backspace  → name === "backspace"
 *   - ←/→/↑/↓    → name === "left" / "right" / "up" / "down"
 *   - printable  → `sequence` carries the raw text; `name` is the char
 *   - Ctrl-C     → ctrl === true && name === "c"
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { TextAttributes, type KeyEvent } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/solid";
import { editReducer, splitAtCursor } from "./text-input-editing.js";
import type { TextEdit, EditAction } from "./text-input-editing.js";
import { fg, useTuiThemeReactive } from "./theme.js";
import { SlashPalette } from "./SlashPalette.js";
import {
  initialSlashPaletteState,
  slashPaletteReducer,
  slashTriggerQuery,
  type SlashPaletteState,
} from "./slash-palette-state.js";
import {
  matchSlashCommands,
  findSlashCommand,
  type SlashCommandSpec,
} from "./slash-registry.js";
import {
  normalizePaste,
  shouldFoldPaste,
  foldedPlaceholder,
  expandPastedPlaceholders,
  type PastedPart,
} from "./paste.js";

export interface TextInputProps {
  /** Prompt label shown before the input. */
  label: string;
  /** Optional prefix character (e.g. "👤"). */
  prefix?: string;
  /** Called with the entered text when Enter is pressed. */
  onSubmit: (value: string) => void;
  /** Called when the user presses Ctrl+C. */
  onCancel?: () => void;
  /** Placeholder shown when value is empty. */
  placeholder?: string;
  /**
   * Past submitted values, most recent first. ↑ walks back, ↓ walks
   * forward. The current draft is preserved when entering history mode.
   */
  history?: string[];
  /**
   * Task #5109 P7 —— 斜杠命令注册表。
   * 传入后，输入框首字符 `/` 触发补全面板；不传入则无面板（向后兼容）。
   */
  slashCommands?: SlashCommandSpec[];
  /**
   * Task #5109 P7 —— 面板选中命令时回调（Enter 直接执行 / Tab 补全后执行）。
   * 返回 `false` = **不执行**（调用方拒绝处理 ⇒ 输入框保留该命令文本）。
   */
  onSlashCommand?: (command: string) => void | false;
  /**
   * Task #5109 P7 —— 面板打开/关闭时通知外部（RunScreen 用来抑制 ESC 打断）。
   */
  onSlashPaletteChange?: (open: boolean) => void;
  /**
   * ★ Task #5109 P7（DS r2 MINOR-2）—— **本次按键是否已被输入框消费**。
   *
   * ## 为什么需要
   *
   * `useKeyboard` 的回调**没有「消费」语义**（不像 DOM 的 preventDefault）——
   * 同一个 Escape 会被**所有**注册过的 handler 各看一遍：
   *   - TextInput 的 handler：面板打开 ⇒ 关面板；
   *   - RunScreen 的 handler：流式中 ⇒ 打断。
   *
   * 之前靠「父组件先注册 ⇒ 先执行」**侥幸**正确（RunScreen 先跑，
   * 此时 `slashPaletteOpen()` 还是 true ⇒ 跳过打断；然后 TextInput 关面板）。
   * 一旦注册顺序变化，RunScreen 就会读到已置 false 的 flag ⇒ **误打断流式**。
   *
   * ## 契约（与注册顺序无关）
   *
   * TextInput 消费某个键时调用 `onKeyConsumed()`；
   * RunScreen 收到通知 ⇒ 递增「已消费代次」；
   * RunScreen 处理 Escape 时**延迟到微任务**再判定 ⇒ 那时所有 handler
   * 都已跑完 ⇒ 代次已更新 ⇒ 「本次 Escape 被面板消费」可被准确识别。
   */
  onKeyConsumed?: () => void;
  /**
   * ★ Task #5116 P7.1 —— **键盘门**：返回 true 时输入框不消费任何键
   * （配置弹窗独占键盘）。useKeyboard 回调最开头判定 ⇒
   * 与 P7 的「消费语义靠通知」契约互补：这里是**结构性让位**，
   * 不需要弹窗与输入框再协商。
   */
  keyGate?: () => boolean;
}

export function TextInput(props: TextInputProps) {
  const theme = useTuiThemeReactive();
  // Task #4103: value + caret live in one state so they always update together.
  const [state, setState] = createSignal<TextEdit>({ value: "", cursor: 0 });
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [draft, setDraft] = createSignal("");
  // Task #4954 P2: remembered pastes. When a big paste folds, the
  // placeholder goes into the buffer and the full text is remembered
  // here; Enter expands every remembered part before submitting.
  const [pastedParts, setPastedParts] = createSignal<PastedPart[]>([]);
  // Task #5109 P7: slash palette state.
  const [paletteState, setPaletteState] = createSignal<SlashPaletteState>(
    initialSlashPaletteState(),
  );

  const dispatch = (action: EditAction) => {
    setState((s) => editReducer(s, action));
  };

  // Sync palette with input value.
  const syncPalette = (value: string) => {
    if (!props.slashCommands || props.slashCommands.length === 0) return;
    const query = slashTriggerQuery(value);
    setPaletteState((s) => slashPaletteReducer(s, { type: "trigger", query }));
    props.onSlashPaletteChange?.(query !== null);
  };

  // Get filtered commands for the panel（带匹配方式，见 matchSlashCommands）。
  const filteredCommands = () => {
    if (!props.slashCommands) return [];
    return matchSlashCommands(props.slashCommands, paletteState().query);
  };

  /**
   * ★ Task #5109 P7（DS r3 MAJOR-1）—— Enter 的**精确匹配优先**判定。
   *
   * ## 回归背景
   *
   * 面板用「描述子串」过滤 ⇒ 用户敲 `/history` 时，
   * `/clear` 的描述 "Clear conversation history" 命中 "history" ⇒
   * 面板只剩 `/clear` 且高亮它 ⇒ Enter **静默清空了会话历史**
   * （语义完全相反），而 `slash.ts` 的既有 `/history` / `/workdir` 命令
   * 被彻底吞掉。
   *
   * ## 修法
   *
   * Enter 时先按**精确名字/别名**匹配（不靠描述）：
   *   - 命中 ⇒ 执行该命令（用户明确敲了完整名字）；
   *   - 未命中且面板有高亮项 ⇒ 执行高亮项（模糊匹配场景，如 `/he`）；
   *   - 都没命中 ⇒ **回退提交原文**（`/zzz` 之类当作普通输入，
   *     由 RunScreen 的 legacy 分发器接手）。
   */
  const exactMatch = (): SlashCommandSpec | null => {
    const raw = state().value.trim();
    if (!raw) return null;
    const hit = findSlashCommand(props.slashCommands ?? [], raw);
    return hit?.spec ?? null;
  };

  // Select the highlighted command (Enter / Tab).
  const selectSlashCommand = (execute: boolean) => {
    const commands = filteredCommands();
    // ★ DS r3 MAJOR-1：精确匹配优先（避免描述匹配劫持既有命令）。
    const exact = execute ? exactMatch() : null;
    const highlighted = commands[paletteState().selectedIndex];
    // 只有**名字命中**的高亮项才可执行；描述命中的 ⇒ 提交原文
    // （`/history` 会命中 `/clear` 的描述 ⇒ 执行它会清空历史）。
    const selected =
      exact ??
      (highlighted && highlighted.match === "name" ? highlighted.spec : null);
    if (!selected) {
      // 没有任何可执行项 ⇒ 回退提交原文（让 legacy 分发器接手）。
      if (execute) {
        const raw = state().value.trim();
        dispatch({ type: "clear" });
        setPaletteState(initialSlashPaletteState());
        props.onSlashPaletteChange?.(false);
        if (raw) props.onSubmit(raw);
      }
      return;
    }
    const text = `/${selected.name}`;
    if (execute) {
      // Enter: execute immediately.
      dispatch({ type: "clear" });
      setPaletteState(initialSlashPaletteState());
      props.onSlashPaletteChange?.(false);
      // ★ Task #5109 P7（DS r1 MINOR-2）：`onSlashCommand` 返回 false
      // 表示「命令已处理，**不要**再走默认提交流程」——
      // 调用方若拒绝执行，输入框已被清空，这里把值还回去。
      const handled = props.onSlashCommand?.(text);
      if (handled === false) {
        dispatch({ type: "set", value: text });
      }
    } else {
      // Tab: insert command + space, keep editing.
      dispatch({ type: "set", value: `${text} ` });
      setPaletteState(initialSlashPaletteState());
      props.onSlashPaletteChange?.(false);
    }
  };

  // Reset the history cursor whenever the caller appends new history rows.
  onMount(() => {
    let lastLen = props.history?.length ?? 0;
    const timer = setInterval(() => {
      const len = props.history?.length ?? 0;
      if (len !== lastLen) {
        lastLen = len;
        setHistoryIndex(-1);
      }
    }, 120);
    onCleanup(() => clearInterval(timer));
  });

  // ★ Task #5109 P7（DS r2 MINOR-2）—— 「本次按键已被消费」标记。
  //
  // useKeyboard 的回调没有消费语义 ⇒ 同一个 Escape 会被所有 handler 看到。
  // TextInput 消费某个键时置 true；RunScreen 处理前先查 isKeyConsumed()。
  //
  // 生命周期：每次 useKeyboard 回调**开头**清零（本次按键重新判定），
  // 消费时置 true。
  // ★ 消费标记：本按键被输入框吃掉 ⇒ 通知外部（RunScreen 的 ESC 打断）。
  const consume = () => {
    props.onKeyConsumed?.();
  };

  useKeyboard((key: KeyEvent) => {
    // ★ Task #5116 P7.1 —— 键盘门：配置弹窗打开 ⇒ 输入框让位。
    if (props.keyGate?.()) return;
    const history = props.history ?? [];
    const palette = paletteState();

    if (key.ctrl && key.name === "c") {
      props.onCancel?.();
      consume();
      return;
    }

    // ★ Task #5109 P7 —— 面板可见时的键位接管（opencode 分层 keymap 同款）。
    if (palette.open) {
      const commands = filteredCommands();
      if (key.name === "escape") {
        // ★ 顺序契约（DS r3 MINOR-1）：**必须先**置本地面板状态、
        // **再**通知外部关闭、**最后**标记消费。
        //   - `onSlashPaletteChange(false)` 让 RunScreen 的
        //     `slashPaletteOpen()` 变 false；
        //   - `consume()` 让 RunScreen 的微任务判定知道「本次 Esc 被消费」
        //     ⇒ 不打断流式。
        // 若把 consume() 提前，RunScreen 的同步短路仍会看到
        // slashPaletteOpen()=true ⇒ 双重保险失效（只剩微任务兜底）。
        setPaletteState(initialSlashPaletteState());
        props.onSlashPaletteChange?.(false);
        consume();
        return;
      }
      // ★ Task #5109 P7（DS r2 MINOR-3）：opencode 的键位是
      // `up,ctrl+p` / `down,ctrl+n`（config/keybind.ts:276-277）——
      // 文档已声明，实现补齐 ctrl+p / ctrl+n。
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        setPaletteState((s) =>
          slashPaletteReducer(s, { type: "move", delta: -1, itemCount: commands.length }),
        );
        consume();
        return;
      }
      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        setPaletteState((s) =>
          slashPaletteReducer(s, { type: "move", delta: 1, itemCount: commands.length }),
        );
        consume();
        return;
      }
      if (key.name === "tab") {
        selectSlashCommand(false);
        consume();
        return;
      }
      if (key.name === "return") {
        selectSlashCommand(true);
        consume();
        return;
      }
      // 面板打开时，可打印字符继续输入（触发过滤）。
      if (key.name === "backspace") {
        dispatch({ type: "backspace" });
        syncPalette(state().value);
        return;
      }
      // ★ Task #5109 P7（DS r1 MINOR-1）：面板打开时**光标移动键仍归输入框**
      // （←/→/Home/End/Delete）—— 面板只接管「命令选择」相关键位
      // （↑↓/Esc/Tab/Enter）。opencode 同款分层（footer.prompt.tsx
      // 的 autocomplete 层只绑 prev/next/hide/select/complete）。
      if (key.name === "delete") {
        dispatch({ type: "delete" });
        syncPalette(state().value);
        return;
      }
      if (key.name === "left") {
        dispatch({ type: "left" });
        return;
      }
      if (key.name === "right") {
        dispatch({ type: "right" });
        return;
      }
      if (key.name === "home") {
        dispatch({ type: "home" });
        return;
      }
      if (key.name === "end") {
        dispatch({ type: "end" });
        return;
      }
      const text = key.sequence && key.sequence.length >= 1 && !key.ctrl && !key.meta
        ? key.sequence
        : "";
      if (text && text.charCodeAt(0) >= 0x20) {
        dispatch({ type: "insert", text });
        syncPalette(state().value);
      }
      return;
    }

    if (key.name === "return") {
      const submitted = submitExpanded();
      dispatch({ type: "clear" });
      setHistoryIndex(-1);
      setDraft("");
      props.onSubmit(submitted);
      return;
    }
    // 片3: opentui's KeyEvent DOES distinguish Delete from Backspace (unlike
    // Ink's useInput — see tui/TextInput.compat.tsx), so we wire the real semantics.
    if (key.name === "backspace") {
      if (historyIndex() !== -1) setHistoryIndex(-1);
      dispatch({ type: "backspace" });
      return;
    }
    if (key.name === "delete") {
      if (historyIndex() !== -1) setHistoryIndex(-1);
      dispatch({ type: "delete" });
      return;
    }
    if (key.name === "left") {
      dispatch({ type: "left" });
      return;
    }
    if (key.name === "right") {
      dispatch({ type: "right" });
      return;
    }
    // 片3: Home / End jump the caret to start / end (Ink had no equivalent).
    if (key.name === "home") {
      dispatch({ type: "home" });
      return;
    }
    if (key.name === "end") {
      dispatch({ type: "end" });
      return;
    }
    if (key.name === "up") {
      if (history.length === 0) return;
      if (historyIndex() === -1) setDraft(state().value);
      const nextIndex = Math.min(historyIndex() + 1, history.length - 1);
      setHistoryIndex(nextIndex);
      dispatch({ type: "set", value: history[nextIndex] ?? "" });
      return;
    }
    if (key.name === "down") {
      if (historyIndex() === -1) return;
      const nextIndex = historyIndex() - 1;
      if (nextIndex < 0) {
        setHistoryIndex(-1);
        dispatch({ type: "set", value: draft() });
      } else {
        setHistoryIndex(nextIndex);
        dispatch({ type: "set", value: history[nextIndex] ?? "" });
      }
      return;
    }
    // Printable input — KeyEvent exposes the raw text in `sequence`.
    if (historyIndex() !== -1) setHistoryIndex(-1);
    const text = key.sequence && key.sequence.length >= 1 && !key.ctrl && !key.meta
      ? key.sequence
      : "";
    // Ignore lone control / escape sequences that arrive as `sequence`.
    if (text && text.charCodeAt(0) >= 0x20) {
      dispatch({ type: "insert", text });
      // ★ Task #5109 P7 —— 输入变化同步面板（首字符 `/` 触发）。
      syncPalette(state().value);
    }
  });

  // ★ Task #4954 P2 — bracketed paste channel.
  //
  // opentui's StdinParser recognizes `ESC[200~ … ESC[201~` and emits a
  // PasteEvent on `renderer.keyInput` (the native layer enables
  // 2004 mode by itself — measured via pty probe). `usePaste` is the
  // solid binding for that stream.
  //
  // Why a hook and not TextInput's focused onPaste: Renderable-level
  // paste needs focus bookkeeping; the global keyInput stream is the
  // same path `useKeyboard` already rides, and TextInput is mounted
  // permanently (Task #4721 G3) so pasting during streaming also lands.
  usePaste((event) => {
    const text = normalizePaste(event.bytes);
    if (!text) return;
    // Empty paste (e.g. clipboard had only an image): nothing to do.
    if (historyIndex() !== -1) setHistoryIndex(-1);
    if (shouldFoldPaste(text)) {
      const placeholder = foldedPlaceholder(text);
      // Remember BEFORE inserting so submit always sees the part.
      setPastedParts((prev) => [...prev, { text, placeholder }]);
      dispatch({ type: "insert", text: placeholder + " " });
    } else {
      dispatch({ type: "insert", text });
    }
  });

  // Task #4954 P2: Enter submits the EXPANDED text (placeholders →
  // real paste contents). opencode parity: getClipboardText expansion.
  const submitExpanded = (): string => {
    const raw = state().value;
    const parts = pastedParts();
    if (parts.length === 0) return raw;
    const expanded = expandPastedPlaceholders(raw, parts);
    setPastedParts([]);
    return expanded;
  };

  const split = () => splitAtCursor(state());

  return (
    <box style={{ flexDirection: "column" }}>
      {/* ★ Task #5109 P7 —— 斜杠补全面板（输入框上方）。 */}
      <Show when={paletteState().open}>
        <SlashPalette
          specs={props.slashCommands ?? []}
          query={paletteState().query}
          selectedIndex={paletteState().selectedIndex}
          visible={paletteState().open}
        />
      </Show>

      <box style={{ flexDirection: "row" }}>
        <text style={{ fg: fg(theme.user), attributes: TextAttributes.BOLD }}>
          {(props.prefix ?? "❯") + " "}
        </text>
        <text style={{ fg: fg(theme.text), attributes: TextAttributes.BOLD }}>{props.label + ": "}</text>

        {/* Task #4103: visible cursor block *at the caret*. A Unicode block
            glyph is used because bg-only cursors get stripped by some emulators. */}
        <Show when={state().value}>
          <text style={{ fg: fg(theme.text) }}>{split().before}</text>
          <text style={{ fg: fg(theme.text), attributes: TextAttributes.INVERSE }}>▌</text>
          <text style={{ fg: fg(theme.text) }}>{split().after}</text>
        </Show>
        <Show when={!state().value && props.placeholder}>
          <text style={{ fg: fg(theme.text), attributes: TextAttributes.INVERSE }}>▌</text>
          <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>{props.placeholder}</text>
        </Show>
        <Show when={!state().value && !props.placeholder}>
          <text style={{ fg: fg(theme.text), attributes: TextAttributes.INVERSE }}>▌</text>
        </Show>

        <Show when={historyIndex() !== -1}>
          <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>  (history)</text>
        </Show>
      </box>
    </box>
  );
}

export default TextInput;
