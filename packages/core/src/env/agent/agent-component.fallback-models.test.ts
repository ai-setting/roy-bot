/**
 * @fileoverview Task #4722 — agent 消费 `llm.fallbackModels` 数组
 *
 * command 子系统（`roy-bot fallback-model add/remove/reorder`）写的是
 * `llm.fallbackModels`（有序数组 = 优先级）。agent 侧必须真的消费它，
 * 否则「命令改了配置但行为没变」= 假功能。
 *
 * 契约：
 * 1. `llm.fallbackModels` 存在 → 取**第一项**作为兜底模型
 * 2. `llm.fallbackModels` 不存在 → 回落 `llm.fallbackModel`（向后兼容）
 * 3. 显式 `--fallback-model`（AgentContext.fallbackModel）优先级最高
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
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          id: sessionId,
          title: "test",
          directory: "/tmp",
          parentId: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 0,
          metadata: {},
        });
      }
      return sessions.get(sessionId);
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
      return null;
    }),
    getConfigComponent: vi.fn(() => opts.configComponent),
    getSessionComponent: vi.fn(() => opts.sessionComponent),
    getLLMComponent: vi.fn(() => opts.llmComponent),
  } as unknown as Environment;
}

describe("Task #4722: agent 消费 llm.fallbackModels 数组", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let mockEnv: Environment;
  let tempDir: string;
  let invokedModels: string[];

  const PRIMARY = "tong/GLM-5.3-Flash";

  beforeEach(async () => {
    vi.clearAllMocks();
    invokedModels = [];

    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-fbmodels-test-"));
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = {
      invoke: vi.fn(async (req: any) => {
        invokedModels.push(req?.model);
        if (req?.model === PRIMARY) {
          throw new Error("404 Page not found");
        }
        return { output: { content: "fallback response", toolCalls: [] } };
      }),
    };
    mockEnv = createMockEnv({ configComponent, sessionComponent, llmComponent });

    await agentComponent.init({
      env: mockEnv,
      options: { configComponent },
    } as any);

    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });
  });

  afterEach(async () => {
    try {
      await agentComponent.stop();
    } catch {}
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("llm.fallbackModels 数组存在 → 取第一项作为兜底", async () => {
    await configComponent.set("llm.fallbackModels", [
      "minimax/MiniMax-M3",
      "opencodego/deepseek-v4.1-flash",
    ]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    expect(invokedModels).toContain("minimax/MiniMax-M3");
    expect(invokedModels).not.toContain("opencodego/deepseek-v4.1-flash");
    expect(result.error).toBeUndefined();
  });

  test("llm.fallbackModels 不存在 → 回落 llm.fallbackModel（向后兼容）", async () => {
    await configComponent.set("llm.fallbackModel", "minimax/MiniMax-M3");

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    expect(invokedModels).toContain("minimax/MiniMax-M3");
    expect(result.error).toBeUndefined();
  });

  test("显式 fallbackModel 优先于 llm.fallbackModels 数组", async () => {
    await configComponent.set("llm.fallbackModels", ["minimax/MiniMax-M3"]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModel: "opencodego/deepseek-v4.1-flash",
    } as any);

    expect(invokedModels).toContain("opencodego/deepseek-v4.1-flash");
    expect(invokedModels).not.toContain("minimax/MiniMax-M3");
    expect(result.error).toBeUndefined();
  });

  test("显式 fallbackModels 数组优先于显式 fallbackModel 单值", async () => {
    // ★ Task #4724 交叉验证 MINOR-1：同一 context 同时给数组与单值时，
    //   数组（CLI 多模型语法）应胜出 —— 单值只应作为「只有一个模型」的兼容写法。
    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["opencodego/deepseek-v4.1-flash"],
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    expect(invokedModels).toContain("opencodego/deepseek-v4.1-flash");
    expect(invokedModels).not.toContain("minimax/MiniMax-M3");
    expect(result.error).toBeUndefined();
  });

  test("llm.fallbackModels 为空数组 → 不触发 fallback（不报错）", async () => {
    await configComponent.set("llm.fallbackModels", []);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    // 主模型失败 → 无兜底 → 直接失败
    expect(result.error).toBeTruthy();
    expect(invokedModels).not.toContain("minimax/MiniMax-M3");
  });
});
