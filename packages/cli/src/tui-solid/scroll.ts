/**
 * @fileoverview Task #5041 — **滚动步进模块**（滚轮 3 行 / 键位预留）。
 *
 * ## 为什么需要这个模块
 *
 * opentui 0.6.6 的 `<scrollbox>` 默认滚轮步进是 **1 行**
 * （`LinearScrollAccel.tick()` 恒返回 1）⇒ 一格滚轮只挪一行，
 * 长对话回看历史时非常慢。本模块提供 `ScrollAcceleration` 的自定义实现，
 * 把步进改成 **3 行**（对齐 opencode 的 `CustomSpeedScroll(3)`）。
 *
 * ## 关键事实：baseDelta 恒为 1（已实测确认）
 *
 * opentui 的滚动计算链（`node_modules/@opentui/core/index.bun.js:14071-14074`）：
 *
 * ```js
 * const baseDelta = event.scroll?.delta ?? 0;
 * const multiplier = this.scrollAccel.tick(now);
 * const scrollAmount = baseDelta * multiplier;   // ← 最终位移
 * ```
 *
 * 而 `event.scroll.delta` 由 `MouseParser` 产生，两条解码路径都**硬编码为 1**：
 *
 * - SGR 解码：`chunk-node-2rg7pskw.js:4750` → `scrollInfo = { direction, delta: 1 }`
 * - basic 解码：`chunk-node-2rg7pskw.js:4790` → `scrollInfo = { direction, delta: 1 }`
 *
 * ⇒ `scrollAmount = 1 × tick()` ⇒ **`tick()` 的返回值就是最终滚动的行数**。
 * ⇒ 要「每档 3 行」，`tick()` 就该返回 **3**（不是别的换算值）。
 *
 * ## 为什么不复用 opentui 自带的 `MacOSScrollAccel`
 *
 * `MacOSScrollAccel` 的乘数随滚轮**连续快慢**在 1..maxMultiplier 之间浮动，
 * ⇒ 同一档滚轮的位移不固定（快滚很猛、慢滚很黏）⇒ **不是**「固定 3 行」。
 * 需求是**确定性步进** ⇒ 自实现 `FixedStepScrollAccel`。
 *
 * @see packages/cli/src/tui-solid/App.tsx（scrollbox 接线）
 */

/** 默认每档滚动的行数（对齐 opencode `CustomSpeedScroll(3)`）。 */
export const DEFAULT_SCROLL_STEP_LINES = 3;

/**
 * opentui 的 `ScrollAcceleration` 接口（`@opentui/core/lib/scroll-acceleration.d.ts`）。
 *
 * 这里**本地重声明**而不是 import —— 理由：opentui 的 `lib/scroll-acceleration.js`
 * 只导出类型（`.d.ts` 里只有 interface + 两个 class 的声明），运行时没有对应的
 * `.js` 实现文件可安全 import（core 的实现在 bundle 内）。
 * 而我们的实现只需要**结构兼容**（opentui 是鸭子类型调用 `tick`/`reset`）。
 */
export interface ScrollAcceleration {
  /** 返回本档的滚动乘数（= 行数，因为 baseDelta ≡ 1）。 */
  tick(now?: number): number;
  /** 复位内部状态。 */
  reset(): void;
}

/**
 * 校验并归一化步进行数。
 *
 * ⚠️ **严格校验**：只接受**正整数**。小数（如 2.5）不是合法的「行数」——
 * 滚动以行为单位，半行没有意义 ⇒ 回落默认值而不是静默截断
 * （截断会让「我配了 2.5」变成「配了 2」，与配置意图不符且难以排查）。
 *
 * @param lines 期望的行数（非法值 → 回落默认）
 * @returns 合法的正整数行数
 */
export function resolveScrollStepLines(lines?: number): number {
  if (typeof lines !== "number" || !Number.isFinite(lines)) return DEFAULT_SCROLL_STEP_LINES;
  if (!Number.isInteger(lines)) return DEFAULT_SCROLL_STEP_LINES;
  if (lines < 1) return DEFAULT_SCROLL_STEP_LINES;
  return lines;
}

/**
 * **固定步进**的滚动加速器 —— 每档滚轮固定走 N 行。
 *
 * 与 opentui 内置的两个实现对比：
 *   - `LinearScrollAccel`：`tick()` 恒返回 1 ⇒ 1 行/档（本模块要替换的对象）
 *   - `MacOSScrollAccel`：乘数随滚轮速度浮动 ⇒ 位移不确定
 *   - **`FixedStepScrollAccel`（本类）**：乘数恒定 ⇒ 位移确定（3 行/档）
 */
export class FixedStepScrollAccel implements ScrollAcceleration {
  /** 每档的行数（已归一化，≥1）。 */
  readonly lines: number;

  constructor(lines: number = DEFAULT_SCROLL_STEP_LINES) {
    this.lines = resolveScrollStepLines(lines);
  }

  /** 返回固定步进行数（忽略时间参数 —— 不做速度自适应）。 */
  tick(_now?: number): number {
    return this.lines;
  }

  /** 无内部状态 ⇒ 空实现（保持接口兼容）。 */
  reset(): void {
    // 固定步进没有「加速中」状态需要复位。
  }
}

/**
 * 创建滚动加速器实例。
 *
 * @param lines 每档行数（默认 3）
 */
export function createScrollAcceleration(lines: number = DEFAULT_SCROLL_STEP_LINES): ScrollAcceleration {
  return new FixedStepScrollAccel(lines);
}

/** 滚轮事件的最小结构（与 opentui 的 `event.scroll` 同形）。 */
export interface WheelScrollInfo {
  direction?: string;
  delta?: number;
}

/**
 * 把滚轮事件换算成「要滚动多少行」。
 *
 * @param scroll opentui 的 `event.scroll`
 * @param stepLines 每档行数（默认 3）
 * @returns 行数（纵向）；左右方向 / 未知方向 ⇒ 0（不产生纵向滚动）
 */
export function scrollLinesForWheelEvent(
  scroll: WheelScrollInfo | undefined,
  stepLines: number = DEFAULT_SCROLL_STEP_LINES,
): number {
  const direction = scroll?.direction;
  if (direction !== "up" && direction !== "down") return 0;
  const step = resolveScrollStepLines(stepLines);
  // opentui 的 MouseParser 恒发 delta: 1；缺省时按 1 处理（与原生路径一致）。
  const delta = typeof scroll?.delta === "number" && Number.isFinite(scroll.delta) ? Math.abs(scroll.delta) : 1;
  return step * delta;
}

/** 键位语义方向。 */
export type ScrollKeyDirection = "up" | "down" | "top" | "bottom";

/**
 * 判定 `node` 是否是 `ancestor` 自身或其后代。
 *
 * ## 为什么需要
 *
 * opentui 的鼠标事件会**向 parent 冒泡**（`Renderable.processMouseEvent`：
 * `if (this.parent && !event.propagationStopped) this.parent.processMouseEvent(event)`）。
 * ⇒ 根节点上的 `onMouseScroll` 会在 **scrollbox 已经处理过之后**才被调用。
 *
 * ⇒ 若无差别地再滚一次 ⇒ **翻倍**（用户滚一档实际走 6 行）。
 * ⇒ 必须能判断「这个事件的 target 是否在 scrollbox 子树内」。
 *
 * @param node 事件命中的 renderable（`MouseEvent.target`）
 * @param ancestor 祖先 renderable
 */
export function isDescendantOf(node: unknown, ancestor: unknown): boolean {
  if (!node || !ancestor) return false;
  if (node === ancestor) return true;
  let current: any = node;
  // 沿 parent 链往上走（opentui 的 Renderable.parent）。
  for (let depth = 0; depth < 64; depth++) {
    const parent = current?.parent;
    if (!parent) return false;
    if (parent === ancestor) return true;
    current = parent;
  }
  return false;
}
/** 一个预留键位的语义描述。 */
export interface ScrollKeyBinding {
  /** 语义方向。 */
  direction: ScrollKeyDirection;
  /**
   * 求出该键位应该滚动多少行。
   *
   * @param viewportHeight 视口高度（行）；未知时传 undefined
   */
  linesFor: (viewportHeight?: number) => number;
}

/**
 * **键位预留**（P3 后续阶段的接线点）。
 *
 * 这里只声明**语义**（翻页 / 跳顶 / 跳底），不绑定具体物理按键 ——
 * 物理按键由上层 keymap 决定，语义保持独立，便于后续阶段接。
 */
export const SCROLL_KEY_BINDINGS = {
  /** 向上翻一屏。 */
  pageUp: {
    direction: "up",
    linesFor: (viewportHeight?: number) =>
      typeof viewportHeight === "number" && viewportHeight > 0 ? Math.trunc(viewportHeight) : DEFAULT_SCROLL_STEP_LINES,
  },
  /** 向下翻一屏。 */
  pageDown: {
    direction: "down",
    linesFor: (viewportHeight?: number) =>
      typeof viewportHeight === "number" && viewportHeight > 0 ? Math.trunc(viewportHeight) : DEFAULT_SCROLL_STEP_LINES,
  },
  /** 直接跳到最顶部（绝对定位 ⇒ 行数无界）。 */
  jumpToTop: {
    direction: "top",
    linesFor: (_viewportHeight?: number) => Number.POSITIVE_INFINITY,
  },
  /** 直接跳到最底部（绝对定位 ⇒ 行数无界）。 */
  jumpToBottom: {
    direction: "bottom",
    linesFor: (_viewportHeight?: number) => Number.POSITIVE_INFINITY,
  },
} as const satisfies Record<string, ScrollKeyBinding>;
