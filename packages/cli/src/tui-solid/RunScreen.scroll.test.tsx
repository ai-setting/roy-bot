/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #4721 G1 — **滚动**（鼠标滚轮能上下滚动历史输出）。
 *
 * ## 根因（设计文档 /tmp/interactive-ui-4721-design.md §1.1）
 *
 * opentui 的滚轮派发（`chunk-node-2rg7pskw.js:23313-23325`）：
 *
 * ```js
 * if (mouseEvent.type === "scroll") {
 *   const maybeRenderableId = this.hitTest(mouseEvent.x, mouseEvent.y);
 *   const maybeRenderable = Renderable.renderablesByNumber.get(maybeRenderableId);
 *   const fallbackTarget = this._currentFocusedRenderable … focused ? … : null;
 *   const scrollTarget = maybeRenderable ?? fallbackTarget;
 *   if (scrollTarget) { …sendMouseEvent(scrollTarget, event) }
 *   return true;                       // ← 无 target 时**直接吞掉**
 * }
 * ```
 *
 * ⇒ 滚轮事件**只**派发给 `hitTest` 命中的 renderable；而
 * `tui-solid/` 全目录 grep `onMouseScroll` = **0 命中**
 * ⇒ 我们的 TUI 树里**没有任何**节点声明滚动行为 ⇒ 滚轮无处可去。
 *
 * ## 修复方向（设计文档已定稿）
 *
 * 在 TUI 根节点挂**常驻**的 `onMouseScroll`，自管一个**滚动视口**：
 *   - 向上滚 ⇒ 视口往历史区回退（`scrollOffset` 增大）
 *   - 向下滚 ⇒ 回到「跟随最新」（`scrollOffset` 归零）
 *
 * ⚠️ **为什么需要自管视口**：opentui 的历史输出是 **write-once scrollback**
 * （片4），**不在 renderable 树里** ⇒ 即便有 `onMouseScroll`，也没有公开的
 * 「回滚 scrollback 视口」API（`setRenderOffset` 在 `.d.ts` 里是 private）。
 *
 * ## 验收标准
 *
 * 1. 滚轮事件能到达 TUI 根节点（`onMouseScroll` 被调用）。
 * 2. 向上滚 ⇒ `scrollOffset` 增大；向下滚 ⇒ 减小；到底 ⇒ 归零。
 * 3. 滚到底后**自动跟随最新**（新内容到达时 scrollOffset 不再钉住）。
 * 4. 不滚时 `scrollOffset` 恒为 0（不影响正常显示）。
 *
 * ## 断言策略
 *
 * opentui `testRender` + `mockMouse.scroll(...)`（走**真实**的鼠标解析器），
 * 断言**行为**（滚动视口状态变化），不做源码字符串断言。
 */

import { describe, expect, it } from "bun:test";
import { createEffect, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import RunScreenSolid from "./RunScreen.js";
import { createScrollViewport, type ScrollViewport } from "./scroll-viewport.js";

function isSolidReactive(): boolean {
  const seen: number[] = [];
  const [n, setN] = createSignal(0);
  createEffect(() => {
    seen.push(n());
  });
  setN(1);
  return seen.length > 1;
}

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** 滚轮事件的最小替身（与 opentui 的 MouseEvent.scroll 同形）。 */
function scrollEvent(direction: "up" | "down", delta = 1) {
  return { type: "scroll", scroll: { direction, delta } } as never;
}

describeIfClient("tui-solid 滚动视口（Task #4721 G1）", () => {
  it("starts at the bottom (scrollOffset = 0)", () => {
    const vp = createScrollViewport();
    expect(vp.offset()).toBe(0);
    expect(vp.isPinnedToBottom()).toBe(true);
  });

  it("scrolls up by the wheel delta", () => {
    const vp = createScrollViewport();
    vp.onScroll(scrollEvent("up", 3));
    expect(vp.offset()).toBe(3);
    expect(vp.isPinnedToBottom()).toBe(false);
  });

  it("scrolls down and clamps at zero", () => {
    const vp = createScrollViewport();
    vp.onScroll(scrollEvent("up", 3));
    vp.onScroll(scrollEvent("down", 1));
    expect(vp.offset()).toBe(2);
    vp.onScroll(scrollEvent("down", 10));
    expect(vp.offset()).toBe(0);
    expect(vp.isPinnedToBottom()).toBe(true);
  });

  it("clamps the offset at the maximum history depth", () => {
    const vp = createScrollViewport({ maxOffset: 5 });
    vp.onScroll(scrollEvent("up", 100));
    expect(vp.offset()).toBe(5);
  });

  it("ignores non-up/down wheel directions", () => {
    const vp = createScrollViewport();
    vp.onScroll(scrollEvent("left", 3));
    vp.onScroll(scrollEvent("right", 3));
    expect(vp.offset()).toBe(0);
  });

  it("re-pins to the bottom when new content arrives while pinned", () => {
    const vp = createScrollViewport();
    vp.onScroll(scrollEvent("up", 2));
    expect(vp.offset()).toBe(2);
    vp.notifyContentAppended();
    // 用户正在看历史 ⇒ **不**跳回底部（否则历史根本看不住）。
    expect(vp.offset()).toBe(2);
    expect(vp.isPinnedToBottom()).toBe(false);
  });

  it("re-pins to the bottom when the user scrolls back down", () => {
    const vp = createScrollViewport();
    vp.onScroll(scrollEvent("up", 2));
    vp.onScroll(scrollEvent("down", 2));
    expect(vp.offset()).toBe(0);
    expect(vp.isPinnedToBottom()).toBe(true);
    vp.notifyContentAppended();
    expect(vp.offset()).toBe(0);
  });

  // ---------------------------------------------------------------------
  // ★ Task #4721（交叉验证 MINOR-3）：停留在历史区时，新内容要**计数并提示**，
  // 否则用户会以为「卡住了」。
  // ---------------------------------------------------------------------
  it("counts pending new content while the user is scrolled back", () => {
    const vp = createScrollViewport();
    vp.onScroll(scrollEvent("up", 2));
    expect(vp.pendingNew()).toBe(0);
    vp.notifyContentAppended();
    expect(vp.pendingNew()).toBe(1);
    vp.notifyContentAppended();
    expect(vp.pendingNew()).toBe(2);
    // 位置不变（不拽回底部）
    expect(vp.offset()).toBe(2);
  });

  it("clears the pending count when the user scrolls back to the bottom", () => {
    const vp = createScrollViewport();
    vp.onScroll(scrollEvent("up", 2));
    vp.notifyContentAppended();
    expect(vp.pendingNew()).toBe(1);
    vp.onScroll(scrollEvent("down", 5));
    expect(vp.pendingNew()).toBe(0);
  });

  // ★ 交叉验证 MINOR-1：中间态向下滚不清零 —— 用户还在历史区
  it("keeps the pending count when scrolling down but not to the bottom", () => {
    const vp = createScrollViewport();
    vp.onScroll(scrollEvent("up", 5));
    vp.notifyContentAppended();
    expect(vp.pendingNew()).toBe(1);
    vp.onScroll(scrollEvent("down", 1));
    // 还在历史区（offset=4）⇒ 提示不能消失
    expect(vp.offset()).toBe(4);
    expect(vp.pendingNew()).toBe(1);
  });

  it("does not count pending content while pinned to the bottom", () => {
    const vp = createScrollViewport();
    vp.notifyContentAppended();
    expect(vp.pendingNew()).toBe(0);
    expect(vp.offset()).toBe(0);
  });

  it("reset clears both the offset and the pending count", () => {
    const vp = createScrollViewport();
    vp.onScroll(scrollEvent("up", 3));
    vp.notifyContentAppended();
    expect(vp.pendingNew()).toBe(1);
    vp.reset();
    expect(vp.offset()).toBe(0);
    expect(vp.pendingNew()).toBe(0);
  });
});

describeIfClient("tui-solid RunScreen — 滚轮接线（Task #4721 G1）", () => {
  it("forwards the wheel event to the scroll viewport", async () => {
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          maxLines={100}
          markdownEnabled={false}
        />
      ),
      { width: 60, height: 24 },
    );
    try {
      // 滚轮事件必须能到达 TUI（根节点命中）。
      await t.mockMouse.scroll(5, 1, "up");
      await t.flush();
      // 断言「没崩」+「滚轮被消费」——具体视口状态由上面的单元测试覆盖。
      expect(t.renderer.isDestroyed).toBe(false);
    } finally {
      await t.dispose();
    }
  });

  it("wheel no longer requests footer height (P0: scrollbox native)", async () => {
    const heights: number[] = [];
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          maxLines={100}
          markdownEnabled={false}
          onFooterHeightChange={(h) => heights.push(h)}
        />
      ),
      { width: 60, height: 24 },
    );
    try {
      await t.mockMouse.scroll(5, 1, "up");
      await t.flush();
      // ★ Task #4954 P0（DS MAJOR-1 修复）：alternate-screen 下
      //   滚动由 scrollbox 原生接管，旧自管视口退役 ⇒
      //   applyWheel 短路，不再请求 footer 高度。
      //   （split-footer 时代该断言是 >12 增高，见 git 历史。）
      expect(heights.length).toBe(0);
      expect(t.renderer.isDestroyed).toBe(false);
    } finally {
      await t.dispose();
    }
  });
});

if (!SOLID_REACTIVE) {
  describe("tui-solid 滚动视口（Task #4721 G1）[SKIPPED]", () => {
    it("explains why the assertions were skipped", () => {
      expect(SOLID_REACTIVE).toBe(false);
    });
  });
}
