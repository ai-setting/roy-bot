/**
 * @fileoverview Task #5659 — bash tool toolEnv 合并测试
 *
 * 验证 bash tool execute 时把 EnvContext.toolEnv 合并进
 * 子进程 env，且用户显式传的 env 优先级最高。
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createChildProcessMockModule } from "../../../test-utils/child-process-mock";
import { runWithEnvContext, createEnvContext } from "../../context/env-context";

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
      pid: 99998,
      unref: () => {},
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

describe("bash tool toolEnv 合并 (Task #5659)", () => {
  test("toolEnv 上下文中执行 bash → 子进程 env 含注入键", async () => {
    const { bashTool } = await import("./bash");
    await runWithEnvContext(
      makeCtx({ WECOM_CLI_CONFIG_DIR: "/bot-2" }),
      async () => {
        await bashTool.execute({ command: "echo hi" }, {});
      },
    );
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.WECOM_CLI_CONFIG_DIR).toBe("/bot-2");
    expect(capturedEnv?.PATH).toBeDefined();
  });

  test("用户显式 env 优先级最高（覆盖 toolEnv）", async () => {
    const { bashTool } = await import("./bash");
    await runWithEnvContext(
      makeCtx({ WECOM_CLI_CONFIG_DIR: "/bot-2" }),
      async () => {
        await bashTool.execute(
          { command: "echo hi", env: { WECOM_CLI_CONFIG_DIR: "/user-override" } },
          {},
        );
      },
    );
    expect(capturedEnv?.WECOM_CLI_CONFIG_DIR).toBe("/user-override");
  });

  test("无 toolEnv 上下文 → 不注入（行为不变）", async () => {
    const { bashTool } = await import("./bash");
    await bashTool.execute({ command: "echo hi" }, {});
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.WECOM_CLI_CONFIG_DIR).toBeUndefined();
  });
});
