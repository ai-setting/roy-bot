/**
 * @fileoverview Task #5287 — 企微回复引用：被动回帧优先
 *
 * 取证结论（官方文档 101463）：
 * - 主动推送（CLI message.aibot.send / WS aibot_send_msg）schema
 *   无 quote/引用字段 —— 协议不支持主动引用某条消息。
 * - 被动回复（aibot_respond_msg，headers.req_id 原样透传）时，
 *   企微服务端**自动**把回复引用到触发回调的用户消息（群聊场景）。
 *
 * ⇒ 要让用户看到「回复引用了哪条消息」，必须走被动回帧。
 *   原实现「CLI 优先」导致回复永远走主动推送（无引用）。
 *   本测试锁定新策略：**有 reqId 且 WS 实例在线 → 被动回帧优先**；
 *   CLI 降为 fallback（无 reqId / WS 失败时仍可用，不回归 #5174）。
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createChildProcessMockModule } from "../../test-utils/child-process-mock";
import {
  registerWecomRespondTarget,
  __resetWecomRespondRegistryForTest,
  sendWecomReply,
} from "./wecom-respond-registry";
import { __resetWecomCliChatIdCacheForTest } from "./wecom-cli-sender";

/**
 * spawn 桩（隔离 wecom-cli-handler.test.ts 的 mock.module
 * 跨文件泄漏 + resolveWecomCliChatId 模块级缓存脏数据）：
 * - `contact users search`（CLI 解析）→ 返回 users[0]
 * - `message aibot send` → 返回 {"success": true}
 */
const spawnStub = mock((cmd: string, args: string[]) => {
  const handlers: Record<string, Function> = {};
  const child = {
    stdout: { on: (e: string, cb: Function) => { handlers["o" + e] = cb; } },
    stderr: { on: (e: string, cb: Function) => { handlers["e" + e] = cb; } },
    on: (e: string, cb: Function) => {
      handlers[e] = cb;
      if (e === "close") setTimeout(() => cb(0), 0);
    },
    kill: () => {},
    pid: 1,
  };
  setImmediate(() => {
    const isSearch = (args ?? []).includes("contact");
    handlers["odata"]?.(
      isSearch ? '{"users":[{"userid":"wotnX"}]}' : '{"success": true}',
    );
  });
  return child as any;
});

describe("sendWecomReply — 被动回帧优先（Task #5287 回复引用）", () => {
  beforeEach(() => {
    mock.module("child_process", () =>
      createChildProcessMockModule({ spawn: spawnStub as any }),
    );
    __resetWecomRespondRegistryForTest();
    __resetWecomCliChatIdCacheForTest();
  });

  test("有 reqId + WS 实例在线 → 走 WS 被动回帧（服务端自动引用），不走 CLI", async () => {
    // CLI 可用（用真实存在的二进制 /bin/echo 模拟 CLI 成功）
    // —— 即便 CLI 能成功，也应优先走 WS 被动回帧（引用语义）
    process.env.WECOM_CLI_BIN = "/bin/echo";
    const calls: Array<{ reqId: string; body: Record<string, unknown> }> = [];
    registerWecomRespondTarget("s-quote", {
      respond: (reqId, body) => {
        calls.push({ reqId, body });
        return undefined;
      },
    });
    try {
      const r = await sendWecomReply({
        sourceId: "s-quote",
        rawChatId: "u-quote",
        reqId: "req-quote-1",
        content: "带引用的回复",
      });
      expect(r.ok).toBe(true);
      expect(r.channel).toBe("ws");
      expect(calls.length).toBe(1);
      expect(calls[0].reqId).toBe("req-quote-1");
      expect(calls[0].body).toEqual({
        msgtype: "markdown",
        markdown: { content: "带引用的回复" },
      });
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });

  test("无 reqId → 保持 CLI 优先（#5174 行为不回归）", async () => {
    // CLI 成功（/bin/echo exit 0）
    process.env.WECOM_CLI_BIN = "/bin/echo";
    const wsCalls: unknown[] = [];
    registerWecomRespondTarget("s-cli", {
      respond: () => {
        wsCalls.push(1);
        return undefined;
      },
    });
    try {
      const r = await sendWecomReply({
        sourceId: "s-cli",
        rawChatId: "u-cli",
        content: "无 reqId 的主动回复",
      });
      expect(r.ok).toBe(true);
      expect(r.channel).toBe("cli");
      expect(wsCalls.length).toBe(0);
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });

  test("有 reqId 但 WS 失败 → CLI fallback（不因新策略丢回复）", async () => {
    process.env.WECOM_CLI_BIN = "/bin/echo";
    registerWecomRespondTarget("s-fb", {
      respond: () => new Error("bridge not connected"),
    });
    try {
      const r = await sendWecomReply({
        sourceId: "s-fb",
        rawChatId: "u-fb",
        reqId: "req-fb-1",
        content: "fallback 内容",
      });
      expect(r.ok).toBe(true);
      expect(r.channel).toBe("cli");
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });

  test("有 reqId 但无注册实例 → CLI fallback", async () => {
    process.env.WECOM_CLI_BIN = "/bin/echo";
    try {
      const r = await sendWecomReply({
        sourceId: "s-no-instance",
        rawChatId: "u-ni",
        reqId: "req-ni-1",
        content: "no instance",
      });
      expect(r.ok).toBe(true);
      expect(r.channel).toBe("cli");
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });
});
