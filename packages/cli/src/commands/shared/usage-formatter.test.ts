import { describe, test, expect, beforeAll } from "bun:test";
import chalk from "chalk";
import { formatCacheLine } from "./usage-formatter";

// Force chalk to emit ANSI codes even when stdout is not a TTY (test runner)
// so colorization branches in formatCacheLine can be asserted directly.
beforeAll(() => {
  chalk.level = 1;
});

// Strip ANSI escape codes for predictable plain-text comparison
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

describe("formatCacheLine (F1)", () => {
  test("returns null when usage is undefined", () => {
    expect(formatCacheLine(undefined, { colorize: false })).toBeNull();
    expect(formatCacheLine(null, { colorize: false })).toBeNull();
  });

  test("returns null when usage has no cache fields at all", () => {
    expect(
      formatCacheLine(
        { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        { colorize: false }
      )
    ).toBeNull();
  });

  test("reports 0/0 with 0% hit rate when cacheRead=0 and cacheWrite=0", () => {
    const out = formatCacheLine(
      { cacheRead: 0, cacheWrite: 0 },
      { colorize: false }
    );
    expect(out).not.toBeNull();
    expect(stripAnsi(out!)).toBe(
      "💰 Cache: read 0 / write 0 (saved ~$0.000 / 0% hit rate)"
    );
  });

  test("computes saved cost and hit rate for cacheRead > 0", () => {
    // 1400 cacheRead tokens at $0.30 vs $3.00 → saved = 1400 * 2.70 / 1_000_000 = $0.003780
    // Round to 3 decimals → $0.004
    const out = formatCacheLine(
      { cacheRead: 1400, cacheWrite: 0 },
      { colorize: false }
    );
    expect(stripAnsi(out!)).toBe(
      "💰 Cache: read 1400 / write 0 (saved ~$0.004 / 100% hit rate)"
    );
  });

  test("computes hit rate with mixed cacheRead and cacheWrite", () => {
    // cacheRead=800, cacheWrite=200, total=1000, hitRate=80%
    // saved = 800 * 2.70 / 1_000_000 = 0.00216 → $0.002
    const out = formatCacheLine(
      { cacheRead: 800, cacheWrite: 200 },
      { colorize: false }
    );
    expect(stripAnsi(out!)).toBe(
      "💰 Cache: read 800 / write 200 (saved ~$0.002 / 80% hit rate)"
    );
  });

  test("reports yellow color when cacheWrite > 0 and cacheRead = 0 (cold cache)", () => {
    const out = formatCacheLine(
      { cacheRead: 0, cacheWrite: 1500 },
      { colorize: true }
    );
    // Just verify the text content + that it's wrapped in ANSI codes
    expect(out).not.toBeNull();
    expect(out!).toContain("\x1B["); // contains ANSI escape
    expect(stripAnsi(out!)).toContain("write 1500");
    expect(stripAnsi(out!)).toContain("0% hit rate");
  });

  test("reports green color when cacheRead > 0 and cacheWrite = 0 (cache hit)", () => {
    const out = formatCacheLine(
      { cacheRead: 1500, cacheWrite: 0 },
      { colorize: true }
    );
    expect(out).not.toBeNull();
    expect(stripAnsi(out!)).toContain("100% hit rate");
  });

  test("treats undefined cacheRead/cacheWrite as 0", () => {
    // Only cacheRead defined, cacheWrite undefined
    const out = formatCacheLine(
      { cacheRead: 100 },
      { colorize: false }
    );
    expect(stripAnsi(out!)).toContain("read 100 / write 0");
  });

  test("handles large numbers without overflow", () => {
    const out = formatCacheLine(
      { cacheRead: 1_000_000, cacheWrite: 0 },
      { colorize: false }
    );
    // saved = 1_000_000 * 2.70 / 1_000_000 = $2.700
    expect(stripAnsi(out!)).toBe(
      "💰 Cache: read 1000000 / write 0 (saved ~$2.700 / 100% hit rate)"
    );
  });
});
// ============================================================================
// Task #4373: hit rate must use the cache-aware INPUT denominator.
//
// The original formula was `cacheRead / (cacheRead + cacheWrite)`, which
// reports 100% for every pure-read provider (pi-ai/minimax/DeepSeek all
// report cacheWrite=0 on warm traffic). That makes the number useless.
//
// Correct denominator = total input tokens processed:
//   promptTokensTotal (when provided)  OR  promptTokens + cacheRead + cacheWrite
// ============================================================================
describe("formatCacheLine hit rate denominator (Task #4373)", () => {
  test("use promptTokensTotal when provided (pi-ai shape: promptTokens is non-cached)", () => {
    const out = formatCacheLine(
      {
        // pi-ai: 24 fresh input tokens + 102016 served from cache
        promptTokens: 24,
        promptTokensTotal: 102040,
        cacheRead: 102016,
        cacheWrite: 0,
      },
      { colorize: false }
    );
    // 102016/102040 = 99.976%  → rounds to 100 with toFixed(0)
    expect(out).toContain("100% hit rate");
  });

  test("derives denominator from promptTokens + cache when promptTokensTotal absent", () => {
    const out = formatCacheLine(
      { promptTokens: 986, cacheRead: 1000, cacheWrite: 14 },
      { colorize: false }
    );
    // 1000 / (986 + 1000 + 14) = 50%
    expect(out).toContain("50% hit rate");
  });

  test("does not report 100% for a pure-read provider on a cold partial hit", () => {
    const out = formatCacheLine(
      { promptTokens: 500, cacheRead: 500, cacheWrite: 0 },
      { colorize: false }
    );
    // 500 / 1000 = 50%, NOT 100%
    expect(out).toContain("50% hit rate");
    expect(out).not.toContain("100% hit rate");
  });

  test("never exceeds 100%", () => {
    const out = formatCacheLine(
      { promptTokens: 10, cacheRead: 5000, cacheWrite: 0 },
      { colorize: false }
    );
    expect(out).not.toContain("500%");
    expect(out).toContain("100% hit rate");
  });
});
