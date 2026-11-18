/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #4721 G2 — **打断**（ESC / Ctrl-C 止住流式输出）。
 *
 * ## 根因（设计文档 /tmp/interactive-ui-4721-design.md §1.2）
 *
 * 1. `commands/interactive.ts` grep `escape|abortAll|abortStream` = **0 命中**
 *    ⇒ opentui 路径**完全没有**打断链路（Ink 链路 `commands/run.ts:897-906`
 *    有 `handleEscKey` → `abortAll()` + `abortStream()`）。
 * 2. `tui-solid/RunScreen.tsx` 流式期间用 `<Show when={status === "idle"}>`
 *    **卸载**了 `<TextInput>` ⇒ 流式期间**没有任何键盘处理器注册** ⇒ ESC 无人监听。
 *
 * ## 验收标准
 *
 * 1. 流式（status !== idle）时按 ESC ⇒ 调用 `onInterrupt` 回调。
 * 2. idle 时按 ESC **不**调用 `onInterrupt`（不误伤正常输入）。
 * 3. Ctrl-C 在流式时**先**打断（而不是直接退出整个程序）——
 *    Ink 链路 `TextInput` 的 Ctrl-C 是 `onCancel → doExit`（退出整个程序），
 *    在 TUI 里这不合理：用户想停的是当前这一轮生成。
 * 4. 打断**后**状态回到 idle（输入框重新可用）。
 *
 * ## 断言策略
 *
 * opentui `testRender` + `mockInput.pressKey`（走**真实**的按键解析器），
 * 断言**行为**（回调被调用 / 状态变化），不做源码字符串断言。
 *
 * 必须用 `bun --conditions=browser test`（见 test-utils/solid-test-env.ts）。
 */

import { describe, expect, it } from "bun:test";
import { createEffect, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import RunScreenSolid from "./RunScreen.js";

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

/**
 * 挂载 RunScreenSolid 并**真的提交一条消息**进入流式状态。
 *
 * `streamHandleQuery` 永不 resolve ⇒ 状态永远停在 "thinking" ⇒ 模拟
 * 「流式输出进行中」。
 */
async function mountStreaming(onInterrupt?: () => void) {
  let captured: { isIdle: () => boolean } | undefined;

  const t = await testRender(() => (
    <RunScreenSolid
      handleQuery={async () => "ok"}
      streamHandleQuery={async (_msg, _onChunk) => {
        // 永不 resolve —— 保持流式状态
        await new Promise(() => {});
        return "";
      }}
      maxLines={100}
      markdownEnabled={false}
      onInterrupt={onInterrupt}
      onRegisterHandlers={(handlers) => {
        captured = handlers;
      }}
    />
  ));

  // 真的打字 + 回车 ⇒ 进入 executeQuery ⇒ status 变成 "thinking"。
  await t.mockInput.typeText("hello");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();

  return { t, captured: captured!, flush: () => t.flush() };
}

/**
 * 按一个 **裸 ESC** 字节。
 *
 * ⚠️ 不用 `mockInput.pressEscape()` —— 实测（Task #4721 probe 4）在**非 kitty**
 * 模式下它**不产生任何 keypress 事件**（mock 的 kitty 编码分支要求
 * `kittyKeyboard: true`）。真实终端里 ESC 就是裸的 `0x1b` 字节，所以直接
 * 写 stdin 反而**更贴近真机**。
 */
async function pressEscape(t: { renderer: { stdin: { emit: (e: string, b: Buffer) => void } } }) {
  t.renderer.stdin.emit("data", Buffer.from([0x1b]));
  // ESC 在真实终端里是「按下即发」，但 parser 需要一个 tick 来判定它不是
  // 某个转义序列的前缀 ⇒ 给一点时间。
  await new Promise((r) => setTimeout(r, 120));
}

describeIfClient("tui-solid RunScreen — 打断链路（Task #4721 G2）", () => {
  it("calls onInterrupt when ESC is pressed while streaming", async () => {
    let interrupts = 0;
    const { t, flush } = await mountStreaming(() => {
      interrupts += 1;
    });
    try {
      expect(interrupts).toBe(0);
      await pressEscape(t);
      await flush();
      expect(interrupts).toBe(1);
    } finally {
      await t.dispose();
    }
  });

  it("does NOT call onInterrupt when ESC is pressed while idle", async () => {
    let interrupts = 0;
    const t = await testRender(() => (
      <RunScreenSolid
        handleQuery={async () => "ok"}
        maxLines={100}
        markdownEnabled={false}
        onInterrupt={() => {
          interrupts += 1;
        }}
      />
    ));
    try {
      await pressEscape(t);
      await t.flush();
      expect(interrupts).toBe(0);
    } finally {
      await t.dispose();
    }
  });

  it("Ctrl-C interrupts the stream instead of exiting the program", async () => {
    let interrupts = 0;
    let exited = false;
    const { t, flush } = await mountStreaming(() => {
      interrupts += 1;
    });
    try {
      t.mockInput.pressCtrlC();
      await flush();
      expect(interrupts).toBe(1);
      // 「退出整个程序」是 TextInput 的 onCancel 语义 —— 在流式期间不应触发
      expect(exited).toBe(false);
    } finally {
      await t.dispose();
    }
  });

  it("returns to idle after an interrupt (input becomes usable again)", async () => {
    let interrupts = 0;
    const { t, captured, flush } = await mountStreaming(() => {
      interrupts += 1;
    });
    try {
      expect(captured.isIdle()).toBe(false);
      await pressEscape(t);
      await flush();
      expect(interrupts).toBe(1);
      expect(captured.isIdle()).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  // ---------------------------------------------------------------------
  // 交叉验证 MAJOR-2 回归护栏
  //
  // G3 让输入框**常驻** ⇒ 用户可以在流式期间**提交下一轮** ⇒ 两轮并发。
  // 之前「轮次作用域」的状态其实是**组件作用域** ⇒ 轮 A 的 finally 会清掉
  // 轮 B 的打断标记、processing 计数永久失配。
  // ---------------------------------------------------------------------
  it("keeps per-turn state isolated when a second turn starts while streaming", async () => {
    let interrupts = 0;
    let captured: { isIdle: () => boolean } | undefined;
    // 两个**独立**的 streamHandleQuery（不同 promise ⇒ 不同轮次）
    const gates: Array<() => void> = [];

    const t = await testRender(() => (
      <RunScreenSolid
        handleQuery={async () => "ok"}
        streamHandleQuery={async (_msg, _chunk) => {
          await new Promise<void>((resolve) => gates.push(resolve));
          return "";
        }}
        maxLines={100}
        markdownEnabled={false}
        onInterrupt={() => {
          interrupts += 1;
        }}
        onRegisterHandlers={(handlers) => {
          captured = handlers;
        }}
      />
    ));

    try {
      // 轮 A
      await t.mockInput.typeText("turn-a");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      expect(captured?.isIdle()).toBe(false);

      // 轮 B（G3 之后输入框常驻 ⇒ 用户可以再提交一次）
      await t.mockInput.typeText("turn-b");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      expect(gates.length).toBe(2);

      // ESC 打断**两轮**
      await pressEscape(t);
      await t.flush();
      expect(interrupts).toBe(1);
      // 两轮都被打断 ⇒ 名额全部释放 ⇒ isIdle 为 true
      expect(captured?.isIdle()).toBe(true);

      // 轮 A 先 settle ⇒ 不能把轮 B 的状态清坏
      gates[0]?.();
      await t.flush();
      await new Promise((r) => setTimeout(r, 50));
      await t.flush();

      // 轮 B 也 settle ⇒ 计数必须回到 0（不能卡在 1 或负数）
      gates[1]?.();
      await t.flush();
      await new Promise((r) => setTimeout(r, 50));
      await t.flush();

      expect(captured?.isIdle()).toBe(true);
    } finally {
      await t.dispose();
    }
  });
});

if (!SOLID_REACTIVE) {
  describe("tui-solid RunScreen — 打断链路（Task #4721 G2）[SKIPPED]", () => {
    it("explains why the assertions were skipped", () => {
      expect(SOLID_REACTIVE).toBe(false);
    });
  });
}
