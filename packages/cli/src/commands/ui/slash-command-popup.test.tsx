/**
 * @fileoverview slash-command-popup tests — Task #2312
 *
 * 验证弹窗组件:
 * - 渲染过滤后的命令列表
 * - 选中行高亮 (▶ 前缀 + inverse)
 * - 空查询/无匹配时不渲染
 * - 集成测试: 输入 / 时 REPLInk 显示弹窗
 *
 * 使用 ink-testing-library 模拟 stdin/stdout。
 */

import { describe, test, expect } from "bun:test";
import { isParallelRun } from "../../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { SlashCommandPopup, clampSelectedIndex, computeWindowedIndex } from "./slash-command-popup";
import { COMMANDS, filterCommands } from "./commands-registry";

/**
 * strip ANSI for stable plain-text assertions
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe.skipIf(isParallelRun)("slash-command-popup (Task #2312)", () => {
  describe("渲染", () => {
    test("query=\"/\" 显示所有命令 (含标题 \"Commands\")", () => {
      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/",
          selectedIndex: 0,
        }),
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("Commands");
      // 包含至少 /help /init /model /compact
      expect(frame).toContain("/help");
      expect(frame).toContain("/init");
      expect(frame).toContain("/model");
      expect(frame).toContain("/compact");
    });

    test("query=\"/he\" 只显示 /help", () => {
      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/he",
          selectedIndex: 0,
        }),
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("/help");
      expect(frame).not.toContain("/init");
      expect(frame).not.toContain("/model");
    });

    test("query=\"/m\" 显示 /model 和 /memory", () => {
      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/m",
          selectedIndex: 0,
        }),
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("/model");
      expect(frame).toContain("/memory");
    });

    test("query 无匹配时不渲染", () => {
      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/nonexistent_xyz",
          selectedIndex: 0,
        }),
      );
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame.trim()).toBe("");
    });

    test("选中行显示 ▶ 标记 (其他行不显示)", () => {
      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/",
          selectedIndex: 0, // /help 选中
        }),
      );
      const frame = lastFrame() ?? "";
      // 应该包含至少一个 ▶ (ANSI codes 在前)
      expect(frame).toContain("▶");
      // /help 行有 ▶ (选中), /init 行没有 (未选中)
      // 用 strip 后的 plain text 比较
      const plain = stripAnsi(frame);
      const lines = plain.split("\n").filter((l) => l.trim().length > 0);
      // 第一行 (含 /help) 应有 ▶
      const helpLine = lines.find((l) => l.includes("/help"));
      expect(helpLine).toBeDefined();
      expect(helpLine).toContain("▶");
    });

    test("selectedIndex 切换时, 高亮行跟着变化", () => {
      // 选中 /help (index=0)
      const r1 = render(
        React.createElement(SlashCommandPopup, {
          query: "/",
          selectedIndex: 0,
        }),
      );
      const f1 = stripAnsi(r1.lastFrame() ?? "");
      const l1 = f1.split("\n").filter((l) => l.includes("/help"))[0];
      expect(l1).toContain("▶");

      r1.unmount();

      // 选中 /quit (index=1)
      const r2 = render(
        React.createElement(SlashCommandPopup, {
          query: "/",
          selectedIndex: 1,
        }),
      );
      const f2 = stripAnsi(r2.lastFrame() ?? "");
      const l2 = f2.split("\n").filter((l) => l.includes("/quit"))[0];
      expect(l2).toContain("▶");

      // /help 行此时没有 ▶
      const l1Again = f2.split("\n").filter((l) => l.includes("/help"))[0];
      expect(l1Again).not.toContain("▶");
    });

    test("弹窗显示命令数量 (\"Commands (N)\")", () => {
      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/",
          selectedIndex: 0,
        }),
      );
      const plain = stripAnsi(lastFrame() ?? "");
      expect(plain).toContain(`Commands (${COMMANDS.length})`);
    });
  });

  describe("clampSelectedIndex 工具函数", () => {
    test("index 在范围内不变", () => {
      expect(clampSelectedIndex(2, 5)).toBe(2);
    });

    test("负数钳到 0", () => {
      expect(clampSelectedIndex(-1, 5)).toBe(0);
    });

    test("超出范围钳到 filteredLength - 1", () => {
      expect(clampSelectedIndex(10, 5)).toBe(4);
    });

    test("filteredLength = 0 返回 0", () => {
      expect(clampSelectedIndex(3, 0)).toBe(0);
    });
  });

  describe("computeWindowedIndex 滚动", () => {
    test("filteredLength <= MAX_POPUP_ITEMS 不滚动", () => {
      // 假设 MAX_POPUP_ITEMS = 8
      expect(computeWindowedIndex(3, 5)).toBe(3);
      expect(computeWindowedIndex(0, 0)).toBe(0);
    });

    test("选中靠后的项时滚动窗口", () => {
      // filteredLength=12, MAX_POPUP_ITEMS=8
      // index=10 应该滚动到窗口内
      const result = computeWindowedIndex(10, 12);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(8); // 在窗口内
    });
  });

  describe("filterCommands 跨组件调用", () => {
    test("返回的命令可以传给弹窗组件", () => {
      const filtered = filterCommands("/h");
      expect(filtered.length).toBeGreaterThan(0);
      // 不抛错即通过
      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/h",
          selectedIndex: 0,
        }),
      );
      expect(stripAnsi(lastFrame() ?? "")).toContain("/help");
    });
  });

  /**
   * Task #2316: 视口滚动回归测试
   *
   * 当命令数 > MAX_POPUP_ITEMS (8) 时, 弹窗必须真的滚动:
   * - 视口跟随 selectedIndex 移动 (始终高亮可见行)
   * - 隐藏指示 "X more ↑/↓" 正确反映视口外命令数
   * - 顶部/底部边界不滚动过头
   */
  describe("滚动视口 (Task #2316)", () => {
    // 命令注册表有 13 个, 超过 MAX_POPUP_ITEMS=8 → 触发滚动
    // 注册表顺序: help(0), quit(1), init(2), memory(3), model(4), compact(5),
    //             sessions(6), attach(7), list(8), paste(9), clear(10), status(11), abort(12)
    const TOTAL = COMMANDS.length; // 13
    const expectMax = (n: number) => expect(TOTAL).toBeGreaterThan(n);

    test("RED-T1: selectedIndex=7 时视口滚动, /help 不在视口内, /attach 高亮", () => {
      // 前提: 命令数 > MAX_POPUP_ITEMS (8)
      expectMax(8);

      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/", // 全部 13 个
          selectedIndex: 7, // /attach (原始索引 7)
        }),
      );
      const plain = stripAnsi(lastFrame() ?? "");

      // 视口滚动了 → /help (索引 0) 滚出视口
      expect(plain).not.toContain("/help");
      // /attach 应该高亮
      expect(plain).toContain("▶");
      const lines = plain.split("\n").filter((l) => l.trim().length > 0);
      const attachLine = lines.find((l) => l.includes("/attach"));
      expect(attachLine).toBeDefined();
      expect(attachLine).toContain("▶");
    });

    test("RED-T2: selectedIndex=12 (末尾) 时视口贴底, /abort 高亮, /help 不可见", () => {
      expectMax(8);

      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/",
          selectedIndex: 12, // /abort (最后)
        }),
      );
      const plain = stripAnsi(lastFrame() ?? "");

      // 顶部命令滚出视口
      expect(plain).not.toContain("/help");
      // 底部命令高亮
      const lines = plain.split("\n").filter((l) => l.trim().length > 0);
      const abortLine = lines.find((l) => l.includes("/abort"));
      expect(abortLine).toBeDefined();
      expect(abortLine).toContain("▶");
    });

    test("RED-T3: 隐藏数量指示: selectedIndex=12 时无 'more ↓' (已在末尾)", () => {
      expectMax(8);

      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/",
          selectedIndex: 12, // 最后
        }),
      );
      const plain = stripAnsi(lastFrame() ?? "");

      // 在末尾时不应该有 "more ↓" (因为视口已贴底)
      // 视口上方可能有 "more ↑"
      const commandsLine = plain.split("\n").find((l) => l.includes("Commands"));
      expect(commandsLine).toBeDefined();
      expect(commandsLine).not.toContain("more ↓");
    });

    test("RED-T4: 过滤后 ≤ 8 个时, 全部可见, 不滚动, 无 hidden 指示", () => {
      // 用一个能匹配少于等于 8 个的查询
      // 例如 /a 应该匹配 /attach, /abort, /paste? 不, /paste 不以 a 开头
      // 实际上 filterCommands("a") 匹配: attach (cmdName contains 'a'), abort (cmdName contains 'a')
      // 主名 startsWith('a'): attach ✓, abort ✓
      // 主名 includes('a'): attach ✓, abort ✓, model (no), memory (no)...
      // alias: 无
      // 所以 /a 返回 [attach, abort] = 2 个
      const filtered = filterCommands("/a");
      expect(filtered.length).toBeLessThanOrEqual(8);
      expect(filtered.length).toBeGreaterThan(0);

      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/a",
          selectedIndex: 0,
        }),
      );
      const plain = stripAnsi(lastFrame() ?? "");

      // 全部可见
      expect(plain).toContain("/attach");
      expect(plain).toContain("/abort");
      // 无 hidden 指示
      expect(plain).not.toContain("more");
    });

    test("RED-T5: 顶部边界: selectedIndex=0 时视口贴顶, /help 高亮, /abort 不在视口", () => {
      expectMax(8);

      const { lastFrame } = render(
        React.createElement(SlashCommandPopup, {
          query: "/",
          selectedIndex: 0, // /help (最顶)
        }),
      );
      const plain = stripAnsi(lastFrame() ?? "");

      // /help 应该高亮
      const lines = plain.split("\n").filter((l) => l.trim().length > 0);
      const helpLine = lines.find((l) => l.includes("/help"));
      expect(helpLine).toBeDefined();
      expect(helpLine).toContain("▶");

      // /abort 不在视口 (因为视口前 8 个)
      expect(plain).not.toContain("/abort");
    });
  });
});