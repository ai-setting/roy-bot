/**
 * @fileoverview Task #4023 — 端到端：envEvent.metadata.parentTaskId 必须真正
 * 进入 AgentComponent 运行期的 EnvContext.parentTaskId。
 *
 * 这是评审发现的 P0 断链的回归测试：
 *   event-source-handlers 解析 chat↔task 绑定后，把 taskId 写入
 *   evt.metadata.parentTaskId；agent-component._run 必须把它映射到
 *   EnvContext.parentTaskId，task_create 才能继承。
 *
 * 该测试在修复前为 RED（getEnvContext().parentTaskId === undefined）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import { getEnvContext, runWithEnvContextAsync } from "../context";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

describe("Task #4023 — envEvent.parentTaskId → EnvContext.parentTaskId", () => {
  let agentComponent: AgentComponent;
  let mockEnv: Environment;
  let configComponent: ConfigComponent;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-parenttask-test-"));
    const emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);

    mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
      registerComponent: vi.fn(),
      unregisterComponent: vi.fn(),
      getComponent: vi.fn((name: string) => {
        if (name === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => name === "config"),
      listComponents: vi.fn(() => []),
      handle_query: vi.fn(),
      handle_action: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeTo: vi.fn(() => () => {}),
      subscribeAll: vi.fn(() => () => {}),
      pushEnvEvent: vi.fn(),
    } as unknown as Environment;

    await agentComponent.init({ env: mockEnv, options: { configComponent } });
  });

  /**
   * Register agent + LLM mock that captures EnvContext.parentTaskId at invoke
   * time (invoke happens inside runWithEnvContextAsync(envContext, ...)).
   */
  function installCapturingLLM(): { observed: () => unknown } {
    let observed: unknown = "unset";
    const mockLLMComponent = {
      invoke: vi.fn(() => {
        observed = getEnvContext()?.parentTaskId;
        return Promise.resolve({
          output: { content: "ok", toolCalls: [], finishReason: "stop" },
        });
      }),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "config") return configComponent;
      if (name === "llm") return mockLLMComponent;
      return undefined;
    });
    return { observed: () => observed };
  }

  it("envEvent.metadata.parentTaskId 映射进 EnvContext（核心 P0 修复）", async () => {
    agentComponent.registerAgent("group-agent", {
      type: "primary",
      systemPrompt: "SYS",
    });
    const { observed } = installCapturingLLM();

    await agentComponent.run("group-agent", "在群里创建任务", {
      sessionId: "session_test",
      persistSession: false,
      envEvent: {
        id: "evt-parent-1",
        type: "event-source.event.lark-cli",
        timestamp: Date.now(),
        metadata: { parentTaskId: 8888 },
        payload: {},
      } as any,
    });

    expect(observed()).toBe(8888);
  });

  it("envEvent 无 parentTaskId 时继承上游 ALS EnvContext.parentTaskId", async () => {
    agentComponent.registerAgent("group-agent", {
      type: "primary",
      systemPrompt: "SYS",
    });
    const { observed } = installCapturingLLM();

    await runWithEnvContextAsync({ parentTaskId: 7777 } as any, async () => {
      await agentComponent.run("group-agent", "subagent task", {
        sessionId: "session_test",
        persistSession: false,
        envEvent: {
          id: "evt-parent-2",
          type: "event-source.event.lark-cli",
          timestamp: Date.now(),
          metadata: {},
          payload: {},
        } as any,
      });
    });

    expect(observed()).toBe(7777);
  });

  it("非法 envEvent.parentTaskId（0/字符串）不注入，回落 root（undefined）", async () => {
    agentComponent.registerAgent("group-agent", {
      type: "primary",
      systemPrompt: "SYS",
    });
    const { observed } = installCapturingLLM();

    await agentComponent.run("group-agent", "bad parent", {
      sessionId: "session_test",
      persistSession: false,
      envEvent: {
        id: "evt-parent-3",
        type: "event-source.event.lark-cli",
        timestamp: Date.now(),
        metadata: { parentTaskId: "8888" },
        payload: {},
      } as any,
    });

    expect(observed()).toBeUndefined();
  });

  it("普通用户消息（无 envEvent）不注入 parentTaskId", async () => {
    agentComponent.registerAgent("normal-agent", {
      type: "primary",
      systemPrompt: "SYS",
    });
    const { observed } = installCapturingLLM();

    await agentComponent.run("normal-agent", "hello", {
      sessionId: "session_test",
      persistSession: false,
    });

    expect(observed()).toBeUndefined();
  });
});
