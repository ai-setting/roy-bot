/**
 * EventSourceComponent.update() 测试
 *
 * TDD 驱动：先写失败测试（RED），再实现（GREEN），最后重构（REFACTOR）
 *
 * 覆盖场景：
 * - 更新 interval 成功（partial 更新，保留其他字段）
 * - 找不到 id 时抛错
 * - 修改 running 状态时先 stop
 * - 修改 type 字段报错
 * - update 后调用 saveConfig 持久化
 */

import { describe, test, expect, beforeEach, vi } from "bun:test";
import { EventSourceComponent } from "./event-source-component";
import {
  type EventSourceConfig,
  type EventSourceHandler,
  type EventSourceInstance,
  type EventSourceEventHandler,
  type EventSourceStatus,
  EventSourceInitHooks,
} from "./types";

// =============================================================================
// 真实组件测试 - 使用真实 EventSourceComponent + Mock Handler
// =============================================================================

/**
 * 创建 mock handler
 * - validateConfig: 基本校验
 * - createInstance: 返回一个可控制的 instance
 */
function createMockHandler(type: string): EventSourceHandler {
  return {
    type,
    validateConfig: (config: EventSourceConfig) => {
      const errors: string[] = [];
      if (type === "timer" && (!config.interval || config.interval <= 0)) {
        errors.push("Interval must be positive for timer");
      }
      return errors;
    },
    createInstance: (config: EventSourceConfig): EventSourceInstance => {
      let status: EventSourceStatus = "created";
      let eventHandler: EventSourceEventHandler | null = null;
      return {
        start: vi.fn(async () => {
          status = "running";
        }),
        stop: vi.fn(async () => {
          status = "stopped";
        }),
        getStatus: () => status,
        onEvent: vi.fn((h: EventSourceEventHandler) => {
          eventHandler = h;
        }),
        offEvent: vi.fn(() => {
          eventHandler = null;
        }),
      };
    },
  };
}

/**
 * 创建一个临时的 isolated home 目录用于持久化测试
 */
function createTempHome(): { cleanup: () => void; home: string } {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "roy-bot-es-update-"));
  const origHome = process.env.HOME;
  process.env.HOME = tempHome;
  return {
    cleanup: () => {
      process.env.HOME = origHome;
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    },
    home: tempHome,
  };
}

describe("EventSourceComponent.update()", () => {
  let component: EventSourceComponent;
  let tempHome: { cleanup: () => void; home: string };

  beforeEach(async () => {
    EventSourceInitHooks.clear();
    tempHome = createTempHome();
    component = new EventSourceComponent();
    // 直接注入 handlers（绕过完整 init 链路）
    (component as any).registerBuiltInHandlers();
    (component as any).handlers.set("timer", createMockHandler("timer"));
    (component as any).handlers.set("custom-source", createMockHandler("custom-source"));
  });

  test("更新 interval 成功 - partial 更新保留其他字段", async () => {
    // Given - 注册一个 timer 事件源
    const config: EventSourceConfig = {
      id: "es-timer-1",
      name: "Test Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
      eventTypes: ["timer.selfReminder"],
      options: { prompt: "old prompt" },
    };
    component.register(config);

    // When - 更新 interval
    const result = await component.update("es-timer-1", { interval: 5000 });

    // Then
    expect(result.updated.id).toBe("es-timer-1");
    expect(result.updated.interval).toBe(5000);
    // 其他字段保留
    expect(result.updated.name).toBe("Test Timer");
    expect(result.updated.type).toBe("timer");
    expect(result.updated.enabled).toBe(true);
    expect(result.updated.eventTypes).toEqual(["timer.selfReminder"]);
    expect(result.updated.options).toEqual({ prompt: "old prompt" });

    // 通过 get() 也能读到新值
    const stored = component.get("es-timer-1");
    expect(stored?.interval).toBe(5000);
  });

  test("更新 running 状态的事件源 - 先 stop 不重启", async () => {
    // Given - 注册并启动一个 timer
    const config: EventSourceConfig = {
      id: "es-running-1",
      name: "Running Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    };
    component.register(config);
    await component.startSource("es-running-1");
    expect(component.getStatus("es-running-1")).toBe("running");

    // When - 更新 interval（不重启）
    const result = await component.update("es-running-1", { interval: 2000 });

    // Then - 应该已 stop（不自动重启）
    expect(result.stopped).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.restarted).toBe(false);
    expect(component.getStatus("es-running-1")).toBe("stopped");
    expect(result.updated.interval).toBe(2000);
  });

  test("更新 stopped 状态的事件源 - 不调用 stop", async () => {
    // Given - 注册但未启动
    component.register({
      id: "es-stopped-1",
      name: "Stopped Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    expect(component.getStatus("es-stopped-1")).toBe("created");

    // When
    const result = await component.update("es-stopped-1", { interval: 3000 });

    // Then - 不应 stop
    expect(result.wasRunning).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.updated.interval).toBe(3000);
  });

  test("找不到 id 时抛错 - 错误信息明确", async () => {
    // When/Then
    await expect(component.update("non-existent-id", { interval: 1000 })).rejects.toThrow(
      /EventSource not found: non-existent-id/,
    );
  });

  test("修改 type 字段时抛错", async () => {
    // Given
    component.register({
      id: "es-typelock-1",
      name: "Type Lock Test",
      type: "timer",
      enabled: true,
      interval: 1000,
    });

    // When/Then - 尝试改 type
    await expect(
      component.update("es-typelock-1", { type: "websocket" as any }),
    ).rejects.toThrow(/Cannot update.*type/);
  });

  test("update 后会持久化 (saveConfig)", async () => {
    // Given
    const saveSpy = vi.spyOn(component, "saveConfig");
    component.register({
      id: "es-persist-1",
      name: "Persist Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    saveSpy.mockClear();

    // When
    await component.update("es-persist-1", { interval: 9999 });

    // Then
    expect(saveSpy).toHaveBeenCalled();
  });

  test("可以同时更新多个字段", async () => {
    // Given
    component.register({
      id: "es-multi-1",
      name: "Old Name",
      type: "timer",
      enabled: true,
      interval: 1000,
    });

    // When
    const result = await component.update("es-multi-1", {
      name: "New Name",
      interval: 7777,
      enabled: false,
    });

    // Then
    expect(result.updated.name).toBe("New Name");
    expect(result.updated.interval).toBe(7777);
    expect(result.updated.enabled).toBe(false);
  });

  test("空 partial 抛出明确错误", async () => {
    // Given
    component.register({
      id: "es-empty-1",
      name: "Empty Test",
      type: "timer",
      enabled: true,
      interval: 1000,
    });

    // When/Then
    await expect(component.update("es-empty-1", {})).rejects.toThrow(
      /partial must not be empty/,
    );
  });
});
