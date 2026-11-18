/**
 * @fileoverview Task #4722 — es 分流：`##command##:` 消息不进 agent 链路
 *
 * 契约（用户需求）：
 *   lark-cli es handler 收到 `##command##: <cmd>` 开头的消息时，
 *   **不走 agent 处理链路**，而是走 command 处理逻辑，
 *   并用飞书卡片消息展示结果。
 *
 * 验证：
 * 1. `##command##:` 消息 → 不调用 eventHandler（agent 链路）
 * 2. 普通消息 → 仍然走 eventHandler（不回归）
 * 3. command 结果（card）→ 通过 lark-cli 发送 interactive 卡片
 * 4. command 失败 → 也用卡片回执告知用户，不静默
 *
 * ⚠️ mock 手法：`event-source-handlers.ts` 用 **ESM 静态 import**
 *   `import { spawn } from "child_process"`，运行时改 `require` 无效 →
 *   必须 `mock.module("child_process", ...)` + 动态 import（见 Task #4420
 *   的 child-process-mock 工厂，避免缺导出导致整个文件 SyntaxError）。
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createChildProcessMockModule } from "../../test-utils/child-process-mock";

/** 捕获的 lark-cli spawn 调用（参数数组） */
const spawnCalls: string[][] = [];

/** 构造一个假 ChildProcess（够 spawn 消费脚本用） */
function makeFakeChild() {
  const handlers: Record<string, Function> = {};
  return {
    stdout: { on: (e: string, cb: Function) => (handlers[`stdout_${e}`] = cb) },
    stderr: { on: (e: string, cb: Function) => (handlers[`stderr_${e}`] = cb) },
    stdin: { on: () => {}, write: () => {}, end: () => {} },
    on: (e: string, cb: Function) => {
      handlers[e] = cb;
      // 模拟进程正常退出（异步），让 promise resolve
      if (e === "close") setTimeout(() => cb(0), 0);
    },
    kill: () => {},
  };
}

const spawnMock = mock((cmd: string, args: string[]) => {
  spawnCalls.push([cmd, ...(args ?? [])]);
  return makeFakeChild() as any;
});

mock.module("child_process", () =>
  createChildProcessMockModule({
    spawn: spawnMock as any,
    exec: ((_cmd: string, cb?: Function) => {
      if (typeof cb === "function") cb(null, { stdout: "", stderr: "" });
      return { on: () => {}, kill: () => {}, pid: 1 } as any;
    }) as any,
  })
);

// 动态 import（让 mock.module 生效）
const { LarkCliInstance } = await import("./event-source-handlers");

/** 构造一条 lark-cli 简化格式的 im.message.receive_v1 消息 */
function makeMessageRawData(text: string): string {
  return (
    JSON.stringify({
      type: "im.message.receive_v1",
      event_id: `evt_${Math.random().toString(36).slice(2)}`,
      timestamp: "1790579077976",
      chat_id: "oc_chat_cmd_test",
      chat_type: "p2p",
      message_id: `om_${Math.random().toString(36).slice(2)}`,
      message_type: "text",
      sender_id: "ou_test_user",
      content: JSON.stringify({ text }),
      profile: "default",
    }) + "\n" // ★ processStream 按行切分：必须带尾部换行才会被 dispatch
  );
}

/** 等待 fire-and-forget 的异步派发完成 */
async function settle(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("Task #4722: es 分流 —— ##command##: 不进 agent 链路", () => {
  let config: any;
  let instance: any;
  let dispatchedEvents: number;

  beforeEach(() => {
    spawnCalls.length = 0;
    spawnMock.mockClear();

    config = {
      id: "es-command-test",
      name: "command test",
      type: "lark-cli",
      enabled: true,
      command: "lark-cli event consume im.message.receive_v1 --as bot",
      // 指向临时 config，避免测试写真实 ~/.roy-bot/config.jsonc
      options: { configPath: "/tmp/roy-cmd-es-test/config.jsonc" },
    };

    instance = new LarkCliInstance(config);
    dispatchedEvents = 0;
    instance.onEvent(() => {
      dispatchedEvents++;
    });
    instance.setEnvironment({ getComponent: () => null } as any);
  });

  test("##command##: 消息不触发 eventHandler（agent 链路）", async () => {
    await instance.processStream(makeMessageRawData("##command##: list model"));
    await settle();

    // 核心断言：agent 链路完全没被触发
    expect(dispatchedEvents).toBe(0);
  });

  test("普通消息仍然走 eventHandler（不回归）", async () => {
    await instance.processStream(makeMessageRawData("你好，帮我看下这个 bug"));
    await settle();

    expect(dispatchedEvents).toBe(1);
  });

  test("##command##: 消息发送 interactive 卡片（lark-cli msg-type interactive）", async () => {
    await instance.processStream(makeMessageRawData("##command##: list model"));
    await settle();

    // 应有 lark-cli 调用
    const larkCalls = spawnCalls.filter((c) => c[0] === "lark-cli");
    expect(larkCalls.length).toBeGreaterThan(0);
    // 卡片消息：msg-type interactive
    expect(larkCalls.some((c) => c.includes("interactive"))).toBe(true);
    // 回复原消息（带 message-id）
    expect(larkCalls.some((c) => c.includes("+messages-reply"))).toBe(true);
  });

  test("##command##: 未注册命令 → 回执错误（不静默、不进 agent）", async () => {
    await instance.processStream(
      makeMessageRawData("##command##: totally-unknown-cmd")
    );
    await settle();

    // agent 链路仍然不触发
    expect(dispatchedEvents).toBe(0);
    // 有回执（卡片）
    const larkCalls = spawnCalls.filter((c) => c[0] === "lark-cli");
    expect(larkCalls.length).toBeGreaterThan(0);
    expect(larkCalls.some((c) => c.includes("interactive"))).toBe(true);
  });

  test("##command##: 卡片内容包含 fallback 列表条目", async () => {
    // 预置一个含 fallbackModels 的 config
    const fs = require("fs");
    const dir = "/tmp/roy-cmd-es-test";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      `${dir}/config.jsonc`,
      '{\n  "llm": { "fallbackModels": ["tong/GLM-5.3-Flash", "opencodego/deepseek-v4.1-flash"] }\n}'
    );

    await instance.processStream(makeMessageRawData("##command##: list model"));
    await settle();

    const larkCalls = spawnCalls.filter((c) => c[0] === "lark-cli");
    const contentArg = larkCalls
      .flatMap((c) => c)
      .find((a) => a.includes("fallbackModels") || a.includes("GLM-5.3-Flash"));
    expect(contentArg).toBeTruthy();
  });
});
