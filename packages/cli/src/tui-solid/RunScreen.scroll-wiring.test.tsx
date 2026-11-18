/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5041 P3 Phase 1 — **RunScreen 滚轮接线** 集成测试。
 *
 * ## 测什么
 *
 * 1. **不重复滚动**：opentui 的鼠标事件会向 parent 冒泡 ⇒ 根节点的
 *    `onMouseScroll` 会在 scrollbox **已经处理过之后**才被调用。
 *    ⇒ 必须靠 `event.target` 判定「已被 scrollbox 处理」，否则一档滚 6 行。
 * 2. **历史区兜底**：`onHistoryWheel`（raw 序列路径）没有 target
 *    ⇒ 由 `applyWheel` 补滚（滚 3 行）。
 *
 * ## 断言方式
 *
 * 走**真实**的 `testRender` + `mockMouse.scroll(...)`（真实鼠标解析器），
 * 断言 scrollbox 的 `scrollTop` 实际变化量。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { ScrollBoxRenderable } from "@opentui/core";
import RunScreenSolid from "./RunScreen.js";
import { isSolidReactive } from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** RunScreen 挂载后拿到的句柄。 */
interface Mounted {
  t: Awaited<ReturnType<typeof testRender>>;
  scrollbox: ScrollBoxRenderable;
  /** 历史区滚轮回调（由 `onRegisterHandlers` 交出）。 */
  historyWheel: (direction: "up" | "down" | "left" | "right") => void;
  dispose: () => Promise<void>;
}

async function mountRunScreen(size: { width: number; height: number } = { width: 60, height: 12 }): Promise<Mounted> {
  let scrollbox: ScrollBoxRenderable | undefined;
  let historyWheel: ((direction: "up" | "down" | "left" | "right") => void) | undefined;

  const t = await testRender(
    () => (
      <RunScreenSolid
        handleQuery={async () => "ok"}
        maxLines={100}
        markdownEnabled={false}
        onRegisterHandlers={(handlers: any) => {
          historyWheel = handlers.onHistoryWheel;
        }}
      />
    ),
    size,
  );

  await t.renderOnce();

  // scrollbox 实例：RunScreen 内部的 App 渲染出来的 ⇒ 从渲染树找。
  const findScrollbox = (node: any): ScrollBoxRenderable | undefined => {
    if (!node) return undefined;
    if (node instanceof ScrollBoxRenderable) return node;
    for (const child of typeof node.getChildren === "function" ? node.getChildren() : []) {
      const found = findScrollbox(child);
      if (found) return found;
    }
    return undefined;
  };

  const root = (t as any).renderer?.root;
  scrollbox = findScrollbox(root);
  if (!scrollbox) throw new Error("未找到 scrollbox 实例");

  return {
    t,
    scrollbox: scrollbox as ScrollBoxRenderable,
    historyWheel: (direction) => historyWheel?.(direction),
    dispose: async () => {
      await t.dispose();
    },
  };
}

describeIfClient("tui-solid RunScreen — 滚轮接线（Task #5041 P3 Phase 1）", () => {
  it("scrollbox 内滚一档 = 3 行（原生处理；不因冒泡而翻倍）", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      (scrollbox.content as any).height = 200;
      await t.renderOnce();

      const before = scrollbox.scrollTop;
      // 指针落在 scrollbox 内（y=3）⇒ scrollbox 原生处理 ⇒ 事件再冒泡到根节点。
      await t.mockMouse.scroll(5, 3, "up");
      await t.flush();
      await t.renderOnce();

      // 期望 3 行（不是 6 ⇒ 说明没有重复滚）。
      expect(scrollbox.scrollTop).toBe(before - 3);
    } finally {
      await dispose();
    }
  });

  it("历史区兜底路径也滚 3 行（无 target ⇒ 由 applyWheel 补滚）", async () => {
    const { t, scrollbox, historyWheel, dispose } = await mountRunScreen();
    try {
      (scrollbox.content as any).height = 200;
      await t.renderOnce();

      const before = scrollbox.scrollTop;
      historyWheel("up");
      await t.flush();
      await t.renderOnce();

      expect(scrollbox.scrollTop).toBe(before - 3);
    } finally {
      await dispose();
    }
  });

  it("历史区兜底路径：向下滚 = 3 行", async () => {
    const { t, scrollbox, historyWheel, dispose } = await mountRunScreen();
    try {
      (scrollbox.content as any).height = 200;
      await t.renderOnce();

      // 先往上滚一档离开底部。
      historyWheel("up");
      await t.flush();
      await t.renderOnce();
      const before = scrollbox.scrollTop;

      historyWheel("down");
      await t.flush();
      await t.renderOnce();

      expect(scrollbox.scrollTop).toBe(before + 3);
    } finally {
      await dispose();
    }
  });

  it("左右方向不产生纵向滚动", async () => {
    const { t, scrollbox, historyWheel, dispose } = await mountRunScreen();
    try {
      (scrollbox.content as any).height = 200;
      await t.renderOnce();

      const before = scrollbox.scrollTop;
      historyWheel("left");
      historyWheel("right");
      await t.flush();
      await t.renderOnce();

      expect(scrollbox.scrollTop).toBe(before);
    } finally {
      await dispose();
    }
  });

  it("滚轮不再请求 footer 高度（旧自管视口已退役）", async () => {
    const heights: number[] = [];
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          maxLines={100}
          markdownEnabled={false}
          onFooterHeightChange={(h: number) => heights.push(h)}
        />
      ),
      { width: 60, height: 24 },
    );
    try {
      await t.mockMouse.scroll(5, 1, "up");
      await t.flush();
      // ★ Task #4954 P0：滚动由 scrollbox 原生接管 ⇒ 不再请求 footer 高度。
      expect(heights.length).toBe(0);
      expect(t.renderer.isDestroyed).toBe(false);
    } finally {
      await t.dispose();
    }
  });
});
