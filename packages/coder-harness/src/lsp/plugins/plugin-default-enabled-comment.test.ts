/**
 * @fileoverview 验证 pylsp-plugin / tslsp-plugin 的 "默认启用" 中文注释 (F6)
 *
 * 注释应当出现在 `preloadMode: "startup"` 上方，解释为何默认是 startup 模式。
 * 这是被 Round 1 review 识别的 P3 finding (F6)，让代码读者快速理解默认行为。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LSP plugin '默认启用' comment (F6)", () => {
  it("pylsp-plugin.ts has '默认启用' comment above preloadMode = 'startup' default", () => {
    const pkgRoot = resolve(__dirname, "..", "..", "..");
    const filePath = resolve(pkgRoot, "src/lsp/plugins/pylsp-plugin.ts");
    const content = readFileSync(filePath, "utf8");

    // 提取 `preloadMode: "startup",` 所在的代码块（前 10 行）
    const lines = content.split("\n");
    const idx = lines.findIndex((l) => l.includes('preloadMode: "startup"'));
    expect(idx).toBeGreaterThan(0);

    // 上方 3 行内应出现 "默认启用" 中文注释
    const above = lines.slice(Math.max(0, idx - 3), idx).join("\n");
    expect(above).toMatch(/默认启用/);
  });

  it("tslsp-plugin.ts has '默认启用' comment above preloadMode = 'startup' default", () => {
    const pkgRoot = resolve(__dirname, "..", "..", "..");
    const filePath = resolve(pkgRoot, "src/lsp/plugins/tslsp-plugin.ts");
    const content = readFileSync(filePath, "utf8");

    const lines = content.split("\n");
    const idx = lines.findIndex((l) => l.includes('preloadMode: "startup"'));
    expect(idx).toBeGreaterThan(0);

    const above = lines.slice(Math.max(0, idx - 3), idx).join("\n");
    expect(above).toMatch(/默认启用/);
  });
});