/**
 * @fileoverview Task #5333 — CLI 侧 extendTools 透传（agentContext → AgentContext）
 *
 * ## 链路
 * `evt.metadata.extendTools`（ES handler 写入）
 *   → `run.ts` / `run-headless-dispatch.ts` 组 `agentContext.extendTools`
 *   → `buildQueryContext()` 搬到 `context.extendTools`（顶层，AgentContext 字段）
 *   → `AgentComponent.getAvailableTools(agent, context)` 据此放行 channelOnly 工具
 *
 * 本文件只测**纯函数** buildQueryContext 的搬运契约（不启动 env）。
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect } from "bun:test";

import { buildQueryContext } from "./query-executor";

describe("buildQueryContext — extendTools 透传（Task #5333）", () => {
  test("RED: agentContext.extendTools → context.extendTools（顶层）", () => {
    const ctx = buildQueryContext("sess_1", "hi", "trace_1", {
      pluginEnabled: {},
      extendTools: ["wecom_respond"],
    });
    expect(ctx.extendTools).toEqual(["wecom_respond"]);
  });

  test("未提供 extendTools 时不凭空造空数组（保持 undefined）", () => {
    const ctx = buildQueryContext("sess_2", "hi", "trace_2", { pluginEnabled: {} });
    expect(ctx.extendTools).toBeUndefined();
  });

  test("extendTools 不从 metadata 里读（防错位：必须是 AgentContext 顶层字段）", () => {
    const ctx = buildQueryContext("sess_3", "hi", "trace_3", {
      metadata: { extendTools: ["wrong_place"] },
    });
    expect(ctx.extendTools).toBeUndefined();
  });
});
