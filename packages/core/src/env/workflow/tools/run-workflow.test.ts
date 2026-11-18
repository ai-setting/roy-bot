/**
 * Run Workflow Tool Tests - Phase 7
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { createRunWorkflowTool, resetRunWorkflowTool } from "./run-workflow";
import type { WorkflowService } from "../service/workflow-service";
import type { ToolContext } from "../../../env/tool/types";

// Mock logger
vi.mock("../../../env/log-trace/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("RunWorkflowTool", () => {
  let mockWorkflowService: Partial<WorkflowService>;
  let tool: ReturnType<typeof createRunWorkflowTool>;
  let mockContext: ToolContext;

  beforeEach(() => {
    // Reset state
    resetRunWorkflowTool();

    // Create mock WorkflowService
    // Task #2100: include `stopRun` so tests can spy on the timeout-path
    // stop-on-timeout behavior. Real WorkflowService.stopRun(sessionId, reason?)
    // is the public method called by the tool when the timeout wins the race.
    mockWorkflowService = {
      runWorkflow: vi.fn(),
      resumeSession: vi.fn(),
      stopRun: vi.fn().mockResolvedValue(undefined),
    };

    // Create the tool
    tool = createRunWorkflowTool(mockWorkflowService as WorkflowService);

    // Create mock context
    mockContext = {
      workdir: "/tmp",
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Tool Definition", () => {
    it("should have correct name", () => {
      expect(tool.name).toBe("workflow_run");
    });

    it("should have correct description (Task #1840: run_id always populated)", () => {
      expect(tool.description).toBe(
        "Run a workflow by name with optional input, OR resume an existing workflow run via the `session` field (the runId itself acts as session ID, both have `workflow_` prefix natively — pass the workflow run's runId directly). Returns run_id (== session_id, ALWAYS populated — even on timeout/abort/error paths), status, output, error, and duration_ms. When `timeout` is omitted the run budget is derived from the workflow definition's `config.timeout`, falling back to 30 minutes (1800000 ms) only when the definition declares none."
      );
    });

    it("should have correct category in metadata", () => {
      expect(tool.metadata?.category).toBe("workflow");
    });

    it("should have workflow tags", () => {
      expect(tool.metadata?.tags).toEqual(["workflow", "execute", "run"]);
    });

    it("should have sandbox disabled", () => {
      expect(tool.sandbox?.enabled).toBe(false);
    });

    it("should have safe permission level", () => {
      expect(tool.permission?.level).toBe("safe");
    });
  });

  describe("Parameter Schema", () => {
    it("should handle missing workflow_name gracefully", async () => {
      // When called directly (without ToolComponent validation), 
      // the tool should handle missing required params
      const result = await tool.execute({}, mockContext);
      // The tool receives undefined as workflow_name and fails when trying to use it
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to run workflow");
    });

    it("should accept valid workflow_name", async () => {
      // Mock the service to avoid actual execution
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        output: { result: "success" },
      });

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        mockContext
      );
      expect(result.success).toBe(true);
    });

    it("should accept optional input parameter", async () => {
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        output: { result: "success" },
      });

      const result = await tool.execute(
        { workflow_name: "test-workflow", input: { key: "value" } },
        mockContext
      );
      expect(result.success).toBe(true);
      // Task #1840: now also passes onSessionCreated; use anything-matcher
      expect(mockWorkflowService.runWorkflow).toHaveBeenCalledWith(
        "test-workflow",
        { key: "value" },
        expect.anything()
      );
    });

    it("should accept timeout parameter", async () => {
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "run-123",
        status: "completed",
      });

      await tool.execute(
        { workflow_name: "test-workflow", timeout: 5000 },
        mockContext
      );
      expect(mockWorkflowService.runWorkflow).toHaveBeenCalledWith(
        "test-workflow",
        undefined,
        expect.anything()
      );
    });

    // Task #3153: caller-supplied `timeout` MUST be forwarded to
    // workflowService.runWorkflow so the engine's `waitForCompletion`
    // honors the same budget as the tool's Promise.race. Previously
    // `baseOptions` dropped `timeout`, causing the engine to silently
    // fall back to its 20-min default — silently shrinking the
    // caller-requested budget for long-tail agent pipelines.
    it("[Task #3153] forwards timeout to workflowService.runWorkflow", async () => {
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "run-3153",
        status: "completed",
      });

      await tool.execute(
        { workflow_name: "long-pipeline", timeout: 3_600_000 },
        mockContext
      );
      expect(mockWorkflowService.runWorkflow).toHaveBeenCalledWith(
        "long-pipeline",
        undefined,
        expect.objectContaining({ timeout: 3_600_000 }),
      );
    });

    // ────────────────────────────────────────────────────────────────────
    // Task #1829: session parameter must route to resumeSession, not runWorkflow
    // ────────────────────────────────────────────────────────────────────

    it("should call workflowService.resumeSession when session is provided", async () => {
      (mockWorkflowService.resumeSession as any).mockResolvedValue({
        runId: "workflow_1783_1",
        status: "completed",
        sessionId: "workflow_1783_1",
      });

      const result = await tool.execute(
        {
          workflow_name: "strict-task-agent",
          session: "workflow_1783_1_abc",
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockWorkflowService.resumeSession).toHaveBeenCalledWith(
        "workflow_1783_1_abc",
        expect.anything()
      );
    });

    it("should NOT call runWorkflow when session is provided (resume path)", async () => {
      (mockWorkflowService.resumeSession as any).mockResolvedValue({
        runId: "workflow_1783_1",
        status: "completed",
        sessionId: "workflow_1783_1",
      });

      await tool.execute(
        {
          workflow_name: "strict-task-agent",
          session: "workflow_1783_1_abc",
        },
        mockContext,
      );

      expect(mockWorkflowService.runWorkflow).not.toHaveBeenCalled();
    });

    it("should still call runWorkflow when session is omitted (fresh-run path)", async () => {
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "run-new",
        status: "completed",
      });

      await tool.execute(
        { workflow_name: "test-workflow" },
        mockContext,
      );

      expect(mockWorkflowService.runWorkflow).toHaveBeenCalledWith(
        "test-workflow",
        undefined,
        expect.anything()
      );
      expect(mockWorkflowService.resumeSession).not.toHaveBeenCalled();
    });

    it("should pass input as userResponse on resume", async () => {
      (mockWorkflowService.resumeSession as any).mockResolvedValue({
        runId: "workflow_1783_1",
        status: "running",
        sessionId: "workflow_1783_1",
      });

      await tool.execute(
        {
          workflow_name: "strict-task-agent",
          session: "workflow_1783_1_abc",
          input: { userResponse: "yes" },
        },
        mockContext,
      );

      expect(mockWorkflowService.resumeSession).toHaveBeenCalledWith(
        "workflow_1783_1_abc",
        expect.objectContaining({
          input: { userResponse: "yes" },
        }),
      );
    });
  });

  describe("Sync Execution", () => {
    it("should return completed status for successful sync execution", async () => {
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "run-123",
        status: "completed",
        output: { result: "success" },
        durationMs: 100,
      });

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.output).toEqual({
        run_id: "run-123",
        status: "completed",
        output: { result: "success" },
        error: undefined,
        duration_ms: 100,
      });
    });

    it("should return failed status for failed execution", async () => {
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "run-123",
        status: "failed",
        error: "Something went wrong",
        durationMs: 50,
      });

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        mockContext
      );

      expect(result.success).toBe(false);
      // Task #2391 — v0.7.3: status=failed now surfaces structured
      // error_code / error_message / error_stack_summary fields so the
      // LLM gets a diagnostic instead of a bare "Unknown error". The
      // legacy fields (run_id / status / error / duration_ms) are
      // preserved for backward compatibility.
      expect(result.output).toMatchObject({
        run_id: "run-123",
        status: "failed",
        error: "Something went wrong",
        duration_ms: 50,
        error_code: "WORKFLOW_FAILED",
        error_message: expect.stringContaining("Something went wrong"),
      });
    });

    it("should include execution_time_ms in metadata", async () => {
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "run-123",
        status: "completed",
      });

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        mockContext
      );

      expect(result.metadata?.execution_time_ms).toBeDefined();
      expect(typeof result.metadata?.execution_time_ms).toBe("number");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Task #2086: workflow_run unified to "call → wait for completion".
  // Production code under test:
  //   - packages/core/src/env/workflow/tools/run-workflow.ts execute()
  //   - packages/core/src/env/workflow/types/run.ts (RunOptions.sync removed)
  //
  // These RED tests verify both layers: the schema rejects sync inputs, and
  // the tool does NOT forward a sync key to the underlying service. The
  // production refactor unblocks these (GREEN stage in Phase 2).
  // ────────────────────────────────────────────────────────────────────────

  describe("Task #2086 — sync removal (RED tests)", () => {
    it("should call runWorkflow with options that do NOT include a `sync` key", async () => {
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "run-2086-x",
        status: "completed",
        output: { ok: true },
        durationMs: 5,
      });

      await tool.execute({ workflow_name: "wf-2086-x" }, mockContext);

      expect(mockWorkflowService.runWorkflow).toHaveBeenCalledTimes(1);
      const callArgs = (mockWorkflowService.runWorkflow as any).mock.calls[0];
      const optionsArg = callArgs[2];
      expect(optionsArg).toBeDefined();
      expect(optionsArg).not.toHaveProperty("sync");
    });

    it("should call resumeSession with options that do NOT include a `sync` key", async () => {
      (mockWorkflowService.resumeSession as any).mockResolvedValue({
        runId: "wf_run_2086_resume",
        status: "completed",
        output: { ok: true },
        durationMs: 5,
      });

      await tool.execute(
        {
          workflow_name: "wf-2086-x",
          session: "workflow_2086_resume_1",
        },
        mockContext,
      );

      expect(mockWorkflowService.resumeSession).toHaveBeenCalledTimes(1);
      const callArgs = (mockWorkflowService.resumeSession as any).mock.calls[0];
      const optionsArg = callArgs[1];
      expect(optionsArg).toBeDefined();
      expect(optionsArg).not.toHaveProperty("sync");
    });
  });

  describe("Error Handling", () => {
    it("should handle workflow not found error", async () => {
      (mockWorkflowService.runWorkflow as any).mockRejectedValue(
        new Error("Workflow not found: non-existent-workflow")
      );

      const result = await tool.execute(
        { workflow_name: "non-existent-workflow" },
        mockContext
      );

      expect(result.success).toBe(false);
      const runId = (result.output as any)?.run_id;
      expect(result.error).toBe(
        `Workflow not found: non-existent-workflow (runId: ${runId})`
      );
    });

    it("should handle execution errors", async () => {
      (mockWorkflowService.runWorkflow as any).mockRejectedValue(
        new Error("Internal error")
      );

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to run workflow");
      expect(result.error).toContain("Internal error");
    });

    it("should handle timeout errors", async () => {
      // Create a tool with a short timeout
      const slowTool = createRunWorkflowTool(mockWorkflowService as WorkflowService);

      // Mock a slow-running workflow
      (mockWorkflowService.runWorkflow as any).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      const result = await slowTool.execute(
        { workflow_name: "slow-workflow", timeout: 100 },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    });

    // ────────────────────────────────────────────────────────────────────
    // Task #1840: run_id MUST be returned even on timeout/error/abort paths,
    // because the calling agent needs it to query status / resume later.
    // The engine creates the session (and exposes runId == sessionId) early
    // in the lifecycle, so the tool can capture it via onSessionCreated
    // and surface it in output.run_id on every termination path.
    // ────────────────────────────────────────────────────────────────────

    it("should return run_id on timeout (Task #1840: capture via onSessionCreated)", async () => {
      const slowTool = createRunWorkflowTool(mockWorkflowService as WorkflowService);

      // Simulate engine firing the callback right after creating the session,
      // BEFORE the slow execution completes. This mimics what the real
      // engine.runWorkflow() does — onSessionCreated is called immediately
      // after createSession() succeeds.
      (mockWorkflowService.runWorkflow as any).mockImplementation(
        (_name: string, _input: any, options: any) => {
          // Engine contract: invoke the callback right after session is
          // created, then continue execution. Here we just keep the promise
          // pending so the tool's timeout fires.
          if (options?.onSessionCreated) {
            options.onSessionCreated("workflow_1840_timeout_1");
          }
          return new Promise(() => {
            // never resolves → tool's Promise.race timeout wins
          });
        },
      );

      const result = await slowTool.execute(
        { workflow_name: "slow-workflow", timeout: 50 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");

      // run_id MUST be present in output (Task #1840 core requirement)
      expect((result.output as any)?.run_id).toBe("workflow_1840_timeout_1");
      expect((result.metadata as any)?.run_id).toBe("workflow_1840_timeout_1");
    });

    it("should return run_id on thrown exception (Task #1840: non-timeout error path)", async () => {
      (mockWorkflowService.runWorkflow as any).mockImplementation(
        (_name: string, _input: any, options: any) => {
          // Simulate engine firing the callback after session creation
          if (options?.onSessionCreated) {
            options.onSessionCreated("workflow_1840_err_1");
          }
          return Promise.reject(new Error("Node execution failed"));
        },
      );

      const result = await tool.execute(
        { workflow_name: "failing-workflow" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Node execution failed");

      // run_id MUST be present in output even on generic exception
      expect((result.output as any)?.run_id).toBe("workflow_1840_err_1");
      expect((result.metadata as any)?.run_id).toBe("workflow_1840_err_1");
    });

    it("should return run_id on aborted workflow (Task #1840: abort path)", async () => {
      const abortController = new AbortController();

      (mockWorkflowService.runWorkflow as any).mockImplementation(
        (_name: string, _input: any, options: any) => {
          if (options?.onSessionCreated) {
            options.onSessionCreated("workflow_1840_abort_1");
          }
          return new Promise((_, reject) => {
            abortController.signal.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          });
        },
      );

      const contextWithAbort: ToolContext = {
        ...mockContext,
        abort: abortController.signal,
      };

      setTimeout(() => abortController.abort(), 30);

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        contextWithAbort,
      );

      expect(result.success).toBe(false);
      expect((result.output as any)?.run_id).toBe("workflow_1840_abort_1");
      expect((result.metadata as any)?.run_id).toBe("workflow_1840_abort_1");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Task #1840: Resume path must also capture run_id via onSessionCreated.
  // The engine.run() (resume) should fire the callback immediately when it
  // resolves the session — which can be earlier than execution completion.
  // ────────────────────────────────────────────────────────────────────

  describe("Resume Run Id Capture (Task #1840)", () => {
    it("should capture run_id from onSessionCreated on resume (before execution completes)", async () => {
      // Simulate a paused workflow: session exists, engine resumes it but
      // execution will throw (simulating e.g. an ask_user interrupt that
      // surfaces as an error). The callback must already have fired by the
      // time the error reaches the tool.
      (mockWorkflowService.resumeSession as any).mockImplementation(
        (_sessionId: string, options: any) => {
          if (options?.onSessionCreated) {
            options.onSessionCreated("workflow_1840_resume_1");
          }
          return Promise.reject(new Error("Resumed execution failed"));
        },
      );

      const result = await tool.execute(
        {
          workflow_name: "strict-task-agent",
          session: "workflow_1840_resume_1",
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect((result.output as any)?.run_id).toBe("workflow_1840_resume_1");
      expect((result.metadata as any)?.run_id).toBe("workflow_1840_resume_1");
    });

    it("should also use captured run_id over result.runId on success", async () => {
      // When the engine completes successfully, runId is also on result.
      // The captured callback value should be preferred (more reliable since
      // it's fired before execution). If engine ever returns a different
      // runId (legacy double-prefix), we still surface the new format.
      (mockWorkflowService.runWorkflow as any).mockImplementation(
        (_name: string, _input: any, options: any) => {
          if (options?.onSessionCreated) {
            options.onSessionCreated("workflow_1840_success_1");
          }
          return Promise.resolve({
            runId: "workflow_1840_success_1",
            status: "completed",
            output: { ok: true },
            durationMs: 42,
          });
        },
      );

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect((result.output as any).run_id).toBe("workflow_1840_success_1");
    });

    it("should not throw when onSessionCreated is not provided (backward compat)", async () => {
      // Pre-Task-#1840 callers won't supply the callback. Tool must work.
      (mockWorkflowService.runWorkflow as any).mockResolvedValue({
        runId: "workflow_legacy_1",
        status: "completed",
      });

      // Mock that does NOT call onSessionCreated (simulating older engine)
      (mockWorkflowService.runWorkflow as any).mockImplementation(
        (_name: string, _input: any, _options: any) => {
          // No callback invocation
          return Promise.resolve({
            runId: "workflow_legacy_1",
            status: "completed",
          });
        },
      );

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect((result.output as any).run_id).toBe("workflow_legacy_1");
    });
  });

  describe("External Abort Signal", () => {
    it("should handle external abort signal", async () => {
      const abortController = new AbortController();

      (mockWorkflowService.runWorkflow as any).mockImplementation(
        () =>
          new Promise((_, reject) => {
            abortController.signal.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          })
      );

      const contextWithAbort: ToolContext = {
        ...mockContext,
        abort: abortController.signal,
      };

      // Abort after a short delay
      setTimeout(() => abortController.abort(), 50);

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        contextWithAbort
      );

      expect(result.success).toBe(false);
      // Should handle abort-related errors
      expect(result.error).toMatch(/aborted|timed out/i);
    });
  });
});

describe("RunWorkflowInputSchema", () => {
  it("should validate correct input", () => {
    const { RunWorkflowInputSchema } = require("./run-workflow");
    const result = RunWorkflowInputSchema.safeParse({
      workflow_name: "test",
      input: { key: "value" },
      timeout: 5000,
    });
    expect(result.success).toBe(true);
  });

  it("should require workflow_name", () => {
    const { RunWorkflowInputSchema } = require("./run-workflow");
    const result = RunWorkflowInputSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toContain("workflow_name");
  });

  // ────────────────────────────────────────────────────────────────────
  // Task #1829: session parameter (resume workflow from existing session)
  // ────────────────────────────────────────────────────────────────────

  it("should accept session id starting with 'workflow_' (resume path)", () => {
    const { RunWorkflowInputSchema } = require("./run-workflow");
    const result = RunWorkflowInputSchema.safeParse({
      workflow_name: "strict-task-agent",
      session: "workflow_1783407282099_1_ah8pho",
    });
    expect(result.success).toBe(true);
    expect(result.data?.session).toBe("workflow_1783407282099_1_ah8pho");
  });

  it("should reject session id NOT starting with 'workflow_'", () => {
    const { RunWorkflowInputSchema } = require("./run-workflow");
    const result = RunWorkflowInputSchema.safeParse({
      workflow_name: "strict-task-agent",
      session: "agent_1783407282099_1_ah8pho", // wrong prefix
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toContain("session");
  });

  it("should keep session optional (omitted = fresh-run, backward compatible)", () => {
    const { RunWorkflowInputSchema } = require("./run-workflow");
    const result = RunWorkflowInputSchema.safeParse({
      workflow_name: "test",
    });
    expect(result.success).toBe(true);
    expect(result.data?.session).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Task #2086: workflow_run is unified to "call → wait for completion" mode.
  // The legacy `sync?: boolean` parameter (true=wait, false=immediate) is
  // removed. The schema MUST reject `sync: true` / `sync: false` inputs,
  // and the tool MUST NOT forward a `sync` key to the underlying service.
  // These are the RED tests for the refactor — both must FAIL until the
  // production code in `tools/run-workflow.ts` and `types/run.ts` is updated.
  // ────────────────────────────────────────────────────────────────────────

  it("[Task #2086 RED] should reject sync:true as an unknown schema key", () => {
    const { RunWorkflowInputSchema } = require("./run-workflow");
    const result = RunWorkflowInputSchema.safeParse({
      workflow_name: "test",
      sync: true,
    });
    // Task #2086: with `.strict()` on the schema, the unknown `sync` key
    // surfaces as a `unrecognized_keys` issue. The error's `path` is empty
    // (it's about the whole object), but `keys` carries the offending names.
    expect(result.success).toBe(false);
    const issue = result.error?.issues?.[0] as any;
    expect(issue?.keys ?? []).toContain("sync");
  });

  it("[Task #2086 RED] should reject sync:false as an unknown schema key", () => {
    const { RunWorkflowInputSchema } = require("./run-workflow");
    const result = RunWorkflowInputSchema.safeParse({
      workflow_name: "test",
      sync: false,
    });
    expect(result.success).toBe(false);
    const issue = result.error?.issues?.[0] as any;
    expect(issue?.keys ?? []).toContain("sync");
  });

  it("[Task #2086 RED] should NOT forward sync to workflowService.runWorkflow", async () => {
    // Fresh tool instance (similar setup to top of file)
    resetRunWorkflowTool();
    const localService: Partial<WorkflowService> = {
      runWorkflow: vi.fn().mockResolvedValue({
        runId: "wf_run_2086_red",
        status: "completed",
        output: { ok: true },
        durationMs: 5,
      }),
      resumeSession: vi.fn(),
    };
    const localTool = createRunWorkflowTool(localService as WorkflowService);
    const localContext: ToolContext = { workdir: "/tmp" };

    await localTool.execute({ workflow_name: "wf-2086" }, localContext);

    expect(localService.runWorkflow).toHaveBeenCalledTimes(1);
    const callArgs = (localService.runWorkflow as any).mock.calls[0];
    const optionsArg = callArgs[2];
    expect(optionsArg).toBeDefined();
    expect(optionsArg).not.toHaveProperty("sync");
  });
});

// ────────────────────────────────────────────────────────────────────
// Task #2100 — Bug 1 (fallback runId on timeout when onSessionCreated
// never fires) + Bug 2 (workflow session is not stopped after timeout).
//
// RED tests added BEFORE the fix to prove both bugs exist in main:
// - T1: output.run_id must be a non-empty workflow_-prefixed string even
//       when the engine never calls onSessionCreated before timeout.
// - T2: workflowService.stopRun must be called once on timeout, with a
//       workflow_-prefixed runId and reason='timed out'.
// - T3: stopRun failure must NOT mask the original timeout error.
// - T4: stopRun must NOT be called on successful (non-timeout) execution.
// ────────────────────────────────────────────────────────────────────

describe("RunWorkflowTool — Task #2100 (timeout fallback runId + stopRun)", () => {
  let mockService: Partial<WorkflowService>;
  let localTool: ReturnType<typeof createRunWorkflowTool>;
  let localCtx: ToolContext;

  beforeEach(() => {
    resetRunWorkflowTool();
    mockService = {
      runWorkflow: vi.fn(),
      resumeSession: vi.fn(),
      // Task #2100 — T2/T3 spy target. Default to resolving; individual
      // tests can override with mockRejectedValueOnce / etc.
      stopRun: vi.fn().mockResolvedValue(undefined),
    };
    localTool = createRunWorkflowTool(mockService as WorkflowService);
    localCtx = { workdir: "/tmp" };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("T1 (Bug 1 RED): returns a non-empty fallback runId when onSessionCreated NEVER fires before timeout", async () => {
    // Mock: engine starts but never invokes onSessionCreated (mimics
    // real engine latency where the runWorkflow promise is still
    // in createSession() when the tool's 50ms timeout wins the race).
    (mockService.runWorkflow as any).mockImplementation(
      (_name: string, _input: any, _options: any) => {
        return new Promise(() => {
          // never resolves AND never invokes onSessionCreated
          // → capturedRunId stays undefined at timeout moment
        });
      },
    );

    const result = await localTool.execute(
      { workflow_name: "slow-never-creates-session", timeout: 50 },
      localCtx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");

    // run_id MUST be a non-empty workflow_-prefixed string
    const runId = (result.output as any)?.run_id;
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);
    expect(runId).not.toBe("");
    expect(runId).toMatch(/^workflow_/);

    // metadata.run_id should match
    expect((result.metadata as any)?.run_id).toBe(runId);
  });

  it("T2 (Bug 2 RED): calls workflowService.stopRun(runId, 'timed out') on timeout", async () => {
    (mockService.runWorkflow as any).mockImplementation(
      (_name: string, _input: any, _options: any) => {
        return new Promise(() => {
          // never resolves
        });
      },
    );

    await localTool.execute(
      { workflow_name: "hung-workflow", timeout: 50 },
      localCtx,
    );

    // stopRun must be called exactly once, with a non-empty runId
    // (either the captured one or the fallback) and reason='timed out'
    expect(mockService.stopRun).toHaveBeenCalledTimes(1);
    const [calledRunId, calledReason] = (mockService.stopRun as any).mock.calls[0];
    expect(typeof calledRunId).toBe("string");
    expect(calledRunId).toMatch(/^workflow_/);
    expect(calledReason).toBe("timed out");
  });

  it("T3 (defensive — stopRun failure does not mask original timeout error)", async () => {
    // Simulate stopRun failing (e.g. session not yet persisted when
    // race resolves). The tool must still return the timeout error
    // and NOT throw or return a stopRun error.
    (mockService.stopRun as any).mockRejectedValueOnce(
      new Error("Session not found: workflow_too_early"),
    );
    (mockService.runWorkflow as any).mockImplementation(
      (_name: string, _input: any, _options: any) =>
        new Promise(() => {
          // never resolves
        }),
    );

    const result = await localTool.execute(
      { workflow_name: "stop-fails-workflow", timeout: 50 },
      localCtx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    // run_id still non-empty even when stopRun failed
    expect((result.output as any)?.run_id).toMatch(/^workflow_/);
  });

  it("T4 (regression guard — stopRun is NOT called on successful run)", async () => {
    (mockService.runWorkflow as any).mockResolvedValue({
      runId: "workflow_ok_1",
      status: "completed",
      output: { ok: true },
    });

    const result = await localTool.execute(
      { workflow_name: "fast-workflow" }, // no timeout → no race
      localCtx,
    );

    expect(result.success).toBe(true);
    expect(mockService.stopRun).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// Task #2140 — the engine's internal waitForCompletion timer rejects
// with "execution timeout", not the outer tool timer's "timed out".
// Pin the tool-layer behavior for that distinct error path.
// ────────────────────────────────────────────────────────────────────

describe("RunWorkflowTool — Task #2140 (engine-inner-timeout path)", () => {
  let mockService: Partial<WorkflowService>;
  let localTool: ReturnType<typeof createRunWorkflowTool>;
  let localCtx: ToolContext;

  beforeEach(() => {
    resetRunWorkflowTool();
    mockService = {
      runWorkflow: vi.fn(),
      resumeSession: vi.fn(),
      stopRun: vi.fn().mockResolvedValue(undefined),
    };
    localTool = createRunWorkflowTool(mockService as WorkflowService);
    localCtx = { workdir: "/tmp" };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function rejectFromEngineInnerTimer(): void {
    (mockService.runWorkflow as any).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("Workflow execution timeout: 1800000ms"));
          }, 5);
        }),
    );
  }

  it("T-2140-A: calls stopRun when the inner engine.waitForCompletion timer wins", async () => {
    rejectFromEngineInnerTimer();

    const result = await localTool.execute(
      { workflow_name: "engine-inner-timer", timeout: 50 },
      localCtx,
    );

    expect(result.success).toBe(false);
    expect(mockService.stopRun).toHaveBeenCalled();
    const [calledRunId, calledReason] = (mockService.stopRun as any).mock.calls[0];
    expect(calledRunId).toMatch(/^workflow_/);
    expect(String(calledReason)).toMatch(/timed out|execution timeout/);
  });

  it("T-2140-B: error text includes the same runId returned for an engine inner timeout", async () => {
    rejectFromEngineInnerTimer();

    const result = await localTool.execute(
      { workflow_name: "engine-inner-timer", timeout: 50 },
      localCtx,
    );

    const runId = (result.output as any)?.run_id;
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/\(runId: workflow_[\w_]+\)/);
    expect(String(result.error)).toContain(runId);
  });

  it("T-2140-C: reports timeout status when the engine inner timer wins", async () => {
    rejectFromEngineInnerTimer();

    const result = await localTool.execute(
      { workflow_name: "engine-inner-timer", timeout: 50 },
      localCtx,
    );

    expect((result.output as any)?.status).toBe("timeout");
  });

  it("T-2140-D: includes runId in workflow-not-found errors", async () => {
    (mockService.runWorkflow as any).mockRejectedValue(
      new Error("Workflow not found: missing-workflow"),
    );

    const result = await localTool.execute(
      { workflow_name: "missing-workflow" },
      localCtx,
    );

    const runId = (result.output as any)?.run_id;
    expect(String(result.error)).toContain(`(runId: ${runId})`);
  });

  it("T-2140-E: includes runId in generic execution errors", async () => {
    (mockService.runWorkflow as any).mockRejectedValue(
      new Error("Node execution failed"),
    );

    const result = await localTool.execute(
      { workflow_name: "failing-workflow" },
      localCtx,
    );

    const runId = (result.output as any)?.run_id;
    expect(String(result.error)).toContain(`(runId: ${runId})`);
  });
});
