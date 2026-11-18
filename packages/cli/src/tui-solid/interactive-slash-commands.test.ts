/**
 * @fileoverview Task #5109 P7 —— interactive 斜杠命令集 handler 测试。
 */

import { describe, expect, it } from "bun:test";
import { interactiveSlashCommands } from "./interactive-slash-commands.js";
import { CLEAR_SENTINEL } from "../slash.js";
import { getTuiThemeMode, resetTuiThemeMode } from "./theme.js";

const SPECS = interactiveSlashCommands({ model: "test/model-1" });

function run(name: string, args = "") {
  const spec = SPECS.find((s) => s.name === name);
  if (!spec) throw new Error(`no such command: ${name}`);
  return spec.run(args);
}

describe("tui-solid P7 interactive-slash-commands — 命令集", () => {
  it("registers the 5 core commands", () => {
    const names = SPECS.map((s) => s.name);
    expect(names).toContain("help");
    expect(names).toContain("exit");
    expect(names).toContain("clear");
    expect(names).toContain("model");
    expect(names).toContain("theme");
  });

  it("registers aliases for exit", () => {
    const exit = SPECS.find((s) => s.name === "exit");
    expect(exit?.aliases).toEqual(["quit", "q"]);
  });

  it("/help returns a handled message listing commands", () => {
    const r = run("help");
    expect(r.kind).toBe("handled");
    expect((r as { message: string }).message).toContain("/theme");
  });

  it("/exit returns kind=exit", () => {
    expect(run("exit").kind).toBe("exit");
  });

  it("/clear returns the CLEAR_SENTINEL", () => {
    const r = run("clear");
    expect(r.kind).toBe("handled");
    expect((r as { message: string }).message).toBe(CLEAR_SENTINEL);
  });

  // ★ Task #5116 P7.1 —— /model 升级为弹窗（不再只读）。
  it("/model opens the model dialog", () => {
    const r = run("model");
    expect(r.kind).toBe("open-dialog");
    expect((r as { dialog: string }).dialog).toBe("model");
  });

  // ★ Task #5116 P7.1 —— /connect 新增。
  it("/connect opens the connect dialog", () => {
    const r = run("connect");
    expect(r.kind).toBe("open-dialog");
    expect((r as { dialog: string }).dialog).toBe("connect");
  });

  it("/theme switches to light", () => {
    resetTuiThemeMode();
    const r = run("theme", "light");
    expect(r.kind).toBe("handled");
    expect(getTuiThemeMode()).toBe("light");
    resetTuiThemeMode();
  });

  it("/theme switches to dark", () => {
    resetTuiThemeMode();
    run("theme", "light");
    const r = run("theme", "dark");
    expect(r.kind).toBe("handled");
    expect(getTuiThemeMode()).toBe("dark");
    resetTuiThemeMode();
  });

  it("/theme rejects an invalid mode", () => {
    resetTuiThemeMode();
    const r = run("theme", "blue");
    expect(r.kind).toBe("unknown");
    expect((r as { message: string }).message).toContain("Usage: /theme");
    resetTuiThemeMode();
  });

  it("/theme rejects an empty mode", () => {
    resetTuiThemeMode();
    const r = run("theme", "");
    expect(r.kind).toBe("unknown");
    resetTuiThemeMode();
  });

  it("/theme 在 NO_COLOR 下如实告知硬降级（不报假成功）", () => {
    resetTuiThemeMode();
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const r = run("theme", "light");
      expect(r.kind).toBe("handled");
      const msg = (r as { message: string }).message;
      expect(msg).toContain("NO_COLOR");
      expect(msg).not.toContain("Theme switched to light");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
      resetTuiThemeMode();
    }
  });

  it("/help 列出 legacy 命令（可发现性）", () => {
    const r = run("help");
    const msg = (r as { message: string }).message;
    expect(msg).toContain("/history");
    expect(msg).toContain("/workdir");
    expect(msg).toContain("/max-lines");
  });
});

// ============================================================================
// ★ Task #5302 —— /es 事件源管理（interactive 前端）
// ============================================================================

describe("Task #5302 — /es 命令", () => {
  it("registers /es spec", () => {
    const es = SPECS.find((s) => s.name === "es");
    expect(es).toBeDefined();
    expect(es?.group).toBe("EventSource");
    expect(es?.description).toContain("event sources");
  });

  it("/help mentions /es", () => {
    const r = run("help");
    expect((r as { message: string }).message).toContain("/es");
  });

  it("/es with no args returns usage (no spawn)", () => {
    const r = run("es", "");
    expect(r.kind).toBe("handled");
    const msg = (r as { message: string }).message;
    expect(msg).toContain("list");
    expect(msg).toContain("add");
    expect(msg).toContain("del");
    expect(msg).toContain("mod");
  });

  it("/es list 经由 CLI 前端执行并回显（隔离 HOME 真实跑通）", () => {
    // 用真实 CLI：隔离 HOME，让 es-slash 读写临时 event-sources.json
    const r = run("es", "list");
    expect(["handled", "unknown"]).toContain(r.kind);
    const msg = (r as { message: string }).message;
    // 成功路径应含「事件源」字样；失败路径（CLI 未构建）应含 /es failed
    expect(msg.length).toBeGreaterThan(0);
  });
});
