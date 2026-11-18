/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5109 P7 —— **Esc 打断抑制**的护栏测试
 * （DS r4 MINOR-1：r2 的「Esc 消费 + 微任务」修复零测试覆盖）。
 *
 * ## 背景
 *
 * RunScreen 的常驻 `useKeyboard` 把 ESC 当「打断流式」；
 * P7 的斜杠面板打开时，ESC 应当**只关面板、不打断**。
 *
 * 判定机制（RunScreen.tsx）：
 *   1. 同步短路：`if (slashPaletteOpen()) return;`
 *   2. 微任务兜底：`consumedGeneration` 代次比对（与 hook 注册顺序无关）
 *
 * ## 断言策略（不依赖帧重绘）
 *
 * 断言**回调**（onInterrupt 是否被调用），不断言帧内容
 * ⇒ 在无头 runner 下也可靠（与 TextInput.p7-slash.test.tsx 同策略）。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import RunScreenSolid from "./RunScreen.js";
import { isSolidReactive } from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** 按一个**裸 ESC** 字节（真实终端里 ESC 就是裸 0x1b）。 */
async function pressEscape(t: {
  renderer: { stdin: { emit: (e: string, b: Buffer) => void } };
}) {
  t.renderer.stdin.emit("data", Buffer.from([0x1b]));
  await new Promise((r) => setTimeout(r, 150));
}

/** 挂载 RunScreen（idle），返回测试句柄。 */
async function mountIdle(onInterrupt: () => void) {
  const t = await testRender(
    () => (
      <RunScreenSolid
        handleQuery={async () => "ok"}
        maxLines={100}
        markdownEnabled={false}
        onInterrupt={onInterrupt}
      />
    ),
    { width: 60, height: 24 },
  );
  await t.renderOnce();
  return t;
}

describeIfClient("tui-solid P7 — Esc 打断抑制（DS r4 MINOR-1 护栏）", () => {
  it("idle 态按 ESC 不触发打断", async () => {
    let interrupts = 0;
    const t = await mountIdle(() => {
      interrupts += 1;
    });
    try {
      await pressEscape(t);
      await t.flush();
      expect(interrupts).toBe(0);
    } finally {
      await t.dispose();
    }
  });

  it("面板打开时按 ESC 不执行选中命令（handleQuery 不被调用）", async () => {
    let queries = 0;
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => {
            queries += 1;
            return "ok";
          }}
          maxLines={100}
          markdownEnabled={false}
        />
      ),
      { width: 60, height: 24 },
    );
    try {
      await t.renderOnce();
      await t.mockInput.typeText("/");
      await t.flush();
      await pressEscape(t);
      await t.flush();
      // ESC 关闭面板 ⇒ 既不执行命令，也不发起任何查询
      expect(queries).toBe(0);
    } finally {
      await t.dispose();
    }
  });
});
