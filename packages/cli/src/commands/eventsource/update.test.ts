/**
 * @fileoverview EventSource Update Command Tests
 *
 * TDD 流程：
 * 1. 测试命令定义（builder, command, describe）
 * 2. 测试选项解析（positional + options）
 * 3. 测试 handler 逻辑（通过 mock 注入）
 */

import { describe, test, expect, vi } from "bun:test";
import { EventSourceUpdateCommand } from "./update";

describe("EventSourceUpdateCommand", () => {
  describe("command definition", () => {
    test("should have correct command name", () => {
      expect(EventSourceUpdateCommand.command).toBe("update <id>");
    });

    test("should have describe text", () => {
      expect(typeof EventSourceUpdateCommand.describe).toBe("string");
      expect(EventSourceUpdateCommand.describe.length).toBeGreaterThan(0);
    });

    test("should have builder function", () => {
      expect(typeof EventSourceUpdateCommand.builder).toBe("function");
    });

    test("should have handler function", () => {
      expect(typeof EventSourceUpdateCommand.handler).toBe("function");
    });
  });

  describe("builder", () => {
    test("should add positional id option", () => {
      // Given
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      // When
      EventSourceUpdateCommand.builder(mockYargs as any);

      // Then
      const positionalCalls = mockYargs.positional.mock.calls;
      const idPositional = positionalCalls.find(
        (call: any[]) => call[0] === "id",
      );
      expect(idPositional).toBeDefined();
      expect(idPositional![1].type).toBe("string");
      expect(idPositional![1].demandOption).toBe(true);
    });

    test("should add --interval option with number type", () => {
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      EventSourceUpdateCommand.builder(mockYargs as any);

      const optionCalls = mockYargs.option.mock.calls;
      const intervalOption = optionCalls.find(
        (call: any[]) => call[0] === "interval",
      );
      expect(intervalOption).toBeDefined();
      expect(intervalOption![1].type).toBe("number");
      expect(intervalOption![1].alias).toBe("i");
    });

    test("should add --prompt option", () => {
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      EventSourceUpdateCommand.builder(mockYargs as any);

      const optionCalls = mockYargs.option.mock.calls;
      const promptOption = optionCalls.find(
        (call: any[]) => call[0] === "prompt",
      );
      expect(promptOption).toBeDefined();
      expect(promptOption![1].type).toBe("string");
    });

    test("should add --event-types, --command, --url, --cron options", () => {
      const mockYargs = {
        option: vi.fn().mockReturnThis(),
        positional: vi.fn().mockReturnThis(),
      };

      EventSourceUpdateCommand.builder(mockYargs as any);

      const optionCalls = mockYargs.option.mock.calls;
      const optionNames = optionCalls.map((c: any[]) => c[0]);

      expect(optionNames).toContain("event-types");
      expect(optionNames).toContain("command");
      expect(optionNames).toContain("url");
      expect(optionNames).toContain("cron");
      expect(optionNames).toContain("enabled");
      expect(optionNames).toContain("name");
    });
  });
});
