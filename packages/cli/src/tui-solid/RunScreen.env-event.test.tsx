/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #4588 端口回归测试 — opentui 侧 **envEvent 必须透传**。
 *
 * ## 这个文件锁的是什么
 *
 * `emitUserTurnTrigger()`（`commands/interactive.ts`）用「`envEvent` 是否存在」区分
 * 用户轮与通知轮：
 *
 *   - 用户轮（envEvent === undefined）→ emit 一条 CLI trigger event（正确）
 *   - 通知轮（envEvent 有值）        → **绝不** emit
 *
 * 判错的后果是**静默**的（无任何报错）：
 *
 *   1. 通知轮被当成用户轮 ⇒ 每轮通知都往 `event_store` 白写一条 trigger
 *      event ⇒ notify → agent → delegate → notify **无限套娃**
 *   2. `mergedContext.envEvent` 被新 emit 的 trigger 覆盖 ⇒ 上游
 *      `replyChannel` / `triggerEventId` 丢失 ⇒
 *      `EventHandler.resolveNoticeTarget()` 三级全 miss ⇒ **通知静默丢弃**
 *
 * ## 为什么 opentui 侧也要测
 *
 * opentui 端口最初**从不传** envEvent：
 *   - `streamHandleQuery(message, onChunk, onTool, onReasoning)` —— 只 4 个参数
 *   - `handleNotification(message, _envEvent)` —— 收下就丢
 *
 * 而 Ink 侧 `RunTui.tsx` 是 `executeQuery(message, envEvent)` 透传的。
 * ⇒ 迁移到 opentui 后，**同一个语义在两条链路上表现不同**，且两边都编译通过。
 *
 * 本文件锁住「opentui 侧 envEvent 一路到 `streamHandleQuery`」这条契约，
 * 防止将来再次静默失效。
 *
 * ## 断言策略（沿用 `RunScreen.notice.test.tsx` 的已知边界）
 *
 * `bun test` 默认把 `solid-js` 解析到 **SSR build**（`dist/server.js`）→
 * effects 不 flush，且 opentui 的 reconciler 在 SSR 下会抛
 * `Orphan text error`。要让断言真的跑起来，必须用 browser 条件：
 *
 *   bun --conditions=browser test packages/cli/src/tui-solid/RunScreen.env-event.test.tsx
 *
 * 纯 `bun test`（SSR）下本文件整体 skip —— 理由写在 skip 消息里，不静默通过。
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

/** 一条假的"通知轮"触发事件。 */
const NOTIFY_EVENT = {
  id: "evt_notify_opentui",
  type: "task.background.completed",
  metadata: { triggerEventId: "evt_ORIGINAL", replyChannel: { chatId: "cli:orig" } },
  payload: {},
};

describeIfClient("tui-solid RunScreen — envEvent 透传（Task #4588 端口回归）", () => {
  it("handleNotification 把 envEvent 原样传给 streamHandleQuery（不丢、不少）", async () => {
    const seen: Array<{ envEvent: unknown; onUsage: unknown; onReasoning: unknown }> = [];

    const t = await testRender(() => (
      <RunScreenSolid
        handleQuery={async () => "ok"}
        streamHandleQuery={async (_m, _c, _t2, onUsage, envEvent, onReasoning) => {
          seen.push({ envEvent, onUsage, onReasoning });
          return "ok";
        }}
        maxLines={100}
        markdownEnabled={false}
        onRegisterHandlers={() => {}}
      />
    ));

    try {
      // 拿到 onRegisterHandlers 暴露的 onNotification —— 这是 EventHandler
      // 投递通知的唯一入口。
      let handlers: {
        onNotification: (message: string, envEvent?: any) => void | Promise<void>;
      } | undefined;
      const t2 = await testRender(() => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          streamHandleQuery={async (_m, _c, _t3, onUsage, envEvent, onReasoning) => {
            seen.push({ envEvent, onUsage, onReasoning });
            return "ok";
          }}
          maxLines={100}
          markdownEnabled={false}
          onRegisterHandlers={(h) => {
            handlers = h as any;
          }}
        />
      ));
      await t2.dispose();

      expect(handlers).toBeDefined();
      await handlers!.onNotification("后台任务完成了", NOTIFY_EVENT);

      // ★ 核心断言：envEvent 必须**原样**到达 streamHandleQuery。
      //   若 opentui 侧丢了它 ⇒ emitUserTurnTrigger 会把这一轮当成用户轮
      //   ⇒ 白写 trigger event + 覆盖 replyChannel ⇒ 通知静默丢弃。
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]!.envEvent).toBe(NOTIFY_EVENT);
    } finally {
      await t.dispose();
    }
  });

  it("positional 顺序必须是 (onTool, onUsage, envEvent, onReasoning) — onUsage 不是 envEvent", async () => {
    const seen: Array<{ onUsage: unknown; envEvent: unknown; onReasoning: unknown }> = [];

    const t = await testRender(() => (
      <RunScreenSolid
        handleQuery={async () => "ok"}
        streamHandleQuery={async (_m, _c, _t2, onUsage, envEvent, onReasoning) => {
          seen.push({ onUsage, envEvent, onReasoning });
          return "ok";
        }}
        maxLines={100}
        markdownEnabled={false}
        onRegisterHandlers={() => {}}
      />
    ));

    try {
      let handlers: {
        onNotification: (message: string, envEvent?: any) => void | Promise<void>;
      } | undefined;
      const t2 = await testRender(() => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          streamHandleQuery={async (_m, _c, _t3, onUsage, envEvent, onReasoning) => {
            seen.push({ onUsage, envEvent, onReasoning });
            return "ok";
          }}
          maxLines={100}
          markdownEnabled={false}
          onRegisterHandlers={(h) => {
            handlers = h as any;
          }}
        />
      ));
      await t2.dispose();

      await handlers!.onNotification("通知", NOTIFY_EVENT);

      expect(seen.length).toBeGreaterThan(0);
      const call = seen[0]!;
      // onUsage 必须落在 onUsage 位（不能与 envEvent 串位）
      expect(call.onUsage).toBeInstanceOf(Function);
      // envEvent 必须落在 envEvent 位
      expect(call.envEvent).toBe(NOTIFY_EVENT);
      // onReasoning 必须落在末位（片6 thinking 通道）
      expect(call.onReasoning).toBeInstanceOf(Function);
    } finally {
      await t.dispose();
    }
  });
});

if (!SOLID_REACTIVE) {
  describe("tui-solid RunScreen — envEvent 透传（Task #4588 端口回归）[SKIPPED]", () => {
    it("explains why the assertions were skipped", () => {
      expect(SOLID_REACTIVE).toBe(false);
      // 用 browser 条件跑：bun --conditions=browser test packages/cli/src/tui-solid/RunScreen.env-event.test.tsx
    });
  });
}
