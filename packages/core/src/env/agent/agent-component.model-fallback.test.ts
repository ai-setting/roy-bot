/**
 * @fileoverview TDD tests for Task #4623 — model inheritance to sub-agents
 * and the `--fallback-model` downgrade mechanism.
 *
 * RED phase — the implementation does not exist yet. Expected failures:
 *
 *   1. `fallback model is used when the primary model 404s` → currently the
 *      primary error propagates and the fallback model is never called.
 *   2. `fallback model is NOT called when the primary model succeeds` → the
 *      fallback plumbing does not exist.
 *   3. `401 does NOT trigger a fallback` → currently passes only because no
 *      fallback mechanism exists at all; it becomes meaningful once (1) works.
 *   4. `the fallback model failing reports the ORIGINAL error` → currently
 *      there is no fallback path to report from.
 *   5. `the fallback is sticky within one run` → no sticky state exists.
 *
 * The `model` inheritance into sub-agents is verified separately in
 * `delegate-tool-model-inheritance.test.ts` (that is a different layer).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../environment";

function createMockSessionComponent() {
  const sessions = new Map<string, any>();
  return {
    get: vi.fn(async (sessionId: string) => {
      if (sessions.has(sessionId)) return sessions.get(sessionId);
      const fresh = {
        id: sessionId,
        title: "test",
        directory: "/tmp",
        parentId: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
        metadata: {},
      };
      sessions.set(sessionId, fresh);
      return fresh;
    }),
    create: vi.fn(async (opts: any) => ({
      id: `sub_${sessions.size}`,
      parentSessionId: opts.parentSessionId ?? null,
      title: "test",
      directory: "/tmp",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      metadata: opts.metadata || {},
    })),
    addMessage: vi.fn(async () => "msg_1"),
    addMessages: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    getMessageCount: vi.fn(async () => 0),
    getContext: vi.fn(async () => ({ messages: [], checkpoint: undefined })),
    update: vi.fn(async () => true),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
}

function createMockEnv(opts: {
  configComponent: ConfigComponent;
  sessionComponent: any;
  llmComponent: any;
}): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "session") return opts.sessionComponent;
      if (name === "config") return opts.configComponent;
      if (name === "llm") return opts.llmComponent;
      return undefined;
    }),
    hasComponent: vi.fn(),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
}

describe("Task #4623 — model fallback in AgentComponent", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let mockEnv: Environment;
  let tempDir: string;

  /** Records every `model` value the LLM component was invoked with. */
  let invokedModels: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    invokedModels = [];

    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-fallback-test-"));
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = {
      invoke: vi.fn(async (req: any) => {
        invokedModels.push(req?.model);
        return {
          output: { content: "ok", toolCalls: [] },
        };
      }),
    };
    mockEnv = createMockEnv({ configComponent, sessionComponent, llmComponent });

    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);
  });

  afterEach(async () => {
    try {
      await agentComponent.stop();
    } catch {}
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  /**
   * Make the LLM component throw for the primary model and succeed for the
   * fallback model, recording every attempt.
   */
  function makeLLMFailOnPrimary(primaryModel: string, error: unknown) {
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === primaryModel) throw error;
      return { output: { content: "fallback response", toolCalls: [] } };
    });
  }

  test("RED: fallback model is used when the primary model 404s", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    makeLLMFailOnPrimary("tong/GLM-5.3-Flash", new Error("404 Page not found"));

    const result = await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    // The fallback model must have been tried.
    expect(invokedModels).toContain("minimax/MiniMax-M3");
    // And the run must not have failed.
    expect(result.error).toBeUndefined();
    expect(result.finalText).toContain("fallback response");
  });

  test("RED: fallback model is NOT called when the primary model succeeds", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    expect(result.error).toBeUndefined();
    expect(invokedModels).toEqual(["tong/GLM-5.3-Flash"]);
    expect(invokedModels).not.toContain("minimax/MiniMax-M3");
  });

  test("RED: 401 does NOT trigger a fallback", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    makeLLMFailOnPrimary("tong/GLM-5.3-Flash", new Error("401 Unauthorized"));

    const result = await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    expect(invokedModels).not.toContain("minimax/MiniMax-M3");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("401");
  });

  test("RED: the fallback model failing reports the ORIGINAL error and does not recurse", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    // Both models fail — the fallback must NOT fall back again.
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === "tong/GLM-5.3-Flash") throw new Error("404 Page not found");
      throw new Error("500 fallback also broken");
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    // Exactly two attempts: primary + one fallback. No third attempt.
    expect(invokedModels).toEqual(["tong/GLM-5.3-Flash", "minimax/MiniMax-M3"]);
    // The ORIGINAL error must be reported (not the fallback's own error).
    expect(result.error).toContain("404");
  });

  test("RED: the fallback is sticky within one run (no repeated primary failures)", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      // Two iterations → two LLM calls in one run.
      maxIterations: 2,
    });

    let primaryAttempts = 0;
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === "tong/GLM-5.3-Flash") {
        primaryAttempts += 1;
        throw new Error("404 Page not found");
      }
      // The fallback returns a tool call so the loop iterates again.
      return {
        output: {
          content: "",
          toolCalls: [
            { id: "tc_1", name: "noop", arguments: {} },
          ],
        },
      };
    });

    await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    // The primary model must only have been tried ONCE — the fallback sticks.
    expect(primaryAttempts).toBe(1);
  });

  test("RED/regression: ToolContext carries model + fallbackModel (original bug line)", async () => {
    // review P1-6：此前所有测试都只直调 BackgroundTaskManager.createTask，
    // 把 agent-component 里 `model: ctx.context.model` 删掉也全绿。
    // 这里从 AgentComponent → 工具执行上下文走一遍真实链路。
    const captured: Array<{ model?: string; fallbackModel?: string }> = [];
    const captureTool = {
      name: "capture_ctx",
      description: "capture tool context",
      parameters: {} as any,
      execute: async (_args: unknown, toolCtx: any) => {
        captured.push({ model: toolCtx.model, fallbackModel: toolCtx.fallbackModel });
        return { success: true, output: "captured" };
      },
    };

    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 3,
    });

    let call = 0;
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      call += 1;
      if (call === 1) {
        return {
          output: {
            content: "",
            toolCalls: [
              {
                id: "tc_1",
                name: "capture_ctx",
                arguments: {},
                function: { name: "capture_ctx", arguments: "{}" },
              },
            ],
          },
        };
      }
      return { output: { content: "done", toolCalls: [] } };
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
      extraTools: [captureTool],
    } as any);

    expect(result.error).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.model).toBe("tong/GLM-5.3-Flash");
    expect(captured[0]?.fallbackModel).toBe("minimax/MiniMax-M3");
  });

  test("the downgrade is scoped to one run: the next run retries the primary model", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    makeLLMFailOnPrimary("tong/GLM-5.3-Flash", new Error("404 Page not found"));

    await agentComponent.run("test-agent", "first", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    // Run 2: primary works again → sticky state must have been cleared.
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      return { output: { content: "primary is back", toolCalls: [] } };
    });

    const second = await agentComponent.run("test-agent", "second", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    expect(second.error).toBeUndefined();
    expect(invokedModels[invokedModels.length - 1]).toBe("tong/GLM-5.3-Flash");
  });

  test("no fallback configured → the primary error propagates unchanged", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    makeLLMFailOnPrimary("tong/GLM-5.3-Flash", new Error("404 Page not found"));

    const result = await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
    } as any);

    expect(invokedModels).toEqual(["tong/GLM-5.3-Flash"]);
    expect(result.error).toContain("404");
  });
});
