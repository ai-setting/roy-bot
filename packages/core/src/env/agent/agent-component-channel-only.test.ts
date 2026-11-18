/**
 * @fileoverview Task #5333 — channelOnly 工具可见性（ES config extendTools）
 *
 * ## 需求（用户 16:54）
 * 「ES config 支持 extend tools —— 不同 ES 驱动的 agent 注入 tools 可不同。
 *   企微 ES 有特有工具（wecom_respond），不该配到 default agent。」
 *
 * ## 问题
 * `wecomRespondTool` 在 `packages/core/src/env/tool/built-in/index.ts` 的
 * `getAllBuiltInTools()` 里**全局注册**，没有 allowedAgentTypes 限制 →
 * 所有 agent（包括交互式 CLI 的 default 接待员）都能看到 `wecom_respond`，
 * 而 default agent 在非企微会话里调用它必然失败。
 *
 * ## 修复契约（本文件断言）
 * 1. `metadata.channelOnly: true` 的工具**默认不可见**（任何 agent）
 * 2. 仅当 `AgentContext.extendTools` 显式列出该工具名时才可见
 * 3. `channelOnly` 过滤对 getAvailableTools 的**所有入口**生效
 *    （ToolComponent 注册表 / defaultTools / extraTools）
 * 4. 未标记 channelOnly 的普通工具行为不变（不受 extendTools 影响）
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import type { AgentInstance, AgentContext } from "./types";
import type { Tool } from "../tool/types";
import { AgentComponent } from "./agent-component";
import { ToolComponent } from "../tool/tool-component";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Helpers
// ============================================================================

function makeTool(
  name: string,
  metadata?: { channelOnly?: boolean; allowedAgentTypes?: string[] },
): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: z.object({}),
    execute: async () => ({ success: true, output: "ok", metadata: { execution_time_ms: 0 } }),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function makeAgentInstance(name: string, type: "primary" | "sub" = "primary"): AgentInstance {
  return {
    name,
    config: {
      type,
      name,
      maxIterations: 10,
      maxErrorRetries: 0,
      doomLoopThreshold: 0,
      toolTimeout: 0,
      toolRetries: 0,
      systemPrompt: "",
      model: "",
      behaviorSpecId: "",
      allowedTools: undefined,
      deniedTools: undefined,
      filterHistory: false,
    },
    status: "idle",
    plugins: new Map(),
  } as unknown as AgentInstance;
}

async function createWiredAgentComponent(): Promise<{
  agentComponent: AgentComponent;
  toolComponent: ToolComponent;
  tempDir: string;
}> {
  const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-chanonly-"));
  const configComponent = new ConfigComponent();
  configComponent.setXdgDataHome(tempDir);
  const emptyAgentsDir = path.join(tempDir, "empty-agents");
  fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
  await configComponent.set("agent.configDir", emptyAgentsDir);

  const mockEnv = {
    name: "test-env",
    version: "1.0.0",
    getConfig: () => ({ name: "test-env", version: "1.0.0", enabled: true }),
    getComponent: (n: string) => (n === "config" ? configComponent : undefined),
    hasComponent: (n: string) => n === "config",
    registerComponent: () => {},
    unregisterComponent: () => {},
    listComponents: () => [],
    handle_query: async () => ({}),
    handle_action: async () => ({}),
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    subscribeAll: () => () => {},
    pushEnvEvent: () => {},
  };

  const toolComponent = new ToolComponent();
  await toolComponent.init({
    name: "tool",
    version: "1.0.0",
    enabled: true,
    env: mockEnv as any,
    options: { configComponent },
  });

  const agentComponent = new AgentComponent();
  await agentComponent.init({
    name: "agent",
    version: "1.0.0",
    enabled: true,
    env: mockEnv as any,
    options: { configComponent },
  });

  (agentComponent as any).toolComponent = toolComponent;

  return { agentComponent, toolComponent, tempDir };
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentComponent.getAvailableTools — channelOnly 工具可见性（Task #5333）", () => {
  let agentComponent: AgentComponent;
  let toolComponent: ToolComponent;
  let tempDir: string;

  beforeEach(async () => {
    const ctx = await createWiredAgentComponent();
    agentComponent = ctx.agentComponent;
    toolComponent = ctx.toolComponent;
    tempDir = ctx.tempDir;
  });

  // MINOR（DS review 第 1 轮）：cleanup 必须是 afterEach ——
  // 写在 beforeEach 的 return 里根本不会被执行（bun 不把返回值当 teardown）。
  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  test("channelOnly 工具默认对 default agent 不可见（无 extendTools）", () => {
    toolComponent.register(makeTool("wecom_respond", { channelOnly: true }), "built-in");
    const tools = agentComponent.getAvailableTools(makeAgentInstance("default"));
    expect(tools.map((t) => t.name)).not.toContain("wecom_respond");
  });

  test("channelOnly 工具在任意 agent 下默认都不可见（roy / strict-task-agent 同样）", () => {
    toolComponent.register(makeTool("wecom_respond", { channelOnly: true }), "built-in");
    expect(
      agentComponent.getAvailableTools(makeAgentInstance("roy")).map((t) => t.name),
    ).not.toContain("wecom_respond");
    expect(
      agentComponent
        .getAvailableTools(makeAgentInstance("strict-task-agent"))
        .map((t) => t.name),
    ).not.toContain("wecom_respond");
  });

  test("extendTools 显式列出时 channelOnly 工具可见（企微 ES 驱动的 default agent）", () => {
    toolComponent.register(makeTool("wecom_respond", { channelOnly: true }), "built-in");
    const ctx: AgentContext = { extendTools: ["wecom_respond"] };
    const tools = agentComponent.getAvailableTools(makeAgentInstance("default"), ctx);
    expect(tools.map((t) => t.name)).toContain("wecom_respond");
  });

  test("extendTools 列出别的工具时不放行未列出的 channelOnly 工具", () => {
    toolComponent.register(makeTool("wecom_respond", { channelOnly: true }), "built-in");
    toolComponent.register(makeTool("lark_respond", { channelOnly: true }), "built-in");
    const ctx: AgentContext = { extendTools: ["lark_respond"] };
    const names = agentComponent
      .getAvailableTools(makeAgentInstance("default"), ctx)
      .map((t) => t.name);
    expect(names).toContain("lark_respond");
    expect(names).not.toContain("wecom_respond");
  });

  test("普通工具（无 channelOnly 标记）不受 extendTools 影响", () => {
    toolComponent.register(makeTool("bash"), "built-in");
    const without = agentComponent.getAvailableTools(makeAgentInstance("default"));
    const withExt: AgentContext = { extendTools: ["wecom_respond"] };
    const withTools = agentComponent.getAvailableTools(makeAgentInstance("default"), withExt);
    expect(without.map((t) => t.name)).toContain("bash");
    expect(withTools.map((t) => t.name)).toContain("bash");
  });

  test("channelOnly 过滤对 defaultTools 入口生效（不走 ToolComponent）", () => {
    agentComponent.setDefaultTools([makeTool("wecom_respond", { channelOnly: true })]);
    expect(
      agentComponent.getAvailableTools(makeAgentInstance("default")).map((t) => t.name),
    ).not.toContain("wecom_respond");
    const ctx: AgentContext = { extendTools: ["wecom_respond"] };
    expect(
      agentComponent.getAvailableTools(makeAgentInstance("default"), ctx).map((t) => t.name),
    ).toContain("wecom_respond");
  });

  test("channelOnly ∧ allowedAgentTypes 都满足才可见（两者正交）", () => {
    // 工具同时声明 channelOnly + allowedAgentTypes:["default"]
    toolComponent.register(
      makeTool("dual_gate_tool", { channelOnly: true, allowedAgentTypes: ["default"] }),
      "built-in",
    );
    const ext: AgentContext = { extendTools: ["dual_gate_tool"] };

    // 条件都满足（default agent + 放行）→ 可见
    expect(
      agentComponent.getAvailableTools(makeAgentInstance("default"), ext).map((t) => t.name),
    ).toContain("dual_gate_tool");
    // 放行了但 agent 身份不符 → 不可见
    expect(
      agentComponent.getAvailableTools(makeAgentInstance("roy"), ext).map((t) => t.name),
    ).not.toContain("dual_gate_tool");
    // agent 身份符合但没放行 → 不可见
    expect(
      agentComponent.getAvailableTools(makeAgentInstance("default")).map((t) => t.name),
    ).not.toContain("dual_gate_tool");
  });

  test("extendTools 不能凭空创造工具（只放行已注册的 channelOnly 工具）", () => {
    toolComponent.register(makeTool("normal_tool"), "built-in");
    const ctx: AgentContext = { extendTools: ["not_registered_tool"] };
    const names = agentComponent
      .getAvailableTools(makeAgentInstance("default"), ctx)
      .map((t) => t.name);
    expect(names).not.toContain("not_registered_tool");
    expect(names).toContain("normal_tool");
  });

  test("channelOnly 过滤对 extraTools 入口生效", () => {
    const extra = makeTool("wecom_respond", { channelOnly: true });
    expect(
      agentComponent
        .getAvailableTools(makeAgentInstance("default"), { extraTools: [extra] })
        .map((t) => t.name),
    ).not.toContain("wecom_respond");
    expect(
      agentComponent
        .getAvailableTools(makeAgentInstance("default"), {
          extraTools: [extra],
          extendTools: ["wecom_respond"],
        })
        .map((t) => t.name),
    ).toContain("wecom_respond");
  });
});
