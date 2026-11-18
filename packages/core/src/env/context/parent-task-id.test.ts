/**
 * @fileoverview Task #4023 — chat↔task 绑定父任务 ID 规范化与解析测试
 *
 * 覆盖曾断链的核心映射：
 *   envEvent.metadata.parentTaskId  →  EnvContext.parentTaskId
 *
 * 历史 bug：event-source-handlers 只把 parentTaskId 写进 evt.metadata /
 * evt.payload，从未写进 EnvContext；agent-component 也不读 envEvent.metadata，
 * 导致 task_create 的 env 继承分支永远拿到 undefined（功能端到端失效）。
 */

import { describe, it, expect } from "bun:test";
import {
  normalizeParentTaskId,
  resolveEnvParentTaskId,
} from "./env-context";

describe("normalizeParentTaskId (Task #4023)", () => {
  it("正整数原样返回", () => {
    expect(normalizeParentTaskId(1)).toBe(1);
    expect(normalizeParentTaskId(8888)).toBe(8888);
  });

  it("0 / 负数 / 非整数 / 非数字一律视为缺失（undefined）", () => {
    expect(normalizeParentTaskId(0)).toBeUndefined();
    expect(normalizeParentTaskId(-1)).toBeUndefined();
    expect(normalizeParentTaskId(1.5)).toBeUndefined();
    expect(normalizeParentTaskId("8888")).toBeUndefined();
    expect(normalizeParentTaskId(null)).toBeUndefined();
    expect(normalizeParentTaskId(undefined)).toBeUndefined();
    expect(normalizeParentTaskId(NaN)).toBeUndefined();
    expect(normalizeParentTaskId(Infinity)).toBeUndefined();
  });
});

describe("resolveEnvParentTaskId (Task #4023)", () => {
  it("从 envEvent.metadata.parentTaskId 提取（本次事件优先）", () => {
    const envEvent = { metadata: { parentTaskId: 8888 } };
    expect(resolveEnvParentTaskId(envEvent)).toBe(8888);
  });

  it("envEvent 无 parentTaskId 时回退到上游 ALS parentEnvContext", () => {
    const envEvent = { metadata: {} };
    expect(
      resolveEnvParentTaskId(envEvent, { parentTaskId: 7777 })
    ).toBe(7777);
  });

  it("envEvent 的 parentTaskId 优先于上游 parentEnvContext", () => {
    const envEvent = { metadata: { parentTaskId: 8888 } };
    expect(
      resolveEnvParentTaskId(envEvent, { parentTaskId: 7777 })
    ).toBe(8888);
  });

  it("envEvent 里非法 parentTaskId（0/负数/字符串）不生效，回退上游", () => {
    expect(
      resolveEnvParentTaskId({ metadata: { parentTaskId: 0 } }, { parentTaskId: 7777 })
    ).toBe(7777);
    expect(
      resolveEnvParentTaskId({ metadata: { parentTaskId: -3 } }, { parentTaskId: 7777 })
    ).toBe(7777);
    expect(
      resolveEnvParentTaskId({ metadata: { parentTaskId: "8888" } }, { parentTaskId: 7777 })
    ).toBe(7777);
  });

  it("envEvent / parentEnvContext 都没有 → undefined（建 root）", () => {
    expect(resolveEnvParentTaskId({ metadata: {} })).toBeUndefined();
    expect(resolveEnvParentTaskId(undefined)).toBeUndefined();
    expect(resolveEnvParentTaskId(null, undefined)).toBeUndefined();
  });
});
