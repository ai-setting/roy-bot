/**
 * @fileoverview LSPManager @TracedAs 装饰验证 (Trace 闭环)
 *
 * 验证 5 个 LSPManager 关键方法被 @TracedAs 装饰器标注，
 * span_name 与 expected_traces 完全一致。
 * 统一规范：仅使用 @TracedAs，禁止 @Traced / @TracedLightweight。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LSPManager @TracedAs decorators (Trace closure)", () => {
  it("manager.ts has 5 @TracedAs decorators with correct span_names", () => {
    // __dirname = /.../packages/coder-harness/src/lsp/
    const filePath = resolve(__dirname, "manager.ts");
    const content = readFileSync(filePath, "utf8");

    const expectedSpans = [
      "lsp-manager.prewarm",
      "lsp-manager.getOrCreateConnection",
      "lsp-manager.getDiagnostics",
      "lsp-manager.cleanupIdle",
      "lsp-manager.dispose",
    ];

    for (const span of expectedSpans) {
      // 装饰器必须存在
      const decoratorRegex = new RegExp(
        `@TracedAs\\(\\s*["']${span.replace(/\./g, "\\.")}["']`,
      );
      expect(content).toMatch(decoratorRegex);
    }

    // 至少 5 个 @TracedAs 装饰器
    const matches = content.match(/@TracedAs\s*\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);

    // 不应使用旧的 @Traced 或 @TracedLightweight
    expect(content).not.toMatch(/@TracedLightweight\s*\(/);
    // 单独检查 @Traced 后跟 (，但允许 @TracedAs 通过 lookbehind 排除
    expect(content).not.toMatch(/(?<![Aa])@Traced\s*\(/);
  });

  it("manager.ts imports TracedAs from @ai-setting/roy-bot-core", () => {
    const filePath = resolve(__dirname, "manager.ts");
    const content = readFileSync(filePath, "utf8");

    expect(content).toMatch(
      /import\s*\{[^}]*TracedAs[^}]*\}\s*from\s*["']@ai-setting\/roy-bot-core["']/,
    );
  });
});