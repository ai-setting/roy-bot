/**
 * @fileoverview Task #2039 - {{agent_name}} 运行时注入路径测试
 *
 * 目标：覆盖 packages/core/src/env/environment.ts 中
 *       handle_query() 对 {{agent_name}} 占位符的替换逻辑
 *
 * 测试维度：
 * 1. metadata.defaultAgentName 命中 → 替换为指定名字
 * 2. metadata.defaultAgentName 缺失/空 → 回退 "Roy"
 * 3. 已注册 agent 的 systemPrompt 也应被替换
 * 4. 模板不含占位符 → 不替换
 * 5. 特殊字符 → 原样保留（不做 escape）
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { BaseEnvironment } from "./environment";
import { AgentComponent } from "./agent/agent-component";
import { ConfigComponent } from "../config/config-component";
import { BaseComponent } from "./component";
import type { AgentContext } from "./agent/types";

// ============================================================================
// Test Double: MockPromptComponent
// 返回包含 {{agent_name}} 占位符的固定模板，并记录替换后的 systemPrompt
// ============================================================================

class MockPromptComponent extends BaseComponent {
  readonly name = "prompt";
  readonly version = "1.0.0";

  /** Mock template with placeholder */
  readonly template: string;

  /** Latest fetched content (post-handle_query), for assertion */
  lastFetchedName?: string;

  constructor(template: string = `你好 {{agent_name}}, workspace: {{workspace_dir}}, memory: {{memory}}`) {
    super();
    this.template = template;
  }

  protected async onInit(): Promise<void> {
    this.setStatus("running");
  }

  /** Mirror of PromptComponent.getPrompt */
  async getPrompt(name: string, _variables: Record<string, string> = {}): Promise<string> {
    this.lastFetchedName = name;
    return this.template;
  }
}

// ============================================================================
// Test setup helpers
// ============================================================================

async function createTestEnv(template?: string): Promise<{
  env: BaseEnvironment;
  agentComponent: AgentComponent;
  promptComponent: MockPromptComponent;
}> {
  const env = new BaseEnvironment({ name: "test-env" });
  const configComponent = new ConfigComponent();
  const agentComponent = new AgentComponent();
  const promptComponent = new MockPromptComponent(template);

  env.registerComponent(configComponent);
  env.registerComponent(promptComponent);
  env.registerComponent(agentComponent);

  await agentComponent.init({
    name: "agent",
    version: "1.0.0",
    enabled: true,
    env: env as any,
    options: { configComponent },
  });

  return { env, agentComponent, promptComponent };
}

// ============================================================================
// Test suites
// ============================================================================

describe("environment.ts - {{agent_name}} runtime injection", () => {
  let env: BaseEnvironment;
  let agentComponent: AgentComponent;
  let promptComponent: MockPromptComponent;

  beforeEach(async () => {
    const setup = await createTestEnv();
    env = setup.env;
    agentComponent = setup.agentComponent;
    promptComponent = setup.promptComponent;
  });

  describe("default agent path (no pre-registered agent)", () => {
    test("substitutes metadata.defaultAgentName into {{agent_name}} placeholder", async () => {
      const context: AgentContext = {
        metadata: { defaultAgentName: "Alice" },
      };

      await env.handle_query("hi", context);

      const agent = agentComponent.getAgent("default");
      expect(agent).toBeDefined();
      expect(agent!.config.systemPrompt).toContain("Alice");
      expect(agent!.config.systemPrompt).not.toContain("{{agent_name}}");
    });

    test("falls back to 'Roy' when metadata is missing", async () => {
      await env.handle_query("hi", { metadata: {} } as AgentContext);

      const agent = agentComponent.getAgent("default");
      expect(agent!.config.systemPrompt).toContain("Roy");
      expect(agent!.config.systemPrompt).not.toContain("{{agent_name}}");
    });

    test("falls back to 'Roy' when context is undefined", async () => {
      await env.handle_query("hi");

      const agent = agentComponent.getAgent("default");
      expect(agent!.config.systemPrompt).toContain("Roy");
      expect(agent!.config.systemPrompt).not.toContain("{{agent_name}}");
    });

    test("falls back to 'Roy' when defaultAgentName is null", async () => {
      const context: AgentContext = {
        metadata: { defaultAgentName: null },
      };

      await env.handle_query("hi", context);

      const agent = agentComponent.getAgent("default");
      expect(agent!.config.systemPrompt).toContain("Roy");
    });

    test("falls back to 'Roy' when defaultAgentName is empty string", async () => {
      const context: AgentContext = {
        metadata: { defaultAgentName: "" },
      };

      await env.handle_query("hi", context);

      const agent = agentComponent.getAgent("default");
      expect(agent!.config.systemPrompt).toContain("Roy");
    });

    test("leaves special chars in agent name intact (no escaping)", async () => {
      const context: AgentContext = {
        metadata: { defaultAgentName: "X-Y_1.0" },
      };

      await env.handle_query("hi", context);

      const agent = agentComponent.getAgent("default");
      expect(agent!.config.systemPrompt).toContain("X-Y_1.0");
    });

    test("does not touch prompt when no placeholder is present", async () => {
      const setup = await createTestEnv("static prompt with no placeholder");
      await setup.env.handle_query("hi", { metadata: { defaultAgentName: "Alice" } });

      const agent = setup.agentComponent.getAgent("default");
      expect(agent!.config.systemPrompt).toBe("static prompt with no placeholder");
    });
  });

  describe("pre-registered agent path", () => {
    test("also substitutes {{agent_name}} for pre-registered agents", async () => {
      // Pre-register an agent that has {{agent_name}} in its systemPrompt
      agentComponent.registerAgent("my-agent", {
        type: "primary",
        systemPrompt: "I am {{agent_name}}, the pre-registered agent",
      });

      const context: AgentContext = {
        agentType: "my-agent",
        metadata: { defaultAgentName: "Bob" },
      };

      await env.handle_query("hi", context);

      const agent = agentComponent.getAgent("my-agent");
      expect(agent).toBeDefined();
      expect(agent!.config.systemPrompt).toContain("Bob");
      expect(agent!.config.systemPrompt).not.toContain("{{agent_name}}");
    });

    test("falls back to 'Roy' for pre-registered agent when metadata missing", async () => {
      agentComponent.registerAgent("my-agent", {
        type: "primary",
        systemPrompt: "I am {{agent_name}}",
      });

      await env.handle_query("hi", { agentType: "my-agent" } as AgentContext);

      const agent = agentComponent.getAgent("my-agent");
      expect(agent!.config.systemPrompt).toContain("Roy");
    });

    test("replaces multiple {{agent_name}} occurrences", async () => {
      agentComponent.registerAgent("multi-agent", {
        type: "primary",
        systemPrompt: "{{agent_name}} says: I am {{agent_name}}, the {{agent_name}} system",
      });

      await env.handle_query("hi", {
        agentType: "multi-agent",
        metadata: { defaultAgentName: "Zoe" },
      } as AgentContext);

      const agent = agentComponent.getAgent("multi-agent");
      const sp = agent!.config.systemPrompt!;
      expect(sp).not.toContain("{{agent_name}}");
      // Count Zoe occurrences — should be 3 (one per placeholder)
      const matches = sp.match(/Zoe/g) ?? [];
      expect(matches.length).toBe(3);
    });
  });

  describe("DRY / refactor safety net", () => {
    /**
     * After the refactor, both code paths should share the same
     * `injectAgentNamePlaceholder()` helper. These tests act as a regression net
     * to make sure behavior is consistent between the two paths.
     */
    test("default agent path and pre-registered path produce same substituted name", async () => {
      const ctxAlice: AgentContext = { metadata: { defaultAgentName: "Alice" } };

      // Path 1: default agent
      await env.handle_query("p1", ctxAlice);
      const defaultAgent = agentComponent.getAgent("default");
      const defaultSP = defaultAgent!.config.systemPrompt!;

      // Path 2: pre-registered agent
      agentComponent.registerAgent("prereg", {
        type: "primary",
        systemPrompt: thisPromptComponentTemplate(),
      });
      await env.handle_query("p2", { agentType: "prereg", metadata: { defaultAgentName: "Alice" } } as AgentContext);
      const preAgent = agentComponent.getAgent("prereg");
      const preSP = preAgent!.config.systemPrompt!;

      // Both paths should have injected "Alice" and stripped the placeholder
      expect(defaultSP).toContain("Alice");
      expect(defaultSP).not.toContain("{{agent_name}}");
      expect(preSP).toContain("Alice");
      expect(preSP).not.toContain("{{agent_name}}");
    });

    function thisPromptComponentTemplate(): string {
      return promptComponent.template;
    }
  });
});