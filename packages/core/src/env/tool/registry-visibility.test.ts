/**
 * @fileoverview ToolRegistry allowedAgentTypes Visibility Filter Tests
 *
 * TDD: 验证 ToolRegistry.listTools() 支持按 agent 名称过滤工具
 *
 * 设计要点：
 * - Tool.metadata.allowedAgentTypes?: string[]
 *   - undefined / 空数组: 对所有 agent 可见（向后兼容）
 *   - 非空数组: 仅匹配列表中 agent.name 的工具返回
 * - 过滤在 getAvailableTools() 应用（agent-component.ts）
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "./registry";
import type { Tool, ToolRegistration } from "./types";

/**
 * Build a tool with a given name and optional allowedAgentTypes.
 */
function toolWithVisibility(
  name: string,
  allowedAgentTypes?: string[],
): Tool {
  const base: Tool = {
    name,
    description: `${name} tool`,
    parameters: z.object({ input: z.string() }),
    execute: async () => ({
      success: true,
      output: "ok",
      metadata: { execution_time_ms: 0 },
    }),
  };
  if (allowedAgentTypes !== undefined) {
    return {
      ...base,
      metadata: {
        ...(base.metadata ?? {}),
        allowedAgentTypes,
      },
    };
  }
  return base;
}

function reg(tool: Tool): ToolRegistration {
  return {
    tool,
    registeredAt: Date.now(),
    source: "built-in",
    enabled: true,
  };
}

describe("ToolRegistry — allowedAgentTypes visibility filter", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test("tools without allowedAgentTypes are visible to all agents (backward compat)", () => {
    const bash = toolWithVisibility("bash"); // no allowedAgentTypes
    registry.register(bash, reg(bash));

    // No filter: visible
    expect(registry.listTools().map((t) => t.name)).toEqual(["bash"]);

    // Filter by agent name: still visible
    const filtered = registry.listTools({ allowedAgent: "default" });
    expect(filtered.map((t) => t.name)).toEqual(["bash"]);

    const filteredRoy = registry.listTools({ allowedAgent: "roy" });
    expect(filteredRoy.map((t) => t.name)).toEqual(["bash"]);
  });

  test("tools with empty allowedAgentTypes array are visible to all agents", () => {
    const tool = toolWithVisibility("read_file", []);
    registry.register(tool, reg(tool));

    const filtered = registry.listTools({ allowedAgent: "default" });
    expect(filtered.map((t) => t.name)).toEqual(["read_file"]);
  });

  test("tools with allowedAgentTypes only show for matching agent", () => {
    const defaultOnly = toolWithVisibility("query_background_process", ["default"]);
    const royOnly = toolWithVisibility("strict-task-tool", ["roy", "strict-task-agent"]);
    const universal = toolWithVisibility("bash");

    registry.register(defaultOnly, reg(defaultOnly));
    registry.register(royOnly, reg(royOnly));
    registry.register(universal, reg(universal));

    // For "default" agent: only defaultOnly + universal
    const forDefault = registry
      .listTools({ allowedAgent: "default" })
      .map((t) => t.name)
      .sort();
    expect(forDefault).toEqual(["bash", "query_background_process"]);

    // For "roy" agent: only royOnly + universal
    const forRoy = registry
      .listTools({ allowedAgent: "roy" })
      .map((t) => t.name)
      .sort();
    expect(forRoy).toEqual(["bash", "strict-task-tool"]);

    // For unknown agent: only universal
    const forUnknown = registry
      .listTools({ allowedAgent: "unknown-agent" })
      .map((t) => t.name);
    expect(forUnknown).toEqual(["bash"]);
  });

  test("allowedAgent filter does not mutate original registry state", () => {
    const defaultOnly = toolWithVisibility("default_tool", ["default"]);
    registry.register(defaultOnly, reg(defaultOnly));

    // Filter by "default" — should see the tool
    expect(registry.listTools({ allowedAgent: "default" })).toHaveLength(1);

    // Filter by "roy" — should be empty
    expect(registry.listTools({ allowedAgent: "roy" })).toHaveLength(0);

    // But the tool should still exist in the registry
    expect(registry.listTools()).toHaveLength(1);
  });

  test("allowedAgent filter composes with other filters", () => {
    const t1 = toolWithVisibility("default_only", ["default"]);
    const t2 = toolWithVisibility("roy_only", ["roy"]);
    const t3 = toolWithVisibility("default_match", ["default", "roy"]);
    registry.register(t1, reg(t1));
    registry.register(t2, reg(t2));
    registry.register(t3, reg(t3));

    // allowedAgent=default + source=built-in → t1 + t3
    const filtered = registry
      .listTools({ allowedAgent: "default", source: "built-in" })
      .map((t) => t.name)
      .sort();
    expect(filtered).toEqual(["default_match", "default_only"]);
  });

  test("allowedAgent filter is case-sensitive", () => {
    const t = toolWithVisibility("default_only", ["default"]);
    registry.register(t, reg(t));

    expect(registry.listTools({ allowedAgent: "default" })).toHaveLength(1);
    expect(registry.listTools({ allowedAgent: "Default" })).toHaveLength(0);
    expect(registry.listTools({ allowedAgent: "DEFAULT" })).toHaveLength(0);
  });
});
/**
 * ★ Task #5333（DS review 第 2 轮 MINOR-5）— 回归锁。
 *
 * 契约：`ToolRegistry.listTools()` 是**存储目录**（`roy-bot tools list`、
 * 调试/枚举路径都会用到），它**不做** channelOnly 过滤。
 *
 * 可见性（channelOnly 放行）唯一收敛在 `AgentComponent.filterToolsByAgent`
 * —— 因为注册表没有"当前会话渠道"这个概念，若在这里过滤会出现
 * 「无 filter 全量返回 / 有 filter 却隐藏」的存在性不一致。
 *
 * 这条测试锁住该契约：后人往 listTools 里"顺手加回" channelOnly 过滤
 * （会让 wecom_respond 之类渠道工具在枚举路径上神秘消失）会立刻失败。
 */
describe("Task #5333 — ToolRegistry 不做 channelOnly 过滤（可见性单点收敛在 AgentComponent）", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  function channelOnlyTool(name: string): Tool {
    return {
      name,
      description: `${name} tool`,
      parameters: z.object({}),
      execute: async () => ({
        success: true,
        output: "ok",
        metadata: { execution_time_ms: 0 },
      }),
      metadata: { channelOnly: true },
    };
  }

  test("listTools() 无 filter 时返回 channelOnly 工具（存储目录语义）", () => {
    const t = channelOnlyTool("wecom_respond");
    registry.register(t, reg(t));
    expect(registry.listTools().map((x) => x.name)).toContain("wecom_respond");
  });

  test("listTools({ allowedAgent }) 仍返回 channelOnly 工具（注册表不管渠道）", () => {
    const t = channelOnlyTool("wecom_respond");
    registry.register(t, reg(t));
    expect(
      registry.listTools({ allowedAgent: "default" }).map((x) => x.name),
    ).toContain("wecom_respond");
  });

  test("listTools({ exclude }) 仍按名字排除（既有语义不受影响）", () => {
    const t = channelOnlyTool("wecom_respond");
    registry.register(t, reg(t));
    expect(
      registry.listTools({ exclude: ["wecom_respond"] }).map((x) => x.name),
    ).not.toContain("wecom_respond");
  });
});
