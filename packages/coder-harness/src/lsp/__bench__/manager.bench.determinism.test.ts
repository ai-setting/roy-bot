/**
 * @fileoverview 验证 manager.bench.ts 包含 Determinism 段落 (F7)
 *
 * Round 1 review 指出 bench 数字在同一机器/同一次运行内会有 ±1-2ms 抖动，
 * 跨机器对比无意义。需要在文件顶部添加 Determinism 说明，避免误判优化效果。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LSP bench determinism note (F7)", () => {
  it("manager.bench.ts has a Determinism section explaining jitter sources", () => {
    const pkgRoot = resolve(__dirname, "..", "..", "..");
    const filePath = resolve(pkgRoot, "src/lsp/__bench__/manager.bench.ts");
    const content = readFileSync(filePath, "utf8");

    // 顶部 60 行内应包含 "Determinism" 段落关键词
    const head = content.split("\n").slice(0, 60).join("\n");
    expect(head).toMatch(/Determinism/);
    // 抖动说明（中文或英文皆可）
    expect(head).toMatch(/抖动|jitter|±\d/);
    // 提醒跑 ≥3 轮取中位数
    expect(head).toMatch(/≥\s*3|>=?\s*3|3\s*轮|median|中位数/i);
  });
});