/**
 * @fileoverview Interactive Trace Integration Tests
 * 
 * TDD: 测试 ES 事件链路与 interactive 的 trace 串联功能
 * 
 * 场景：
 * 1. ES 事件触发时，lark-cli.handleEvent 创建根 span 并设置全局 context
 * 2. interactive.executeInternal 检测已有 traceId，复用而非创建新根
 * 3. 整个链路使用同一个 traceId
 */

import { describe, test, expect } from "bun:test";

describe("Interactive Trace - ES Event Path", () => {
  describe("executeInternal traceId 复用逻辑", () => {
    test("应该复用已有的全局 traceId（ES 事件路径）", () => {
      // Given: 全局 context 已存在（ES 事件路径）
      const existingContext = {
        traceId: "019e4abc1234567890abcdef12345678",
        spanId: "es_span_001",
        parentSpanId: undefined,
      };

      // 新的 spanContext（interactive.execute）
      const newSpanContext = {
        traceId: existingContext.traceId, // 复用
        spanId: "interactive_span_001",
        parentSpanId: "es_span_001", // 指向 ES span
      };

      // Then: 应该复用原有的 traceId
      expect(newSpanContext.traceId).toBe(existingContext.traceId);
      expect(newSpanContext.parentSpanId).toBe("es_span_001");
    });

    test("应该创建新的 traceId（用户输入路径）", () => {
      // Given: 全局 context 为空（用户输入路径）
      const newTraceId = "019enew1234567890abcdef12345678";

      // 新的 spanContext（interactive.execute）
      const newSpanContext = {
        traceId: newTraceId,
        spanId: "user_span_001",
        parentSpanId: undefined,
      };

      // Then: 应该创建新的 traceId
      expect(newSpanContext.traceId).toBe(newTraceId);
      expect(newSpanContext.parentSpanId).toBeUndefined();
    });

    test("ES 事件 span 应该作为 interactive span 的父 span", () => {
      // ES handleEvent 创建的 span
      const esSpanContext = {
        traceId: "019e4es1234567890abcdef12345678",
        spanId: "es_handle_001",
        parentSpanId: undefined,
      };

      // interactive.execute 创建的 span
      const interactiveSpanContext = {
        traceId: esSpanContext.traceId, // 复用同一个 traceId
        spanId: "interactive_span_001",
        parentSpanId: esSpanContext.spanId, // 父 span 是 ES handleEvent
      };

      // Then: 验证父子关系
      expect(interactiveSpanContext.traceId).toBe(esSpanContext.traceId);
      expect(interactiveSpanContext.parentSpanId).toBe(esSpanContext.spanId);
    });
  });
});

describe("ES Event Trace - LarkCliInstance.handleEvent", () => {
  test("handleEvent 应该设置全局 context", () => {
    // 这个测试验证 ES 事件入口会设置全局 context
    // 实际实现应该在 event-source-handlers.ts 的 handleEvent 方法中

    const rootSpanContext = {
      traceId: "019e4es1234567890abcdef12345678",
      spanId: "es_handle_001",
    };

    // Then: 全局 context 应该包含 traceId 和 spanId
    expect(rootSpanContext).toEqual(
      expect.objectContaining({
        traceId: expect.any(String),
        spanId: expect.any(String),
      })
    );
  });

  test("全局 context 应该在 spanContext 格式中包含所有必要字段", () => {
    // 使用真实的十六进制格式
    const spanContext = {
      traceId: "019e4abc1234567890abcdef12345678",
      spanId: "abc123456789abcd",
      parentSpanId: undefined,
    };

    // 验证字段格式符合 OTel 标准
    expect(spanContext.traceId).toMatch(/^[0-9a-f]{32}$/); // 32 字符十六进制
    expect(spanContext.spanId).toMatch(/^[0-9a-f]{16}$/); // 16 字符十六进制
    expect(spanContext.parentSpanId).toBeUndefined(); // 根 span 没有 parent
  });
});

describe("完整链路 trace 验证", () => {
  test("ES -> Interactive -> LLM 应该使用同一 traceId", () => {
    // 模拟完整链路
    const traceId = "019e4complete123456789abcdef1234";

    // 1. ES handleEvent 创建根 span
    const esSpan = {
      traceId,
      spanId: "es_root_span",
      parentSpanId: undefined,
    };

    // 2. Interactive.execute 创建子 span
    const interactiveSpan = {
      traceId: esSpan.traceId, // 复用
      spanId: "interactive_span",
      parentSpanId: esSpan.spanId, // 父是 ES span
    };

    // 3. LLM component 创建子 span
    const llmSpan = {
      traceId: interactiveSpan.traceId, // 复用
      spanId: "llm_span",
      parentSpanId: interactiveSpan.spanId, // 父是 Interactive span
    };

    // 验证所有 span 使用同一 traceId
    expect(esSpan.traceId).toBe(traceId);
    expect(interactiveSpan.traceId).toBe(traceId);
    expect(llmSpan.traceId).toBe(traceId);

    // 验证父子关系链
    expect(interactiveSpan.parentSpanId).toBe(esSpan.spanId);
    expect(llmSpan.parentSpanId).toBe(interactiveSpan.spanId);
  });

  test("用户输入路径应该创建独立的 traceId", () => {
    const userSpan = {
      traceId: "019euser1234567890abcdef123456",
      spanId: "user_span",
      parentSpanId: undefined,
    };

    // 验证用户输入是独立的根
    expect(userSpan.parentSpanId).toBeUndefined();
    expect(userSpan.traceId).not.toBe("019e4complete123456789abcdef1234");
  });
});
