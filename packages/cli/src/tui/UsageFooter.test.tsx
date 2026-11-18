/**
 * @fileoverview Tests for UsageFooter — the dim grey cache/token line that
 * is appended after every assistant message in the interactive TUI.
 *
 * Task #4396. User requirement (飞书 p2p 2026-10-20):
 *   "在每个Agent消息的后面添加上这个cache和token信息已灰色颜色展示出来"
 *
 * The pure formatter is tested unconditionally; the Ink render tests are
 * skipped under `bun test --parallel 4` because Ink's renderer shares
 * process-wide stdout state (see test-utils/parallel-guard.ts).
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { formatUsageFooter, UsageFooter, type UsageLike } from "./UsageFooter.js";

// ---------------------------------------------------------------------------
// Realistic fixture: warm pi-ai / deepseek-shaped usage
// (promptTokens is the NON-cached remainder, promptTokensTotal is authoritative)
// ---------------------------------------------------------------------------
const WARM: UsageLike = {
  promptTokens: 32,
  completionTokens: 8,
  totalTokens: 15120,
  cacheRead: 14976,
  cacheWrite: 0,
  promptTokensTotal: 15008,
};

describe("formatUsageFooter", () => {
  it("shows cache hit rate with one decimal", () => {
    // 14976 / 15008 = 99.7867...%
    expect(formatUsageFooter(WARM)).toContain("99.8%");
  });

  it("abbreviates cache/total token counts with k", () => {
    const s = formatUsageFooter(WARM);
    expect(s).toContain("15.0k");
  });

  it("shows uncached input and output token counts", () => {
    const s = formatUsageFooter(WARM);
    expect(s).toContain("in 32");
    expect(s).toContain("out 8");
  });

  it("returns null when there is no usage at all", () => {
    expect(formatUsageFooter(undefined)).toBeNull();
    expect(formatUsageFooter(null)).toBeNull();
  });

  it("omits cache text when cacheRead is absent", () => {
    const s = formatUsageFooter({
      promptTokens: 1000,
      completionTokens: 50,
      totalTokens: 1050,
    });
    expect(s).not.toBeNull();
    expect(s!).not.toContain("cache");
    // 1000 is abbreviated to 1.0k (see the "abbreviates" test / formatTokens)
    expect(s!).toContain("in 1.0k");
    expect(s!).toContain("out 50");
  });

  it("renders nothing for an all-zero (aborted) usage record", () => {
    // Aborted calls report zeros; a "0.0% · in 0 · out 0" line is noise.
    expect(
      formatUsageFooter({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        promptTokensTotal: 0,
      }),
    ).toBeNull();
  });

  it("never emits NaN when promptTokensTotal is zero", () => {
    const s = formatUsageFooter({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokensTotal: 0,
    });
    // Everything is zero → nothing meaningful to show.
    expect(s === null || !s.includes("NaN")).toBe(true);
  });

  it("derives the denominator when promptTokensTotal is missing", () => {
    // pi-ai shape: promptTokens excludes cache, so total = p + read + write
    const s = formatUsageFooter({
      promptTokens: 100,
      completionTokens: 5,
      totalTokens: 1105,
      cacheRead: 1000,
      cacheWrite: 0,
    });
    expect(s).toContain("90.9%"); // 1000 / 1100
  });

  it("clamps a bogus >100% hit rate instead of printing nonsense", () => {
    const s = formatUsageFooter({
      promptTokens: 10,
      completionTokens: 1,
      totalTokens: 11,
      cacheRead: 9999,
      cacheWrite: 0,
      promptTokensTotal: 10, // provider misreported
    });
    expect(s).toContain("100.0%");
    expect(s).not.toContain("999");
  });

  it("mentions cache write tokens when the provider reports them", () => {
    const s = formatUsageFooter({
      promptTokens: 0,
      completionTokens: 12,
      totalTokens: 2012,
      cacheRead: 0,
      cacheWrite: 2000,
      promptTokensTotal: 2000,
    });
    expect(s).toContain("write 2.0k");
  });

  it("keeps small token counts un-abbreviated", () => {
    const s = formatUsageFooter({
      promptTokens: 12,
      completionTokens: 3,
      totalTokens: 15,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokensTotal: 12,
    });
    expect(s).toContain("in 12");
    expect(s).not.toContain("0.0k");
  });
});

describe.skipIf(isParallelRun)("UsageFooter component", () => {
  it("renders nothing when usage is undefined", () => {
    const { lastFrame } = render(<UsageFooter usage={undefined} />);
    // Ink renders an empty frame for null children.
    expect(lastFrame() ?? "").not.toContain("%");
  });

  it("renders the formatted line for warm usage", () => {
    const { lastFrame } = render(<UsageFooter usage={WARM} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("99.8%");
    expect(frame).toContain("in 32");
    expect(frame).toContain("out 8");
  });

  it("substitutes a fallback when asked for one and usage is missing", () => {
    const { lastFrame } = render(
      <UsageFooter usage={undefined} fallback="(no usage reported)" />,
    );
    expect(lastFrame() ?? "").toContain("no usage reported");
  });
});
