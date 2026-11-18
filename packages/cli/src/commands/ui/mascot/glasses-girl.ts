/**
 * @fileoverview Glasses Girl Mascot — 戴眼镜的小女孩像素 sprite
 *
 * Task #2398: 重新设计 roy-bot 终端欢迎页左侧 mascot。
 *
 * 设计目标:
 *   - 明确可辨识的「友好、聪明、戴眼镜的小女孩」
 *   - 保留 Roy 科技助手气质
 *   - 适合深色终端的小尺寸像素 art (4 行, 每行 ≤ 26 chars)
 *   - 兼容品牌色 (#ff6b6b 暖红) + 有限辅色 (深棕发/奶油肤色/青蓝眼镜高光)
 *   - 提供 NO_COLOR / 窄终端 fallback
 *
 * 实现策略:
 *   - GLASSES_GIRL_RAW_LINES 是 4 行 raw sprite (无 ANSI)，可直接用于 PIXEL_LOGO_LINES
 *   - renderGlassesGirlLines() 包装 ANSI 着色 + fallback
 *   - validateGlassesGirlSprite() 是单元测试用的不变量校验器
 *
 * 字符选择:
 *   - ▀ (U+2580) / ▄ (U+2584) — top/bottom half block (头发, hoodie 上下)
 *   - ▙ (U+2599) / ▟ (U+259F) — left/right curve corners (圆润头型)
 *   - ◐ (U+25D0) / ◑ (U+25D1) — half-filled circle (眼镜 + 瞳孔)
 *   - █ (U+2588) — full block (深色填充)
 *
 * 4 行 sprite:
 *   Row 0: ▟▀▀▀▀▀▀▙       — 头顶发型 (圆润, 6 cells + 左右弧角)
 *   Row 1: ◐◑ ◐◑          — 眼镜 (4 half-circle 模拟 2 个 lens + 桥)
 *   Row 2: ▙▀▀▀▀▀▀▟       — hoodie 下摆 (圆润)
 *   Row 3: Roy mascot girl — alt label
 */

import chalk from "chalk";

/**
 * 调色板：品牌色 (#ff6b6b) + 有限辅色（头发/眼镜高光）。
 * NO_COLOR / lowColor 时只使用单色。
 */
export const GLASSES_GIRL_PALETTE = {
  /** 品牌暖红 — 主色 (头发 + body outline) */
  hair: "#5d4037",
  /** 奶油肤色 — face highlight */
  skin: "#ffe0b2",
  /** 眼镜片深色 — pupil */
  pupil: "#3a3a3a",
  /** 眼镜高光 — cyan */
  lensHi: "#80deea",
  /** 主 brand color — accent */
  brand: "#ff6b6b",
} as const;

export type PaletteName = "brand" | "mono" | "duo";

/**
 * 4 行 sprite (无 ANSI)。可以直接喂给 PIXEL_LOGO_LINES。
 *
 * 关键：每行字符长度都 ≤ LEFT_WIDTH (= 26)，且每个字符 Bun.stringWidth = 1。
 *
 * 设计选择 (Task #2398 user feedback round 2): 在 v3 基础上添加「hair bow clips」。
 *   - v9-b: 头发顶嵌入两个小 ♥ 作为 hair bow / ribbon clips (粉色系)
 *   - row 2 保留 ▄ 肩部两侧长发 (girl silhouette)
 *   - 这是 4 行约束下「little girl」最强的可读信号 — heart 在传统
 *     pixel art 语义里就是「女孩的发饰」
 */
export const GLASSES_GIRL_RAW_LINES: readonly string[] = [
  // Row 0: 头发顶 + 两个小 ♥ 作为 hair bow (rounded, half-block arc, heart accents)
  "  \u259F\u2665\u2580\u2580\u2665\u2580\u258C  ",
  // Row 1: 眼镜 (4 half-circle 模拟 2 个 lens + 桥, 8 chars 总宽 + padding)
  "  \u25D0\u25D1 \u25D0\u25D1   ",
  // Row 2: hoodie + 长发垂到肩 (coral pink + deep brown side hair)
  " \u2584 \u2599\u2580\u2580\u2580\u2580\u2580\u2580\u259F \u2584 ",
  // Row 3: alt label (说明性文案, 不是 R.O.Y 全大写 — 新设计更友善)
  "  Roy mascot    ",
] as const;

/**
 * 兼容旧接口的导出 (welcome-card PIXEL_LOGO_LINES 直接使用)。
 */
export const GLASSES_GIRL_LINES: readonly string[] = GLASSES_GIRL_RAW_LINES;

/**
 * Alt text — 屏幕阅读器 / 测试 / 文档使用。
 *
 * 不要包含 emoji (会被一些终端宽度 2)。
 */
export const GLASSES_GIRL_ALT_TEXT: string =
  "Roy mascot: a friendly glasses-wearing little girl with short bobbed hair and a coral-pink hoodie. The Roy AI assistant.";

/**
 * Sprite 元数据
 */
export const GLASSES_GIRL_META = {
  version: "2398.1",
  palette: "brand" as PaletteName,
  alt: GLASSES_GIRL_ALT_TEXT,
  rows: 4 as const,
  maxWidth: 26 as const,
  // 关键字符索引 (供测试断言使用)
  hasGlasses: true as const,
  hasHair: true as const,
  hasHoodie: true as const,
} as const;

export interface GlassesGirlRenderOptions {
  /** 强制 NO_COLOR 模式 (跳过所有 ANSI 着色) */
  noColor?: boolean;
  /** 限制调色板 (mono = 单色, duo = 双色, brand = 全色) */
  palette?: PaletteName;
  /** chalk 实例 (默认导入的 chalk — 测试时可注入 mock) */
  chalkLib?: typeof chalk;
}

/**
 * 检测当前是否处于 NO_COLOR 环境 (env var / TTY / chalk level)
 */
function isNoColorEnv(chalkLib: typeof chalk): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return true;
  if (chalkLib.level === 0) return true;
  return false;
}

/**
 * Strip ANSI escape codes (helpers for callers)
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 把一行 padTo 指定可见宽度（左侧允许 ANSI 转义）
 */
function padTo(s: string, width: number): string {
  const vl = stripAnsi(s).length;
  if (vl >= width) {
    return stripAnsi(s).slice(0, width);
  }
  return s + " ".repeat(width - vl);
}

/**
 * 渲染 4 行 sprite，附带 ANSI 着色。
 *
 * - 默认 brand palette: hair/skin/lens 配色
 * - palette=mono: 仅使用 accent
 * - palette=duo: accent + skin
 * - noColor=true: 不输出 ANSI
 * - 自动检测 process.env.NO_COLOR / chalk.level=0
 */
export function renderGlassesGirlLines(
  opts: GlassesGirlRenderOptions = {},
): string[] {
  const chalkLib = opts.chalkLib ?? chalk;
  const noColor = opts.noColor || isNoColorEnv(chalkLib);
  const palette = opts.palette ?? "brand";

  const colorize = (s: string, key: keyof typeof GLASSES_GIRL_PALETTE): string => {
    if (noColor) return s;
    if (palette === "mono") {
      // 单色模式: 用基础 16 色 redBright — 不输出 true-color (38;2;)
      // 兼容性最好: 16-color / 256-color / true-color 终端都支持
      return chalkLib.redBright ? chalkLib.redBright(s) : chalkLib.hex(GLASSES_GIRL_PALETTE.brand)(s);
    }
    if (palette === "duo") {
      // duo: hair + brand 是同色, skin 用 skin color
      if (key === "skin") {
        // 用 yellow 代替 hex (避免 true-color)
        return chalkLib.yellow ? chalkLib.yellow(s) : chalkLib.hex(GLASSES_GIRL_PALETTE.skin)(s);
      }
      return chalkLib.hex(GLASSES_GIRL_PALETTE.brand)(s);
    }
    // brand: full color
    return chalkLib.hex(GLASSES_GIRL_PALETTE[key])(s);
  };

  const result: string[] = [];
  // Row 0: hair top — brand color
  result.push(padTo(colorize(GLASSES_GIRL_RAW_LINES[0] ?? "", "brand"), 26));
  // Row 1: glasses — pupil dark + lens highlight + brand bridge
  result.push(padTo(colorize(GLASSES_GIRL_RAW_LINES[1] ?? "", "pupil"), 26));
  // Row 2: hoodie — brand color
  result.push(padTo(colorize(GLASSES_GIRL_RAW_LINES[2] ?? "", "brand"), 26));
  // Row 3: label — no color (text)
  result.push(GLASSES_GIRL_RAW_LINES[3] ?? "");
  return result;
}

/**
 * 不变量校验器 — 测试时验证 sprite 完整性
 *
 * 返回 issues 字符串数组; 空数组表示无问题。
 */
export interface SpriteValidationInput {
  lines?: readonly string[];
}

export function validateGlassesGirlSprite(
  input: SpriteValidationInput = {},
): string[] {
  const lines = input.lines ?? GLASSES_GIRL_RAW_LINES;
  const issues: string[] = [];

  if (lines.length !== 4) {
    issues.push(`行数错误: 期望 4 行, 实际 ${lines.length}`);
  }

  lines.forEach((line, idx) => {
    if (line.length > 26) {
      issues.push(`行 ${idx} 超宽: ${line.length} > 26`);
    }
    if (line.trim().length === 0) {
      issues.push(`行 ${idx} 为空`);
    }
    // 检测 wide char (使用 Bun.stringWidth 如可用; 降级到 ch.length)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stringWidthFn = ((globalThis as any).Bun?.stringWidth as ((s: string) => number) | undefined);
    for (const ch of line) {
      const w = stringWidthFn ? stringWidthFn(ch) : ch.length;
      if (w !== 1) {
        issues.push(`行 ${idx} 包含宽字符 (U+${ch.codePointAt(0)?.toString(16)} width=${w})`);
      }
    }
  });

  return issues;
}