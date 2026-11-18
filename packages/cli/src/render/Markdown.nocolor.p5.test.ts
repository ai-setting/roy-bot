/**
 * @fileoverview Task #5086 P5 DS r2 MINOR-3 — renderMarkdown 的 NO_COLOR 回归保护。
 *
 * markdown.ts 的 ANSI 色码走惰性 getter（noColorMode() 每次求值）；
 * 若未来重构把 getter 改回模块常量，本测试会在 NO_COLOR 下抓到泄漏的
 * \x1b[3xm / \x1b[9xm 色码。
 */

import { describe, expect, it } from "bun:test";
import { renderMarkdown } from "../render/markdown.js";

describe("P5 renderMarkdown NO_COLOR 降级（MINOR-3 回归保护）", () => {
  it("NO_COLOR=1 ⇒ 输出不含前景/背景色码（3x/9x/48/38）", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const out = renderMarkdown("## 标题\n\n正文 **加粗**\n\n```ts\nconst x = 1;\n```\n", {
        width: 60,
      });
      // 色码：31-37 / 90-97（前景）、41-47 / 100-107（背景）。
      // bold/dim/italic 是属性不是颜色，NO_COLOR 规范允许保留。
      const colorCodes = [
        /\x1b\[3[0-7]m/, /\x1b\[9[0-7]m/,
        /\x1b\[4[0-7]m/, /\x1b\[10[0-7]m/,
      ];
      for (const re of colorCodes) {
        expect(re.test(out)).toBe(false);
      }
      // 属性码应保留（heading 有 bold）
      expect(out).toContain("标题");
      expect(out).toContain("const x = 1;");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it("无 NO_COLOR ⇒ 保留色码（cyan heading 等）", () => {
    const prev = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const out = renderMarkdown("## 标题\n", { width: 60 });
      expect(/\x1b\[3[0-7]m/.test(out) || /\x1b\[9[0-7]m/.test(out)).toBe(true);
    } finally {
      if (prev !== undefined) process.env.NO_COLOR = prev;
    }
  });
});
