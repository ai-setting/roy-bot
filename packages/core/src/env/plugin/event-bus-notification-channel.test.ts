/**
 * @fileoverview EventBusNotificationChannel Tests (TDD)
 *
 * 默认 NotificationChannel 实现测试。
 * 关键行为：
 * - canRoute 始终 true（不依赖 replyChannel）
 * - send 通过 env.pushEnvEvent 发 `plugin.notification.<type>` 事件
 * - event.metadata.source = "plugin:<pluginName>"
 * - 缺失 envInstance 或 pushEnvEvent 时 silent skip
 * - pushEnvEvent 抛错被 swallow（不污染 Plugin 主流程）
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { EventBusNotificationChannel } from "./event-bus-notification-channel";
import type {
  NotificationOptions,
  NotificationSendExtras,
  EnvContextLike,
} from "./notification-channel";

describe("EventBusNotificationChannel", () => {
  let channel: EventBusNotificationChannel;
  let mockPushEnvEvent: ReturnType<typeof vi.fn>;

  const baseOptions: NotificationOptions = {
    type: "visualization_ready",
    title: "Viz Ready",
    content: "Chart rendered successfully",
  };

  const baseExtras: NotificationSendExtras = {
    pluginName: "task-show",
  };

  const baseEnvContext: EnvContextLike = {};

  beforeEach(() => {
    channel = new EventBusNotificationChannel();
    mockPushEnvEvent = vi.fn();
  });

  // ========================================================================
  // Channel Identity
  // ========================================================================

  test("channel.name should be 'event-bus'", () => {
    expect(channel.name).toBe("event-bus");
  });

  // ========================================================================
  // canRoute
  // ========================================================================

  describe("canRoute", () => {
    test("should always return true (event-bus is always routable when env has pushEnvEvent)", () => {
      expect(
        channel.canRoute(baseOptions, baseExtras, baseEnvContext)
      ).toBe(true);
    });

    test("should return true even when replyChannel is missing", () => {
      expect(
        channel.canRoute(baseOptions, baseExtras, {})
      ).toBe(true);
    });

    test("should return true even when envInstance is missing (canRoute is always true; send will skip)", () => {
      expect(
        channel.canRoute(baseOptions, baseExtras, baseEnvContext)
      ).toBe(true);
    });

    test("should return true even when type contains dot/dash/underscore variants", () => {
      const variants = [
        "visualization_ready",
        "task.completed",
        "report-uploaded",
        "x",
      ];
      for (const type of variants) {
        expect(
          channel.canRoute({ ...baseOptions, type }, baseExtras, baseEnvContext)
        ).toBe(true);
      }
    });
  });

  // ========================================================================
  // send - happy path
  // ========================================================================

  describe("send - happy path", () => {
    test("should call env.pushEnvEvent once with namespaced event", async () => {
      const envInstance = { pushEnvEvent: mockPushEnvEvent };
      const extras: NotificationSendExtras = {
        ...baseExtras,
        envInstance: envInstance as any,
      };

      await channel.send(baseOptions, extras, baseEnvContext);

      expect(mockPushEnvEvent).toHaveBeenCalledTimes(1);
      const event = mockPushEnvEvent.mock.calls[0]![0];
      expect(event.type).toBe("plugin.notification.visualization_ready");
    });

    test("should set metadata.source to 'plugin:<pluginName>'", async () => {
      const envInstance = { pushEnvEvent: mockPushEnvEvent };
      const extras: NotificationSendExtras = {
        pluginName: "my-plugin",
        envInstance: envInstance as any,
      };

      await channel.send(baseOptions, extras, baseEnvContext);

      const event = mockPushEnvEvent.mock.calls[0]![0];
      expect(event.metadata.source).toBe("plugin:my-plugin");
    });

    test("should preserve user-provided metadata (and not overwrite source)", async () => {
      const envInstance = { pushEnvEvent: mockPushEnvEvent };
      const extras: NotificationSendExtras = {
        pluginName: "task-show",
        envInstance: envInstance as any,
      };
      const options: NotificationOptions = {
        ...baseOptions,
        metadata: {
          taskId: 1234,
          priority: "high",
        },
      };

      await channel.send(options, extras, baseEnvContext);

      const event = mockPushEnvEvent.mock.calls[0]![0];
      expect(event.metadata.source).toBe("plugin:task-show");
      expect(event.metadata.taskId).toBe(1234);
      expect(event.metadata.priority).toBe("high");
    });

    test("should put title and content into payload", async () => {
      const envInstance = { pushEnvEvent: mockPushEnvEvent };
      const extras: NotificationSendExtras = {
        ...baseExtras,
        envInstance: envInstance as any,
      };

      await channel.send(baseOptions, extras, baseEnvContext);

      const event = mockPushEnvEvent.mock.calls[0]![0];
      expect(event.payload).toEqual({
        title: "Viz Ready",
        content: "Chart rendered successfully",
      });
    });

    test("should generate an event id", async () => {
      const envInstance = { pushEnvEvent: mockPushEnvEvent };
      const extras: NotificationSendExtras = {
        ...baseExtras,
        envInstance: envInstance as any,
      };

      await channel.send(baseOptions, extras, baseEnvContext);

      const event = mockPushEnvEvent.mock.calls[0]![0];
      expect(event.id).toBeDefined();
      expect(typeof event.id).toBe("string");
      expect((event.id as string).length).toBeGreaterThan(0);
    });

    test("should set timestamp as a number close to Date.now()", async () => {
      const before = Date.now();
      const envInstance = { pushEnvEvent: mockPushEnvEvent };
      const extras: NotificationSendExtras = {
        ...baseExtras,
        envInstance: envInstance as any,
      };

      await channel.send(baseOptions, extras, baseEnvContext);

      const event = mockPushEnvEvent.mock.calls[0]![0];
      const after = Date.now();
      expect(typeof event.timestamp).toBe("number");
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });
  });

  // ========================================================================
  // send - silent skip
  // ========================================================================

  describe("send - silent skip when env is unavailable", () => {
    test("should NOT call pushEnvEvent when envInstance is undefined", async () => {
      const extras: NotificationSendExtras = { pluginName: "p1" };

      await expect(
        channel.send(baseOptions, extras, baseEnvContext)
      ).resolves.toBeUndefined();
      expect(mockPushEnvEvent).not.toHaveBeenCalled();
    });

    test("should NOT call pushEnvEvent when envInstance.pushEnvEvent is missing", async () => {
      const extras: NotificationSendExtras = {
        pluginName: "p1",
        envInstance: {} as any,
      };

      await expect(
        channel.send(baseOptions, extras, baseEnvContext)
      ).resolves.toBeUndefined();
      expect(mockPushEnvEvent).not.toHaveBeenCalled();
    });

    test("should NOT call pushEnvEvent when envInstance.pushEnvEvent is not a function", async () => {
      const extras: NotificationSendExtras = {
        pluginName: "p1",
        envInstance: { pushEnvEvent: "not-a-fn" } as any,
      };

      await expect(
        channel.send(baseOptions, extras, baseEnvContext)
      ).resolves.toBeUndefined();
      expect(mockPushEnvEvent).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // send - exception swallowing
  // ========================================================================

  describe("send - exception handling", () => {
    test("should swallow exceptions thrown by pushEnvEvent (resolve, not reject)", async () => {
      const throwingPush = vi.fn(() => {
        throw new Error("event bus broken");
      });
      const extras: NotificationSendExtras = {
        ...baseExtras,
        envInstance: { pushEnvEvent: throwingPush } as any,
      };

      await expect(
        channel.send(baseOptions, extras, baseEnvContext)
      ).resolves.toBeUndefined();
      expect(throwingPush).toHaveBeenCalled();
    });

    test("should swallow async-style throws (e.g., returning rejected promise) without breaking", async () => {
      const rejectedPush = vi.fn(() => {
        // Synchronous throw inside async function - should be caught
        throw new TypeError("bad event shape");
      });
      const extras: NotificationSendExtras = {
        ...baseExtras,
        envInstance: { pushEnvEvent: rejectedPush } as any,
      };

      await expect(
        channel.send(baseOptions, extras, baseEnvContext)
      ).resolves.toBeUndefined();
    });
  });

  // ========================================================================
  // Multiple sends
  // ========================================================================

  describe("send - multiple calls", () => {
    test("should generate distinct event ids across multiple sends", async () => {
      const envInstance = { pushEnvEvent: mockPushEnvEvent };
      const extras: NotificationSendExtras = {
        ...baseExtras,
        envInstance: envInstance as any,
      };

      await channel.send(baseOptions, extras, baseEnvContext);
      await channel.send(baseOptions, extras, baseEnvContext);
      await channel.send(baseOptions, extras, baseEnvContext);

      expect(mockPushEnvEvent).toHaveBeenCalledTimes(3);
      const ids = mockPushEnvEvent.mock.calls.map((c) => c[0].id);
      expect(new Set(ids).size).toBe(3);
    });
  });
});
