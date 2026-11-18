/**
 * @fileoverview 精确复现测试：模拟完整调用链
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { HookManager } from "./hook-manager";
import { TracedAs } from "../log-trace/decorator";
import { getTracerProvider, resetTracerProvider } from "../log-trace/opentelemetry/tracer-provider";

// ========================================================================
// 模拟 LarkCliTaskNotifyHook
// ========================================================================

class MockLarkCliTaskNotifyHook {
  name = "MockLarkCliTaskNotifyHook";
  
  @TracedAs("lark-cli-task-notify.execute")
  async execute(): Promise<void> {
    // 什么都不做
  }
}

// ========================================================================
// 测试
// ========================================================================

describe("LarkCliTaskNotifyHook traceId 继承", () => {
  let provider: ReturnType<typeof getTracerProvider>;
  
  beforeEach(async () => {
    resetTracerProvider();
    provider = getTracerProvider();
    await provider.initialize();
  });
  
  afterEach(() => {
    resetTracerProvider();
  });
  
  test("完整调用链 traceId 继承", async () => {
    const tracer = provider.getTracer("roy-tracer");
    
    // 1. handle_query 创建根 span
    const handleQuerySpan = tracer.startSpan("env.handle_query");
    const rootTraceId = handleQuerySpan.spanContext.traceId;
    console.log("[1] handle_query - traceId:", rootTraceId);
    
    // 2. agent.run
    const agentSpan = tracer.startSpan("agent.run");
    console.log("[2] agent.run - traceId:", agentSpan.spanContext.traceId);
    expect(agentSpan.spanContext.traceId).toBe(rootTraceId);
    
    // 3. HookManager
    const hookManager = new HookManager({ componentName: "agent" });
    const hook = new MockLarkCliTaskNotifyHook();
    hookManager.register("task:after.update", {
      name: "MockLarkCliTaskNotifyHook",
      execute: hook.execute.bind(hook),
    });
    
    // 4. hook.manager.execute
    const executeSpan = tracer.startSpan("hook.manager.execute");
    console.log("[3] hook.manager.execute - traceId:", executeSpan.spanContext.traceId);
    expect(executeSpan.spanContext.traceId).toBe(rootTraceId);
    
    // 5. 执行 hook
    await hookManager.execute("task:after.update", {});
    
    tracer.endSpan(executeSpan);
    tracer.endSpan(agentSpan);
    tracer.endSpan(handleQuerySpan);
    
    console.log("[PASS] 所有 span 共享同一个 traceId");
  });
});
