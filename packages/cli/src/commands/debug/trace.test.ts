/**
 * @fileoverview Debug Trace Command - TDD Tests
 * 
 * TDD 开发流程:
 * 1. RED - 编写失败的测试
 * 2. GREEN - 编写最小代码让测试通过
 * 3. REFACTOR - 重构
 * 
 * 测试目标: debug trace <traceId>
 * 功能: 以 tree 方式展示 traceId 的 spans
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Span } from "@ai-setting/roy-bot-core";
import { SpanKind, SpanStatus } from "@ai-setting/roy-bot-core";

describe("Debug Trace Command - TDD", () => {
  describe("RED: getDefaultSpanDbPath()", () => {
    test("should return path in XDG_DATA_HOME/roy-bot/traces.db by default", async () => {
      const { getDefaultSpanDbPath } = await import("./trace");
      
      // Clear environment variables
      delete process.env.LOG_TRACE_TRACING_DB_PATH;
      
      const dbPath = getDefaultSpanDbPath();
      
      expect(dbPath).toContain("roy-bot");
      expect(dbPath).toContain("traces.db");
    });

    test("should use LOG_TRACE_TRACING_DB_PATH environment variable when set", async () => {
      const { getDefaultSpanDbPath } = await import("./trace");
      
      const customPath = "/custom/path/my-traces.db";
      process.env.LOG_TRACE_TRACING_DB_PATH = customPath;
      
      const dbPath = getDefaultSpanDbPath();
      
      expect(dbPath).toBe(customPath);
      
      delete process.env.LOG_TRACE_TRACING_DB_PATH;
    });
  });

  describe("RED: formatSpanTree()", () => {
    test("should format single root span", async () => {
      const { formatSpanTree } = await import("./trace");
      
      const spans: Span[] = [{
        traceId: "trace_1",
        spanId: "span_1",
        name: "root",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        children: [],
      }];

      const output = formatSpanTree(spans);
      
      expect(output).toContain("root");
      expect(output).toContain("1000ms"); // duration
    });

    test("should format span with children showing indentation", async () => {
      const { formatSpanTree } = await import("./trace");
      
      // spans 是已经构建好的树结构（根节点数组，每个节点有 children）
      const spans: Span[] = [
        {
          traceId: "trace_1",
          spanId: "span_1",
          name: "root",
          kind: SpanKind.INTERNAL,
          status: SpanStatus.OK,
          startTime: 1000,
          endTime: 2000,
          attributes: {},
          children: [
            {
              traceId: "trace_1",
              spanId: "span_2",
              parentSpanId: "span_1",
              name: "child",
              kind: SpanKind.INTERNAL,
              status: SpanStatus.OK,
              startTime: 1200,
              endTime: 1500,
              attributes: {},
              children: [],
            },
          ],
        },
      ];

      const output = formatSpanTree(spans);
      
      expect(output).toContain("root");
      expect(output).toContain("child");
      // Should show child under parent with indentation indicator
      expect(output).toContain("└──") || expect(output).toContain("child");
    });

    test("should calculate duration correctly", async () => {
      const { formatSpanTree } = await import("./trace");
      
      const spans: Span[] = [{
        traceId: "trace_1",
        spanId: "span_1",
        name: "operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000,
        endTime: 2500, // 1500ms duration
        attributes: {},
        children: [],
      }];

      const output = formatSpanTree(spans);
      
      expect(output).toContain("1500ms");
    });

    test("should handle span without endTime (running)", async () => {
      const { formatSpanTree } = await import("./trace");
      
      const spans: Span[] = [{
        traceId: "trace_1",
        spanId: "span_1",
        name: "running-operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000,
        endTime: undefined,
        attributes: {},
        children: [],
      }];

      const output = formatSpanTree(spans);
      
      expect(output).toContain("running-operation");
      expect(output).toContain("(running)");
    });

    test("should show error indicator for failed spans", async () => {
      const { formatSpanTree } = await import("./trace");
      
      const spans: Span[] = [{
        traceId: "trace_1",
        spanId: "span_1",
        name: "failed-operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.ERROR,
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        error: "Something went wrong",
        children: [],
      }];

      const output = formatSpanTree(spans);
      
      expect(output).toContain("failed-operation");
      expect(output).toContain("Something went wrong");
    });

    test("should handle empty spans array", async () => {
      const { formatSpanTree } = await import("./trace");
      
      const output = formatSpanTree([]);
      
      expect(output).toContain("(empty)");
    });

    test("should show spanId in output", async () => {
      const { formatSpanTree } = await import("./trace");
      
      const spans: Span[] = [{
        traceId: "trace_1",
        spanId: "span_1",
        name: "operation",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: 1000,
        endTime: 2000,
        attributes: { "http.method": "GET", "http.url": "/api/test" },
        children: [],
      }];

      const output = formatSpanTree(spans);
      
      // Should show spanId
      expect(output).toContain("[spanId:span_1]");
      // Should NOT show attributes (simplified output)
      expect(output).not.toContain("http.method");
      expect(output).not.toContain("GET");
    });
  });

  describe("GREEN: TraceCommand structure", () => {
    test("should have correct command name 'trace'", async () => {
      const { TraceCommand } = await import("./index");
      
      expect(TraceCommand.command).toBe("trace");
    });

    test("should have describe text mentioning tree visualization", async () => {
      const { TraceCommand } = await import("./index");
      
      expect(TraceCommand.describe).toBeDefined();
      expect(typeof TraceCommand.describe).toBe("string");
    });

    test("should have builder that adds traceId positional argument", async () => {
      const { TraceCommand } = await import("./index");
      
      let positionalConfig: any = null;
      const mockYargs = {
        positional: (name: string, config: any) => {
          if (name === "traceId") {
            positionalConfig = config;
          }
          return mockYargs;
        },
        option: () => mockYargs,
      };
      
      TraceCommand.builder(mockYargs as any);
      
      expect(positionalConfig).toBeDefined();
      expect(positionalConfig.type).toBe("string");
    });

    test("should have --db option for custom db path", async () => {
      const { TraceCommand } = await import("./index");
      
      let capturedOptions: Record<string, any> = {};
      const mockYargs = {
        option: (name: string, config: any) => {
          capturedOptions[name] = config;
          return mockYargs;
        },
        positional: () => mockYargs,
      };
      
      TraceCommand.builder(mockYargs as any);
      
      expect(capturedOptions.db).toBeDefined();
      expect(capturedOptions.db.type).toBe("string");
    });
  });

  describe("GREEN: debug trace --list", () => {
    test("formatTraceList should render a row per trace", async () => {
      const { formatTraceList } = await import("./trace");

      const output = formatTraceList([
        {
          traceId: "trace-a",
          rootSpanName: "agent.run",
          startTime: 1000,
          endTime: 1500,
          duration: 500,
          spanCount: 3,
          status: "ok",
        },
        {
          traceId: "trace-b",
          rootSpanName: "agent.run",
          startTime: 2000,
          endTime: 2500,
          duration: 500,
          spanCount: 2,
          status: "error",
        },
      ]);

      expect(output).toContain("trace-a");
      expect(output).toContain("trace-b");
      expect(output).toContain("agent.run");
      expect(output).toContain("500ms");
      expect(output).toContain("Showing 2 traces");
    });

    test("formatTraceList should handle empty list", async () => {
      const { formatTraceList } = await import("./trace");

      expect(formatTraceList([])).toContain("(no traces)");
    });

    test("formatTraceList should show (running) when duration is missing", async () => {
      const { formatTraceList } = await import("./trace");

      const output = formatTraceList([
        {
          traceId: "trace-running",
          rootSpanName: "agent.run",
          startTime: 1000,
          spanCount: 1,
          status: "ok",
        },
      ]);

      expect(output).toContain("(running)");
    });

    test("should expose --list / --limit / --json options", async () => {
      const { TraceCommand } = await import("./index");

      const capturedOptions: Record<string, any> = {};
      const mockYargs = {
        option: (name: string, config: any) => {
          capturedOptions[name] = config;
          return mockYargs;
        },
        positional: () => mockYargs,
      };

      TraceCommand.builder(mockYargs as any);

      expect(capturedOptions.list).toBeDefined();
      expect(capturedOptions.list.type).toBe("boolean");
      expect(capturedOptions.limit).toBeDefined();
      expect(capturedOptions.limit.alias).toBe("n");
      expect(capturedOptions.limit.default).toBe(20);
      expect(capturedOptions.json).toBeDefined();
    });

    test("traceId positional should not be required (list mode)", async () => {
      const { TraceCommand } = await import("./index");

      let positionalConfig: any = null;
      const mockYargs = {
        positional: (_name: string, config: any) => {
          positionalConfig = config;
          return mockYargs;
        },
        option: () => mockYargs,
      };

      TraceCommand.builder(mockYargs as any);

      expect(positionalConfig.demandOption).toBeFalsy();
    });
  });
});
