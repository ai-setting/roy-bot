/**
 * @fileoverview Task #5086 P5 — ansiToRuns 的 SGR 基线回落语义（DS r3/r4）。
 *
 * 背景：Markdown.tsx 把 `fg: theme.text` 作为 baseStyle 传进 ansiToRuns。
 * SGR 0（reset）/ 39（default fg）/ 49（default bg）必须回落到这个
 * **基线色**，而不是「当前色」或「终端默认色」——
 * 否则 light 主题下正文会退回近白（白底白字，不可读）。
 */

import { describe, expect, it } from "bun:test";
import { ansiToRuns } from "./style.js";

const BASE = { fg: "#1a1a1a" };

describe("P5 ansiToRuns — SGR 基线回落（style.ts）", () => {
  it("SGR 0 (reset) 回落到 base fg（清属性不清基线色）", () => {
    const runs = ansiToRuns("\u001b[36m\u001b[1mH\u001b[22m\u001b[0mbody", BASE);
    expect(runs.length).toBe(2);
    expect(runs[0]!.style.fg).toBe("#00cdcd"); // cyan 保留
    expect(runs[0]!.style.bold).toBe(true);
    expect(runs[1]!.style.fg).toBe("#1a1a1a"); // ← 回落基线
  });

  it("SGR 39 (default fg) 回落到 base fg", () => {
    const runs = ansiToRuns("\u001b[36mcyan\u001b[39mafter", BASE);
    expect(runs.length).toBe(2);
    expect(runs[0]!.style.fg).toBe("#00cdcd");
    expect(runs[1]!.style.fg).toBe("#1a1a1a");
  });

  it("SGR 49 (default bg) 回落到 base bg", () => {
    const runs = ansiToRuns("\u001b[44mcolored-bg\u001b[49mafter", { ...BASE, bg: "#fafafa" });
    expect(runs.length).toBe(2);
    expect(runs[0]!.style.bg).toBe("#0000ee");
    expect(runs[1]!.style.bg).toBe("#fafafa");
  });

  it("无 baseStyle 时 reset 后 fg 为 undefined（终端默认，不报错）", () => {
    const runs = ansiToRuns("\u001b[36mcyan\u001b[0mafter");
    expect(runs.length).toBe(2);
    expect(runs[1]!.style.fg).toBeUndefined();
  });

  it("SGR 22 (bold off) 不影响 fg", () => {
    const runs = ansiToRuns("\u001b[36m\u001b[1mH\u001b[22mtext", BASE);
    expect(runs[0]!.style.fg).toBe("#00cdcd");
    expect(runs[0]!.style.bold).toBe(true);
  });
});
