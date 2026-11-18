/**
 * @fileoverview tui-solid — Solid component surface for `roy-bot interactive`.
 *
 * Fork of `tui/index.ts` (Ink/React) for Task #4278 (片1 地基).
 *
 * ⚠️ **Why a separate directory?** The `run` chain
 * (`commands/run.ts` → `ChatTui.tsx`) and the `interactive` chain
 * (`commands/interactive.ts` → `RunTui.tsx`) both import `tui/`. Task #4278's hard
 * constraint is that the `run` chain must stay byte-for-byte unchanged, so
 * the Solid port lives in its own tree and `tui/` is left untouched.
 *
 * Shared *pure* modules (no JSX / no React) are re-used in place rather than
 * forked, to avoid drift:
 *   - `tui/theme.ts`                 (palette + capability probe)
 *   - `tui/scrollback.ts`            (splitStable)
 *   - `tui/tool-call.ts`             (describeToolCall / formatDuration / …)
 *   - `tui/text-input-editing.ts`    (editReducer / splitAtCursor)
 */

export { App, HistoryEntry } from "./App.js";
export type { AppProps, AppStatus, HistoryItem, Role } from "./App.js";
export { Markdown } from "./Markdown.js";
export type { MarkdownProps } from "./Markdown.js";
export { Spinner } from "./Spinner.js";
export type { SpinnerProps } from "./Spinner.js";
export { StatusBar } from "./StatusBar.js";
export type { StatusBarProps } from "./StatusBar.js";
export { TextInput } from "./TextInput.js";
export type { TextInputProps } from "./TextInput.js";
export { ToolCall } from "./ToolCall.js";
export type { ToolCallProps } from "./ToolCall.js";
export { useStreamingAccumulator } from "./use-streaming-accumulator.js";
export type {
  StreamingAccumulator,
  StreamingAccumulatorOptions,
} from "./use-streaming-accumulator.js";
export { getTheme, fg } from "./theme.js";

// Task #5086 P5 (DS r2 MINOR-4): expose the token API for
// external consumers (incl. future P6 opentui upgrade).
export {
  TUI_TOKENS,
  useTuiTheme,
  getNoColorTheme,
  resolveSolidTheme,
} from "./theme.js";
export type { TuiToken, TuiThemeMode, TuiTokenPalette, TuiSolidTheme } from "./theme.js";

// 片1: mount bridge + composition root (Solid analogue of RunTui.tsx).
export { RunScreenSolid } from "./RunScreen.js";
export type { RunTuiSolidProps } from "./RunScreen.js";
export { mountInteractiveScreen } from "./mount.js";
