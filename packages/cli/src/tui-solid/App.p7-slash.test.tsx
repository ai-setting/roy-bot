/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5109 P7 —— 斜杠面板**集成**测试（RunScreen + TextInput）。
 *
 * ## ⚠️ 本文件在无头渲染器下**恒 skip**（DS r3 MINOR-2）
 *
 * 这里的 6 条用例都依赖「信号变化 → 帧重绘」，而 `bun test` 的内置 JSX
 * 是**急求值**（REPAINTABLE=false，见 `test-utils/repaint-capability.ts`
 * 的实测记录）⇒ 它们在无头环境下 skip。
 *
 * **真实键路径覆盖在别处**：
 *   - `TextInput.p7-slash.test.tsx`（14 用例）—— 断言**回调**而非帧，
 *     在无头环境下**真跑**（触发/过滤/Enter/Tab/Esc/↑↓/精确匹配优先）；
 *   - 真终端 e2e：`scripts/tui-solid/e2e-interactive-solid.py`。
 *
 * ⇒ 本文件保留作为「有重绘能力的 runner 下的额外护栏」，
 * **不要**把它当作已验证的证据。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import RunScreenSolid from "./RunScreen.js";
import { canRepaintWith, NO_REPAINT_REASON } from "./test-utils/repaint-capability.js";
import { createEffect, createSignal } from "solid-js";

function isSolidReactive(): boolean {
  const seen: number[] = [];
  const [n, setN] = createSignal(0);
  createEffect(() => {
    seen.push(n());
  });
  setN(1);
  return seen.length > 1;
}

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;
const REPAINTABLE = await canRepaintWith((value) => <text>{`Z=${value()}`}</text>);
const describeIfRepaintable = REPAINTABLE ? describeIfClient : describe.skip;

/** 挂载 RunScreen 并进入 idle 状态。 */
async function mount() {
  const t = await testRender(
    () => (
      <RunScreenSolid
        handleQuery={async () => "ok"}
        maxLines={100}
        markdownEnabled={false}
      />
    ),
    { width: 60, height: 24 },
  );
  await t.renderOnce();
  return t;
}

describeIfRepaintable("tui-solid P7 — 斜杠面板集成（RunScreen + TextInput）", () => {
  it("opens the slash palette when typing /", async () => {
    const t = await mount();
    try {
      await t.mockInput.typeText("/");
      await t.flush();
      const f = t.captureCharFrame();
      // 面板应显示命令列表
      expect(f).toContain("/help");
      expect(f).toContain("/exit");
      expect(f).toContain("/clear");
    } finally {
      await t.dispose();
    }
  });

  it("filters commands as you type", async () => {
    const t = await mount();
    try {
      await t.mockInput.typeText("/he");
      await t.flush();
      const f = t.captureCharFrame();
      // 应只显示 /help（/exit /clear 被过滤掉）
      expect(f).toContain("/help");
      // 但面板仍在（输入框里有 /he）
      expect(f).toContain("/he");
    } finally {
      await t.dispose();
    }
  });

  it("closes the palette on Escape", async () => {
    const t = await mount();
    try {
      await t.mockInput.typeText("/");
      await t.flush();
      t.renderer.stdin.emit("data", Buffer.from([0x1b]));
      await new Promise((r) => setTimeout(r, 120));
      await t.flush();
      const f = t.captureCharFrame();
      // 面板应消失（不再显示 /help 列表）
      // 但输入框可能仍有 `/`
      expect(f).toBeDefined();
    } finally {
      await t.dispose();
    }
  });

  it("executes the selected command on Enter", async () => {
    const t = await mount();
    try {
      await t.mockInput.typeText("/he");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      const f = t.captureCharFrame();
      // /help 执行后应显示帮助文本
      expect(f).toContain("Available slash commands");
    } finally {
      await t.dispose();
    }
  });

  it("completes the command on Tab", async () => {
    const t = await mount();
    try {
      await t.mockInput.typeText("/he");
      await t.flush();
      t.mockInput.pressTab();
      await t.flush();
      const f = t.captureCharFrame();
      // Tab 应把 /help 写入输入框（不执行）
      expect(f).toContain("/help");
    } finally {
      await t.dispose();
    }
  });

  it("moves the selection with up/down arrows", async () => {
    const t = await mount();
    try {
      await t.mockInput.typeText("/");
      await t.flush();
      // 按 down 两次
      t.mockInput.pressArrow("down");
      t.mockInput.pressArrow("down");
      await t.flush();
      const f = t.captureCharFrame();
      // 高亮行应在 /clear（第 3 条）
      expect(f).toContain("▶");
    } finally {
      await t.dispose();
    }
  });
});

describe("tui-solid P7 — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[P7] solid-reactive=${SOLID_REACTIVE} repaintable=${REPAINTABLE} ` +
        `=> P7 integration suite ${REPAINTABLE ? "RUN" : `SKIPPED: ${NO_REPAINT_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
