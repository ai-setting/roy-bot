import { describe, test, expect, beforeEach } from "bun:test";
import {
  type SpanContext,
  type SpanAttributes,
  type Span,
  SpanKind,
  SpanStatus,
} from "./types";

describe("Types", () => {
  describe("SpanContext", () => {
    test("should have required fields", () => {
      const context: SpanContext = {
        traceId: "trace-123",
        spanId: "span-456",
      };
      expect(context.traceId).toBe("trace-123");
      expect(context.spanId).toBe("span-456");
    });

    test("should allow optional parentSpanId", () => {
      const context: SpanContext = {
        traceId: "trace-123",
        spanId: "span-456",
        parentSpanId: "span-789",
      };
      expect(context.parentSpanId).toBe("span-789");
    });
  });

  describe("Span", () => {
    test("should create a complete span", () => {
      const span: Span = {
        traceId: "trace-123",
        spanId: "span-456",
        name: "test-span",
        kind: SpanKind.INTERNAL,
        status: SpanStatus.OK,
        startTime: Date.now(),
        attributes: { "key": "value" },
        children: [],
      };
      expect(span.name).toBe("test-span");
      expect(span.kind).toBe(SpanKind.INTERNAL);
      expect(span.status).toBe(SpanStatus.OK);
    });
  });

  describe("SpanKind", () => {
    test("should have correct values", () => {
      expect(SpanKind.CLIENT).toBe("client");
      expect(SpanKind.SERVER).toBe("server");
      expect(SpanKind.INTERNAL).toBe("internal");
    });
  });

  describe("SpanStatus", () => {
    test("should have correct values", () => {
      expect(SpanStatus.OK).toBe("ok");
      expect(SpanStatus.ERROR).toBe("error");
    });
  });
});
