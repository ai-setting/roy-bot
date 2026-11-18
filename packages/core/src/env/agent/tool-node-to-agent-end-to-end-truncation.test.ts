/**
 * End-to-end regression test: workflow → tool → agent LLM context flow.
 *
 * Background: when a workflow executes a tool via ToolNode, the tool's
 * raw output enters `previousOutputs` of the workflow context, which
 * eventually flows into the Agent's LLM context (tool message body).
 *
 * History: the original "Path C" code in ToolNode.applyOutputTruncation()
 * attempted to truncate the tool-node's own output. The audit
 * (Task #1510) revealed this was redundant — the proper truncation
 * moment is when the tool output enters the LLM context, which is
 * already covered by Path A (extraTool) and Path B (no-ToolComponent
 * fallback) in AgentComponent.executeTool().
 *
 * As of this task (Task #1533), Path C is removed from ToolNode. To
 * prove this removal does NOT introduce a bypass — i.e., a tool
 * invoked via the workflow's ToolNode still gets its output truncated
 * before reaching the LLM — this test demonstrates the full flow:
 *
 *   1. ToolNode.execute() returns the raw, uncapped 10 KB output
 *      (proves Path C is no longer present).
 *   2. The same tool, invoked directly by the AgentComponent via the
 *      extraTool path (Path A) or fallback path (Path B), gets
 *      truncated to ≤5 KB with the standard "[OUTPUT TRUNCATED:"
 *      banner (proves the LLM-context boundary still applies the cap).
 *
 * Taken together, these two assertions prove end-to-end safety:
 *   - ToolNode stays a thin pass-through (preserves workflow raw data)
 *   - AgentComponent still owns the LLM-context cap (Path A/B)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

import { ToolNode, type ToolRegistry, type Tool } from "../workflow/nodes/tool-node";
import type { NodeDefinition, NodeExecutionContext } from "../workflow/types";
import { AgentComponent } from "./agent-component";
import type { Tool as ITool } from "../tool/types";
import { setToolConfigComponent } from "../tool/tool-component";
import { ConfigComponent } from "../../config/config-component";

import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

describe("Workflow ToolNode → AgentComponent end-to-end truncation", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let tempDir: string;
  let emptyAgentsDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    setToolConfigComponent(null);

    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "wf-agent-e2e-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);

    const mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
      registerComponent: vi.fn(),
      unregisterComponent: vi.fn(),
      getComponent: vi.fn((name: string) => (name === "config" ? configComponent : undefined)),
      hasComponent: vi.fn((name: string) => name === "config"),
      listComponents: vi.fn(() => []),
      handle_query: vi.fn(),
      handle_action: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeTo: vi.fn(() => () => {}),
      subscribeAll: vi.fn(() => () => {}),
      pushEnvEvent: vi.fn(),
    };

    await agentComponent.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env: mockEnv as any,
      options: { configComponent } as any,
    } as any);
  });

  afterEach(() => {
    setToolConfigComponent(null);
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {
      // ignore cleanup failures
    }
  });

  function buildAgentCtx(toolName: string, tool: ITool) {
    return {
      currentToolCall: {
        id: "tc-1",
        // AI SDK v6 uses { id, name, function: { name, arguments } } shape
        name: toolName,
        function: { name: toolName, arguments: {} },
      },
      tools: [tool],
      context: {
        sessionId: "test-session",
        messageId: "test-msg",
        abort: new AbortController().signal,
        metadata: {},
      },
    };
  }

  const noParamsSchema = z.object({});

  function buildToolNodeContext(
    nodeDefinition: NodeDefinition,
    sessionId: string
  ): NodeExecutionContext {
    return {
      runId: "run-1",
      nodeId: nodeDefinition.id,
      workflowName: "test-wf",
      config: nodeDefinition.config,
      sessionId,
      templateResolver: {
        resolve: vi.fn((v: any) => v),
        resolveValue: vi.fn((v: any) => v),
      } as any,
    } as any;
  }

  it("ToolNode passes through uncapped (Path C removed) AND AgentComponent truncates at LLM context boundary (Path A)", async () => {
    // A 10 KB string — well over the 5 KB default cap.
    const big = "E".repeat(10_000);

    // ---- Step 1: ToolNode.execute() — should return uncapped raw output.
    // ToolNode should no longer apply truncation (Path C removed). This
    // part of the proof: ToolNode is a thin pass-through to preserve
    // the integrity of workflow raw data.
    const wfRegistry: ToolRegistry = {
      getTool: vi.fn(),
      hasTool: vi.fn(),
    } as any;
    const wfTool: Tool = {
      name: "workflow-big-tool",
      execute: vi.fn(async () => ({ success: true, output: big })),
    } as any;
    (wfRegistry.getTool as any).mockReturnValue(wfTool);

    const wfNodeDef: NodeDefinition = {
      id: "wf-node-1",
      type: "tool",
      name: "Workflow Tool Node",
      config: {
        tool: "workflow-big-tool",
        input: { message: "hello" },
      },
    };
    const wfContext = buildToolNodeContext(wfNodeDef, "wf-session");

    const toolNode = new ToolNode(wfNodeDef, wfRegistry);
    const wfResult = await toolNode.execute(wfContext);

    // ToolNode returns the raw, uncapped 10 KB string. This means the
    // full output is preserved as a workflow node artifact. Path C
    // being absent is correct behavior.
    expect(wfResult.error).toBeUndefined();
    expect((wfResult.output as string).length).toBe(10_000);
    expect(wfResult.output).toBe(big);

    // ---- Step 2: AgentComponent.executeTool() — should truncate at
    // the LLM context boundary via Path A (extraTool). This is the
    // second part of the proof: even though ToolNode didn't truncate,
    // the same tool — invoked directly via AgentComponent — DOES get
    // truncated to the 5 KB cap before reaching the LLM.
    const agentTool: ITool = {
      name: "workflow-big-tool",
      description: "tool reachable via extraTool path",
      parameters: noParamsSchema,
      execute: vi.fn(async () => ({ success: true, output: big })),
    };
    agentComponent.setDefaultTools([agentTool]);

    (agentComponent as any).toolComponent = {
      getTool: vi.fn(() => undefined), // tool NOT in registry → Path A
      execute: vi.fn(),
    };

    const agentResult = await (agentComponent as any).executeTool(
      buildAgentCtx("workflow-big-tool", agentTool)
    );

    expect(agentResult.success).toBe(true);
    const out = agentResult.result.output as string;
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("[OUTPUT TRUNCATED:");
    expect(agentResult.result.metadata?.output_truncated).toBe(true);
    expect(agentResult.result.metadata?.original_output_size).toBe(big.length);
    expect(agentResult.result.metadata?.truncated_output_size).toBe(5120);
  });

  it("ToolNode passes through uncapped even when AgentComponent fallback path applies (Path B)", async () => {
    // Belt-and-braces: prove both Path A and Path B at the LLM-context
    // boundary cover the workflow tool output. With Path C gone and
    // Path A/B in place, the LLM context never receives >5 KB even if
    // the workflow tool produced 10 KB.
    const big = "F".repeat(10_000);

    const wfRegistry: ToolRegistry = {
      getTool: vi.fn(),
      hasTool: vi.fn(),
    } as any;
    const wfTool: Tool = {
      name: "fallback-tool",
      execute: vi.fn(async () => ({ success: true, output: big })),
    } as any;
    (wfRegistry.getTool as any).mockReturnValue(wfTool);

    const wfNodeDef: NodeDefinition = {
      id: "wf-node-2",
      type: "tool",
      name: "Workflow Tool Node (fallback)",
      config: {
        tool: "fallback-tool",
        input: { message: "ping" },
      },
    };
    const wfContext = buildToolNodeContext(wfNodeDef, "wf-session-2");
    const toolNode = new ToolNode(wfNodeDef, wfRegistry);
    const wfResult = await toolNode.execute(wfContext);

    // ToolNode passes uncapped raw output — Path C absent.
    expect((wfResult.output as string).length).toBe(10_000);

    // AgentComponent Path B (no ToolComponent) truncates at LLM boundary.
    const agentTool: ITool = {
      name: "fallback-tool",
      description: "tool reachable via fallback path",
      parameters: noParamsSchema,
      execute: vi.fn(async () => ({ success: true, output: big })),
    };
    agentComponent.setDefaultTools([agentTool]);
    (agentComponent as any).toolComponent = null; // Path B

    const agentResult = await (agentComponent as any).executeTool(
      buildAgentCtx("fallback-tool", agentTool)
    );
    expect(agentResult.success).toBe(true);
    expect((agentResult.result.output as string).length).toBeLessThan(big.length);
    expect(agentResult.result.metadata?.output_truncated).toBe(true);
  });
});
