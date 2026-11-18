/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5109 P7 —— `SlashPalette` 补全面板 UI（TDD RED 先行）。
 *
 * ## 被测对象
 *
 * 面板**渲染**：给定一组命令 + 状态（query/selectedIndex），把
 * 每行 `/name —— description` 画出来，高亮行带反色/边框。
 *
 * ## 为什么测渲染而不是按键
 *
 * 按键语义已在 `slash-palette-state.test.ts` 穷举（纯函数，确定性）。
 * 这里只需证明：**面板能把注册表内容渲染出来**，且**选中行**有视觉区分。
 *
 * opentui `testRender` 在 `bun test` 下首帧可断言（不依赖重绘），
 * 所以本文件直接走 `testRender` + `captureCharFrame()`。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { SlashPalette } from "./SlashPalette.js";
import type { SlashCommandSpec } from "./slash-registry.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

const SPECS: SlashCommandSpec[] = [
  {
    name: "help",
    description: "List commands",
    group: "System",
    run: () => ({ kind: "handled", message: "help" }),
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Exit the app",
    group: "System",
    run: () => ({ kind: "exit" }),
  },
  {
    name: "clear",
    description: "Clear history",
    group: "Session",
    run: () => ({ kind: "handled", message: "clear" }),
  },
];

async function frameOf(props: {
  specs: SlashCommandSpec[];
  query?: string;
  selectedIndex?: number;
  visible?: boolean;
}): Promise<string> {
  const t = await testRender(
    () => (
      <SlashPalette
        specs={props.specs}
        query={props.query ?? ""}
        selectedIndex={props.selectedIndex ?? 0}
        visible={props.visible ?? true}
      />
    ),
    { width: 50, height: 12 },
  );
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

describeIfClient("tui-solid P7 SlashPalette — 面板渲染", () => {
  it("renders command names with a leading slash", async () => {
    const f = await frameOf({ specs: SPECS });
    expect(f).toContain("/help");
    expect(f).toContain("/exit");
    expect(f).toContain("/clear");
  });

  it("renders descriptions next to the names", async () => {
    const f = await frameOf({ specs: SPECS });
    expect(f).toContain("List commands");
    expect(f).toContain("Exit the app");
  });

  it("renders aliases in the row", async () => {
    const f = await frameOf({ specs: SPECS });
    expect(f).toContain("quit");
    expect(f).toContain("q");
  });

  it("marks the selected row with a highlight indicator", async () => {
    const f = await frameOf({ specs: SPECS, selectedIndex: 0 });
    // 高亮行的标记符（opencode 用背景色；本仓用 "▶" 前缀）。
    expect(f).toContain("▶");
  });

  it("marks a different selected row when the index moves", async () => {
    const f = await frameOf({ specs: SPECS, selectedIndex: 1 });
    // 高亮前缀应在 /exit 那一行。
    const lines = f.split("\n");
    const exitLine = lines.find((l) => l.includes("/exit"));
    expect(exitLine).toBeDefined();
    expect(exitLine).toContain("▶");
  });

  it("shows an empty-state message when nothing matches", async () => {
    const f = await frameOf({ specs: [], query: "zzz" });
    expect(f).toContain("No matching commands");
  });

  it("renders nothing when not visible", async () => {
    const f = await frameOf({ specs: SPECS, visible: false });
    expect(f).not.toContain("/help");
  });
});

describe("tui-solid P7 SlashPalette — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[P7] solid-reactive=${SOLID_REACTIVE} ` +
        `=> SlashPalette suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
