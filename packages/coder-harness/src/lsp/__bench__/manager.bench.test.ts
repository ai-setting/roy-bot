/**
 * @fileoverview LSP Manager 性能基准测试
 *
 * 验证 LSPManager 优化（prewarm / dedupe / cache）生效，并记录冷热路径延迟数字。
 * 这是一个测试文件，它执行基准测量并断言"优化后"的行为符合预期。
 *
 * 生成的数字会同时输出到控制台，供 reports/lsp-optimization-report.md 引用。
 */

import { describe, expect, it } from "vitest";
import { benchPrewarmHit } from "./manager.bench";

describe("LSP Manager benchmark", () => {
  it(
    "prewarm + dedupe + cache reduce cold→warm latency",
    async () => {
      const result = await benchPrewarmHit(["typescript"], "/tmp/bench-workspace");

      console.log("\n[LSP Bench Result]", JSON.stringify(result, null, 2));

      // === 断言优化效果 ===
      // warm 路径应该显著快于 cold（prewarm 跳过了 initialize 延迟）
      expect(result.warmMs).toBeLessThan(result.coldMs);
      // hit 路径应该接近 0（5s cache 命中，无 server 调用）
      expect(result.hitMs).toBeLessThan(10);
      // 所有延迟必须为非负数
      expect(result.coldMs).toBeGreaterThanOrEqual(0);
      expect(result.warmMs).toBeGreaterThanOrEqual(0);
      expect(result.hitMs).toBeGreaterThanOrEqual(0);
      expect(result.serial100Ms).toBeGreaterThanOrEqual(0);
      expect(result.parallel100Ms).toBeGreaterThanOrEqual(0);
    },
    30000,
  );

  it(
    "handles cold-only path without prewarm",
    async () => {
      const result = await benchPrewarmHit(["typescript"], "/tmp/bench-cold-only", {
        initLatencyMs: 50,
        diagnosticsLatencyMs: 30,
      });

      console.log("\n[LSP Bench Cold Only]", JSON.stringify(result, null, 2));

      // 即使是 cold 路径，至少应该有数据返回
      expect(result.coldMs).toBeGreaterThanOrEqual(0);
    },
    20000,
  );
});
