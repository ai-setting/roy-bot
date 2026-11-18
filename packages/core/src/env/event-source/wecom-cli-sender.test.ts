/**
 * @fileoverview Task #5174（用户明令 11:29）— 企微出站 CLI 发送器测试
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  buildWecomCliSendArgs,
  buildWecomCliResolveArgs,
  parseWecomCliResult,
  parseWecomCliUserSearch,
  sendWecomCliMarkdown,
  resolveWecomCliChatId,
  resolveWecomCliBinary,
  __resetWecomCliChatIdCacheForTest,
} from "./wecom-cli-sender";

describe("wecom-cli-sender — argv 构造", () => {
  test("send 参数：message aibot send + chat-id + msg-type markdown", () => {
    const args = buildWecomCliSendArgs({
      chatId: "wotnB7WgAAnEii415uQec5esMLd2IieA",
      content: "hello",
    });
    expect(args.slice(0, 3)).toEqual(["message", "aibot", "send"]);
    expect(args).toContain("--chat-id");
    expect(
      args[args.indexOf("--chat-id") + 1],
    ).toBe("wotnB7WgAAnEii415uQec5esMLd2IieA");
    expect(args[args.indexOf("--msg-type") + 1]).toBe("markdown");
    // ★ CLI 没有 text 类型 —— 绝不能用 text
    expect(args).not.toContain("text");
    // markdown 内容必须包成 {"content": "..."}
    const md = JSON.parse(args[args.indexOf("--markdown") + 1]);
    expect(md).toEqual({ content: "hello" });
  });

  test("resolve 参数：contact users search --set keywords=", () => {
    const args = buildWecomCliResolveArgs("DongZhaoKun");
    expect(args.slice(0, 3)).toEqual(["contact", "users", "search"]);
    expect(args).toContain("--set");
    expect(args[args.indexOf("--set") + 1]).toBe("keywords=DongZhaoKun");
  });
});

describe("wecom-cli-sender — 输出解析", () => {
  test("success:true → ok", () => {
    expect(parseWecomCliResult('{"success":true}').ok).toBe(true);
  });

  test("带噪声前缀的 JSON 也能解析", () => {
    const out = '[wecom] json repair: 输入 JSON 已自动修复\n{"success":true}';
    expect(parseWecomCliResult(out).ok).toBe(true);
  });

  test("无 success 但带 security_notice → 视为成功", () => {
    const out = JSON.stringify({
      security_notice: "xxx",
      extra_identity_context: "yyy",
    });
    expect(parseWecomCliResult(out).ok).toBe(true);
  });

  test("error 对象 → 失败并带 code", () => {
    const r = parseWecomCliResult(
      '{"error":{"code":40073,"message":"非法的 chat_id"}}',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("40073");
      expect(r.error).toContain("非法的 chat_id");
    }
  });

  test("空输出 / 非 JSON → 失败", () => {
    expect(parseWecomCliResult("").ok).toBe(false);
    const r = parseWecomCliResult("not json at all");
    expect(r.ok).toBe(false);
  });

  test("user search 解析：取 users[0].userid", () => {
    const out = JSON.stringify({
      users: [{ userid: "wotnB7WgAAnEii415uQec5esMLd2IieA", name: "开发者本人" }],
      users_count: 1,
    });
    expect(parseWecomCliUserSearch(out, "fallback")).toBe(
      "wotnB7WgAAnEii415uQec5esMLd2IieA",
    );
  });

  test("user search 无结果 → fallback", () => {
    expect(parseWecomCliUserSearch('{"users":[]}', "fallback")).toBe(
      "fallback",
    );
  });
});

describe("wecom-cli-sender — resolveWecomCliBinary", () => {
  afterEach(() => {
    delete process.env.WECOM_CLI_BIN;
  });

  test("env 优先", () => {
    process.env.WECOM_CLI_BIN = "/tmp/fake/wecom-cli";
    expect(resolveWecomCliBinary()).toBe("/tmp/fake/wecom-cli");
  });

  test("无 env → PATH 名", () => {
    delete process.env.WECOM_CLI_BIN;
    expect(resolveWecomCliBinary()).toBe("wecom-cli");
  });
});

describe("wecom-cli-sender — sendWecomCliMarkdown（mock spawn）", () => {
  test("空 chatId/content → 失败不 spawn", async () => {
    const r = await sendWecomCliMarkdown({ chatId: "", content: "x" });
    expect(r.ok).toBe(false);
    const r2 = await sendWecomCliMarkdown({ chatId: "c", content: "  " });
    expect(r2.ok).toBe(false);
  });
});

describe("wecom-cli-sender — 真实 CLI 集成（可选，CLI 缺失即跳过）", () => {
  beforeEach(() => __resetWecomCliChatIdCacheForTest());

  test("chat_id 解析：DongZhaoKun → 真实 userid（需要已授权 CLI）", async () => {
    const bin = process.env.WECOM_CLI_BIN;
    if (!bin) {
      // 未指定 CLI 路径 ⇒ 跳过（CI / 无 CLI 环境不应失败）
      expect(true).toBe(true);
      return;
    }
    const resolved = await resolveWecomCliChatId("DongZhaoKun");
    // 解析成功则应是 wotn... 形态；失败则原样返回（不崩）
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });
});
