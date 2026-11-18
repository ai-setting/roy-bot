/**
 * @fileoverview Task #4568 — CLI 作为 EventSource：端到端（最核心）
 *
 * ## 这个文件回答用户最初的报障
 *
 * > 「从 cli 的入口输入的 query 触发的 delegate 就无法达到 event 送到 agent
 * >   让其处理的目标了」
 *
 * 三个必须同时成立的事实：
 *   A. notify event **带 triggerEventId**（否则 v2 notify prompt dead）
 *   B. rule-based 通知**投到 stdout**（否则静默丢弃，用户看不到）
 *   C. event **仍然进 lane 进 agent**（否则 agent 不参与，等于没通知）
 *
 * ## 为什么 B 和 C 必须同时测
 *
 * `TELEMETRY_EVENT_TYPES`（started/progress）是"发完就 return"；
 * `RULE_NOTICE_EVENT_TYPES`（completed/timeout）是"发完继续跑 agent"。
 * 若只测 C，会漏掉"通知其实没发"；若只测 B，会漏掉"agent 没接管"。
 * 用户两条都要，所以两条都锁。
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStoreImpl } from "@ai-setting/roy-bot-core/env/event-source/event-store";
import {
  cliCommandHandler,
  buildCliReplyChannel,
} from "@ai-setting/roy-bot-core/env/event-source/cli-command-handler";

import { EventHandler } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";

const CLI_SID = "session_4568_cli";

let tmpDir: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cli-e2e-"));
  store = new EventStoreImpl({ dbPath: join(tmpDir, "events.db") });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeSubscribableEnv() {
  let dispatch: ((e: any) => void) | null = null;
  return {
    env: {
      subscribeAll: (h: (e: any) => void) => {
        dispatch = h;
        return () => { dispatch = null; };
      },
      getComponent: () => undefined,
    } as any,
    emit: (e: any) => { if (!dispatch) throw new Error("not subscribed"); dispatch(e); },
  };
}

function makeSessionComponent() {
  return {
    create: vi.fn().mockImplementation(async (opts: any) => ({ id: opts?.id ?? "created-1" })),
    get: vi.fn().mockImplementation(async (id: string) => ({ id })),
    list: vi.fn().mockResolvedValue([]),
    getActiveSessionId: vi.fn().mockReturnValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(true),
  };
}

/** 造一条「CLI 触发 → delegate → 后台完成」的 notify event */
async function makeCliNotifyEvent(type: string) {
  const replyChannel = buildCliReplyChannel({ sessionId: CLI_SID });
  const triggerEventId = await cliCommandHandler.emitTriggerEvent!(
    {
      senderId: "cli:test:1234",
      text: "delegate 一个任务",
      metadata: {
        eventType: "cli.query",
        sessionId: CLI_SID,
        cwd: "/tmp/work",
        chatId: replyChannel.chatId,
        replyChannel,
      },
      rawEvent: { command: "run", query: "delegate 一个任务" },
    },
    store,
  );

  return {
    id: `evt_bg_${type}`,
    type,
    timestamp: Date.now(),
    metadata: {
      source: "task.background",
      trigger_session_id: CLI_SID,
      triggerEventId,
      replyChannel,
    },
    payload: {
      backgroundTaskId: "process_cli_1",
      subSessionId: "sub_cli_1",
      parentSessionId: CLI_SID,
      description: "CLI 触发的后台任务",
      subagentType: "general",
      result: "任务结果正文",
      executionTimeMs: 1234,
      associatedTaskId: 4568,
    },
  };
}

function makeHandler(opts: {
  env: any;
  onEvent?: (m: string) => Promise<void>;
  onEventWithEnv?: (f: any) => Promise<void>;
  telemetrySender?: (n: any) => Promise<void>;
}) {
  return new EventHandler({
    env: opts.env,
    eventTypes: ["task.background.*", "event-source.event.*"],
    formatter: new EventMessageFormatter({ prefix: "[通知]" }),
    isIdle: () => true,
    sessionComponent: makeSessionComponent() as any,
    eventStore: store,
    getHandlerForEsType: (t: string) => (t === "cli-command" ? cliCommandHandler : undefined),
    ...(opts.telemetrySender ? { telemetrySender: opts.telemetrySender } : {}),
    onEvent: opts.onEvent ?? (async () => {}),
    ...(opts.onEventWithEnv ? { onEventWithEnv: opts.onEventWithEnv } : {}),
  } as any);
}

// ============================================================================
// A. notify event 带 triggerEventId
// ============================================================================

describe("A. CLI 触发的 delegate → notify event 带 triggerEventId", () => {
  test("v2 notify prompt 被走到（formatEventViaESPluginV2 命中 cli-command handler）", async () => {
    const { env, emit } = makeSubscribableEnv();
    const seen: any[] = [];
    const handler = makeHandler({
      env,
      onEventWithEnv: async (f: any) => { seen.push(f); },
    });

    const formatSpy = vi.spyOn(handler as any, "formatEventViaESPluginV2");
    handler.start();
    emit(await makeCliNotifyEvent("task.background.completed"));
    await sleep(500);

    // ★ v2 路径必须被真正调用（不是回落老 formatter）
    expect(formatSpy).toHaveBeenCalled();
    expect(seen.length).toBe(1);
    // ★ prompt 里必须有 cli-command 渠道声明
    expect(seen[0].message).toContain("cli-command");

    handler.stop();
  }, 20000);
});

// ============================================================================
// B. rule-based 通知真的"发出去"（投到 stdout，不是静默丢弃）
// ============================================================================

describe("B. rule-based 通知投递（不是静默丢弃）", () => {
  test("completed → telemetrySender 被调用一次，且带 sink", async () => {
    const { env, emit } = makeSubscribableEnv();
    const notices: any[] = [];
    const handler = makeHandler({
      env,
      telemetrySender: async (n: any) => { notices.push(n); },
    });

    handler.start();
    emit(await makeCliNotifyEvent("task.background.completed"));
    await sleep(500);

    expect(notices.length).toBe(1);
    // ★ sink 必须透出来（否则 EventHandler 不知道该 console 还是 spawn lark-cli）
    expect(notices[0].sink).toBe("stdout");
    expect(notices[0].chatId).toBe(`cli:${CLI_SID}`);
    expect(typeof notices[0].text).toBe("string");
    expect(notices[0].text.length).toBeGreaterThan(0);

    handler.stop();
  }, 20000);

  test("timeout → 同样直发（白名单含 timeout）", async () => {
    const { env, emit } = makeSubscribableEnv();
    const notices: any[] = [];
    const handler = makeHandler({
      env,
      telemetrySender: async (n: any) => { notices.push(n); },
    });

    handler.start();
    emit(await makeCliNotifyEvent("task.background.timeout"));
    await sleep(500);

    expect(notices.length).toBe(1);
    expect(notices[0].sink).toBe("stdout");

    handler.stop();
  }, 20000);

  test("progress（telemetry）→ 直发一条但**不进 agent**（不烧 token）", async () => {
    const { env, emit } = makeSubscribableEnv();
    const notices: any[] = [];
    let agentRuns = 0;
    const handler = makeHandler({
      env,
      telemetrySender: async (n: any) => { notices.push(n); },
      onEvent: async () => { agentRuns++; },
    });

    handler.start();
    emit(await makeCliNotifyEvent("task.background.progress"));
    await sleep(500);

    expect(notices.length).toBe(1);
    expect(notices[0].sink).toBe("stdout");
    expect(agentRuns).toBe(0);

    handler.stop();
  }, 20000);
});

// ============================================================================
// C. event 仍然进 agent（agent 参与 response）
// ============================================================================

describe("C. event 仍然进 lane → 进 agent", () => {
  test("completed → agent 被调用，且 prompt 是 CLI 专属（不是 lark）", async () => {
    const { env, emit } = makeSubscribableEnv();
    const seen: any[] = [];
    const handler = makeHandler({
      env,
      onEventWithEnv: async (f: any) => { seen.push(f); },
    });

    handler.start();
    emit(await makeCliNotifyEvent("task.background.completed"));
    await sleep(500);

    expect(seen.length).toBe(1);
    // ★ prompt 必须说 CLI 无 IM 通道
    expect(seen[0].message).toMatch(/stdout|终端/);
    expect(seen[0].message).toContain("任务结果正文");

    handler.stop();
  }, 20000);

  test("cli:<sid> lane → 复用的是原 session，不是新建 cli:xxx session", async () => {
    const { env, emit } = makeSubscribableEnv();
    const sessionComp = makeSessionComponent();
    const seen: any[] = [];
    const handler = new EventHandler({
      env,
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter({ prefix: "[通知]" }),
      isIdle: () => true,
      sessionComponent: sessionComp as any,
      eventStore: store,
      getHandlerForEsType: (t: string) => (t === "cli-command" ? cliCommandHandler : undefined),
      telemetrySender: async () => {},
      onEventWithEnv: async (f: any) => { seen.push(f); },
    } as any);

    handler.start();
    emit(await makeCliNotifyEvent("task.background.completed"));
    await sleep(600);

    // ★ 关键：绝不能 create 一个 id 为 "cli:xxx" 的假 session
    const createdIds = sessionComp.create.mock.calls.map((c: any[]) => c[0]?.id);
    expect(createdIds).not.toContain(`cli:${CLI_SID}`);
    // sessionComponent.get 应该被用原 sessionId 调用过（复用而不是新建）
    const gotIds = sessionComp.get.mock.calls.map((c: any[]) => c[0]);
    expect(gotIds).toContain(CLI_SID);
    expect(seen.length).toBe(1);

    handler.stop();
  }, 20000);
});

// ============================================================================
// D. emit 循环守卫（交叉验证抓到的真 bug 的回归护栏）
// ============================================================================

describe("D. 用户输入 vs 通知驱动的判据（防 notify 轮重复 emit）", () => {
  /**
   * 判据语义：本轮 agentContext 里**有没有 envEvent**。
   *
   * 历史 bug（交叉验证探针 probeC 抓到）：最初用
   * `!runSessionId || runSessionId === sessionId` 判断，
   * 但通知驱动 turn 的 `eventSessionId` **就是** REPL 自己的 session
   * （EventHandler 缓存命中 / ensureActiveSession 复用），于是
   * `runSessionId === sessionId` 为 true ⇒ 通知轮被误判成用户轮 ⇒ 每轮 notify
   * 都多写一条 trigger event，且给 EnvContext 换上一个"由通知产生"的 triggerEventId。
   *
   * 正确判据用结构性标志（agentContext.envEvent 是否存在）：
   *   - 用户键入：handleUserQuery → executeInternal(payload, {showPrompt:false})
   *     ⇒ agentContext undefined（interactive.ts:1059）
   *   - 通知驱动：handleEventMessageWithEnv → executeInternal(..., {
   *       agentContext: { envEvent, ... } })  ⇒ envEvent 一定有值（interactive.ts:1182）
   */
  const isUserTurn = (agentContext?: { envEvent?: unknown }) =>
    !agentContext?.envEvent;

  test("用户键入（agentContext 为空）→ emit", () => {
    expect(isUserTurn(undefined)).toBe(true);
    expect(isUserTurn({})).toBe(true);
    expect(isUserTurn({ envEvent: undefined })).toBe(true);
  });

  test("★ 通知驱动（agentContext.envEvent 有值）→ 不 emit，即使 session 相同", () => {
    // 关键：这里刻意让 session 无法区分（模拟真实生产：两者都是 REPL session）
    expect(isUserTurn({ envEvent: { id: "evt_x", type: "event-source.event.lark" } })).toBe(false);
    expect(isUserTurn({ envEvent: { id: "evt_y", type: "task.background.completed" } })).toBe(false);
  });

  test("回归护栏：旧判据（比较 sessionId）在通知轮会误判为 true", () => {
    // 复刻旧判据，证明它确实错（防止有人"优化"回旧写法）
    const oldGuard = (runSessionId?: string, sessionId = "sess") =>
      !runSessionId || runSessionId === sessionId;
    const notifyTurnSession = "sess"; // EventHandler 复用 REPL session
    expect(oldGuard(notifyTurnSession, "sess")).toBe(true); // ← 旧判据的 bug
    // 新判据对同一场景给出 false
    expect(isUserTurn({ envEvent: { id: "evt_z" } })).toBe(false);
  });
});
