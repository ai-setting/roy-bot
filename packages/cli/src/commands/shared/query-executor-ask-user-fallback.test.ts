/**
 * @fileoverview Task #4983 — QueryExecutor 的 ask_user 兜底投递（接线测试）
 *
 * ## 背景（生产日志铁证）
 *
 * traceId `01a1a68652ee79c9c6508579b504e662`（2026-11-04 20:55:38 → 20:56:09，
 * 飞书 p2p `oc_9406ee012e5b7ae65a7a83314b2f8fbc`）：
 *
 *   20:55:38.788  [BackgroundTaskManager] Event published: task.background.ask_user
 *                  （triggerEventId + replyChannel 都齐 ✅ —— #3147 的 notify 链路完好）
 *   20:55:38.790  cli.query-executor.execute enter: "[通知] ❓ 后台子代理「…」请求用户输入 …"
 *   20:56:09.513  [agent:component] Iteration 1 error
 *                  {runId:"unknown", nodeId:"unknown", type:"ask-user", name:"AskUserError"}
 *   20:56:09.517  cli.query-executor.execute error: __ASK_USER_ERROR__:{…}
 *   ⇒ 此后该 traceId **0 次** lark messages-send / messages-reply
 *
 * 根因：`query-executor.ts` 原本对 AskUserError 直接 `return`（不当失败处理）
 * ⇒ headless 场景没人接 ⇒ 问题正文从未离开进程 ⇒ 用户零感知。
 *
 * ## 本文件的契约（CLI 层 = 最后一层网）
 *
 * 1. AskUserError（`delivered:false`，工具层没投成）→ 兜底投递器被调用**一次**
 * 2. AskUserError（`delivered:true`，工具层已投过）→ 兜底投递器**不被调用**（防双发）
 * 3. 非 AskUserError → 兜底投递器不被调用（那是失败回执的职责）
 * 4. 原始错误必须照旧向上抛（兜底不能吞错误）
 * 5. 兜底投递器自身抛错 → 不影响原始错误传播
 * 6. 投递器拿到本轮的 envEvent（用于定位 replyChannel）
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// 注入假投递器（用 QueryExecutorOptions.askUserNotifier 注入点 ——
// Bun 的 vi.mock 不支持 importOriginal，无法只覆盖单个导出）
// ---------------------------------------------------------------------------
const mockAskUserNotifier = vi.fn(async () => {});

import { QueryExecutor } from "./query-executor";
import { OutputService } from "../../services/output.service";
import { resetStreamAbort } from "../../services/stream-output.service";

const REPLY_CHANNEL = {
  type: "lark-cli",
  chatId: "oc_4983_chat",
  messageId: "om_4983_msg",
  profile: "tongzhuli",
};

/** 构造一个带 __ASK_USER_ERROR__ 前缀的 error（core 侧 agent-component 的编码形态） */
function makeAskUserError(query: string, delivered: boolean): Error {
  const payload = JSON.stringify({
    query,
    sessionId: "session_sub",
    nodeId: "unknown",
    nodeType: "agent",
    agentSessionId: undefined,
    delivered,
  });
  const err = new Error(`__ASK_USER_ERROR__:${payload}`);
  (err as any).name = "AskUserError";
  (err as any).type = "ask-user";
  return err;
}

function buildExecutor(opts: {
  handleQueryImpl: () => Promise<string>;
  quiet?: boolean;
}) {
  const mockEnv: any = {
    subscribeTo: vi.fn().mockReturnValue(vi.fn()),
    getComponent: vi.fn(),
    handle_query: vi.fn(opts.handleQueryImpl),
    pushEnvEvent: vi.fn(),
  };

  const output = new OutputService();
  output.configure({ quiet: opts.quiet ?? true });

  const qe = new QueryExecutor({
    env: mockEnv,
    sessionComponent: { setSummaryComponents: vi.fn() } as any,
    output,
    quiet: opts.quiet ?? true,
    failureNotifier: vi.fn(async () => ({
      sent: true,
      kind: "upstream_retry" as const,
      info: {
        kind: "upstream_retry" as const,
        title: "t",
        reason: "r",
        retryable: true,
      },
    })),
    askUserNotifier: (args) => mockAskUserNotifier(args),
  });

  return { qe, mockEnv };
}

/** 飞书事件形态的 agentContext */
function larkAgentContext(envEvent: any = {
  type: "event-source.event.lark.message",
  metadata: { replyChannel: REPLY_CHANNEL },
}) {
  return {
    envEvent,
    eventSessionId: "session_lark_4983",
  };
}

describe("#4983 QueryExecutor — ask_user 兜底投递", () => {
  beforeEach(() => {
    resetStreamAbort();
    mockAskUserNotifier.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // ------------------------------------------------------------------
  // 契约 1：工具层没投成 → 兜底投递一次
  // ------------------------------------------------------------------
  test("契约1: AskUserError(delivered=false) → 兜底投递器被调用一次", async () => {
    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw makeAskUserError("请确认是否继续？", false);
      },
    });

    await expect(
      qe.execute("q", "session_lark_4983", {}, undefined, larkAgentContext()),
    ).rejects.toThrow();

    expect(mockAskUserNotifier).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // 契约 2：工具层已投过 → 兜底**不**投（防用户收到两条）
  // ------------------------------------------------------------------
  test("契约2: AskUserError(delivered=true) → 兜底投递器不被调用（防双发）", async () => {
    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw makeAskUserError("请确认是否继续？", true);
      },
    });

    await expect(
      qe.execute("q", "session_lark_4983", {}, undefined, larkAgentContext()),
    ).rejects.toThrow();

    expect(mockAskUserNotifier).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 契约 3：非 AskUserError → 不走兜底（那是失败回执的职责）
  // ------------------------------------------------------------------
  test("契约3: 非 AskUserError → 兜底投递器不被调用", async () => {
    const err = new Error("Failed after 4 attempts. Last error: upstream down.");
    (err as any).name = "AI_RetryError";

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw err;
      },
    });

    await expect(
      qe.execute("q", "session_lark_4983", {}, undefined, larkAgentContext()),
    ).rejects.toThrow();

    expect(mockAskUserNotifier).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 契约 4：原始错误必须照旧向上抛
  // ------------------------------------------------------------------
  test("契约4: 原始 AskUserError 继续向上抛（兜底不能吞错误）", async () => {
    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw makeAskUserError("原始问题", false);
      },
    });

    const err = await qe
      .execute("q", "session_lark_4983", {}, undefined, larkAgentContext())
      .then(() => null)
      .catch((e) => e);

    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toContain("__ASK_USER_ERROR__");
  });

  // ------------------------------------------------------------------
  // 契约 5：兜底投递器自身抛错 → 不影响原始错误传播
  // ------------------------------------------------------------------
  test("契约5: 兜底投递器抛错时原始错误仍照旧传播", async () => {
    mockAskUserNotifier.mockImplementationOnce(async () => {
      throw new Error("lark-cli spawn failed");
    });

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw makeAskUserError("原始问题", false);
      },
    });

    const err = await qe
      .execute("q", "session_lark_4983", {}, undefined, larkAgentContext())
      .then(() => null)
      .catch((e) => e);

    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toContain("__ASK_USER_ERROR__");
  });

  // ------------------------------------------------------------------
  // 契约 6：投递器拿到本轮 envEvent（用于定位 replyChannel）
  // ------------------------------------------------------------------
  test("契约6: 兜底投递器拿到本轮的 envEvent 与问题正文", async () => {
    const envEvent = {
      type: "event-source.event.lark.message",
      metadata: { replyChannel: REPLY_CHANNEL },
    };

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw makeAskUserError("问题正文 ABC", false);
      },
    });

    await qe
      .execute("q", "session_lark_4983", {}, undefined, larkAgentContext(envEvent))
      .catch(() => undefined);

    const [call] = mockAskUserNotifier.mock.calls;
    expect(call[0].envEvent).toEqual(envEvent);
    expect(call[0].query).toContain("问题正文 ABC");
    expect(call[0].delivered).toBe(false);
  });
});
