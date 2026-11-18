/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5109 P7 —— 斜杠面板**键路径**集成测试
 * （DS r2 MINOR-1 补强：截图是受控组件隔离，本文件证明真实键路径接线）。
 *
 * ## 测什么
 *
 * **不依赖帧重绘**，只断言**行为**（回调/状态）：
 *   1. 敲 `/` ⇒ 面板打开（onSlashPaletteChange(true)）；
 *   2. 再敲 `he` ⇒ 过滤词更新；
 *   3. Enter ⇒ 执行选中命令（onSlashCommand 收到 `/help`）；
 *   4. Tab ⇒ 补全（输入框值变成 `/help `，不执行）；
 *   5. Esc ⇒ 关面板（onSlashPaletteChange(false)），不提交；
 *   6. ↑↓ ⇒ 高亮移动（用 Enter 选中的命令变化来观察）。
 *
 * ## 为什么不需要重绘
 *
 * opentui 的 `useKeyboard` 回调**一定会**跑（键能送达），
 * 只是**帧不重绘** ⇒ 断言「回调收到什么」比断言「帧里有什么」可靠。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { TextInput } from "./TextInput.js";
import { interactiveSlashCommands } from "./interactive-slash-commands.js";
import { isSolidReactive } from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

const SPECS = interactiveSlashCommands({ model: "fake/p7" });

interface Harness {
  submitted: string[];
  executed: string[];
  paletteOpen: boolean[];
  value: string;
}

async function mount(): Promise<{ t: any; h: Harness }> {
  const h: Harness = { submitted: [], executed: [], paletteOpen: [], value: "" };
  const t = await testRender(
    () => (
      <TextInput
        label="You"
        prefix="👤"
        placeholder="Type a message…"
        slashCommands={SPECS}
        onSubmit={(v) => {
          h.submitted.push(v);
          h.value = v;
        }}
        onSlashCommand={(c) => {
          h.executed.push(c);
        }}
        onSlashPaletteChange={(open) => {
          h.paletteOpen.push(open);
        }}
      />
    ),
    { width: 60, height: 12 },
  );
  await t.renderOnce();
  return { t, h };
}

describeIfClient("tui-solid P7 — 斜杠面板键路径（不依赖重绘）", () => {
  it("敲 / 打开面板", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/");
      await t.flush();
      expect(h.paletteOpen).toContain(true);
    } finally {
      await t.dispose();
    }
  });

  it("继续输入不关闭面板（过滤）", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/");
      await t.flush();
      const openedCount = h.paletteOpen.filter(Boolean).length;
      await t.mockInput.typeText("he");
      await t.flush();
      // 面板仍是打开状态（没有被关掉）
      expect(h.paletteOpen.filter(Boolean).length).toBeGreaterThanOrEqual(openedCount);
      expect(h.paletteOpen[h.paletteOpen.length - 1]).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it("Enter 执行选中命令（/he ⇒ /help）", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/he");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      expect(h.executed).toContain("/help");
    } finally {
      await t.dispose();
    }
  });

  it("Enter 执行的是过滤后的第一条（/he ⇒ /help 而非 /exit）", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/he");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      expect(h.executed.length).toBe(1);
      expect(h.executed[0]).toBe("/help");
    } finally {
      await t.dispose();
    }
  });

  it("Esc 关闭面板且不提交内容", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/");
      await t.flush();
      t.renderer.stdin.emit("data", Buffer.from([0x1b]));
      await new Promise((r) => setTimeout(r, 150));
      await t.flush();
      expect(h.paletteOpen[h.paletteOpen.length - 1]).toBe(false);
      expect(h.submitted.length).toBe(0);
    } finally {
      await t.dispose();
    }
  });

  it("↓ 移动高亮后 Enter 选中第二条", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/");
      await t.flush();
      t.mockInput.pressArrow("down");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      // 第二条 = /exit（注册表顺序：help, exit, clear, model, theme）
      expect(h.executed[0]).toBe("/exit");
    } finally {
      await t.dispose();
    }
  });

  it("↑ 从第二项回到第一项", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/");
      await t.flush();
      t.mockInput.pressArrow("down");
      await t.flush();
      t.mockInput.pressArrow("up");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      expect(h.executed[0]).toBe("/help");
    } finally {
      await t.dispose();
    }
  });

  it("Tab 补全（不执行）", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/he");
      await t.flush();
      t.mockInput.pressTab();
      await t.flush();
      // Tab 不执行命令
      expect(h.executed.length).toBe(0);
      // Tab 后面板关闭
      expect(h.paletteOpen[h.paletteOpen.length - 1]).toBe(false);
    } finally {
      await t.dispose();
    }
  });

  it("没有注册表时不打开面板", async () => {
    const h: Harness = { submitted: [], executed: [], paletteOpen: [], value: "" };
    const t = await testRender(
      () => (
        <TextInput
          label="You"
          onSubmit={(v) => {
            h.submitted.push(v);
          }}
          onSlashPaletteChange={(open) => {
            h.paletteOpen.push(open);
          }}
        />
      ),
      { width: 60, height: 12 },
    );
    try {
      await t.renderOnce();
      await t.mockInput.typeText("/");
      await t.flush();
      expect(h.paletteOpen.filter(Boolean).length).toBe(0);
    } finally {
      await t.dispose();
    }
  });
});

/**
 * ★ DS r3 MAJOR-1 回归护栏。
 *
 * 面板按**描述子串**过滤 ⇒ `/history` 会命中 `/clear` 的描述
 * "Clear conversation history" ⇒ 若 Enter 按「面板高亮项」执行，
 * 就会**静默清空会话历史**（语义完全相反），且 `slash.ts` 的既有
 * `/history` / `/workdir` 命令被吞掉。
 *
 * ⇒ Enter 必须**精确名字优先**，未命中精确名时才用高亮项，
 * 都未命中则**回退提交原文**。
 */
describeIfClient("tui-solid P7 — Enter 精确匹配优先（DS r3 MAJOR-1 回归护栏）", () => {
  it("/history 不会被 /clear 的描述劫持（不进 executed）", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/history");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      // 关键：绝不能执行 /clear
      expect(h.executed).not.toContain("/clear");
      expect(h.executed).not.toContain("/history");
      // 回退提交原文 ⇒ 交给 legacy 分发器
      expect(h.submitted).toContain("/history");
    } finally {
      await t.dispose();
    }
  });

  it("/workdir 不被吞掉（回退提交）", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/workdir");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      expect(h.submitted).toContain("/workdir");
      expect(h.executed.length).toBe(0);
    } finally {
      await t.dispose();
    }
  });

  it("/zzz 完全不匹配时回退提交原文", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/zzz");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      expect(h.submitted).toContain("/zzz");
      expect(h.executed.length).toBe(0);
    } finally {
      await t.dispose();
    }
  });

  it("精确匹配存在时优先执行它（/help 不被描述匹配抢走）", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/help");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      expect(h.executed).toContain("/help");
      expect(h.submitted.length).toBe(0);
    } finally {
      await t.dispose();
    }
  });

  it("别名精确匹配也优先（/q ⇒ /exit）", async () => {
    const { t, h } = await mount();
    try {
      await t.mockInput.typeText("/q");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      expect(h.executed).toContain("/exit");
    } finally {
      await t.dispose();
    }
  });
});
