/**
 * @fileoverview Task #4721 G1 — **滚轮序列拦截**（让历史区的滚轮也能滚动）。
 *
 * ## 根因（交叉验证实测确认）
 *
 * opentui 的 `processSingleMouseEvent`（`chunk-node-2rg7pskw.js:23293`）：
 *
 * ```js
 * processSingleMouseEvent(mouseEvent) {
 *   if (this._splitHeight > 0) {
 *     if (mouseEvent.y < this.renderOffset) {
 *       return false;                       // ← **历史区**直接放弃
 *     }
 *     mouseEvent.y -= this.renderOffset;
 *   }
 *   …
 *   if (mouseEvent.type === "scroll") {
 *     const maybeRenderableId = this.hitTest(mouseEvent.x, mouseEvent.y);
 *     …
 *   }
 * }
 * ```
 *
 * 在 **split-footer** 模式下：
 *
 *   - `renderOffset` = 终端高度 - footer 高度（= 30 - 12 = 18）
 *   - ⇒ 指针在**上面 18 行**（= 历史区，用户真正想滚的地方）⇒ **直接 return false**
 *   - ⇒ 指针在**下面 12 行**（= 动态区）⇒ `hitTest` 在 scene 坐标里命中 ⇒ 事件派发成功
 *
 * ⇒ **滚轮只在动态区生效，历史区完全滚不动** —— 这正是用户报的原始问题。
 *
 * ## 为什么 `focused` fallback 救不了
 *
 * scroll 分支的 fallback 是 `hitTest() ?? focusedRenderable`。历史区在
 * `processSingleMouseEvent` **开头**就 `return false` 了 ⇒ **根本走不到**
 * scroll 分支 ⇒ fallback 分支永远不会被求值 ⇒ 让根节点 focused **无效**。
 *
 * ## 解法：拦截原始输入序列
 *
 * opentui 的 stdin 处理顺序（`chunk-node-2rg7pskw.js:23191-23197`）：
 *
 * ```js
 * case "mouse":
 *   if (this._useMouse && this.processSingleMouseEvent(event.event)) {
 *     return;                                // 被消费
 *   }
 *   this.dispatchSequenceHandlers(event.raw); // ← **未被消费**时落到这里
 *   return;
 * ```
 *
 * ⇒ 历史区的滚轮因为 `return false` 而**落到 `dispatchSequenceHandlers`** ⇒
 * 我们注册的 `prependInputHandlers`（公开 API）就能拿到**原始序列** ⇒
 * 自己解析 SGR 滚轮并驱动滚动视口。
 *
 * ## 为什么不直接用 `onMouseScroll`
 *
 * `onMouseScroll` 仍然保留：它负责**动态区**的滚轮（走 opentui 原生路径）。
 * 本模块负责**历史区**（opentui 放弃的那部分）。两者互补，不冲突。
 *
 * @see packages/cli/src/tui-solid/RunScreen.tsx
 */

/** SGR 鼠标序列：`ESC [ < button ; col ; row (M|m)`。 */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * SGR button code 里代表「滚轮」的位（xterm 规范：64 + 方向位）。
 *   64 = wheel up，65 = wheel down，66 = wheel left，67 = wheel right
 */
const SGR_WHEEL_BIT = 64;

/** 滚轮方向（button & 3）。 */
const SGR_WHEEL_DIRECTION: Record<number, "up" | "down" | "left" | "right"> = {
  0: "up",
  1: "down",
  2: "left",
  3: "right",
};

export interface WheelEvent {
  direction: "up" | "down" | "left" | "right";
  /** 1-based 列/行（SGR 协议是 1-based）。 */
  column: number;
  row: number;
}

/**
 * 解析一个原始输入序列，判断它是不是**滚轮**事件。
 *
 * @returns 滚轮事件；不是滚轮（或格式不认识）⇒ `null`
 */
export function parseWheelSequence(sequence: string): WheelEvent | null {
  const m = SGR_MOUSE_RE.exec(sequence);
  if (!m) return null;
  const button = Number(m[1]);
  // 滚轮位必须置上，且不是 motion 位（32）。
  if ((button & SGR_WHEEL_BIT) === 0) return null;
  if ((button & 32) !== 0) return null;
  const direction = SGR_WHEEL_DIRECTION[button & 3];
  if (!direction) return null;
  return { direction, column: Number(m[2]), row: Number(m[3]) };
}

export interface WheelInterceptorOptions {
  /**
   * 判定「这个滚轮事件是否落在历史区」（opentui 不派发的区域）。
   *
   * @param row 1-based 终端行号
   * @returns true = 历史区（需要我们自己处理）
   */
  isInHistoryArea: (row: number) => boolean;
  /** 收到历史区滚轮时的回调。 */
  onHistoryWheel: (event: WheelEvent) => void;
}

/**
 * 创建一个 opentui `prependInputHandlers` 处理器。
 *
 * ⚠️ **必须返回 false**（=「我没处理」）除非确实消费了事件 ——
 * 动态区的滚轮由 opentui 原生路径处理，我们不能抢。
 *
 * @returns 一个 `(sequence: string) => boolean` 处理器
 */
export function createWheelInterceptor(options: WheelInterceptorOptions): (sequence: string) => boolean {
  return (sequence: string): boolean => {
    const wheel = parseWheelSequence(sequence);
    if (!wheel) return false;
    // 只处理历史区；动态区交给 opentui 原生 onMouseScroll。
    if (!options.isInHistoryArea(wheel.row)) return false;
    options.onHistoryWheel(wheel);
    // 返回 true = 已消费 ⇒ opentui 不会再把这个序列送给别处。
    return true;
  };
}
