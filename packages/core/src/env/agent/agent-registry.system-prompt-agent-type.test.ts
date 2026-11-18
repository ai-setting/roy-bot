/**
 * @fileoverview AgentRegistry.getSystemPrompt 必须把 agent.type 透传给 PromptComponent
 *
 * 背景（2026-10-16 生产事故 traceId=83eadac2316d5be7529ca42ce7057d63）：
 *   `prompt.after-render` 上的 commands-prompt hook 只应给 **primary** agent 注入
 *   Commands Arsenal。若渲染时拿不到 agent 类型，hook 就只能靠「prompt 名字黑名单」
 *   猜，新增的内置子 agent（compact / compact-hint）被漏掉 → 它们的 prompt 被追加
 *   "Use them directly via bash when needed"，而它们没有 bash 工具
 *   → `Tool not found: bash` → 压缩写出空 checkpoint（657 条消息被静默归档）。
 *
 * 因此契约是：`AgentRegistry.getSystemPrompt(name)` 必须把该 agent 的 `type`
 * 作为 `agentType` 传给 `PromptComponent.getPrompt()`。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentRegistry } from "./agent-registry";

vi.mock("../log-trace/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const createMockConfigComponent = () => ({
  get: vi.fn((key: string) => (key === "agent.configDir" ? "/tmp/empty-agents" : undefined)),
  set: vi.fn(),
  registerSource: vi.fn(),
  load: vi.fn(),
  watch: vi.fn(),
});

/** PromptComponent 桩：记录每次 render 的 context，证明 agentType 被透传 */
function createRecordingPromptComponent() {
  const calls: Array<{ name: string; context: any }> = [];
  return {
    calls,
    get: vi.fn(() => "raw"),
    getPrompt: vi.fn(async (name: string, _vars?: any, context?: any) => {
      calls.push({ name, context });
      return `RENDERED(${name})`;
    }),
  };
}

describe("AgentRegistry — getSystemPrompt 透传 agentType 给 render hook", () => {
  let registry: AgentRegistry;
  let promptComponent: ReturnType<typeof createRecordingPromptComponent>;

  beforeEach(() => {
    vi.clearAllMocks();
    promptComponent = createRecordingPromptComponent();
    registry = new AgentRegistry({
      configComponent: createMockConfigComponent() as any,
      resolvePromptComponent: () => promptComponent as any,
      baseDir: "/tmp/test-roy-bot",
    });
  });

  it("primary agent 的 prompt 渲染时 agentType='primary'", async () => {
    registry.register({ name: "default", type: "primary", systemPromptRef: "default" });

    const rendered = await registry.getSystemPrompt("default");

    expect(rendered).toBe("RENDERED(default)");
    expect(promptComponent.calls).toHaveLength(1);
    expect(promptComponent.calls[0].context?.agentType).toBe("primary");
  });

  it("sub agent 的 prompt 渲染时 agentType='sub'（hook 据此跳过 Commands Arsenal）", async () => {
    // compact 正是漏网的那个内置子 agent
    registry.register({ name: "compact", type: "sub", systemPromptRef: "compact" });
    registry.register({ name: "compact-hint", type: "sub", systemPromptRef: "compact-hint" });

    await registry.getSystemPrompt("compact");
    await registry.getSystemPrompt("compact-hint");

    expect(promptComponent.calls).toHaveLength(2);
    expect(promptComponent.calls[0].context?.agentType).toBe("sub");
    expect(promptComponent.calls[1].context?.agentType).toBe("sub");
  });
});
