/**
 * @fileoverview Task #5142 — EventSourceComponent 对「优雅降级」的状态处理
 *
 * ## 为什么需要这个测试
 *
 * `EventSourceComponent.startSource()` 原本在 `await instance.start()` 之后
 * **无条件**写 `this.statuses.set(id, "running")`。
 *
 * 问题：handler 可以在 `start()` 里**优雅降级**（不抛异常，但状态是 error）——
 * 例如 wecom-cli 二进制缺失时，`WecomCliInstance.start()` 会把状态置为 `error`
 * 并记录可读的安装提示，然后**正常返回**（不 crash）。
 *
 * 无条件写 running 的后果：
 * - `eventsource status` 显示「运行中」，但实际什么都没跑 —— **状态撒谎**
 * - `eventsource start` 返回成功，用户以为通了
 * - 没有任何 error 事件推给上层
 *
 * 修复：start 后读 `instance.getStatus()`，若是 `error` 则
 * 写 error 状态 + 抛错（让 CLI 能提示）+ 推 `event-source.error` 事件。
 */

import { describe, test, expect } from "bun:test";
import type {
  EventSourceConfig,
  EventSourceHandler,
  EventSourceInstance,
  EventSourceStatus,
  EventSourceEventHandler,
} from "./types";

/**
 * 造一个「start() 里优雅降级」的 handler：
 * - start() **不抛**，但把状态置为 error
 * - getLastError() 返回可读原因
 */
function createDegradingHandler(type: string): EventSourceHandler {
  return {
    type,
    validateConfig: () => [],
    createInstance: (config: EventSourceConfig): EventSourceInstance => {
      let status: EventSourceStatus = "created";
      return {
        start: async () => {
          // ★ 不抛异常，只是降级
          status = "error";
        },
        stop: async () => {
          status = "stopped";
        },
        getStatus: () => status,
        onEvent: (_h: EventSourceEventHandler) => {},
        offEvent: () => {},
        getLastError: () => "wecom-cli binary not found on PATH",
      } as unknown as EventSourceInstance;
    },
  };
}

/**
 * 造一个正常工作的 handler。
 */
function createHealthyHandler(type: string): EventSourceHandler {
  return {
    type,
    validateConfig: () => [],
    createInstance: (config: EventSourceConfig): EventSourceInstance => {
      let status: EventSourceStatus = "created";
      return {
        start: async () => {
          status = "running";
        },
        stop: async () => {
          status = "stopped";
        },
        getStatus: () => status,
        onEvent: (_h: EventSourceEventHandler) => {},
        offEvent: () => {},
      } as unknown as EventSourceInstance;
    },
  };
}

describe("EventSourceComponent — 优雅降级时的状态处理（Task #5142）", () => {
  test("instance.start() 降级为 error 时，组件状态不应是 running", async () => {
    const { EventSourceComponent } = await import("./event-source-component");

    const component = new EventSourceComponent();
    component.registerHandler(createDegradingHandler("wecom-degrade"));

    const config = {
      id: "es-degrade-1",
      name: "degrade",
      type: "wecom-degrade",
      enabled: true,
    } as unknown as EventSourceConfig;
    component.register(config);

    // start 应当抛错（把降级暴露给调用方，而不是静默吞掉）
    let threw = false;
    try {
      await component.startSource("es-degrade-1");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // ★ 关键断言：状态不是 running
    expect(component.getStatus("es-degrade-1")).toBe("error");
  });

  test("正常启动时状态仍然是 running（不回归）", async () => {
    const { EventSourceComponent } = await import("./event-source-component");

    const component = new EventSourceComponent();
    component.registerHandler(createHealthyHandler("wecom-healthy"));

    const config = {
      id: "es-healthy-1",
      name: "healthy",
      type: "wecom-healthy",
      enabled: true,
    } as unknown as EventSourceConfig;
    component.register(config);

    await component.startSource("es-healthy-1");
    expect(component.getStatus("es-healthy-1")).toBe("running");
  });
});
