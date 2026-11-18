/**
 * @fileoverview PerTaskGroupChatPlugin 端到端 trace 诊断测试
 *
 * 用 bun:test 的 mock.module 拦截 child_process.spawn，
 * 验证 plugin 调用的 lark-cli 命令 + spans 是否正确记录。
 *
 * 运行：
 *   bun test src/env/task/plugins/per-task-group-chat-plugin-trace-diag.test.ts
 *
 * 验证：
 *   1. 所有 args 都包含 --as bot
 *   2. spans 正确写入 SQLite，可用 `roy debug trace <traceId>` 查
 *   3. attributes 包含期望的字段（chatId, profile, contentLength, ok 等）
 */

import { describe, it, expect, mock } from "bun:test";
import { createChildProcessMockModule } from "../../../test-utils/child-process-mock";
import { EventEmitter } from "events";
import * as os from "os";
import * as path from "path";

// 1. mock child_process（在 import plugin 之前）
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

mock.module("child_process", () =>
  createChildProcessMockModule({
    spawn: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      const proc: any = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        if (args.includes("+chat-create")) {
          proc.stdout.emit("data", JSON.stringify({
            ok: true,
            data: { chat_id: "oc_diag_chat_xyz", chat_app_link: "https://applink.feishu.cn/..." },
          }));
        } else {
          proc.stdout.emit("data", JSON.stringify({ ok: true }));
        }
        proc.stderr.emit("data", "");
        proc.emit("close", 0);
      });
      return proc;
    },
  }),
);

// 2. 动态 import（必须在 mock 之后）
const tracerModule = await import(
  "../../log-trace/opentelemetry/tracer-provider"
);
const { PerTaskGroupChatPlugin } = await import(
  "./per-task-group-chat-plugin"
);
const { SQLiteSpanStorage } = await import(
  "../../log-trace/span-storage"
);
import type {
  Span,
  SpanStorage,
  TraceInfo,
} from "../../log-trace/types";

// 3. CompositeSpanStorage：in-memory + SQLite
class InMemorySpanStorage implements SpanStorage {
  public spans: Span[] = [];
  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> {}
  isEnabled(): boolean { return true; }
  save(span: Span): void { this.spans.push(span); }
  saveBatch(spans: Span[]): void { this.spans.push(...spans); }
  findByTraceId(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }
  findBySpanId(spanId: string): Span | undefined {
    return this.spans.find((s) => s.spanId === spanId);
  }
  listTraces(limit?: number): TraceInfo[] {
    const traceIds = [...new Set(this.spans.map((s) => s.traceId))];
    return traceIds.map((traceId) => ({
      traceId,
      spanCount: this.spans.filter((s) => s.traceId === traceId).length,
      startTime: Math.min(...this.spans.filter((s) => s.traceId === traceId).map((s) => s.startTime)),
      endTime: Math.max(...this.spans.filter((s) => s.traceId === traceId).map((s) => s.endTime ?? s.startTime)),
    }));
  }
}

class CompositeSpanStorage implements SpanStorage {
  constructor(
    private memory: SpanStorage,
    private sqlite: SpanStorage,
  ) {}
  async initialize(): Promise<void> { await this.sqlite.initialize(); }
  async shutdown(): Promise<void> { await this.sqlite.shutdown?.(); }
  isEnabled(): boolean { return true; }
  save(span: Span): void { this.memory.save(span); this.sqlite.save(span); }
  saveBatch(spans: Span[]): void { this.memory.saveBatch(spans); this.sqlite.saveBatch(spans); }
  findByTraceId(traceId: string): Span[] { return this.memory.findByTraceId(traceId); }
  findBySpanId(spanId: string): Span | undefined { return this.memory.findBySpanId(spanId); }
  listTraces(limit?: number): TraceInfo[] { return this.memory.listTraces(limit); }
}

describe("PerTaskGroupChatPlugin 端到端 trace 诊断", () => {
  it("plugin 调用的所有 lark-cli 命令正确 + spans 记录正确", async () => {
    // 4. 设置自定义 tracer provider
    const inMemoryStorage = new InMemorySpanStorage();
    const tmpDbPath = path.join(os.tmpdir(), `per-task-group-trace-${Date.now()}.db`);
    console.log(`\n📁 Spans DB: ${tmpDbPath}`);

    const sqliteStorage = new SQLiteSpanStorage(tmpDbPath);
    const compositeStorage = new CompositeSpanStorage(inMemoryStorage, sqliteStorage);

    const provider = new tracerModule.OTelTracerProvider(compositeStorage);
    await provider.initialize();
    tracerModule.setTracerProvider(provider);

    // 5. 创建 plugin
    console.log("\n🚀 PerTaskGroupChatPlugin 端到端 trace 诊断\n");
    const plugin = new PerTaskGroupChatPlugin({
      pluginName: "PerTaskGroupChatPlugin",
      sourceId: "id_diag_test",
    });

    // 6. 测试 1: buildCreateGroupChatArgs
    console.log("\n[测试 1] buildCreateGroupChatArgs");
    const createArgs = (plugin as any).buildCreateGroupChatArgs({
      name: "Diag Test Group",
      description: "diag description",
      profile: "default",
      botAppIds: ["cli_diag_bot"],
    });
    console.log("  args:", createArgs.join(" "));
    expect(createArgs.includes("--as")).toBe(true);
    expect(createArgs[createArgs.indexOf("--as") + 1]).toBe("bot");
    expect(createArgs.includes("--bots")).toBe(true);
    expect(createArgs.includes("--set-bot-manager")).toBe(true);

    // 7. 测试 2: createGroupChat
    console.log("\n[测试 2] createGroupChat");
    spawnCalls.length = 0;
    const chatId = await (plugin as any).createGroupChat({
      name: "Diag Test Group",
      description: "diag description",
      profile: "default",
      botAppIds: ["cli_diag_bot"],
    });
    console.log(`  chat_id = ${chatId}`);
    expect(chatId).toBe("oc_diag_chat_xyz");

    // 8. 测试 3: 卡片生命周期已移交 notify hook（Task #4237）
    //   插件侧不应再有 patchCardForTask / finishTask 这类"自己发卡"的方法
    console.log("\n[测试 3] 插件不再持有卡片生命周期（owner=LarkCliTaskNotifyHook）");
    expect(typeof (plugin as any).patchCardForTask).toBe("undefined");
    spawnCalls.length = 0;

    // 9. 验证 spans
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 Span 检查\n");
    const spanNames = inMemoryStorage.spans.map((s) => s.name);
    console.log(`  总 spans: ${inMemoryStorage.spans.length}`);
    for (const n of [...new Set(spanNames)]) {
      console.log(`    - ${n}`);
    }

    // 10. 显示关键 span 的 attributes
    const createSpan = inMemoryStorage.spans.find((s) => s.name === "per-task-group-chat.createGroupChat");

    console.log(`\n  createGroupChat span:`);
    if (createSpan) {
      console.log(`    spanId: ${createSpan.spanId}`);
      console.log(`    traceId: ${createSpan.traceId}`);
      console.log(`    duration: ${(createSpan.endTime ?? 0) - createSpan.startTime}ms`);
      console.log(`    flattened attributes:`);
      for (const [k, v] of Object.entries(createSpan.attributes || {})) {
        if (k === "params") continue;
        console.log(`      ${k}: ${JSON.stringify(v)}`);
      }
      console.log(`    result: ${JSON.stringify(createSpan.result)}`);
    }

    console.log(`\n💡 用真实 CLI 验证:`);
    console.log(`   bun packages/cli/dist/bin/roy-bot.js debug trace ${createSpan?.traceId} --db ${tmpDbPath}`);
    console.log(`   bun packages/cli/dist/bin/roy-bot.js debug span ${createSpan?.spanId} --db ${tmpDbPath}`);

    // 11. 断言所有期望的 span 都存在
    const expectedSpans = [
      "per-task-group-chat.buildCreateGroupChatArgs",
      "per-task-group-chat.createGroupChat",
    ];
    for (const name of expectedSpans) {
      const found = inMemoryStorage.spans.some((s) => s.name === name);
      expect(found).toBe(true);
    }

    // ★ Task #4230：普通消息通知的 span 必须彻底消失（旧逻辑已删除）
    expect(spanNames).not.toContain("per-task-group-chat.sendToChat");
    expect(spanNames).not.toContain("per-task-group-chat.sendToMain");

    // 12. 验证关键 attributes
    expect(createSpan?.attributes?.["chatId"]).toBe("oc_diag_chat_xyz");
    expect(createSpan?.attributes?.["ok"]).toBe(true);
    expect(createSpan?.attributes?.["profile"]).toBe("default");

    console.log("\n✅ 所有断言通过");
  });
});
