/**
 * @fileoverview AgentComponent.onStop abort-scope regression tests
 *
 * Task #4794 — Bug 链第二环：CLI `act` 收尾时 EnvironmentService.dispose()
 * → environment.stop() → stopComponents() 按注册顺序停组件。
 * AgentComponent 在 TaskComponent **之前** stop，其 onStop() 无条件
 * abort 所有 agent run（含正在运行的后台子 agent run
 * `roy:bg_process_xxx`）→ 子 agent LLM 调用被中断（finishReason=aborted）。
 *
 * 修复：AgentComponentOptions 增加 `skipAbortRunningTasksOnStop`。
 * - act 收尾路径传 true → onStop 跳过 abort（子 agent 由
 *   TaskComponent.stop 的 waitForRunningTasks 等待自然完成）。
 * - 默认（不传）→ 行为与旧版一致（abort 全部），
 *   ESC cascade / 强杀等「用户主动退出」语义不变。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";

function createMockEnvironment(configComponent: ConfigComponent): Environment {
  const mockEnv = {
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
  return mockEnv;
}

describe("AgentComponent.onStop abort-scope (Task #4794)", () => {
  let configComponent: ConfigComponent;
  let mockEnv: Environment;

  beforeEach(async () => {
    vi.clearAllMocks();
    configComponent = new ConfigComponent();
    mockEnv = createMockEnvironment(configComponent);
  });

  /** 模拟一个正在运行的后台子 agent run（runId 形如 roy:bg_process_xxx） */
  function seedRunningRun(agentComponent: AgentComponent, runId: string) {
    (agentComponent as any).aborted.set(runId, false);
    const controller = new AbortController();
    (agentComponent as any).abortControllers.set(runId, controller);
    (agentComponent as any).doomLoopCaches.set(runId, new Map());
    // agents registry 需要有 "roy" 且状态 running，onStop 才会遍历到
    const royAgent = (agentComponent as any).agents.get("roy");
    if (royAgent) {
      royAgent.status = "running";
    }
    return controller;
  }

  it("RED-A: 默认 onStop 保持 abort 全部语义（用户主动退出）", async () => {
    const agentComponent = new AgentComponent();
    await agentComponent.init({ env: mockEnv, options: { configComponent } });

    const controller = seedRunningRun(agentComponent, "roy:bg_process_test1");
    const abortSpy = vi.spyOn(controller.signal, "abort" as any);

    await (agentComponent as any).onStop();

    // 默认：abort 被调用（旧语义不变）
    expect(controller.signal.aborted).toBe(true);
  });

  it("RED-B: skipAbortRunningTasksOnStop=true 时 onStop 不 abort 运行中的 run", async () => {
    const agentComponent = new AgentComponent();
    await agentComponent.init({
      env: mockEnv,
      options: { configComponent, skipAbortRunningTasksOnStop: true },
    });

    const controller = seedRunningRun(agentComponent, "roy:bg_process_test2");

    await (agentComponent as any).onStop();

    // 关键断言：没有 abort（子 agent 不被误杀）
    expect(controller.signal.aborted).toBe(false);
  });

  it("RED-C: skip 模式下 onStop 仍清理注册表（防句柄泄漏）", async () => {
    const agentComponent = new AgentComponent();
    await agentComponent.init({
      env: mockEnv,
      options: { configComponent, skipAbortRunningTasksOnStop: true },
    });

    seedRunningRun(agentComponent, "roy:bg_process_test3");

    await (agentComponent as any).onStop();

    expect((agentComponent as any).abortControllers.size).toBe(0);
    expect((agentComponent as any).aborted.size).toBe(0);
    expect((agentComponent as any).doomLoopCaches.size).toBe(0);
  });
});
