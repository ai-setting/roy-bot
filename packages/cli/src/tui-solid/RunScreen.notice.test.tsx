/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #4588 端口测试 — `onNotice`（「仅显示、不驱动 agent」通道）。
 *
 * ## 为什么需要这个文件
 *
 * main（#4588）在 **Ink** 链路 `RunTui.tsx` 里实现了 `onNotice`：
 * telemetry 通知（`task.background.started` / `.progress`）语义是「只发一条提示，
 * 不进 lane、不跑 agent」。它们原本走 `EventHandler` 默认 sender 的
 * `console.log` —— 在 Ink 下 stdout 被独占做整帧重绘，裸 `console.log` 会被
 * 排队/错序，实测打在 `/exit` 之后。
 *
 * 迁移到 **opentui/Solid** 后，生产入口是 `commands/interactive.ts` → `tui-solid/mount.tsx`
 * → `tui-solid/RunScreen.tsx`。`commands/interactive.ts` 侧的接线（`runState.onNotice`、
 * `dispatchInteractiveNotice`、`buildInteractiveEventHandlerOptions`）已随 merge 带入，
 * 但 **`tui-solid/RunScreen.tsx` 原本没有实现 `onNotice`** —— 于是：
 *
 *   - `runState.onNotice` 永远是 `undefined`
 *   - `dispatchInteractiveNotice` 的 `onNotice?.(text) === true` 恒为 false
 *   - → 落进 `writeFallback`（`console.log`）—— **正是 #4588 要修的那个 bug**
 *
 * 所以本文件锁住「opentui 侧也必须提供 `onNotice`」这条契约。
 *
 * ## 断言策略（沿用片5 模板的已知边界）
 *
 * `bun test` 默认把 `solid-js` 解析到 **SSR build**（`dist/server.js`）→
 * effects 不 flush，且 opentui 的 reconciler 在 SSR 下会抛
 * `Orphan text error`。要让断言真的跑起来，必须用 browser 条件：
 *
 *   bun --conditions=browser test packages/cli/src/tui-solid/RunScreen.notice.test.tsx
 *
 * 这正是生产路径（`bun build --conditions=browser`）用的 solid-js client 构建。
 * 纯 `bun test`（SSR）下本文件整体 skip —— 理由写在 skip 消息里，不静默通过。
 *
 * 动态行为（点击展开 / 输入回显）由真 pty 脚本覆盖
 * （`scripts/tui-solid/e2e-thinking-clickable.py` 等）。
 */

import { describe, expect, it } from "bun:test";
import { createEffect, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import RunScreenSolid from "./RunScreen.js";

/**
 * True only when Solid's client runtime is live (片5 模板 blocker (2)).
 * Under `bun test` this is `false`; under `bun --conditions=browser test` `true`.
 */
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

/** `bun test`（SSR）下 opentui reconciler 会抛 Orphan text error → 整体 skip。 */
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/**
 * 渲染 RunScreenSolid 并捕获 `onRegisterHandlers` 收到的 handlers。
 *
 * `onRegisterHandlers` 在 Solid 组件体内**同步**调用（见 RunScreen.tsx 的注释），
 * 所以捕获是稳定的 —— 不依赖 repaint。
 */
async function mountAndCaptureHandlers(handleQuery?: () => Promise<string>) {
  let captured: {
    onNotification: (message: string, envEvent?: any) => void | Promise<void>;
    onNotice?: (text: string) => boolean;
    isIdle: () => boolean;
  } | undefined;

  const t = await testRender(() => (
    <RunScreenSolid
      handleQuery={handleQuery ?? (async () => "ok")}
      maxLines={100}
      markdownEnabled={false}
      onRegisterHandlers={(handlers) => {
        captured = handlers;
      }}
    />
  ));

  return { t, captured: captured! };
}

describeIfClient("tui-solid RunScreen — onNotice 通道（Task #4588 端口）", () => {
  it("registers an onNotice handler (the #4588 contract)", async () => {
    const { t, captured } = await mountAndCaptureHandlers();
    try {
      expect(captured).toBeDefined();
      expect(typeof captured.onNotice).toBe("function");
    } finally {
      await t.dispose();
    }
  });

  it("onNotice returns true (「已接管」契约 — interactive.ts 用 === true 判定)", async () => {
    const { t, captured } = await mountAndCaptureHandlers();
    try {
      // 契约要求：返回 true 表示「已接管并显示」。
      // 返回 undefined 会让同一条通知既画进 TUI **又**额外 console.log 一次。
      expect(captured.onNotice?.("hello")).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it("onNotice does NOT trigger an agent run (「仅显示」语义)", async () => {
    let queryCalls = 0;
    const { t, captured } = await mountAndCaptureHandlers(async () => {
      queryCalls += 1;
      return "ok";
    });
    try {
      captured?.onNotice?.("task.background.started: 某某任务开始");
      // onNotice 是「仅显示」通道 —— 绝不能驱动 agent 再跑一轮。
      expect(queryCalls).toBe(0);
    } finally {
      await t.dispose();
    }
  });

  it("isIdle stays true while onNotice is used (通知不占用 agent)", async () => {
    const { t, captured } = await mountAndCaptureHandlers();
    try {
      captured.onNotice?.("通知");
      expect(captured.isIdle()).toBe(true);
    } finally {
      await t.dispose();
    }
  });
});

if (!SOLID_REACTIVE) {
  describe("tui-solid RunScreen — onNotice 通道（Task #4588 端口）[SKIPPED]", () => {
    it("explains why the assertions were skipped", () => {
      expect(SOLID_REACTIVE).toBe(false);
      // 提示：SSR 下 solid-js → dist/server.js（effects 不 flush），
      // 且 opentui reconciler 抛 Orphan text error。
      // 用 `bun --conditions=browser test <file>` 重跑即可真正执行断言。
    });
  });
}
