/**
 * @fileoverview Task #5077 P3 Phase 2 — **键位滚动命令**模块。
 *
 * ## 对齐目标（opencode 双通道滚动的键盘通道）
 *
 * opencode `packages/tui/src/config/keybind.ts:181-188`：
 *
 * ```
 * session.page.up        pageup,ctrl+alt+b   半视口（scroll.height/2）
 * session.page.down      pagedown,ctrl+alt+f 半视口
 * session.line.up        ctrl+alt+y          1 行
 * session.line.down      ctrl+alt+e          1 行
 * session.half.page.up   ctrl+alt+u          ¼ 视口（scroll.height/4）
 * session.half.page.down ctrl+alt+d          ¼ 视口
 * session.first          ctrl+g,home         跳顶
 * session.last           ctrl+alt+g,end      跳底
 * ```
 *
 * （opencode 的消费：`routes/session/index.tsx:916-957` 的
 * `moveTranscript(±scroll.height/2 | ±1 | ±scroll.height/4)`。）
 *
 * ## 本仓的键位取舍（有注释依据）
 *
 * - **home/end 不收**：本仓 `<TextInput>` 把 home/end 用于
 *   **行内光标跳转**（TextInput.tsx:122-129）——用户在输入框打字时
 *   按 home/end 是想移动光标，不是滚动历史 ⇒ 这两个键位给输入框。
 *   跳顶/跳底用 opencode 的主别名键 **ctrl+g / ctrl+alt+g**。
 * - **ctrl+u / ctrl+d 收为半视口别名**：用户需求点名「Ctrl+u/Ctrl+d」
 *   （emacs 风格上下半页）；opencode 主键 ctrl+alt+u/d 同时保留。
 * - **shift 组合一律不路由**：shift+home/end 之类留给选区语义。
 *
 * ## 执行语义（直接复用 opentui ScrollBox.scrollBy 的单位制）
 *
 * opentui `ScrollBarRenderable.scrollBy(delta, unit)`：
 *
 * ```
 * multiplier = unit === "viewport" ? viewportSize
 *            : unit === "content"  ? scrollSize
 *            : unit === "step"     ? scrollStep ?? 1 : 1
 * scrollPosition += multiplier * delta
 * ```
 *
 * opencode 的命令等价于 `scrollBy(∓0.5, "viewport")`（半视口）与
 * `scrollBy(∓0.25, "viewport")`（¼ 视口）⇒ 本模块直接用同一单位制，
 * **不自己乘视口高**（乘法交给 opentui，测试断言调用参数）。
 */

import type { ScrollKeyBinding } from "./scroll.js";

/** 键位判定的最小 KeyEvent 形状（opentui ParsedKey 的调用方子集）。 */
export interface ScrollKeyEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** 一个滚动命令：语义名 + 物理键位 + 行数求值。 */
export interface ScrollCommand {
  name: string;
  /** 物理键位（`ctrl+alt+u` 形式；方向键直接 `pageup`）。 */
  keys: string[];
  /** 方向语义（复用 Phase 1 的 ScrollKeyBinding）。 */
  binding: ScrollKeyBinding;
  /**
   * 求该命令在给定视口高度下的「绝对行数」。
   *
   * page ⇒ ⌈vh/2⌉、halfPage ⇒ ⌈vh/4⌉、line ⇒ 1、jump ⇒ Infinity。
   */
  amount: (vh?: { viewportHeight?: number }) => number;
}

/** 视口高度非法时 page/halfPage 的回落步进（对齐滚轮 3 行）。 */
const FALLBACK_LINES = 3;

/** 归一化视口高度；非法（≤0/小数/NaN/undefined）⇒ undefined。 */
function normalizeViewportHeight(viewportHeight?: number): number | undefined {
  if (typeof viewportHeight !== "number" || !Number.isFinite(viewportHeight)) return undefined;
  // 终端行高恒为整数；小数视为非法输入（回落，不静默截断）。
  if (!Number.isInteger(viewportHeight) || viewportHeight <= 0) return undefined;
  return viewportHeight;
}

function pageAmount(vh?: { viewportHeight?: number }): number {
  const height = normalizeViewportHeight(vh?.viewportHeight);
  if (height === undefined) return FALLBACK_LINES;
  return Math.max(1, Math.ceil(height / 2));
}

function halfPageAmount(vh?: { viewportHeight?: number }): number {
  const height = normalizeViewportHeight(vh?.viewportHeight);
  if (height === undefined) return FALLBACK_LINES;
  return Math.max(1, Math.ceil(height / 4));
}

function lineAmount(_vh?: { viewportHeight?: number }): number {
  return 1;
}

function jumpAmount(_vh?: { viewportHeight?: number }): number {
  return Number.POSITIVE_INFINITY;
}

/**
 * 把「对象签名」的 amount 函数适配成 Phase 1 `ScrollKeyBinding.linesFor`
 * 的「number 签名」。
 *
 * ⚠️ 为什么需要适配器：Phase 1 的 `ScrollKeyBinding.linesFor` 契约是
 * `(viewportHeight?: number) => number`（scroll.ts:174）—— **不要改它**
 * （那是已 merge 的公开契约 + 25 条测试锁着）。而本模块的 `amount`
 * 用对象签名（`{viewportHeight?: number}`）以便未来加参数而不破坏调用方。
 * ⇒ 这里用适配器桥接，两边契约都不动。
 */
function toLinesFor(amount: (vh?: { viewportHeight?: number }) => number): (viewportHeight?: number) => number {
  return (viewportHeight?: number) => amount({ viewportHeight });
}

/**
 * **键位表**（对齐 opencode `keybind.ts:181-188`，取舍见文件头）。
 */
export const SCROLL_KEYS = {
  /** 上翻半视口。 */
  pageUp: {
    name: "pageUp",
    keys: ["pageup", "ctrl+alt+b"],
    binding: { direction: "up" as const, linesFor: toLinesFor(pageAmount) },
    amount: pageAmount,
  },
  /** 下翻半视口。 */
  pageDown: {
    name: "pageDown",
    keys: ["pagedown", "ctrl+alt+f"],
    binding: { direction: "down" as const, linesFor: toLinesFor(pageAmount) },
    amount: pageAmount,
  },
  /** 上翻 ¼ 视口（opencode ctrl+alt+u + 本仓别名 ctrl+u）。 */
  halfPageUp: {
    name: "halfPageUp",
    keys: ["ctrl+alt+u", "ctrl+u"],
    binding: { direction: "up" as const, linesFor: toLinesFor(halfPageAmount) },
    amount: halfPageAmount,
  },
  /** 下翻 ¼ 视口（opencode ctrl+alt+d + 本仓别名 ctrl+d）。 */
  halfPageDown: {
    name: "halfPageDown",
    keys: ["ctrl+alt+d", "ctrl+d"],
    binding: { direction: "down" as const, linesFor: toLinesFor(halfPageAmount) },
    amount: halfPageAmount,
  },
  /** 上 1 行。 */
  lineUp: {
    name: "lineUp",
    keys: ["ctrl+alt+y"],
    binding: { direction: "up" as const, linesFor: toLinesFor(lineAmount) },
    amount: lineAmount,
  },
  /** 下 1 行。 */
  lineDown: {
    name: "lineDown",
    keys: ["ctrl+alt+e"],
    binding: { direction: "down" as const, linesFor: toLinesFor(lineAmount) },
    amount: lineAmount,
  },
  /** 跳顶（opencode ctrl+g；home 留给 TextInput 行内光标）。 */
  jumpToTop: {
    name: "jumpToTop",
    keys: ["ctrl+g"],
    binding: { direction: "top" as const, linesFor: toLinesFor(jumpAmount) },
    amount: jumpAmount,
  },
  /** 跳底（opencode ctrl+alt+g；end 留给 TextInput 行内光标）。 */
  jumpToBottom: {
    name: "jumpToBottom",
    keys: ["ctrl+alt+g"],
    binding: { direction: "bottom" as const, linesFor: toLinesFor(jumpAmount) },
    amount: jumpAmount,
  },
} as const satisfies Record<string, ScrollCommand>;

/** 键位字符串 → 命令（启动时建好索引，运行期 O(1) 查）。 */
const KEY_INDEX: ReadonlyMap<string, ScrollCommand> = (() => {
  const map = new Map<string, ScrollCommand>();
  for (const command of Object.values(SCROLL_KEYS)) {
    for (const key of command.keys) map.set(key, command);
  }
  return map;
})();

/**
 * 把 KeyEvent 归一化成键位字符串（`ctrl+alt+u` 形式）。
 * shift 参与判定（shift 组合不路由，见 SCROLL_KEYS 文件头）。
 */
function keyIdOf(key: ScrollKeyEvent): string | undefined {
  if (!key || typeof key.name !== "string" || key.name.length === 0) return undefined;
  const parts: string[] = [];
  if (key.ctrl) parts.push("ctrl");
  if (key.meta) parts.push("alt");
  parts.push(key.name.toLowerCase());
  return parts.join("+");
}

/**
 * 键位 → 带符号行数（up ⇒ 负行数、down ⇒ 正行数；jump 给绝对标记）。
 */
export function resolveScrollKeyAmount(command: ScrollCommand, viewportHeight?: number): number {
  const lines = command.amount({ viewportHeight });
  if (!Number.isFinite(lines)) return lines;
  return command.binding.direction === "up" ? -lines : lines;
}

/**
 * **KeyEvent 路由**：命中键位表 ⇒ 返回命令；否则 undefined。
 *
 * 路由失败（undefined）≠ 消费失败——调用方（RunScreen）必须**放行**
 * 未命中的键（不 return true），避免吞掉 TextInput 的输入。
 */
export function routeScrollKey(key: ScrollKeyEvent): ScrollCommand | undefined {
  const shift = key?.shift === true;
  if (shift) return undefined; // shift 组合不路由（选区/大写输入语义优先）
  const id = keyIdOf(key);
  if (!id) return undefined;
  return KEY_INDEX.get(id);
}

/** applyScrollKey 需要的 scrollbox 最小形状（ScrollBoxRenderable 子集）。 */
export interface ScrollableLike {
  scrollTop: number;
  scrollHeight: number;
  viewport: { height: number };
  scrollBy(delta: number, unit?: string): void;
  scrollTo(target: number): void;
  stickyScroll?: boolean;
}

/**
 * **落盘执行**：把命令变成 scrollbox 的真实滚动。
 *
 * - page/halfPage ⇒ `scrollBy(∓n, "viewport")`（n = 0.5 / 0.25，
 *   与 opentui 的单位制对齐，opencode 的 ±height/2、±height/4）
 * - line ⇒ `scrollBy(∓1, "absolute")`
 * - jumpToTop ⇒ `scrollTo(0)` + 关粘底
 * - jumpToBottom ⇒ `scrollTo(scrollHeight)` + 开粘底
 * - scrollbox 缺失/半初始化 ⇒ 静默不炸（首帧前键入不崩）
 */
export function applyScrollKey(command: ScrollCommand, scrollbox: ScrollableLike | undefined): void {
  if (!scrollbox || typeof scrollbox.scrollTo !== "function") return;
  const vh = scrollbox?.viewport?.height;

  switch (command.binding.direction) {
    case "top":
      scrollbox.stickyScroll = false;
      scrollbox.scrollTo(0);
      return;
    case "bottom":
      scrollbox.stickyScroll = true;
      scrollbox.scrollTo(scrollbox.scrollHeight);
      return;
    case "up":
    case "down": {
      const lines = command.amount({ viewportHeight: vh });
      // jump 语义不会出现在 up/down（见 SCROLL_KEYS），防御性回落 1 行。
      const step = Number.isFinite(lines) ? lines : 1;
      const delta = command.binding.direction === "up" ? -step : step;
      // ★ 为什么用 `scrollTo(绝对位置)` 而不是 `scrollBy(相对量)`：
      //   opentui 的 `ScrollBox.scrollBy` 直接改 scrollbar 的 scrollPosition，
      //   **不经过 `scrollTop` setter** ⇒ 不会触发 `updateStickyState()`
      //   ⇒ 键位滚动后 sticky 状态仍是旧的 ⇒ 之后新内容到达时可能把视图
      //   拽回底部（用户已手动上滚却仍被拽回 = 经典 bug）。
      //   `scrollTo` → `scrollTop` setter → `updateStickyState()` ⇒ sticky
      //   与真实滚动位置保持一致（opencode 同样依赖 sticky 语义）。
      const maxScrollTop = Math.max(0, scrollbox.scrollHeight - vh);
      const target = Math.min(maxScrollTop, Math.max(0, scrollbox.scrollTop + delta));
      scrollbox.scrollTo(target);
      return;
    }
  }
}
