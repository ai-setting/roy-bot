/**
 * @fileoverview Task #4418: QueryExecutor 异常路径的飞书兜底回复（接线测试）
 *
 * 单元测试（`packages/core/src/env/error-reply.test.ts`）证明了
 * `notifyReactFailure` 本身工作；**本文件证明它被真正接进了执行链**。
 *
 * ## 为什么接在 QueryExecutor.execute
 *
 * `QueryExecutor.execute()` 是**唯一**的执行入口，三个调用方全都经过它：
 *
 * | 调用方 | 文件:行 | 场景 |
 * |---|---|---|
 * | interactive REPL | `commands/run.ts` | 本地交互 + 飞书事件（`handleEventMessageWithEnv`） |
 * | run 非流式 | `interactive.ts:215` | `roy-bot run` 的 handleQuery |
 * | run 流式 TUI | `interactive.ts:393` | `roy-bot run` 的 streamHandleQuery |
 *
 * 接在这里比接 `run.ts` / `RunTui.tsx` 更好：
 * - 一处覆盖三种运行模式（尤其 `run --es` = 用户当前生产进程）
 * - 位于 `ContextHandlerService`（已处理 context compact retry）**下游**，
 *   只兜底真正救不回来的失败，不会跟 ContextError 的重试/压缩逻辑打架
 * - 不依赖 REPL 的 `currentAgentContext` 私有状态
 *
 * ## 契约
 *
 * 1. 失败 → `notifyReactFailure` 被调用一次，带原始 error + 本次的 envEvent
 * 2. 成功 → 不调用
 * 3. AskUserError（正常交互流，不是失败）→ 不调用
 * 4. **原始错误必须照旧向上抛**（兜底 reply 不能吞掉错误）
 * 5. reply 自身失败 → 不影响错误传播
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// 注入假通知器（不走 vi.mock —— Bun 的 vi.mock 不支持 importOriginal，
// 无法只覆盖单个导出；改用 QueryExecutorOptions.failureNotifier 注入点）
// ---------------------------------------------------------------------------
const mockNotify = vi.fn(async () => ({
  sent: true,
  kind: "upstream_retry" as const,
  info: { kind: "upstream_retry" as const, title: "t", reason: "r", retryable: true },
}));

import { QueryExecutor } from "./query-executor";
import { OutputService } from "../../services/output.service";
import { resetStreamAbort } from "../../services/stream-output.service";

const RETRY_ERROR_MESSAGE =
  "Failed after 4 attempts. Last error: Upstream request failed: Endpoint is unavailable.";

const REPLY_CHANNEL = {
  type: "lark-cli",
  chatId: "oc_4418_chat",
  messageId: "om_4418_msg",
  profile: "tongzhuli",
};

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
    failureNotifier: (args) => mockNotify(args),
  });

  return { qe, mockEnv };
}

/** 飞书事件形态的 agentContext（handleEventMessageWithEnv 注入的样子） */
function larkAgentContext(envEvent: any = {
  type: "event-source.event.lark.message",
  metadata: { replyChannel: REPLY_CHANNEL },
}) {
  return {
    envEvent,
    eventSessionId: "session_lark_4418",
  };
}

describe("#4418 QueryExecutor — 异常路径飞书兜底回复", () => {
  beforeEach(() => {
    resetStreamAbort();
    mockNotify.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  test("RetryError 失败 → notifyReactFailure 被调用一次", async () => {
    const err = new Error(RETRY_ERROR_MESSAGE);
    (err as any).name = "AI_RetryError";

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw err;
      },
    });

    await expect(
      qe.execute("帮我分析下", "session_lark_4418", {}, undefined, larkAgentContext()),
    ).rejects.toThrow();

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test("notifyReactFailure 拿到原始 error 对象（不是字符串化后的）", async () => {
    const err = new Error(RETRY_ERROR_MESSAGE);
    (err as any).name = "AI_RetryError";

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw err;
      },
    });

    await qe
      .execute("q", "s", {}, undefined, larkAgentContext())
      .catch(() => undefined);

    const [call] = mockNotify.mock.calls;
    expect(call[0].error).toBe(err);
  });

  test("notifyReactFailure 拿到本次的 envEvent（= 用户要的「对应 triggerEvent」）", async () => {
    const envEvent = {
      type: "event-source.event.lark.message",
      metadata: { replyChannel: REPLY_CHANNEL },
    };

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw new Error(RETRY_ERROR_MESSAGE);
      },
    });

    await qe
      .execute("q", "s", {}, undefined, larkAgentContext(envEvent))
      .catch(() => undefined);

    const [call] = mockNotify.mock.calls;
    expect(call[0].envEvent).toEqual(envEvent);
  });

  test("原始 query 被传给 notifyReactFailure（用户能对上号）", async () => {
    const query = "帮我分析下 example-project 的 IMPLEMENTATION_ERROR";

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw new Error(RETRY_ERROR_MESSAGE);
      },
    });

    await qe
      .execute(query, "s", {}, undefined, larkAgentContext())
      .catch(() => undefined);

    expect(mockNotify.mock.calls[0][0].query).toBe(query);
  });

  test("★ 原始错误必须继续向上抛（兜底 reply 不能吞错误）", async () => {
    const err = new Error(RETRY_ERROR_MESSAGE);
    (err as any).name = "AI_RetryError";

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw err;
      },
    });

    let caught: unknown;
    try {
      await qe.execute("q", "s", {}, undefined, larkAgentContext());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(err);
  });

  test("成功路径 → 不调用 notifyReactFailure", async () => {
    const { qe } = buildExecutor({
      handleQueryImpl: async () => "执行成功",
    });

    const result = await qe.execute("q", "s", {}, undefined, larkAgentContext());

    expect(result).toBe("执行成功");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test("AskUserError（正常交互流，非失败）→ 不发失败 reply", async () => {
    const askErr = new Error(
      '__ASK_USER_ERROR__:{"query":"要继续吗","sessionId":"s"}',
    );
    (askErr as any).name = "AskUserError";

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw askErr;
      },
    });

    await qe
      .execute("q", "s", {}, undefined, larkAgentContext())
      .catch(() => undefined);

    expect(mockNotify).not.toHaveBeenCalled();
  });

  test("notifyReactFailure 自己抛错 → 不掩盖原始错误（best-effort）", async () => {
    mockNotify.mockImplementationOnce(async () => {
      throw new Error("notify exploded");
    });

    const original = new Error(RETRY_ERROR_MESSAGE);

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw original;
      },
    });

    let caught: unknown;
    try {
      await qe.execute("q", "s", {}, undefined, larkAgentContext());
    } catch (e) {
      caught = e;
    }

    // 仍然抛原始错误，不是 "notify exploded"
    expect(caught).toBe(original);
  });

  test("无 envEvent（本地 REPL / act）→ 仍然调用，交由内部判 no_channel", async () => {
    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw new Error(RETRY_ERROR_MESSAGE);
      },
    });

    await qe.execute("q", "s").catch(() => undefined);

    // 调用是统一的；「要不要发」交给 notifyReactFailure 内部判断
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0].envEvent).toBeUndefined();
  });

  test("task.background.* notify event 失败 → 也兜底（用 notify 自带的 replyChannel）", async () => {
    const notifyEnvEvent = {
      type: "task.background.failed",
      metadata: { replyChannel: { ...REPLY_CHANNEL, messageId: "om_notify" } },
    };

    const { qe } = buildExecutor({
      handleQueryImpl: async () => {
        throw new Error(RETRY_ERROR_MESSAGE);
      },
    });

    await qe
      .execute("q", "s", {}, undefined, larkAgentContext(notifyEnvEvent))
      .catch(() => undefined);

    expect(mockNotify.mock.calls[0][0].envEvent).toEqual(notifyEnvEvent);
  });
});
