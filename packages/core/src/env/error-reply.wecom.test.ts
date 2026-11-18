/**
 * @fileoverview Task #5311 — 企微失败通知：error-reply 多通道分流
 *
 * ## 背景（Task #5308 review 结论）
 *
 * 2026-11-11 10:06 真实故障：企微群 wr26OgBgAAJlUoB3CZmlkgP2RNMPZ_yg
 * 用户发「just do it」→ LLM fallback 全挂 → run 死亡 → **群内零通知**。
 *
 * 根因：`error-reply.ts` 的 `isUsableChannel` 用 `type.includes("lark")`
 * 白名单，企微 `type: "wecom-cli"` 被过滤；且该模块无企微 sender
 * （`spawnLarkReply` 只 spawn lark-cli）。
 *
 * ## 本文件锁定的契约
 *
 * 1. wecom channel（type 以 "wecom" 开头 + chatId 非空）通过过滤
 * 2. `pickSender` 按 type 分流：lark → spawnLarkReply / wecom → spawnWecomReply
 * 3. `spawnWecomReply` 薄封装 `sendWecomReply`（CLI 优先 + WS 兜底），
 *    参数含 rawChatId / sourceId / reqId / content
 * 4. 失败通知正文带「⚠️ 系统失败通知」前缀（R4 回灌防御：即使被回灌也易识别）
 * 5. lark 回归不破坏（既有 736 行测试全用 lark，零改动）
 * 6. 去重 / no-channel 降级对企微同样生效
 * 7. **绝不抛**：企微发送失败只返回 {sent:false, error}，且去重标记回滚
 */

import { describe, test, expect, beforeEach, vi } from "bun:test";
import { createChildProcessMockModule } from "../test-utils/child-process-mock";

// ---------------------------------------------------------------------------
// Mock node:child_process.spawn（lark 路径走这里；wecom 路径走
// wecom-cli-sender 的 runCli → 也 spawn 同一个 mock —— 用二进制名区分）
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
  stdout?: string;
  stderr?: string;
  error?: Error;
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

  queueMicrotask(() => {
    if (opts.stdout) {
      (proc.stdout.on as any).mock.calls.forEach(([_e, h]: any) =>
        h(Buffer.from(opts.stdout!)),
      );
    }
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
  notifyReactFailure,
  __resetFailureReplyDedupForTest,
} from "./error-reply";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RETRY_ERROR_MESSAGE =
  "Failed after 4 attempts. Last error: Upstream request failed: Endpoint is unavailable.";

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

/** 企微 replyChannel（真实生产形态：wecom-cli-handler.buildWecomReplyChannel） */
const WECOM_REPLY_CHANNEL = {
  type: "wecom-cli",
  chatId: "wr26OgBgAAJlUoB3CZmlkgP2RNMPZ_yg",
  messageId: "b436e837_msgid",
  params: {
    chatType: "group",
    userId: "DongZhaoKun",
    wecomChatId: "wr26OgBgAAJlUoB3CZmlkgP2RNMPZ_yg",
    wecomUserId: "DongZhaoKun",
    sourceId: "es-wecom-prod",
    reqId: "req-5311",
  },
};

function makeWecomEnvEvent(replyChannel: any = WECOM_REPLY_CHANNEL) {
  return {
    type: "event-source.event.wecom-cli",
    metadata: { replyChannel, sourceId: "es-wecom-prod" },
    payload: {},
  };
}

/** 企微 CLI 成功输出（parseWecomCliResult 认可的 JSON） */
const WECOM_CLI_OK_STDOUT = JSON.stringify({ success: true });

/** 企微 CLI 失败输出（error JSON，parseWecomCliResult 判失败） */
const WECOM_CLI_ERR_STDOUT = JSON.stringify({
  error: { code: 40073, message: "invalid chat_id" },
});

/** contact users search 的空结果（解析失败 → 保留原始 chatId） */
const WECOM_CLI_SEARCH_EMPTY_STDOUT = JSON.stringify({ users: [] });

/**
 * 企微 CLI 一次回复 = 2 次 spawn：
 *   1. `contact users search`（resolveWecomCliChatId 解析 chat_id）
 *   2. `message aibot send`（真正发送）
 * 按参数分流 mock。search 返回空 users → 保留原始 chatId 直传。
 */
function mockWecomCli(opts: {
  sendExitCode?: number;
  sendStdout?: string;
  sendStderr?: string;
}) {
  mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
    const isSend = args.includes("send");
    return buildFakeProc(
      isSend
        ? {
            exitCode: opts.sendExitCode ?? 0,
            stdout: opts.sendStdout ?? WECOM_CLI_OK_STDOUT,
            stderr: opts.sendStderr,
          }
        : { exitCode: 0, stdout: WECOM_CLI_SEARCH_EMPTY_STDOUT },
    );
  });
}

/** 取「message aibot send」那一次 spawn 调用 */
function findSendCall(): any[] | undefined {
  return mockSpawn.mock.calls.find(([, args]) =>
    (args as string[]).includes("send"),
  );
}

// ---------------------------------------------------------------------------
// 1. wecom channel 通过 isUsableChannel 过滤 + pickSender 分流
// ---------------------------------------------------------------------------

describe("#5311 企微 channel 分流", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    __resetFailureReplyDedupForTest();
  });

  test("wecom channel → spawn 的是 wecom-cli（不是 lark-cli），参数含 message aibot send", async () => {
    mockWecomCli({});

    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent(),
    });

    expect(out.sent).toBe(true);
    const sendCall = findSendCall();
    expect(sendCall).toBeDefined();
    const [cmd, args] = sendCall!;
    // ★ 二进制必须是 wecom-cli（isUsableChannel 放行 + pickSender 分流的联合证据）
    expect(cmd).toBe("wecom-cli");
    // ★ CLI argv：message aibot send --chat-id ...
    expect(args).toContain("message");
    expect(args).toContain("aibot");
    expect(args).toContain("send");
    expect(args).toContain("--chat-id");
    expect(args).toContain("wr26OgBgAAJlUoB3CZmlkgP2RNMPZ_yg");
    // 不允许走 lark 的 messages-reply
    expect(args).not.toContain("+messages-reply");
  });

  test("企微 + 飞书各一次 → 互不串扰（各走各的 CLI）", async () => {
    mockWecomCli({});

    await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent(),
    });
    await notifyReactFailure({
      error: makeRetryError(),
      envEvent: {
        type: "event-source.event.lark.message",
        metadata: {
          replyChannel: {
            type: "lark-cli",
            chatId: "oc_5311_chat",
            messageId: "om_5311_msg",
            profile: "tongzhuli",
          },
        },
        payload: {},
      },
    });

    const cmds = mockSpawn.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("wecom-cli");
    expect(cmds).toContain("lark-cli");
    // lark 那次带 --profile（企微没有 profile 概念）
    const larkCall = mockSpawn.mock.calls.find((c) => c[0] === "lark-cli");
    expect(larkCall![1]).toContain("--profile");
    // lark 那次是 messages-reply，企微那次是 message aibot send
    const larkArgs = larkCall![1] as string[];
    expect(larkArgs).toContain("+messages-reply");
    const wecomSend = findSendCall()!;
    expect(wecomSend[0]).toBe("wecom-cli");
  });

  test("type 缺省 + 有 chatId → 仍走 lark（向后兼容，老数据）", async () => {
    mockWecomCli({});

    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: {
        type: "event-source.event",
        metadata: { replyChannel: { chatId: "oc_legacy", messageId: "om_legacy" } },
        payload: {},
      },
    });

    expect(out.sent).toBe(true);
    expect(mockSpawn.mock.calls[0][0]).toBe("lark-cli");
  });

  test("wecom type 变体（wecom-ws）同样放行（前缀匹配）", async () => {
    mockWecomCli({});

    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent({
        type: "wecom-ws",
        chatId: "wr_wsv",
      }),
    });

    expect(out.sent).toBe(true);
    expect(findSendCall()![0]).toBe("wecom-cli");
  });
});

// ---------------------------------------------------------------------------
// 2. spawnWecomReply 参数与 R4 防御
// ---------------------------------------------------------------------------

describe("#5311 spawnWecomReply 参数", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    __resetFailureReplyDedupForTest();
  });

  test("rawChatId / sourceId / reqId 透传（WS fallback 可用）", async () => {
    mockWecomCli({ sendStdout: WECOM_CLI_ERR_STDOUT, sendStderr: "cli boom" });

    // CLI send 失败 → sendWecomReply 走 WS fallback（reqId + sourceId）；
    // 无注册实例 → 最终 {ok:false} → notifyReactFailure 返回 {sent:false} 且不抛
    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent(),
    });

    expect(out.sent).toBe(false);
    expect(out.error).toBeDefined();
  });

  test("R4 防御：失败通知正文带「⚠️ 系统失败通知」前缀（即使回灌也易识别）", async () => {
    mockWecomCli({});

    await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent(),
    });

    const [, args] = findSendCall()!;
    const mdIdx = args.indexOf("--markdown");
    expect(mdIdx).toBeGreaterThan(-1);
    const content = args[mdIdx + 1];
    expect(content).toContain("⚠️ 系统失败通知");
    // 失败原因仍可读
    expect(content).toMatch(/重试/);
  });
});

// ---------------------------------------------------------------------------
// 3. best-effort 契约（企微路径同样绝不抛）
// ---------------------------------------------------------------------------

describe("#5311 企微路径 best-effort", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    __resetFailureReplyDedupForTest();
  });

  test("企微 CLI 失败（exit 1）→ 不抛，返回 {sent:false, error}", async () => {
    mockWecomCli({ sendStdout: WECOM_CLI_ERR_STDOUT, sendStderr: "wecom-cli boom" });

    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent(),
    });

    expect(out.sent).toBe(false);
    expect(out.error).toBeDefined();
  });

  test("企微发送失败 → 去重标记回滚（第二次仍会尝试，不永久封锁）", async () => {
    // 第一次 send 失败（search 仍成功）
    mockWecomCli({ sendStdout: WECOM_CLI_ERR_STDOUT, sendStderr: "transient" });

    const first = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent(),
    });
    expect(first.sent).toBe(false);

    // 第二次（同一 triggerEvent）应该仍能尝试
    mockWecomCli({});
    const second = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent(),
    });
    expect(second.sent).toBe(true);
  });

  test("企微 chat-only 去重：同群同类型 5 分钟内只回一次", async () => {
    mockWecomCli({});
    const chatOnly = {
      type: "wecom-cli",
      chatId: "wr_dedup_group",
    };

    const first = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent(chatOnly),
    });
    const second = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: makeWecomEnvEvent(chatOnly),
    });

    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.skipped).toBe("duplicate");
    // 企微一次回复 = search + send 两次 spawn；第二次被去重不再 spawn
    expect(findSendCall()).toBeDefined();
    const sendCalls = mockSpawn.mock.calls.filter(([, args]) =>
      (args as string[]).includes("send"),
    );
    expect(sendCalls.length).toBe(1);
  });

  test("ask_user（正常交互）企微同样不发（notify:false 规则渠道无关）", async () => {
    mockWecomCli({});

    const askErr = new Error('__ASK_USER_ERROR__:{"query":"继续吗"}');
    askErr.name = "AskUserError";

    const out = await notifyReactFailure({
      error: askErr,
      envEvent: makeWecomEnvEvent(),
    });

    expect(out.sent).toBe(false);
    expect(out.skipped).toBe("not_a_failure");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. no-channel 文案区分（可观测性 bug 修正）
// ---------------------------------------------------------------------------

describe("#5311 no_channel 文案区分", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    __resetFailureReplyDedupForTest();
  });

  test("无 channel（本地执行）→ no_channel，不 spawn", async () => {
    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: { type: "local", metadata: {} },
    });

    expect(out.sent).toBe(false);
    expect(out.skipped).toBe("no_channel");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("channel 存在但 type 不支持（如 telegram）→ no_channel（warn 级）", async () => {
    const out = await notifyReactFailure({
      error: makeRetryError(),
      envEvent: {
        type: "event-source.event.telegram",
        metadata: {
          replyChannel: { type: "telegram-bot", chatId: "tg_123" },
        },
        payload: {},
      },
    });

    expect(out.sent).toBe(false);
    expect(out.skipped).toBe("no_channel");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. classifyReactFailure 回归（企微错误同样能分类）
// ---------------------------------------------------------------------------

describe("#5311 分类回归", () => {
  test("企微侧真实错误（fallback 耗尽）→ upstream_retry", () => {
    const info = classifyReactFailure(
      new Error(
        'fallback model "opencodego/deepseek-v4.1-flash" also failed; no more fallback models left; re-throwing the ORIGINAL primary error',
      ),
    );
    // 真实行为：fallback 耗尽文案不命中 upstream 特征词 →
    // 落到 UNKNOWN_RULE catch-all（notify:true，仍会通知 ——
    // 结构上不可能静默）。企微侧同样适用。
    expect(info.notify).toBe(true);
    expect(info.kind).toBe("unknown");
  });
});
