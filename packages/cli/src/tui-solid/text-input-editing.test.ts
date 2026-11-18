/**
 * @fileoverview Unit tests for the **tui-solid** fork of the pure TextInput
 * caret/editing helpers (片3, Task #4297; forked from tui/ Task #4103). These are deterministic — no terminal keypress simulation —
 * so caret behaviour is verified without the flakiness that let the
 * original always-at-end cursor slip through.
 */

import { describe, it, expect } from "bun:test";
import {
  clampCursor,
  deleteAt,
  deleteBefore,
  editReducer,
  insertText,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  splitAtCursor,
  type TextEdit,
} from "./text-input-editing.js";

describe("text-input-editing (Task #4103 caret logic)", () => {
  it("insertText inserts at the caret and advances the caret", () => {
    expect(insertText({ value: "ac", cursor: 1 }, "b")).toEqual({
      value: "abc",
      cursor: 2,
    });
    expect(insertText({ value: "", cursor: 0 }, "x")).toEqual({
      value: "x",
      cursor: 1,
    });
    expect(insertText({ value: "ab", cursor: 2 }, "c")).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  it("insertText supports multi-character (paste) input", () => {
    expect(insertText({ value: "ac", cursor: 1 }, "bb")).toEqual({
      value: "abbc",
      cursor: 3,
    });
  });

  it("deleteBefore removes the character before the caret", () => {
    expect(deleteBefore({ value: "abc", cursor: 2 })).toEqual({
      value: "ac",
      cursor: 1,
    });
    // No-op at index 0
    expect(deleteBefore({ value: "abc", cursor: 0 })).toEqual({
      value: "abc",
      cursor: 0,
    });
  });

  it("deleteAt removes the character at the caret", () => {
    expect(deleteAt({ value: "abc", cursor: 1 })).toEqual({
      value: "ac",
      cursor: 1,
    });
    // No-op at end of buffer
    expect(deleteAt({ value: "abc", cursor: 3 })).toEqual({
      value: "abc",
      cursor: 3,
    });
  });

  it("moveLeft / moveRight clamp at the ends", () => {
    expect(moveLeft({ value: "ab", cursor: 0 }).cursor).toBe(0);
    expect(moveLeft({ value: "ab", cursor: 2 }).cursor).toBe(1);
    expect(moveRight({ value: "ab", cursor: 1 }).cursor).toBe(2);
    expect(moveRight({ value: "ab", cursor: 2 }).cursor).toBe(2);
  });

  it("splitAtCursor splits around the caret so the cursor can move mid-line", () => {
    expect(splitAtCursor({ value: "abc", cursor: 2 })).toEqual({
      before: "ab",
      after: "c",
      cursor: 2,
    });
    expect(splitAtCursor({ value: "abc", cursor: 0 })).toEqual({
      before: "",
      after: "abc",
      cursor: 0,
    });
    expect(splitAtCursor({ value: "abc", cursor: 3 })).toEqual({
      before: "abc",
      after: "",
      cursor: 3,
    });
  });

  it("clampCursor keeps the caret within [0, value.length]", () => {
    expect(clampCursor("abc", -5)).toBe(0);
    expect(clampCursor("abc", 99)).toBe(3);
    expect(clampCursor("abc", Number.NaN)).toBe(3);
  });
});

describe("editReducer (Task #4103)", () => {
  it("applies several inserts against the latest state (no stale-closure loss)", () => {
    // "abc" delivered in a single tick must all survive. With independent
    // useState setters reading the render-time value, only "c" would remain.
    let state: TextEdit = { value: "", cursor: 0 };
    for (const ch of "abc") state = editReducer(state, { type: "insert", text: ch });
    expect(state).toEqual({ value: "abc", cursor: 3 });
  });

  it("interleaves caret moves and edits atomically", () => {
    let state: TextEdit = { value: "", cursor: 0 };
    state = editReducer(state, { type: "insert", text: "ac" });
    state = editReducer(state, { type: "left" });
    state = editReducer(state, { type: "insert", text: "b" });
    expect(state).toEqual({ value: "abc", cursor: 2 });
    state = editReducer(state, { type: "backspace" });
    expect(state).toEqual({ value: "ac", cursor: 1 });
  });

  it("set moves the caret to the end of the new value; clear resets both", () => {
    expect(
      editReducer({ value: "", cursor: 0 }, { type: "set", value: "hist" }),
    ).toEqual({ value: "hist", cursor: 4 });
    expect(
      editReducer({ value: "abc", cursor: 2 }, { type: "clear" }),
    ).toEqual({ value: "", cursor: 0 });
  });

  // 片3 (Task #4297): Home / End caret jump. opentui's KeyEvent exposes real
  // `home` / `end` names (bun/Ink's useInput had no equivalent).
  it("moveHome / moveEnd jump the caret to the ends", () => {
    expect(moveHome({ value: "abc", cursor: 2 })).toEqual({ value: "abc", cursor: 0 });
    expect(moveEnd({ value: "abc", cursor: 1 })).toEqual({ value: "abc", cursor: 3 });
    expect(moveHome({ value: "abc", cursor: 0 }).cursor).toBe(0);
    expect(moveEnd({ value: "abc", cursor: 3 }).cursor).toBe(3);
  });

  it("editReducer supports home / end actions", () => {
    expect(editReducer({ value: "hello", cursor: 3 }, { type: "home" })).toEqual({
      value: "hello",
      cursor: 0,
    });
    expect(editReducer({ value: "hello", cursor: 3 }, { type: "end" })).toEqual({
      value: "hello",
      cursor: 5,
    });
  });

  it("delegates left/right/backspace/delete to the caret helpers", () => {
    expect(editReducer({ value: "abc", cursor: 2 }, { type: "left" })).toEqual({
      value: "abc",
      cursor: 1,
    });
    expect(editReducer({ value: "abc", cursor: 1 }, { type: "right" })).toEqual({
      value: "abc",
      cursor: 2,
    });
    expect(
      editReducer({ value: "abc", cursor: 2 }, { type: "backspace" }),
    ).toEqual({ value: "ac", cursor: 1 });
    expect(editReducer({ value: "abc", cursor: 2 }, { type: "delete" })).toEqual(
      { value: "ab", cursor: 2 },
    );
  });
});
