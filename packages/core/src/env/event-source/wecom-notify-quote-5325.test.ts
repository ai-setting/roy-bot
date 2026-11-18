import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerWecomRespondTarget,
  __resetWecomRespondRegistryForTest,
  wecomRespondTool,
} from "./wecom-respond-registry";
import {
  runWithEnvContextAsync,
  type EnvContext,
} from "../context/env-context";

/**
 * Task #5325 — 通知轮（task.background.*）回复引用修复
 *
 * 根因：通知轮的 envEvent.metadata **没有顶层 reqId**（reqId 只在
 * replyChannel.params.reqId 里），wecom_respond 只读 metadata.reqId
 * → undefined → 走 CLI 主动推送 → 用户看不到引用。
 *
 * 修复：wecom_respond 增加 replyChannel.params 兜底读取
 * （reqId / sourceId）。
 */

describe("wecom_respond notify-turn reqId fallback (#5325)", () => {
  beforeEach(() => {
    __resetWecomRespondRegistryForTest();
  });

  const makeRespondTarget = (captured: {
    reqId?: string;
    chatId?: string;
    err?: Error;
  }) => ({
    respond: (reqId: string, body: Record<string, unknown>) => {
      captured.reqId = reqId;
      // ★ DS review MINOR-1：捕获 body 以断言 chatId 兜底分支
      // （sendWecomReply 只发 markdown，chatId 走 CLI 解析；
      // 这里断言「ws 分支被走到 + reqId 正确」即可，chatId 兜底
      // 通过 sendWecomReply 的入参 rawChatId 在 CLI 侧验证，
      // ws body 无 chatId 字段 —— 用 captured.chatId 记录调用次数）
      captured.chatId = captured.chatId === undefined ? "called" : captured.chatId;
      return captured.err;
    },
  });

  it("RED: notify-turn envEvent without top-level reqId but with replyChannel.params.reqId → ws respond called with that reqId", async () => {
    const captured: { reqId?: string; err?: Error } = {};
    registerWecomRespondTarget("wecom-bot-2", makeRespondTarget(captured));

    // 模拟通知轮 EnvContext：metadata 无顶层 reqId，只有 replyChannel.params.reqId
    const ctx = {
      sourceId: undefined as string | undefined,
      envEvent: {
        type: "task.background.completed",
        metadata: {
          trigger_session_id: "chat-1",
          replyChannel: {
            type: "wecom-cli",
            chatId: "woUser",
            params: {
              sourceId: "wecom-bot-2",
              reqId: "REQ_FROM_PARAMS",
            },
          },
        },
      },
    } as unknown as EnvContext;

    const { wecomRespondTool: wecom_respond } = {
      wecomRespondTool,
    };
    const result = await runWithEnvContextAsync(ctx, () =>
      (wecom_respond as any).execute(
        { content: "hello" },
        {} as any,
      ),
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.channel).toBe("ws");
    expect(captured.reqId).toBe("REQ_FROM_PARAMS");
    // ★ DS review MINOR-1：chatId 兜底分支生效证明
    // （通知轮 metadata 无顶层 chatId → 走 replyChannel.chatId="woUser"
    // → chatId 解析成功，工具未报 "cannot resolve chat_id"）
    expect(result.metadata?.chat_id).toBe("woUser");
    expect(captured.chatId).toBe("called");
  });

  it("user-message turn with top-level metadata.reqId still works (no regression)", async () => {
    const captured: { reqId?: string; err?: Error } = {};
    registerWecomRespondTarget("wecom-bot-2", makeRespondTarget(captured));

    const ctx = {
      sourceId: "wecom-bot-2",
      envEvent: {
        type: "event-source.event.wecom-cli",
        metadata: {
          chatId: "woUser",
          reqId: "TOP_LEVEL_REQ",
        },
      },
    } as unknown as EnvContext;

    const result = await runWithEnvContextAsync(ctx, () =>
      (wecomRespondTool as any).execute({ content: "hi" }, {} as any),
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.channel).toBe("ws");
    expect(captured.reqId).toBe("TOP_LEVEL_REQ");
  });

  it("no reqId anywhere → CLI fallback (existing behavior unchanged)", async () => {
    const captured: { reqId?: string; err?: Error } = {};
    registerWecomRespondTarget("wecom-bot-2", makeRespondTarget(captured));

    const ctx = {
      sourceId: "wecom-bot-2",
      envEvent: {
        type: "task.background.completed",
        metadata: {
          replyChannel: { type: "wecom-cli", chatId: "woUser" },
        },
      },
    } as unknown as EnvContext;

    const result = await runWithEnvContextAsync(ctx, () =>
      (wecomRespondTool as any).execute({ content: "hi" }, {} as any),
    );
    expect(captured.reqId).toBeUndefined();
    // ★ DS review MINOR-2：强化断言 —— 无 reqId 时工具失败
    // （测试环境无真实 CLI 凭据，CLI 发送失败 → success=false），
    // 证明确实走到了 CLI 分支而非提前 return
    expect(result.success).toBe(false);
  });
});
