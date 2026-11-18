/**
 * @fileoverview Task #5077 P3 Phase 2 — **滚动条配置模块**（纯函数）。
 *
 * ## 为什么独立成模块
 *
 * opentui 0.6.6 的 `<scrollbox>` 支持内建纵向滚动条
 * （`verticalScrollbarOptions`），但**默认关闭**（不传就不渲染）。
 * 对齐 opencode 的视觉（`routes/session/index.tsx:1508-1517`）：
 *
 * ```jsx
 * viewportOptions={{ paddingRight: showScrollbar() ? 1 : 0 }}
 * verticalScrollbarOptions={{
 *   paddingLeft: 1,
 *   visible: showScrollbar(),
 *   trackOptions: {
 *     backgroundColor: theme.decrease(theme.background.raised.base),
 *     foregroundColor: theme.border.base,
 *   },
 * }}
 * ```
 *
 * 本模块把「要不要滚」/「配色」/「间距」收成**可单测的纯函数**，
 * App.tsx 只负责接线（可被集成测试变异验证承重）。
 *
 * ## 滚动条字形实测（opentui native 层）
 *
 * 滑块画在**最右 1 列**，用半块字形（上半块 `▀` / 下半块 `▄`）
 * 表示滑块头/尾，随 `scrollTop` 连续移动：
 *
 *   - 钉底（scrollTop = scrollHeight - viewport）→ 末行 `▄`
 *   - 中间态 → 对应行 `▀`
 *   - 顶部（scrollTop = 0）→ 首行 `▀`
 *
 * 内容不足一屏时 opentui 原生隐藏（`recalculateVisibility`：
 * `scrollSize <= viewportSize ⇒ visible=false`）——接线侧不需要
 * 手动开关 `visible`（但集成测试仍显式断言这一行为）。
 */
import { useTuiThemeReactive } from "./theme.js";


/**
 * 滚动条滑块前景色 —— Task #5086 P5：token 默认值是 `borderActive`
 * （dark #606060 / light #a0a0a0，opencode `theme.border.base` 量级）。
 * 常量保留仅为 import 兼容；`resolveScrollbarColors()` 无参调用时
 * 从主题读真实 token（DS r2 MINOR-1）。
 */
export const DEFAULT_SCROLLBAR_FOREGROUND_COLOR = "#606060";

/**
 * 滚动条 track 底色 —— Task #5086 P5：token 默认值是 `backgroundElement`
 * （dark #1e1e1e / light #f5f5f5，opencode `decrease(background.raised.base)` 量级）。
 * 常量保留仅为 import 兼容（DS r2 MINOR-1）。
 */
export const DEFAULT_SCROLLBAR_TRACK_BACKGROUND_COLOR = "#1e1e1e";

/** 默认滑块与内容列之间的呼吸距（opencode 同款 1 列）。 */
const DEFAULT_SCROLLBAR_PADDING = 1;

/** trackOptions 的配色结构（与 opentui `trackOptions` 同形子集）。 */
export interface ScrollbarTrackColors {
  backgroundColor: string;
  foregroundColor: string;
}

/**
 * 滚动条配色（默认取主题 token，显式传参以调用方为准）。
 *
 * Task #5086 P5 (DS r2 MINOR-1): 默认值从主题 token 解析
 * (`borderActive` / `backgroundElement`)，不再硬编码 dark 常量——
 * 无参调用在 light 模式下也能拿到正确的亮色滚动条。
 * `override` 显式传参仍优先（App.p3-scrollbar 测试用）。
 *
 * 注：theme.ts 不 import scrollbar.ts（无循环依赖），可安全静态引入。
 */
export function resolveScrollbarColors(override?: Partial<ScrollbarTrackColors>): ScrollbarTrackColors {
  const theme = useTuiThemeReactive();
  // Task #5086 P5 (DS r3 MAJOR-1): use `||` (not `??`) for the theme
  // fallback — in NO_COLOR mode the token is the EMPTY STRING, and
  // `??` would happily return "" ⇒ opentui parseColor("") paints the
  // scrollbar magenta + logs "Invalid hex color" every frame.
  // `||` treats "" as absent and falls back to the dark default.
  return {
    backgroundColor:
      override?.backgroundColor || theme.backgroundElement || DEFAULT_SCROLLBAR_TRACK_BACKGROUND_COLOR,
    foregroundColor:
      override?.foregroundColor || theme.borderActive || DEFAULT_SCROLLBAR_FOREGROUND_COLOR,
  };
}

/**
 * 滑块左侧呼吸距（列数，≥1 整数；非法值回落默认 1）。
 */
export function resolveScrollbarPadding(padding?: number): number {
  if (typeof padding !== "number" || !Number.isFinite(padding)) return DEFAULT_SCROLLBAR_PADDING;
  if (!Number.isInteger(padding) || padding < 1) return DEFAULT_SCROLLBAR_PADDING;
  return padding;
}

/**
 * 视口右内边距（给滚动条让位的列数）。
 *
 * 默认与滑块呼吸距相等（1 列）——滚动条占最右列，
 * 内容再右移 1 列才不会互相压字。
 */
export function resolveViewportPaddingRight(padding?: number): number {
  return resolveScrollbarPadding(padding);
}

/**
 * 「该不该显示滚动条」的显式判定（对齐 opentui `recalculateVisibility`）。
 *
 * - 内容 > 视口 ⇒ 可滚动 ⇒ 显示
 * - 内容 ≤ 视口 / 退化输入 ⇒ 隐藏
 *
 * 接线侧（App.tsx）目前依赖 opentui 原生行为即可；此函数用于
 * 集成测试断言 + 未来「强制开关」的守卫。
 */
export function computeScrollbarVisible(opts: {
  contentHeight: number;
  viewportHeight: number;
}): boolean {
  const { contentHeight, viewportHeight } = opts;
  if (typeof contentHeight !== "number" || !Number.isFinite(contentHeight)) return false;
  if (typeof viewportHeight !== "number" || !Number.isFinite(viewportHeight)) return false;
  if (viewportHeight <= 0) return false;
  return contentHeight > viewportHeight;
}
