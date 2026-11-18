/**
 * @fileoverview EventSourceEventPayload.parentTaskId 类型字段测试 (Task #4023 + #4025 OC 推荐 #2)
 *
 * 目的：把 `parentTaskId?: number` 从 runtime duck-typing 升级为
 * `EventSourceEventPayload` 接口的显式字段。
 *
 * 价值：
 * - 下游 consumer (task_create tool, agent) 可以 `evt.payload.parentTaskId` 静态访问
 * - 不再依赖 EventMetadata 的 [key: string]: unknown 索引逃生
 * - 编译期拒绝任何把 parentTaskId 写成 string / undefined 的错误
 *
 * 实现位置：
 * - 文件：packages/core/src/env/event-source/types.ts
 * - 接口：EventSourceEventPayload
 */

import { describe, it, expect } from "bun:test";
import type { EventSourceEventPayload } from "./types";

describe("Task #4023+#4025 OC #2 — EventSourceEventPayload.parentTaskId 显式字段", () => {
  it("运行时：构造 payload 时显式 parentTaskId 字段保留", () => {
    const payload: EventSourceEventPayload = {
      sourceId: "es_test",
      sourceType: "lark-cli",
      rawEvent: {},
      message: "hi",
      metadata: {} as any,
      timestamp: 123,
      parentTaskId: 9999,
    };
    expect(payload.parentTaskId).toBe(9999);
  });

  it("运行时：parentTaskId 可省略（undefined）", () => {
    const payload: EventSourceEventPayload = {
      sourceId: "es_test",
      sourceType: "lark-cli",
      rawEvent: {},
      message: "hi",
      metadata: {} as any,
      timestamp: 123,
    };
    expect(payload.parentTaskId).toBeUndefined();
  });

  it("运行时：parentTaskId = 0 也合法", () => {
    const payload: EventSourceEventPayload = {
      sourceId: "es_test",
      sourceType: "lark-cli",
      rawEvent: {},
      message: "hi",
      metadata: {} as any,
      timestamp: 123,
      parentTaskId: 0,
    };
    expect(payload.parentTaskId).toBe(0);
  });
});