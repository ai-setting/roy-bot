import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { AgentComponent } from "./agent-component";
import type { Tool } from "../tool/types";
import { setToolConfigComponent } from "../tool/tool-component";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Tests for the truncation safety net on the AgentComponent tool execution
 * paths that previously bypassed `ToolComponent.execute()`:
 *
 *   (A) `isExtraTool` branch — tool is NOT in the ToolComponent registry
 *   (B) Fallback branch — ToolComponent is null / not initialized
 *
 * Both paths previously returned the raw tool output to the LLM without
 * any size cap. These tests assert that the inline truncation fix is wired
 * into both paths.
 */
describe("AgentComponent tool output truncation (bypass paths A & B)", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let tempDir: string;
  let emptyAgentsDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    setToolConfigComponent(null);

    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-trunc-test-"));
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

  /**
   * Build a fake HookContext for the private `executeTool(ctx)` method.
   * Only the fields `executeTool` actually consumes are populated.
   */
  function buildCtx(toolName: string, tool: Tool) {
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

  describe("Path B — no ToolComponent (fallback branch)", () => {
    it("truncates a large string output returned via the fallback path", async () => {
      const big = "B".repeat(10_000);
      const tool: Tool = {
        name: "fallback-huge",
        description: "returns a huge string",
        parameters: noParamsSchema,
        execute: vi.fn(async () => ({ success: true, output: big })),
      };
      agentComponent.setDefaultTools([tool]);

      // Force Path B: knock the toolComponent reference out so the
      // `else` branch runs and `tool.execute()` is called directly.
      (agentComponent as any).toolComponent = null;

      const ctx = buildCtx("fallback-huge", tool);
      const result = await (agentComponent as any).executeTool(ctx);

      expect(result.success).toBe(true);
      const out = result.result.output as string;
      expect(out.length).toBeLessThan(big.length);
      expect(out).toContain("[OUTPUT TRUNCATED:");
      expect(result.result.metadata?.output_truncated).toBe(true);
      expect(result.result.metadata?.original_output_size).toBe(big.length);
      expect(result.result.metadata?.truncated_output_size).toBe(5120);
    });

    it("does not truncate when fallback output is under the limit", async () => {
      const tool: Tool = {
        name: "fallback-small",
        description: "returns a small string",
        parameters: noParamsSchema,
        execute: vi.fn(async () => ({ success: true, output: "tiny" })),
      };
      agentComponent.setDefaultTools([tool]);
      (agentComponent as any).toolComponent = null;

      const result = await (agentComponent as any).executeTool(buildCtx("fallback-small", tool));

      expect(result.result.output).toBe("tiny");
      expect(result.result.metadata?.output_truncated).toBeUndefined();
    });
  });

  describe("Path A — extraTool (not in ToolComponent registry)", () => {
    it("truncates a large string output returned via the extraTool path", async () => {
      const big = "A".repeat(8_000);
      const extraTool: Tool = {
        name: "extra-huge",
        description: "extra tool with huge output",
        parameters: noParamsSchema,
        execute: vi.fn(async () => ({ success: true, output: big })),
      };
      agentComponent.setDefaultTools([extraTool]);

      // Force Path A: inject a mock ToolComponent that has a `getTool()` method
      // but reports "tool not registered" for our extra tool. This is the
      // exact condition the `isExtraTool` check verifies.
      (agentComponent as any).toolComponent = {
        getTool: vi.fn(() => undefined), // tool NOT in registry
        execute: vi.fn(),
      };

      const result = await (agentComponent as any).executeTool(buildCtx("extra-huge", extraTool));

      expect(result.success).toBe(true);
      const out = result.result.output as string;
      expect(out.length).toBeLessThan(big.length);
      expect(out).toContain("[OUTPUT TRUNCATED:");
      expect(result.result.metadata?.output_truncated).toBe(true);
      expect(result.result.metadata?.original_output_size).toBe(big.length);
      expect(result.result.metadata?.truncated_output_size).toBe(5120);
    });

    it("does not truncate when extraTool output is under the limit", async () => {
      const extraTool: Tool = {
        name: "extra-small",
        description: "extra tool with small output",
        parameters: noParamsSchema,
        execute: vi.fn(async () => ({ success: true, output: "ok" })),
      };
      agentComponent.setDefaultTools([extraTool]);

      (agentComponent as any).toolComponent = {
        getTool: vi.fn(() => undefined),
        execute: vi.fn(),
      };

      const result = await (agentComponent as any).executeTool(buildCtx("extra-small", extraTool));

      expect(result.result.output).toBe("ok");
      expect(result.result.metadata?.output_truncated).toBeUndefined();
    });

    it("honors per-tool override cap when toolName is read_file (200KB)", async () => {
      // 100KB output: over the 5KB default but well under the 200KB read_file
      // override. The bypass path should pick up the per-tool override via
      // `truncateOutputInline(result, undefined, undefined, toolName)`.
      const big = "R".repeat(100_000);
      const readFileTool: Tool = {
        name: "read_file",
        description: "read a file",
        parameters: noParamsSchema,
        execute: vi.fn(async () => ({ success: true, output: big })),
      };
      agentComponent.setDefaultTools([readFileTool]);

      (agentComponent as any).toolComponent = {
        getTool: vi.fn(() => undefined),
        execute: vi.fn(),
      };

      const result = await (agentComponent as any).executeTool(buildCtx("read_file", readFileTool));

      expect(result.success).toBe(true);
      // Per-tool override allows 100KB to pass through untouched.
      expect(result.result.metadata?.output_truncated).toBeUndefined();
      expect((result.result.output as string).length).toBe(100_000);
    });
  });

  // ========================================================================
  // skipTruncation metadata opt-in — Path A (extraTool) and Path B (fallback)
  // RED #6-#7 — both bypass paths must honor the tool's metadata flag.
  // ========================================================================
  describe("Path A — skipTruncation extraTool honors metadata opt-in", () => {
    it("preserves a 100KB string output for an opt-in extraTool", async () => {
      const big = "A".repeat(100_000);
      const tool: Tool = {
        name: "extra-skip",
        description: "extraTool opt-out of truncation",
        parameters: noParamsSchema,
        metadata: { skipTruncation: true },
        execute: vi.fn(async () => ({ success: true, output: big })),
      };
      agentComponent.setDefaultTools([tool]);

      // Force Path A: tool NOT registered with ToolComponent.
      (agentComponent as any).toolComponent = {
        getTool: vi.fn(() => undefined),
        execute: vi.fn(),
      };

      const result = await (agentComponent as any).executeTool(buildCtx(tool.name, tool));

      expect(result.success).toBe(true);
      expect(result.result.output).toBe(big);
      expect(result.result.metadata?.output_truncated).toBeUndefined();
      expect(result.result.metadata?.original_output_size).toBeUndefined();
      // The opt-in tool must not even mention a temp file fallback.
      expect(result.result.metadata?.truncation_temp_file).toBeUndefined();
    });
  });

  describe("Path B — skipTruncation fallback honors metadata opt-in", () => {
    it("preserves a 100KB string output for an opt-in fallback tool", async () => {
      const big = "B".repeat(100_000);
      const tool: Tool = {
        name: "fallback-skip",
        description: "fallback tool opt-out of truncation",
        parameters: noParamsSchema,
        metadata: { skipTruncation: true },
        execute: vi.fn(async () => ({ success: true, output: big })),
      };
      agentComponent.setDefaultTools([tool]);

      // Force Path B: no ToolComponent at all.
      (agentComponent as any).toolComponent = null;

      const result = await (agentComponent as any).executeTool(buildCtx(tool.name, tool));

      expect(result.success).toBe(true);
      expect(result.result.output).toBe(big);
      expect(result.result.metadata?.output_truncated).toBeUndefined();
      expect(result.result.metadata?.original_output_size).toBeUndefined();
      expect(result.result.metadata?.truncation_temp_file).toBeUndefined();
    });
  });
});
