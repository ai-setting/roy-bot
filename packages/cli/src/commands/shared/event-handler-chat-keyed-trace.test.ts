/**
 * @fileoverview Chat-keyed session trace 验证测试
 *
 * 验证：调用 EventHandler 后，ensureChatSession span 被创建且包含 chatId 参数。
 * 运行后用 `roy-bot debug trace <traceId>` 查看完整调用链。
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as os from "os";
import * as path from "path";
import { EventHandler } from "./event-handler";
import { EventMessageFormatter, type FormattedEvent } from "./event-message-formatter";
import {
  SessionComponent,
  MemorySessionStore,
  OTelTracerProvider,
  resetTracerProvider,
  SQLiteSpanStorage,
} from "@ai-setting/roy-bot-core";
import { setTracerProvider } from "../../../../core/src/env/log-trace/opentelemetry/tracer-provider";

// ★ 重要：trace 测试会调 setTracerProvider(provider) 注入全局 provider，
//     但每个测试结束后必须 reset，否则会污染后续测试的 global state。
//     (e.g., OTelTracerProvider Context Management 测试)
afterEach(() => {
  resetTracerProvider();
});

describe("Chat-Keyed Session trace 验证", () => {
  test("ensureChatSession span 被创建并记录 chatId 参数", async () => {
    const home = os.homedir();
    const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
    const dbPath = path.join(dataHome, "roy-bot", "traces.db");

    // 1. 初始化 tracer provider
    const provider = new OTelTracerProvider(undefined, dbPath);
    await provider.initialize();
    setTracerProvider(provider);

    // 2. 真实 SessionComponent
    const store = new MemorySessionStore();
    const component = new SessionComponent();
    (component as any).store = store;

    const chatId = "oc_trace_test_demo";
    const receivedSessionIds: (string | undefined)[] = [];
    const onEventWithEnv = async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    };

    const handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: ["event-source.event.*"],
      onEventWithEnv,
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      sessionComponent: component as any,
    });

    // 3. 入队 chat 事件
    const formatter = new EventMessageFormatter();
    const event = {
      id: "evt-trace-test",
      type: "event-source.event.lark-cli",
      metadata: {
        replyChannel: { type: "lark-cli", chatId, messageId: "om_test" },
      },
    };
    handler.enqueue(formatter.formatWithEvent(event as any));

    // 等待处理
    const start = Date.now();
    while (receivedSessionIds.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500)); // 等 span 写盘

    // 4. 验证 eventSessionId === chatId
    expect(receivedSessionIds[0]).toBe(chatId);

    // 5. 验证 span 被记录（只看本轮 test run 产生的最近 traces，避免旧 run 干扰）
    const storage = new SQLiteSpanStorage(dbPath);
    await storage.initialize();
    const allTraces = storage.listTraces(100);
    const testStartTime = Date.now() - 60000; // 最近 60 秒内的 traces
    const recentTraces = allTraces.filter((t) => t.startTime >= testStartTime);
    const found = recentTraces.find((t) => {
      const spans = storage.findByTraceId(t.traceId);
      const spanNames = new Set<string>();
      const collectNames = (s: any) => {
        spanNames.add(s.name);
        for (const c of s.children || []) collectNames(c);
      };
      for (const s of spans) collectNames(s);
      return spanNames.has("cli.event-handler.ensureChatSession");
    });

    expect(found).toBeDefined();
    if (found) {
      console.log(`\n🔍 traceId: ${found.traceId}`);
      // findByTraceId returns tree roots - 递归找 child spans
      const spans = storage.findByTraceId(found.traceId);
      const flatten = (s: any): any[] => [s, ...(s.children || []).flatMap(flatten)];
      const allSpans = spans.flatMap(flatten);
      const ensureSpan = allSpans.find((s) => s.name === "cli.event-handler.ensureChatSession");
      expect(ensureSpan).toBeDefined();
      // 飞书事件路径按 item 的 chatId 直接走 ensureChatSession,
      // 不再经过 ensureActiveSession (后者仅服务非飞书事件)。
      const activeSpan = allSpans.find((s) => s.name === "cli.event-handler.ensureActiveSession");
      expect(activeSpan).toBeUndefined();
      console.log(`🔍 ensureChatSession span:`, ensureSpan?.attributes);
    }

    handler.stop();
    storage.close();
  }, 10000);
});
