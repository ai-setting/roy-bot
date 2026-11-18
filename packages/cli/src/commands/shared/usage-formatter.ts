/**
 * @fileoverview Usage formatter — render cache / token info as one-liner.
 *
 * F1 (review-cache-stability.md): provide a human-friendly summary of
 * Anthropic prompt cache effectiveness in interactive REPL output, so
 * users can observe cache hit rates at a glance.
 *
 * Pricing reference (Anthropic Sonnet 4.5):
 * - regular input:  $3.00 / 1M tokens
 * - cacheRead:     $0.30 / 1M tokens
 * - cacheWrite:    $3.75 / 1M tokens
 *
 * We compute `saved` as the difference between what would have been paid
 * at regular price and what was actually paid for cacheRead tokens:
 *   saved = cacheRead * (regularPrice - cacheReadPrice)
 */

import chalk from "chalk";

/**
 * Subset of UsageInfo that the formatter needs.
 *
 * Defined locally so this module does not depend on the CLI's
 * `StreamOutputService` types (keeps the formatter easy to unit-test
 * without spinning up the full stream service).
 */
export interface FormattableUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /**
   * Cache-aware input denominator (`promptTokens + cacheRead + cacheWrite`),
   * precomputed by core's `normalizeUsage()`. When present it is authoritative
   * because core has already reconciled whether `promptTokens` is inclusive
   * (AI SDK) or cache-subtracted (pi-ai).
   */
  promptTokensTotal?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Anthropic Sonnet 4.5 pricing (USD per token) */
const PRICING = {
  regularPerToken: 3 / 1_000_000,
  cacheReadPerToken: 0.3 / 1_000_000,
  cacheWritePerToken: 3.75 / 1_000_000,
} as const;

export interface CacheLineOptions {
  /**
   * If true, wrap output in ANSI color codes (green/red/yellow).
   * Default: true (use chalk).
   * Pass false in tests for predictable plain-text comparison.
   */
  colorize?: boolean;
}

/**
 * Format a one-line cache summary, e.g.:
 *   `💰 Cache: read 1400 / write 0 (saved ~$0.004 / 100% hit rate)`
 *
 * Returns null when:
 * - usage is undefined
 * - cacheRead and cacheWrite are both 0 or undefined (nothing to report)
 *
 * Color rules (when colorize=true):
 * - cacheRead > 0 AND cacheWrite == 0: green (pure hit)
 * - cacheRead == 0 AND cacheWrite > 0: yellow (cold cache, paying write cost)
 * - mixed: yellow (mixed read/write)
 * - no cache fields at all: muted gray fallback ("no cache info")
 */
export function formatCacheLine(
  usage: FormattableUsage | undefined | null,
  options: CacheLineOptions = {}
): string | null {
  const { colorize = true } = options;

  if (!usage) return null;

  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  // No cache info available at all → muted fallback
  if (
    usage.cacheRead === undefined &&
    usage.cacheWrite === undefined &&
    cacheRead === 0 &&
    cacheWrite === 0
  ) {
    return null;
  }

  // Pure zero values (cache was checked, nothing cached) → still report 0
  if (cacheRead === 0 && cacheWrite === 0) {
    if (!colorize) return "💰 Cache: read 0 / write 0 (saved ~$0.000 / 0% hit rate)";
    return chalk.gray("💰 Cache: read 0 / write 0 (saved ~$0.000 / 0% hit rate)");
  }

  const saved =
    cacheRead * (PRICING.regularPerToken - PRICING.cacheReadPerToken);

  // Task #4373: the denominator must be the total INPUT the model processed,
  // not `cacheRead + cacheWrite`.
  //
  // The old `cacheRead / (cacheRead + cacheWrite)` reported 100% for every
  // pure-read provider (pi-ai / minimax / DeepSeek all leave cacheWrite at 0
  // on warm traffic), which made the metric meaningless.
  //
  // Prefer the denominator core already reconciled (`promptTokensTotal`).
  // Fall back to deriving it: in the pi-ai shape `promptTokens` is the
  // non-cached remainder, so adding the cache counters back is correct.
  const promptTokens = usage.promptTokens ?? 0;
  const denom =
    usage.promptTokensTotal !== undefined && usage.promptTokensTotal > 0
      ? usage.promptTokensTotal
      : promptTokens + cacheRead + cacheWrite;

  const rawRate = denom > 0 ? (cacheRead / denom) * 100 : 0;
  // Defensive clamp — a misbehaving provider must never show >100%.
  const hitRate = Math.min(100, Math.max(0, rawRate)).toFixed(0);

  const text = `💰 Cache: read ${cacheRead} / write ${cacheWrite} (saved ~$${saved.toFixed(3)} / ${hitRate}% hit rate)`;

  if (!colorize) return text;

  if (cacheRead > 0 && cacheWrite === 0) return chalk.green(text);
  if (cacheRead === 0 && cacheWrite > 0) return chalk.yellow(text);
  return chalk.yellow(text); // mixed
}