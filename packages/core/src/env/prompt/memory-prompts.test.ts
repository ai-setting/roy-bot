/**
 * @fileoverview Memory Agent Prompts Tests
 *
 * TDD 测试：Memory Agent prompts
 *
 * 背景（来自 /tmp/prompt-hallucination-audit.md，Task #2033 P0-2）：
 * - 旧版 prompt 把 `record_memory({ scope, mode, content, title })` 列为可用工具
 * - 但运行时 agent 实际白名单注册的只有 `write_memory`（来自 memory-agent-tools.ts）
 * - `write_memory` 的真实 schema 是：{ scope: "project" | "global", content: string }
 *   没有 `mode` 或 `title` 参数
 * - LLM 读 prompt 后会调 record_memory → 框架返回 tool-not-found → 浪费迭代
 *
 * 修复目标：prompt 中不应再出现 `record_memory` 字样，所有引用应改为 `write_memory`，
 * 参数描述要与 WriteMemorySchema 严格一致。
 */

import { describe, expect, test } from "vitest";
import { builtInPrompts, getBuiltInPrompt, getBuiltInPromptNames } from "./prompts-index";

describe("builtInPrompts", () => {
  describe("should have project-memory prompt", () => {
    test("project-memory prompt exists", () => {
      expect(builtInPrompts["project-memory"]).toBeDefined();
    });

    test("project-memory prompt contains role", () => {
      const prompt = builtInPrompts["project-memory"];
      expect(prompt).toContain("项目记忆管理专家");
    });

    test("project-memory prompt contains tools reference (search_sessions, get_session, write_memory)", () => {
      const prompt = builtInPrompts["project-memory"];
      expect(prompt).toContain("search_sessions");
      expect(prompt).toContain("get_session");
      // P0-2 修复：必须是 write_memory，不是 record_memory
      expect(prompt).toContain("write_memory");
    });

    test("project-memory prompt must NOT contain record_memory (P0-2 hallucination)", () => {
      const prompt = builtInPrompts["project-memory"];
      expect(prompt).not.toMatch(/record_memory/);
    });

    test("project-memory prompt contains variable placeholder", () => {
      const prompt = builtInPrompts["project-memory"];
      expect(prompt).toContain("{CURRENT_MEMORY}");
      expect(prompt).toContain("{USER_REQUIREMENT}");
      expect(prompt).toContain("{SCOPE}");
    });

    test("project-memory write_memory description matches WriteMemorySchema (scope, content)", () => {
      const prompt = builtInPrompts["project-memory"];
      // 抓取 write_memory 工具说明段
      const writeMemorySection = prompt.match(/write_memory[\s\S]{0,300}/);
      expect(writeMemorySection, "必须有 write_memory 说明").not.toBeNull();
      // 必须有 scope 参数
      expect(writeMemorySection![0]).toMatch(/scope/);
      // 必须有 content 参数
      expect(writeMemorySection![0]).toMatch(/content/);
      // P0-2 修复：不应该出现 mode 或 title 参数（write_memory schema 不接受它们）
      expect(writeMemorySection![0]).not.toMatch(/\bmode\b/);
      expect(writeMemorySection![0]).not.toMatch(/\btitle\b/);
    });
  });

  describe("should have global-memory prompt", () => {
    test("global-memory prompt exists", () => {
      expect(builtInPrompts["global-memory"]).toBeDefined();
    });

    test("global-memory prompt contains role", () => {
      const prompt = builtInPrompts["global-memory"];
      expect(prompt).toContain("全局记忆管理专家");
    });

    test("global-memory prompt contains tools reference (search_sessions, get_session, write_memory)", () => {
      const prompt = builtInPrompts["global-memory"];
      expect(prompt).toContain("search_sessions");
      expect(prompt).toContain("get_session");
      // P0-2 修复：必须是 write_memory，不是 record_memory
      expect(prompt).toContain("write_memory");
    });

    test("global-memory prompt must NOT contain record_memory (P0-2 hallucination)", () => {
      const prompt = builtInPrompts["global-memory"];
      expect(prompt).not.toMatch(/record_memory/);
    });

    test("global-memory prompt contains variable placeholder", () => {
      const prompt = builtInPrompts["global-memory"];
      expect(prompt).toContain("{CURRENT_MEMORY}");
      expect(prompt).toContain("{USER_REQUIREMENT}");
      expect(prompt).toContain("{SCOPE}");
    });

    test("global-memory write_memory description matches WriteMemorySchema (scope, content)", () => {
      const prompt = builtInPrompts["global-memory"];
      const writeMemorySection = prompt.match(/write_memory[\s\S]{0,300}/);
      expect(writeMemorySection, "必须有 write_memory 说明").not.toBeNull();
      expect(writeMemorySection![0]).toMatch(/scope/);
      expect(writeMemorySection![0]).toMatch(/content/);
      // P0-2 修复：不应该出现 mode 或 title 参数
      expect(writeMemorySection![0]).not.toMatch(/\bmode\b/);
      expect(writeMemorySection![0]).not.toMatch(/\btitle\b/);
    });
  });
});

describe("getBuiltInPrompt", () => {
  test("should return project-memory prompt", () => {
    const prompt = getBuiltInPrompt("project-memory");
    expect(prompt).toBeDefined();
    expect(prompt).toContain("项目记忆管理专家");
  });

  test("should return global-memory prompt", () => {
    const prompt = getBuiltInPrompt("global-memory");
    expect(prompt).toBeDefined();
    expect(prompt).toContain("全局记忆管理专家");
  });

  test("should return undefined for unknown prompt", () => {
    const prompt = getBuiltInPrompt("unknown-prompt");
    expect(prompt).toBeUndefined();
  });
});