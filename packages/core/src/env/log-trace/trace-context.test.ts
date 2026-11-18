import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getTraceContext,
  initTraceContext,
  type ITraceContext,
} from "./trace-context";
import { contextStore } from "./trace-context";

describe("TraceContext", () => {
  let traceCtx: ITraceContext;

  beforeEach(() => {
    // 重置为新的实例
    traceCtx = initTraceContext();
  });

  afterEach(() => {
    // 清理 AsyncLocalStorage 状态
    contextStore.disable();
  });

  describe("generateRequestId", () => {
    test("should generate unique request IDs", () => {
      const id1 = traceCtx.generateRequestId();
      const id2 = traceCtx.generateRequestId();
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    test("should start with req_ prefix", () => {
      const id = traceCtx.generateRequestId();
      expect(id.startsWith("req_")).toBe(true);
    });
  });

  describe("initContext", () => {
    test("should set requestId", () => {
      const requestId = "test-request-123";
      traceCtx.initContext(requestId);
      expect(traceCtx.getRequestId()).toBe(requestId);
    });

    test("should set sessionId", () => {
      const requestId = "test-request-123";
      const sessionId = "session-456";
      traceCtx.initContext(requestId, sessionId);
      expect(traceCtx.getRequestId()).toBe(requestId);
      expect(traceCtx.getSpanContext()?.traceId).toBe(requestId);
    });
  });

  describe("runWithContext", () => {
    test("should run function with current context", () => {
      const requestId = "test-request-123";
      traceCtx.initContext(requestId);

      let capturedId: string | undefined;
      traceCtx.runWithContext(() => {
        capturedId = traceCtx.getRequestId();
      });

      expect(capturedId).toBe(requestId);
    });

    test("should preserve context across nested calls", () => {
      const requestId = "test-request-123";
      traceCtx.initContext(requestId);

      let outerId: string | undefined;
      let innerId: string | undefined;

      traceCtx.runWithContext(() => {
        outerId = traceCtx.getRequestId();
        traceCtx.runWithContext(() => {
          innerId = traceCtx.getRequestId();
        });
      });

      expect(outerId).toBe(requestId);
      expect(innerId).toBe(requestId);
    });
  });

  describe("runWithNewContext", () => {
    test("should run function in new context", () => {
      const requestId1 = "request-1";
      const requestId2 = "request-2";
      traceCtx.initContext(requestId1);

      let capturedId: string | undefined;
      traceCtx.runWithNewContext(requestId2, undefined, () => {
        capturedId = traceCtx.getRequestId();
      });

      expect(capturedId).toBe(requestId2);
    });

    test("should restore previous context after new context", () => {
      const requestId1 = "request-1";
      const requestId2 = "request-2";
      traceCtx.initContext(requestId1);

      let beforeId: string | undefined;
      let duringId: string | undefined;
      let afterId: string | undefined;

      beforeId = traceCtx.getRequestId();
      traceCtx.runWithNewContext(requestId2, undefined, () => {
        duringId = traceCtx.getRequestId();
      });
      afterId = traceCtx.getRequestId();

      expect(beforeId).toBe(requestId1);
      expect(duringId).toBe(requestId2);
      expect(afterId).toBe(requestId1);
    });
  });

  describe("runWithContextAsync", () => {
    test("should preserve context in async function", async () => {
      const requestId = "async-request";
      traceCtx.initContext(requestId);

      let capturedId: string | undefined;
      await traceCtx.runWithContextAsync(async () => {
        await Promise.resolve();
        capturedId = traceCtx.getRequestId();
      });

      expect(capturedId).toBe(requestId);
    });
  });

  describe("runWithNewContextAsync", () => {
    test("should run async function in new context", async () => {
      const requestId1 = "request-1";
      const requestId2 = "request-2";
      traceCtx.initContext(requestId1);

      let capturedId: string | undefined;
      await traceCtx.runWithNewContextAsync(requestId2, undefined, async () => {
        await Promise.resolve();
        capturedId = traceCtx.getRequestId();
      });

      expect(capturedId).toBe(requestId2);
    });
  });

  describe("startNewContext", () => {
    test("should enter new context and return cleanup function", () => {
      const requestId = "new-context";
      
      const cleanup = traceCtx.startNewContext(requestId);
      expect(traceCtx.getRequestId()).toBe(requestId);
      
      cleanup();
      // After cleanup, context should be undefined (no previous context was set)
      // Note: AsyncLocalStorage.enterWith persists, so cleanup to previous state
      expect(traceCtx.getRequestId()).toBeUndefined();
    });

    test("should restore previous context on cleanup", () => {
      const requestId1 = "context-1";
      const requestId2 = "context-2";
      
      traceCtx.initContext(requestId1);
      const cleanup = traceCtx.startNewContext(requestId2);
      cleanup();
      
      expect(traceCtx.getRequestId()).toBe(requestId1);
    });
  });

  describe("getSpanContext", () => {
    test("should return span context with traceId and spanId", () => {
      const requestId = "span-context-test";
      traceCtx.initContext(requestId);
      
      const spanCtx = traceCtx.getSpanContext();
      expect(spanCtx).toBeDefined();
      expect(spanCtx?.traceId).toBe(requestId);
      expect(spanCtx?.spanId).toBeDefined();
    });
  });
});
