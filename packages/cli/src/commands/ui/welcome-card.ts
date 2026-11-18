/**
 * @fileoverview Welcome Card — Claude Code 风格启动欢迎卡
 *
 * Task #2252: 改造点 1 (欢迎卡) + 改造点 6 (像素 logo)
 * Task #2262: 第二轮打磨 — Tips/What's new 双列视觉分离 + 居中布局
 *
 * 设计灵感：Claude Code TUI 启动时显示的 ╭───╮...╰───╯ 圆角框，
 * 内含 左侧 (logo + 模型 + cwd) + 中间 Tips + 右侧 What's new 三列，
 * 列与列之间用 box-drawing 分隔符 (│) 清晰分隔。
 *
 * 实现方式：
 *   - 用 box-drawing 字符 (╭─╮│╰╯├┤) 拼出圆角外框 + 中间垂直分隔线
 *   - 用 ANSI SGR 着色 (moved to COLORS.primary/secondary/accent)
 *   - 像素 logo：3 行半色调块图 ("Roy" 小吉祥物)
 *   - 全部用纯字符串拼接（不依赖 clack 的 `intro` API，因为 clack 会自动 exit process，
 *     对 readline 循环的 TUI 不可靠）
 *   - 精确 visibleLength 计算（strip ANSI）确保列宽严格对齐
 *   - 居中布局：按 process.stdout.columns 计算左右 padding
 */

import chalk from "chalk";
import { COLORS } from "../../services/stream-output.service";
import { GLASSES_GIRL_RAW_LINES } from "./mascot/glasses-girl";

/**
 * 像素 logo（"Roy" 小吉祥物 — 4 行块字符）
 *
 * Task #2264 P2: 扩展到 4 行以便与 Tips(4) / What's new(4) 严格对齐。
 * 之前 3 行 + meta info 导致左侧多行而 Tips/Whats 列提前结束，产生悬空。
 * 现在 4 行 logo + 4 行 Tips + 4 行 What's new = 严格 4 行内容对齐。
 *
 * Task #2398: 重设计为「戴眼镜的小女孩」(glasses-wearing little girl)。
 * 原 sprite 是珊瑚粉像素怪物/机器人，被替换为更友好、更智能的角色，
 * 兼容品牌色 + 有限辅色，并提供 NO_COLOR / 窄终端 fallback。
 * 实现见 packages/cli/src/commands/ui/mascot/glasses-girl.ts。
 *
 * PIXEL_LOGO_LINES 保留为对外 API（tests 引用）；内部从 GLASSES_GIRL_RAW_LINES 取值。
 */
export const PIXEL_LOGO_LINES: readonly string[] = GLASSES_GIRL_RAW_LINES;

/**
 * Tips 行（中间列）
 *
 * 每条 tip 是一个 shell 命令 + 简短说明。
 * 保持纯文本，方便测试。
 */
export const TIPS_LINES: readonly string[] = [
  "/help    Show all commands",
  "/init    Create memory file",
  "/model   Switch model",
  "/compact Compress context",
] as const;

/**
 * What's new 行（右列）
 *
 * Task #2264: 修剪到 4 条以便与 Tips 列 (4 条) 严格行对齐。
 * 原 6 条导致第三列悬浮 — Tips 4 行结束 + What's new 6 行继续 → Logo 列悬空。
 * 现在 Tips=4 / Whats=4 / Left info=4 — 三列严格行对齐。
 */
export const WHATS_NEW_LINES: readonly string[] = [
  "\u2605 Welcome card    with tips",
  "\u2605 Input slot      with borders",
  "\u2605 Status bar      multi-segment",
  "\u2593 Pixel logo      Roy mascot",
] as const;

export interface WelcomeCardContext {
  /** 后端模型名 (e.g. "MiniMax-M3") */
  model: string;
  /** 当前工作目录（绝对路径） */
  cwd: string;
  /** roy-bot 版本号 */
  version: string;
  /** session title (会话名) */
  sessionTitle: string;
}

/**
 * 内部 helper：把一个 string 的可见宽度算出来。
 * 关键：要 strip ANSI 转义码后再算 length，否则带颜色的字符串 length > 可见长度，
 * 会被错误截断（e.g. "Model: XYZ" 17 chars + 6 ANSI = 23 chars，但可见只有 17）。
 */
function visibleLength(s: string): number {
  // strip ANSI escape: \x1b[...m  +  OSC: \x1b]...\x07
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * 把字符串补齐到指定可见宽度（左侧用 ANSI 转义码包的颜色不影响补齐）。
 */
function padTo(s: string, width: number): string {
  const vl = visibleLength(s);
  if (vl >= width) {
    // 简化：超过 width 时按 visible 字符截断（剥 ANSI 后 slice）。
    // eslint-disable-next-line no-control-regex
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
    return stripped.slice(0, width);
  }
  return s + " ".repeat(width - vl);
}

/**
 * strip ANSI 转义码（让测试可以做纯文本断言）。
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 居中布局的左右 padding。
 * 如果 stdout 没有 columns（管道/重定向），返回 0（贴左布局，保留原行为）。
 */
export function centerPadding(frameWidth: number): { left: number } {
  const cols = process.stdout.columns ?? 0;
  if (cols <= 0 || cols <= frameWidth + 2) return { left: 0 };
  return { left: Math.floor((cols - frameWidth) / 2) };
}

/**
 * 构造欢迎卡。
 *
 * 输出格式（无 ANSI 时，左对齐版 ≈ 居中版的简化示意）：
 * ```
 * ╭─ Roy Interactive vX.Y.Z ─────────────────────────────────────────────╮
 * │  ▐▛███▜▌       │  Tips            │  What's new                     │
 * │  ▝▜███▛▘       │  /help    ...    │  ★ Welcome card with tips       │
 * │    ▔▔▔         │  /init    ...    │  ★ Input slot with borders      │
 * │  Model: XYZ    │  /model   ...    │  ★ Status bar at bottom         │
 * │  cwd: /a/b     │  /compact ...    │  ● Status dot instead of ...    │
 * │  v1.6.13       │                  │  ▓ Pixel logo Roy mascot        │
 * │  session: foo  │                  │                                 │
 * ╰────────────────────────────────────────────────────────────────────────╯
 * ```
 *
 * @param ctx WelcomeCardContext
 * @returns 完整的多行 ANSI 字符串（已含居中 padding）
 */
export function buildWelcomeCard(ctx: WelcomeCardContext): string {
  const FRAME_WIDTH = 100;
  const INNER_WIDTH = FRAME_WIDTH - 2; // 不含左右 │

  // 三列宽度（精确）：
  //   LEFT_WIDTH  = logo / model / cwd / version / session 信息（26 字符）
  //   TIPS_WIDTH  = Tips 命令列表（28 字符 — "/help    Show all commands" = 28）
  //   WHATS_WIDTH = What's new 列表（38 字符 — "● Status dot instead of spinner" 35）
  // 中间用 3 个空格作为列间距（每个 " │ " 占 3 字符：空格 + 分隔符 + 空格）
  const LEFT_WIDTH = 26;
  const TIPS_WIDTH = 28;
  const COL_GAP = 3; // " │ "
  const WHATS_WIDTH = INNER_WIDTH - LEFT_WIDTH - TIPS_WIDTH - COL_GAP * 2;

  // 顶部横框：╭─ <title> ─...─╮
  // Task #2262 P2: 标题下划线用 accent (暖红) 贯穿品牌色 — 边框 + 标题文本统一 accent
  const titleText = ` Roy Interactive v${ctx.version} `;
  const titleDashes = "─".repeat(Math.max(0, FRAME_WIDTH - 2 - titleText.length));
  const topFrame = COLORS.accent("\u256D\u2500" + titleText + titleDashes + "\u256E");

  // 底框：同样用 accent 贯穿品牌色
  const bottomFrame = COLORS.accent("\u2570" + "\u2500".repeat(FRAME_WIDTH - 2) + "\u256F");

  // Task #2264 P2: 不再使用居中分隔线 — 三列严格 4 行对齐，无悬空
  // 之前的 sepLine (├...┼...┤) 因为 Tips=4 行结束而悬空，已删除

  // 列头（tips / what's new）
  const tipsHeader = COLORS.accentBold("Tips");
  const whatsHeader = COLORS.accentBold("What's new");

  // Tips 行（padEnd 严格对齐到 TIPS_WIDTH）
  const tipsPadded = TIPS_LINES.map((t) => padTo(t, TIPS_WIDTH));

  // What's new 行（padEnd 严格对齐到 WHATS_WIDTH；超长则截断）
  const whatsPadded = WHATS_NEW_LINES.map((w) => padTo(w, WHATS_WIDTH));

  // 中间主体（不计入 top/bottom）
  const lines: string[] = [];

  // 渲染每一行（左右 │ + 中间 │ 分隔三列）
  // 自动 padTo 三个列（确保空 cell 也填满宽度）
  const renderRow = (
    left: string,
    tips: string,
    whats: string,
  ): string => {
    return (
      COLORS.muted("\u2502") +
      padTo(left, LEFT_WIDTH) +
      COLORS.muted(" \u2502 ") +
      padTo(tips, TIPS_WIDTH) +
      COLORS.muted(" \u2502 ") +
      padTo(whats, WHATS_WIDTH) +
      COLORS.muted("\u2502")
    );
  };

  // 行序：列头 → 4 行内容（logo + tips + whats 严格 4 行对齐）
  // Task #2264 P2: 移除中间的 ─────── 分割线，让 3 列在每个数据行都有内容
  // 之前 Tips=4 行提前结束、Left meta=4 行继续 → Logo 列悬空
  // 现在 Logo=4 / Tips=4 / Whats=4 → 严格对齐，无悬空
  const orderedRows: Array<{ left: string; tips: string; whats: string; sep?: boolean }> = [
    { left: "", tips: tipsHeader, whats: whatsHeader },
    { left: COLORS.accent(PIXEL_LOGO_LINES[0] ?? ""), tips: tipsPadded[0] ?? "", whats: whatsPadded[0] ?? "" },
    { left: COLORS.accent(PIXEL_LOGO_LINES[1] ?? ""), tips: tipsPadded[1] ?? "", whats: whatsPadded[1] ?? "" },
    { left: COLORS.accent(PIXEL_LOGO_LINES[2] ?? ""), tips: tipsPadded[2] ?? "", whats: whatsPadded[2] ?? "" },
    { left: COLORS.accent(PIXEL_LOGO_LINES[3] ?? ""), tips: tipsPadded[3] ?? "", whats: whatsPadded[3] ?? "" },
  ];

  for (const row of orderedRows) {
    lines.push(renderRow(row.left, row.tips, row.whats));
  }

  // 居中 padding：每行加 N 个前导空格
  const { left: pad } = centerPadding(FRAME_WIDTH);
  const padding = " ".repeat(pad);

  // Task #2274 P1: 删除底部冗余 infoFooter（model/cwd/version/session）。
  // 原因：底部状态栏已展示 model/cwd/git，重复显示视觉冗余。
  // 欢迎卡表格内的 Model/cwd/v/session 列保留（启动元信息展示）。
  // 如果以后想恢复，留作注释参考：
  //   const infoFooter: string[] = [];
  //   infoFooter.push(
  //     infoPadding +
  //       COLORS.primary(`model: ${ctx.model}`) + ...,
  //   );
  //   return [..., ...infoFooter, ""];

  return [
    padding + topFrame,
    ...lines.map((l) => padding + l),
    padding + bottomFrame,
    "", // 末尾空行（让 REPL prompt 不紧贴边框）
  ].join("\n");
}
/**
 * 打印欢迎卡到 stdout（直接 console.log 整块）。
 */
export function printWelcomeCard(ctx: WelcomeCardContext): void {
  console.log(buildWelcomeCard(ctx));
}

// re-export chalk for tests
export { chalk };