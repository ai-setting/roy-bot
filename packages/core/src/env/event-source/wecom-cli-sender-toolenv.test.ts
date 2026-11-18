/**
 * @fileoverview Task #5659 — toolEnv spawn 合并测试
 *
 * 验证 spawn 处从 ALS EnvContext 读取 toolEnv 并合并进子进程 env：
 *   1. wecom-cli-sender.runCli → spawn env 含 toolEnv
 *   2. 无 EnvContext → env 与 process.env 一致（行为不变）
 *
 * mock 模式沿用 Task #4420 的 createChildProcessMockModule
 * （mock.module ESM exports 语义，导出面必须完整）。
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createChildProcessMockModule } from "../../test-utils/child-process-mock";
import { runWithEnvContext, createEnvContext } from "../context/env-context";

const spawnMock = mock(
  (
    _cmd: string,
    _args: string[],
    _opts?: { env?: Record<string, string> },
  ) => {
    if (_opts?.env) capturedEnv = _opts.env;
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, cb: Function) => {
        if (event === "close") cb(0);
      },
      kill: () => {},
      pid: 99997,
    } as any;
  },
);

let capturedEnv: Record<string, string> | undefined;

beforeEach(() => {
  capturedEnv = undefined;
  spawnMock.mockClear();
  mock.module("child_process", () =>
    createChildProcessMockModule({ spawn: spawnMock as any }),
  );
});

function makeCtx(toolEnv: Record<string, string>) {
  return createEnvContext({
    envEvent: { metadata: { toolEnv } },
    sourceId: "wecom-bot-2",
    userId: "test-user",
  });
}

describe("runCli spawn env 合并 (Task #5659)", () => {
  test("toolEnv 上下文中 sendWecomCliMarkdown → spawn env 含 WECOM_CLI_CONFIG_DIR", async () => {
    // 动态 import 让 mock.module 生效
    const { sendWecomCliMarkdown } = await import("./wecom-cli-sender");
    await runWithEnvContext(
      makeCtx({ WECOM_CLI_CONFIG_DIR: "~/.config/wecom/bot-2" }),
      async () => {
        await sendWecomCliMarkdown({ chatId: "c", content: "x" });
      },
    );
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.WECOM_CLI_CONFIG_DIR).toBe(
      "~/.config/wecom/bot-2",
    );
    // process.env 仍被继承（PATH 等不丢）
    expect(capturedEnv?.PATH).toBeDefined();
  });

  test("无 toolEnv 上下文 → spawn env 不含注入键（行为不变）", async () => {
    const { sendWecomCliMarkdown } = await import("./wecom-cli-sender");
    await sendWecomCliMarkdown({ chatId: "c", content: "x" });
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.WECOM_CLI_CONFIG_DIR).toBeUndefined();
    expect(capturedEnv?.PATH).toBeDefined();
  });
});
