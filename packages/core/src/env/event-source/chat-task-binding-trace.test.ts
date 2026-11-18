/**
 * @fileoverview Task #4023 — chat↔task 绑定链路的 @TracedAs 可观测性测试
 *
 * 目的：把评审要求的"方便调试 / 检测验证"固化成自动化断言。整条链路的关键节点
 * 都必须产生带命名属性的 span，才能用 `roy-bot debug trace` / `debug span`
 * 快速定位断链在哪一环：
 *
 *   write:   per-task-group-chat.writeChatBinding   (taskId/chatId/status)
 *   persist: session.upsertChatTaskBinding          (chatId/taskId/status/rebindCount)
 *   read:    lark-cli.resolveChatTaskBinding        (chatId → resolvedTaskId)
 *   map:     env-context.resolveEnvParentTaskId     (parentTaskId)
 *
 * 若某个 span 缺失或其属性为 null，即可判定该环节未生效（例如 P0 断链时
 * resolveEnvParentTaskId 的 parentTaskId 会是 null）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  OTelTracerProvider,
  setTracerProvider,
  resetTracerProvider,
} from "../log-trace/opentelemetry/tracer-provider";
import { SQLiteSpanStorage } from "../log-trace/span-storage";
import type { Span } from "../log-trace/types";

import { resolveEnvParentTaskId } from "../context";
import { LarkCliInstance } from "./event-source-handlers";
import { createPerTaskGroupChatPlugin } from "../task/plugins/per-task-group-chat-plugin";
import { SessionComponent } from "../session/session-component";
import { MemorySessionStore } from "../session/storage";

// ============================================================================
// Span helpers
// ============================================================================

function flattenSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  const walk = (n: Span) => {
    out.push(n);
    if (n.children) for (const c of n.children) walk(c);
  };
  for (const s of spans) walk(s);
  return out;
}

function collectAllSpans(storage: SQLiteSpanStorage): Span[] {
  const traces = storage.listTraces(1000);
  const out: Span[] = [];
  for (const t of traces) {
    out.push(...flattenSpans(storage.findByTraceId(t.traceId)));
  }
  return out;
}

function findBySuffix(storage: SQLiteSpanStorage, suffix: string): Span | undefined {
  return collectAllSpans(storage).find((s) => s.name === suffix);
}

const flush = () => new Promise((r) => setTimeout(r, 60));

let tempDir: string;
let storage: SQLiteSpanStorage;
let provider: OTelTracerProvider;

beforeEach(async () => {
  resetTracerProvider();
  tempDir = mkdtempSync(join(tmpdir(), "chat-task-binding-trace-"));
  storage = new SQLiteSpanStorage(join(tempDir, "spans.db"));
  provider = new OTelTracerProvider(storage);
  await provider.initialize();
  setTracerProvider(provider);
});

afterEach(() => {
  resetTracerProvider();
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
});

describe("Task #4023 — chat↔task binding @TracedAs observability", () => {
  it("env-context.resolveEnvParentTaskId 暴露 parentTaskId 属性", async () => {
    const resolved = resolveEnvParentTaskId({ metadata: { parentTaskId: 8888 } });
    expect(resolved).toBe(8888);
    await flush();

    const span = findBySuffix(storage, "env-context.resolveEnvParentTaskId");
    expect(span).toBeDefined();
    expect(span!.attributes["parentTaskId"]).toBe(8888);
  });

  it("resolveEnvParentTaskId 无绑定时 parentTaskId=null（可检测断链）", async () => {
    resolveEnvParentTaskId({ metadata: {} });
    await flush();

    const span = findBySuffix(storage, "env-context.resolveEnvParentTaskId");
    expect(span).toBeDefined();
    expect(span!.attributes["parentTaskId"]).toBe(null);
  });

  it("lark-cli.resolveChatTaskBinding 暴露 chatId → resolvedTaskId", async () => {
    const session = {
      getChatTaskBinding: async (chatId: string) =>
        chatId === "oc_trace"
          ? {
              chatId,
              taskId: 4242,
              profile: "default",
              boundAt: "2026-10-09T00:00:00Z",
              status: "ready" as const,
              errorMessage: null,
              rebindCount: 0,
            }
          : null,
    };
    const instance = new LarkCliInstance({
      id: "es-trace",
      name: "trace",
      type: "lark-cli",
      enabled: true,
    });
    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    const resolved = await (instance as any).resolveChatTaskBinding("oc_trace");
    expect(resolved).toBe(4242);
    await flush();

    const span = findBySuffix(storage, "lark-cli.resolveChatTaskBinding");
    expect(span).toBeDefined();
    expect(span!.attributes["chatId"]).toBe("oc_trace");
    expect(span!.attributes["resolvedTaskId"]).toBe(4242);
  });

  it("per-task-group-chat.writeChatBinding 暴露 taskId/chatId/status", async () => {
    const plugin = createPerTaskGroupChatPlugin({ sourceId: "es-trace", pluginName: "P" });
    (plugin as any).setSessionComponent({
      upsertChatTaskBinding: async () => ({}),
    });

    await (plugin as any).writeChatBinding(
      { id: 77, title: "t", context: "{}" },
      "oc_write_trace",
      "default",
      "ready"
    );
    await flush();

    const span = findBySuffix(storage, "per-task-group-chat.writeChatBinding");
    expect(span).toBeDefined();
    expect(span!.attributes["taskId"]).toBe(77);
    expect(span!.attributes["chatId"]).toBe("oc_write_trace");
    expect(span!.attributes["status"]).toBe("ready");
  });

  it("session.upsertChatTaskBinding 暴露落库结果属性", async () => {
    const component = new SessionComponent();
    (component as any).store = new MemorySessionStore();
    (component as any).hooksConfig = {};

    const binding = await component.upsertChatTaskBinding({
      chatId: "oc_session_trace",
      taskId: 1234,
      status: "ready",
    });
    expect(binding.taskId).toBe(1234);
    await flush();

    const span = findBySuffix(storage, "session.upsertChatTaskBinding");
    expect(span).toBeDefined();
    expect(span!.attributes["chatId"]).toBe("oc_session_trace");
    expect(span!.attributes["taskId"]).toBe(1234);
    expect(span!.attributes["status"]).toBe("ready");
    expect(span!.attributes["rebindCount"]).toBe(0);
  });

  it("session.getChatTaskBinding 暴露 found/taskId/status（读侧诊断）", async () => {
    const component = new SessionComponent();
    (component as any).store = new MemorySessionStore();
    (component as any).hooksConfig = {};

    await component.getChatTaskBinding("oc_missing_trace");
    await flush();

    const span = findBySuffix(storage, "session.getChatTaskBinding");
    expect(span).toBeDefined();
    expect(span!.attributes["found"]).toBe(false);
    expect(span!.attributes["taskId"]).toBe(null);
  });
});
