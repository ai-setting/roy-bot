/**
 * @fileoverview Task #5077 P3 Phase 2 — **键位滚动命令** 单测（TDD RED）。
 *
 * ## 测什么
 *
 * `scroll-commands.ts`：
 *   1. `SCROLL_KEYS` —— 对齐 opencode `keybind.ts:181-188` 的物理键位表
 *   2. `resolveScrollKeyAmount` —— 键位 → 行数（半视口/¼视口/1 行/绝对）
 *   3. `routeScrollKey` —— KeyEvent → 命令路由（无命中 ⇒ undefined）
 *   4. `applyScrollKey` —— 落盘执行（scrollBy / scrollTo，粘底恢复）
 *
 * ## 键位设计（对齐 opencode，避开本仓 TextInput 冲突）
 *
 * | 语义              | opencode 主键   | opencode 别名 | 本仓采纳                |
 * |-------------------|----------------|---------------|------------------------|
 * | 上翻半视口        | pageup         | ctrl+alt+b    | pageup + ctrl+alt+b    |
 * | 下翻半视口        | pagedown       | ctrl+alt+f    | pagedown + ctrl+alt+f  |
 * | 上翻 ¼ 视口       | ctrl+alt+u     | —             | ctrl+alt+u + ctrl+u    |
 * | 下翻 ¼ 视口       | ctrl+alt+d     | —             | ctrl+alt+d + ctrl+u    |
 * | 上 1 行           | ctrl+alt+y     | —             | ctrl+alt+y             |
 * | 下 1 行           | ctrl+alt+e     | —             | ctrl+alt+e             |
 * | 跳顶              | ctrl+g         | home          | ctrl+g（home 留给行内光标） |
 * | 跳底              | ctrl+alt+g     | end           | ctrl+alt+g（end 同上） |
 *
 * `ctrl+u`/`ctrl+d` 别名来自用户需求（「Ctrl+u/Ctrl+d 或对齐 opencode」）；
 * opencode 的主键 ctrl+alt+u/d 是 emacs 风格，本仓两者都收。
 */

import { describe, expect, it } from "bun:test";
import { SCROLL_KEYS, resolveScrollKeyAmount, routeScrollKey, applyScrollKey } from "./scroll-commands.js";

describe("scroll-commands.ts — 键位表（对齐 opencode keybind.ts）", () => {
  it("每个语义都注册了物理键位", () => {
    const semantics = Object.keys(SCROLL_KEYS).sort();
    expect(semantics).toEqual(
      ["halfPageDown", "halfPageUp", "jumpToBottom", "jumpToTop", "lineDown", "lineUp", "pageDown", "pageUp"].sort(),
    );
  });

  it("pageup/pagedown 主键 + ctrl+alt+b/f 别名（opencode 同款）", () => {
    expect(SCROLL_KEYS.pageUp.keys).toContain("pageup");
    expect(SCROLL_KEYS.pageUp.keys).toContain("ctrl+alt+b");
    expect(SCROLL_KEYS.pageDown.keys).toContain("pagedown");
    expect(SCROLL_KEYS.pageDown.keys).toContain("ctrl+alt+f");
  });

  it("半视口键位 ctrl+alt+u/d（opencode）+ ctrl+u/d 别名（用户需求）", () => {
    expect(SCROLL_KEYS.halfPageUp.keys).toContain("ctrl+alt+u");
    expect(SCROLL_KEYS.halfPageUp.keys).toContain("ctrl+u");
    expect(SCROLL_KEYS.halfPageDown.keys).toContain("ctrl+alt+d");
    expect(SCROLL_KEYS.halfPageDown.keys).toContain("ctrl+d");
  });

  it("1 行键位 ctrl+alt+y/e（opencode 同款）", () => {
    expect(SCROLL_KEYS.lineUp.keys).toContain("ctrl+alt+y");
    expect(SCROLL_KEYS.lineDown.keys).toContain("ctrl+alt+e");
  });

  it("跳顶/跳底用 ctrl+g / ctrl+alt+g（opencode 别名键，home/end 留给 TextInput 行内光标）", () => {
    expect(SCROLL_KEYS.jumpToTop.keys).toContain("ctrl+g");
    expect(SCROLL_KEYS.jumpToBottom.keys).toContain("ctrl+alt+g");
    // 不与 TextInput 行内光标冲突
    expect(SCROLL_KEYS.jumpToTop.keys).not.toContain("home");
    expect(SCROLL_KEYS.jumpToBottom.keys).not.toContain("end");
  });
});

describe("scroll-commands.ts — 行数求值", () => {
  it("page 语义 = 半视口（opencode moveTranscript(±scroll.height/2)）", () => {
    expect(SCROLL_KEYS.pageUp.amount({ viewportHeight: 20 })).toBe(10);
    expect(SCROLL_KEYS.pageDown.amount({ viewportHeight: 20 })).toBe(10);
  });

  it("halfPage 语义 = ¼ 视口（opencode moveTranscript(±scroll.height/4)）", () => {
    expect(SCROLL_KEYS.halfPageUp.amount({ viewportHeight: 20 })).toBe(5);
    expect(SCROLL_KEYS.halfPageDown.amount({ viewportHeight: 20 })).toBe(5);
  });

  it("line 语义 = 1 行", () => {
    expect(SCROLL_KEYS.lineUp.amount({ viewportHeight: 20 })).toBe(1);
    expect(SCROLL_KEYS.lineDown.amount({ viewportHeight: 20 })).toBe(1);
  });

  it("jump 语义 = 绝对定位（Infinity 标记）", () => {
    expect(SCROLL_KEYS.jumpToTop.amount({ viewportHeight: 20 })).toBe(Number.POSITIVE_INFINITY);
    expect(SCROLL_KEYS.jumpToBottom.amount({ viewportHeight: 20 })).toBe(Number.POSITIVE_INFINITY);
  });

  it("视口高度非法时 page/halfPage 回落 3 行步进", () => {
    expect(SCROLL_KEYS.pageUp.amount({ viewportHeight: 0 })).toBe(3);
    expect(SCROLL_KEYS.halfPageUp.amount({ viewportHeight: Number.NaN })).toBe(3);
    expect(SCROLL_KEYS.pageDown.amount({ viewportHeight: 1.5 })).toBe(3);
  });

  it("resolveScrollKeyAmount：方向语义 → 带符号行数", () => {
    expect(resolveScrollKeyAmount(SCROLL_KEYS.pageUp, 20)).toBe(-10);
    expect(resolveScrollKeyAmount(SCROLL_KEYS.pageDown, 20)).toBe(10);
    expect(resolveScrollKeyAmount(SCROLL_KEYS.halfPageUp, 20)).toBe(-5);
    expect(resolveScrollKeyAmount(SCROLL_KEYS.halfPageDown, 20)).toBe(5);
    expect(resolveScrollKeyAmount(SCROLL_KEYS.lineUp, 20)).toBe(-1);
    expect(resolveScrollKeyAmount(SCROLL_KEYS.lineDown, 20)).toBe(1);
  });
});

describe("scroll-commands.ts — KeyEvent 路由", () => {
  it("pageup 键 → pageUp 命令", () => {
    const key = { name: "pageup", ctrl: false, meta: false, shift: false };
    expect(routeScrollKey(key)?.name).toBe("pageUp");
  });

  it("ctrl+alt+u → halfPageUp（meta 传 alt）", () => {
    const key = { name: "u", ctrl: true, meta: true, shift: false };
    expect(routeScrollKey(key)?.name).toBe("halfPageUp");
  });

  it("ctrl+u → halfPageUp（本仓别名）", () => {
    const key = { name: "u", ctrl: true, meta: false, shift: false };
    expect(routeScrollKey(key)?.name).toBe("halfPageUp");
  });

  it("ctrl+alt+d → halfPageDown；ctrl+d → halfPageDown", () => {
    expect(routeScrollKey({ name: "d", ctrl: true, meta: true, shift: false })?.name).toBe("halfPageDown");
    expect(routeScrollKey({ name: "d", ctrl: true, meta: false, shift: false })?.name).toBe("halfPageDown");
  });

  it("ctrl+alt+y/e → lineUp/lineDown", () => {
    expect(routeScrollKey({ name: "y", ctrl: true, meta: true, shift: false })?.name).toBe("lineUp");
    expect(routeScrollKey({ name: "e", ctrl: true, meta: true, shift: false })?.name).toBe("lineDown");
  });

  it("ctrl+g → jumpToTop；ctrl+alt+g → jumpToBottom", () => {
    expect(routeScrollKey({ name: "g", ctrl: true, meta: false, shift: false })?.name).toBe("jumpToTop");
    expect(routeScrollKey({ name: "g", ctrl: true, meta: true, shift: false })?.name).toBe("jumpToBottom");
  });

  it("普通字符 / 方向键 / home / end 不路由", () => {
    expect(routeScrollKey({ name: "a", ctrl: false, meta: false, shift: false })).toBeUndefined();
    expect(routeScrollKey({ name: "up", ctrl: false, meta: false, shift: false })).toBeUndefined();
    expect(routeScrollKey({ name: "home", ctrl: false, meta: false, shift: false })).toBeUndefined();
    expect(routeScrollKey({ name: "end", ctrl: false, meta: false, shift: false })).toBeUndefined();
    // ctrl+c 留给 TextInput 的取消语义
    expect(routeScrollKey({ name: "c", ctrl: true, meta: false, shift: false })).toBeUndefined();
  });

  it("shift 组合不路由（避免误伤选区语义）", () => {
    expect(routeScrollKey({ name: "u", ctrl: true, meta: true, shift: true })).toBeUndefined();
  });
});

describe("scroll-commands.ts — applyScrollKey 落盘执行", () => {
  function makeScrollbox(startTop = 0) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      calls,
      scrollTop: startTop,
      scrollHeight: 200,
      viewport: { height: 20 },
      scrollBy(delta: number, unit?: string) {
        calls.push({ method: "scrollBy", args: [delta, unit] });
        if (unit === "viewport") this.scrollTop += delta * this.viewport.height;
        else if (unit === "content") this.scrollTop += delta * this.scrollHeight;
        else this.scrollTop += delta;
      },
      scrollTo(target: number) {
        calls.push({ method: "scrollTo", args: [target] });
        this.scrollTop = target;
      },
    };
  }

  it("pageUp：滚到 半视口 之前（scrollTop - ⌈vh/2⌉，下限 0）", () => {
    const sb = makeScrollbox(180);
    applyScrollKey(SCROLL_KEYS.pageUp, sb as never);
    // scrollTop=180, vh=20 ⇒ 半视口=10 ⇒ 170
    expect(sb.calls[0]).toEqual({ method: "scrollTo", args: [170] });
  });

  it("halfPageUp：滚到 ¼ 视口 之前（scrollTop - ⌈vh/4⌉）", () => {
    const sb = makeScrollbox(180);
    applyScrollKey(SCROLL_KEYS.halfPageUp, sb as never);
    // 180 - 5 = 175
    expect(sb.calls[0]).toEqual({ method: "scrollTo", args: [175] });
  });

  it("lineUp/lineDown：滚到 ±1 行（scrollTop ∓ 1）", () => {
    const sb = makeScrollbox(180);
    applyScrollKey(SCROLL_KEYS.lineUp, sb as never);
    expect(sb.calls[0]).toEqual({ method: "scrollTo", args: [179] });
    applyScrollKey(SCROLL_KEYS.lineDown, sb as never);
    expect(sb.calls[1]).toEqual({ method: "scrollTo", args: [180] }); // clamp 到 maxScrollTop
  });

  it("★滚动不越界：顶部之上 clamp 到 0，底部之下 clamp 到 maxScrollTop", () => {
    const sb = makeScrollbox();
    sb.scrollTop = 3;
    applyScrollKey(SCROLL_KEYS.pageUp, sb as never);
    expect(sb.calls[0]).toEqual({ method: "scrollTo", args: [0] });
    sb.scrollTop = 198; // max = 200 - 20 = 180
    sb.calls.length = 0;
    applyScrollKey(SCROLL_KEYS.pageDown, sb as never);
    expect(sb.calls[0]).toEqual({ method: "scrollTo", args: [180] });
  });

  it("jumpToTop：scrollTo(0) + 粘底关闭", () => {
    const sb = makeScrollbox();
    (sb as any).stickyScroll = true;
    applyScrollKey(SCROLL_KEYS.jumpToTop, sb as never);
    expect(sb.calls[0]).toEqual({ method: "scrollTo", args: [0] });
    expect((sb as any).stickyScroll).toBe(false);
  });

  it("jumpToBottom：scrollTo(scrollHeight) + 粘底恢复", () => {
    const sb = makeScrollbox();
    (sb as any).stickyScroll = false;
    applyScrollKey(SCROLL_KEYS.jumpToBottom, sb as never);
    expect(sb.calls[0]).toEqual({ method: "scrollTo", args: [200] });
    expect((sb as any).stickyScroll).toBe(true);
  });

  it("scrollbox 缺失时静默不炸", () => {
    expect(() => applyScrollKey(SCROLL_KEYS.pageUp, undefined as never)).not.toThrow();
    expect(() => applyScrollKey(SCROLL_KEYS.jumpToTop, undefined as never)).not.toThrow();
  });
});
