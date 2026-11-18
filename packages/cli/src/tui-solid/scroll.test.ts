/**
 * @fileoverview Task #5041 — **滚动步进模块**（scroll.ts）单测。
 *
 * 覆盖三件事：
 *   1. `FixedStepScrollAccel.tick()` 恒返回配置的步进行数（默认 3）。
 *   2. opentui 的滚轮计算链 `scrollAmount = baseDelta × tick()` 的**行数换算**
 *      —— baseDelta 在 opentui 0.6.6 的 MouseParser 里**硬编码为 1**
 *      （`chunk-node-2rg7pskw.js:4750` / `:4790`），
 *      所以 `tick()` 的返回值 **就是** 最终滚动行数。
 *   3. 键位预留接口（page/jump 语义）可独立求值，不依赖 opentui。
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SCROLL_STEP_LINES,
  FixedStepScrollAccel,
  SCROLL_KEY_BINDINGS,
  createScrollAcceleration,
  isDescendantOf,
  resolveScrollStepLines,
  scrollLinesForWheelEvent,
} from "./scroll.js";

describe("scroll.ts — 滚轮步进常量", () => {
  it("默认步进是 3 行（对齐 opencode CustomSpeedScroll(3)）", () => {
    expect(DEFAULT_SCROLL_STEP_LINES).toBe(3);
  });

  it("步进行数必须是正整数（非法值回落到默认）", () => {
    expect(resolveScrollStepLines(5)).toBe(5);
    expect(resolveScrollStepLines(1)).toBe(1);
    expect(resolveScrollStepLines(0)).toBe(DEFAULT_SCROLL_STEP_LINES);
    expect(resolveScrollStepLines(-2)).toBe(DEFAULT_SCROLL_STEP_LINES);
    expect(resolveScrollStepLines(2.5)).toBe(DEFAULT_SCROLL_STEP_LINES);
    expect(resolveScrollStepLines(Number.NaN)).toBe(DEFAULT_SCROLL_STEP_LINES);
    expect(resolveScrollStepLines(undefined)).toBe(DEFAULT_SCROLL_STEP_LINES);
  });
});

describe("scroll.ts — FixedStepScrollAccel", () => {
  it("tick() 恒返回步进行数（与时间无关）", () => {
    const accel = new FixedStepScrollAccel(3);
    expect(accel.tick()).toBe(3);
    expect(accel.tick(0)).toBe(3);
    expect(accel.tick(1_000_000)).toBe(3);
  });

  it("tick() 的返回值就是最终滚动行数（baseDelta ≡ 1）", () => {
    // opentui 0.6.6：scrollAmount = (event.scroll.delta ?? 0) * multiplier，
    // 而 MouseParser 恒发 delta: 1 ⇒ scrollAmount = 1 * tick() = tick() 行。
    const accel = new FixedStepScrollAccel(3);
    const baseDelta = 1;
    const scrollAmount = baseDelta * accel.tick();
    expect(scrollAmount).toBe(3);
  });

  it("reset() 复位内部状态且不改变步进值", () => {
    const accel = new FixedStepScrollAccel(3);
    accel.reset();
    expect(accel.tick()).toBe(3);
  });

  it("默认构造就是 3 行步进", () => {
    const accel = new FixedStepScrollAccel();
    expect(accel.tick()).toBe(DEFAULT_SCROLL_STEP_LINES);
  });

  it("非法步进回落到默认值", () => {
    const accel = new FixedStepScrollAccel(0);
    expect(accel.tick()).toBe(DEFAULT_SCROLL_STEP_LINES);
  });
});

describe("scroll.ts — createScrollAcceleration", () => {
  it("返回实现了 ScrollAcceleration 接口的实例", () => {
    const accel = createScrollAcceleration();
    expect(typeof accel.tick).toBe("function");
    expect(typeof accel.reset).toBe("function");
    expect(accel.tick()).toBe(DEFAULT_SCROLL_STEP_LINES);
  });

  it("支持自定义步进行数", () => {
    const accel = createScrollAcceleration(5);
    expect(accel.tick()).toBe(5);
  });
});

describe("scroll.ts — 滚轮事件 → 行数换算", () => {
  it("up 事件向上滚 step 行", () => {
    expect(scrollLinesForWheelEvent({ direction: "up", delta: 1 }, 3)).toBe(3);
  });

  it("down 事件向下滚 step 行", () => {
    expect(scrollLinesForWheelEvent({ direction: "down", delta: 1 }, 3)).toBe(3);
  });

  it("左右方向不产生纵向滚动（返回 0）", () => {
    expect(scrollLinesForWheelEvent({ direction: "left", delta: 1 }, 3)).toBe(0);
    expect(scrollLinesForWheelEvent({ direction: "right", delta: 1 }, 3)).toBe(0);
  });

  it("未知方向返回 0", () => {
    expect(scrollLinesForWheelEvent({ direction: "unknown", delta: 1 }, 3)).toBe(0);
    expect(scrollLinesForWheelEvent({}, 3)).toBe(0);
  });

  it("delta 缺失时按 1 处理（与 opentui 的 delta ?? 0 + 我们的缺省一致）", () => {
    // opentui 自己会兜底 delta ?? 0；我们在纯函数层对缺省 delta 兜底为 1。
    expect(scrollLinesForWheelEvent({ direction: "up" }, 3)).toBe(3);
  });
});

describe("scroll.ts — 键位预留接口", () => {
  it("声明了 page-up / page-down / 跳到顶 / 跳到底 四个语义键位", () => {
    expect(Object.keys(SCROLL_KEY_BINDINGS).sort()).toEqual(
      ["jumpToBottom", "jumpToTop", "pageDown", "pageUp"].sort(),
    );
  });

  it("每个键位都声明了语义方向（供 P3 后续阶段接线）", () => {
    for (const binding of Object.values(SCROLL_KEY_BINDINGS)) {
      expect(["up", "down", "top", "bottom"]).toContain(binding.direction);
    }
  });

  it("page 键位按视口高度翻页（用注入的 viewportHeight 求值）", () => {
    const pageUp = SCROLL_KEY_BINDINGS.pageUp;
    expect(pageUp.linesFor(20)).toBe(20);
    const pageDown = SCROLL_KEY_BINDINGS.pageDown;
    expect(pageDown.linesFor(20)).toBe(20);
  });

  it("视口高度未知时 page 键位回落到默认步进", () => {
    expect(SCROLL_KEY_BINDINGS.pageUp.linesFor(undefined)).toBe(DEFAULT_SCROLL_STEP_LINES);
    expect(SCROLL_KEY_BINDINGS.pageUp.linesFor(0)).toBe(DEFAULT_SCROLL_STEP_LINES);
  });

  it("跳到顶 / 跳到底 是绝对定位（lines 为 Infinity）", () => {
    expect(SCROLL_KEY_BINDINGS.jumpToTop.linesFor(20)).toBe(Number.POSITIVE_INFINITY);
    expect(SCROLL_KEY_BINDINGS.jumpToBottom.linesFor(20)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("scroll.ts — isDescendantOf（防重复滚动）", () => {
  /** 造一个假的 renderable 链：leaf → mid → root。 */
  function chain(): { root: any; mid: any; leaf: any } {
    const root: any = { id: "root" };
    const mid: any = { id: "mid", parent: root };
    const leaf: any = { id: "leaf", parent: mid };
    return { root, mid, leaf };
  }

  it("自身算后代", () => {
    const { root } = chain();
    expect(isDescendantOf(root, root)).toBe(true);
  });

  it("直接子节点算后代", () => {
    const { root, mid } = chain();
    expect(isDescendantOf(mid, root)).toBe(true);
  });

  it("隔一层的子孙也算后代", () => {
    const { root, leaf } = chain();
    expect(isDescendantOf(leaf, root)).toBe(true);
  });

  it("不在祖先链上的节点不算后代", () => {
    const { root } = chain();
    const stranger: any = { id: "stranger" };
    expect(isDescendantOf(stranger, root)).toBe(false);
  });

  it("空输入不抛异常，返回 false", () => {
    expect(isDescendantOf(undefined, {})).toBe(false);
    expect(isDescendantOf({}, undefined)).toBe(false);
    expect(isDescendantOf(null, null)).toBe(false);
  });

  it("环状 parent 链不会死循环（深度上限）", () => {
    const a: any = { id: "a" };
    const b: any = { id: "b", parent: a };
    a.parent = b; // 人为造环
    expect(isDescendantOf(a, { id: "unrelated" })).toBe(false);
  });
});
