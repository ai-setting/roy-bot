/**
 * @fileoverview Task #5109 P7 —— 斜杠补全面板**状态机**单元测试（TDD RED 先行）。
 *
 * 被测模块：`./slash-palette-state.js`（P7 新增）。
 *
 * ## 为什么状态机要独立成纯函数模块
 *
 * opentui 的 `testRender` 在 `bun test` 下**急求值**（不能靠重绘验证），
 * 而 UI 交互（↑↓/Tab/Enter/Esc）正是「状态变化 → 重绘」型断言。
 * ⇒ 把状态机抽成纯函数 ⇒ 可以在不依赖渲染器的前提下**穷举**交互语义，
 * UI 组件只负责把状态画出来。
 *
 * ## 对齐 opencode
 *
 * opencode 的分层 keymap（footer.prompt.tsx:1283-1335）在面板可见时把
 * ↑↓/Esc/Enter/Tab 接管给面板；关面板时 ↑↓ 回到历史导航。本状态机就是
 * 那一层的等价物。
 */

import { describe, expect, it } from "bun:test";
import {
  initialSlashPaletteState,
  slashPaletteReducer,
  slashTriggerQuery,
  type SlashPaletteState,
} from "./slash-palette-state.js";

const CLOSED: SlashPaletteState = initialSlashPaletteState();

describe("tui-solid P7 slash-palette-state — 触发检测", () => {
  it("detects a leading slash as the trigger", () => {
    expect(slashTriggerQuery("/")).toBe("");
  });

  it("returns the typed query after the slash", () => {
    expect(slashTriggerQuery("/he")).toBe("he");
  });

  it("does not trigger when the slash is not at a word boundary", () => {
    expect(slashTriggerQuery("abc/def")).toBeNull();
  });

  it("does not trigger after whitespace in the query", () => {
    expect(slashTriggerQuery("/help me")).toBeNull();
  });

  it("does not trigger on a second slash", () => {
    expect(slashTriggerQuery("/a/b")).toBeNull();
  });

  it("triggers on a slash after a space", () => {
    expect(slashTriggerQuery("hello /mo")).toBe("mo");
  });

  it("returns null for an empty string", () => {
    expect(slashTriggerQuery("")).toBeNull();
  });
});

describe("tui-solid P7 slash-palette-state — 状态迁移", () => {
  it("starts closed with an empty query", () => {
    expect(CLOSED.open).toBe(false);
    expect(CLOSED.query).toBe("");
    expect(CLOSED.selectedIndex).toBe(0);
  });

  it("opens on a slash trigger", () => {
    const next = slashPaletteReducer(CLOSED, { type: "trigger", query: "" });
    expect(next.open).toBe(true);
    expect(next.selectedIndex).toBe(0);
  });

  it("updates the query while open", () => {
    const opened = slashPaletteReducer(CLOSED, { type: "trigger", query: "" });
    const next = slashPaletteReducer(opened, { type: "query", query: "he" });
    expect(next.query).toBe("he");
    expect(next.open).toBe(true);
  });

  it("resets the selection when the query changes", () => {
    const opened = slashPaletteReducer(CLOSED, { type: "trigger", query: "" });
    const moved = slashPaletteReducer(opened, { type: "move", delta: 2 });
    expect(moved.selectedIndex).toBe(2);
    const retyped = slashPaletteReducer(moved, { type: "query", query: "c" });
    expect(retyped.selectedIndex).toBe(0);
  });

  it("moves the selection down", () => {
    const opened = slashPaletteReducer(CLOSED, { type: "trigger", query: "" });
    const next = slashPaletteReducer(opened, { type: "move", delta: 1 });
    expect(next.selectedIndex).toBe(1);
  });

  it("moves the selection up", () => {
    const opened = slashPaletteReducer(CLOSED, { type: "trigger", query: "" });
    const moved = slashPaletteReducer(opened, { type: "move", delta: 1 });
    const next = slashPaletteReducer(moved, { type: "move", delta: -1 });
    expect(next.selectedIndex).toBe(0);
  });

  it("clamps the selection at the top", () => {
    const opened = slashPaletteReducer(CLOSED, { type: "trigger", query: "" });
    const next = slashPaletteReducer(opened, { type: "move", delta: -1 });
    expect(next.selectedIndex).toBe(0);
  });

  it("clamps the selection at the bottom", () => {
    const opened = slashPaletteReducer(CLOSED, { type: "trigger", query: "" });
    const next = slashPaletteReducer(opened, { type: "move", delta: 99, itemCount: 3 });
    expect(next.selectedIndex).toBe(2);
  });

  it("closes on escape and clears the query", () => {
    const opened = slashPaletteReducer(CLOSED, { type: "trigger", query: "he" });
    const next = slashPaletteReducer(opened, { type: "close" });
    expect(next.open).toBe(false);
    expect(next.query).toBe("");
    expect(next.selectedIndex).toBe(0);
  });

  it("ignores a move while closed", () => {
    const next = slashPaletteReducer(CLOSED, { type: "move", delta: 1 });
    expect(next.selectedIndex).toBe(0);
    expect(next.open).toBe(false);
  });

  it("ignores a query update while closed", () => {
    const next = slashPaletteReducer(CLOSED, { type: "query", query: "he" });
    expect(next.open).toBe(false);
    expect(next.query).toBe("");
  });

  it("closes when the trigger is gone", () => {
    const opened = slashPaletteReducer(CLOSED, { type: "trigger", query: "he" });
    const next = slashPaletteReducer(opened, { type: "trigger", query: null });
    expect(next.open).toBe(false);
    expect(next.query).toBe("");
  });

  it("reports the count of matched items for clamping", () => {
    const opened = slashPaletteReducer(CLOSED, { type: "trigger", query: "" });
    const next = slashPaletteReducer(opened, { type: "move", delta: 1, itemCount: 3 });
    expect(next.selectedIndex).toBe(1);
    const clamped = slashPaletteReducer(next, { type: "move", delta: 5, itemCount: 3 });
    expect(clamped.selectedIndex).toBe(2);
  });
});
