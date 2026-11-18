/**
 * @fileoverview TUI components for roy-bot CLI (Ink + React).
 *
 * Task #2610 stage 2: re-exports the tui/ primitives for the RunTui /
 * ChatTui composition root.
 *
 * Exports:
 *   - App: root component for the chat/run interactive screen
 *   - Markdown: wraps the ANSI markdown renderer inside an Ink <Text>
 *   - Spinner: animated thinking indicator
 *   - StatusBar: footer status line (model + workdir + exit hint)
 *   - TextInput: single-line input with ↑/↓ history navigation
 *     (compatibility shim — @deprecated, see the export below)
 *
 * Usage:
 *   import { render } from "ink";
 *   import { App } from "./tui/App.js";
 *   const { waitUntilExit, unmount } = render(<App history={[]} status="idle" />);
 */

export { App } from "./App.js";
export type { AppProps, AppStatus, HistoryItem, Role } from "./App.js";
export { Markdown } from "./Markdown.js";
export type { MarkdownProps } from "./Markdown.js";
export { Spinner } from "./Spinner.js";
export type { SpinnerProps } from "./Spinner.js";
export { StatusBar } from "./StatusBar.js";
export type { StatusBarProps } from "./StatusBar.js";
// Task #4688: the Ink `TextInput` lost its only live consumer when Task
// #4681 removed the Ink `RunTui.tsx` (measured: the component body was
// fully tree-shaken out of the CLI bundle). `TextInput.compat.tsx` keeps
// this export pointing at a real, working Ink implementation — the
// public surface of `tui/index.ts` is unchanged.
//
// @deprecated Prefer the Solid implementation in `tui-solid/TextInput.tsx`,
//   which is the one that actually runs in `roy-bot interactive`.
export { TextInput } from "./TextInput.compat.js";
export type { TextInputProps } from "./TextInput.compat.js";

// Task #4124: opencode-style tool rendering.
export { ToolCall } from "./ToolCall.js";
export type { ToolCallProps } from "./ToolCall.js";
export {
  describeToolCall,
  formatDuration,
  formatToolOutput,
  humanizeToolName,
  stringifyToolOutput,
} from "./tool-call.js";
export type {
  ToolCallInfo,
  ToolCallStatus,
  ToolDescriptor,
  ToolStreamEvent,
} from "./tool-call.js";

// Task #2657 Round 2: theme system (NO_COLOR / capability detection).
// Exports `getTheme(env?)` so Spinner / StatusBar / App can route colors
// through one place. Default colors match the pre-existing hardcoded
// values so visual output is unchanged unless NO_COLOR/TERM=dumb is set.
export { getTheme } from "./theme.js";
export type { TuiTheme } from "./theme.js";

// Task #2613 Plan Step 3: welcome card via tui/welcome-card.renderWelcomeCard
// (re-export wrapper over commands/ui/welcome-card buildWelcomeCard).
// AC1: repl-ink.tsx no longer imports from `./ui/welcome-card` directly.
// AC2: repl-ink.tsx no longer calls `buildWelcomeCard` directly.
export { renderWelcomeCard } from "./welcome-card.js";
export type { WelcomeCardContext } from "./welcome-card.js";