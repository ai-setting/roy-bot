/**
 * @fileoverview Task #4682 — agent-level integration test:
 * the exact tong gateway "No deployments available" error must
 * trigger the fallback in the REAL AgentComponent dispatch path
 * (default agent AND sub agent), not just in the pure
 * eligibility function.
 *
 * Regression guard (implementation landed in 6927f4f3, review
 * fixes in d7b0dab6) — before the fix the primary error
 * propagated and the fallback was never invoked.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../environment";

/** The exact error text from the user's production screenshot. */
const TONG_GATEWAY_ERROR =
  "Failed after 4 attempts. Last error: No deployments available for " +
  "selected model, Try again in 5 seconds. Passed model=GLM-5.3-Flash. " +
  "pre-call-checks=False, cooldown_list=['4364fec50f3bb0a41bdcdecd5ebf5a923e87483134373caae0794df726286b89']";

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

describe("Task #4682 — gateway no-deployments error triggers fallback in AgentComponent", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let mockEnv: Environment;
  let tempDir: string;
  let invokedModels: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    invokedModels = [];

    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-gw-fallback-test-"));
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = {
      invoke: vi.fn(async (req: any) => {
        invokedModels.push(req?.model);
        return { output: { content: "ok", toolCalls: [] } };
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

  test("the exact tong gateway error downgrades to the fallback model", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === "tong/GLM-5.3-Flash") {
        throw new Error(TONG_GATEWAY_ERROR);
      }
      return { output: { content: "fallback response", toolCalls: [] } };
    });

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

  test("a SUB agent with the gateway error also downgrades (Task #4682 acceptance 5)", async () => {
    agentComponent.registerAgent("sub-agent", {
      type: "sub",
      systemPrompt: "You are a sub agent.",
      maxIterations: 1,
    });

    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === "tong/GLM-5.3-Flash") {
        throw new Error(TONG_GATEWAY_ERROR);
      }
      return { output: { content: "sub fallback response", toolCalls: [] } };
    });

    const result = await agentComponent.run("sub-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    expect(invokedModels).toContain("minimax/MiniMax-M3");
    expect(result.error).toBeUndefined();
    expect(result.finalText).toContain("sub fallback response");
  });

  test("the gateway error carrying statusCode 400 still downgrades (DS review M-1)", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    // The gateway can attach HTTP 400 to the same "No deployments"
    // text (the file's own header comment documents that opencodego
    // answers 400 for "model unavailable").
    const err = Object.assign(new Error(TONG_GATEWAY_ERROR), {
      statusCode: 400,
    });

    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === "tong/GLM-5.3-Flash") throw err;
      return { output: { content: "fallback response", toolCalls: [] } };
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    expect(invokedModels).toContain("minimax/MiniMax-M3");
    expect(result.error).toBeUndefined();
  });

  test("fallback also failing reports the ORIGINAL error and does not recurse", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    // Both models fail — the fallback must NOT fall back again.
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === "tong/GLM-5.3-Flash") {
        throw new Error(TONG_GATEWAY_ERROR);
      }
      throw new Error("500 fallback also broken");
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    // Exactly two attempts: primary + one fallback. No third attempt.
    expect(invokedModels).toEqual(["tong/GLM-5.3-Flash", "minimax/MiniMax-M3"]);
    // The ORIGINAL error must be reported (not the fallback's own error).
    expect(result.error).toContain("No deployments available");
  });

  test("gateway error in the AI SDK RetryError shape also downgrades", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    // The production error is an AI SDK RetryError: name=AI_RetryError,
    // message="Failed after N attempts. Last error: ...", no statusCode.
    const retryError = Object.assign(new Error(TONG_GATEWAY_ERROR), {
      name: "AI_RetryError",
      reason: "maxRetriesExceeded",
    });

    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === "tong/GLM-5.3-Flash") throw retryError;
      return { output: { content: "fallback response", toolCalls: [] } };
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    expect(invokedModels).toContain("minimax/MiniMax-M3");
    expect(result.error).toBeUndefined();
  });
});
