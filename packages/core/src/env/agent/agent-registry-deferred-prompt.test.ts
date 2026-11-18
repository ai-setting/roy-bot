/**
 * @fileoverview AgentRegistry 延迟解析 SystemPrompt 测试
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentRegistry } from "./agent-registry";

vi.mock("../log-trace/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const createMockConfigComponent = () => ({
  get: vi.fn((key: string) => {
    if (key === "agent.configDir") return "/tmp/empty-agents";
    return undefined;
  }),
  set: vi.fn(),
  registerSource: vi.fn(),
  load: vi.fn(),
  watch: vi.fn(),
});

const createMockPromptComponent = () => ({
  get: vi.fn((name: string) => {
    if (name === "subagent/explore") {
      return "You are an explore agent specialized for exploring codebases.";
    }
    return undefined;
  }),
  getPrompt: vi.fn(async (name: string) => {
    if (name === "subagent/explore") {
      return "You are an explore agent specialized for exploring codebases.";
    }
    return undefined;
  }),
});

describe("AgentRegistry - 延迟解析 SystemPrompt", () => {
  let mockConfigComponent: ReturnType<typeof createMockConfigComponent>;
  let mockPromptComponent: ReturnType<typeof createMockPromptComponent>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigComponent = createMockConfigComponent();
    mockPromptComponent = createMockPromptComponent();
  });

  it("should resolve systemPromptRef after PromptComponent becomes available", async () => {
    let promptComponentRef: ReturnType<typeof createMockPromptComponent> | null = null;

    const registry = new AgentRegistry({
      configComponent: mockConfigComponent as any,
      resolvePromptComponent: () => promptComponentRef,
      baseDir: "/tmp/test-roy-bot",
    });

    registry.register({
      name: "explore",
      type: "sub",
      systemPromptRef: "subagent/explore",
    });

    expect(await registry.getSystemPrompt("explore")).toBeUndefined();

    promptComponentRef = mockPromptComponent;

    expect(await registry.getSystemPrompt("explore")).toBe(
      "You are an explore agent specialized for exploring codebases."
    );
  });

  it("should resolve immediately when PromptComponent is available at init", async () => {
    const registry = new AgentRegistry({
      configComponent: mockConfigComponent as any,
      promptComponent: mockPromptComponent as any,
      baseDir: "/tmp/test-roy-bot",
    });

    registry.register({
      name: "explore",
      type: "sub",
      systemPromptRef: "subagent/explore",
    });

    expect(await registry.getSystemPrompt("explore")).toBe(
      "You are an explore agent specialized for exploring codebases."
    );
  });

  it("should retry resolution on each getSystemPrompt call without caching failures", async () => {
    let promptComponentRef: ReturnType<typeof createMockPromptComponent> | null = null;

    const registry = new AgentRegistry({
      configComponent: mockConfigComponent as any,
      resolvePromptComponent: () => promptComponentRef,
      baseDir: "/tmp/test-roy-bot",
    });

    registry.register({
      name: "test-agent",
      type: "sub",
      systemPromptRef: "subagent/explore",
    });

    expect(await registry.getSystemPrompt("test-agent")).toBeUndefined();

    promptComponentRef = mockPromptComponent;

    expect(await registry.getSystemPrompt("test-agent")).toBe(
      "You are an explore agent specialized for exploring codebases."
    );
  });
});
