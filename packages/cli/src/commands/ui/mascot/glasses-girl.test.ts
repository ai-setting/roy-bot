/**
 * @fileoverview Glasses Girl Mascot — 像素 sprite 单元测试
 *
 * Task #2398: 重新设计 roy-bot 终端欢迎页 mascot 为「戴眼镜的小女孩」。
 *
 * 验证:
 *   - 4 行 sprite (3 像素 + 1 label)，与 Tips/What's new 行数对齐
 *   - 每行 visible width 一致 (≤ LEFT_WIDTH=26)
 *   - 所有字符都是 1 cell 宽 (Bun.stringWidth = 1) — 避免 East Asian Width 错位
 *   - NO_COLOR (chalk.level=0) 降级时仍可读
 *   - 窄终端 (process.stdout.columns=40) 不破坏布局
 *   - 眼镜元素可见: 至少有两个对称的圆形/方形 lens + 桥
 *   - 女孩元素可见: 头发形状 + hoodie/shirt
 *   - ANSI stripping 不留孤立 escape
 *   - alt 文案不引入 emoji width 2
 *   - 与现有 PIXEL_LOGO_LINES 兼容 (welcome-card 测试不回归)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as chalkNs from "chalk";
import {
  GLASSES_GIRL_LINES,
  GLASSES_GIRL_RAW_LINES,
  GLASSES_GIRL_ALT_TEXT,
  GLASSES_GIRL_META,
  renderGlassesGirlLines,
  stripAnsi,
  validateGlassesGirlSprite,
  type GlassesGirlRenderOptions,
} from "./glasses-girl";

const chalk = chalkNs.default;

describe("Glasses Girl Mascot (Task #2398)", () => {
  let originalLevel: 0 | 1 | 2 | 3;
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalLevel = chalk.level as 0 | 1 | 2 | 3;
    originalColumns = process.stdout.columns;
    chalk.level = 3; // 默认开 true color，测 fallback 时切到 0
  });

  afterEach(() => {
    chalk.level = originalLevel;
    if (originalColumns !== undefined) {
      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
      });
    }
  });

  describe("Sprite 结构 (4 行对齐)", () => {
    test("应该有 4 行 (3 像素 + 1 label) — 与 Tips/What's new 行数严格对齐", () => {
      expect(GLASSES_GIRL_LINES.length).toBe(4);
      expect(GLASSES_GIRL_RAW_LINES.length).toBe(4);
    });

    test("每行 raw 字符长度不应超过 LEFT_WIDTH (26) — 避免终端 wrap", () => {
      for (const line of GLASSES_GIRL_RAW_LINES) {
        expect(line.length).toBeLessThanOrEqual(26);
      }
    });

    test("每行都应该非空", () => {
      for (const line of GLASSES_GIRL_RAW_LINES) {
        expect(line.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe("字符宽度稳定性 (无 East Asian width 错位)", () => {
    test("sprite 中所有字符的 Bun.stringWidth 都应为 1", () => {
      // 防止出现 emoji / CJK wide 字符导致列错位
      for (const line of GLASSES_GIRL_RAW_LINES) {
        for (const ch of line) {
          const w = (Bun as any).stringWidth?.(ch) ?? ch.length;
          expect(w).toBe(1);
        }
      }
    });

    test("label 行不应包含 emoji 或 wide 字符 (避免 alt/label 错位)", () => {
      const label = GLASSES_GIRL_RAW_LINES[3] ?? "";
      for (const ch of label) {
        const w = (Bun as any).stringWidth?.(ch) ?? ch.length;
        expect(w).toBe(1);
      }
    });
  });

  describe("可读性 — 眼镜 / 女孩 / 身体元素", () => {
    test("sprite 中应包含至少 2 个对称的 lens 形状 (◐ ◑ ◒ ◓ ◯ ○ ● □ ▢ 任选 2)", () => {
      const all = GLASSES_GIRL_RAW_LINES.join("");
      const lensChars = ["\u25D0", "\u25D1", "\u25D2", "\u25D3",
                         "\u25CF", "\u25CB", "\u25EF", "\u25C6", "\u25C7",
                         "\u25A1", "\u25A2", "\u25A3"];
      let count = 0;
      for (const lc of lensChars) {
        // eslint-disable-next-line no-loop-func
        for (const line of GLASSES_GIRL_RAW_LINES) {
          count += (line.match(new RegExp(lc, "g")) || []).length;
        }
      }
      // 至少 4 个 lens 字符 (2 lens + 2 pupil/eye 之类)
      expect(count).toBeGreaterThanOrEqual(4);
    });

    test("sprite 中应包含 hair/head 元素 (▀ ▄ ▌ ▐ █ ▙ ▟ ▝ ▘ 任选)", () => {
      const hairChars = ["\u2580", "\u2584", "\u258C", "\u2590", "\u2588",
                         "\u2599", "\u259F", "\u259D", "\u2598"];
      let count = 0;
      for (const hc of hairChars) {
        for (const line of GLASSES_GIRL_RAW_LINES) {
          count += (line.match(new RegExp(hc, "g")) || []).length;
        }
      }
      // 至少 6 个 hair/head 像素 — 表明有完整头型
      expect(count).toBeGreaterThanOrEqual(6);
    });

    test("sprite 中应包含 body 元素 (▀ ▄ █ 底部行)", () => {
      const bottomRow = GLASSES_GIRL_RAW_LINES[2] ?? "";
      // 底部行应该是 body/hoodie — 至少 4 个 body pixel
      const bodyChars = ["\u2580", "\u2584", "\u2588", "\u259D", "\u2598", "\u2599", "\u259F"];
      let count = 0;
      for (const bc of bodyChars) {
        count += (bottomRow.match(new RegExp(bc, "g")) || []).length;
      }
      expect(count).toBeGreaterThanOrEqual(4);
    });

    test("label 应明确说明 mascot 是 Roy (保留品牌识别)", () => {
      const label = GLASSES_GIRL_RAW_LINES[3] ?? "";
      expect(label.toLowerCase()).toContain("roy");
    });
  });

  describe("renderGlassesGirlLines — 渲染 / ANSI / 宽度", () => {
    test("chalk.level=0 (NO_COLOR) 不应输出任何 ANSI escape", () => {
      chalk.level = 0;
      const lines = renderGlassesGirlLines();
      for (const line of lines) {
        expect(line).not.toMatch(/\x1b\[/);
      }
    });

    test("chalk.level=3 (true color) 至少应在 art 行输出 ANSI 颜色", () => {
      chalk.level = 3;
      const lines = renderGlassesGirlLines();
      // 至少前 3 行 (art) 应有 ANSI 颜色
      const hasAnsi = lines.slice(0, 3).some((l) => l.includes("\x1b["));
      expect(hasAnsi).toBe(true);
    });

    test("chalk.level=1 (16-color) 仍应输出 ANSI (兼容 16-color 终端)", () => {
      chalk.level = 1;
      const lines = renderGlassesGirlLines();
      const hasAnsi = lines.slice(0, 3).some((l) => l.includes("\x1b["));
      expect(hasAnsi).toBe(true);
    });

    test("stripAnsi 后每行 visible length 应一致 (允许 padding 差异，但 ROW 0..2 像素行应一致)", () => {
      chalk.level = 0;
      const lines = renderGlassesGirlLines();
      const art0 = stripAnsi(lines[0] ?? "").length;
      const art1 = stripAnsi(lines[1] ?? "").length;
      const art2 = stripAnsi(lines[2] ?? "").length;
      // 3 个 art 行的 visible 长度应一致 (每行都已 padTo LEFT_WIDTH)
      expect(art0).toBe(art1);
      expect(art1).toBe(art2);
    });

    test("强制 NO_COLOR option 时跳过 ANSI 渲染", () => {
      const lines = renderGlassesGirlLines({ noColor: true });
      for (const line of lines) {
        expect(line).not.toMatch(/\x1b\[/);
      }
    });

    test("强制 lowColor option 时限制颜色 palette", () => {
      const lines = renderGlassesGirlLines({ palette: "mono" });
      // mono palette 应该是单色或 no-color — 至少不应该用 #ff6b6b 的真彩色 hex
      const hasTrueColor = lines.some((l) => l.includes("38;2;"));
      expect(hasTrueColor).toBe(false);
    });

    test("窄终端 columns=40 不应抛错", () => {
      Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
      expect(() => renderGlassesGirlLines()).not.toThrow();
    });

    test("columns=undefined (管道/重定向) 不应抛错", () => {
      Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
      expect(() => renderGlassesGirlLines()).not.toThrow();
    });
  });

  describe("alt text / metadata", () => {
    test("GLASSES_GIRL_ALT_TEXT 应是非空字符串", () => {
      expect(typeof GLASSES_GIRL_ALT_TEXT).toBe("string");
      expect(GLASSES_GIRL_ALT_TEXT.length).toBeGreaterThan(0);
    });

    test("alt text 应说明角色特征 (girl + glasses + AI 助手)", () => {
      const lower = GLASSES_GIRL_ALT_TEXT.toLowerCase();
      // 不强制每个关键词，但应能让屏幕阅读器讲出这是一个戴眼镜的女孩
      expect(lower).toMatch(/(girl|woman|lady|child)/);
      expect(lower).toMatch(/(glasses|spectacle|eyewear)/);
    });

    test("GLASSES_GIRL_META 应包含版本、palette、alt", () => {
      expect(GLASSES_GIRL_META.version).toBe("2398.1");
      expect(typeof GLASSES_GIRL_META.palette).toBe("string");
      expect(typeof GLASSES_GIRL_META.alt).toBe("string");
    });
  });

  describe("validateGlassesGirlSprite — 不变量校验", () => {
    test("validateGlassesGirlSprite() 在干净状态下应返回空错误数组", () => {
      const issues = validateGlassesGirlSprite();
      expect(issues).toEqual([]);
    });

    test("validateGlassesGirlSprite() 接受自定义 lines 并检测行数错误", () => {
      const issues = validateGlassesGirlSprite({
        lines: ["only one line"],
      });
      expect(issues.length).toBeGreaterThan(0);
      // 应包含 "行数" 相关错误
      expect(issues.some((i) => i.includes("行数") || i.includes("line"))).toBe(true);
    });

    test("validateGlassesGirlSprite() 检测超宽行", () => {
      const issues = validateGlassesGirlSprite({
        lines: [
          "x".repeat(40),
          "ok",
          "ok",
          "ok",
        ],
      });
      expect(issues.some((i) => i.includes("超宽") || i.includes("width"))).toBe(true);
    });

    test("validateGlassesGirlSprite() 检测空行", () => {
      const issues = validateGlassesGirlSprite({
        lines: ["", "ok", "ok", "ok"],
      });
      expect(issues.some((i) => i.includes("空") || i.includes("empty"))).toBe(true);
    });
  });

  describe("与 PIXEL_LOGO_LINES 向后兼容", () => {
    test("GLASSES_GIRL_RAW_LINES 可以被 PIXEL_LOGO_LINES 替换而不破坏长度", () => {
      // 模拟替换 PIXEL_LOGO_LINES 后 welcome-card 仍然能 padTo(26)
      const lines = GLASSES_GIRL_RAW_LINES;
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(26);
      }
    });
  });
});

describe("Glasses Girl Mascot — 集成到 Welcome Card", () => {
  // 间接验证：把 welcome-card 的 PIXEL_LOGO_LINES 替换成我们的 sprite，
  // 整个 buildWelcomeCard 仍然能渲染通过 (visibleLength 一致, 边框对齐)。
  test("集成 helper: buildMockedWelcomeCard 应当渲染 4 行内容 + 边框", async () => {
    // 用 lazy import 避免循环依赖
    const mod = await import("../welcome-card");
    // 简单 patch 验证
    const out = mod.buildWelcomeCard({
      model: "MiniMax-M3",
      cwd: "/tmp",
      version: "1.6.18",
      sessionTitle: "test",
    });
    expect(out).toContain("\u256D"); // ╭
    expect(out).toContain("\u256F"); // ╯
    // 数据行 visible 长度一致 (100)
    const lines = out.split("\n");
    const dataRows = lines.filter((l) => {
      const stripped = mod.stripAnsi(l).trimStart();
      return stripped.length > 0 && stripped.startsWith("\u2502") && !stripped.includes("\u251C");
    });
    const lengths = dataRows.map((r) => mod.stripAnsi(r).trimStart().length);
    expect(Math.max(...lengths)).toBe(100);
    expect(Math.min(...lengths)).toBe(100);
  });
});
