/**
 * @fileoverview Subagent resolver tests (TDD)
 */

import { describe, it, expect, vi } from "vitest";
import { AgentRegistry, DEFAULT_SUBAGENT_PROMPT } from "../../agent/agent-registry";
import { builtInSubAgents } from "./delegate-tool";
import {
  isKnownSubagentType,
  listKnownSubagentDescriptions,
  resolveSubAgentConfig,
} from "./subagent-resolver";

const createMockConfigComponent = () => ({
  get: vi.fn(),
});

const createMockPromptComponent = () => ({
  get: vi.fn((name: string) => {
    if (name === "subagent/explore") {
      return "Resolved explore prompt.";
    }
    return undefined;
  }),
  getPrompt: vi.fn(),
});

describe("subagent-resolver", () => {
  describe("isKnownSubagentType", () => {
    it("should accept built-in subagent types", () => {
      expect(isKnownSubagentType("general")).toBe(true);
      expect(isKnownSubagentType("explore")).toBe(true);
    });

    it("should accept custom agents from registry", () => {
      const registry = new AgentRegistry({
        configComponent: createMockConfigComponent(),
        promptComponent: createMockPromptComponent(),
        baseDir: "/tmp/subagent-resolver",
      });
      registry.register({
        name: "my-custom",
        type: "sub",
        description: "Custom",
      });

      expect(isKnownSubagentType("my-custom", registry)).toBe(true);
    });

    it("should reject unknown types", () => {
      expect(isKnownSubagentType("unknown-agent")).toBe(false);
    });
  });

  describe("resolveSubAgentConfig", () => {
    it("should resolve built-in subagent prompt", async () => {
      const builtIn = builtInSubAgents.find((a) => a.id === "general")!;
      const resolved = await resolveSubAgentConfig("general", {
        getBuiltIn: () => builtIn,
      });

      expect(resolved).toBeDefined();
      expect(resolved?.basePrompt).toContain("subagent");
      expect(resolved?.deniedTools).toContain("delegate_task");
    });

    it("should prefer registry config and resolve systemPromptRef", async () => {
      const registry = new AgentRegistry({
        configComponent: createMockConfigComponent(),
        promptComponent: createMockPromptComponent(),
        baseDir: "/tmp/subagent-resolver",
      });
      registry.register({
        name: "explore",
        type: "sub",
        systemPromptRef: "subagent/explore",
        allowedTools: ["glob"],
        deniedTools: ["delegate_task"],
      });

      const resolved = await resolveSubAgentConfig("explore", { registry });

      expect(resolved?.basePrompt).toBe("Resolved explore prompt.");
      expect(resolved?.allowedTools).toEqual(["glob"]);
      expect(resolved?.fromRegistry).toBe(true);
    });

    it("should fall back to DEFAULT_SUBAGENT_PROMPT for registry agent without prompt", async () => {
      const registry = new AgentRegistry({
        configComponent: createMockConfigComponent(),
        promptComponent: createMockPromptComponent(),
        baseDir: "/tmp/subagent-resolver",
      });
      registry.register({
        name: "empty-agent",
        type: "sub",
      });

      const resolved = await resolveSubAgentConfig("empty-agent", { registry });

      expect(resolved?.basePrompt).toBe(DEFAULT_SUBAGENT_PROMPT);
    });

    it("should return undefined for unknown subagent", async () => {
      const resolved = await resolveSubAgentConfig("does-not-exist", {});
      expect(resolved).toBeUndefined();
    });
  });

  describe("listKnownSubagentDescriptions", () => {
    it("should include built-in agents without registry", () => {
      const descriptions = listKnownSubagentDescriptions();
      expect(descriptions).toContain("- general:");
      expect(descriptions).toContain("- explore:");
    });

    it("should include custom registry subagents", () => {
      const registry = new AgentRegistry({
        configComponent: createMockConfigComponent(),
        promptComponent: createMockPromptComponent(),
        baseDir: "/tmp/subagent-resolver",
      });
      registry.register({
        name: "markdown-ontology-extractor",
        type: "sub",
        description: "Extract ontology from markdown documents",
      });

      const descriptions = listKnownSubagentDescriptions(registry);

      expect(descriptions).toContain(
        "- markdown-ontology-extractor: Extract ontology from markdown documents"
      );
    });

    it("should not duplicate built-in agents registered in registry", () => {
      const registry = new AgentRegistry({
        configComponent: createMockConfigComponent(),
        promptComponent: createMockPromptComponent(),
        baseDir: "/tmp/subagent-resolver",
      });
      registry.register({
        name: "explore",
        type: "sub",
        description: "Registry override should not appear as duplicate line",
      });
      registry.register({
        name: "my-custom",
        type: "sub",
        description: "Custom only agent",
      });

      const descriptions = listKnownSubagentDescriptions(registry);
      const exploreMatches = descriptions.match(/^- explore:/gm) ?? [];

      expect(exploreMatches).toHaveLength(1);
      expect(descriptions).toContain("- my-custom: Custom only agent");
    });

    it("should use English-only selection guide without duplicating built-in summaries", () => {
      const registry = new AgentRegistry({
        configComponent: createMockConfigComponent(),
        promptComponent: createMockPromptComponent(),
        baseDir: "/tmp/subagent-resolver",
      });
      registry.register({
        name: "my-custom",
        type: "sub",
        description: "Custom only agent",
      });

      const descriptions = listKnownSubagentDescriptions(registry);
      const guideSection = descriptions.split("## Agent Selection Guide")[1] ?? "";

      expect(descriptions).toContain("## Agent Selection Guide");
      expect(descriptions).not.toMatch(/[\u4e00-\u9fff]/);
      expect(guideSection).toContain("use `general` when no specialized agent fits");
      expect(guideSection).toContain("Custom agents from AgentRegistry are listed above.");
      expect(guideSection).not.toContain("exploring codebases");
      expect(guideSection).not.toContain("file_agent");
    });

    it("should mention registry note when no custom agents are registered", () => {
      const descriptions = listKnownSubagentDescriptions();

      expect(descriptions).toContain(
        "Custom agents from AgentRegistry appear above when registered."
      );
    });
  });

  describe("workflow type agent support", () => {
    it("isKnownSubagentType 应该接受 workflow 类型 agent", () => {
      const registry = new AgentRegistry({
        configComponent: createMockConfigComponent(),
        promptComponent: createMockPromptComponent(),
        baseDir: "/tmp/subagent-resolver",
      });
      registry.register({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
        description: "自动生成周报",
      });

      expect(isKnownSubagentType("weekly-report", registry)).toBe(true);
    });

    it("resolveSubAgentConfig 应该解析 workflow 类型 agent 的配置", async () => {
      const registry = new AgentRegistry({
        configComponent: createMockConfigComponent(),
        promptComponent: createMockPromptComponent(),
        baseDir: "/tmp/subagent-resolver",
      });
      registry.register({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
        description: "自动生成周报",
      });

      const resolved = await resolveSubAgentConfig("weekly-report", { registry });

      expect(resolved).toBeDefined();
      expect(resolved!.subagentType).toBe("weekly-report");
      expect(resolved!.description).toBe("自动生成周报");
      expect(resolved!.fromRegistry).toBe(true);
      // workflow agent 没有 system prompt
      expect(resolved!.basePrompt).toBe(DEFAULT_SUBAGENT_PROMPT);
    });

    it("listKnownSubagentDescriptions 应该包含 workflow 类型 agent", () => {
      const registry = new AgentRegistry({
        configComponent: createMockConfigComponent(),
        promptComponent: createMockPromptComponent(),
        baseDir: "/tmp/subagent-resolver",
      });
      registry.register({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
        description: "自动生成周报",
      });

      const descriptions = listKnownSubagentDescriptions(registry);
      expect(descriptions).toContain("- weekly-report: 自动生成周报 (workflow: weekly-report-workflow)");
    });
  });
});
