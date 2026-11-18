/**
 * @fileoverview Memory Recall Command Tests
 * 
 * 测试：recall 命令（记忆读取）
 * 注意：--extract 功能已迁移到 record 命令
 */

import { describe, expect, test, vi } from "vitest";
import { RecallCommand } from "./recall";

describe("RecallCommand", () => {
  describe("command configuration", () => {
    test("should have correct command name", () => {
      expect(RecallCommand.command).toBe("recall");
    });

    test("should have aliases", () => {
      expect(RecallCommand.aliases).toContain("load");
    });

    test("should have description", () => {
      expect(RecallCommand.describe).toBe("读取所有 memory file 的内容");
    });
  });

  describe("builder - options", () => {
    test("should have config option", () => {
      const builder = RecallCommand.builder as Function;
      const mockOption = vi.fn().mockReturnThis();
      builder({ option: mockOption });
      
      const calls = mockOption.mock.calls;
      const configCall = calls.find((call: any[]) => call[0] === "config");
      expect(configCall).toBeDefined();
    });

    test("should have json option", () => {
      const builder = RecallCommand.builder as Function;
      const mockOption = vi.fn().mockReturnThis();
      builder({ option: mockOption });
      
      const calls = mockOption.mock.calls;
      const jsonCall = calls.find((call: any[]) => call[0] === "json");
      expect(jsonCall).toBeDefined();
      expect(jsonCall[1]).toMatchObject({
        type: "boolean",
        default: false,
      });
    });

    test("should have scope option without default (optional parameter)", () => {
      const builder = RecallCommand.builder as Function;
      const mockOption = vi.fn().mockReturnThis();
      builder({ option: mockOption });
      
      const calls = mockOption.mock.calls;
      const scopeCall = calls.find((call: any[]) => call[0] === "scope");
      expect(scopeCall).toBeDefined();
      expect(scopeCall[1]).toMatchObject({
        type: "string",
        choices: ["project", "global"],
        describe: "记忆作用域 (可选，不传则读取所有)",
      });
      // scope 是可选参数，不应该有默认值
      expect(scopeCall[1].default).toBeUndefined();
    });

    test("should NOT have extract option (migrated to record)", () => {
      const builder = RecallCommand.builder as Function;
      const mockOption = vi.fn().mockReturnThis();
      builder({ option: mockOption });
      
      const calls = mockOption.mock.calls;
      const extractCall = calls.find((call: any[]) => call[0] === "extract");
      expect(extractCall).toBeUndefined();
    });

    test("should NOT have session-id option (migrated to record)", () => {
      const builder = RecallCommand.builder as Function;
      const mockOption = vi.fn().mockReturnThis();
      builder({ option: mockOption });
      
      const calls = mockOption.mock.calls;
      const sessionIdCall = calls.find((call: any[]) => call[0] === "session-id");
      expect(sessionIdCall).toBeUndefined();
    });

    test("should NOT have require option (migrated to record)", () => {
      const builder = RecallCommand.builder as Function;
      const mockOption = vi.fn().mockReturnThis();
      builder({ option: mockOption });
      
      const calls = mockOption.mock.calls;
      const requireCall = calls.find((call: any[]) => call[0] === "require");
      expect(requireCall).toBeUndefined();
    });
  });

  describe("RecallOptions interface", () => {
    test("should include basic options", () => {
      const options = {
        config: "/path/to/config",
        json: true,
        scope: "global" as const,
      };

      expect(options.config).toBe("/path/to/config");
      expect(options.json).toBe(true);
      expect(options.scope).toBe("global");
    });

    test("scope should accept both project and global", () => {
      const projectOptions = { scope: "project" as const };
      const globalOptions = { scope: "global" as const };

      expect(projectOptions.scope).toBe("project");
      expect(globalOptions.scope).toBe("global");
    });
  });
});
