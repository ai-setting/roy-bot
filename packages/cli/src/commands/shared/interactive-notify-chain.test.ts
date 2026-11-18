/**
 * @fileoverview Task #4588 — Ink TUI (`roy-bot interactive`) 通知链路断点回归
 *
 * ## 为什么这个文件必须存在（真机 trace 铁证）
 *
 * 用户 2026-10-28 10:17 在 `roy-bot interactive`（PID 19473）里 delegate 了一个
 * 后台任务 `process_1793153834389_ju34s5qwm`，之后**彻底停住**：没有 rule-based
 * 通知，agent 也没有接着处理完成事件。
 *
 * traces.db（traceId `01a1804b9a63ab21`）里三条铁证：
 *   - `delegate.deriveTriggerEventId` → `[undefined]`
 *   - `delegate.captureReplyChannel`  → `[undefined]`
 *   - `event_handler.handle_event` (task.background.started)
 *       metadata 只有 `{source, trigger_session_id, env_name}`
 *       —— **没有 replyChannel，也没有 triggerEventId**
 *
 * ## 根因（不是 run.ts！）
 *
 * `roy-bot interactive` 实跑的是 `interactive.ts` 的 `createRunCommand()`。Task #4568
 * 给 interactive.ts 加了两条 query 通道，但**只给其中一条加了 emit**：
 *
 *   | 函数                        | emit? | RunTui 是否用       |
 *   |-----------------------------|-------|---------------------|
 *   | `handleQuery`（one-shot）    | ✅    | 仅当 stream 缺失     |
 *   | `createStreamHandleQuery`   | ❌    | ✅ 优先（永远走这条） |
 *
 * `RunTui.tsx:346` 的判据 `if (streamHandleQuery)` 恒真 ⇒ `handleQuery` 的 emit
 * 是**死代码**，stream 路径的 EnvContext 里永远没有 `envEvent` ⇒
 * `captureReplyChannelSnapshot()` undefined ⇒ notify event 无回复目标 ⇒
 * `resolveNoticeTarget()` 三级全 miss ⇒ 静默丢弃。
 *
 * ## RED 分组说明（不造假红）
 *
 * - 组 1 / 组 3：**当前必红**（emit 缺失、快照缺失）。
 * - 组 2：当前**已经是绿的** —— 它是「通知轮绝不 emit」的回归护栏，
 *   写它是为了防止我在修组 1 时把判据写坏（#4568 就因为判据写成
 *   `runSessionId === sessionId` 而在通知轮多写了一倍 trigger event）。
 * - 组 4：锁 EventHandler 对 CLI sink 的处置（不得 spawn lark-cli 到 `cli:` 假 chatId）。
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildInteractiveEventHandlerOptions,
  createStreamHandleQuery,
  dispatchInteractiveNotice,
  emitUserTurnTrigger,
} from "../interactive";
import { EventHandler } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";

// ============================================================================
// 测试替身
// ============================================================================

/** 捕获 queryExecutor.execute 收到的 mergedContext（这就是 EnvContext 的上游）。 */
function makeFakeExecutor() {
  const captured: Array<{ message: string; sessionId: string; mergedContext: any }> = [];
  const executor = {
    setChunkCallback: () => {},
    execute: async (message: string, sessionId: string, _opts: any, _traceId: any, ctx: any) => {
      captured.push({ message, sessionId, mergedContext: ctx });
      return "ok";
    },
    getFullText: () => "",
    getLastUsage: () => undefined,
    initStreamOutput: () => {},
  };
  return { executor, captured };
}

/**
 * ★ Task #4588（交叉验证 ISSUE 4）：测试必须把 trigger event 写到 tmp 库。
 *
 * 首版没传 dbPath → `emitCliTriggerEvent()` 默认解析到
 * `~/.roy-bot/event-store.db` ⇒ 每跑一次单测就往**用户真实库**插一条
 * `cli-query` 记录（实测污染 38 行，sessionId 全是 `session_stream_*`）。
 */
function makeTmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "4588-trigger-"));
  return join(dir, "event-store.db");
}

function makeRunOpts(dbPath: string): any {
  return {
    model: "test-model",
    reasoning: true,
    toolCalls: true,
    toolResults: false,
    defaultAgentName: "test",
    triggerEventDbPath: dbPath,
  };
}

/**
 * 剥掉行注释与块注释，用于源码结构断言。
 *
 * 为什么需要：组 5/6 的断言关键词（`telemetrySender` / `notice.sink !== "stdout"`
 * / `sendLarkChatMarkdown`）**本身就出现在我写的解释性注释里** —— 直接 indexOf
 * 会命中注释，让断言恒真（假绿）。交叉验证时我第一版就踩了这个坑。
 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

// ============================================================================
// 组 1：stream 路径（RunTui 实际走的那条）必须 emit trigger event
// ============================================================================

describe("Task #4588 组1 — createStreamHandleQuery 用户轮必须注入 envEvent", () => {
  test("用户轮（envEvent 为 undefined）→ mergedContext 必须带 envEvent + replyChannel", async () => {
    const { executor, captured } = makeFakeExecutor();
    const dbPath = makeTmpDbPath();
    const streamHandle = createStreamHandleQuery(
      executor as any,
      "session_stream_1",
      makeRunOpts(dbPath),
      undefined,
      undefined,
    );

    // envEvent 不传 = 用户键入
    await streamHandle("请 delegate 一个后台任务", () => {});

    expect(captured).toHaveLength(1);
    const ctx = captured[0]!.mergedContext;

    // ★ 核心断言：没有 envEvent 就不可能有 replyChannel 快照 → 通知必丢。
    expect(ctx.envEvent).toBeDefined();
    expect(ctx.envEvent?.metadata?.triggerEventId).toBeString();
    expect(ctx.envEvent?.metadata?.replyChannel?.chatId).toBe("cli:session_stream_1");
    expect(ctx.envEvent?.metadata?.replyChannel?.params?.sink).toBe("stdout");
  });
});

// ============================================================================
// 组 2：通知轮绝不 emit（回归护栏 —— 现状已绿，修组 1 时不许写坏）
// ============================================================================

describe("Task #4588 组2 — 通知轮绝不能重复 emit（防无限套娃）", () => {
  test("envEvent 有值 → mergedContext.envEvent 必须是**原样透传**，不得被新 trigger 覆盖", async () => {
    const { executor, captured } = makeFakeExecutor();
    const dbPath = makeTmpDbPath();
    const streamHandle = createStreamHandleQuery(
      executor as any,
      "session_stream_2",
      makeRunOpts(dbPath),
      undefined,
      undefined,
    );

    const notifyEvent = {
      id: "evt_notify_orig",
      type: "task.background.completed",
      metadata: { triggerEventId: "evt_ORIGINAL", replyChannel: { chatId: "cli:orig" } },
      payload: {},
    };

    await streamHandle("后台任务完成了", () => {}, undefined, undefined, notifyEvent);

    expect(captured).toHaveLength(1);
    const ctx = captured[0]!.mergedContext;
    // 原样透传 —— 若被新 emit 的 envEvent 覆盖，triggerEventId 就变了
    expect(ctx.envEvent?.metadata?.triggerEventId).toBe("evt_ORIGINAL");
    // ★ 交叉验证第二轮：仅断言 triggerEventId 太弱 —— 若实现「先 emit 再取
    //   `envEvent ?? triggerInjection`」，triggerEventId 仍是原值，断言照样绿，
    //   但每次通知都白写一条 trigger event（#4568 踩过的坑）。
    //   所以直接**调 helper 断言它返回 undefined** —— 这是"绝不 emit"的充分条件。
    const injected = await emitUserTurnTrigger({
      envEvent: notifyEvent,
      message: "后台任务完成了",
      sessionId: "session_stream_2",
      quiet: true,
      dbPath: makeTmpDbPath(),
    });
    expect(injected).toBeUndefined();
  });
});

// ============================================================================
// 组 3：有了 trigger event，delegate 的快照必须拿到 replyChannel
// ============================================================================

describe("Task #4588 组3 — trigger event 能让 replyChannel 快照非空", () => {
  test("toCliEnvEvent 产出的 metadata 能穿透 targetFromEventMetadata()", async () => {
    const { toCliEnvEvent } = await import("./cli-trigger-event");
    const { targetFromEventMetadata } = await import("./telemetry-notice");

    const envEvent = toCliEnvEvent(
      {
        triggerEventId: "evt_snap_1",
        replyChannel: {
          type: "cli-command",
          chatId: "cli:session_snap",
          params: { sink: "stdout", cliSessionId: "session_snap" },
        },
      } as any,
      "用户 query",
    );

    // buildRunEnvContext 读的就是 effectiveContext.envEvent.metadata.replyChannel
    const target = targetFromEventMetadata(envEvent.metadata as any);
    expect(target).toBeDefined();
    expect(target?.chatId).toBe("cli:session_snap");
    // 关键：必须是 stdout，否则 EventHandler 会 spawn lark-cli 到假 chatId
    expect(target?.sink).toBe("stdout");
  });
});

// ============================================================================
// 组 4：EventHandler 拿到 CLI replyChannel 时必须走 stdout，不得 spawn lark-cli
// ============================================================================

describe("Task #4588 组4 — CLI 来源的通知必须走 stdout sink", () => {
  test("task.background.completed 带 cli: chatId → telemetrySender 收到 sink=stdout", async () => {
    const sent: any[] = [];
    const env: any = {
      subscribeAll: (cb: any) => {
        env._cb = cb;
        return () => {};
      },
      getComponent: () => undefined,
    };

    const handler = new EventHandler({
      env,
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter({ prefix: "[通知]" }),
      isIdle: () => true,
      onEvent: async () => {},
      onEventWithEnv: async () => {},
      // 显式注入探针 sender：既避免真的 spawn lark-cli，又能断言 sink
      telemetrySender: async (notice: any) => {
        sent.push(notice);
      },
    });
    handler.start();

    env._cb({
      id: "evt_cli_done_1",
      type: "task.background.completed",
      timestamp: Date.now(),
      metadata: {
        replyChannel: {
          type: "cli-command",
          chatId: "cli:session_stream_4",
          params: { sink: "stdout", cliSessionId: "session_stream_4" },
        },
        triggerEventId: "evt_cli_trig_4",
      },
      payload: { backgroundTaskId: "process_x", description: "sleep 8", status: "completed" },
    });

    // rule notice 是 await 的，事件订阅回调 fire-and-forget，给一拍
    await new Promise((r) => setTimeout(r, 200));

    expect(sent.length).toBeGreaterThan(0);
    const notice = sent[0]!;
    expect(notice.chatId).toBe("cli:session_stream_4");
    // ★ 核心：sink 必须是 stdout。若为 undefined/'lark'，生产默认 sender 会去
    //   spawn `lark-cli --chat-id cli:xxx` → 飞书拒 → 被 catch swallow → 静默丢弃
    expect(notice.sink).toBe("stdout");

    handler.stop();
  });
});

// ============================================================================
// 组 5/6：Q3 —— 通知分派的**行为**断言（交叉验证第二轮 ISSUE 6 根治）
// ============================================================================
//
// ## 为什么不再用「读 interactive.ts 源码 + 字符串包含」
//
// 第一版组 5/6 是源码字符串断言。交叉验证第二轮实测证明它**可被轻易绕过**：
// 把 sink 分派整段删掉，只在**行尾注释**塞 `// notice.sink !== "stdout"`
// 或在**字符串字面量**塞 `void "sendLarkChatMarkdown";` → 依然 7 pass 全绿。
// 也就是说那个护栏价值≈0，ISSUE 1 的回归能悄无声息地回来。
//
// 根治办法：把分派策略抽成导出纯函数 `dispatchInteractiveNotice(notice, deps)`
// （interactive.ts），测试**直接调它并观察副作用**。

describe("Task #4588 组5/6 — dispatchInteractiveNotice 按 sink 分派", () => {
  /** 记录一次分派里发生了什么（谁被调了、调了几次）。 */
  function tap() {
    const lark: any[] = [];
    const notices: string[] = [];
    const fallbacks: string[] = [];
    return {
      lark,
      notices,
      fallbacks,
      deps: {
        sendLark: async (n: any) => {
          lark.push(n);
        },
        onNotice: (t: string) => {
          notices.push(t);
          return true;
        },
        writeFallback: (t: string) => {
          fallbacks.push(t);
        },
      },
    };
  }

  test("sink='stdout'（CLI 来源）→ 只进 TUI，绝不 spawn lark-cli", async () => {
    const t = tap();
    await dispatchInteractiveNotice(
      { text: "🔔 已启动", sink: "stdout", chatId: "cli:sess-1" },
      t.deps,
    );
    expect(t.notices).toEqual(["🔔 已启动"]);
    expect(t.lark).toEqual([]);       // ← 绝不发飞书
    expect(t.fallbacks).toEqual([]);  // ← 已接管，不该兜底
  });

  test("sink 缺省（真实飞书来源）→ 只发 lark，绝不进本地 TUI", async () => {
    const t = tap();
    await dispatchInteractiveNotice(
      { text: "✅ 已完成", chatId: "oc_real_chat" },
      t.deps,
    );
    expect(t.lark).toHaveLength(1);
    expect(t.lark[0].chatId).toBe("oc_real_chat");
    expect(t.notices).toEqual([]);    // ← 回归护栏：不能被拽进终端
    expect(t.fallbacks).toEqual([]);
  });

  test("sink='lark' → 走 lark，与控制台无关", async () => {
    const t = tap();
    await dispatchInteractiveNotice({ text: "✅", sink: "lark", chatId: "oc_x" }, t.deps);
    expect(t.lark).toHaveLength(1);
    expect(t.notices).toEqual([]);
  });

  test("onNotice 未就绪（mount 前）→ 退回兜底输出，绝不静默丢弃", async () => {
    const fallbacks: string[] = [];
    let larkCalls = 0;
    await dispatchInteractiveNotice(
      { text: "🔔 已启动", sink: "stdout", chatId: "cli:s" },
      {
        // 显式不给 onNotice
        sendLark: async () => {
          larkCalls += 1;
        },
        writeFallback: (x) => fallbacks.push(x),
      },
    );
    expect(fallbacks).toEqual(["🔔 已启动"]);
    expect(larkCalls).toBe(0); // 绝不能因为没 TUI 就改去发飞书
  });

  test("onNotice 返回 undefined（实现写错）→ 也走兜底，不会静默丢", async () => {
    const fallbacks: string[] = [];
    const notices: string[] = [];
    await dispatchInteractiveNotice(
      { text: "X", sink: "stdout" },
      {
        onNotice: (t) => {
          notices.push(t);
          return undefined; // 模拟「画了但没声明接管」
        },
        writeFallback: (x) => fallbacks.push(x),
      },
    );
    expect(notices).toEqual(["X"]);
    expect(fallbacks).toEqual(["X"]); // 宁可重复也不静默丢（已在注释说明取舍）
  });
});

// ============================================================================
// 组 7（交叉验证 ISSUE 2 回归）：通知行的 role 必须是 Role 联合里的合法值
// ============================================================================
//
// `tui/App.tsx` 的 `Role = "user" | "assistant" | "tool" | "usage"` —— **没有
// "system"**。用 "system" 会落到 assistant 分支 → 渲染成「🤖 Agent」标题 +
// Markdown 解析（任务描述里的 `*` / `` ` `` / `[]()` 被吃掉变形）。
//
// 为什么这条仍是源码断言：`onNotice` 是 TUI 组件内的内联回调，依赖渲染
// 上下文，无法在纯 bun 测试里取到。折中做法 —— 断言用的是**完整字面量**
// `role: "tool"`，比裸关键词更难被注释/字符串意外满足；
// 且 tsc 会独立把关（本仓库确实装了 @types/react，交叉验证第二轮实测
// role:"system" 会报 TS2345）。
//
// ⚠️ Task #4681：断言目标从 `src/RunTui.tsx`（Ink 版）改为
// **`src/tui-solid/RunScreen.tsx`**（opentui/Solid 版）。原因：
// `roy-bot interactive` 的 TUI 已迁到 opentui（`commands/interactive.ts`
// → `tui-solid/mount.tsx` → `tui-solid/RunScreen.tsx`），Ink 版 `RunTui.tsx`
// 已成为孤儿并在 Task #4681 中删除。**断言意图不变**，只是跟随实现搬家 ——
// 若仍指向已删除的文件，这条测试会因 ENOENT 而红（那不是产品缺陷，是
// 断言指向了死代码）。
//
// Solid 版的 `onNotice` 实现见 `handleNotice`（`tui-solid/RunScreen.tsx`）：
// 它走 `pushTool(...)` ⇒ `commitHistory({ role: "tool", content, … })`，
// 与 Ink 版同义（role 合法 + 显式 `return true`）。

describe("Task #4588 组7 — onNotice 的 role 必须是合法 Role", () => {
  test('onNotice 使用 role:"tool"（合法值），不用不存在的 "system"', async () => {
    const { readFileSync } = await import("node:fs");
    // live 的 opentui/Solid 实现（interactive 链路真实运行的那份）
    const tui = readFileSync(
      join(import.meta.dir, "..", "..", "tui-solid", "RunScreen.tsx"),
      "utf-8",
    );

    // 定位 live 的 onNotice 实现体
    const start = tui.indexOf("const handleNotice = (text: string): boolean => {");
    expect(start).toBeGreaterThan(-1);
    const block = tui.slice(start, start + 400);

    // 契约：必须显式 return true，否则 interactive.ts 侧判定为「没接管」→ 双打
    expect(block).toContain("return true;");
    // onNotice 走 pushTool ⇒ role 必须是合法的 "tool"，绝不能是 "system"
    expect(block).toContain("pushTool(");
    expect(block).not.toContain('role: "system"');

    // pushTool 的实现必须写死 role: "tool"（Solid 版把 role 放在
    // commitHistory 调用里，不像 Ink 版直接内联在 onNotice 回调中）
    const pushToolStart = tui.indexOf("const pushTool = (content: string) => {");
    expect(pushToolStart).toBeGreaterThan(-1);
    const pushToolBlock = tui.slice(pushToolStart, pushToolStart + 200);
    expect(pushToolBlock).toContain('role: "tool"');
    expect(pushToolBlock).not.toContain('role: "system"');
  });
});

// ============================================================================
// 组 8（交叉验证第三轮 ISSUE A 根治）：**生产接线**必须真的接上 telemetrySender
// ============================================================================
//
// ## 为什么这条必须存在（本轮最严重的假绿）
//
// 上一轮的组 5/6 只断言了纯函数 `dispatchInteractiveNotice()` 自身的行为。
// 交叉验证实测：把生产端 `telemetrySender:` **整段删掉**，10 个测试依然全绿 ——
// 纯函数写得再对，生产端不接线也白搭，而删掉接线的后果正是**本次修复的主目标
// 直接回退**（通知退回 EventHandler 默认的 console.log，Ink 下看不见）。
//
// 现在 `buildInteractiveEventHandlerOptions()` 被导出，可以直接断言：
//   ① 返回值里确实有 telemetrySender
//   ② 该 sender 对 sink='stdout' 走 onNotice（不是 console.log）
//   ③ 该 sender 对 lark 通知走 sendLark（不进本地 TUI）
//   ④ onEventWithEnv 真的把通知交给 onNotification（驱动 agent 续跑）

describe("Task #4588 组8 — 生产接线：buildInteractiveEventHandlerOptions 真的接上了", () => {
  function makeDeps(probes: {
    notices: string[];
    larks: any[];
    notifications: Array<{ message: string }>;
  }) {
    return {
      env: {} as any,
      sessionComponent: {} as any,
      isIdle: () => true,
      onNotice: (t: string) => {
        probes.notices.push(t);
        return true;
      },
      onNotification: async (message: string) => {
        probes.notifications.push({ message });
      },
      sendLark: async (n: any) => {
        probes.larks.push(n);
      },
    };
  }

  test("返回的 options 必须带 telemetrySender（删掉接线这条就红）", async () => {
    const probes = { notices: [], larks: [], notifications: [] };
    const opts: any = buildInteractiveEventHandlerOptions(makeDeps(probes) as any);

    expect(typeof opts.telemetrySender).toBe("function");
    // 通配订阅也必须保留（task.background.completed 靠它进来）
    expect(opts.eventTypes).toEqual(["task.background.*", "event-source.event.*"]);
  });

  test("接线后的 sender：sink='stdout' → onNotice，sink 缺省 → sendLark", async () => {
    const probes = { notices: [], larks: [], notifications: [] };
    const opts: any = buildInteractiveEventHandlerOptions(makeDeps(probes) as any);

    await opts.telemetrySender({ text: "🔔 已启动", sink: "stdout", chatId: "cli:s1" });
    expect(probes.notices).toEqual(["🔔 已启动"]);
    expect(probes.larks).toEqual([]);

    await opts.telemetrySender({ text: "✅ 已完成", chatId: "oc_real" });
    expect(probes.larks).toHaveLength(1);
    expect(probes.notices).toEqual(["🔔 已启动"]); // 没新增
  });

  test("接线后的 onEventWithEnv 必须交出通知（否则 agent 不会续跑）", async () => {
    const probes = { notices: [], larks: [], notifications: [] };
    const opts: any = buildInteractiveEventHandlerOptions(makeDeps(probes) as any);

    await opts.onEventWithEnv({ message: "[通知] 后台任务已完成", envEvent: { id: "e1" } });
    expect(probes.notifications).toEqual([{ message: "[通知] 后台任务已完成" }]);
  });
});

// ============================================================================
// 组 9（交叉验证第三轮 ISSUE B 根治）：**调用点**漏传 envEvent 必须被 DB 抓到
// ============================================================================
//
// ## 为什么不能只断言 helper
//
// 组 2 断言的是 `emitUserTurnTrigger({envEvent})` **自身**返回 undefined。
// 但交叉验证实测：把 `interactive.ts` 流式调用点的 `envEvent` 改成 `undefined`，
// 10 个测试依然全绿 —— helper 是对的、调用点漏传，照样绿。
//
// 后果不是理论：通知轮会**真的多写一条 trigger event**（探针实测 tmp 库
// 从空表变成有 1 行），正是 #4568 踩过的"每轮 notify 多写一条"。
//
// 现在直接查 DB 行数：通知轮跑完后 `event_store` **不得新增行**。

describe("Task #4588 组9 — 通知轮不得往 event_store 写任何行", () => {
  function countRows(dbPath: string): number {
    try {
      const db = new Database(dbPath, { readonly: true });
      const r = db.query("select count(*) c from event_store").get() as any;
      db.close();
      return Number(r?.c ?? 0);
    } catch {
      // 表不存在 = 0 行
      return 0;
    }
  }

  test("通知轮（envEvent 有值）→ event_store 新增 0 行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "4588-notifyturn-"));
    const dbPath = join(dir, "event-store.db");

    const { executor } = makeFakeExecutor();
    const streamHandle = createStreamHandleQuery(
      executor as any,
      "session_notify_turn",
      makeRunOpts(dbPath),
      undefined,
    );

    const before = countRows(dbPath);
    expect(before).toBe(0);

    const notifyEvent = {
      id: "evt_notify_b",
      type: "task.background.completed",
      metadata: { triggerEventId: "evt_ORIG_B", replyChannel: { chatId: "cli:orig" } },
      payload: {},
    };
    await streamHandle("后台任务完成了", () => {}, undefined, undefined, notifyEvent);

    // ★ 核心：通知轮绝不落库。若调用点把 envEvent 传成 undefined
    //   （helper 会当成用户轮 → emit），这里会变成 1。
    expect(countRows(dbPath)).toBe(before);

    rmSync(dir, { recursive: true, force: true });
  });

  test("用户轮 → event_store 必须新增 1 行（对照组，证明上面的 0 不是恒真）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "4588-userturn-"));
    const dbPath = join(dir, "event-store.db");

    const { executor } = makeFakeExecutor();
    const streamHandle = createStreamHandleQuery(
      executor as any,
      "session_user_turn",
      makeRunOpts(dbPath),
      undefined,
    );

    expect(countRows(dbPath)).toBe(0);
    await streamHandle("请 delegate 一个后台任务", () => {});
    expect(countRows(dbPath)).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });
});
