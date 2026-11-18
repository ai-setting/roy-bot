/**
 * @fileoverview Task #4418: React 循环异常中断时必须给飞书发 reply
 *
 * ## 用户诉求（飞书 p2p 2026-10-21）
 *
 * > 我希望通过重试失败之后，这个失败导致的 react 中断，也需要找到对应的
 * > triggerEvent 构建 response 让飞书方知道（送一个 reply 哈）
 *
 * ## 报错原文
 *
 * ```
 * RetryError [AI_RetryError]: Failed after 4 attempts.
 * Last error: Upstream request failed: Endpoint is unavailable.
 * statusCode: 429
 * isRetryable: true
 * url: https://opencode.ai/inference/go/v1/chat/completions
 * model: deepseek-v4.1-flash
 * ```
 *
 * 上游 429 不是 roy-bot 的 bug；**异常中断后无 reply 才是**。
 *
 * ## 本文件锁定的契约
 *
 * 1. 任何异常（RetryError / ContextError / AbortError / 未知）都能被分类，
 *    并生成**人类可读**的中文原因（不是裸 stack trace）
 * 2. `classifyReactFailure` 必须能从**字符串化后**的错误消息识别 RetryError
 *    （因为 environment.ts:430 `throw new Error(result.error)` 会丢掉类型，
 *     真实调用链里拿到的往往只剩 message 文本）
 * 3. 有 replyChannel → spawn lark-cli 发 reply；无 replyChannel（本地 REPL）→ 静默跳过不崩
 * 4. 同一 triggerEvent 只回一次（去重）
 * 5. **best-effort**：spawn 失败 / 抛错都不得污染原始错误传播
 *
 * 与 #4410 的区别：#4410 是「没有 replyChannel」，本任务是「有 replyChannel
 * 但异常路径根本没走 reply」——不同 bug，静默黑洞的异常路径变种。
 */

import { describe, test, expect, beforeEach, vi } from "bun:test";
import { createChildProcessMockModule } from "../test-utils/child-process-mock";

// ---------------------------------------------------------------------------
// Mock node:child_process.spawn
//
// 用共享 factory 自省真实模块补齐**完整导出面**（Bun 走 ESM exports 语义）：
// 只给 spawn 会让任何静态 import exec / spawnSync… 的模块加载期 SyntaxError
// （Task #4420 —— 同进程跨文件泄漏，整个测试文件瞬间全红且报错指向别人）。
// ---------------------------------------------------------------------------
const mockSpawn = vi.fn();
vi.mock("node:child_process", () =>
  createChildProcessMockModule({
    spawn: (...args: any[]) => mockSpawn(...args),
  }),
);

/** 构造一个 ChildProcess-like 对象，能按需 emit close / error */
function buildFakeProc(opts: {
  exitCode?: number;
  stderr?: string;
  error?: Error;
  /** true = 永不 settle（模拟 lark-cli 卡死），用于验证硬超时 */
  hang?: boolean;
}) {
  const proc: any = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  const handlers: Record<string, (arg: any) => void> = {};
  proc.on = vi.fn((event: string, handler: (arg: any) => void) => {
    handlers[event] = handler;
    return proc;
  });

  if (opts.hang) return proc;

  queueMicrotask(() => {
    if (opts.stderr) {
      (proc.stderr.on as any).mock.calls.forEach(([_e, h]: any) =>
        h(Buffer.from(opts.stderr!)),
      );
    }
    if (opts.error) {
      handlers.error?.(opts.error);
    } else {
      handlers.close?.(opts.exitCode ?? 0);
    }
  });

  return proc;
}

// Import AFTER vi.mock so the module picks up the mocked spawn
import {
  classifyReactFailure,
  buildFailureReplyMarkdown,
  notifyReactFailure,
  getFailureRuleIds,
  __resetFailureReplyDedupForTest,
} from "./error-reply";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** RetryError 的 message 文本（environment.ts 字符串化后仅剩这个） */
const RETRY_ERROR_MESSAGE =
  'Failed after 4 attempts. Last error: Upstream request failed: Endpoint is unavailable.';

/** 带 originalError 的 RetryError 实例（type 信息完整） */
function makeRetryError(): Error {
  const err = new Error(RETRY_ERROR_MESSAGE, {
    cause: Object.assign(
      new Error("Upstream request failed: Endpoint is unavailable."),
      { statusCode: 429, isRetryable: true },
    ),
  });
  err.name = "AI_RetryError";
  return err;
}

/** 完整 replyChannel（飞书触发场景） */
const LARK_REPLY_CHANNEL = {
  type: "lark-cli",
  chatId: "oc_4418_chat",
  messageId: "om_4418_msg",
  profile: "tongzhuli",
};

/** 包成 EnvEvent（event-source.event.* 的标准形态） */
function makeEnvEvent(replyChannel: any = LARK_REPLY_CHANNEL) {
  return {
    type: "event-source.event.lark.message",
    metadata: { replyChannel },
    payload: {},
  };
}

// ---------------------------------------------------------------------------
// 1. classifyReactFailure — 错误分类 + 可读化
// ---------------------------------------------------------------------------

describe("#4418 classifyReactFailure", () => {
  test("RetryError（有原对象）→ upstream_retry，且原因可读", () => {
    const info = classifyReactFailure(makeRetryError());

    expect(info.kind).toBe("upstream_retry");
    // 标题/原因必须是中文可读文案，不是裸 stack trace
    expect(info.title.length).toBeGreaterThan(0);
    expect(info.reason.length).toBeGreaterThan(0);
    // 必须点出「重试」这件事，用户才知道不是自己写错了
    expect(info.title + info.reason).toContain("重试");
    // 不能把 stack trace 塞进来
    expect(info.reason).not.toContain("    at ");
    // 上游 429 是可重试的
    expect(info.retryable).toBe(true);
  });

  test("RetryError（类型丢失，只剩字符串化 message）→ 仍能识别为 upstream_retry", () => {
    // ★ 真实调用链：environment.ts:430 throw new Error(result.error)
    //   抛出来的是普通 Error，message 就是 hookCtx.error.message
    const stringified = new Error(RETRY_ERROR_MESSAGE);

    const info = classifyReactFailure(stringified);

    expect(info.kind).toBe("upstream_retry");
    expect(info.title + info.reason).toContain("重试");
  });

  test("429 / Endpoint is unavailable / rate limit 等上游特征词 → upstream_retry", () => {
    const cases = [
      "Upstream request failed: Endpoint is unavailable.",
      "rate limit exceeded (429)",
      "The service is temporarily unavailable",
      "ECONNRESET / socket hang up",
    ];

    for (const msg of cases) {
      const info = classifyReactFailure(new Error(msg));
      expect(info.kind).toBe("upstream_retry");
      expect(info.retryable).toBe(true);
    }
  });

  test("AbortError → aborted，且提示是自己中断的", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";

    const info = classifyReactFailure(err);

    expect(info.kind).toBe("aborted");
    // 明确告知用户是中断而非失败，避免误以为 bug
    expect(info.title + info.reason).toMatch(/中断|取消|中止/);
    expect(info.retryable).toBe(true);
  });

  test("超时（LLM invocation timeout / 300s）→ timeout", () => {
    const info = classifyReactFailure(
      new Error("LLM invocation timeout after 300s"),
    );

    expect(info.kind).toBe("timeout");
    expect(info.title + info.reason).toMatch(/超时/);
  });

  test("ContextError → context_overflow，不复用 RetryError 文案", () => {
    const err = new Error("Context threshold exceeded: 1230/10000 (12.3%)");
    err.name = "ContextError";

    const info = classifyReactFailure(err);

    expect(info.kind).toBe("context_overflow");
    expect(info.title + info.reason).toMatch(/上下文/);
  });

  test("未知错误 → unknown，但仍有可读兜底文案 + 保留技术细节", () => {
    const info = classifyReactFailure(new Error("some weird failure xyz"));

    expect(info.kind).toBe("unknown");
    expect(info.title.length).toBeGreaterThan(0);
    // 技术细节保留（截断），供用户/开发者定位
    expect(info.technical).toBeDefined();
    expect(info.technical!).toContain("some weird failure xyz");
  });

  test("非 Error 输入（字符串 / undefined / 对象）不崩", () => {
    expect(() => classifyReactFailure("plain string error")).not.toThrow();
    expect(() => classifyReactFailure(undefined)).not.toThrow();
    expect(() => classifyReactFailure(null)).not.toThrow();
    expect(() => classifyReactFailure({ foo: "bar" })).not.toThrow();

    expect(classifyReactFailure("plain string error").kind).toBe("unknown");
    expect(classifyReactFailure(undefined).kind).toBe("unknown");
  });

  test("429 状态码从 cause/statusCode 属性也能识别", () => {
    const err: any = new Error("something failed");
    err.statusCode = 429;

    expect(classifyReactFailure(err).kind).toBe("upstream_retry");
  });
});

// ---------------------------------------------------------------------------
// 1b. rule base —— 规则表顺序与「不允许静默」契约
// ---------------------------------------------------------------------------

describe("#4418 规则表（rule base）", () => {
  test("规则顺序固定：ask_user → context → timeout → quota → upstream → transport → aborted → unknown", () => {
    expect(getFailureRuleIds()).toEqual([
      "ask_user",
      "context_overflow",
      "timeout",
      "quota_exhausted",
      "upstream_retry",
      "upstream_aborted",
      "aborted",
      "unknown",
    ]);
  });

  test("★ Task #4625 顺序铁律：quota_exhausted 必须先于 upstream_retry", () => {
    // 额度用尽同时也是 429，会被 upstream_retry 的 `/\b429\b/` 命中。
    // 若顺序反过来，用户收到的就是「稍后重发一次即可」—— 而真实恢复窗口
    // 是 22 小时，这条建议会让人白试几十次。顺序必须钉死。
    const err: any = new Error(
      "429 Free usage limit reached: subscribe to OpenCode Go",
    );
    err.status = 429;

    const info = classifyReactFailure(err);

    expect(info.ruleId).toBe("quota_exhausted");
    expect(info.retryable).toBe(false);
    // 且不能退回「重发即可」的默认建议
    expect(info.suggestion).toBeTruthy();
    expect(info.suggestion).not.toContain("直接再发一次");
  });

  test("★ timeout 先于 abort：`aborted due to timeout` 必须说超时，不能说「你取消了」", () => {
    // AbortSignal.timeout() / undici 超时的真实形态
    const err = new Error("This operation was aborted due to timeout");
    err.name = "AbortError";

    const info = classifyReactFailure(err);

    expect(info.kind).toBe("timeout");
    expect(info.ruleId).toBe("timeout");
    expect(info.title).toMatch(/超时/);
    expect(info.title).not.toMatch(/中断/);
  });

  test("传输层断链（RequestAbortedError）≠ 用户取消", () => {
    const err = new Error("The request was aborted by the peer");
    err.name = "RequestAbortedError";

    const info = classifyReactFailure(err);

    expect(info.kind).toBe("upstream_aborted");
    expect(info.reason).toMatch(/连接|传输/);
  });

  test("真正的手动取消 → aborted", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";

    expect(classifyReactFailure(err).kind).toBe("aborted");
  });

  test("★ ask_user 是唯一 notify=false 的规则（正常交互，不是失败）", () => {
    const askErr = new Error('__ASK_USER_ERROR__:{"query":"继续吗"}');
    askErr.name = "AskUserError";

    const info = classifyReactFailure(askErr);

    expect(info.kind).toBe("ask_user");
    expect(info.notify).toBe(false);
  });

  test("★ 所有真正的失败/中断 notify=true（含 aborted / unknown）", () => {
    const failures = [
      new Error(RETRY_ERROR_MESSAGE),
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
      new Error("LLM invocation timeout after 300s"),
      Object.assign(new Error("context threshold exceeded"), { name: "ContextError" }),
      new Error("totally unexpected thing"), // catch-all
    ];

    for (const err of failures) {
      const info = classifyReactFailure(err);
      expect(info.notify).toBe(true);
      expect(info.ruleId).not.toBe("ask_user");
    }
  });

  test("任何未知错误都落到 unknown 规则，仍带可读文案（结构上不可能静默）", () => {
    const info = classifyReactFailure({ weird: true });

    expect(info.ruleId).toBe("unknown");
    expect(info.notify).toBe(true);
    expect(info.title.length).toBeGreaterThan(0);
    expect(info.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. buildFailureReplyMarkdown — reply 正文
// ---------------------------------------------------------------------------

describe("#4418 buildFailureReplyMarkdown", () => {
  test("包含失败标题 + 可读原因（用户能看懂「是什么失败了」）", () => {
    const md = buildFailureReplyMarkdown(classifyReactFailure(makeRetryError()));

    expect(md).toContain("❌");
    expect(md.length).toBeGreaterThan(20);
    expect(md).toMatch(/重试/);
  });

  test("不包含裸 stack trace（用户不该看到 at File:line）", () => {
    const info = classifyReactFailure(makeRetryError());
    const md = buildFailureReplyMarkdown(info);

    expect(md).not.toContain("    at ");
    expect(md).not.toMatch(/at .*\.ts:\d+:\d+/);
  });

  test("带上「可以怎么自救」的提示（不是纯报错）", () => {
    const md = buildFailureReplyMarkdown(classifyReactFailure(makeRetryError()));

    // 必须给出可操作建议
    expect(md).toMatch(/重试|再发一次|稍后/);
  });

  test("可传入原始 query 摘要，便于用户对上号是哪次请求", () => {
    const md = buildFailureReplyMarkdown(classifyReactFailure(makeRetryError()), {
      query: "帮我分析下 example-project 的 IMPLEMENTATION_ERROR",
    });

    expect(md).toContain("帮我分析下");
  });

  test("超长 query 被截断（不刷屏）", () => {
    const md = buildFailureReplyMarkdown(classifyReactFailure(makeRetryError()), {
      query: "x".repeat(5000),
    });

    // 单条飞书消息 4096 上限，这里必须远小于它
    expect(md.length).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// 3. notifyReactFailure — 真正发 reply
// ---------------------------------------------------------------------------

describe("#4418 notifyReactFailure — 发送", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    __resetFailureReplyDedupForTest();
  });

  test("有 replyChannel.messageId → spawn lark-cli im +messages-reply（复用现有机制）", async () => {
    mockSpawn.mockReturnValue(buildFakeProc({ exitCode: 0 }));

    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(),
      sessionId: "session_4418",
    });

    expect(out.sent).toBe(true);
    expect(out.kind).toBe("upstream_retry");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("lark-cli");
    expect(args).toContain("im");
    // ★ 必须走 messages-reply 关联原始消息（用户要的「找到对应 triggerEvent」）
    expect(args).toContain("+messages-reply");
    expect(args).toContain("--message-id");
    expect(args).toContain("om_4418_msg");
    // profile 必须透传（多 appId 场景否则 99992361）
    expect(args).toContain("--profile");
    expect(args).toContain("tongzhuli");
    // ★ RED-4（回归护栏）：reply 分支本来就带 --as bot，本次不得回退
    expect(args).toContain("--as");
    expect(args[args.indexOf("--as") + 1]).toBe("bot");
  });

  test("只有 chatId（无 messageId）→ 退化为 im +messages-send --chat-id", async () => {
    mockSpawn.mockReturnValue(buildFakeProc({ exitCode: 0 }));

    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent({
        type: "lark-cli",
        chatId: "oc_only_chat",
      }),
    });

    expect(out.sent).toBe(true);
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("+messages-send");
    expect(args).toContain("--chat-id");
    expect(args).toContain("oc_only_chat");

    // ★ RED-1（Task #4557）：chatId 分支同样**必须**显式 --as bot。
    //
    // 修复前这一支没带 flag → lark-cli 用默认身份（user = 真人账号）发出 →
    // `lark-cli event consume im.message.receive_v1` 只看「是不是 user 发的」
    // → 我们自己的失败回执被同一个 consumer 当成用户消息回灌 → 又跑一次
    // 完整 agent run。Task #4552 实测回灌率 5/11 = 45%（token 没省还翻倍），
    // 修好后 0/5 = 0%。证据：本机报告 reports/4552-a1-real-e2e.md §6（gitignored，未入库）
    //
    // 这条断言只检查 args 数组 —— 正是此前 54 条测试的盲区：它们 mock 了
    // sender，看不出真实出站身份。args 才是真身份的唯一来源。
    expect(
      args.indexOf("--as"),
      "chatId 分支必须带 --as bot，否则失败回执会以 user 身份发出并被自我回灌",
    ).toBeGreaterThanOrEqual(0);
    expect(args[args.indexOf("--as") + 1]).toBe("bot");
    // 恰好出现一次（防重复拼参）
    expect(args.filter((a: string) => a === "--as").length).toBe(1);
  });

  test("RED-1b：profile 与 --as bot 共存，且 --profile 仍在最前（两个修复不互相挤掉）", async () => {
    mockSpawn.mockReturnValue(buildFakeProc({ exitCode: 0 }));

    await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent({
        type: "lark-cli",
        chatId: "oc_only_chat",
      }),
    });

    const [, args] = mockSpawn.mock.calls[0];
    // profile 由 args.unshift 注入 → 必须仍在最前（lark-cli 全局 flag 位置）
    if (args.includes("--profile")) {
      expect(args[0]).toBe("--profile");
    }
    // 两个修复不互相挤掉
    expect(args).toContain("--as");
    expect(args[args.indexOf("--as") + 1]).toBe("bot");
  });

  test("replyChannel 在 payload 位置（EventSourceEvent 兼容）也能取到", async () => {
    mockSpawn.mockReturnValue(buildFakeProc({ exitCode: 0 }));

    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: {
        type: "event-source.event",
        payload: { replyChannel: LARK_REPLY_CHANNEL },
      },
    });

    expect(out.sent).toBe(true);
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("om_4418_msg");
  });

  test("显式 replyChannel 优先于 envEvent 内的", async () => {
    mockSpawn.mockReturnValue(buildFakeProc({ exitCode: 0 }));

    await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(),
      replyChannel: {
        type: "lark-cli",
        chatId: "oc_explicit",
        messageId: "om_explicit",
      },
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("om_explicit");
    expect(args).not.toContain("om_4418_msg");
  });

  test("reply 正文里带上失败原因（不是空消息）", async () => {
    mockSpawn.mockReturnValue(buildFakeProc({ exitCode: 0 }));

    await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(),
    });

    const [, args] = mockSpawn.mock.calls[0];
    const contentIdx = args.indexOf("--markdown");
    expect(contentIdx).toBeGreaterThan(-1);
    const content = args[contentIdx + 1];
    expect(content).toMatch(/重试/);
  });
});

// ---------------------------------------------------------------------------
// 4. notifyReactFailure — 边界：无 channel / 去重 / best-effort
// ---------------------------------------------------------------------------

describe("#4418 notifyReactFailure — 边界与 best-effort", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    __resetFailureReplyDedupForTest();
  });

  test("无 replyChannel（本地 REPL）→ 不发、不崩，返回 no_channel", async () => {
    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: { type: "local", metadata: {} },
    });

    expect(out.sent).toBe(false);
    expect(out.skipped).toBe("no_channel");
    expect(mockSpawn).not.toHaveBeenCalled();
    // 仍然返回分类结果，调用方可记日志
    expect(out.kind).toBe("upstream_retry");
  });

  test("envEvent 完全缺失（act 一次性执行）→ 不发、不崩", async () => {
    const out = await notifyReactFailure({ error: makeRetryError() });

    expect(out.sent).toBe(false);
    expect(out.skipped).toBe("no_channel");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("同一 triggerEvent 连续两次失败 → 只回一次（去重）", async () => {
    mockSpawn.mockReturnValue(buildFakeProc({ exitCode: 0 }));

    const first = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(),
    });
    const second = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(),
    });

    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.skipped).toBe("duplicate");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  test("不同 triggerEvent → 各自都能回", async () => {
    // 每次 spawn 都要拿到**新的** fake proc —— buildFakeProc 只 emit 一次
    // close 事件，复用同一个对象会让第二次 await 永不 resolve
    mockSpawn.mockImplementation(() => buildFakeProc({ exitCode: 0 }));

    await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent({ ...LARK_REPLY_CHANNEL, messageId: "om_a" }),
    });
    await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent({ ...LARK_REPLY_CHANNEL, messageId: "om_b" }),
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  test("lark-cli 退出码非 0 → 吞掉，不抛（best-effort）", async () => {
    mockSpawn.mockReturnValue(
      buildFakeProc({ exitCode: 1, stderr: "lark-cli boom" }),
    );

    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(),
    });

    // 不发成功，但**绝不抛**
    expect(out.sent).toBe(false);
    expect(out.error).toBeDefined();
  });

  test("spawn 本身抛错（lark-cli 未安装）→ 吞掉，不抛", async () => {
    mockSpawn.mockReturnValue(
      buildFakeProc({ error: new Error("spawn lark-cli ENOENT") }),
    );

    await expect(
      notifyReactFailure({
        error: makeRetryError(),
        envEvent: makeEnvEvent(),
      }),
    ).resolves.toBeDefined();
  });

  test("spawn 同步 throw → 也吞掉（不污染原始错误传播）", async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("sync spawn failure");
    });

    await expect(
      notifyReactFailure({
        error: makeRetryError(),
        envEvent: makeEnvEvent(),
      }),
    ).resolves.toBeDefined();
  });

  test("失败后去重标记回滚 → 允许后续再次尝试（避免一次失败永久封锁）", async () => {
    // 第一次 spawn 失败
    mockSpawn.mockReturnValueOnce(
      buildFakeProc({ error: new Error("transient spawn failure") }),
    );

    const first = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(),
    });
    expect(first.sent).toBe(false);

    // 第二次（同一 triggerEvent）应该仍能尝试
    mockSpawn.mockReturnValue(buildFakeProc({ exitCode: 0 }));
    const second = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(),
    });

    expect(second.sent).toBe(true);
  });

  test("★ lark-cli 卡死不返回 → 硬超时后 kill 并返回（绝不能挂住 QueryExecutor）", async () => {
    const proc = buildFakeProc({ hang: true });
    mockSpawn.mockReturnValue(proc);

    const startedAt = Date.now();
    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(),
      replyTimeoutMs: 30,
    });
    const elapsed = Date.now() - startedAt;

    expect(out.sent).toBe(false);
    expect(out.error).toMatch(/timed out/i);
    expect(proc.kill).toHaveBeenCalled();
    // 确实在超时附近返回，而不是永远等
    expect(elapsed).toBeLessThan(2000);
  });

  test("★ ask_user（正常交互）不发失败说明（唯一允许不发的情形）", async () => {
    mockSpawn.mockReturnValue(buildFakeProc({ exitCode: 0 }));

    const askErr = new Error('__ASK_USER_ERROR__:{"query":"继续吗"}');
    askErr.name = "AskUserError";

    const out = await notifyReactFailure({
      error: askErr,
      envEvent: makeEnvEvent(),
    });

    expect(out.sent).toBe(false);
    expect(out.skipped).toBe("not_a_failure");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("★ chat-only 通道：同群不同错误类型都能回（不会被第一次永久封锁）", async () => {
    mockSpawn.mockImplementation(() => buildFakeProc({ exitCode: 0 }));
    const chatOnly = { type: "lark-cli", chatId: "oc_chat_only" };

    const first = await notifyReactFailure({
      error: makeRetryError(), // upstream_retry
      envEvent: makeEnvEvent(chatOnly),
    });
    const second = await notifyReactFailure({
      error: new Error("LLM invocation timeout after 300s"), // timeout
      envEvent: makeEnvEvent(chatOnly),
    });

    expect(first.sent).toBe(true);
    expect(second.sent).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  test("chat-only 通道：同群同类型 5 分钟内去重（防重放刷屏）", async () => {
    mockSpawn.mockImplementation(() => buildFakeProc({ exitCode: 0 }));
    const chatOnly = { type: "lark-cli", chatId: "oc_chat_only" };

    const first = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(chatOnly),
    });
    const second = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeEnvEvent(chatOnly),
    });

    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.skipped).toBe("duplicate");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
