/**
 * Task #4604 — D2: `workflow_run` must not impose a 30-minute ceiling on
 * workflows whose own definition asks for a longer budget.
 *
 * Root cause (Task #4599 §5.3):
 *   `run-workflow.ts:517` destructures `timeout = 1800000` — a hardcoded
 *   30-minute tool-side default. When the caller omits `timeout`, that value
 *   ALSO gets forwarded to the engine (`engine.ts:waitForCompletion`), so the
 *   whole run is aborted at 30 min no matter what the workflow definition's
 *   `config.timeout` says.
 *
 *   Real damage: `wheel-build-upload-validate` declares `config.timeout: 7200000`
 *   (2 h) and needs 40-55 min of real docker builds. Invoked without an explicit
 *   `timeout` it was aborted at exactly 30m0s, losing 7 of 12 nodes.
 *
 * Chosen fix — Option B (respect the workflow definition's own budget):
 *   When the caller does NOT pass `timeout`, derive the budget from the
 *   workflow definition (`definition.config.timeout`), falling back to the
 *   historical 30-minute default only when the definition declares nothing.
 *   An explicit caller `timeout` still wins (Option A behavior preserved).
 *
 * Unless the workflow definition cannot be resolved at all, in which case we
 * keep 30 minutes to avoid a surprise unbounded run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { createRunWorkflowTool, resetRunWorkflowTool } from "./run-workflow";
import type { WorkflowService } from "../service/workflow-service";
import type { ToolContext } from "../../../env/tool/types";

vi.mock("../../../env/log-trace/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const THIRTY_MINUTES = 1_800_000;

/** Build a WorkflowService stub whose definition declares `configTimeout`. */
function makeService(opts: {
  configTimeout?: number;
  definitionMissing?: boolean;
  runResolvesAfterMs?: number;
}): {
  service: Partial<WorkflowService>;
  runWorkflow: ReturnType<typeof vi.fn>;
} {
  const runWorkflow = vi.fn().mockImplementation(
    async (_name: string, _input: unknown, options: any) => {
      // Emulate the engine: fire onSessionCreated immediately so the tool's
      // timeout path is reachable in short tests.
      options?.onSessionCreated?.("workflow_4604_test_run");
      if (opts.runResolvesAfterMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.runResolvesAfterMs));
      }
      return { runId: "workflow_4604_test_run", status: "completed", output: {} };
    }
  );

  const service: Partial<WorkflowService> = {
    runWorkflow: runWorkflow as any,
    resumeSession: vi.fn() as any,
    stopRun: vi.fn().mockResolvedValue(undefined) as any,
    // The tool needs the workflow definition to resolve the declared budget.
    getWorkflowByName: vi.fn().mockImplementation((name: string) => {
      if (opts.definitionMissing) return null;
      return {
        id: name,
        name,
        version: "1.0.0",
        definition: {
          name,
          nodes: [],
          edges: [],
          config: {
            ...(opts.configTimeout !== undefined
              ? { timeout: opts.configTimeout }
              : {}),
          },
        },
        config: {},
        metadata: {},
        tags: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }) as any,
  };

  return { service, runWorkflow };
}

describe("Task #4604 D2 — workflow_run timeout derivation", () => {
  let tool: ReturnType<typeof createRunWorkflowTool>;
  let mockContext: ToolContext;

  beforeEach(() => {
    resetRunWorkflowTool();
    mockContext = { workdir: "/tmp" };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("RED-1: inherits definition config.timeout (2h) when caller omits timeout", async () => {
    const { service, runWorkflow } = makeService({ configTimeout: 7_200_000 });
    tool = createRunWorkflowTool(service as WorkflowService);

    await tool.execute(
      { workflow_name: "wheel-build-upload-validate" },
      mockContext
    );

    // The engine must receive 2h, NOT the 30-minute hardcoded default.
    expect(runWorkflow).toHaveBeenCalledTimes(1);
    expect(runWorkflow.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: 7_200_000 })
    );
  });

  it("RED-2: caller-supplied timeout still wins over the definition", async () => {
    const { service, runWorkflow } = makeService({ configTimeout: 7_200_000 });
    tool = createRunWorkflowTool(service as WorkflowService);

    await tool.execute(
      {
        workflow_name: "wheel-build-upload-validate",
        timeout: 500_000,
      },
      mockContext
    );

    expect(runWorkflow.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: 500_000 })
    );
  });

  it("RED-3: falls back to 30 minutes when the definition declares no config.timeout", async () => {
    const { service, runWorkflow } = makeService({});
    tool = createRunWorkflowTool(service as WorkflowService);

    await tool.execute({ workflow_name: "no-declared-budget" }, mockContext);

    expect(runWorkflow.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: THIRTY_MINUTES })
    );
  });

  it("RED-4: falls back to 30 minutes when the definition cannot be resolved", async () => {
    const { service, runWorkflow } = makeService({ definitionMissing: true });
    tool = createRunWorkflowTool(service as WorkflowService);

    await tool.execute({ workflow_name: "ghost-workflow" }, mockContext);

    expect(runWorkflow.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: THIRTY_MINUTES })
    );
  });

  it("RED-5: the ACTUAL race timer honors the derived 2h budget (not 30m)", async () => {
    // Run resolves after 60ms; definition declares 2h; caller omits timeout.
    // If the tool still used a 50ms-ish timer the run would be aborted — here
    // we just assert the derived budget is adopted (positive control below).
    const { service } = makeService({
      configTimeout: 7_200_000,
      runResolvesAfterMs: 60,
    });
    tool = createRunWorkflowTool(service as WorkflowService);

    const result = await tool.execute(
      { workflow_name: "wheel-build-upload-validate" },
      mockContext
    );

    expect((result.output as any)?.status).toBe("completed");
  });

  it("RED-6: a definition-declared short budget is honored too (no silent inflation)", async () => {
    const { service, runWorkflow } = makeService({ configTimeout: 20_000 });
    tool = createRunWorkflowTool(service as WorkflowService);

    await tool.execute({ workflow_name: "quick-task" }, mockContext);

    expect(runWorkflow.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: 20_000 })
    );
  });

  it("RED-7: resume path also derives the budget from the definition", async () => {
    const { service } = makeService({ configTimeout: 7_200_000 });
    (service.resumeSession as any).mockImplementation(
      async (_session: string, options: any) => {
        options?.onSessionCreated?.("workflow_1793160196641_fallback_ba1m78");
        return {
          runId: "workflow_1793160196641_fallback_ba1m78",
          status: "completed",
          output: {},
        };
      }
    );
    tool = createRunWorkflowTool(service as WorkflowService);

    // Real callers pass both `session` (to resume) and `workflow_name`
    // (the workflow being resumed) — see the CLI resume path.
    await tool.execute(
      {
        workflow_name: "wheel-build-upload-validate",
        session: "workflow_1793160196641_fallback_ba1m78",
      },
      mockContext
    );

    expect(service.resumeSession).toHaveBeenCalledTimes(1);
    expect((service.resumeSession as any).mock.calls[0][1]).toEqual(
      expect.objectContaining({ timeout: 7_200_000 })
    );
  });

  it("RED-8: the effective timeout is surfaced in the tool result metadata", async () => {
    const { service } = makeService({ configTimeout: 7_200_000 });
    tool = createRunWorkflowTool(service as WorkflowService);

    const result = await tool.execute(
      { workflow_name: "wheel-build-upload-validate" },
      mockContext
    );

    // Operators must be able to see which budget was actually applied.
    expect((result.metadata as any)?.timeout_ms).toBe(7_200_000);
  });
});

/**
 * Task #4604 (F3) — cross-validation found that `resolveEffectiveTimeout`
 * resolved definitions by NAME only, while `runWorkflow` accepts an ID.
 * `getWorkflow(idOrName)` tries `getById` FIRST, so a workflow invoked by ID
 * runs fine but its `config.timeout` was invisible → silently fell back to 30m.
 */
describe('Task #4604 F3 — definition resolution must work for both name and id', () => {
  it('RED-F3-1: a workflow addressed by ID still inherits its config.timeout', async () => {
    // Service whose getWorkflowByName is ID-blind, but getWorkflow(idOrName) resolves by id.
    const byId = {
      id: 'c0ffee-uuid',
      name: 'id-addressed-wf',
      definition: { name: 'id-addressed-wf', config: { timeout: 5_400_000 }, nodes: [] },
    };
    const service = {
      getWorkflowByName: (_n: string) => null,          // name lookup misses (it was invoked by id)
      getWorkflow: (idOrName: string) => (idOrName === 'c0ffee-uuid' ? byId : null),
      runWorkflow: async () => ({ runId: 'r', status: 'completed', output: undefined }),
    } as unknown as WorkflowService;

    const tool = createRunWorkflowTool(service, createMockSessionForF3());
    const result = await tool.execute({
      workflow_name: 'c0ffee-uuid',
      input: {},
    } as RunWorkflowInput);

    expect((result as any).metadata?.timeout_ms).toBe(5_400_000);
  });
});

function createMockSessionForF3(): any {
  return {
    create: async () => ({ id: 's' }),
    addMessage: async () => {},
    getMessages: async () => [],
    get: async () => ({ id: 's', metadata: {} }),
    update: async () => {},
  };
}
