/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5077 P3 Phase 2 — **键位滚动** 集成测试。
 *
 * ## 测什么
 *
 * RunScreen 接上 `useKeyboard` 键位路由后（真实按键字节 → 真实滚动）：
 *   1. **pageup**（ESC[5~）⇒ scrollTop 变化 ≈ 半视口（opencode session.page.up）
 *   2. **ctrl+u**（0x15）⇒ ≈ ¼ 视口（本仓别名；opencode ctrl+alt+u 同语义）
 *   3. **ctrl+alt+y**（ESC 0x19）⇒ 1 行（session.line.up）
 *   4. **ctrl+g**（0x07）⇒ 跳顶（session.first）
 *   5. **ctrl+alt+g**（ESC 0x07）⇒ 跳底 + 粘底恢复（session.last）
 *   6. **home/end 不滚历史**（留给 TextInput 行内光标）
 *
 * ## 两个实测踩坑（写在这里避免后人重蹈）
 *
 * 1. **`mockInput.pressKey("pageup")` 是陷阱** ——
 *    opentui 的 `KeyCodes` 表**没有** PAGEUP/PAGEDOWN
 *    （node_modules/@opentui/core/testing.bun.js）⇒ `pressKey("pageup")`
 *    会把**字面字符串** "pageup"（6 个字符）灌进 stdin ⇒
 *    被解析成 6 次普通按键 ⇒ 断言全错。
 *    ⇒ 必须用**真实终端字节序列**：`pressKeys(["\x1B[5~"])`。
 * 2. **RunScreen 内部历史在 testRender 下不 flush** ——
 *    Solid 的 `<For each={historyRows()}>` 在 testRender 环境下不重新
 *    渲染（Phase 1 已记录同一现象）⇒ 无法靠「灌历史」制造可滚动内容。
 *    ⇒ 改用 Phase 1 已验证的技巧：**直接设置 `scrollbox.content.height`**
 *    造出可滚动空间（不依赖历史渲染链路）。
 *
 * ## 断言方式
 *
 * `testRender` + `mockInput.pressKeys([...])`（走**真实**字节解析链），
 * 断言 scrollbox.scrollTop 的实际变化 —— 不做源码字符串断言。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { ScrollBoxRenderable } from "@opentui/core";
import RunScreenSolid from "./RunScreen.js";
import { isSolidReactive } from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** 真实终端字节序列（不用 pressKey(name) —— KeyCodes 表无 pageup）。 */
const BYTES = {
  pageUp: "\x1B[5~",
  pageDown: "\x1B[6~",
  ctrlU: "\x15", // ctrl+u
  ctrlD: "\x04", // ctrl+d
  ctrlG: "\x07", // ctrl+g
  ctrlAltG: "\x1B\x07", // ESC + 0x07（meta 修饰）
  ctrlAltY: "\x1B\x19", // ESC + ctrl+y
} as const;

interface Mounted {
  t: Awaited<ReturnType<typeof testRender>>;
  scrollbox: ScrollBoxRenderable;
  dispose: () => Promise<void>;
}

/**
 * 挂载 RunScreen，并**直接撑高 scrollbox 的内容**制造可滚动空间。
 *
 * ⚠️ 为什么用 `content.height` 而不是灌历史：Solid 的 `<For>` 在
 * testRender 环境下不随信号变化重渲染（Phase 1 同样踩过）⇒
 * 灌历史造不出可滚动空间。直接设 content.height 是**渲染层事实**
 * （scrollbox 的滚动能力由 content/viewport 高度比决定），
 * 且与生产路径「内容超出视口即可滚」同构。
 */
async function mountRunScreen(
  contentHeight = 200,
  size: { width: number; height: number } = { width: 60, height: 14 },
): Promise<Mounted> {
  const t = await testRender(
    () => <RunScreenSolid handleQuery={async () => "ok"} maxLines={100} markdownEnabled={false} />,
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
  const scrollbox = findScrollbox((t as any).renderer?.root);
  if (!scrollbox) throw new Error("scrollbox not found in RunScreen tree");

  // 造出可滚动空间（内容 200 行 > 视口 ~11 行）。
  scrollbox.content.height = contentHeight;
  await t.renderOnce();

  return { t, scrollbox, dispose: () => t.dispose() };
}

/** 滚到底（钉底位），返回滚动前的 scrollTop。 */
async function scrollToBottom(t: Awaited<ReturnType<typeof testRender>>, scrollbox: ScrollBoxRenderable) {
  scrollbox.scrollTop = scrollbox.scrollHeight;
  await t.renderOnce();
  return scrollbox.scrollTop;
}

describeIfClient("RunScreen.p3-keys — 键位滚动（真实按键字节链）", () => {
  it("pageup（ESC[5~）⇒ 半视口上滚（opencode session.page.up 语义）", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      const before = await scrollToBottom(t, scrollbox);
      const vh = scrollbox.viewport.height;
      await t.mockInput.pressKeys([BYTES.pageUp]);
      await t.flush();
      await t.renderOnce();
      const moved = before - scrollbox.scrollTop;
      // 半视口（⌈vh/2⌉）；允许 ±1 行的 native 取整差
      expect(Math.abs(moved - Math.ceil(vh / 2))).toBeLessThanOrEqual(1);
      expect(moved).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it("pagedown（ESC[6~）⇒ 半视口下滚", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      scrollbox.scrollTop = 40;
      await t.renderOnce();
      const before = scrollbox.scrollTop;
      await t.mockInput.pressKeys([BYTES.pageDown]);
      await t.flush();
      await t.renderOnce();
      expect(scrollbox.scrollTop - before).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it("ctrl+u（0x15）⇒ ¼ 视口上滚（本仓别名；opencode ctrl+alt+u 同语义）", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      const before = await scrollToBottom(t, scrollbox);
      const vh = scrollbox.viewport.height;
      await t.mockInput.pressKeys([BYTES.ctrlU]);
      await t.flush();
      await t.renderOnce();
      const moved = before - scrollbox.scrollTop;
      expect(Math.abs(moved - Math.ceil(vh / 4))).toBeLessThanOrEqual(1);
      expect(moved).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it("ctrl+alt+y（ESC 0x19）⇒ 恰好 1 行（session.line.up）", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      const before = await scrollToBottom(t, scrollbox);
      await t.mockInput.pressKeys([BYTES.ctrlAltY]);
      await t.flush();
      await t.renderOnce();
      expect(before - scrollbox.scrollTop).toBe(1);
    } finally {
      await dispose();
    }
  });

  it("ctrl+g（0x07）⇒ 跳顶（scrollTop=0）", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      await scrollToBottom(t, scrollbox);
      await t.mockInput.pressKeys([BYTES.ctrlG]);
      await t.flush();
      await t.renderOnce();
      expect(scrollbox.scrollTop).toBe(0);
    } finally {
      await dispose();
    }
  });

  it("ctrl+alt+g（ESC 0x07）⇒ 跳底 + 粘底恢复（session.last）", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      // 先跳顶 + 关粘底
      scrollbox.stickyScroll = false;
      scrollbox.scrollTop = 0;
      await t.renderOnce();
      await t.mockInput.pressKeys([BYTES.ctrlAltG]);
      await t.flush();
      await t.renderOnce();
      expect(scrollbox.scrollTop).toBe(scrollbox.scrollHeight - scrollbox.viewport.height);
      expect(scrollbox.stickyScroll).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("home/end 不滚历史（留给 TextInput 行内光标）", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      const before = await scrollToBottom(t, scrollbox);
      await t.mockInput.pressKeys(["\x1B[H"]); // home
      await t.flush();
      await t.renderOnce();
      await t.mockInput.pressKeys(["\x1B[F"]); // end
      await t.flush();
      await t.renderOnce();
      expect(scrollbox.scrollTop).toBe(before);
    } finally {
      await dispose();
    }
  });

  it("★键位滚动不越界（clamp 到 [0, maxScrollTop]）", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      // 钉底状态 ⇒ 滚到底
      scrollbox.stickyScroll = true;
      await scrollToBottom(t, scrollbox);
      // 键位上滚 ⇒ 视图离开底部 ⇒ sticky 必须**脱离**（否则新内容会把用户拽回底部）
      await t.mockInput.pressKeys([BYTES.ctrlU]);
      await t.flush();
      await t.renderOnce();
      expect(scrollbox.scrollTop).toBeLessThan(scrollbox.scrollHeight - scrollbox.viewport.height);
      // 滚动位置必须落在合法区间内（不越上界、不越下界）。
      const maxScrollTop = scrollbox.scrollHeight - scrollbox.viewport.height;
      expect(scrollbox.scrollTop).toBeGreaterThanOrEqual(0);
      expect(scrollbox.scrollTop).toBeLessThanOrEqual(maxScrollTop);
    } finally {
      await dispose();
    }
  });

  it("普通字符（'a'）不滚历史（不误伤输入）", async () => {
    const { t, scrollbox, dispose } = await mountRunScreen();
    try {
      const before = await scrollToBottom(t, scrollbox);
      await t.mockInput.pressKeys(["a"]);
      await t.flush();
      await t.renderOnce();
      expect(scrollbox.scrollTop).toBe(before);
    } finally {
      await dispose();
    }
  });
});
