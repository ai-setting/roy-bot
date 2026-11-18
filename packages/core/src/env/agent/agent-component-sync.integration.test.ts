/**
 * @fileoverview AgentComponent syncRegistryAgentsFromConfig 集成测试
 *
 * 验证 PromptComponent 注册到 Environment 后，sync 能正确解析 systemPromptRef
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";
import type { PromptComponent } from "../prompt/prompt-component";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../log-trace/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const EXPLORE_PROMPT = "You are the explore subagent from persisted prompt. Reply briefly.";

function createMockPromptComponent(): PromptComponent {
  return {
    get: vi.fn((name: string) => {
      if (name === "subagent/explore") return EXPLORE_PROMPT;
      return undefined;
    }),
    getPrompt: vi.fn(async (name: string) => {
      if (name === "subagent/explore") return EXPLORE_PROMPT;
      return undefined;
    }),
  } as unknown as PromptComponent;
}

describe("AgentComponent.syncRegistryAgentsFromConfig", () => {
  let configComponent: ConfigComponent;
  let agentComponent: AgentComponent;
  let promptComponent: PromptComponent;
  let env: Environment;
  let tempDir: string;
  let emptyAgentsDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sync-test-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fs.mkdirSync(emptyAgentsDir, { recursive: true });

    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);

    promptComponent = createMockPromptComponent();
    agentComponent = new AgentComponent();

    env = {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((name: string) => {
        if (name === "config") return configComponent;
        if (name === "prompt") return promptComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => name === "config" || name === "prompt"),
    } as unknown as Environment;

    await agentComponent.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });

    const registry = agentComponent.getRegistry()!;
    registry.register({
      name: "explore",
      type: "sub",
      systemPromptRef: "subagent/explore",
      allowedTools: ["glob", "grep", "read", "bash"],
    });

    agentComponent.registerAgent("explore", {
      type: "sub",
      systemPromptRef: "subagent/explore",
      allowedTools: ["glob", "grep", "read", "bash"],
    });
  });

  it("should not resolve systemPrompt when prompt component is not on env", async () => {
    const envWithoutPrompt = {
      ...env,
      getComponent: vi.fn((name: string) => {
        if (name === "config") return configComponent;
        return undefined;
      }),
    } as unknown as Environment;

    (agentComponent as any).env = envWithoutPrompt;

    await agentComponent.syncRegistryAgentsFromConfig();

    const agent = agentComponent.getAgent("explore");
    expect(agent?.config.systemPrompt).toBeUndefined();
    expect(agent?.config.systemPromptRef).toBe("subagent/explore");
  });

  it("should resolve systemPrompt when prompt component is registered on env", async () => {
    await agentComponent.syncRegistryAgentsFromConfig();

    const agent = agentComponent.getAgent("explore");
    expect(agent?.config.systemPrompt).toBe(EXPLORE_PROMPT);
    expect(agent?.config.systemPromptRef).toBe("subagent/explore");
  });

  it("should register missing agent with systemPromptRef during sync", async () => {
    agentComponent.unregisterAgent("explore");

    await agentComponent.syncRegistryAgentsFromConfig();

    const agent = agentComponent.getAgent("explore");
    expect(agent).toBeDefined();
    expect(agent?.config.systemPrompt).toBe(EXPLORE_PROMPT);
    expect(agent?.config.systemPromptRef).toBe("subagent/explore");
  });
});

describe("AgentComponent.resolveSystemPrompt via run entry", () => {
  it("should resolve systemPromptRef before LLM when sync was skipped", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-test-"));
    const emptyAgentsDir = path.join(tempDir, "empty-agents");
    fs.mkdirSync(emptyAgentsDir, { recursive: true });

    const configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);

    const promptComponent = createMockPromptComponent();
    let promptAvailable = false;

    const env = {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((name: string) => {
        if (name === "config") return configComponent;
        if (name === "prompt" && promptAvailable) return promptComponent;
        if (name === "llm") {
          return {
            invoke: vi.fn(async () => ({
              output: { content: "done", finishReason: "stop" },
            })),
          };
        }
        if (name === "tool") return { listTools: vi.fn(() => []) };
        return undefined;
      }),
    } as unknown as Environment;

    const agentComponent = new AgentComponent();
    await agentComponent.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });

    agentComponent.getRegistry()!.register({
      name: "explore",
      type: "sub",
      systemPromptRef: "subagent/explore",
    });

    agentComponent.registerAgent("explore", {
      type: "sub",
      systemPromptRef: "subagent/explore",
      maxIterations: 1,
    });

    promptAvailable = true;

    await agentComponent.run("explore", "hello");

    const agent = agentComponent.getAgent("explore");
    expect(agent?.config.systemPrompt).toBe(EXPLORE_PROMPT);
  });
});
