/**
 * @fileoverview LarkCli event 去重测试 (Task #3977/3978)
 *
 * 根因：
 * - lark-cli event consume 偶尔把同一条 JSON 事件同时写到 stdout 和 stderr
 *   （race condition / reconnect 重发）
 * - roy-bot 之前的 LarkCliInstance.handleEvent 没有去重
 *   → 同一个 event_id 被 dispatch 两次
 *   → 主 agent + sub-agent 都创建同名 task（用户看到 2 个 task）
 *
 * 修复：在 LarkCliInstance 内加 LRU dedup，
 * 同一 instance 内 60s 内相同 event_id 视为重复并跳过。
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { LarkCliInstance } from "./event-source-handlers";
import type { EventSourceConfig, EventSourceEventHandler } from "./types";

describe("LarkCli event dedup (Task #3977/3978)", () => {
  let config: EventSourceConfig;
  let instance: LarkCliInstance;
  let dispatchedEvents: number;

  beforeEach(() => {
    config = {
      id: "es-test",
      name: "dedup test",
      type: "lark-cli",
      enabled: true,
      command: "lark-cli --profile default event consume im.message.receive_v1 --as bot",
    };
    instance = new LarkCliInstance(config);
    dispatchedEvents = 0;

    const handler: EventSourceEventHandler = mock(() => {
      dispatchedEvents++;
    });
    instance.onEvent(handler);
  });

  /**
   * 构造一个飞书 im.message.receive_v1 事件的 rawData 字符串
   */
  function makeRawData(eventId: string): string {
    return JSON.stringify({
      type: "im.message.receive_v1",
      event_id: eventId,
      timestamp: "1790579077976",
      id: `om_msg_${eventId}`,
      message_id: `om_msg_${eventId}`,
      chat_id: "oc_chat_X",
      chat_type: "p2p",
      message_type: "text",
      sender_id: { open_id: "ou_user_X" },
      sender_type: "user",
      content: "委托roy新建一个任务",
    });
  }

  /**
   * 直接调用 private handleEvent（绕过 processStream buffer 逻辑）
   *
   * ★ Task #4023: handleEvent 现在是 async（要 await sessionComponent.getChatTaskBinding），
   *   所以 callHandle 也变成 async。tests 里 await callHandle()。
   */
  async function callHandle(rawData: string): Promise<void> {
    await (instance as unknown as { handleEvent: (s: string) => Promise<void> }).handleEvent(rawData);
  }

  test("第一次收到 event_id 应该正常 dispatch", async () => {
    await callHandle(makeRawData("evt_001"));
    expect(dispatchedEvents).toBe(1);
  });

  test("60s 内重复同一 event_id 应该被去重（不 dispatch）", async () => {
    const raw = makeRawData("evt_002");
    await callHandle(raw);
    expect(dispatchedEvents).toBe(1);

    // 模拟 race：同一 rawData 在 1ms 后再触发一次
    await callHandle(raw);
    expect(dispatchedEvents).toBe(1); // ★ 第二次被去重

    await callHandle(raw);
    expect(dispatchedEvents).toBe(1); // ★ 第三次也被去重
  });

  test("不同 event_id 应该独立 dispatch（不去重）", async () => {
    await callHandle(makeRawData("evt_A"));
    await callHandle(makeRawData("evt_B"));
    await callHandle(makeRawData("evt_C"));
    expect(dispatchedEvents).toBe(3);
  });

  test("非 JSON rawData 不应该被去重（fallback 路径要能工作）", async () => {
    // processStream 在 JSON.parse 失败时会用 fallback 路径
    // 这种 rawData 没有 event_id 字段，不进 dedup
    const nonJson = "some non-json log line";
    await callHandle(nonJson);
    await callHandle(nonJson);
    // 两次都被处理（fallback 路径不依赖 event_id）
    expect(dispatchedEvents).toBe(2);
  });

  test("event_id 在 header.event_id 时也应该去重（v2 飞书事件格式）", async () => {
    const rawV2 = JSON.stringify({
      schema: "2.0",
      header: {
        event_type: "im.message.receive_v1",
        event_id: "evt_header_001",
        app_id: "cli_xxx",
      },
      event: {
        message: {
          message_id: "om_v2",
          chat_id: "oc_chat",
        },
      },
    });
    await callHandle(rawV2);
    await callHandle(rawV2);
    expect(dispatchedEvents).toBe(1);
  });

  test("LRU dedup 不会因高频事件 OOM（超过 DEDUP_MAX_SIZE 时清理）", async () => {
    // 推 110 个不同 event_id，超过 DEDUP_MAX_SIZE=100
    // 不会崩，dispatch 计数 == 110（没有触发 dedup，因为 event_id 都不同）
    for (let i = 0; i < 110; i++) {
      await callHandle(makeRawData(`evt_unique_${i.toString().padStart(3, "0")}`));
    }
    expect(dispatchedEvents).toBe(110);

    // 触发一次 cleanup（再加 5 个，让 size 超过 100）
    for (let i = 0; i < 5; i++) {
      await callHandle(makeRawData(`evt_more_${i.toString().padStart(3, "0")}`));
    }
    // 没有 OOM = 测试通过
    expect(dispatchedEvents).toBe(115);
  });
});
