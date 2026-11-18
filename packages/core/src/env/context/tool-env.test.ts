/**
 * @fileoverview Task #5659 — toolEnv 方案 C 全链路测试
 *
 * 解决 #5654 跨组织泄漏：wecom-bot-2 等 ES 配置注入 toolEnv
 * （如 WECOM_CLI_CONFIG_DIR），经 metadata → EnvContext 透传，
 * wecom-cli spawn 与 bash tool spawn 时合并 env。
 *
 * 链路（与 extendTools 同构，Task #5333）：
 *   EventSourceConfig.toolEnv
 *     → handleEvent 写 evt.metadata.toolEnv
 *     → createEnvContext / buildRunEnvContext 写 EnvContext.toolEnv
 *     → wecom-cli-sender runCli / bash tool spawn 合并 env
 */

import { describe, it, expect } from "bun:test";
import {
  createEnvContext,
  resolveToolEnv,
  runWithEnvContext,
} from "./env-context";

describe("resolveToolEnv (Task #5659)", () => {
  it("从 envEvent.metadata.toolEnv 提取（本次事件优先）", () => {
    const envEvent = {
      metadata: { toolEnv: { WECOM_CLI_CONFIG_DIR: "~/.config/wecom/bot-2" } },
    };
    expect(resolveToolEnv(envEvent)).toEqual({
      WECOM_CLI_CONFIG_DIR: "~/.config/wecom/bot-2",
    });
  });

  it("envEvent 无 toolEnv 时回退到上游 ALS parentEnvContext", () => {
    const envEvent = { metadata: {} };
    expect(
      resolveToolEnv(envEvent, {
        toolEnv: { FOO: "parent" },
      }),
    ).toEqual({ FOO: "parent" });
  });

  it("envEvent 的 toolEnv 优先于上游 parentEnvContext", () => {
    const envEvent = { metadata: { toolEnv: { FOO: "event" } } };
    expect(
      resolveToolEnv(envEvent, { toolEnv: { FOO: "parent" } }),
    ).toEqual({ FOO: "event" });
  });

  it("两侧都有时合并，envEvent 键优先", () => {
    const envEvent = { metadata: { toolEnv: { A: "event", B: "event" } } };
    expect(
      resolveToolEnv(envEvent, { toolEnv: { B: "parent", C: "parent" } }),
    ).toEqual({ A: "event", B: "event", C: "parent" });
  });

  it("非法 toolEnv（非对象 / 数组 / 空对象）不生效", () => {
    expect(resolveToolEnv({ metadata: { toolEnv: "str" } })).toBeUndefined();
    expect(resolveToolEnv({ metadata: { toolEnv: [1, 2] } })).toBeUndefined();
    expect(resolveToolEnv({ metadata: { toolEnv: {} } })).toBeUndefined();
    expect(resolveToolEnv({ metadata: {} })).toBeUndefined();
    expect(resolveToolEnv(undefined)).toBeUndefined();
  });

  it("值非字符串的键被过滤", () => {
    expect(
      resolveToolEnv({ metadata: { toolEnv: { OK: "v", BAD: 123 } } }),
    ).toEqual({ OK: "v" });
  });
});

describe("createEnvContext toolEnv (Task #5659)", () => {
  it("envEvent.metadata.toolEnv 映射进 EnvContext.toolEnv", () => {
    const envEvent = {
      metadata: { toolEnv: { WECOM_CLI_CONFIG_DIR: "/bot-2" } },
    };
    const ctx = createEnvContext({
      envEvent,
      sourceId: "wecom-bot-2",
      userId: "u1",
    });
    expect(ctx.toolEnv).toEqual({ WECOM_CLI_CONFIG_DIR: "/bot-2" });
  });

  it("显式 options.toolEnv 优先于 envEvent.metadata.toolEnv", () => {
    const envEvent = { metadata: { toolEnv: { A: "meta" } } };
    const ctx = createEnvContext({
      envEvent,
      sourceId: "s",
      userId: "u",
      toolEnv: { A: "explicit" },
    });
    expect(ctx.toolEnv).toEqual({ A: "explicit" });
  });

  it("无 toolEnv 时字段为 undefined（不写空对象）", () => {
    const ctx = createEnvContext({
      envEvent: { metadata: {} },
      sourceId: "s",
      userId: "u",
    });
    expect(ctx.toolEnv).toBeUndefined();
  });
});

describe("runWithEnvContext 读取 toolEnv (Task #5659)", () => {
  it("spawn 处可通过 getEnvContext 读到 toolEnv", async () => {
    const ctx = createEnvContext({
      envEvent: { metadata: { toolEnv: { K: "V" } } },
      sourceId: "s",
      userId: "u",
    });
    await runWithEnvContext(ctx, async () => {
      const { getEnvContext } = await import("./env-context");
      expect(getEnvContext()?.toolEnv).toEqual({ K: "V" });
    });
  });
});
