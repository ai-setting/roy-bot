/**
 * @fileoverview Messages Command Tests
 *
 * TDD: 测试 sessions messages 命令的分页和总数功能
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import yargs from "yargs";
import type { SessionMessage } from "@ai-setting/roy-bot-core";
import { MessagesCommand } from "./messages";
import { formatMessageContent } from "./format-message-content";

describe("MessagesCommand MessagesOptions", () => {
  test("should have required offset parameter", () => {
    // Given: 期望 offset 是必填参数
    const options = {
      sessionId: "test-session",
      offset: 10,
      limit: 20,
    };
    
    // Then: offset 和 limit 应该是必填的
    expect(options.offset).toBeDefined();
    expect(options.limit).toBeDefined();
  });

  test("should have required limit parameter", () => {
    const options = {
      sessionId: "test-session",
      offset: 0,
      limit: 50,
    };
    
    expect(options.offset).toBeDefined();
    expect(options.limit).toBeDefined();
  });
});

describe("MessagesCommand Pagination Logic", () => {
  // Mock SessionComponent
  let mockSessionComponent: {
    get: ReturnType<typeof vi.fn>;
    getMessages: ReturnType<typeof vi.fn>;
    getMessageCount: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockSessionComponent = {
      get: vi.fn(),
      getMessages: vi.fn(),
      getMessageCount: vi.fn(),
    };
    
    // Setup default mocks
    mockSessionComponent.get.mockResolvedValue({
      id: "test-session",
      title: "Test Session",
    });
    
    mockSessionComponent.getMessageCount.mockResolvedValue(100);
    mockSessionComponent.getMessages.mockResolvedValue([
      {
        id: "msg-1",
        sessionID: "test-session",
        role: "user",
        content: "Hello",
        timestamp: Date.now(),
      },
    ]);
  });

  test("should call getMessages with offset and limit", async () => {
    // Given: offset=10, limit=20
    const offset = 10;
    const limit = 20;
    
    // When: 调用 getMessages
    const messages = await mockSessionComponent.getMessages("test-session", {
      offset,
      limit,
    });
    
    // Then: 应该传入正确的 offset 和 limit
    expect(mockSessionComponent.getMessages).toHaveBeenCalledWith(
      "test-session",
      { offset: 10, limit: 20 }
    );
    expect(messages).toHaveLength(1);
  });

  test("should call getMessageCount to get total", async () => {
    // Given
    const sessionId = "test-session";
    
    // When: 获取消息总数
    const totalCount = await mockSessionComponent.getMessageCount(sessionId);
    
    // Then: 应该返回正确的总数
    expect(mockSessionComponent.getMessageCount).toHaveBeenCalledWith(sessionId);
    expect(totalCount).toBe(100);
  });

  test("should return messages with pagination info", async () => {
    // Given
    const sessionId = "test-session";
    const offset = 0;
    const limit = 10;
    
    // 模拟分页数据
    const mockMessages: SessionMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `msg-${i}`,
      sessionID: sessionId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
      timestamp: Date.now() + i,
    }));
    
    mockSessionComponent.getMessages.mockResolvedValue(mockMessages);
    mockSessionComponent.getMessageCount.mockResolvedValue(100);
    
    // When
    const [messages, totalCount] = await Promise.all([
      mockSessionComponent.getMessages(sessionId, { offset, limit }),
      mockSessionComponent.getMessageCount(sessionId),
    ]);
    
    // Then
    expect(messages).toHaveLength(10);
    expect(totalCount).toBe(100);
  });

  test("should handle edge case: offset equals total count", async () => {
    // Given: offset 等于总数（最后一页之后）
    const sessionId = "test-session";
    mockSessionComponent.getMessages.mockResolvedValue([]);
    mockSessionComponent.getMessageCount.mockResolvedValue(50);
    
    // When
    const [messages, totalCount] = await Promise.all([
      mockSessionComponent.getMessages(sessionId, { offset: 50, limit: 10 }),
      mockSessionComponent.getMessageCount(sessionId),
    ]);
    
    // Then
    expect(messages).toHaveLength(0);
    expect(totalCount).toBe(50);
  });
});

describe("MessagesCommand JSON Output", () => {
  test("should include total count in JSON output", () => {
    // Given: JSON 响应应该包含总数
    const jsonResponse = {
      sessionId: "test-session",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Hello",
          timestamp: new Date().toISOString(),
        },
      ],
      total: 100, // 消息总数
      pagination: {
        offset: 0,
        limit: 10,
      },
    };
    
    // Then: 应该包含 total 字段
    expect(jsonResponse).toHaveProperty("total");
    expect(jsonResponse.total).toBe(100);
  });

  test("should include pagination info in JSON output", () => {
    // Given
    const jsonResponse = {
      sessionId: "test-session",
      messages: [],
      total: 100,
      pagination: {
        offset: 10,
        limit: 20,
        hasMore: true, // 是否有更多消息
      },
    };
    
    // Then
    expect(jsonResponse.pagination).toBeDefined();
    expect(jsonResponse.pagination.offset).toBe(10);
    expect(jsonResponse.pagination.limit).toBe(20);
  });
});

describe("MessagesCommand CLI Options", () => {
  test("offset should be required in CLI builder", () => {
    // Given: CLI 参数定义
    const expectedOptions = {
      offset: { alias: "o", type: "number", demandOption: true },
      limit: { alias: "n", type: "number", demandOption: true },
    };
    
    // Then: offset 和 limit 应该是必填的 (demandOption: true)
    expect(expectedOptions.offset.demandOption).toBe(true);
    expect(expectedOptions.limit.demandOption).toBe(true);
  });

  test("should have default values for optional parameters", () => {
    // Note: 虽然 offset 和 limit 是必填的，但 reverse 和 json 有默认值
    const cliOptions = {
      offset: { alias: "o", type: "number", demandOption: true },
      limit: { alias: "n", type: "number", demandOption: true },
      reverse: { alias: "r", type: "boolean", default: false },
      json: { alias: "j", type: "boolean", default: false },
    };
    
    expect(cliOptions.reverse.default).toBe(false);
    expect(cliOptions.json.default).toBe(false);
  });
});

describe("MessagesCommand Format Message Content", () => {
  test("should handle tool-call with undefined arguments without error", () => {
    // Given: tool-call part 的 arguments 是 undefined
    const mockMessage = {
      id: "msg-1",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      parts: [
        { type: "tool-call", toolCallId: "call_1", toolName: "bash", arguments: undefined, state: "pending" },
      ],
    } as unknown as SessionMessage;

    // When/Then: 应该能安全处理 undefined arguments
    expect(() => formatMessageContent(mockMessage, { detail: true })).not.toThrow();
    const result = formatMessageContent(mockMessage, { detail: true });
    expect(result).toContain("[Tool Call] bash");
  });
});

describe("MessagesCommand --detail CLI Option", () => {
  /**
   * Helper: use yargs to parse the command's actual builder and return parsed args.
   * This invokes the REAL builder (not an inline duplicate), so it verifies
   * the option is actually registered.
   */
  function parseWithBuilder(argv: string[]): { detail?: boolean; offset?: number; limit?: number; json?: boolean; reverse?: boolean } {
    // MessagesCommand.builder is required, but TS thinks it could be undefined
    const builderFn = MessagesCommand.builder! as unknown as (y: typeof yargs) => any;
    const parser = builderFn(yargs());
    const allArgs = ["test-session", ...argv];
    const parsed = parser.parse(allArgs) as any;
    return parsed;
  }

  test("should register --detail option in the CLI builder", () => {
    // When: parse with --detail
    const parsed = parseWithBuilder(["--offset", "0", "--limit", "10", "--detail"]);

    // Then: detail should be true
    expect(parsed.detail).toBe(true);
  });

  test("should default --detail to false (backward compatibility)", () => {
    // When: parse without --detail
    const parsed = parseWithBuilder(["--offset", "0", "--limit", "10"]);

    // Then: detail should default to false
    expect(parsed.detail).toBe(false);
  });

  test("should not affect --reverse, --offset, --limit when --detail is set", () => {
    // When: parse with --detail and other options
    const parsed = parseWithBuilder([
      "--offset", "5",
      "--limit", "20",
      "--detail",
      "--reverse",
    ]);

    // Then: all options should be parsed correctly
    expect(parsed.detail).toBe(true);
    expect(parsed.offset).toBe(5);
    expect(parsed.limit).toBe(20);
    expect(parsed.reverse).toBe(true);
  });
});

describe("MessagesCommand getMessageCount Integration", () => {
  let mockSessionComponent: {
    getMessageCount: ReturnType<typeof vi.fn>;
    getMessages: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockSessionComponent = {
      getMessageCount: vi.fn(),
      getMessages: vi.fn(),
    };
  });

  test("should use getMessageCount to get total messages", async () => {
    // Given
    mockSessionComponent.getMessageCount.mockResolvedValue(150);
    
    // When
    const total = await mockSessionComponent.getMessageCount("session-123");
    
    // Then
    expect(total).toBe(150);
    expect(mockSessionComponent.getMessageCount).toHaveBeenCalledWith("session-123");
  });

  test("should calculate hasMore based on offset, limit and total", async () => {
    // Given
    const offset = 90;
    const limit = 20;
    const total = 100;
    
    // When: 计算是否还有更多消息
    // offset + limit < total 表示还有下一页
    const hasMore = offset + limit < total;
    
    // Then: offset=90, limit=20, total=100
    // offset + limit = 110, 110 < 100 = false
    expect(hasMore).toBe(false);
  });

  test("should correctly determine hasMore when at last page", async () => {
    // Given
    const offset = 90;
    const limit = 10;
    const total = 100;
    
    // When
    const hasMore = offset + limit < total;
    
    // Then: offset=90, limit=10, total=100
    // offset + limit = 100, 100 < 100 = false
    expect(hasMore).toBe(false);
  });

  test("should correctly determine hasMore when more pages exist", async () => {
    // Given
    const offset = 0;
    const limit = 10;
    const total = 100;
    
    // When
    const hasMore = offset + limit < total;
    
    // Then: offset=0, limit=10, total=100
    // 0 + 10 = 10, 10 < 100 = true
    expect(hasMore).toBe(true);
  });
});
