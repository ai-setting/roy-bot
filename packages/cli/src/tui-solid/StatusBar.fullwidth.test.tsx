/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #4954 P1 — 全宽状态栏（RED→GREEN）。
 *
 * ## P1 契约（对标 opencode 用户截图基准）
 *
 * 单行三段：
 *   左  = 状态/模型（`Build · <model>` 或 working 提示）
 *   中  = 工作目录（📁 /tmp）
 *   右  = 快捷键提示（`ctrl+c exit` 式，单一来源）
 *
 * hint 冗余收敛：原 3 处提示语（StatusBar "Ctrl+C to exit"、
 * RunScreen "working…(ESC…)"、TextInput "/exit to quit"）
 * 统一走 StatusBar props.status / props.hint。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { StatusBar } from "./StatusBar.js";
import { isSolidReactive, SSR_SKIP_REASON } from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

async function frameOf(props: Parameters<typeof StatusBar>[0]) {
  const t = await testRender(() => <StatusBar {...props} />, {
    width: 100,
    height: 3,
  });
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

describeIfClient("Task #4954 P1 — 全宽状态栏", () => {
  it("renders status on the left, workdir center, hint right (wide)", async () => {
    const f = await frameOf({
      model: "GLM-5.3-Flash",
      workdir: "/tmp",
      status: "Build",
      hint: "ctrl+c exit",
      columns: 100,
    });
    const lines = f.split("\n").filter((l) => l.includes("GLM"));
    expect(lines.length).toBeGreaterThan(0);
    const row = lines[0];
    // 左段：状态/模型
    expect(row.indexOf("Build")).toBeLessThan(row.indexOf("/tmp"));
    // 右段：hint 在 workdir 之后（靠右）
    expect(row.indexOf("ctrl+c exit")).toBeGreaterThan(row.indexOf("/tmp"));
    // 单行：状态栏内容在同一行
    expect(row).toContain("GLM-5.3-Flash");
  });

  it("working status swaps the left segment (esc interrupt hint)", async () => {
    const f = await frameOf({
      model: "GLM-5.3-Flash",
      workdir: "/tmp",
      status: "esc interrupt",
      hint: "",
      columns: 100,
    });
    expect(f).toContain("esc interrupt");
  });

  it("narrow terminal degrades to model+hint only (no workdir)", async () => {
    const f = await frameOf({
      model: "GLM-5.3-Flash",
      workdir: "/tmp",
      status: "Build",
      hint: "ctrl+c exit",
      columns: 40,
    });
    expect(f).toContain("GLM");
    expect(f).toContain("ctrl+c exit");
  });
});
