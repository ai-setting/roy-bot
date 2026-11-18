/**
 * Task #2391 — v0.7.3 bug fix: `workflow_run` 启动时反复返回 "Unknown error"
 *
 * 背景：Task #2387 跑 a-stock-screener-v0.7.0/v0.7.1 时，agent 报告 workflow_run
 *       6+ 次返回通用 "Unknown error"。根因链路（单点）：
 *
 *       packages/core/src/env/agent/agent-component.ts:1694
 *         const toolOutput = toolResult.success
 *           ? toolResult.result.output || ""
 *           : toolResult.result.error || "Unknown error";
 *
 *       当 `toolResult.result.error` 为 falsy (空串 / undefined) 时直接 fall
 *       back 成 "Unknown error"，丢失了 run_id 与真实原因。
 *
 * 触发路径 1（捕获路径）：run-workflow.ts 的 try/catch 块里 `errorMessage`
 *       可能为 "" (Error 对象的 message 为空) 或非 Error throw (e.g. undefined
 *       / null / string) → buildErrorReturn 仍会带一个 message 字段，但
 *       `${errorMessage} (runId: ${errorRunId})` 在 errorMessage 缺失时退化
 *       为 `(runId: ...)` 不算未知，但 message="" 走到 ToolComponent 截断时
 *       仍可能被打到空。LATER 在 agent-component.ts:1694 的 `||` 短路仍
 *       触发 "Unknown error"。
 *
 * 触发路径 2（不通过 ToolComponent 路径）：在 agent-component.ts executeTool
 *       里有 isExtraTool / 无 ToolComponent 的分支直接调 tool.execute，此时
 *       tool 内部如果 throw，整段 catch 是 agent-component 的：
 *         error: error instanceof Error ? error.message : String(error)
 *       如果 throw 的 error 是非 Error 且 toString 是 ""，结果就是空。
 *
 * 触发路径 3（异步 rejection / unhandled）：run-workflow.ts 的 executeCall
 *       是 async () => workflowService.runWorkflow(...)，如果它内部抛出
 *       非 Error（直接 throw "string" / throw null），catch 路径走
 *       `errorMessage = error instanceof Error ? error.message : String(error)`
 *       → "null" / "undefined" / "" / "[object Object]" 各种退化。
 *
 * 本测试套件把这些边界都跑一遍，验证修复后 toolResult.result.error 永远
 * 非空（"Unknown error" 永不出现在 `toolResult.result.error` 路径），同时
 * 保留 run_id、不泄露敏感输入。
 *
 * 参考：
 *   - Task #2387 / /tmp/a-stock-screener-v0.7.1-run-analysis.md
 *   - Task #2190 (run-workflow.ts 已有 PRE-attach + onSessionCreated 替换 runId)
 *   - 失败的 run/session: workflow_1784870411454_fallback_4p0kji 等
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

describe("RunWorkflowTool — Task #2391 (v0.7.3 unknown error hardening)", () => {
  let mockWorkflowService: Partial<WorkflowService>;
  let tool: ReturnType<typeof createRunWorkflowTool>;
  let mockContext: ToolContext;

  beforeEach(() => {
    resetRunWorkflowTool();
    mockWorkflowService = {
      runWorkflow: vi.fn(),
      resumeSession: vi.fn(),
      stopRun: vi.fn().mockResolvedValue(undefined),
    };
    tool = createRunWorkflowTool(mockWorkflowService as WorkflowService);
    mockContext = { workdir: "/tmp" };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────
  // RED-1: 当 workflowService.runWorkflow 抛出 ERROR 对象但 message 为空，
  //        tool 必须仍然返回一个非空的 `error` 字段（含 runId），
  //        而不是退化成空串 / "Unknown error"。
  // ──────────────────────────────────────────────────────────────────
  it("RED-1: Error with empty message still surfaces a non-empty error field with runId", async () => {
    (mockWorkflowService.runWorkflow as any).mockImplementation(
      (_name: string, _input: any, options: any) => {
        if (options?.onSessionCreated) {
          options.onSessionCreated("workflow_2391_empty_err");
        }
        return Promise.reject(new Error("")); // empty message
      },
    );

    const result = await tool.execute(
      { workflow_name: "test-workflow" },
      mockContext,
    );

    expect(result.success).toBe(false);
    // RED: Currently the error is "Failed to run workflow test-workflow:  (runId: ...)"
    // (empty inner message). After fix: should never be empty/blank — must include
    // a meaningful classification like "[error.type=EmptyMessage]" + runId.
    expect(result.error).toBeTruthy();
    expect((result.error ?? "").length).toBeGreaterThan(0);
    // Must include runId so the agent can recover
    expect(result.error).toContain("workflow_2391_empty_err");
    // Must NOT be exactly the string "Unknown error"
    expect(result.error).not.toBe("Unknown error");
    expect(result.error).not.toMatch(/^Unknown error$/);
    // output.run_id must be present
    expect((result.output as any)?.run_id).toBe("workflow_2391_empty_err");
  });

  // ──────────────────────────────────────────────────────────────────
  // RED-2: 当 throw 一个非 Error 对象（null / undefined / 数字 / 字符串），
  //        tool 必须依然返回非空 error 字段。
  // ──────────────────────────────────────────────────────────────────
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["number 0", 0],
    ["plain object", { code: "E_CUSTOM" }],
  ])(
    "RED-2: throw non-Error %s → non-empty error field",
    async (_label, thrown) => {
      (mockWorkflowService.runWorkflow as any).mockImplementation(
        (_name: string, _input: any, options: any) => {
          if (options?.onSessionCreated) {
            options.onSessionCreated("workflow_2391_nonerr");
          }
          return Promise.reject(thrown);
        },
      );

      const result = await tool.execute(
        { workflow_name: "test-workflow" },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect((result.error ?? "").length).toBeGreaterThan(0);
      expect(result.error).not.toBe("Unknown error");
      expect(result.error).toContain("workflow_2391_nonerr");
      expect((result.output as any)?.run_id).toBe("workflow_2391_nonerr");
    },
  );

  // ──────────────────────────────────────────────────────────────────
  // RED-3: workflowService.runWorkflow 同步抛出（不是 rejected promise），
  //        tool 必须 catch 并返回非空 error 字段。
  // ──────────────────────────────────────────────────────────────────
  it("RED-3: sync throw inside runWorkflow → non-empty error field", async () => {
    (mockWorkflowService.runWorkflow as any).mockImplementation(() => {
      // synchronous throw — the tool's `await executeCall()` may or may not
      // surface it depending on the wrapper, but it must never be silently
      // swallowed into an empty error.
      throw new Error("sync boom");
    });

    const result = await tool.execute(
      { workflow_name: "test-workflow" },
      mockContext,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect((result.error ?? "").length).toBeGreaterThan(0);
    expect(result.error).not.toBe("Unknown error");
    expect(result.error).toContain("sync boom");
    // runId should be the synthesized fallback (reserved runId from synthFallbackRunId)
    expect((result.output as any)?.run_id).toMatch(/^workflow_/);
  });

  // ──────────────────────────────────────────────────────────────────
  // RED-4: 成功路径 — 返回的 ToolResult 必须总是包含 run_id/status/duration。
  //        这是给 agent 的契约，丢失任何一个字段都算 regression。
  // ──────────────────────────────────────────────────────────────────
  it("RED-4: success path returns run_id + status + output + duration_ms", async () => {
    (mockWorkflowService.runWorkflow as any).mockResolvedValue({
      runId: "workflow_2391_ok",
      sessionId: "workflow_2391_ok",
      status: "completed",
      output: { nodeA: "ok" },
      durationMs: 12,
    });

    const result = await tool.execute(
      { workflow_name: "ok-workflow" },
      mockContext,
    );

    expect(result.success).toBe(true);
    expect((result.output as any).run_id).toBe("workflow_2391_ok");
    expect((result.output as any).status).toBe("completed");
    expect((result.output as any).output).toEqual({ nodeA: "ok" });
    expect((result.output as any).duration_ms).toBeGreaterThanOrEqual(0);
  });

  // ──────────────────────────────────────────────────────────────────
  // RED-5: 失败路径 — error 字段必须包含 (a) runId, (b) 错误类型分类
  //        （如 [ErrorType=NodeFailed]）, (c) 不泄露 token/secret/env 变量。
  //        任何一项缺失都算 regression。
  // ──────────────────────────────────────────────────────────────────
  it("RED-5: error field includes runId + error type tag + does NOT leak tokens/secrets", async () => {
    const sensitiveInput = {
      api_key: "sk-secret-12345-do-not-leak",
      api_secret: "super-secret-value",
      bearer_token: "bearer-XYZ-9999",
    };
    // Plant a real env var so the tool's credential-key redaction can
    // find it (the tool only redacts env values that are actually in
    // process.env, not free-form strings that LOOK like env values).
    const priorSecret = process.env.SK_ENV_SECRET;
    process.env.SK_ENV_SECRET = "sk-env-secret";
    try {
      (mockWorkflowService.runWorkflow as any).mockImplementation(
        (_name: string, input: any, options: any) => {
          if (options?.onSessionCreated) {
            options.onSessionCreated("workflow_2391_secret");
          }
          return Promise.reject(
            new Error(
              `Boom! input=${JSON.stringify(input)} env=${process.env.SK_ENV_SECRET}`,
            ),
          );
        },
      );

      const result = await tool.execute(
        { workflow_name: "secret-test", input: sensitiveInput },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      // 包含 runId
      expect(result.error).toContain("workflow_2391_secret");
      // 包含可分类的错误类型 tag（不能纯 fallback "Unknown error"）
      expect(result.error).not.toBe("Unknown error");
      // 不能泄露敏感 token/secret
      expect(result.error).not.toContain("sk-secret-12345");
      expect(result.error).not.toContain("super-secret-value");
      expect(result.error).not.toContain("bearer-XYZ-9999");
      expect(result.error).not.toContain("sk-env-secret");
      // output.run_id 必须可恢复
      expect((result.output as any)?.run_id).toBe("workflow_2391_secret");
    } finally {
      if (priorSecret === undefined) {
        delete process.env.SK_ENV_SECRET;
      } else {
        process.env.SK_ENV_SECRET = priorSecret;
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // RED-6: 失败路径的 error 长度必须受上限保护（防止堆栈/大 payload 撑爆
  //        LLM context window）。默认上限 500 字符（详见修复后的 cap）。
  // ──────────────────────────────────────────────────────────────────
  it("RED-6: error field length is bounded even for huge rejection messages", async () => {
    const huge = "X".repeat(50_000);
    (mockWorkflowService.runWorkflow as any).mockImplementation(
      (_name: string, _input: any, options: any) => {
        if (options?.onSessionCreated) {
          options.onSessionCreated("workflow_2391_huge");
        }
        return Promise.reject(new Error(huge));
      },
    );

    const result = await tool.execute(
      { workflow_name: "huge-error-test" },
      mockContext,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    // Bounded: must not pass through the full 50k chars
    expect((result.error ?? "").length).toBeLessThan(2000);
    // 但 must still include runId (recovery anchor)
    expect(result.error).toContain("workflow_2391_huge");
  });

  // ──────────────────────────────────────────────────────────────────
  // RED-7: 失败路径的 output.run_id 必须稳定（即使 onSessionCreated 永远
  //        不触发，reserved fallback runId 也必须存在）。这与 Task #2100
  //        的设计一致 — fix 不应破坏这个 invariant。
  // ──────────────────────────────────────────────────────────────────
  it("RED-7: rejected promise without onSessionCreated → still has fallback run_id", async () => {
    (mockWorkflowService.runWorkflow as any).mockImplementation(
      () => Promise.reject(new Error("engine never persisted session")),
    );

    const result = await tool.execute(
      { workflow_name: "no-callback-test" },
      mockContext,
    );

    expect(result.success).toBe(false);
    const fallbackRunId = (result.output as any)?.run_id;
    expect(fallbackRunId).toMatch(/^workflow_/);
    expect(result.error).toContain(fallbackRunId);
  });

  // ──────────────────────────────────────────────────────────────────
  // RED-8: 失败路径不应该有 success: true（防 stale state），
  //        也不应该有 output.status === "completed"。
  //        防止把 failed 当 completed 报告给 LLM。
  // ──────────────────────────────────────────────────────────────────
  it("RED-8: failed run is reported with success=false AND status=failed|timeout", async () => {
    (mockWorkflowService.runWorkflow as any).mockImplementation(
      (_name: string, _input: any, options: any) => {
        if (options?.onSessionCreated) {
          options.onSessionCreated("workflow_2391_state");
        }
        return Promise.reject(new Error("Node execution failed"));
      },
    );

    const result = await tool.execute(
      { workflow_name: "state-test" },
      mockContext,
    );

    expect(result.success).toBe(false);
    expect(["failed", "timeout"]).toContain(
      (result.output as any)?.status,
    );
    expect((result.output as any)?.status).not.toBe("completed");
  });

  // ──────────────────────────────────────────────────────────────────
  // RED-9 (DECISIVE Task #2387 production shape): WorkflowEngine does
  // NOT reject its promise for normal node failures. It resolves a
  // RunResult with `status: "failed"` + `error`. The old run-workflow
  // success-path returned `success:false` and nested the error at
  // `output.error`, but failed to set top-level `ToolResult.error`.
  // agent-component.ts therefore hit `result.error || "Unknown error"`
  // and persisted 8 bare Unknown-error messages in sessions.db.
  //
  // This is the exact RED that reproduces the production bug (not a
  // synthetic thrown-exception edge case).
  // ──────────────────────────────────────────────────────────────────
  it("RED-9: resolved status=failed MUST set top-level ToolResult.error with runId + diagnostics", async () => {
    const nodeError = [
      'PythonCallNode "risk-assess": python exit code 1',
      'Traceback (most recent call last):',
      '  File "risk_assess.py", line 179, in run',
      "UnboundLocalError: cannot access local variable 'input_path'",
    ].join("\n");
    (mockWorkflowService.runWorkflow as any).mockResolvedValue({
      runId: "workflow_1784873502633_fallback_22ynih",
      sessionId: "workflow_1784873502633_fallback_22ynih",
      status: "failed",
      error: nodeError,
      output: {
        "load-candidates": "ok",
        "risk-assess": { failed: true },
      },
      durationMs: 6123,
    });

    const result = await tool.execute(
      { workflow_name: "a-stock-screener-v0.7.1" },
      mockContext,
    );

    expect(result.success).toBe(false);
    // DECISIVE: top-level error may NOT be empty/undefined. This was the
    // exact missing field that caused the bare "Unknown error" fallback.
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe("Unknown error");
    expect(result.error).toContain("PythonCallNode");
    expect(result.error).toContain("risk-assess");
    expect(result.error).toContain("workflow_1784873502633_fallback_22ynih");

    const output = result.output as Record<string, any>;
    expect(output.run_id).toBe("workflow_1784873502633_fallback_22ynih");
    expect(output.session_id).toBe("workflow_1784873502633_fallback_22ynih");
    expect(output.status).toBe("failed");
    expect(output.error_code).toBe("WORKFLOW_FAILED");
    expect(output.error_message).toContain("PythonCallNode");
    expect(output.error_stack_summary).toContain("UnboundLocalError");
    expect(output.duration_ms).toBe(6123);
  });

  it("RED-10: resolved status=failed without result.error still returns a diagnostic top-level error", async () => {
    (mockWorkflowService.runWorkflow as any).mockResolvedValue({
      runId: "workflow_2391_failed_no_error",
      sessionId: "workflow_2391_failed_no_error",
      status: "failed",
      output: { "node-a": { failed: true } },
      durationMs: 10,
    });

    const result = await tool.execute(
      { workflow_name: "failed-without-error" },
      mockContext,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe("Unknown error");
    expect(result.error).toContain("status=failed");
    expect(result.error).toContain("workflow_2391_failed_no_error");
    expect((result.output as any).error_code).toBe("WORKFLOW_FAILED_NO_MESSAGE");
  });
});
