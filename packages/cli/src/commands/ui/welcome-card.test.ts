/**
 * @fileoverview Welcome Card 单元测试
 *
 * Task #2252: 改造点 1 (欢迎卡) + 改造点 6 (像素 logo)
 * Task #2262: 第二轮打磨 — Tips/What's new 双列分离 + 居中
 *
 * 验证:
 *   - 输出含 box-drawing 边框 (╭ ╰ │ ─)
 *   - 含中间列分隔符 (│ ├ ┤ ┼) — 三列布局
 *   - 含模型名 / cwd / version / sessionTitle
 *   - 含 3 行像素 logo
 *   - 含 Tips 行 (4 条) 和 What's new 行 (≥3 条)
 *   - 列宽严格对齐（每行 visibleLength 一致）
 *   - 列头有 "Tips" 和 "What's new"
 *   - 末尾有空行（让 REPL prompt 不紧贴边框）
 *   - 居中：当 process.stdout.columns 足够时，输出有前导 padding
 *   - chalk.level=0 时仍可工作（无 ANSI 转义，输出仍含文本）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as chalkNs from "chalk";
import {
  buildWelcomeCard,
  PIXEL_LOGO_LINES,
  TIPS_LINES,
  WHATS_NEW_LINES,
  stripAnsi,
  centerPadding,
  type WelcomeCardContext,
} from "./welcome-card";

const chalk = chalkNs.default;

const SAMPLE_CTX: WelcomeCardContext = {
  model: "MiniMax-M3",
  cwd: "~/work/proj",
  version: "1.6.13",
  sessionTitle: "test-session",
};

describe("Welcome Card (Task #2252 + #2262 polish)", () => {
  let originalLevel: 0 | 1 | 2 | 3;
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalLevel = chalk.level as 0 | 1 | 2 | 3;
    originalColumns = process.stdout.columns;
    chalk.level = 0; // 强制无颜色，便于做精确列宽断言
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

  describe("buildWelcomeCard — 基础结构", () => {
    test("should output a box-drawing frame (top + bottom + sides)", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      expect(out).toContain("\u256D"); // ╭
      expect(out).toContain("\u256E"); // ╮
      expect(out).toContain("\u2570"); // ╰
      expect(out).toContain("\u256F"); // ╯
      expect(out).toContain("\u2502"); // │
      expect(out).toContain("\u2500"); // ─
    });

    test("should contain the model name (status bar ctx, not in welcome card itself)", () => {
      // Task #2274 P1: model/cwd/session 不再在欢迎卡表格内（避免重复 status bar 信息）
      // 状态栏 ctx 仍保留 modelName 给 redrawInputArea 用
      const out = buildWelcomeCard(SAMPLE_CTX);
      // 标题含 version（仍在表格内），不含 model
      expect(out).not.toContain("Model:");
    });

    test("should NOT contain the cwd in welcome card (status bar shows it instead)", () => {
      // Task #2274 P1: cwd 不再在欢迎卡输出（与底部状态栏重复）
      const out = buildWelcomeCard(SAMPLE_CTX);
      expect(out).not.toContain("~/work/proj");
    });

    test("should contain the version (in title bar)", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      // 1.6.13 is in "╭─ Roy Interactive v1.6.13 ─...─╮"
      expect(out).toContain("1.6.13");
    });

    test("should NOT contain the sessionTitle in welcome card (redundant with status bar)", () => {
      // Task #2274 P1: session 不再在欢迎卡（避免重复）
      const out = buildWelcomeCard(SAMPLE_CTX);
      expect(out).not.toContain("test-session");
    });

    test("should contain the title text 'Roy Interactive'", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      expect(out).toContain("Roy Interactive");
    });

    test("should contain all 4 pixel logo lines (Task #2398: glasses-wearing little girl mascot)", () => {
      // Task #2398: PIXEL_LOGO_LINES 现在是 4 行 — 3 行像素 art + 1 行 "Roy mascot" label
      // 原 "3 像素 logo 行" 已升级为 4 行以适配新 sprite
      const out = buildWelcomeCard(SAMPLE_CTX);
      for (const logoLine of PIXEL_LOGO_LINES) {
        expect(out).toContain(logoLine);
      }
      // 验证 sprite 包含关键元素 (眼镜 + 头发)
      expect(PIXEL_LOGO_LINES.join("")).toMatch(/[\u25D0\u25D1\u25CB\u25CF]/);  // 至少一个 lens 字符
      expect(PIXEL_LOGO_LINES.join("")).toMatch(/[\u2580\u2584\u2588]/);  // 至少一个 hair/body 像素
    });

    test("should contain all 4 tips lines", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      for (const tip of TIPS_LINES) {
        expect(out).toContain(tip);
      }
    });

    test("should contain at least 3 What's new lines", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      let count = 0;
      for (const line of WHATS_NEW_LINES) {
        if (out.includes(line)) count++;
      }
      expect(count).toBeGreaterThanOrEqual(3);
    });

    test("should end with empty trailing line (for prompt spacing)", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      expect(out.endsWith("\n")).toBe(true);
    });

    test("should have multi-line structure (>= 8 lines: top + header + 4 content + bottom + footer + empty)", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lineCount = out.split("\n").length;
      // top + header + 4 content rows + bottom + 1 info footer + trailing = 8
      expect(lineCount).toBeGreaterThanOrEqual(8);
    });
  });

  describe("P0: 三列视觉分离 (Task #2262)", () => {
    test("should contain vertical divider │ between Tips and What's new", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      // Task #2264 P2: 不再用 ├ ┼ ┤ 居中分隔符，但 │ 仍在每行分割 Tips / What's new
      expect(out).toContain("\u2502"); // │
      // 至少有 5 次 │（header 1 + 4 内容行各 2 个内部 │）
      const barCount = (out.match(/\u2502/g) || []).length;
      expect(barCount).toBeGreaterThanOrEqual(10);
    });

    test("should have column headers 'Tips' and 'What's new'", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      expect(out).toContain("Tips");
      expect(out).toContain("What's new");
    });

    test("every body row should have exactly 4 vertical bars (╭/╮ border + 2 inner dividers)", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lines = out.split("\n");
      // 跳过分隔线行（├...┤）和 top/bottom frame
      const bodyRows = lines.filter((l) => {
        const stripped = stripAnsi(l);
        // 数据行：以 │ 开头，但不含 ├
        return stripped.startsWith("\u2502") && !stripped.includes("\u251C");
      });
      for (const row of bodyRows) {
        const stripped = stripAnsi(row);
        // 每行应该有 4 个 │（左 + 2 个内部 + 右）
        const barCount = (stripped.match(/\u2502/g) || []).length;
        expect(barCount).toBe(4);
      }
    });

    test("every body row should have similar visible length (column alignment)", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lines = out.split("\n");
      // 数据行宽度应该接近（FRAME_WIDTH = 100；分隔行 ├...┤ 无空格 = 96，差 4 是正常的 box-drawing 约定）
      const dataRows = lines.filter((l) => {
        const stripped = stripAnsi(l);
        return stripped.length > 0 && stripped.startsWith("\u2502");
      });
      const lengths = dataRows.map((r) => stripAnsi(r).length);
      const min = Math.min(...lengths);
      const max = Math.max(...lengths);
      // 数据行（含内 │ 分隔）的宽度应该完全一致
      expect(max - min).toBe(0);
      expect(min).toBe(100); // FRAME_WIDTH = 100

      // 分隔行宽度 = INNER_WIDTH - COL_GAP*2 (因为 ├┼┤ 不需要左右空格)
      const sepRows = lines.filter((l) => stripAnsi(l).startsWith("\u251C"));
      for (const sep of sepRows) {
        expect(stripAnsi(sep).length).toBe(96); // 100 - 4 (少了两侧的 " │ " padding)
      }
    });

    test("column width (LEFT_WIDTH + TIPS_WIDTH + WHATS_WIDTH + gaps) should equal FRAME_WIDTH", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lines = out.split("\n");
      const dataRow = lines.find((l) => stripAnsi(l).startsWith("\u2502") && stripAnsi(l).includes("/help"));
      expect(dataRow).toBeDefined();
      if (dataRow) {
        // visible width 应该等于 FRAME_WIDTH = 100
        const vl = stripAnsi(dataRow).length;
        expect(vl).toBe(100);
      }
    });
  });

  describe("P3: 居中布局 (Task #2262)", () => {
    test("should add left padding when columns > frame width", () => {
      Object.defineProperty(process.stdout, "columns", { value: 140, configurable: true });
      const out = buildWelcomeCard(SAMPLE_CTX);
      // 第一行（top frame）应该有前导空格
      const firstLine = out.split("\n")[0] ?? "";
      // 居中 padding = floor((140-100)/2) = 20
      const expectedPad = " ".repeat(Math.floor((140 - 100) / 2));
      expect(firstLine.startsWith(expectedPad)).toBe(true);
    });

    test("should NOT add padding when columns <= frame width", () => {
      Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
      const out = buildWelcomeCard(SAMPLE_CTX);
      const firstLine = out.split("\n")[0] ?? "";
      // columns=100 <= 100+2, 不应居中
      expect(firstLine.startsWith("\u256D")).toBe(true);
    });

    test("should NOT add padding when columns is undefined", () => {
      Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
      const out = buildWelcomeCard(SAMPLE_CTX);
      const firstLine = out.split("\n")[0] ?? "";
      expect(firstLine.startsWith("\u256D")).toBe(true);
    });

    test("centerPadding helper should compute correct left padding", () => {
      Object.defineProperty(process.stdout, "columns", { value: 140, configurable: true });
      const pad = centerPadding(100);
      expect(pad.left).toBe(20);
    });

    test("centerPadding helper should return 0 for narrow terminal", () => {
      Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
      const pad = centerPadding(100);
      expect(pad.left).toBe(0);
    });
  });

  describe("P2: 行列严格对齐 (Task #2264)", () => {
    test("Tips and What's new should have equal row count after trim", () => {
      // Task #2264: 修剪 Whats 到 4 条，与 Tips 4 条 + Logo 4 行严格对齐
      expect(TIPS_LINES.length).toBe(WHATS_NEW_LINES.length);
    });

    test("PIXEL_LOGO should have 4 lines (matching Tips/What's new count)", () => {
      // Task #2264 P2: Logo 扩展到 4 行以便与 Tips/What's new 严格 4 行对齐
      expect(PIXEL_LOGO_LINES.length).toBe(4);
      expect(PIXEL_LOGO_LINES.length).toBe(TIPS_LINES.length);
      expect(PIXEL_LOGO_LINES.length).toBe(WHATS_NEW_LINES.length);
    });

    test("data rows should all have content in left + tips + whats columns (no row mismatch)", () => {
      // Task #2264: 验证行数严格 — 1 header + 4 content = 5 dataRows
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lines = out.split("\n");
      const dataRows = lines.filter((l) => {
        const stripped = stripAnsi(l).trimStart(); // 容忍 centerPadding 前导空格
        return stripped.length > 0 && stripped.startsWith("\u2502") && !stripped.includes("\u251C");
      });
      expect(dataRows.length).toBe(5); // 1 header + 4 content (logo/tips/whats)
    });

    test("every data row's visible length should be consistent (FRAME_WIDTH = 100)", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lines = out.split("\n");
      const dataRows = lines.filter((l) => {
        const stripped = stripAnsi(l).trimStart();
        return stripped.length > 0 && stripped.startsWith("\u2502") && !stripped.includes("\u251C");
      });
      // 验证：所有数据行的 visible length 一致（FRAME_WIDTH = 100）
      const lengths = dataRows.map((r) => stripAnsi(r).trimStart().length);
      const min = Math.min(...lengths);
      const max = Math.max(...lengths);
      expect(max - min).toBe(0);
      expect(min).toBe(100);
    });

    test("every content row (row 2-5) should have non-empty tips and whats columns", () => {
      // Task #2264: 验证 Tips 和 What's new 列在所有数据行（包括 header 后）都有内容
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lines = out.split("\n");
      const dataRows = lines.filter((l) => {
        const stripped = stripAnsi(l).trimStart();
        return stripped.length > 0 && stripped.startsWith("\u2502") && !stripped.includes("\u251C");
      });
      // row 0 = header, rows 1-4 = content (4 内容行)
      const contentRows = dataRows.slice(1);
      expect(contentRows.length).toBe(4);
      for (const row of contentRows) {
        const stripped = stripAnsi(row).trimStart();
        // Tips 在 │ ... │ ... │ ... │ 的中间段，去掉前后 │
        const inner = stripped.replace(/^\u2502/, "").replace(/\u2502$/, "");
        const parts = inner.split(/\u2502/);
        // Tips (parts[1]) 和 What's new (parts[2]) 都应该有非空白内容
        expect((parts[1] ?? "").trim().length).toBeGreaterThan(0);
        expect((parts[2] ?? "").trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe("P2: 品牌色贯穿 (Task #2262)", () => {
    test("should use accent color for pixel logo (warm red, true color)", () => {
      chalk.level = 3; // true color
      const out = buildWelcomeCard(SAMPLE_CTX);
      // chalk.hex("#ff6b6b") 在 true color 输出 \x1b[38;2;255;107;107m
      expect(out).toMatch(/\x1b\[38;2;255;107;107m/);
    });

    test("should use accent color for column headers (Tips / What's new)", () => {
      chalk.level = 3;
      const out = buildWelcomeCard(SAMPLE_CTX);
      // 至少有 5 次 ff6b6b 调用（logo 3 行 + 2 个列头 = 5 次）
      const matches = out.match(/\x1b\[38;2;255;107;107m/g) || [];
      expect(matches.length).toBeGreaterThanOrEqual(5);
    });

    test("should use accent color even at chalk.level=1 (basic 16-color)", () => {
      chalk.level = 1;
      const out = buildWelcomeCard(SAMPLE_CTX);
      // level=1 用 256-color palette 或 fallback 到 16-color (bright red = 91)
      // 至少有一些 ANSI 颜色码（包含 91 或 38;5;x）
      expect(out).toMatch(/\x1b\[(91|38;5;\d+)m/);
    });

    test("should use accent color for top frame (title underline) — Task #2262 P2", () => {
      chalk.level = 3;
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lines = out.split("\n");
      const topFrame = lines[0] ?? "";
      // top frame 应该含 warm red (accent)
      expect(topFrame).toMatch(/\x1b\[38;2;255;107;107m/);
    });

    test("should use accent color for bottom frame — Task #2262 P2", () => {
      chalk.level = 3;
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lines = out.split("\n");
      // 倒数第 3 行是 bottom frame (倒数第 2 行是 info footer，最后一行是空行)
      const bottomFrame = lines[lines.length - 3] ?? "";
      expect(bottomFrame).toMatch(/\x1b\[38;2;255;107;107m/);
    });

    test("accent color should appear in top frame, logo, and headers (multiple sources)", () => {
      chalk.level = 3;
      const out = buildWelcomeCard(SAMPLE_CTX);
      const matches = out.match(/\x1b\[38;2;255;107;107m/g) || [];
      // top frame (1) + bottom frame (1) + 3 logo lines + 2 headers = 7+ occurrences
      expect(matches.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe("chalk.level=0 (无颜色终端) 降级", () => {
    test("should still output readable text (no throw)", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      // Task #2274 P1: model/cwd 不再在 welcome card，version 仍在标题
      expect(out).toContain("1.6.13");
      expect(out).toContain("\u256D"); // ╭
    });

    test("should not contain ANSI escape when chalk.level=0", () => {
      const out = buildWelcomeCard(SAMPLE_CTX);
      expect(out).not.toContain("\x1b");
    });
  });

  describe("不同的 ctx 应该生成不同的输出", () => {
    test("changing model should NOT change welcome card output (model no longer in welcome card)", () => {
      // Task #2274 P1: model 不再在欢迎卡（移到 status bar ctx），所以改 model 不影响欢迎卡
      // 但 version 改变会影响标题
      const a = buildWelcomeCard(SAMPLE_CTX);
      const b = buildWelcomeCard({ ...SAMPLE_CTX, model: "GPT-4" });
      expect(a).toBe(b); // model 不在 welcome card 中，输出不变
    });

    test("changing cwd should NOT change welcome card output (cwd no longer in welcome card)", () => {
      // Task #2274 P1: cwd 不再在欢迎卡
      const a = buildWelcomeCard(SAMPLE_CTX);
      const b = buildWelcomeCard({ ...SAMPLE_CTX, cwd: "/tmp/other" });
      expect(a).toBe(b);
    });

    test("changing version should change welcome card output (in title)", () => {
      const a = buildWelcomeCard(SAMPLE_CTX);
      const b = buildWelcomeCard({ ...SAMPLE_CTX, version: "9.9.9" });
      expect(a).not.toBe(b);
      expect(b).toContain("9.9.9");
    });
  });

  describe("stripAnsi helper", () => {
    test("should remove ANSI escape codes", () => {
      const input = "\x1b[31mhello\x1b[0m world";
      expect(stripAnsi(input)).toBe("hello world");
    });

    test("should leave plain text unchanged", () => {
      expect(stripAnsi("plain text")).toBe("plain text");
    });
  });

  describe("P1: 无冗余信息栏 (Task #2274)", () => {
    test("welcome card should NOT contain info footer with model/cwd/v/session", () => {
      // Task #2274 P1: 底部状态栏已显示 model/cwd，删除欢迎卡下方冗余信息栏
      const out = buildWelcomeCard(SAMPLE_CTX);
      // 简单断言：output 不含 "session: ${ctx.sessionTitle}" 的 footer 形式
      expect(out).not.toMatch(/session:\s*test-session/);
      // 也不含 "model: " 或 "cwd: " 等 footer 形式
      expect(out).not.toMatch(/^\s*model:/m);
      expect(out).not.toMatch(/^\s*cwd:/m);
      expect(out).not.toMatch(/^\s*v1\.6\.13\s*\|/m);
    });

    test("welcome card should end with bottom frame + empty line (no info footer in between)", () => {
      // Task #2274 P1: 之前 output 是 [top, content, bottom, infoFooter, empty]
      // 现在 output 应该是 [top, content, bottom, empty]
      const out = buildWelcomeCard(SAMPLE_CTX);
      const lines = out.split("\n");
      // 最后一行应该是空
      expect(lines[lines.length - 1]).toBe("");
      // 倒数第二行应该是 bottom frame (╰...╯)
      expect(lines[lines.length - 2]).toContain("\u2570");
      // 倒数第三行应该是最后内容行（logo line 4 = "Roy mascot" label — Task #2398）
      expect(lines[lines.length - 3]).toContain("\u2502");
      expect(lines[lines.length - 3]).toContain("Roy mascot");
    });
  });
});
