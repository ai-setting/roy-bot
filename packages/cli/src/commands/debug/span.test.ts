/**
 * @fileoverview Debug Span Command - TDD Tests
 * 
 * TDD 开发流程:
 * 1. RED - 编写失败的测试
 * 2. GREEN - 编写最小代码让测试通过
 * 3. REFACTOR - 重构
 * 
 * 测试目标: roy debug span <spanId>
 * 功能: 通过 spanId 从 SQLite 中查询详细的 span 信息
 */

import { describe, expect, test } from "bun:test";
import type { Span } from "@ai-setting/roy-bot-core";
import { SpanKind, SpanStatus } from "@ai-setting/roy-bot-core";

describe("Debug Span Command - TDD", () => {
  describe("RED: formatSpanDetail()", () => {
    test("should format span with all fields", async () => {
      const { formatSpanDetail } = await import("./span");
      
      const span: Span = {
        traceId: "trace_1",
        spanId: "span_123",
        parentSpanId: "span_parent",
        name: "test-operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000000000000,
        endTime: 1000000001500,
        attributes: { "http.method": "GET", "http.url": "/api/test" },
        result: { data: "success" },
        children: [],
      };

      const output = formatSpanDetail(span);
      
      expect(output).toContain("span_123");
      expect(output).toContain("test-operation");
      expect(output).toContain("trace_1");
      expect(output).toContain("500ms"); // duration
    });

    test("should show running span without duration", async () => {
      const { formatSpanDetail } = await import("./span");
      
      const span: Span = {
        traceId: "trace_1",
        spanId: "span_running",
        name: "running-operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000000000000,
        endTime: undefined,
        attributes: {},
        children: [],
      };

      const output = formatSpanDetail(span);
      
      expect(output).toContain("span_running");
      expect(output).toContain("(running)");
    });

    test("should show error span with error message", async () => {
      const { formatSpanDetail } = await import("./span");
      
      const span: Span = {
        traceId: "trace_1",
        spanId: "span_error",
        name: "failed-operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.ERROR,
        startTime: 1000000000000,
        endTime: 1000000001000,
        attributes: {},
        error: "Something went wrong",
        children: [],
      };

      const output = formatSpanDetail(span);
      
      // status 是小写的
      expect(output).toContain("Status:     error");
      expect(output).toContain("Something went wrong");
    });

    test("should format attributes as key-value pairs", async () => {
      const { formatSpanDetail } = await import("./span");
      
      const span: Span = {
        traceId: "trace_1",
        spanId: "span_attrs",
        name: "operation-with-attrs",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000000000000,
        endTime: 1000000001000,
        attributes: { 
          "http.method": "POST",
          "http.url": "/api/users",
          "http.status_code": 200
        },
        children: [],
      };

      const output = formatSpanDetail(span);
      
      expect(output).toContain("http.method");
      expect(output).toContain("POST");
      expect(output).toContain("http.url");
      expect(output).toContain("/api/users");
    });

    test("should show result if present", async () => {
      const { formatSpanDetail } = await import("./span");
      
      const span: Span = {
        traceId: "trace_1",
        spanId: "span_result",
        name: "operation-with-result",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000000000000,
        endTime: 1000000001000,
        attributes: {},
        result: { items: ["a", "b", "c"], count: 3 },
        children: [],
      };

      const output = formatSpanDetail(span);
      
      expect(output).toContain("Result:");
      expect(output).toContain('"a"');
      expect(output).toContain("count");
      expect(output).toContain("3");
    });

    test("should show parent span info", async () => {
      const { formatSpanDetail } = await import("./span");
      
      const span: Span = {
        traceId: "trace_1",
        spanId: "span_child",
        parentSpanId: "span_parent",
        name: "child-operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000000000000,
        endTime: 1000000001000,
        attributes: {},
        children: [],
      };

      const output = formatSpanDetail(span);
      
      // 首字母大写格式
      expect(output).toContain("Parent:");
      expect(output).toContain("span_parent");
    });

    test("should show kind information", async () => {
      const { formatSpanDetail } = await import("./span");
      
      const span: Span = {
        traceId: "trace_1",
        spanId: "span_kind",
        name: "server-handler",
        kind: SpanKind.SERVER,
        status: SpanStatus.OK,
        startTime: 1000000000000,
        endTime: 1000000001000,
        attributes: {},
        children: [],
      };

      const output = formatSpanDetail(span);
      
      // 首字母大写格式，值是小写的
      expect(output).toContain("Kind:");
      expect(output).toContain("server");
    });

    test("should handle circular reference in result", async () => {
      const { formatSpanDetail } = await import("./span");
      
      // 创建循环引用对象
      const circularObj: any = { name: "test" };
      circularObj.self = circularObj;
      
      const span: Span = {
        traceId: "trace_1",
        spanId: "span_circular",
        name: "operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000000000000,
        endTime: 1000000001000,
        attributes: {},
        result: circularObj,
        children: [],
      };

      // Should not throw, should handle circular reference
      expect(() => formatSpanDetail(span)).not.toThrow();
      const output = formatSpanDetail(span);
      expect(output).toContain("Result:");
      expect(output).toContain("[Circular]");
    });

    test("should handle corrupted result string from old data", async () => {
      const { formatSpanDetail } = await import("./span");
      
      // 模拟已经存储的损坏数据
      const span: Span = {
        traceId: "trace_1",
        spanId: "span_corrupted",
        name: "operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000000000000,
        endTime: 1000000001000,
        attributes: {},
        result: "[Object with circular reference: some error message]" as any,
        children: [],
      };

      const output = formatSpanDetail(span);
      expect(output).toContain("Result:");
      expect(output).toContain("Circular reference");
    });
  });

  describe("GREEN: SpanCommand structure", () => {
    test("should have correct command name 'span'", async () => {
      const { SpanCommand } = await import("./index");
      
      expect(SpanCommand.command).toBe("span");
    });

    test("should have describe text mentioning span lookup", async () => {
      const { SpanCommand } = await import("./index");
      
      expect(SpanCommand.describe).toBeDefined();
      expect(typeof SpanCommand.describe).toBe("string");
      expect((SpanCommand.describe || "").toLowerCase()).toContain("span");
    });

    test("should have builder that adds spanId positional argument", async () => {
      const { SpanCommand } = await import("./index");
      
      let positionalConfig: any = null;
      const mockYargs = {
        positional: (name: string, config: any) => {
          if (name === "spanId") {
            positionalConfig = config;
          }
          return mockYargs;
        },
        option: () => mockYargs,
      };
      
      SpanCommand.builder(mockYargs as any);
      
      expect(positionalConfig).toBeDefined();
      expect(positionalConfig.type).toBe("string");
    });

    test("should have --db option for custom db path", async () => {
      const { SpanCommand } = await import("./index");
      
      let capturedOptions: Record<string, any> = {};
      const mockYargs = {
        option: (name: string, config: any) => {
          capturedOptions[name] = config;
          return mockYargs;
        },
        positional: () => mockYargs,
      };
      
      SpanCommand.builder(mockYargs as any);
      
      expect(capturedOptions.db).toBeDefined();
      expect(capturedOptions.db.type).toBe("string");
    });
  });

  describe("GREEN: SpanCommand handler integration", () => {
    test("should be exported from debug/index.ts", async () => {
      // This test verifies the span command is properly integrated
      const debugModule = await import("./index");
      
      expect(debugModule.SpanCommand).toBeDefined();
      expect(debugModule.SpanCommand.command).toBe("span");
    });
  });
});
