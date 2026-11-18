/**
 * @fileoverview usage-format — **pure** cache/token formatting for the
 * interactive TUI's usage footer (Task #4396).
 *
 * ## Why this module exists (Task #4278 交叉验证发现)
 *
 * `tui/UsageFooter.tsx` mixes two very different things:
 *
 *   1. the **pure** formatter (`formatTokens` / `formatUsageFooter` / `UsageLike`)
 *   2. the **Ink** component (`<UsageFooter>` → `<Text dimColor>`)
 *
 * The `tui-solid/` fork (opentui/Solid port) needs (1) but must NOT pull (2):
 * `UsageFooter.tsx` does `import { Text } from "ink"` at module top level, so
 * importing the formatter from it drags **React + Ink** into the opentui path.
 *
 * That would violate the fork's own policy, documented in `tui-solid/index.ts`:
 *
 *   "Shared *pure* modules (no JSX / no React) are re-used in place rather
 *    than forked, to avoid drift"
 *
 * Every other shared module `tui-solid/` imports (`tui/tool-call.ts`,
 * `tui/theme.ts`, `tui/scrollback.ts`) has **zero imports** — they are pure.
 * `UsageFooter.tsx` was the one exception, and it broke that invariant.
 *
 * ⇒ This module holds the pure half; `tui/UsageFooter.tsx` re-exports it
 * (so the Ink chain keeps its exact public surface) and `tui-solid/` imports
 * it directly (so the opentui path stays React-free).
 *
 * ## No drift
 *
 * `tui/UsageFooter.tsx` re-exports every symbol from here — there is exactly
 * ONE implementation of the formatting logic.
 */

/**
 * The subset of usage fields the footer needs.
 *
 * Structurally compatible with:
 *   - `UsageInfo` in `services/stream-output.service.ts`
 *   - `UsageInfo` in `@ai-setting/roy-bot-core` (`env/llm/types.ts`)
 *   - the `metadata.usage` payload the LLM completed event carries
 */
export interface UsageLike {
  /** Non-cached prompt (input) tokens. pi-ai shape excludes cache tokens. */
  promptTokens?: number;
  /** Generated (output) tokens. */
  completionTokens?: number;
  /** Provider-reported grand total. */
  totalTokens?: number;
  /** Tokens served from the prompt cache (Anthropic `cache_read_input_tokens`). */
  cacheRead?: number;
  /** Tokens written into the prompt cache (Anthropic `cache_creation_input_tokens`). */
  cacheWrite?: number;
  /** Cache-aware input denominator reconciled by core's `normalizeUsage()`. */
  promptTokensTotal?: number;
}

/** Format a token count: 999 → "999", 14976 → "15.0k", 1234567 → "1234.6k". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1)}k`;
}

/**
 * Render the cache / token summary as a plain one-liner.
 *
 * Returns `null` when `usage` is missing or carries no displayable number,
 * so callers can render nothing at all (no stray separator, no "undefined").
 */
export function formatUsageFooter(
  usage: UsageLike | undefined | null,
): string | null {
  if (!usage) return null;

  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  const cacheRead = usage.cacheRead;
  const cacheWrite = usage.cacheWrite;

  const hasCacheRead = typeof cacheRead === "number";
  const hasCacheWrite = typeof cacheWrite === "number";
  const hasPrompt = typeof promptTokens === "number";
  const hasCompletion = typeof completionTokens === "number";

  // Nothing at all to display.
  if (!hasPrompt && !hasCompletion && !hasCacheRead && !hasCacheWrite) {
    return null;
  }

  // An aborted / short-circuited call can report every counter as 0. Showing
  // "cache 0.0% · in 0 · out 0" is noise that looks like a provider failure,
  // so treat an all-zero record as "nothing to report".
  const allZero =
    (promptTokens ?? 0) === 0 &&
    (completionTokens ?? 0) === 0 &&
    (cacheRead ?? 0) === 0 &&
    (cacheWrite ?? 0) === 0;
  if (allZero) return null;

  const parts: string[] = [];

  // ---- cache segment -----------------------------------------------------
  // Only meaningful when the provider actually reports cache counters.
  if (hasCacheRead || hasCacheWrite) {
    const read = cacheRead ?? 0;
    const write = cacheWrite ?? 0;

    // Cache-aware input denominator.
    // `promptTokensTotal` from core is authoritative (Task #4373); derive
    // it from the pi-ai shape otherwise.
    const reportedTotal = usage.promptTokensTotal;
    const denom =
      typeof reportedTotal === "number" && reportedTotal > 0
        ? reportedTotal
        : (promptTokens ?? 0) + read + write;

    const rawRate = denom > 0 ? (read / denom) * 100 : 0;
    const rate = Math.min(100, Math.max(0, rawRate));

    parts.push(`cache ${rate.toFixed(1)}%`);

    if (denom > 0) {
      parts.push(`${formatTokens(read)}/${formatTokens(denom)}`);
    }

    if (write > 0) {
      parts.push(`write ${formatTokens(write)}`);
    }
  }

  // ---- token segments ----------------------------------------------------
  if (hasPrompt) parts.push(`in ${formatTokens(promptTokens!)}`);
  if (hasCompletion) parts.push(`out ${formatTokens(completionTokens!)}`);

  if (parts.length === 0) return null;
  return parts.join(" · ");
}

// =============================================================================
// P4 meta info line (Task #4994)
// =============================================================================

/** Fields of the assistant meta info line (opencode `AssistantFooter`). */
export interface MetaInfo {
  /** Agent / turn label, e.g. `Build` (opencode: `Locale.titlecase(agent)`). */
  agent: string;
  /** Model identifier shown after the agent label. */
  model?: string;
}

/** Turn duration in milliseconds (Task #4994). */
export type DurationMs = number | undefined;

/**
 * Format an assistant meta info line, opencode AssistantFooter style:
 *
 *   `Build · <model> · <duration>s · <tok/s>`
 *
 * Segments appear only when their data exists:
 *   - `agent` is always present;
 *   - `model` when provided;
 *   - duration (`<x.x>s`) when `durationMs` is a positive finite number;
 *   - tok/s when both `usage.completionTokens` and `durationMs` allow it.
 *
 * The cache/token summary of `formatUsageFooter` (Task #4396) is
 * appended when usage data exists, so one line carries everything:
 *
 *   `Build · m1 · 4.2s · 5.9 tok/s · cache 99.2% · 14.7k/14.8k`
 *
 * Returns `null` only when `usage` is empty AND no model/duration
 * was given — callers render nothing in that case (same contract as
 * `formatUsageFooter`).
 */
export function formatMetaLine(
  meta: MetaInfo,
  usage?: UsageLike | null,
  durationMs?: DurationMs,
): string | null {
  const parts: string[] = [];
  if (meta.agent) parts.push(meta.agent);
  if (meta.model) parts.push(meta.model);

  const hasDuration =
    typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs > 0;
  if (hasDuration) {
    parts.push(`${(durationMs! / 1000).toFixed(1)}s`);
  }

  // tok/s: completion tokens over the wall-clock duration.
  const completionTokens = usage?.completionTokens;
  if (
    hasDuration &&
    typeof completionTokens === "number" &&
    completionTokens > 0
  ) {
    const tps = (completionTokens / durationMs!) * 1000;
    if (Number.isFinite(tps) && tps > 0) {
      parts.push(`${tps.toFixed(1)} tok/s`);
    }
  }

  // Cache/token summary (Task #4396 semantics, appended).
  const usageText = formatUsageFooter(usage);
  if (usageText) {
    for (const seg of usageText.split(" · ")) parts.push(seg);
  }

  if (parts.length === 0) return null;
  return parts.join(" · ");
}
