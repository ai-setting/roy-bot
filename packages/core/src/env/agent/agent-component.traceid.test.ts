/**
 * @fileoverview AgentComponent traceId 提升测试
 *
 * 回归保护：Code Review v2 报告 C1
 * - effectiveContext 在 agent-component.ts:933 构造时
 * - 必须把 context.metadata.traceId 提升到 AgentContext.traceId 顶层
 * - 不提升会导致下游消费者（如 auto-task-plugin 的 per-query 去重）拿到 undefined
 *   退化为 sessionId 去重，等价于 per-query 去重功能未生效
 *
 * 运行: bun test packages/core/src/env/agent/agent-component.traceid.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { AgentComponent } from "./agent-component";
import type { AgentContext, HookContext } from "./types";
import type { Plugin } from "./types";
import { ConfigComponent } from "../../config/config-component";

/**
 * 创建最小可用的 mock env，附带 capture hook 用的 plugin
 */
function createTraceIdMockEnv(traceIdCapture: { traceId?: string }) {
  const llmInvokeMock = vi.fn(async () => ({
    output: {
      content: "ok",
      finishReason: "stop",
      toolCalls: [],
    },
    providerId: "test",
    model: "test-model",
    latencyMs: 1,
  }));

  // plugin 用于捕获 agent:before.llm hook 中的 ctx.context.traceId
  const capturePlugin: Plugin = {
    name: "traceId-capture",
    version: "1.0.0",
    description: "captures AgentContext.traceId for assertion",
    hooks: [{ point: "agent:before.llm", priority: 1 }],
    execute: async (ctx: HookContext) => {
      traceIdCapture.traceId = ctx.context?.traceId;
      return { continue: true };
    },
  };

  const env: any = {
    name: "test",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "llm") return { invoke: llmInvokeMock };
      if (name === "session")
        return {
          getConversationHistory: async () => [],
          addMessage: async () => undefined,
          compact: async () => ({}),
        };
      return undefined;
    }),
    hasComponent: vi.fn(() => true),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  };

  return { env, llmInvokeMock, capturePlugin };
}

async function initAgentForTest(
  agentComponent: AgentComponent,
  env: any,
  configComponent: ConfigComponent,
  capturePlugin: Plugin,
  agentName: string
) {
  const envWithConfig: any = {
    ...env,
    getComponent: vi.fn((name: string) => {
      if (name === "config") return configComponent;
      return env.getComponent(name);
    }),
    hasComponent: vi.fn((name: string) =>
      name === "config" || env.hasComponent(name)
    ),
  };
  await agentComponent.init({
    name: "agent",
    version: "1.0.0",
    enabled: true,
    env: envWithConfig,
    options: { configComponent },
  });
  agentComponent.registerAgent(agentName, {
    type: "primary",
    systemPrompt: "You are a helpful assistant.",
    maxIterations: 1,
  });
  agentComponent.registerPlugin(agentName, capturePlugin);
}

describe("AgentComponent traceId lifting (Code Review v2 C1)", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let tempDir: string;
  let emptyAgentsDir: string;

  beforeEach(async () => {
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "traceid-test-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);
  });

  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  it("should lift traceId from context.metadata.traceId to AgentContext.traceId top-level", async () => {
    const traceIdCapture: { traceId?: string } = {};
    const { env, capturePlugin } = createTraceIdMockEnv(traceIdCapture);

    await initAgentForTest(
      agentComponent,
      env,
      configComponent,
      capturePlugin,
      "test-agent"
    );

    // Production-style: traceId 只在 metadata.traceId
    const ctx: AgentContext = {
      sessionId: "sess-xyz",
      metadata: { traceId: "lifted-trace-abc-123" },
    };

    await agentComponent.run("test-agent", "test query", ctx);

    // 关键断言: hook 拿到的 AgentContext.traceId 是顶层字段
    expect(traceIdCapture.traceId).toBe("lifted-trace-abc-123");
  });

  it("should prefer metadata.traceId over context.traceId when both are provided", async () => {
    const traceIdCapture: { traceId?: string } = {};
    const { env } = createTraceIdMockEnv(traceIdCapture);
    const capturePlugin: Plugin = {
      name: "traceId-capture",
      version: "1.0.0",
      description: "captures",
      hooks: [{ point: "agent:before.llm" as const, priority: 1 }],
      execute: async (ctx: HookContext) => {
        traceIdCapture.traceId = ctx.context?.traceId;
        return { continue: true };
      },
    };

    await initAgentForTest(
      agentComponent,
      env,
      configComponent,
      capturePlugin,
      "test-agent"
    );

    const ctx: AgentContext = {
      sessionId: "sess-xyz",
      traceId: "top-level-trace",
      metadata: { traceId: "metadata-trace-should-win" },
    };

    await agentComponent.run("test-agent", "test", ctx);

    // 优先级：metadata.traceId > context.traceId（metadata 是 production 源）
    expect(traceIdCapture.traceId).toBe("metadata-trace-should-win");
  });

  it("should leave traceId undefined when neither top-level nor metadata.traceId are provided", async () => {
    const traceIdCapture: { traceId?: string } = {};
    const { env } = createTraceIdMockEnv(traceIdCapture);
    const capturePlugin: Plugin = {
      name: "traceId-capture",
      version: "1.0.0",
      description: "captures",
      hooks: [{ point: "agent:before.llm" as const, priority: 1 }],
      execute: async (ctx: HookContext) => {
        traceIdCapture.traceId = ctx.context?.traceId;
        return { continue: true };
      },
    };

    await initAgentForTest(
      agentComponent,
      env,
      configComponent,
      capturePlugin,
      "test-agent"
    );

    await agentComponent.run("test-agent", "test", { sessionId: "sess-xyz" });

    // 既无顶层 traceId 也无 metadata.traceId 时保持 undefined
    expect(traceIdCapture.traceId).toBeUndefined();
  });
});
