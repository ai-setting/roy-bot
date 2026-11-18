/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5041 P3 Phase 1 — **滚轮 3 行步进 + sticky 自动跟随** 集成测试。
 *
 * ## 测什么
 *
 * 1. **3 行步进**：滚轮一档 ⇒ scrollbox 的 `scrollTop` 变化 **3**（不是 1）。
 *    关键前提（已实测）：opentui 0.6.6 的 `MouseParser` 恒发 `delta: 1`
 *    ⇒ `scrollAmount = 1 × scrollAccel.tick()` ⇒ `tick()` 返回值 = 行数。
 * 2. **sticky 自动跟随**：停在底部时新内容到达 ⇒ 自动滚到底（`scrollTop` 跟随）；
 *    用户手动往上滚之后 ⇒ **不再**被拽回底部（`stickyScroll` 的 sticky 语义）。
 *
 * ## 断言方式
 *
 * 用 opentui 的 `testRender` + `mockMouse.scroll(...)`（走**真实**的鼠标解析器）
 * ⇒ 断言**行为**（scrollTop 的实际变化），不做源码字符串断言。
 *
 * scrollbox 的定位：走 App 的 `onScrollboxRef` 钩子（`ref` prop）拿到
 * **确定的那个**实例 ⇒ 不用遍历全局注册表去猜（避免拿到别的 App 的残留实例）。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { ScrollBoxRenderable } from "@opentui/core";
import { App, type HistoryItem } from "./App.js";
import { createScrollAcceleration } from "./scroll.js";
import { isSolidReactive } from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** 造 N 行历史（每行一个序号，方便在帧里定位）。 */
function rows(count: number, offset = 0): HistoryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    role: "assistant" as const,
    text: `row-${String(i + offset).padStart(3, "0")}`,
  }));
}

interface Mounted {
  t: Awaited<ReturnType<typeof testRender>>;
  scrollbox: ScrollBoxRenderable;
  dispose: () => Promise<void>;
}

/**
 * 挂载一个带 scrollbox 的 App，并抓住 scrollbox 的 renderable 实例。
 */
async function mountScrollbox(
  props: Partial<Parameters<typeof App>[0]> = {},
  size: { width: number; height: number } = { width: 60, height: 12 },
): Promise<Mounted> {
  let scrollbox: ScrollBoxRenderable | undefined;

  const t = await testRender(
    () => (
      <App
        history={rows(40)}
        status="idle"
        model="test-model"
        workdir="/tmp"
        {...props}
        onScrollboxRef={(node: ScrollBoxRenderable) => {
          scrollbox = node;
        }}
      />
    ),
    size,
  );

  await t.renderOnce();
  if (!scrollbox) {
    throw new Error("scrollbox ref 未被回调（App 的 onScrollboxRef 没触发）");
  }

  return {
    t,
    scrollbox: scrollbox as ScrollBoxRenderable,
    dispose: async () => {
      await t.dispose();
    },
  };
}

describeIfClient("tui-solid — 滚轮 3 行步进（Task #5041 P3 Phase 1）", () => {
  it("一档滚轮让 scrollTop 变化 3 行（默认步进）", async () => {
    const { t, scrollbox, dispose } = await mountScrollbox();
    try {
      // 先滚到底（起点），再往上滚一档量差值。
      scrollbox.scrollTop = scrollbox.scrollHeight;
      await t.renderOnce();
      const before = scrollbox.scrollTop;

      await t.mockMouse.scroll(5, 3, "up");
      await t.flush();
      await t.renderOnce();

      expect(scrollbox.scrollTop).toBe(before - 3);
    } finally {
      await dispose();
    }
  });

  it("默认加速器的 tick() 返回 3（与集成行为一致）", () => {
    const accel = createScrollAcceleration();
    expect(accel.tick()).toBe(3);
  });

  it("注入自定义加速器后步进随之改变（证明接线真的生效）", async () => {
    const { t, scrollbox, dispose } = await mountScrollbox({
      scrollAcceleration: createScrollAcceleration(1),
    });
    try {
      scrollbox.scrollTop = scrollbox.scrollHeight;
      await t.renderOnce();
      const before = scrollbox.scrollTop;

      await t.mockMouse.scroll(5, 3, "up");
      await t.flush();
      await t.renderOnce();

      expect(scrollbox.scrollTop).toBe(before - 1);
    } finally {
      await dispose();
    }
  });

  it("连续两档滚轮累计 6 行（步进稳定，不衰减）", async () => {
    const { t, scrollbox, dispose } = await mountScrollbox();
    try {
      scrollbox.scrollTop = scrollbox.scrollHeight;
      await t.renderOnce();
      const before = scrollbox.scrollTop;

      await t.mockMouse.scroll(5, 3, "up");
      await t.flush();
      await t.renderOnce();
      await t.mockMouse.scroll(5, 3, "up");
      await t.flush();
      await t.renderOnce();

      expect(scrollbox.scrollTop).toBe(before - 6);
    } finally {
      await dispose();
    }
  });
});

describeIfClient("tui-solid — sticky 自动跟随（Task #5041 P3 Phase 1）", () => {
  it("停在底部时新内容到达 ⇒ 自动跟随到底", async () => {
    const { t, scrollbox, dispose } = await mountScrollbox();
    try {
      // 撑高内容 ⇒ 产生可滚动空间（scrollHeight 由**内容高度**决定）。
      (scrollbox.content as any).height = 200;
      await t.renderOnce();

      const maxTopBefore = scrollbox.scrollHeight - scrollbox.viewport.height;
      // stickyStart="bottom" ⇒ 初始就贴底。
      expect(Math.abs(scrollbox.scrollTop - maxTopBefore)).toBeLessThanOrEqual(1);

      // 内容变高 ⇒ sticky 应把视口带到**新的**底部。
      (scrollbox.content as any).height = 300;
      await t.renderOnce();

      const maxTopAfter = scrollbox.scrollHeight - scrollbox.viewport.height;
      expect(maxTopAfter).toBeGreaterThan(maxTopBefore);
      expect(Math.abs(scrollbox.scrollTop - maxTopAfter)).toBeLessThanOrEqual(1);
    } finally {
      await dispose();
    }
  });

  it("用户手动往上滚之后 ⇒ 不再被 sticky 拽回底部", async () => {
    const { t, scrollbox, dispose } = await mountScrollbox();
    try {
      (scrollbox.content as any).height = 200;
      await t.renderOnce();

      const maxTop = scrollbox.scrollHeight - scrollbox.viewport.height;

      // 往上滚 6 行（2 档 × 3 行）⇒ 离开底部。
      await t.mockMouse.scroll(5, 3, "up");
      await t.mockMouse.scroll(5, 3, "up");
      await t.flush();
      await t.renderOnce();

      const afterScroll = scrollbox.scrollTop;
      expect(afterScroll).toBeLessThan(maxTop);

      // 内容变高 ⇒ **不**应被拽回底部（sticky 的「手动滚动后脱离」语义）。
      (scrollbox.content as any).height = 300;
      await t.renderOnce();

      expect(scrollbox.scrollTop).toBe(afterScroll);
    } finally {
      await dispose();
    }
  });
});
