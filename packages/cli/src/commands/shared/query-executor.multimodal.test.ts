/**
 * @fileoverview QueryExecutor 多模态 payload 测试
 *
 * TDD RED: 验证 QueryExecutor.execute() 接受 ContentPart[]
 * 并把它透传给 ContextHandler.handleQueryWithContext()
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContentPart } from "@ai-setting/roy-bot-core";
import { QueryExecutor } from "./query-executor";
import { OutputService } from "../../services/output.service";
import { ContextHandlerService } from "../../services/context-handler.service";

describe("QueryExecutor — multimodal payload", () => {
  let queryExecutor: QueryExecutor;
  let mockEnv: any;
  let mockSessionComponent: any;
  let mockOutput: OutputService;
  let handleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const mockUnsubscribe = vi.fn();
    mockEnv = {
      subscribeTo: vi.fn().mockReturnValue(mockUnsubscribe),
      getComponent: vi.fn(),
      pushEnvEvent: vi.fn(),
    };
    mockSessionComponent = {
      setSummaryComponents: vi.fn(),
      compact: vi.fn(),
    };
    mockOutput = new OutputService();
    mockOutput.configure({ quiet: true });

    // Spy on ContextHandlerService.handleQueryWithContext
    handleSpy = vi
      .spyOn(ContextHandlerService.prototype, "handleQueryWithContext")
      .mockResolvedValue("ok");

    queryExecutor = new QueryExecutor({
      env: mockEnv,
      sessionComponent: mockSessionComponent,
      output: mockOutput,
      quiet: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    queryExecutor.dispose();
  });

  test("accepts string payload (backward compat)", async () => {
    await queryExecutor.execute("hello", "session-1");
    expect(handleSpy).toHaveBeenCalledTimes(1);
    const [query] = handleSpy.mock.calls[0];
    expect(query).toBe("hello");
  });

  test("accepts ContentPart[] payload and forwards as-is", async () => {
    const payload: ContentPart[] = [
      { type: "text", text: "describe" },
      { type: "image", image: Buffer.from([0x89, 0x50]) },
    ];

    await queryExecutor.execute(payload, "session-2");

    expect(handleSpy).toHaveBeenCalledTimes(1);
    const [forwarded] = handleSpy.mock.calls[0];
    expect(Array.isArray(forwarded)).toBe(true);
    expect(forwarded).toEqual(payload);
  });

  test("preserves URL string in image part (not coerced to Buffer)", async () => {
    const url = "https://example.com/x.png";
    const payload: ContentPart[] = [
      { type: "text", text: "from web" },
      { type: "image", image: url },
    ];

    await queryExecutor.execute(payload, "session-3");

    const [forwarded] = handleSpy.mock.calls[0];
    expect(Array.isArray(forwarded)).toBe(true);
    const parts = forwarded as ContentPart[];
    expect((parts[1] as any).image).toBe(url);
  });
});