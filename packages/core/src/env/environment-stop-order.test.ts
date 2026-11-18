/**
 * @fileoverview Environment.stopComponents() LIFO 顺序回归测试
 *
 * Task #4794 根因 #4 — e2e 取证：act 收尾等待后台子 agent 时
 * （TaskComponent.stop → BackgroundTaskManager.dispose
 * waitForRunningTasks 轮询），子 agent 下一次 LLM 调用抛
 * "LLMComponent is not running" → 任务 failed → 等待中断
 * → 进程退出杀子 agent。
 *
 * 原因：stopComponents() 按注册顺序 FIFO 停止
 * （config→session→llm→tool→agent→…→task），
 * LLMComponent 先于 TaskComponent 停止，等待期间
 * 子 agent 的 LLM 依赖已被拆除。
 *
 * 修复：LIFO 逆序停止（后注册的先停）—— task 最后注册、
 * 最先停止，等待期间 llm/tool/agent 仍存活；
 * config/session 最后停止（符合依赖方向）。
 */

import { describe, it, expect } from "vitest";
import { BaseEnvironment } from "./environment";
import { BaseComponent } from "./component";

class TrackedComponent extends BaseComponent {
  name: string;
  readonly onStopCalls: string[];

  constructor(name: string, onStopCalls: string[]) {
    super();
    this.name = name;
    this.onStopCalls = onStopCalls;
  }

  async onInit(): Promise<void> {}
  async onStart(): Promise<void> {}
  async onStop(): Promise<void> {
    this.onStopCalls.push(this.name);
  }
}

describe("Environment.stopComponents LIFO order (Task #4794 root cause #4)", () => {
  it("RED: stop() 必须按注册逆序停止（task 先于 llm）", async () => {
    const env = new BaseEnvironment({ name: "test-env" });
    const stopOrder: string[] = [];

    // 模拟真实注册顺序：config → session → llm → tool → agent → task
    env.registerComponent(new TrackedComponent("config", stopOrder));
    env.registerComponent(new TrackedComponent("session", stopOrder));
    env.registerComponent(new TrackedComponent("llm", stopOrder));
    env.registerComponent(new TrackedComponent("tool", stopOrder));
    env.registerComponent(new TrackedComponent("agent", stopOrder));
    env.registerComponent(new TrackedComponent("task", stopOrder));

    await env.init();
    await env.start();
    await env.stop();

    // LIFO：task 最先停（它要等待后台子 agent，需要 llm/tool/agent 活着）
    const idx = (n: string) => stopOrder.indexOf(n);
    expect(idx("task")).toBe(0);
    expect(idx("task")).toBeLessThan(idx("agent"));
    expect(idx("agent")).toBeLessThan(idx("tool"));
    expect(idx("tool")).toBeLessThan(idx("llm"));
    // config/session 最后停（收尾持久化）
    expect(idx("session")).toBe(stopOrder.length - 2);
    expect(idx("config")).toBe(stopOrder.length - 1);
  });

  it("RED: start() 仍按注册顺序（FIFO，行为不变）", async () => {
    const env = new BaseEnvironment({ name: "test-env-2" });
    const startOrder: string[] = [];

    class StartTracked extends BaseComponent {
      name: string;
      constructor(name: string) {
        super();
        this.name = name;
      }
      async onInit(): Promise<void> {}
      async onStart(): Promise<void> {
        startOrder.push(this.name);
      }
      async onStop(): Promise<void> {}
    }

    env.registerComponent(new StartTracked("llm"));
    env.registerComponent(new StartTracked("agent"));
    env.registerComponent(new StartTracked("task"));

    await env.init();
    await env.start();
    await env.stop();

    expect(startOrder).toEqual(["llm", "agent", "task"]);
  });
});
