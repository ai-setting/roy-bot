/**
 * Task #2391 — v0.7.3 unknown-error hardening at the agent-component layer.
 *
 * `composeToolOutputForLLM` is the helper that decides what string the
 * LLM sees for a tool result. The previous inline expression silently
 * produced a bare "Unknown error" string when the tool's `error` field
 * was empty, dropping the runId + recovery hint. These tests pin down
 * the new structured-fallback behavior across the four relevant shapes.
 *
 * Reference:
 *   - packages/core/src/env/agent/agent-component.ts (composeToolOutputForLLM)
 *   - Task #2387 /tmp/a-stock-screener-v0.7.1-run-analysis.md (symptom)
 */

import { describe, it, expect } from "bun:test";
import { composeToolOutputForLLM } from "./agent-component";

describe("composeToolOutputForLLM — Task #2391 unknown-error fallback", () => {
  it("returns the error string verbatim when error is non-empty (success=false)", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: false,
      output: "",
      error: "Workflow not found: a-stock-screener-v0.7.1",
    });
    expect(out).toBe("Workflow not found: a-stock-screener-v0.7.1");
    // The literal "Unknown error" must NEVER appear as the LLM-facing string
    expect(out).not.toBe("Unknown error");
    expect(out).not.toMatch(/^Unknown error$/);
  });

  it("returns the success output verbatim when success=true (output is string)", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: true,
      output: "ok",
      error: "",
    });
    expect(out).toBe("ok");
  });

  it("JSON-stringifies the success output when it is a record", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: true,
      output: { run_id: "workflow_abc", status: "completed", value: 42 },
      error: "",
    });
    expect(JSON.parse(out)).toEqual({
      run_id: "workflow_abc",
      status: "completed",
      value: 42,
    });
  });

  it("structured fallback includes runId + status when error is empty (runId from metadata)", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: false,
      output: { status: "failed" },
      error: "",
      metadata: { run_id: "workflow_2391_meta_runid" },
    });
    // The literal "Unknown error" must NEVER appear
    expect(out).not.toBe("Unknown error");
    expect(out).not.toMatch(/^Unknown error$/);
    // Must include runId (so the LLM can recover via workflow_run_status)
    expect(out).toContain("workflow_2391_meta_runid");
    // Must include status
    expect(out).toContain("status=failed");
    // Must include the diagnostic tag
    expect(out).toContain("[ErrorType=EmptyErrorField]");
  });

  it("structured fallback falls back to runId from output when metadata has none", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: false,
      output: { run_id: "workflow_2391_out_runid", status: "timeout" },
      error: undefined,
    });
    expect(out).toContain("workflow_2391_out_runid");
    expect(out).toContain("status=timeout");
    expect(out).toContain("[ErrorType=EmptyErrorField]");
  });

  it("structured fallback falls back to session_id when neither metadata.run_id nor output.run_id is present", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: false,
      output: { session_id: "workflow_2391_sess", status: "failed" },
      error: "",
    });
    expect(out).toContain("workflow_2391_sess");
  });

  it("structured fallback works even when there is NO runId anywhere (degenerate case)", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: false,
      output: { status: "failed" },
      error: "",
    });
    expect(out).not.toBe("Unknown error");
    expect(out).toContain("[ErrorType=EmptyErrorField]");
    expect(out).toContain("status=failed");
    expect(out).toContain("no error message and no runId");
  });

  it("null result yields a structured diagnostic, not a crash or 'Unknown error'", () => {
    const out = composeToolOutputForLLM("workflow_run", null);
    expect(out).toContain("[ErrorType=NullResult]");
    expect(out).not.toBe("Unknown error");
  });

  it("undefined result yields a structured diagnostic", () => {
    const out = composeToolOutputForLLM("workflow_run", undefined);
    expect(out).toContain("[ErrorType=NullResult]");
    expect(out).not.toBe("Unknown error");
  });

  it("empty string error AND empty output AND no metadata → still structured (not 'Unknown error')", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: false,
      output: "",
      error: "",
    });
    expect(out).not.toBe("Unknown error");
    expect(out).toContain("[ErrorType=EmptyErrorField]");
  });

  // ────────────────────────────────────────────────────────────────────
  // Task #2391 — actual production bug: tool results historically
  // surfaced `success: false` with a nested `output.error` (set by the
  // run-workflow tool layer) but WITHOUT a top-level `result.error`
  // field. The previous `toolResult.result.error || "Unknown error"`
  // fallback then dropped the diagnostic entirely, persisting 8 bare
  // `Unknown error` tool messages in sessions.db (Task #2387 evidence).
  // The new helper must fall back to `output.error` when top-level
  // `error` is missing, preserving the nested diagnostic.
  // ────────────────────────────────────────────────────────────────────
  it("falls back to output.error when top-level error is missing (Task #2387 production bug)", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: false,
      output: {
        run_id: "workflow_1784873502633_fallback_22ynih",
        status: "failed",
        error: "PythonCallNode ml-prediction failed: Need >=4 dates, got 1 (runId: workflow_1784873502633_fallback_22ynih)",
      },
      // NOTE: no top-level `error` field — this matches the production
      // shape recorded in sessions.db during Task #2387.
    });
    expect(out).not.toBe("Unknown error");
    expect(out).not.toMatch(/^Unknown error$/);
    // Must surface the nested error (not lose it)
    expect(out).toContain("PythonCallNode ml-prediction failed");
    // Must include the runId so the LLM can recover
    expect(out).toContain("workflow_1784873502633_fallback_22ynih");
  });

  it("prefers top-level error over output.error when both are present", () => {
    const out = composeToolOutputForLLM("workflow_run", {
      success: false,
      output: {
        run_id: "workflow_xyz",
        error: "nested: should-be-ignored",
      },
      error: "top-level: should-be-used",
    });
    expect(out).toContain("top-level: should-be-used");
    expect(out).not.toContain("nested: should-be-ignored");
  });
});
