/**
 * @fileoverview Task #5116 P7.1 —— dialog-state 测试（纯函数穷举）。
 */

import { describe, expect, it } from "bun:test";
import {
  dialogReducer,
  initialDialogState,
  type DialogListItem,
} from "./dialog-state.js";

const ITEMS: DialogListItem[] = [
  { id: "a", label: "alpha" },
  { id: "b", label: "beta" },
  { id: "c", label: "gamma" },
];

describe("dialog-state — list mode", () => {
  it("starts in list mode with selectedIndex 0", () => {
    const s = initialDialogState("connect");
    expect(s.mode).toBe("list");
    expect(s.selectedIndex).toBe(0);
  });

  it("moves down and up with clamping", () => {
    const s0 = initialDialogState("model");
    const s1 = dialogReducer(s0, { type: "down" }, ITEMS.length).state;
    expect(s1.selectedIndex).toBe(1);
    const s2 = dialogReducer(s1, { type: "down" }, ITEMS.length).state;
    const s3 = dialogReducer(s2, { type: "down" }, ITEMS.length).state;
    const s4 = dialogReducer(s3, { type: "down" }, ITEMS.length).state; // clamp
    expect(s4.selectedIndex).toBe(2);
    const s5 = dialogReducer(s4, { type: "up" }, ITEMS.length).state;
    expect(s5.selectedIndex).toBe(1);
    const s6 = dialogReducer(s0, { type: "up" }, ITEMS.length).state; // clamp at 0
    expect(s6.selectedIndex).toBe(0);
  });

  it("no-ops movement on an empty list", () => {
    const s = dialogReducer(initialDialogState("model"), { type: "down" }, 0).state;
    expect(s.selectedIndex).toBe(0);
  });

  it("select returns item-selected and keeps state", () => {
    const s = { ...initialDialogState("model"), selectedIndex: 1 };
    const r = dialogReducer(s, { type: "select" }, ITEMS.length);
    expect(r.outcome.kind).toBe("item-selected");
    expect(r.state.mode).toBe("list");
  });

  it("cancel closes the dialog and reports cancelled", () => {
    const r = dialogReducer(initialDialogState("connect"), { type: "cancel" }, ITEMS.length);
    expect(r.outcome.kind).toBe("cancelled");
    expect(r.state.mode).toBe("closed");
  });

  it("form actions are no-ops in list mode", () => {
    const r = dialogReducer(initialDialogState("connect"), { type: "field-input", text: "x" }, ITEMS.length);
    expect(r.outcome.kind).toBe("none");
    expect(r.state.fields.name).toBe("");
  });
});

describe("dialog-state — form mode (add provider)", () => {
  const form = () => ({ ...initialDialogState("connect"), mode: "form" as const });

  it("field-input appends to the current field only", () => {
    const s0 = form();
    const s1 = dialogReducer(s0, { type: "field-input", text: "openai" }, 0).state;
    expect(s1.fields.name).toBe("openai");
    expect(s1.fields.apiKey).toBe("");
    // 切字段
    const s2 = dialogReducer(s1, { type: "next-field" }, 0).state;
    expect(s2.fieldIndex).toBe(1);
    const s3 = dialogReducer(s2, { type: "field-input", text: "sk-key" }, 0).state;
    expect(s3.fields.apiKey).toBe("sk-key");
    expect(s3.fields.name).toBe("openai");
  });

  it("filters control characters (no newlines in single-line fields)", () => {
    const s0 = form();
    const s1 = dialogReducer(s0, { type: "field-input", text: "ab\ncd" }, 0).state;
    expect(s1.fields.name).toBe("abcd");
  });

  it("field-backspace removes the last char", () => {
    let s = form();
    s = dialogReducer(s, { type: "field-input", text: "abc" }, 0).state;
    s = dialogReducer(s, { type: "field-backspace" }, 0).state;
    expect(s.fields.name).toBe("ab");
    // 空字段 backspace 无副作用
    s = dialogReducer(s, { type: "field-backspace" }, 0).state;
    s = dialogReducer(s, { type: "field-backspace" }, 0).state;
    s = dialogReducer(s, { type: "field-backspace" }, 0).state;
    expect(s.fields.name).toBe("");
  });

  it("next-field walks name → apiKey → baseURL → submit", () => {
    let s = form();
    s = dialogReducer(s, { type: "field-input", text: "prov" }, 0).state;
    s = dialogReducer(s, { type: "next-field" }, 0).state; // → apiKey
    s = dialogReducer(s, { type: "field-input", text: "sk-x" }, 0).state;
    s = dialogReducer(s, { type: "next-field" }, 0).state; // → baseURL
    s = dialogReducer(s, { type: "field-input", text: "https://api.x" }, 0).state;
    expect(s.fieldIndex).toBe(2);
    const r = dialogReducer(s, { type: "submit" }, 0);
    expect(r.outcome.kind).toBe("form-submitted");
    if (r.outcome.kind === "form-submitted") {
      expect(r.outcome.name).toBe("prov");
      expect(r.outcome.apiKey).toBe("sk-x");
      expect(r.outcome.baseURL).toBe("https://api.x");
    }
  });

  it("submit on the last field happens naturally (Enter on baseURL submits)", () => {
    let s = form();
    s = dialogReducer(s, { type: "next-field" }, 0).state; // apiKey
    s = dialogReducer(s, { type: "next-field" }, 0).state; // baseURL
    const r = dialogReducer(s, { type: "next-field" }, 0); // Enter on last = submit
    expect(r.outcome.kind).toBe("form-submitted");
  });

  it("cancel closes from the form and reports cancelled", () => {
    const r = dialogReducer(form(), { type: "cancel" }, 0);
    expect(r.outcome.kind).toBe("cancelled");
    expect(r.state.mode).toBe("closed");
  });

  it("back-to-list resets the form", () => {
    let s = form();
    s = dialogReducer(s, { type: "field-input", text: "junk" }, 0).state;
    s = dialogReducer(s, { type: "next-field" }, 0).state;
    const r = dialogReducer(s, { type: "back-to-list" }, 3);
    expect(r.state.mode).toBe("list");
    expect(r.state.fieldIndex).toBe(0);
    expect(r.state.fields.name).toBe("");
    expect(r.state.selectedIndex).toBe(0);
  });
});
