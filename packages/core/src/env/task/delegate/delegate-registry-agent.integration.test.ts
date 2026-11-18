/**
 * @fileoverview delegate_task + AgentRegistry 集成测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { AgentRegistry } from "../../agent/agent-registry";
import { PromptStore } from "../../prompt/prompt-store";
import { PromptComponent } from "../../prompt/prompt-component";
import { ConfigComponent } from "../../../config/config-component";
import {
  createDelegateTool,
  type DelegateToolParams,
} from "./delegate-tool";
import { isKnownSubagentType, resolveSubAgentConfig } from "./subagent-resolver";

describe("delegate_task custom registry agent integration", () => {
  let baseDir: string;
  let configComponent: ConfigComponent;
  let promptComponent: PromptComponent;
  let registry: AgentRegistry;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "roy-delegate-int-"));
    const promptsDir = join(baseDir, "prompts");
    const agentsDir = join(baseDir, "agents");

    configComponent = new ConfigComponent();
    await configComponent.init({
      name: "config",
      version: "1.0.0",
      enabled: true,
      env: null as any,
    });
    await configComponent.set("prompt.configDir", promptsDir);
    await configComponent.set("agent.configDir", agentsDir);

    const promptStore = new PromptStore({ configDir: promptsDir });
    await promptStore.savePrompt(
      "subagent/registry-test",
      "You are registry-test subagent. Always reply exactly: REGISTRY_AGENT_OK"
    );

    promptComponent = new PromptComponent();
    await promptComponent.init({
      name: "prompt",
      version: "1.0.0",
      enabled: true,
      env: { getComponent: (n: string) => (n === "config" ? configComponent : undefined) } as any,
      options: { configComponent },
    });

    registry = new AgentRegistry({
      configComponent,
      promptComponent,
      baseDir,
    });
    await registry.saveAgent({
      name: "registry-test",
      type: "sub",
      description: "Registry-backed delegate subagent",
      systemPromptRef: "subagent/registry-test",
      deniedTools: ["delegate_task", "stop_task"],
    });
  });

  afterEach(async () => {
    await promptComponent.stop();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("should recognize custom registry subagent type", () => {
    expect(isKnownSubagentType("registry-test", registry)).toBe(true);
    expect(isKnownSubagentType("unknown-custom", registry)).toBe(false);
  });

  it("should list custom registry agent in delegate_task description", () => {
    const mockSessionComponent = {
      get: vi.fn(),
      create: vi.fn(),
      addMessage: vi.fn(),
    };
    const mockAgentComponent = {
      getAgent: vi.fn(() => undefined),
      registerAgent: vi.fn((name: string, config: any) => ({ name, config })),
      getRegistry: vi.fn(() => registry),
    };
    const mockTaskComponent: any = {
      getTagService: () => ({
        listTags: vi.fn().mockResolvedValue([]),
        findSimilarTasks: vi.fn().mockResolvedValue([]),
      }),
      env: {
        getComponent: (name: string) => {
          if (name === "session") return mockSessionComponent;
          if (name === "agent") return mockAgentComponent;
          return undefined;
        },
      },
    };

    const tool = createDelegateTool(mockTaskComponent);

    expect(tool.description).toContain(
      "- registry-test: Registry-backed delegate subagent"
    );
  });

  it("should resolve custom agent prompt from persisted PromptStore", async () => {
    const resolved = await resolveSubAgentConfig("registry-test", { registry });
    expect(resolved?.basePrompt).toContain("REGISTRY_AGENT_OK");
    expect(resolved?.fromRegistry).toBe(true);
  });

  it("should execute delegate_task using registry agent via handle_query", async () => {
    const handleQuery = vi.fn().mockResolvedValue("REGISTRY_AGENT_OK");

    const mockSessionComponent = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ id: "parent-session" })
        .mockResolvedValueOnce({
          id: "sub-session-1",
          info: { metadata: { subagent_type: "registry-test" } },
        }),
      create: vi.fn().mockResolvedValue({
        id: "sub-session-1",
        info: { metadata: { subagent_type: "registry-test" } },
      }),
      addMessage: vi.fn().mockResolvedValue(undefined),
    };

    const mockAgentComponent = {
      getRegistry: () => registry,
      getAgent: vi.fn().mockReturnValue(undefined),
      registerAgent: vi.fn((name: string, config: any) => ({ name, config })),
    };

    const mockTaskComponent: any = {
      getTagService: () => ({
        listTags: vi.fn().mockResolvedValue([]),
        findSimilarTasks: vi.fn().mockResolvedValue([]),
      }),
      env: {
        getComponent: (name: string) => {
          if (name === "session") return mockSessionComponent;
          if (name === "agent") return mockAgentComponent;
          return undefined;
        },
        handle_query: handleQuery,
      },
    };

    const tool = createDelegateTool(mockTaskComponent);

    const result = await tool.execute(
      {
        description: "registry verify",
        similar_task_ids: [],
        prompt: "Reply with only REGISTRY_AGENT_OK",
        subagent_type: "registry-test",
      } satisfies DelegateToolParams,
      { session_id: "parent-session" } as any
    );

    expect(result.success).toBe(true);
    // ★ background 模式下返回 bgProcessId，sub-agent 内部自行创建 Task
    expect(result.metadata?.bgProcessId).toBeDefined();
    expect(result.metadata?.task_id).toBeUndefined();
  });
});
