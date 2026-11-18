/**
 * @fileoverview Task #4721 G1 — **滚动视口**（自管的 history viewport）。
 *
 * ## 为什么必须「自管」
 *
 * opentui 的历史输出是 **write-once scrollback**（Task #4278 片4）：
 * `renderer.writeToScrollback(...)` 把已提交的消息写进终端的滚动缓冲，
 * **它们不在 renderable 树里** ⇒
 *
 *   - 树里的任何 `<box>` 都**没有**这些历史行 ⇒ `<ScrollBox>` 之类组件
 *     **滚不到**它们；
 *   - opentui **没有公开**「回滚 scrollback 视口」的 API
 *     （`setRenderOffset` 在 `renderer.d.ts` 里是 `private`，
 *      `sessionSplitControl` 的 `render-offset` 是 native ABI）。
 *
 * ⇒ 只能**自己**记一个「视口回退了���少行」，并在回退时把对应的历史行
 * **重新渲染进 frame**（而不是去操纵终端滚动缓冲）。
 *
 * ## 语义
 *
 *   - `offset()` = 0 ⇒ 视口在**最新**（跟随输出）。
 *   - `offset() > 0` ⇒ 视口回退了 `offset()` 行（用户在看历史）。
 *   - 向上滚 ⇒ `offset` 增大（往历史走）；向下滚 ⇒ 减小。
 *   - 到底 ⇒ `offset` 归零 ⇒ `isPinnedToBottom()` 为 true ⇒ 新内容继续跟随。
 *
 * ## 为什么「看历史时新内容不跳走」
 *
 * 用户往上翻就是想**稳住**那一屏历史。若新内容一进来就把视口拽回底部，
 * 用户永远读不到之前的内容（这正是原始 bug 的体感）。所以：
 *   - `offset > 0`（未钉在底部）⇒ `notifyContentAppended()` **不**改变 offset；
 *   - `offset === 0`（钉在底部）⇒ 保持 0（自然跟随）。
 */

import { createSignal } from "solid-js";

export interface ScrollViewportOptions {
  /** 可回退的最大行数（超过就钳住）。默认 1000。 */
  maxOffset?: number;
}

export interface ScrollViewport {
  /** 当前回退行数（0 = 跟随最新）。 */
  offset: () => number;
  /** 是否钉在底部（跟随最新）。 */
  isPinnedToBottom: () => boolean;
  /**
   * ★ Task #4721（MINOR-3）：停留在历史区时，下方堆积的**新内容条数**。
   *
   * 用于界面提示「↓ 有 N 条新消息」⇒ 避免用户以为卡住。
   */
  pendingNew: () => number;
  /** 处理一个滚轮事件。 */
  onScroll: (event: { scroll?: { direction?: string; delta?: number } }) => void;
  /** 有新内容追加（历史变长）。 */
  notifyContentAppended: () => void;
  /** 复位到底部。 */
  reset: () => void;
}

/** 滚轮方向 → 偏移增量。 */
function deltaFor(direction: string | undefined, delta: number | undefined): number {
  const amount = Number.isFinite(delta) ? Math.abs(delta as number) : 1;
  switch (direction) {
    case "up":
      return amount;
    case "down":
      return -amount;
    default:
      return 0;
  }
}

export function createScrollViewport(options: ScrollViewportOptions = {}): ScrollViewport {
  const maxOffset = options.maxOffset ?? 1000;
  const [offset, setOffset] = createSignal(0);
  /**
   * ★ Task #4721（交叉验证 MINOR-3）：停留在历史区时，下方堆积的新内容条数。
   *
   * 用户往上翻时新内容**不**把视口拽回底部（否则永远读不到之前的内容），
   * 但必须**告诉用户**「下面有 N 条新的」⇒ 否则会被误判为「卡住了」。
   */
  const [pendingNew, setPendingNew] = createSignal(0);

  const onScroll = (event: { scroll?: { direction?: string; delta?: number } }) => {
    const step = deltaFor(event?.scroll?.direction, event?.scroll?.delta);
    if (step === 0) return;
    setOffset((prev) => {
      const next = prev + step;
      if (next < 0) return 0;
      if (next > maxOffset) return maxOffset;
      return next;
    });
    // 滚回底部（offset 归零）⇒ 下面的新内容「已消化」⇒ 清零计数。
    // ★ 交叉验证 MINOR-1：只在**真正回到底部**时清零 ——
    //   中间态（offset 4→3）不该清，否则用户还在历史区里
    //   提示就消失了（正是 MINOR-3 想避免的「以为卡住」体感）。
    if (offset() === 0) setPendingNew(0);
  };

  const notifyContentAppended = () => {
    // ★ Task #4721（交叉验证 MINOR-3）：用户正在看历史（offset > 0）时，
    //   **不**拽回底部（那会让他永远读不到之前的内容），
    //   但要**记下**「下面又多了 N 条」⇒ 界面上给出提示，
    //   否则用户停留不动时会以为「卡住了」。
    if (offset() > 0) {
      setPendingNew((n) => n + 1);
      return;
    }
    // 钉在底部时 offset 已经是 0 ⇒ 天然跟随。
    setPendingNew(0);
    setOffset(0);
  };

  const reset = () => {
    setPendingNew(0);
    setOffset(0);
  };

  return {
    offset,
    isPinnedToBottom: () => offset() === 0,
    pendingNew,
    onScroll,
    notifyContentAppended,
    reset,
  };
}
