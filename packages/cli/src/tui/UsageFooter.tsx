/**
 * @fileoverview UsageFooter — the dim grey cache / token line rendered
 * underneath every assistant message in the interactive TUI.
 *
 * Task #4396. User requirement (飞书 p2p 2026-10-20):
 *   "在每个Agent消息的后面添加上这个cache和token信息已灰色颜色展示出来"
 *
 * Design notes
 * ------------
 * The formatter is intentionally a *pure string function* so it can be
 * unit-tested without an Ink render (Ink shares process-wide stdout state
 * and cannot run under `bun test --parallel 4`). The React component is a
 * thin `<Text dimColor>` wrapper around it.
 *
 * Token semantics (Task #4373):
 *   pi-ai reports `promptTokens` as the NON-cached remainder and
 *   `promptTokensTotal` as the authoritative cache-aware denominator
 *   (`promptTokens + cacheRead + cacheWrite`). We therefore:
 *     - use `promptTokensTotal` for the hit-rate denominator when present;
 *     - fall back to `promptTokens + cacheRead + cacheWrite` otherwise;
 *     - clamp the rate to [0, 100] so a misbehaving provider can never
 *       print a nonsense 261579% (the bug Task #4373 fixed).
 *
 * Output shape (single line, `·` separated, everything optional):
 *   cache 99.8% · 15.0k/15.0k · in 32 · out 8
 *   cache 0.0% · write 2.0k · in 0 · out 12
 *   in 1000 · out 50          (no cache data reported by the provider)
 */

import React from "react";
import { Text } from "ink";

// ★ Task #4278 交叉验证：the pure formatting half now lives in
//   `tui/usage-format.ts` (no React / no Ink). The `tui-solid/` fork needs
//   that half but must NOT drag React+Ink into the opentui path, so it
//   imports `usage-format.ts` directly. Re-exporting here keeps this
//   module's public surface byte-identical for every existing consumer
//   (`tui/App.tsx`, `RunTui.tsx`, `tui/UsageFooter.test.tsx`).
//
// ⚠️ `export { x } from "..."` does NOT create a local binding — the
//   component below calls `formatUsageFooter(...)` directly, so we need a
//   real `import` too.
import {
  formatTokens,
  formatUsageFooter,
  type UsageLike,
} from "./usage-format.js";

export {
  formatTokens,
  formatUsageFooter,
  type UsageLike,
};


export interface UsageFooterProps {
  usage?: UsageLike | null;
  /**
   * Text to render when `usage` is missing/empty. Omit (the default) to
   * render nothing at all — which is what the REPL does for providers that
   * report no usage.
   */
  fallback?: string;
  /** Indent in columns, aligns the footer under the message body. */
  indent?: number;
}

/**
 * Dim grey usage line, appended after an assistant message.
 *
 * `<Text dimColor>` is Ink's terminal-native dim attribute: it degrades to
 * plain text on terminals without SGR 2 support and is unaffected by the
 * NO_COLOR theme (which empties every colour string but leaves dimColor
 * working), so the footer stays visually subordinate in every mode.
 */
export const UsageFooter: React.FC<UsageFooterProps> = ({
  usage,
  fallback,
  indent = 2,
}) => {
  const line = formatUsageFooter(usage);
  if (!line) {
    if (!fallback) return null;
    return <Text dimColor>{`${" ".repeat(indent)}${fallback}`}</Text>;
  }
  return <Text dimColor>{`${" ".repeat(indent)}${line}`}</Text>;
};

export default UsageFooter;
