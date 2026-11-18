import { describe, test, expect, beforeEach } from "bun:test";
import { ContextHandlerService, type HandleQueryOptions } from "./context-handler.service";
import { ContextError, ErrorCodes, getTracerProvider, resetTracerProvider, type OTelTracer } from "@ai-setting/roy-bot-core";
import type { Environment, AgentContext } from "@ai-setting/roy-bot-core";
import type { SessionComponent, SessionCheckpoint } from "@ai-setting/roy-bot-core";

// Mock checkpoint
const mockCheckpoint: SessionCheckpoint = {
  id: "cp_test123",
  messageIndex: 10,
  title: "Test Checkpoint",
  summary: "Summary of conversation",
  processKeyPoints: ["Point 1", "Point 2"],
  currentState: "Current working state",
  nextSteps: ["Next step 1", "Next step 2"],
  userIntents: [],
  messageCountBefore: 15,
  createdAt: Date.now(),
  type: "compact",
};

describe("ContextHandlerService", () => {
  let mockEnv: Environment;
  let mockSessionComponent: SessionComponent;
  let contextHandler: ContextHandlerService;
  let handleQueryMock: any;
  let pushEnvEventMock: any;
  let compactMock: any;

  beforeEach(() => {
    // 清除环境变量中的 trace context，避免继承外部上下文
    delete process.env['TRACEPARENT'];
    delete process.env['TRACE_ID'];
    delete process.env['LOG_TRACE_REQUEST_ID'];
    
    // 重置 tracer provider，确保干净的上下文
    resetTracerProvider();
    
    // Create fresh mocks
    handleQueryMock = async () => { throw new Error("Not mocked"); };
    pushEnvEventMock = () => {};
    compactMock = async () => { throw new Error("Not mocked"); };

    mockEnv = {
      handle_query: handleQueryMock,
      pushEnvEvent: pushEnvEventMock,
      getComponent: () => undefined,
      subscribe: () => () => {},
      subscribeTo: () => () => {},
    } as unknown as Environment;

    // Mock generateCompactHint for two-phase compact
    const generateCompactHintMock = async () => "Generated scenario hint for testing";

    mockSessionComponent = {
      compact: compactMock,
      generateCompactHint: generateCompactHintMock,
      get: async () => undefined,
      addMessage: async () => undefined,
    } as unknown as SessionComponent;

    contextHandler = new ContextHandlerService(
      mockEnv,
      mockSessionComponent,
      { maxRetries: 1, autoCompact: true }
    );
  });

  describe("handleQueryWithContext", () => {
    test("should return result when handle_query succeeds", async () => {
      handleQueryMock = async () => "Query completed";
      mockEnv.handle_query = handleQueryMock;

      const result = await contextHandler.handleQueryWithContext(
        "Test query",
        { sessionId: "session-123" }
      );

      expect(result).toBe("Query completed");
    });

    test("should throw non-ContextError as-is", async () => {
      handleQueryMock = async () => { throw new Error("Some other error"); };
      mockEnv.handle_query = handleQueryMock;

      await expect(
        contextHandler.handleQueryWithContext("Test query")
      ).rejects.toThrow("Some other error");
    });

    test("should compact and retry when ContextError is thrown", async () => {
      let callCount = 0;
      handleQueryMock = async () => {
        callCount++;
        if (callCount === 1) {
          throw new ContextError(
            "Context threshold exceeded",
            ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
            "session-123",
            { promptTokens: 10000, completionTokens: 500, totalTokens: 10500 },
            128000
          );
        }
        return "Retry result";
      };
      mockEnv.handle_query = handleQueryMock;

      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.handleQueryWithContext(
        "Test query",
        { sessionId: "session-123" }
      );

      expect(result).toBe("Retry result");
      expect(callCount).toBe(2);
    });

    test("should publish events when compacting", async () => {
      const events: any[] = [];
      pushEnvEventMock = (event: any) => events.push(event);
      mockEnv.pushEnvEvent = pushEnvEventMock;

      let callCount = 0;
      handleQueryMock = async () => {
        callCount++;
        if (callCount === 1) {
          throw new ContextError(
            "Context threshold exceeded",
            ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
            "session-123"
          );
        }
        return "Retry result";
      };
      mockEnv.handle_query = handleQueryMock;

      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      await contextHandler.handleQueryWithContext(
        "Test query",
        { sessionId: "session-123" }
      );

      // Verify events were published
      expect(events.some(e => e.type === "context.threshold_exceeded")).toBe(true);
      expect(events.some(e => e.type === "context.compacting")).toBe(true);
      expect(events.some(e => e.type === "context.compacted")).toBe(true);
    });

    test("should throw after max compact retries", async () => {
      handleQueryMock = async () => {
        throw new ContextError(
          "Context threshold exceeded",
          ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
          "session-123"
        );
      };
      mockEnv.handle_query = handleQueryMock;

      // compactMock 始终返回 success 但每次产生一个新 query（避免触发「无变化终止」）
      let compactCallCount = 0;
      compactMock = async () => {
        compactCallCount++;
        return {
          checkpoint: mockCheckpoint,
          deletedMessageCount: 15,
          remainingMessageCount: 5,
          checkpointCount: compactCallCount,
          newQuery: `refined query #${compactCallCount}`,
        };
      };
      mockSessionComponent.compact = compactMock;

      let error: any;
      try {
        await contextHandler.handleQueryWithContext("Test query", { sessionId: "session-123" });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(ContextError);
    });

    test("should retry when compact succeeds but newQuery equals original query", async () => {
      // 场景: compact 成功，newQuery 与原始 query 相同。
      // 压缩实际上改变了 session（归档消息+添加 checkpoint），
      // 相同的 query 在缩减后的上下文中应该能成功。
      // 如果依然失败（此测试中 handleQueryMock 始终抛 ContextError），
      // 则会重试直到 MAX_COMPACT_RETRIES，每次 reset 后再次 compact。
      let callCount = 0;
      handleQueryMock = async () => {
        callCount++;
        throw new ContextError(
          "Context threshold exceeded",
          ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
          "session-123"
        );
      };
      mockEnv.handle_query = handleQueryMock;

      let compactCallCount = 0;
      contextHandler.compactSessionWithTwoPhases = async () => {
        compactCallCount++;
        return {
          success: true,
          checkpoint: mockCheckpoint,
          newQuery: "Test query", // 与传入 query 完全相同
        };
      };

      let error: any;
      try {
        await contextHandler.handleQueryWithContext("Test query", { sessionId: "session-123" });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(ContextError);
      // compact 会被调用多次（直到 MAX_COMPACT_RETRIES=10），
      // 因为此测试中 handle_query 始终抛 ContextError
      expect(compactCallCount).toBe(10); // MAX_COMPACT_RETRIES
    });

    test("should terminate when compact succeeds but newQuery is undefined", async () => {
      // 场景: compact 返回 success:true 但 newQuery 为 undefined，
      // 表示压缩未改变任何东西。应当立即终止而非重试到 MAX_COMPACT_RETRIES。
      handleQueryMock = async () => {
        throw new ContextError(
          "Context threshold exceeded",
          ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
          "session-123"
        );
      };
      mockEnv.handle_query = handleQueryMock;

      let compactCallCount = 0;
      contextHandler.compactSessionWithTwoPhases = async () => {
        compactCallCount++;
        return {
          success: true,
          checkpoint: mockCheckpoint,
          // newQuery 故意省略（undefined）
        };
      };

      let error: any;
      try {
        await contextHandler.handleQueryWithContext("Test query", { sessionId: "session-123" });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(ContextError);
      // 关键: compact 只应被调用 1 次
      expect(compactCallCount).toBe(1);
    });

    test("should not compact when autoCompact is disabled", async () => {
      contextHandler = new ContextHandlerService(
        mockEnv,
        mockSessionComponent,
        { maxRetries: 1, autoCompact: false }
      );

      handleQueryMock = async () => {
        throw new ContextError(
          "Context threshold exceeded",
          ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
          "session-123"
        );
      };
      mockEnv.handle_query = handleQueryMock;

      let compactCalled = false;
      compactMock = async () => {
        compactCalled = true;
        return {
          checkpoint: mockCheckpoint,
          deletedMessageCount: 15,
          remainingMessageCount: 5,
          checkpointCount: 2,
        };
      };
      mockSessionComponent.compact = compactMock;

      let error: any;
      try {
        await contextHandler.handleQueryWithContext("Test query");
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(ContextError);
      expect(compactCalled).toBe(false);
    });
  });

  describe("compactSession", () => {
    test("should return error when no sessionId provided", async () => {
      const result = await contextHandler.compactSession(undefined);

      expect(result.success).toBe(false);
      expect(result.error).toBe("No session ID provided");
    });

    test("should compact session and return new query", async () => {
      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSession("session-123", "User's new query");

      expect(result.success).toBe(true);
      expect(result.checkpoint).toEqual(mockCheckpoint);
      // query 应保持短小，仅包含原始用户输入
      expect(result.newQuery).toBe("User's new query");
      // checkpoint 上下文不应塞进 query（它们通过 session messages 传递）
      expect(result.newQuery).not.toContain("【会话历史摘要】");
      expect(result.newQuery).not.toContain("【待完成的任务】");
    });

    test("should handle compact failure", async () => {
      compactMock = async () => { throw new Error("Compact failed"); };
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSession("session-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Compact failed");
    });

    test("should construct query without original query", async () => {
      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSession("session-123");

      expect(result.newQuery).not.toContain("【用户新输入】");
    });
  });

  describe("Two-Phase Compact", () => {
    test("should call generateCompactHint before compact in two-phase flow", async () => {
      const events: any[] = [];
      pushEnvEventMock = (event: any) => events.push(event);
      mockEnv.pushEnvEvent = pushEnvEventMock;

      let generateHintCalled = false;
      let hintValue = "Scenario hint for task execution";
      const generateCompactHintMock = async () => {
        generateHintCalled = true;
        return hintValue;
      };
      mockSessionComponent.generateCompactHint = generateCompactHintMock;

      compactMock = async (sessionId: string, options: any) => {
        // Verify scenarioHint was passed to compact
        return {
          checkpoint: {
            ...mockCheckpoint,
            recentMessages: [
              { role: "user", content: "Test question" },
              { role: "assistant", content: "Test answer" },
            ],
          },
          deletedMessageCount: 15,
          remainingMessageCount: 5,
          checkpointCount: 2,
        };
      };
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSessionWithTwoPhases("session-123", "Test query");

      expect(result.success).toBe(true);
      expect(generateHintCalled).toBe(true);
      
      // Verify events were published
      expect(events.some(e => e.type === "context.compacting")).toBe(true);
      expect(events.some(e => e.type === "context.hint_generated")).toBe(true);
      expect(events.some(e => e.type === "context.compacted")).toBe(true);
      
      // Verify hint_generated event contains hint info
      const hintEvent = events.find(e => e.type === "context.hint_generated");
      expect(hintEvent?.payload?.hintLength).toBe(hintValue.length);
    });

    test("should continue with empty hint when generateCompactHint fails", async () => {
      const events: any[] = [];
      pushEnvEventMock = (event: any) => events.push(event);
      mockEnv.pushEnvEvent = pushEnvEventMock;

      // Make generateCompactHint fail
      const generateCompactHintMock = async () => {
        throw new Error("LLM not available");
      };
      mockSessionComponent.generateCompactHint = generateCompactHintMock;

      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSessionWithTwoPhases("session-123", "Test query");

      expect(result.success).toBe(true);
      
      // Verify hint_generated event was still published (with empty hint)
      const hintEvent = events.find(e => e.type === "context.hint_generated");
      expect(hintEvent?.payload?.hintLength).toBe(0);
    });

    test("should include scenarioHintUsed in compacted event", async () => {
      const events: any[] = [];
      pushEnvEventMock = (event: any) => events.push(event);
      mockEnv.pushEnvEvent = pushEnvEventMock;

      const generateCompactHintMock = async () => "Test scenario hint";
      mockSessionComponent.generateCompactHint = generateCompactHintMock;

      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      await contextHandler.compactSessionWithTwoPhases("session-123");

      const compactedEvent = events.find(e => e.type === "context.compacted");
      expect(compactedEvent?.payload?.scenarioHintUsed).toBe(true);
    });

    test("compactSession should call compactSessionWithTwoPhases", async () => {
      let twoPhaseCalled = false;
      const originalCompactSessionWithTwoPhases = (contextHandler as any).compactSessionWithTwoPhases.bind(contextHandler);
      (contextHandler as any).compactSessionWithTwoPhases = async (sessionId?: string, originalQuery?: string) => {
        twoPhaseCalled = true;
        return originalCompactSessionWithTwoPhases(sessionId, originalQuery);
      };

      const generateCompactHintMock = async () => "Test hint";
      mockSessionComponent.generateCompactHint = generateCompactHintMock;
      mockSessionComponent.compact = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });

      await contextHandler.compactSession("session-123");

      expect(twoPhaseCalled).toBe(true);
    });
  });

  describe("constructQueryWithCheckpoint", () => {
    test("should return original query unchanged when short", async () => {
      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSession("session-123", "Short user query");

      expect(result.success).toBe(true);
      // query 应保持短小，仅包含原始用户输入，不塞入 checkpoint 数据
      expect(result.newQuery).toBe("Short user query");
    });

    test("should return fallback message when originalQuery is empty", async () => {
      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSession("session-123", "");

      expect(result.success).toBe(true);
      expect(result.newQuery).toContain("continue");
    });

    test("should return fallback message when originalQuery is undefined", async () => {
      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSession("session-123", undefined);

      expect(result.success).toBe(true);
      expect(result.newQuery).toContain("continue");
    });

    test("should truncate excessively long originalQuery", async () => {
      const veryLongQuery = "X".repeat(8000);
      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSession("session-123", veryLongQuery);

      expect(result.success).toBe(true);
      // 截断后的 query 不应超过 MAX_QUERY_LENGTH(4000) + 截断标记
      expect(result.newQuery!.length).toBeLessThan(4200);
      expect(result.newQuery).toContain("已截断");
    });

    test("should NOT include checkpoint summary in constructed query", async () => {
      compactMock = async () => ({
        checkpoint: mockCheckpoint,
        deletedMessageCount: 15,
        remainingMessageCount: 5,
        checkpointCount: 2,
      });
      mockSessionComponent.compact = compactMock;

      const result = await contextHandler.compactSession("session-123", "User query");

      expect(result.success).toBe(true);
      // checkpoint 数据不应出现在 query 中（它们通过 session messages 传递）
      expect(result.newQuery).not.toContain("【会话历史摘要】");
      expect(result.newQuery).not.toContain("【待完成的任务】");
      expect(result.newQuery).not.toContain("Summary of conversation");
    });
  });

  describe("Trace Integration", () => {
    test("should generate trace id when handleQueryWithContext is called", async () => {
      // Get tracer from provider
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer("roy-tracer");

      handleQueryMock = async () => "Success";
      mockEnv.handle_query = handleQueryMock;

      // 在调用期间捕获上下文
      let capturedContext: any;
      const originalHandleQuery = handleQueryMock;
      handleQueryMock = async () => {
        capturedContext = tracer.getCurrentContext();
        return originalHandleQuery();
      };
      mockEnv.handle_query = handleQueryMock;

      // Execute query
      const result = await contextHandler.handleQueryWithContext(
        "Test query",
        { sessionId: "session-123" }
      );

      expect(result).toBe("Success");

      // Verify tracer created spans
      expect(tracer).toBeDefined();
      expect(tracer.name).toBe("roy-tracer");
      
      // Verify context was captured during execution
      expect(capturedContext).toBeDefined();
      expect(capturedContext?.traceId).toBeDefined();
      expect(typeof capturedContext?.traceId).toBe("string");
      console.log("Generated trace ID:", capturedContext?.traceId);
    });

    test("should use provided trace id in context", async () => {
      // Get tracer from provider
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer("roy-tracer");

      // 在调用期间捕获上下文
      let capturedContext: any;
      handleQueryMock = async () => {
        capturedContext = tracer.getCurrentContext();
        return "Success with custom trace";
      };
      mockEnv.handle_query = handleQueryMock;

      // Execute with custom trace id in metadata
      const result = await contextHandler.handleQueryWithContext(
        "Test query",
        { 
          sessionId: "session-123",
          metadata: { 
            traceId: "custom_trace_12345" 
          }
        }
      );

      expect(result).toBe("Success with custom trace");

      // Verify context was captured during execution
      expect(capturedContext).toBeDefined();
      expect(capturedContext?.traceId).toBeDefined();
    });

    test("should start span for query execution", async () => {
      // Get tracer from provider
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer("roy-tracer");

      // 在调用期间捕获上下文
      let capturedContext: any;
      handleQueryMock = async () => {
        capturedContext = tracer.getCurrentContext();
        return "Span test";
      };
      mockEnv.handle_query = handleQueryMock;

      // Execute query
      await contextHandler.handleQueryWithContext(
        "Test query",
        { sessionId: "session-123" }
      );

      // Verify span was created during execution
      expect(capturedContext).toBeDefined();
      expect(capturedContext?.traceId).toBeDefined();
      expect(capturedContext?.spanId).toBeDefined();
      
      console.log(`Created span ${capturedContext?.spanId} for trace ${capturedContext?.traceId}`);
    });
  });
});
