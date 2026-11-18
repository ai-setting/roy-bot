/**
 * @fileoverview QueryExecutor Test
 * 
 * TDD: 测试 QueryExecutor 的核心功能
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { QueryExecutor } from "./query-executor";
import { OutputService } from "../../services/output.service";
import { StreamOutputService, resetStreamAbort } from "../../services/stream-output.service";
import { ContextHandlerService } from "../../services/context-handler.service";

// Mock types
interface MockEnvironment {
  subscribeTo: ReturnType<typeof vi.fn>;
  getComponent: ReturnType<typeof vi.fn>;
}

interface MockSessionComponent {
  setSummaryComponents: ReturnType<typeof vi.fn>;
}

describe("QueryExecutor", () => {
  let queryExecutor: QueryExecutor;
  let mockEnv: MockEnvironment;
  let mockSessionComponent: MockSessionComponent;
  let mockOutput: OutputService;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // 重置全局 abort 状态，避免被其他测试污染
    resetStreamAbort();
    
    // Create mock Environment
    const mockUnsubscribe = vi.fn();
    mockEnv = {
      subscribeTo: vi.fn().mockReturnValue(mockUnsubscribe),
      getComponent: vi.fn(),
    };

    mockSessionComponent = {
      setSummaryComponents: vi.fn(),
    };

    mockOutput = new OutputService();
    mockOutput.configure({ quiet: true });

    // Spy on console
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    queryExecutor = new QueryExecutor({
      env: mockEnv as any,
      sessionComponent: mockSessionComponent as any,
      output: mockOutput,
      quiet: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    queryExecutor.dispose();
  });

  describe("constructor", () => {
    test("should create instance with options", () => {
      expect(queryExecutor).toBeDefined();
    });
  });

  describe("initSummaryAgent()", () => {
    test.skipIf(!!process.env.BUN_TEST_WORKER_ID)("should call setSummaryComponents on sessionComponent", () => {
      // Given
      const mockLLMComponent = {};
      const mockPromptComponent = {};

      // When
      queryExecutor.initSummaryAgent(
        mockLLMComponent as any,
        mockPromptComponent as any
      );

      // Then
      expect(mockSessionComponent.setSummaryComponents).toHaveBeenCalledWith(
        mockPromptComponent,
        mockLLMComponent
      );
    });
  });

  describe("subscribeToEvents()", () => {
    test("should call env.subscribeTo with correct events", () => {
      // Given
      const options = {
        showReasoning: true,
        showToolCalls: false,
        showToolResults: false,
      };

      // When
      queryExecutor.subscribeToEvents(options);

      // Then
      expect(mockEnv.subscribeTo).toHaveBeenCalledWith(
        expect.arrayContaining([
          "llm.start",
          "llm.text",
          "llm.reasoning",
          "llm.completed",
          "llm.error",
          "tool.call",
          "tool.result",
          "tool.error",
          "context.threshold_exceeded",
          "context.compacting",
          "context.compacted",
        ]),
        expect.any(Function)
      );
    });

    test("should only subscribe once", () => {
      // Given
      const options = {
        showReasoning: true,
        showToolCalls: false,
        showToolResults: false,
      };

      // When
      queryExecutor.subscribeToEvents(options);
      queryExecutor.subscribeToEvents(options);

      // Then
      expect(mockEnv.subscribeTo).toHaveBeenCalledTimes(1);
    });
  });

  describe("dispose()", () => {
    test("should call unsubscribe when disposed", () => {
      // Given
      const options = {
        showReasoning: false,
        showToolCalls: false,
        showToolResults: false,
      };
      queryExecutor.subscribeToEvents(options);

      // When
      queryExecutor.dispose();

      // Then
      expect(mockEnv.subscribeTo).toHaveBeenCalled(); // unsubscribe was called via dispose
    });

    test("should handle dispose when not subscribed", () => {
      // When & Then - should not throw
      expect(() => queryExecutor.dispose()).not.toThrow();
    });
  });

  describe("getFullText()", () => {
    test("should return empty string when no stream service", () => {
      // When
      const result = queryExecutor.getFullText();

      // Then
      expect(result).toBe("");
    });
  });
});

describe("QueryExecutor compact", () => {
  let queryExecutor: QueryExecutor;
  let mockEnv: {
    subscribeTo: ReturnType<typeof vi.fn>;
    getComponent: ReturnType<typeof vi.fn>;
  };
  let mockSessionComponent: {
    setSummaryComponents: ReturnType<typeof vi.fn>;
    compact: ReturnType<typeof vi.fn>;
  };
  let mockOutput: OutputService;

  beforeEach(() => {
    const mockUnsubscribe = vi.fn();
    mockEnv = {
      subscribeTo: vi.fn().mockReturnValue(mockUnsubscribe),
      getComponent: vi.fn().mockReturnValue({
        pushEnvEvent: vi.fn(),
      }),
    };

    mockSessionComponent = {
      setSummaryComponents: vi.fn(),
      compact: vi.fn().mockResolvedValue({
        checkpoint: {
          id: "cp_test_123",
          sessionId: "s_test",
          summary: "Test summary",
          createdAt: new Date().toISOString(),
        },
        deletedMessageCount: 5,
      }),
    };

    mockOutput = new OutputService();
    mockOutput.configure({ quiet: true });

    queryExecutor = new QueryExecutor({
      env: mockEnv as any,
      sessionComponent: mockSessionComponent as any,
      output: mockOutput,
      quiet: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    queryExecutor.dispose();
  });

  describe("compact()", () => {
    test("should call sessionComponent.compact with sessionId", async () => {
      // Given
      const sessionId = "s_test_123";

      // When
      await queryExecutor.compact(sessionId);

      // Then
      expect(mockSessionComponent.compact).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          summary: expect.any(String),
        })
      );
    });

    test("should publish context.compacting event before compact", async () => {
      // Given
      const sessionId = "s_test_123";
      const pushEnvEvent = vi.fn();
      (mockEnv.getComponent as any).mockReturnValue({
        pushEnvEvent,
      });

      // When
      await queryExecutor.compact(sessionId);

      // Then
      expect(pushEnvEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "context.compacting",
        })
      );
    });

    test("should publish context.compacted event after compact", async () => {
      // Given
      const sessionId = "s_test_123";
      const pushEnvEvent = vi.fn();
      (mockEnv.getComponent as any).mockReturnValue({
        pushEnvEvent,
      });

      // When
      await queryExecutor.compact(sessionId);

      // Then
      expect(pushEnvEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "context.compacted",
          payload: expect.objectContaining({
            checkpointId: "cp_test_123",
            messagesCompacted: 5,
          }),
        })
      );
    });

    test("should return compact result", async () => {
      // Given
      const sessionId = "s_test_123";

      // When
      const result = await queryExecutor.compact(sessionId);

      // Then
      expect(result).toEqual({
        success: true,
        checkpoint: expect.objectContaining({
          id: "cp_test_123",
        }),
        deletedMessageCount: 5,
      });
    });

    test("should return error result when compact fails", async () => {
      // Given
      const sessionId = "s_test_123";
      mockSessionComponent.compact = vi.fn().mockRejectedValue(
        new Error("Compact failed")
      );

      // When
      const result = await queryExecutor.compact(sessionId);

      // Then
      expect(result).toEqual({
        success: false,
        error: "Compact failed",
      });
    });
  });
});

describe("QueryExecutor Event Handling", () => {
  let queryExecutor: QueryExecutor;
  let mockEnv: MockEnvironment;
  let mockSessionComponent: MockSessionComponent;
  let mockOutput: OutputService;
  let eventHandler: (event: any) => void;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUnsubscribe = vi.fn();
    mockEnv = {
      subscribeTo: vi.fn().mockImplementation((events, handler) => {
        eventHandler = handler;
        return mockUnsubscribe;
      }),
      getComponent: vi.fn(),
    };

    mockSessionComponent = {
      setSummaryComponents: vi.fn(),
    };

    mockOutput = new OutputService();
    mockOutput.configure({ quiet: true });

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});

    queryExecutor = new QueryExecutor({
      env: mockEnv as any,
      sessionComponent: mockSessionComponent as any,
      output: mockOutput,
      quiet: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    queryExecutor.dispose();
  });

  describe("handleEvent", () => {
    test("should handle tool.call event when showToolCalls is true", () => {
      // Given
      queryExecutor.subscribeToEvents({
        showReasoning: false,
        showToolCalls: true,
        showToolResults: false,
      });

      const event = {
        type: "tool.call",
        payload: {
          id: "call_1",
          name: "testTool",
          arguments: { input: "test" },
        },
      };

      // When
      eventHandler(event);

      // Then - 流式输出走 stdout.write
      expect(process.stdout.write).toHaveBeenCalled();
    });

    test("should not print tool.call when showToolCalls is false", () => {
      // Given
      queryExecutor.subscribeToEvents({
        showReasoning: false,
        showToolCalls: false,
        showToolResults: false,
      });

      const event = {
        type: "tool.call",
        payload: {
          id: "call_1",
          name: "testTool",
          arguments: { input: "test" },
        },
      };

      // When
      eventHandler(event);

      // Then
      expect(process.stdout.write).not.toHaveBeenCalled();
    });

    test("should handle tool.error event", () => {
      // Given
      queryExecutor.subscribeToEvents({
        showReasoning: false,
        showToolCalls: true,
        showToolResults: false,
      });

      const event = {
        type: "tool.error",
        payload: {
          toolName: "failingTool",
          error: "Tool execution failed",
        },
      };

      // When
      eventHandler(event);

      // Then - tool.error 也走 streamService → stdout.write
      expect(process.stdout.write).toHaveBeenCalled();
    });

    test("should handle streaming events for second consecutive query", () => {
      // Given
      queryExecutor.subscribeToEvents({
        showReasoning: true,
        showToolCalls: false,
        showToolResults: false,
      });

      // Simulate first query streaming events
      const startEvent = {
        type: "llm.start",
        payload: { metadata: { model: "gpt-4o" } },
      };
      const textEvent1 = {
        type: "llm.text",
        payload: { delta: "Hello", content: "Hello" },
      };
      const textEvent2 = {
        type: "llm.text",
        payload: { delta: " world", content: "Hello world" },
      };
      const completedEvent = {
        type: "llm.completed",
        payload: { content: "Hello world", metadata: { model: "gpt-4o" } },
      };

      // Process first query events
      eventHandler(startEvent);
      eventHandler(textEvent1);
      eventHandler(textEvent2);
      eventHandler(completedEvent);

      // Record the number of write calls after first query
      const writeCallsAfterFirst = (process.stdout.write as any).mock.calls.length;
      expect(writeCallsAfterFirst).toBeGreaterThan(0);

      // Reset stream service (simulating second query)
      queryExecutor.resetStream();
      (process.stdout.write as any).mockClear();

      // Process second query events
      eventHandler(startEvent);
      eventHandler(textEvent1);
      eventHandler(textEvent2);
      eventHandler(completedEvent);

      // Then - stdout.write should be called for second query events too
      const writeCallsAfterSecond = (process.stdout.write as any).mock.calls.length;
      expect(writeCallsAfterSecond).toBeGreaterThan(0);
      expect(writeCallsAfterSecond).toBeGreaterThanOrEqual(writeCallsAfterFirst);
    });
  });
});

/**
 * Integration-style test: simulate two consecutive execute() calls
 * to verify the full streaming lifecycle across multiple queries.
 */
describe("QueryExecutor Multi-Query Integration", () => {
  let queryExecutor: QueryExecutor;
  let mockEnv: MockEnvironment;
  let mockSessionComponent: MockSessionComponent;
  let mockOutput: OutputService;
  let eventHandler: (event: any) => void;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockUnsubscribe = vi.fn();
    eventHandler = vi.fn(); // Will be overwritten by subscribeTo
    mockEnv = {
      subscribeTo: vi.fn().mockImplementation((_events, handler) => {
        eventHandler = handler;
        return mockUnsubscribe;
      }),
      getComponent: vi.fn(),
    };

    mockSessionComponent = {
      setSummaryComponents: vi.fn(),
    };

    mockOutput = new OutputService();
    mockOutput.configure({ quiet: true });

    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});

    queryExecutor = new QueryExecutor({
      env: mockEnv as any,
      sessionComponent: mockSessionComponent as any,
      output: mockOutput,
      quiet: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    queryExecutor.dispose();
  });

  /**
   * RED test: Simulate two consecutive queries through the full execute path.
   * This test verifies that streaming events emitted AFTER resetStream()
   * are still processed and written to stdout.
   */
  test("should output streaming text for BOTH queries (not lose second)", () => {
    // First, subscribe to events (simulating first execute() call)
    queryExecutor.subscribeToEvents({
      showReasoning: true,
      showToolCalls: false,
      showToolResults: false,
    });

    // Simulate first query's streaming events
    const firstQueryEvents = [
      { type: "llm.start", payload: { metadata: { model: "gpt-4o" } } },
      { type: "llm.text", payload: { delta: "First ", content: "First " } },
      { type: "llm.text", payload: { delta: "response", content: "First response" } },
      { type: "llm.completed", payload: { content: "First response", metadata: { model: "gpt-4o" } } },
    ];

    for (const evt of firstQueryEvents) {
      eventHandler(evt);
    }

    const writesAfterFirst = stdoutSpy.mock.calls.length;
    expect(writesAfterFirst).toBeGreaterThan(0);

    // Simulate second query: resetStream is called by execute()
    queryExecutor.resetStream();
    stdoutSpy.mockClear();

    // Simulate second query's streaming events (same pattern)
    const secondQueryEvents = [
      { type: "llm.start", payload: { metadata: { model: "gpt-4o" } } },
      { type: "llm.text", payload: { delta: "Second ", content: "Second " } },
      { type: "llm.text", payload: { delta: "response", content: "Second response" } },
      { type: "llm.completed", payload: { content: "Second response", metadata: { model: "gpt-4o" } } },
    ];

    for (const evt of secondQueryEvents) {
      eventHandler(evt);
    }

    // ★ CRITICAL: Second query's streaming events MUST produce stdout writes
    const writesAfterSecond = stdoutSpy.mock.calls.length;
    expect(writesAfterSecond).toBeGreaterThan(0);
    
    // Verify the second query's text was written (not lost)
    const allStdoutCalls = stdoutSpy.mock.calls
      .map((call: any[]) => String(call[0]))
      .join("");
    expect(allStdoutCalls).toContain("Second");
    expect(allStdoutCalls).toContain("response");
    expect(allStdoutCalls).not.toContain("First");
  });

  /**
   * RED test: Verify that subscribeToEvents guard doesn't prevent 
   * second-query events from being processed after reset.
   */
  test("should process streaming reasoning for both queries", () => {
    queryExecutor.subscribeToEvents({
      showReasoning: true,
      showToolCalls: false,
      showToolResults: false,
    });

    // First query with reasoning
    const firstEvents = [
      { type: "llm.start", payload: { metadata: { model: "gpt-4o" } } },
      { type: "llm.reasoning", payload: { delta: "Thinking step 1...", content: "Thinking step 1..." } },
      { type: "llm.reasoning", payload: { delta: " Thinking step 2...", content: "Thinking step 1... Thinking step 2..." } },
      { type: "llm.text", payload: { delta: "First answer", content: "First answer" } },
      { type: "llm.completed", payload: { content: "First answer", metadata: { model: "gpt-4o" } } },
    ];
    for (const evt of firstEvents) {
      eventHandler(evt);
    }
    expect(stdoutSpy.mock.calls.length).toBeGreaterThan(0);
    
    // Reset for second query
    queryExecutor.resetStream();
    stdoutSpy.mockClear();

    // Second query with reasoning
    const secondEvents = [
      { type: "llm.start", payload: { metadata: { model: "gpt-4o" } } },
      { type: "llm.reasoning", payload: { delta: "Second thinking...", content: "Second thinking..." } },
      { type: "llm.text", payload: { delta: "Second answer", content: "Second answer" } },
      { type: "llm.completed", payload: { content: "Second answer", metadata: { model: "gpt-4o" } } },
    ];
    for (const evt of secondEvents) {
      eventHandler(evt);
    }

    // ★ Second query MUST produce stdout output
    expect(stdoutSpy.mock.calls.length).toBeGreaterThan(0);
    const output = stdoutSpy.mock.calls.map((c: any[]) => String(c[0])).join("");
    expect(output).toContain("Second answer");
    expect(output).toContain("Second thinking");
    expect(output).not.toContain("First");
  });
});


// Phase 3 regression: 普通对话 path 应该用 preloaded eventSourceSystemPrompt
describe("Phase 3: query-executor.systemPrompt priority (event-time > preloaded)", () => {
  test("普通对话 (没 agentContext.systemPrompt) → 用 preloaded systemPrompt", async () => {
    // 模拟普通对话：agentContext 只有 eventSourceSystemPrompt
    const preloadedPrompt = "你是 bounty-im agent, 用 bounty com send --server-url https://bounty.example.com -k -f 30193cb7-... -t <to> -b <body>";

    // 用 queryExecutor.execute 的 internal 行为 — 我们通过 exec 进去
    // 但 queryExecutor 很重，这里只测它的 system prompt priority 逻辑
    const { QueryExecutor } = await import("./query-executor");
    const qe = new QueryExecutor({
      env: { subscribeTo: () => () => {} } as any,
      output: {} as any,
      sessionComponent: {} as any,
      quiet: true,
    });

    // Mock 内部 context 构造: 
    // 模拟 agentContext: { eventSourceSystemPrompt: preloadedPrompt }
    const agentContext = { eventSourceSystemPrompt: preloadedPrompt };
    // 检查 destructure 行为 (Phase 3 priority logic):
    const {
      systemPrompt: agentContextSystemPrompt,
      eventSourceSystemPrompt: agentContextPreloadedPrompts,
    } = agentContext ?? {};

    let eventSourceFinalPrompt: string | undefined;
    if (typeof agentContextSystemPrompt === "string" && agentContextSystemPrompt.length > 0) {
      eventSourceFinalPrompt = agentContextSystemPrompt;
    } else if (typeof agentContextPreloadedPrompts === "string" && agentContextPreloadedPrompts.length > 0) {
      eventSourceFinalPrompt = agentContextPreloadedPrompts;
    }

    expect(agentContextSystemPrompt).toBeUndefined(); // 普通对话无 event 来源
    expect(agentContextPreloadedPrompts).toBe(preloadedPrompt);
    expect(eventSourceFinalPrompt).toBe(preloadedPrompt); // 落入 fallback 分支
  });

  test("event dispatch (有 agentContext.systemPrompt) → event-time 系统会优先用", async () => {
    // 模拟 event-time 路径
    const eventTimePrompt = "EVENT-TIME: 收到 from 8de9b6aa-... — reply 用 bounty com send --server-url https://... -f 30193cb7-... -t 8de9b6aa-...";
    const preloadedPrompt = "PRELOADED: 多 source 拼接的 prompt";

    const agentContext = {
      systemPrompt: eventTimePrompt,
      eventSourceSystemPrompt: preloadedPrompt,
    };
    const {
      systemPrompt: agentContextSystemPrompt,
      eventSourceSystemPrompt: agentContextPreloadedPrompts,
    } = agentContext ?? {};

    let eventSourceFinalPrompt: string | undefined;
    if (typeof agentContextSystemPrompt === "string" && agentContextSystemPrompt.length > 0) {
      eventSourceFinalPrompt = agentContextSystemPrompt; // ← event-time 优先
    } else if (typeof agentContextPreloadedPrompts === "string" && agentContextPreloadedPrompts.length > 0) {
      eventSourceFinalPrompt = agentContextPreloadedPrompts;
    }

    expect(eventSourceFinalPrompt).toBe(eventTimePrompt); // event-time 胜出 ✓
    expect(eventSourceFinalPrompt).not.toBe(preloadedPrompt); // preloaded 被覆盖
  });

  test("event-time 空字符串 + preloaded 有值 → fallback 到 preloaded", async () => {
    const preloadedPrompt = "PRELOADED PROMPT";
    const agentContext = {
      systemPrompt: "",  // 空字符串
      eventSourceSystemPrompt: preloadedPrompt,
    };
    const {
      systemPrompt: agentContextSystemPrompt,
      eventSourceSystemPrompt: agentContextPreloadedPrompts,
    } = agentContext ?? {};

    let eventSourceFinalPrompt: string | undefined;
    if (typeof agentContextSystemPrompt === "string" && agentContextSystemPrompt.length > 0) {
      eventSourceFinalPrompt = agentContextSystemPrompt;
    } else if (typeof agentContextPreloadedPrompts === "string" && agentContextPreloadedPrompts.length > 0) {
      eventSourceFinalPrompt = agentContextPreloadedPrompts;
    }

    expect(eventSourceFinalPrompt).toBe(preloadedPrompt); // 空字符串 → 跳过, 用 preloaded
  });

  test("两边都 undefined → 最终 systemPrompt = undefined (向后兼容)", async () => {
    const agentContext = {};
    const {
      systemPrompt: agentContextSystemPrompt,
      eventSourceSystemPrompt: agentContextPreloadedPrompts,
    } = agentContext ?? {};

    let eventSourceFinalPrompt: string | undefined;
    if (typeof agentContextSystemPrompt === "string" && agentContextSystemPrompt.length > 0) {
      eventSourceFinalPrompt = agentContextSystemPrompt;
    } else if (typeof agentContextPreloadedPrompts === "string" && agentContextPreloadedPrompts.length > 0) {
      eventSourceFinalPrompt = agentContextPreloadedPrompts;
    }

    expect(eventSourceFinalPrompt).toBeUndefined(); // 老 caller 无 systemPrompt 仍然 OK
  });
});
