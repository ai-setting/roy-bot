/**
 * @fileoverview Dim 6 multi-block production wire test (Task #2760)
 *
 * Background (claude review #2759):
 * - `buildMultiBlockSystem` helper supports 4 segments:
 *     [0] characterSheet (rarely changes, cached via cache_control)
 *     [1] toolDefinitions (changes when config changes, cached)
 *     [2] memoryBlock (changes when memory changes, no cache)
 *     [3] dynamicContext (currentTaskId etc, no cache)
 * - The production call site at agent-component.ts:2416-2425 only passes
 *     { characterSheet, dynamicContext } — `toolDefinitions` and `memoryBlock`
 *     are silently dropped.
 * - Unit tests in `llm-cache-options.test.ts` T4.1/T4.2 only exercise the
 *     helper in isolation, not the production call site.
 * - Result: production code only emits 2 system messages, not 4.
 *
 * This file provides 2 RED tests that exercise the FULL production path:
 *  1. D6.segments: When `ctx.tools` is populated, the production call to
 *     `buildMultiBlockSystem` should be passed non-empty `toolDefinitions`.
 *  2. D6.toolDefContent: The tool definitions string should contain the
 *     tool names from ctx.tools, so the helper can produce a separate
 *     cache-friendly segment.
 *
 * Tests will fail on current code (toolDefinitions empty) and pass after
 * the fix populates toolDefinitions in buildMessages.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";

interface MockSessionState {
  messages: unknown[];
  metadata: Record<string, unknown>;
}

function createMockSessionComponent() {
  const sessions = new Map<string, MockSessionState>();
  return {
    _sessions: sessions,
    get: vi.fn(async (sessionId: string) => {
      const state = sessions.get(sessionId) ?? { messages: [], metadata: {} };
      return {
        id: sessionId,
        title: "test",
        directory: "/tmp",
        parentId: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
        metadata: state.metadata,
      };
    }),
    update: vi.fn(async (sessionId: string, updates: { metadata?: Record<string, unknown> }) => {
      const state = sessions.get(sessionId) ?? { messages: [], metadata: {} };
      if (updates.metadata) {
        state.metadata = { ...state.metadata, ...updates.metadata };
      }
      sessions.set(sessionId, state);
      return true;
    }),
  };
}

function createMockLLMComponent() {
  return {
    invoke: vi.fn(() =>
      Promise.resolve({
        output: {
          content: "test response",
          toolCalls: [],
        },
      })
    ),
  };
}

function createMockMemoryComponent(recallResult: string) {
  return {
    recallMemory: vi.fn(async () => recallResult),
  };
}

function createMockEnv(
  sessionComponent: unknown,
  configComponent: ConfigComponent,
  llmComponent: unknown,
  memoryComponent: unknown,
): Environment {
  const getComponent = vi.fn((name: string) => {
    if (name === "session") return sessionComponent;
    if (name === "config") return configComponent;
    if (name === "llm") return llmComponent;
    if (name === "memory") return memoryComponent;
    return undefined;
  });
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent,
    pushEnvEvent: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    shutdown: vi.fn(async () => {}),
  } as unknown as Environment;
}

describe("Dim 6 multi-block production wire — buildMessages fills all 4 segments", () => {
  let configComponent: ConfigComponent;
  let sessionComponent: ReturnType<typeof createMockSessionComponent>;
  let llmComponent: ReturnType<typeof createMockLLMComponent>;
  let memoryComponent: ReturnType<typeof createMockMemoryComponent>;
  let mockEnv: Environment;
  let agentComponent: AgentComponent;

  beforeEach(async () => {
    vi.clearAllMocks();

    const fsSync = await import("fs");
    const path = await import("path");
    const os = await import("os");
    const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-multiblock-prod-test-"));
    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    await configComponent.set("workspace_dir", "/home/test/workspace");
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = createMockLLMComponent();
    memoryComponent = createMockMemoryComponent("User memory: prefers TypeScript.");
    mockEnv = createMockEnv(sessionComponent, configComponent, llmComponent, memoryComponent);

    agentComponent = new AgentComponent();
    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Spy on buildMultiBlockSystem to capture the actual arguments passed
   * by the production buildMessages call site. This is the RED test surface.
   */
  function setupBuildMultiBlockSpy() {
    const agentComponentModule = require("./agent-component") as typeof import("./agent-component");
    const spy = vi.spyOn(agentComponentModule, "buildMultiBlockSystem");
    return spy;
  }

  it("D6.segments: buildMessages calls buildMultiBlockSystem with toolDefinitions populated (not undefined/empty)", async () => {
    const buildMultiBlockSystemSpy = setupBuildMultiBlockSpy();

    // Register an agent. The system prompt will go through `ctx.systemPrompt`.
    // Tools come in via `extraTools` in the run context, which appends to
    // ctx.tools through getAvailableTools → toolComponent.
    const originalPrompt = "工作目录: {{workspace_dir}}\n记忆: {{memory}}\n开始。";
    agentComponent.registerAgent("multiblock-prod-agent", {
      type: "primary",
      systemPrompt: originalPrompt,
      maxIterations: 1,
    });

    // Run one turn with extraTools to populate ctx.tools
    await agentComponent.run("multiblock-prod-agent", "test query", {
      sessionId: "session_d6_segments",
      additionInfo: "[Task #1] running",
      extraTools: [
        {
          name: "bash",
          description: "Run shell commands",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
        {
          name: "read_file",
          description: "Read file contents",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ] as never,
    });

    // Verify buildMultiBlockSystem was called
    expect(buildMultiBlockSystemSpy).toHaveBeenCalled();
    const callArgs = buildMultiBlockSystemSpy.mock.calls[0]?.[0] as
      | {
          characterSheet?: string;
          toolDefinitions?: string;
          memoryBlock?: string;
          dynamicContext?: string;
        }
      | undefined;
    expect(callArgs).toBeDefined();

    // Baseline assertions (already pass): characterSheet + dynamicContext
    expect(callArgs!.characterSheet).toBeDefined();
    expect(callArgs!.characterSheet!.length).toBeGreaterThan(0);
    expect(callArgs!.dynamicContext).toBe("[Task #1] running");

    // RED: After fix, toolDefinitions should be non-empty and contain tool names
    expect(callArgs!.toolDefinitions).toBeDefined();
    expect(callArgs!.toolDefinitions!.length).toBeGreaterThan(0);
    expect(callArgs!.toolDefinitions).toContain("bash");
    expect(callArgs!.toolDefinitions).toContain("read_file");
  });

  it("D6.toolDefContent: toolDefinitions segment is content-stable across turns (cache-friendly)", async () => {
    const buildMultiBlockSystemSpy = setupBuildMultiBlockSpy();

    agentComponent.registerAgent("multiblock-cache-agent", {
      type: "primary",
      systemPrompt: "static system prompt",
      maxIterations: 1,
    });

    const sharedTools = [
      {
        name: "bash",
        description: "Run shell commands",
        parameters: { type: "object" },
      },
    ] as never;

    // Run three turns with different additionInfo
    for (let i = 0; i < 3; i++) {
      await agentComponent.run("multiblock-cache-agent", `query ${i}`, {
        sessionId: "session_d6_cache",
        additionInfo: `[Task #${i + 1}] different`,
        extraTools: sharedTools,
      });
    }

    // Either called multiple times (cache miss) or once (cache snapshot hit). Both are fine.
    // The key invariant: toolDefinitions is non-empty and contains the tool name.
    expect(buildMultiBlockSystemSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const callsArgs = buildMultiBlockSystemSpy.mock.calls.map(
      (c) => c[0] as { toolDefinitions?: string; dynamicContext?: string }
    );

    // toolDefinitions segment should be defined and non-empty
    const firstToolDef = callsArgs[0].toolDefinitions;
    expect(firstToolDef).toBeDefined();
    expect(firstToolDef!.length).toBeGreaterThan(0);
    expect(firstToolDef).toContain("bash");

    // When multiple calls happened (cache miss path), toolDefinitions must be
    // byte-equal across all calls (this is the cache hit invariant).
    if (callsArgs.length >= 2) {
      for (let i = 1; i < callsArgs.length; i++) {
        expect(callsArgs[i].toolDefinitions).toBe(firstToolDef);
      }
    }
  });
});
