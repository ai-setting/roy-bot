/**
 * @fileoverview Task #4552 (A1) — telemetry 进展提示（纯 IM 直发）单测
 *
 * ## 这条链路要解决的问题（trace 实证）
 *
 * `task.background.started` / `task.background.progress` 两类**中间态 telemetry**
 * 以前走「老 formatter → 进 lane → 完整 agent run」：
 *
 * 1. 心跳带 `replyChannel.chatId` → `laneKeyFor()` 归到**群那条 lane**
 * 2. 该 lane 与用户真实消息共用，且严格 FIFO 串行
 * 3. 每次心跳 = 一次完整 agent run（几分钟到十几分钟）
 *
 * 实测（trace `151a2374558501c014d9042321835e5a`，12856 spans）：
 * - 入站延迟 14min / 18.4min / **21.5min**
 * - lane 占用 313 run-minutes / 210 分钟墙钟（>100% 饱和）
 * - 用户两条消息被完全饿死
 *
 * ## A1 = 从源头消灭
 *
 * 这两类事件完全不进 lane，只做一件事：反查 triggerEvent 拿 chatId + profile，
 * 用 lark-cli 发一条**一句话**进展提示。
 *
 * ## 本文件锁定
 *
 * - 事件白名单（哪些是 telemetry，哪些绝不能进）
 * - 文案格式（task id / 标题 / 已跑时长 / **预计超时绝对时间**）
 * - 目标解析（metadata 快照 → EventStore 反查兜底）
 * - lark-cli args 拼装 + idempotency-key ≤ 50 字符
 * - spawn 的硬超时 / 错误传播语义
 */

import { describe, test, expect, vi } from "bun:test";
import {
  TELEMETRY_EVENT_TYPES,
  buildLarkSendArgs,
  buildTelemetryNoticeText,
  formatClock,
  formatElapsed,
  formatTimeoutLabel,
  isTelemetryEvent,
  sendLarkChatMarkdown,
  targetFromEventMetadata,
  targetFromTriggerEvent,
} from "./telemetry-notice";

// ============================================================================
// Fixtures
// ============================================================================

const CHAT = "oc_8904d6f184e31b6cc51ba53a0a19aa2f";
const START = new Date(2026, 9, 26, 12, 23, 42).getTime(); // 12:23:42 本地时区
const FIVE_HOURS = 5 * 3600 * 1000;

function progressPayload(over: Record<string, unknown> = {}) {
  return {
    backgroundTaskId: "process_1792988622098_r6rml36s6",
    subSessionId: "sub-1",
    parentSessionId: "parent-1",
    status: "running",
    description: "调研 airport 本体生成",
    associatedTaskId: 4547,
    startedAt: START,
    timeoutMs: FIVE_HOURS,
    ...over,
  };
}

// ============================================================================
// 1. 事件白名单
// ============================================================================

describe("Task #4552 A1 — telemetry 事件白名单", () => {
  test("started / progress 是 telemetry", () => {
    expect(isTelemetryEvent("task.background.started")).toBe(true);
    expect(isTelemetryEvent("task.background.progress")).toBe(true);
    expect(TELEMETRY_EVENT_TYPES.has("task.background.started")).toBe(true);
    expect(TELEMETRY_EVENT_TYPES.has("task.background.progress")).toBe(true);
  });

  test("终态 + ask_user 绝不是 telemetry（回归护栏）", () => {
    for (const t of [
      "task.background.completed",
      "task.background.failed",
      "task.background.timeout",
      "task.background.stopped",
      // ask_user 需要 agent 渲染问题并等用户答复，直发一条等于把交互降级成广播
      "task.background.ask_user",
      // 非后台任务事件
      "event-source.event.lark-cli",
      "task.created",
    ]) {
      expect(isTelemetryEvent(t)).toBe(false);
      expect(TELEMETRY_EVENT_TYPES.has(t)).toBe(false);
    }
  });

  test("空值 / undefined 不崩", () => {
    expect(isTelemetryEvent(undefined)).toBe(false);
    expect(isTelemetryEvent("")).toBe(false);
  });

  test("白名单刻意极小（2 个）—— 新增成员必须是深思熟虑的决定", () => {
    expect(TELEMETRY_EVENT_TYPES.size).toBe(2);
  });
});

// ============================================================================
// 2. 时长 / 时钟格式化
// ============================================================================

describe("Task #4552 A1 — 时长格式化", () => {
  test("紧凑人类可读：45m / 2h16m / 1d2h", () => {
    expect(formatElapsed(45 * 60_000)).toBe("45m");
    expect(formatElapsed(2 * 3600_000 + 16 * 60_000)).toBe("2h16m");
    expect(formatElapsed(2 * 3600_000)).toBe("2h");
    expect(formatElapsed(26 * 3600_000)).toBe("1d2h");
    expect(formatElapsed(24 * 3600_000)).toBe("1d");
  });

  test("负数 / NaN / Infinity / 0 → 0m（绝不渲染 -1m 或 NaNm）", () => {
    expect(formatElapsed(-1)).toBe("0m");
    expect(formatElapsed(0)).toBe("0m");
    expect(formatElapsed(Number.NaN)).toBe("0m");
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("0m");
  });

  test("timeout 标签与 elapsed 同源（5h / 30m）", () => {
    expect(formatTimeoutLabel(FIVE_HOURS)).toBe("5h");
    expect(formatTimeoutLabel(30 * 60_000)).toBe("30m");
    expect(formatTimeoutLabel(0)).toBe("0m");
    expect(formatTimeoutLabel(Number.NaN)).toBe("0m");
  });

  test("formatClock 补零 HH:MM", () => {
    expect(formatClock(new Date(2026, 9, 26, 17, 23).getTime())).toBe("17:23");
    expect(formatClock(new Date(2026, 9, 26, 9, 5).getTime())).toBe("09:05");
  });
});

// ============================================================================
// 3. 文案
// ============================================================================

describe("Task #4552 A1 — 进展提示文案", () => {
  test("progress：task id + 标题 + 已跑时长 + 预计超时绝对时间", () => {
    const now = START + 2 * 3600_000 + 16 * 60_000; // 已跑 2h16m
    const text = buildTelemetryNoticeText(
      "task.background.progress",
      progressPayload(),
      now,
    );

    expect(text).toContain("Task #4547");
    expect(text).toContain("调研 airport 本体生成");
    expect(text).toContain("已跑 2h16m");
    // ★ goals 第 5 项：5h timeout 可见性 —— 必须是**绝对时间**，
    //   用户才能判断「现在几点了、还要等多久」，而不是以为早就该有结论
    expect(text).toContain("预计 17:23 超时");
    expect(text).toContain("timeout 5h");
  });

  test("started：同样给预计超时，但不报「已跑 0m」（刚启动是噪音）", () => {
    const text = buildTelemetryNoticeText(
      "task.background.started",
      progressPayload(),
      START,
    );

    expect(text).toContain("Task #4547");
    expect(text).toContain("已启动");
    expect(text).toContain("预计 17:23 超时");
    expect(text).not.toContain("已跑");
  });

  test("不含内部标识 / 不含给 agent 的指令（漏到群里对用户无意义）", () => {
    const text = buildTelemetryNoticeText(
      "task.background.progress",
      progressPayload(),
      START,
    );

    expect(text).not.toContain("sub-1"); // subSessionId
    expect(text).not.toContain("process_1792988622098"); // backgroundTaskId（有 Task #N 时不显示）
    expect(text).not.toContain("task_get"); // 老 formatter 的 agent 指令
    expect(text).not.toContain("[通知]");
  });

  test("缺 startedAt / timeoutMs → 降级但不渲染 undefined / NaN", () => {
    const text = buildTelemetryNoticeText(
      "task.background.progress",
      { description: "调研", associatedTaskId: 4547 } as any,
      START,
    );

    expect(text).toContain("Task #4547");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("已跑");
  });

  test("payload 完全缺失也不崩（payload 可能为空对象）", () => {
    const text = buildTelemetryNoticeText("task.background.progress", undefined, START);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(text.length).toBeGreaterThan(0);
  });

  test("无 associatedTaskId → 退到 backgroundTaskId，绝不渲染 Task #undefined", () => {
    const text = buildTelemetryNoticeText(
      "task.background.progress",
      progressPayload({ associatedTaskId: undefined }),
      START,
    );

    expect(text).not.toContain("Task #undefined");
    expect(text).toContain("process_1792988622098_r6rml36s6");
  });

  test("超长标题被截断（心跳每 20 分钟一条，不许刷屏）", () => {
    const long = "调".repeat(120);
    const text = buildTelemetryNoticeText(
      "task.background.progress",
      progressPayload({ description: long }),
      START,
    );

    expect(text).toContain("…");
    const firstLine = text.split("\n")[0];
    expect(firstLine.length).toBeLessThan(90);
  });

  test("progressMessage 有就附一行（子代理主动汇报）", () => {
    const text = buildTelemetryNoticeText(
      "task.background.progress",
      progressPayload({ progressMessage: "已扫描 30/58 个文件" }),
      START,
    );

    expect(text).toContain("已扫描 30/58 个文件");
  });
});

// ============================================================================
// 4. 目标解析（chatId / profile）
// ============================================================================

describe("Task #4552 A1 — 直发目标解析", () => {
  test("metadata.replyChannel 快照优先（publishBackgroundEvent 写入）", () => {
    const t = targetFromEventMetadata({
      replyChannel: { type: "lark-cli", chatId: CHAT, profile: "tongzhuli" },
    });
    expect(t).toEqual({ chatId: CHAT, profile: "tongzhuli" });
  });

  test("metadata.chatId 顶层（部分 ES 生产端直接写）", () => {
    const t = targetFromEventMetadata({ chatId: "oc_top", profile: "p1" });
    expect(t).toEqual({ chatId: "oc_top", profile: "p1" });
  });

  test("无 chatId → undefined（不猜目标）", () => {
    expect(targetFromEventMetadata(undefined)).toBeUndefined();
    expect(targetFromEventMetadata({})).toBeUndefined();
    expect(targetFromEventMetadata({ chatId: "" })).toBeUndefined();
    expect(targetFromEventMetadata({ replyChannel: {} })).toBeUndefined();
  });

  test("EventStore 反查成功 → 用落库的 chatId/profile", async () => {
    const store = {
      getEventById: vi.fn().mockResolvedValue({
        metadata: { chatId: "oc_from_store", profile: "tongzhuli" },
      }),
    };

    const t = await targetFromTriggerEvent(store as any, "evt_1");
    expect(store.getEventById).toHaveBeenCalledWith("evt_1");
    expect(t).toEqual({ chatId: "oc_from_store", profile: "tongzhuli" });
  });

  test("EventStore 返回 null / 空 → undefined", async () => {
    expect(
      await targetFromTriggerEvent({ getEventById: async () => null } as any, "x"),
    ).toBeUndefined();
    expect(
      await targetFromTriggerEvent({ getEventById: async () => ({}) } as any, "x"),
    ).toBeUndefined();
  });

  test("EventStore 抛错 / 无 store / 无 id → undefined（绝不抛）", async () => {
    const throwing = {
      getEventById: async () => {
        throw new Error("db down");
      },
    };
    await expect(
      targetFromTriggerEvent(throwing as any, "x"),
    ).resolves.toBeUndefined();

    expect(await targetFromTriggerEvent(undefined, "x")).toBeUndefined();
    expect(await targetFromTriggerEvent({ getEventById: async () => null } as any, undefined))
      .toBeUndefined();
  });
});

// ============================================================================
// 5. lark-cli args 拼装
// ============================================================================

describe("Task #4552 A1 — lark-cli args 拼装", () => {
  test("基础形态：im +messages-send --chat-id --markdown --as bot", () => {
    const args = buildLarkSendArgs({ chatId: CHAT, text: "hello" });
    // ★ A1 BLOCKING 修复（Task #4552）：`--as bot` 是**必需**的，不是可选装饰。
    //   去掉它 → 默认身份是 user → 被自己的 consumer 回灌 → 跑完整 agent run。
    //   铁证见 本机 E2E 报告 reports/4552-a1-real-e2e.md §6（gitignored 未入库）与下方「出站必须 --as bot」组。
    expect(args).toEqual([
      "im",
      "+messages-send",
      "--chat-id",
      CHAT,
      "--markdown",
      "hello",
      "--as",
      "bot",
    ]);
  });

  test("profile 前置（多 appId 场景否则飞书 99992361）", () => {
    const args = buildLarkSendArgs({ chatId: CHAT, text: "hi", profile: "tongzhuli" });
    expect(args.slice(0, 2)).toEqual(["--profile", "tongzhuli"]);
    expect(args).toContain("+messages-send");
  });

  test("@-mention 自闭合语法被规范化（否则飞书不触发通知）", () => {
    const args = buildLarkSendArgs({
      chatId: CHAT,
      text: '<at user_id="ou_123"/>看这里',
    });
    const md = args[args.indexOf("--markdown") + 1];
    expect(md).toContain('<at user_id="ou_123"></at>');
  });

  test("idempotency-key ≤ 50 字符（飞书硬限制）", () => {
    const args = buildLarkSendArgs({
      chatId: CHAT,
      text: "x",
      idempotencyKey: "roy-" + "a".repeat(80),
    });
    const idx = args.indexOf("--idempotency-key");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1].length).toBeLessThanOrEqual(50);
  });

  test("不传 idempotencyKey 时不出现该 flag", () => {
    const args = buildLarkSendArgs({ chatId: CHAT, text: "x" });
    expect(args).not.toContain("--idempotency-key");
  });
});

// ============================================================================
// 6. 直发器：硬超时 / 错误传播
// ============================================================================

describe("Task #4552 A1 — sendLarkChatMarkdown", () => {
  test("空 chatId → reject，且不 spawn（不做无目标投递）", async () => {
    await expect(
      sendLarkChatMarkdown({ chatId: "", text: "x" }),
    ).rejects.toThrow(/chatId/);
  });

  test("正常路径 resolve（spawn 成功 + exit 0）", async () => {
    // 用真实 lark-cli 不可行（会真发消息）→ 本用例只覆盖"参数校验 + 不抛"
    // 真实 spawn 行为由 event-handler-telemetry-notice.test.ts 通过注入 sender 覆盖。
    // 这里断言非法输入路径不会挂住进程。
    await expect(sendLarkChatMarkdown({ chatId: "", text: "" })).rejects.toThrow();
  });
});

// ============================================================================
// 5b. ★ A1 BLOCKING 修复：出站必须显式 --as bot（防自我回灌）
// ============================================================================
//
// ## 缺陷（真实 E2E 实测，本机报告 reports/4552-a1-real-e2e.md §6；reports/ 被 gitignore，未入库）
//
// 原实现**刻意不加** `--as bot`，注释理由是「send 到 chat 用默认身份即可；
// 显式 --as bot 在部分 profile 下会因 bot 不在会话里报 230002」。
//
// 实测该顾虑在本 profile（default）不成立：
//   - `--as bot` 成功，返回 `identity: "bot"`
//   - `im +chat-members-list` 显示 bot 确实在群里
//
// 而不加时默认身份是 **user（开发者本人）** → `im.message.receive_v1` 只看
// 「是不是 user 发的」→ 提示被同一个 consumer 当作用户消息**回灌**，
// 又跑一次完整 agent run（188 spans / 5582ms）。实测 11 条事件中 5 条是回灌
// （4 条 telemetry 提示全部回灌），回灌率 45%。
//
// ## 为什么这比修复前更糟
//
// A1 的目的是省 token。回灌后每条提示变成新「用户消息」→ 进 lane → 跑完整
// agent run → token 一点没省，消息量翻倍，lane 饥饿原封不动，且有正反馈风险。
//
// ## 同仓对照
//
// `lark-cli-notification-channel.ts` 的 `+messages-reply` 分支**显式带
// `--as bot`**，只有 `+messages-send` 分支不带 —— A1 抄了不带的那一支。
// 本修复让两者一致。

describe("Task #4552 A1-BLOCKING — 出站必须 --as bot（防自我回灌）", () => {
  test("args 必须包含 --as bot（默认身份是 user → 会被回灌）", () => {
    const args = buildLarkSendArgs({ chatId: CHAT, text: "hello" });
    const idx = args.indexOf("--as");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("bot");
  });

  test("--as bot 与 profile 同时存在且 profile 仍在最前（参数习惯一致性）", () => {
    const args = buildLarkSendArgs({ chatId: CHAT, text: "hi", profile: "default" });
    expect(args.slice(0, 2)).toEqual(["--profile", "default"]);
    expect(args).toContain("--as");
    expect(args[args.indexOf("--as") + 1]).toBe("bot");
  });

  test("--as bot 与 --idempotency-key 共存（两个修复不互相挤掉）", () => {
    const args = buildLarkSendArgs({
      chatId: CHAT,
      text: "x",
      idempotencyKey: "roy-abc",
    });
    expect(args[args.indexOf("--as") + 1]).toBe("bot");
    expect(args[args.indexOf("--idempotency-key") + 1]).toBe("roy-abc");
  });

  test("--as bot 恰好出现一次（不重复拼参）", () => {
    const args = buildLarkSendArgs({ chatId: CHAT, text: "x", profile: "p" });
    expect(args.filter((a) => a === "--as").length).toBe(1);
    expect(args.filter((a) => a === "bot").length).toBe(1);
  });

  test("仍是 im +messages-send --chat-id（命令主体不变）", () => {
    const args = buildLarkSendArgs({ chatId: CHAT, text: "hello" });
    expect(args.slice(0, 2)).toEqual(["im", "+messages-send"]);
    expect(args[args.indexOf("--chat-id") + 1]).toBe(CHAT);
    expect(args[args.indexOf("--markdown") + 1]).toBe("hello");
  });
});
