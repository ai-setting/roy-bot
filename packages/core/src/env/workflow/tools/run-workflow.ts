/**
 * Run Workflow Tool - Phase 7
 * 
 * A Tool for executing workflows by name from within other workflows or agents.
 * 
 * Named "workflow_run" for consistency with other workflow tools.
 * The old name "run-workflow" is available via export alias.
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../../env/tool/types";
import type { WorkflowService } from "../service/workflow-service";
import { createLogger } from "../../../env/log-trace/logger";
import { TracedAs } from "../../../env/log-trace/decorator";
import { isValidSessionId } from "../../session";
import { getCurrentBgTaskId } from "../../task/delegate/bg-task-id-storage";

// 创建日志器
const logger = createLogger("run-workflow-tool");

/**
 * Task #2144 — Lifecycle hooks for sub-session attach/detach.
 *
 * Passed to createRunWorkflowTool by WorkflowComponent which has access to
 * BackgroundTaskManager. The hooks are optional: when omitted (e.g. main
 * session direct invocation, CLI `roy-bot workflow run`), the tool skips
 * attach/detach and behaves exactly as before.
 *
 * - attachWorkflowRun(bgTaskId, runId) is called BEFORE execute, when a
 *   bgTaskId is present in the AsyncLocalStorage stack. Even if the run
 *   later fails, attach is left in place so propagateStopToWorkflowRuns
 *   can clean up. This is the conservative "leak-prevention" semantics:
 *   any workflow run we know about deserves a stop attempt when the
 *   parent task stops.
 *
 * - detachWorkflowRun(bgTaskId, runId) is called ONLY on the success
 *   path (status === "completed" or "paused"). Detaching on success
 *   avoids redundant stopRun attempts on already-terminal workflows
 *   (which would otherwise log harmless "Session not found" warnings).
 */
export interface RunWorkflowLifecycleHooks {
  attachWorkflowRun?: (bgTaskId: string, runId: string) => void;
  detachWorkflowRun?: (bgTaskId: string, runId: string) => void;
  /**
   * Task #2190 — fired when the engine reports the real runId via
   * `onSessionCreated(realRunId)`. Allows the BackgroundTaskManager to
   * swap the registry entry from the reserved (placeholder) runId to the
   * real engine runId, so a mid-flight `stop_task` can find the workflow
   * by its real id (instead of the placeholder).
   *
   * Semantics: caller should drop `oldRunId` and add `newRunId`. If
   * `newRunId` is empty/falsy, the registry entry is simply removed
   * (engine never produced a real id — likely timeout before persistence).
   */
  replaceWorkflowRun?: (
    bgTaskId: string,
    oldRunId: string,
    newRunId: string,
  ) => void;
}

/**
 * Task #2100 — synthesize a `workflow_`-prefixed fallback runId.
 *
 * Used in `execute()` as the default value for `capturedRunId` when the
 * engine never fires `onSessionCreated` before the timeout/abort/error
 * path resolves. The format mirrors Task #1837's runId == sessionId
 * contract (`workflow_` + timestamp + suffix) so callers can't
 * distinguish a fallback runId from a real one by shape alone.
 *
 * Exported for testability (so tests can assert the format regex without
 * having to trigger the timeout path each time).
 *
 * @internal
 */
export function synthFallbackRunId(now: number = Date.now()): string {
  // Timestamp + 6-char base36 random — sufficient for cross-call
  // uniqueness within a single tool invocation; not crypto-grade.
  return `workflow_${now}_fallback_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Task #2100 — fire-and-forget stop for a workflow session after the
 * tool's timeout wins the Promise.race. Guarantees:
 *  - Never throws (`.catch` swallows stopRun's own rejections)
 *  - Never blocks the caller (`stopRun` is invoked without await)
 *  - Never masks the original timeout error (rejection is logged, not rethrown)
 *  - Defensive against partial test mocks that omit `stopRun`
 *
 * @internal
 */
function attemptStopOnTimeout(
  workflowService: WorkflowService,
  runId: string,
  reason: string,
): void {
  if (typeof workflowService.stopRun !== "function") return;
  workflowService.stopRun(runId, reason).catch((stopErr) => {
    logger.warn(
      `Failed to stop workflow ${runId} after timeout: ${
        stopErr instanceof Error ? stopErr.message : String(stopErr)
      }`,
    );
  });
}

/** Build a consistent failed ToolResult whose visible error always has runId. */
function buildErrorReturn(args: {
  errorRunId: string;
  status: "timeout" | "failed";
  errorMessage: string;
  durationMs: number;
}): ToolResult {
  const { errorRunId, status, errorMessage, durationMs } = args;
  const errorWithRunId = `${errorMessage} (runId: ${errorRunId})`;

  return {
    success: false,
    output: {
      run_id: errorRunId,
      status,
      error: errorWithRunId,
      duration_ms: durationMs,
    },
    error: errorWithRunId,
    metadata: {
      execution_time_ms: durationMs,
      run_id: errorRunId,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Task #2391 — v0.7.3 unknown-error hardening
// ────────────────────────────────────────────────────────────────────────
// Root cause: when a workflow_run invocation throws an Error with empty
// message, or a non-Error value (null / undefined / number / object), the
// tool's catch path used to produce a malformed error string. Worse, the
// engine's error message was passed through verbatim, so a workflow that
// echoed its `input` (which often contains API keys, tokens, env-bound
// secrets) into the error path would leak those secrets back to the LLM
// (RED-5). And a 50KB stack trace could blow up the LLM context window
// (RED-6). The downstream agent-component.ts:1694 fallback silently maps
// empty `toolResult.result.error` to the literal string "Unknown error",
// dropping the runId and recovery hint.
//
// The fix introduces three small helpers:
//   1. `classifyError(error)` — produce a stable, non-empty error type tag
//      (e.g. "[ErrorType=EmptyMessage]") so the LLM gets a diagnostic
//      even when the original message is empty / a non-string.
//   2. `sanitizeErrorMessage(message, sensitive)` — strip / replace the
//      sensitive payload (full input object, env values) with a
//      placeholder so secrets don't get echoed back through the tool
//      result and into the LLM context.
//   3. `capErrorLength(message, max)` — bound the surfaced message length
//      so a huge stack trace can't blow up the agent's context window.
//
// Constants chosen to fit the LLM context budget (a 1500-char cap on
// error means the rest of the tool output keeps room for the run_id,
// status, and a brief description). The cap is intentionally larger than
// the default `truncateOutput` ceiling (5120) because the run_id anchor
// + classification tag + truncated message is a high-signal payload.
// Note: the runId suffix `(runId: workflow_xxxxxxxxxx_xxxxxx_xxxxxx)`
// adds ~50 chars in buildErrorReturn, so the effective final cap is
// ~1550 chars; RED-6 asserts < 2000 which leaves a comfortable margin
// for future suffix growth.
const MAX_ERROR_MESSAGE_CHARS = 1500;
/** Prefix that lets the LLM / log parser identify a fallback classification. */
const ERROR_CLASSIFICATION_PREFIX = "[ErrorType=";

function classifyError(error: unknown): string {
  // Error must be checked BEFORE generic object, otherwise every native
  // Error is mislabeled `[ErrorType=Object]` (self-review finding).
  if (error instanceof Error) {
    const rawName = typeof error.name === "string" && error.name.trim()
      ? error.name.trim()
      : "Error";
    const safeName = rawName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
    if (!error.message) return `${ERROR_CLASSIFICATION_PREFIX}${safeName}:EmptyMessage]`;
    return `${ERROR_CLASSIFICATION_PREFIX}${safeName}]`;
  }
  if (error === null) return `${ERROR_CLASSIFICATION_PREFIX}Null]`;
  if (error === undefined) return `${ERROR_CLASSIFICATION_PREFIX}Undefined]`;
  if (typeof error === "string") {
    if (error.trim().length === 0) return `${ERROR_CLASSIFICATION_PREFIX}EmptyString]`;
    return `${ERROR_CLASSIFICATION_PREFIX}String]`;
  }
  if (typeof error === "number") return `${ERROR_CLASSIFICATION_PREFIX}Number]`;
  if (typeof error === "boolean") return `${ERROR_CLASSIFICATION_PREFIX}Boolean]`;
  if (typeof error === "object") return `${ERROR_CLASSIFICATION_PREFIX}Object]`;
  return `${ERROR_CLASSIFICATION_PREFIX}Unknown]`;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    return error.name && error.name !== "Error" ? error.name : "";
  }
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }
  // null / undefined / object: nothing safe to surface verbatim
  return "";
}

/**
 * Replace any occurrence of `sensitive` substrings in `message` with a
 * generic `[REDACTED]` marker. Used to scrub input objects and env-bound
 * secrets that may have been embedded in the error by upstream layers
 * (workflow nodes, python_call, etc.). `sensitive` is an array of strings
 * (longest first to avoid partial-substring ordering issues).
 */
function sanitizeErrorMessage(message: string, sensitive: string[]): string {
  if (!message || sensitive.length === 0) return message;
  let sanitized = message;
  // Sort longest-first so a longer token (e.g. "sk-secret-12345-do-not-leak")
  // is replaced before any shorter prefix of it (e.g. "sk-secret").
  const ordered = [...sensitive].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    if (!secret) continue;
    // Use a global, non-overlapping replace; for the patterns we care about
    // (tokens, env-var values) a literal string replace is correct.
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized;
}

function capErrorLength(message: string, max: number = MAX_ERROR_MESSAGE_CHARS): string {
  if (typeof message !== "string" || message.length <= max) return message;
  const truncated = message.substring(0, max);
  return `${truncated}…[truncated ${message.length - max} chars; original=${message.length}]`;
}

/**
 * Pick the first non-empty message for a non-Error throwable. Mirrors
 * `normalizeErrorMessage` but skips the Error-specific branch because
 * the success-path caller already has a `string` (the engine's
 * `RunResult.error` is a string, never a thrown value). Kept as a
 * separate helper so the catch path can stay simple while the success
 * path remains readable.
 */
function errorMessageBaseFor(message: string | undefined): string {
  return typeof message === "string" && message.length > 0 ? message : "";
}

/**
 * Collect sensitive values to redact: every string value in the
 * caller-supplied `input` object plus any `process.env` value whose
 * KEY contains a credential-related token (token/secret/password/api_key)
 * OR whose VALUE appears verbatim in the supplied error message. The
 * second pass is the safety net for python_call / bash_tool nodes
 * that interpolate env values into error strings.
 */
function collectSensitiveValues(
  input: unknown,
  messageForEnvScan: string,
): string[] {
  const sensitive: string[] = [];
  if (input && typeof input === "object") {
    for (const v of Object.values(input as Record<string, unknown>)) {
      if (typeof v === "string" && v.length >= 6) sensitive.push(v);
    }
  }
  const envSecretKeys = new Set<string>();
  try {
    for (const [k, v] of Object.entries(process.env ?? {})) {
      if (typeof v !== "string" || v.length < 6) continue;
      const kLower = k.toLowerCase();
      if (
        kLower.includes("token") ||
        kLower.includes("secret") ||
        kLower.includes("password") ||
        kLower.includes("api_key") ||
        kLower.includes("apikey")
      ) {
        sensitive.push(v);
        envSecretKeys.add(k);
      }
    }
  } catch {
    // Some test envs forbid process.env reads; skip silently.
  }
  if (messageForEnvScan) {
    try {
      for (const [k, v] of Object.entries(process.env ?? {})) {
        if (typeof v !== "string" || v.length < 8) continue;
        if (envSecretKeys.has(k)) continue;
        if (
          messageForEnvScan.includes(v) &&
          (/[0-9_-]/.test(v) || /^[A-Za-z0-9+/=_-]+$/.test(v))
        ) {
          sensitive.push(v);
        }
      }
    } catch {
      // skip
    }
  }
  return sensitive;
}

/**
 * Extract a short stack-like summary from a multi-line error message.
 * Heuristic: keep the first non-empty line + up to 3 lines that look
 * like traceback frames (`File "..."` / `at ...`). Lines starting with
 * `Traceback` and an actual error message line (the line immediately
 * before the next `File ` frame) are also kept so the LLM can see
 * WHICH exception type fired. Bounded to 600 chars.
 */
function extractStackSummary(message: string): string {
  if (typeof message !== "string" || message.length === 0) return "";
  const lines = message.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  const picked: string[] = [lines[0]!];
  let frameCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(File\s+|at\s+)/.test(line)) {
      picked.push(line);
      frameCount++;
      if (frameCount >= 3) break;
    }
  }
  // If the very last non-empty line isn't a `File`/`at` frame (e.g.
  // the error type line like "UnboundLocalError: ..."), tack it on so
  // the LLM sees the actual exception type instead of a truncated view.
  const lastLine = lines[lines.length - 1]!;
  if (
    picked[picked.length - 1] !== lastLine &&
    !/^\s*(File\s+|at\s+)/.test(lastLine)
  ) {
    picked.push(lastLine);
  }
  const joined = picked.join("\n");
  return joined.length > 600 ? joined.slice(0, 600) + "…[truncated]" : joined;
}

/**
 * Input schema for workflow_run tool
 */
export const RunWorkflowInputSchema = z.object({
  workflow_name: z.string().describe("Name of the workflow to run"),
  input: z.record(z.any()).optional().describe("Input to pass to the workflow"),
  timeout: z.number().positive().optional().describe("Timeout in milliseconds. When omitted, derived from the workflow definition's config.timeout; falls back to 1800000 (30 min) if the definition declares none."),
  // Task #1974 — Workflow Node-Level Config + Resume + Stop.
  // Per-node runtime overrides keyed by node id. Values are shallow-merged
  // into each node's effective config at buildNodeContext time. Keys present
  // in BOTH the node's static config and nodeConfig[nodeId] are taken from
  // nodeConfig (input wins). Unknown node IDs are silently ignored.
  //
  // Common keys:
  // - `timeout`: per-node execution timeout (ms), overrides engine global
  //   timeout and the node's static `definition.timeout`.
  // - `maxIterations`: only honored when the workflow has `loopEnabled: true`.
  // - `model`, `allowedTools`, `deniedTools`: forwarded to agent nodes via
  //   `options.*` (forward-compatible; agent-node reads these).
  //
  // Backward compatible: when omitted (or empty), engine behavior is unchanged.
  node_config: z.record(z.string(), z.record(z.string(), z.any())).optional()
    .describe("Per-node runtime config overrides keyed by node id (Task #1974). "
      + "Shallow-merged into each node's effective config; input wins over nodeDef.config."),
  // Task #1829: session resume capability added.
  // Task #1837: runId natively carries `workflow_` prefix, so runId == sessionId.
  // Pass the runId directly as the `session` parameter to resume an existing
  // workflow run. The regex below still enforces the `workflow_` prefix for
  // safety (and covers legacy double-prefixed ids like `workflow_run_xxx`).
  // Mutually exclusive (in spirit) with `input` — though the tool does not
  // enforce this; if both are provided, `input` is forwarded as a
  // `userResponse` to the engine for ask_user interrupt resume paths.
  session: z.string()
    .regex(/^workflow_/, { message: "session must start with 'workflow_'" })
    .optional()
    .describe("Existing session ID (workflow_xxx) to resume from. Mutually exclusive with fresh `input` runs."),
})
  // Task #2086: workflow_run is unified to "call → wait for completion".
  // The legacy `sync?: boolean` field is removed from the schema. We
  // also enable `strict()` so that ANY unknown key — including a
  // lingering `sync: true|false` from a stale caller — is rejected
  // with a clear validation error rather than silently stripped.
  // This protects the API surface from future schema drift.
  .strict();

export type RunWorkflowInput = z.infer<typeof RunWorkflowInputSchema>;

/**
 * Workflow Run Tool interface for type-safe access
 */
export interface RunWorkflowToolInterface {
  name: "workflow_run";
  description: string;
  inputSchema: typeof RunWorkflowInputSchema;
}

/** Decorated wrapper that preserves the public Tool execute signature. */
class RunWorkflowToolRunner {
  constructor(private readonly executeImpl: Tool["execute"]) {}

  @TracedAs("workflow.run-workflow-tool.execute", {
    recordParams: true,
    recordResult: false,
  })
  public async execute(
    args: Parameters<Tool["execute"]>[0],
    ctx: ToolContext,
  ): Promise<ToolResult> {
    return this.executeImpl(args, ctx);
  }
}

/**
 * Task #2190 — Decorated wrapper that traces the PRE-attach orchestration
 * (attach/replace/detach three-phase) for sub-session-launched workflow runs.
 *
 * The inner `RunWorkflowToolRunner` already covers the full tool execution
 * with `workflow.run-workflow-tool.execute`. This additional span tracks
 * the lifecycle hook orchestration specifically (whether PRE-attach fired,
 * whether replaceWorkflowRun got called, whether detach happened).
 *
 * @internal
 */
class RunWorkflowLifecycleTracer {
  constructor(
    private readonly runner: RunWorkflowToolRunner,
    private readonly bgTaskId: string | undefined,
    private readonly hooks: RunWorkflowLifecycleHooks | undefined,
  ) {}

  @TracedAs("workflow.run-tool.pre-attach", {
    recordParams: true,
    recordResult: false,
  })
  public async execute(
    args: Parameters<Tool["execute"]>[0],
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const hasHooks = !!this.hooks?.attachWorkflowRun;
    const hasBgTask = !!this.bgTaskId;
    const result = await this.runner.execute(args, ctx);

    // Mirror the orchestrator's detach logic so the trace result reflects
    // what actually happened (attached/replaced/detached/success).
    let detached = false;
    if (this.bgTaskId && this.hooks?.detachWorkflowRun) {
      const runId =
        (result as any)?.metadata?.run_id ??
        (result as any)?.output?.run_id ??
        "";
      if (runId && result.success) {
        this.hooks.detachWorkflowRun(this.bgTaskId, runId);
        detached = true;
      }
    }

    return {
      ...result,
      // Tag the trace result with the orchestration state so the span
      // observer can see attached/replaced/detached/success in one place.
      metadata: {
        ...(result as any).metadata,
        __pre_attach: {
          hasBgTask,
          hasHooks,
          detached,
          success: !!result.success,
        },
      },
    } as ToolResult;
  }
}

/**
 * Legacy tool-side default run budget (30 minutes).
 *
 * Kept as the fallback for definitions that declare no `config.timeout`, and
 * for the case where the definition cannot be resolved at all. See
 * `resolveEffectiveTimeout` for the full precedence chain.
 */
export const DEFAULT_WORKFLOW_RUN_TIMEOUT_MS = 1_800_000;

/**
 * Resolve the effective run budget for `workflow_run`.
 *
 * Precedence (Task #4604 / D2):
 *   1. Caller-supplied `timeout`               — always wins (explicit intent)
 *   2. Workflow definition `config.timeout`    — the workflow's declared budget
 *   3. `DEFAULT_WORKFLOW_RUN_TIMEOUT_MS`       — legacy 30-minute fallback
 *
 * Why step 2 exists: previously the tool's 30-minute default was forwarded to
 * the engine, so a workflow declaring `config.timeout: 7200000` was still
 * aborted at 30 minutes. The definition is the authoritative budget — the tool
 * should not silently shrink it.
 *
 * Only positive finite numbers are accepted at every level; anything else falls
 * through to the next level (same defensive shape as tool-node's
 * `getToolTimeoutMs`).
 *
 * Definition lookup is wrapped in try/catch: a missing/partial WorkflowService
 * (lightweight test doubles, mock services) must NOT make workflow execution
 * fail here. We degrade to the legacy default instead.
 */
export function resolveEffectiveTimeout(
  workflowService: WorkflowService | undefined,
  workflowName: string | undefined,
  explicitTimeout: number | undefined
): number {
  if (isPositiveFinite(explicitTimeout)) {
    return explicitTimeout;
  }

  if (workflowName) {
    try {
      // `runWorkflow` accepts an ID *or* a name, and `getWorkflow(idOrName)`
      // tries `getById` FIRST. Resolving by name only (the original D2 shape)
      // therefore missed definitions addressed by ID, silently falling back to
      // the 30-minute default (Task #4604 F3, found in cross-validation).
      const workflow =
        workflowService?.getWorkflow?.(workflowName) ??
        workflowService?.getWorkflowByName?.(workflowName);
      const declared = workflow?.definition?.config?.timeout;
      if (isPositiveFinite(declared)) {
        return declared;
      }
    } catch (err) {
      // Defensive: definition lookup must never break execution. The same read
      // happens again inside `workflowService.runWorkflow`, so a genuinely
      // corrupt definition still surfaces to the caller one step later —
      // warn here rather than swallowing silently.
      logger.warn(
        `workflow_run: could not resolve definition for ${workflowName}; ` +
          `falling back to the default run budget`,
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  return DEFAULT_WORKFLOW_RUN_TIMEOUT_MS;
}

/** Type guard: true iff `v` is a positive, finite number. */
function isPositiveFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Create a workflow_run tool with the given WorkflowService
 *
 * @param workflowService - The WorkflowService instance for executing workflows
 * @param hooks - Optional Task #2144 lifecycle hooks for sub-session attach/detach.
 *                When bgTaskId is present in the ALS stack (i.e. invoked from a
 *                sub-session inside a delegate_task), the tool will register
 *                its runId via `hooks.attachWorkflowRun` and detach on success
 *                via `hooks.detachWorkflowRun`. Main-session direct invocation
 *                (no bgTaskId) skips both.
 * @returns A Tool instance for running workflows
 */
export function createRunWorkflowTool(
  workflowService: WorkflowService,
  hooks?: RunWorkflowLifecycleHooks
): Tool {
  const tool: Tool = {
    name: "workflow_run",
    // Task #1837: runId == sessionId. Task #1840: run_id is ALWAYS populated,
    // even when execution times out, aborts, or throws — so the calling agent
    // can later query status or resume via `workflow_run_status` / re-invoke
    // `workflow_run` with `session=run_id`.
    description: "Run a workflow by name with optional input, OR resume an existing workflow run via the `session` field (the runId itself acts as session ID, both have `workflow_` prefix natively — pass the workflow run's runId directly). Returns run_id (== session_id, ALWAYS populated — even on timeout/abort/error paths), status, output, error, and duration_ms. When `timeout` is omitted the run budget is derived from the workflow definition's `config.timeout`, falling back to 30 minutes (1800000 ms) only when the definition declares none.",
    parameters: RunWorkflowInputSchema,
    sandbox: {
      enabled: false, // Workflow execution doesn't need sandbox
    },
    permission: {
      level: "safe",
    },
    metadata: {
      category: "workflow",
      tags: ["workflow", "execute", "run"],
      version: "1.0.0",
      experimental: false,
    },
    execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const startTime = Date.now();
      // Task #1974: snake_case → camelCase rename for the engine layer, which
      // uses `nodeConfig` (matches RunOptions / WorkflowEngineConfig shape).
      // We accept `node_config` from the tool schema (snake_case is the
      // convention for tool inputs — see also `workflow_name`, `session`, etc.)
      // and pass it through as `nodeConfig` to engine / service.
      const { workflow_name, input, session, timeout, node_config } = args as RunWorkflowInput & { node_config?: Record<string, Record<string, unknown>> };

      // ★ Task #4604 (D2) — derive the run budget instead of hard-capping it.
      //
      // Before: `timeout = 1800000` at the destructuring site. That 30-minute
      // value was ALSO forwarded to the engine (`...(timeout ? { timeout } : {})`),
      // so `engine.waitForCompletion` used it (`timeoutMs = timeout ?? 1200000`)
      // and aborted the whole run at exactly 30m — no matter what the workflow
      // definition's own `config.timeout` said.
      //
      // Real damage (Task #4599 §5.3): `wheel-build-upload-validate` declares
      // `config.timeout: 7200000` (2h) and needs 40-55 minutes of real docker
      // builds. Invoked without an explicit `timeout`, it was killed at 30m0s
      // with only 5 of 12 nodes done.
      //
      // Now: an explicit caller `timeout` still wins (unchanged precedence), and
      // when omitted we consult the workflow definition's `config.timeout`, so a
      // workflow that declares its own budget is no longer silently shrunk.
      // The 30-minute value survives only as the fallback for definitions that
      // declare nothing (or that cannot be resolved), preserving legacy behavior.
      const effectiveTimeout = resolveEffectiveTimeout(
        workflowService,
        workflow_name,
        timeout
      );

      logger.info(`Running workflow: ${workflow_name}`, {
        input,
        timeout: effectiveTimeout,
        timeoutSource: timeout ? "caller" : "definition-or-default",
        ...(session ? { resumeSession: session } : {}),
      });

      // Capture parent session id from tool context so the workflow run
      // session is linked to the calling agent/CLI session (Task #1739).
      // Falls back to ROY_PARENT_SESSION_ID env var for cross-process cases
      // (e.g. when invoked from `roy-bot workflow run` CLI).
      //
      // Issue #8: validate every candidate before using it. The env-var
      // fallback in particular crosses a trust boundary (a parent process
      // sets it for the child), so we silently ignore invalid values
      // rather than letting malformed strings corrupt the session tree.
      const ctxSessionId =
        typeof ctx?.session_id === "string" && isValidSessionId(ctx.session_id)
          ? ctx.session_id
          : undefined;
      const envSessionId =
        typeof process.env.ROY_PARENT_SESSION_ID === "string" &&
        isValidSessionId(process.env.ROY_PARENT_SESSION_ID)
          ? process.env.ROY_PARENT_SESSION_ID
          : undefined;
      if (
        process.env.ROY_PARENT_SESSION_ID &&
        !envSessionId
      ) {
        logger.warn(
          `Ignoring malformed ROY_PARENT_SESSION_ID env value (must match /^[A-Za-z0-9_-]{8,128}$/); received length=${process.env.ROY_PARENT_SESSION_ID.length}`
        );
      }
      const parentSessionId: string | undefined = ctxSessionId ?? envSessionId;

      let timeoutHandle: NodeJS.Timeout | undefined;
      let durationMs: number;

      // Task #1840: capture the runId (== sessionId) AS EARLY AS POSSIBLE so
      // it can be returned on every termination path (success / timeout /
      // abort / thrown exception). The engine fires `onSessionCreated`
      // immediately after creating/resolving the workflow session, which is
      // before any user-facing execution begins.
      //
      // Resume path: when `session` is provided, the runId IS the session
      // id (Task #1837: runId == sessionId). We can capture it immediately
      // without waiting for the engine, so timeout/error responses include
      // the runId even if the engine itself never gets a chance to fire.
      //
      // Task #2100 — Bug 1 fix: pre-synthesize a `workflow_`-prefixed
      // fallback runId at the very top of execute(). The default for
      // capturedRunId is `fallbackRunId` (instead of undefined) so the
      // error path's `capturedRunId ?? fallbackRunId` still works when
      // the engine never fires onSessionCreated (timeout wins before
      // createSession() resolves).
      //
      // We track whether onSessionCreated actually fired via
      // `capturedByCallback`. The success path uses this flag to avoid
      // accidentally overwriting a real `result.runId` with the
      // synthesized fallback when the engine never fires the callback.
      //
      // Task #2106 GREEN-B: turn the synthesized fallback into a REAL
      // reserved runId that we forward to the engine via RunOptions.runId.
      // After this change, the fallback is queryable / stoppable through
      // workflow_run_status / workflow_run_stop, not just shape-compatible.
      const reservedRunId = synthFallbackRunId();
      let timedOut = false;
      let capturedByCallback = false;
      let capturedRunId: string | undefined = session ? session : reservedRunId;

      // ★ Task #2190 — PRE-execution attach.
      // The bug: stop_task fires `propagateStopToWorkflowRuns`, which reads
      // `workflowRunRegistries.get(bgTaskId)`. With POST-attach (the previous
      // behavior), the registry is empty during the entire workflow lifetime,
      // so propagateStop early-returns (`set.size === 0`) and the workflow
      // keeps running as an orphan.
      //
      // Fix: register the reservedRunId NOW, BEFORE `workflowService.runWorkflow`
      // is awaited. The engine's eventual `onSessionCreated(sid)` then triggers
      // `replaceWorkflowRun(bgTaskId, reservedRunId, sid)` so the registry
      // entry points at the real engine runId.
      //
      // Main-session direct invocation (no bgTaskId) skips this entirely;
      // the wrapper short-circuits before we even reach this code path.
      const bgTaskIdForAttach = getCurrentBgTaskId();
      if (bgTaskIdForAttach && hooks?.attachWorkflowRun) {
        hooks.attachWorkflowRun(bgTaskIdForAttach, reservedRunId);
      }

      const onSessionCreated = (sid: string) => {
        capturedRunId = sid;
        capturedByCallback = true;
        // Task #2106 RED-B3 fix: if the tool's timeout already fired
        // before the engine persisted the session, the initial stopRun
        // attempt likely failed with "Session not found". Retry once
        // now that the real session exists, so background workflow
        // execution does not continue past the user-visible timeout.
        if (timedOut) {
          attemptStopOnTimeout(workflowService, sid, "timed out");
        }
        // Task #2190 — onSessionCreated now also swaps the registry entry
        // from the reserved placeholder runId to the real engine runId.
        // This is the "replaceWorkflowRun" half of the PRE-attach fix.
        if (bgTaskIdForAttach && hooks?.replaceWorkflowRun) {
          hooks.replaceWorkflowRun(bgTaskIdForAttach, reservedRunId, sid);
        }
      };

      try {
        let result;

        // Task #1829: branch on `session` parameter.
        // - With `session`: resume an existing workflow session via the public
        //   `WorkflowService.resumeSession()` API. The engine re-enters
        //   execution from the persisted node state (or forwards `input` as
        //   userResponse for ask_user interrupt paths).
        // - Without `session`: fresh run via `runWorkflow` as before.
        //
        // Task #1840: forward onSessionCreated so the engine can populate
        // capturedRunId right after session creation — the only way to get
        // runId on timeout/error paths.
        //
        // Task #1974: forward `nodeConfig` so the engine can merge per-node
        // runtime overrides into each node's effective config.
        const fallbackRunId = reservedRunId; // Task #2106: alias for backward compat in error paths
        const baseOptions: Record<string, unknown> = {
          ...(parentSessionId ? { parentSessionId } : {}),
          // Task #2106 GREEN-B: forward the reserved runId on fresh runs so
          // the engine persists the same id we'll surface on timeout.
          // Resume path keeps the caller's session id verbatim.
          ...(session ? {} : { runId: reservedRunId }),
          onSessionCreated,
          ...(node_config ? { nodeConfig: node_config } : {}),
          // ★ Task #3153 — Forward caller-supplied `timeout` to the engine so
          // `waitForCompletion` honors the same timeout as the tool's
          // Promise.race. Without this, the engine falls back to its 20-min
          // default (`timeoutMs = timeout ?? 1200000` in
          // `engine.ts:waitForCompletion`), which silently shrinks the
          // caller-requested 60-min budget for long-tail agent pipelines
          // (e.g. example-rd-with-trace-and-ci 12-node chain).
          // See DEFAULT_WORKFLOW_RUN_TIMEOUT_MS for the tool-side fallback of 1800000.
          timeout: effectiveTimeout,
        };

        const executeCall = async () => {
          if (session) {
            return workflowService.resumeSession(session, {
              ...baseOptions,
              ...(input ? { input } : {}),
            });
          }
          return workflowService.runWorkflow(workflow_name, input, baseOptions as any);
        };

        if (effectiveTimeout) {
          // Execute workflow with timeout wrapper
          result = await Promise.race([
            executeCall(),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                // Task #2100 — Bug 2 fix: stop the underlying workflow
                // session so it doesn't keep burning tokens in the
                // background after we return the timeout error. We use
                // whichever runId we have at this moment
                // (capturedRunId may have been populated by
                // onSessionCreated; fallbackRunId is the engine-never-fired
                // fallback). The helper is fire-and-forget and never
                // masks the timeout error.
                //
                // Task #2106 RED-B3 fix: mark `timedOut = true` BEFORE
                // attempting stopRun so that a late onSessionCreated
                // callback (firing after this point) triggers a retry
                // stopRun against the now-persisted session.
                timedOut = true;
                attemptStopOnTimeout(
                  workflowService,
                  capturedRunId ?? reservedRunId,
                  "timed out",
                );
                reject(new Error("Workflow execution timed out"));
              }, effectiveTimeout);
            }),
          ]);
        } else {
          // No timeout - execute directly
          result = await executeCall();
        }

        // Clear timeout
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        durationMs = Date.now() - startTime;

        // Task #1840: prefer capturedRunId over result.runId when both are
        // available. capturedRunId is more reliable because it was captured
        // at session-creation time (before any execution branching), whereas
        // result.runId comes back through the full pipeline and could in
        // theory diverge (e.g. legacy double-prefix).
        //
        // Task #2100 — Bug 1 fix: gate the `capturedRunId` choice on
        // `capturedByCallback` so we don't accidentally surface the
        // synthesized fallback on the success path when the engine
        // didn't fire onSessionCreated — in that case the real runId
        // came back via result.runId and is the authoritative value.
        // (The fallback is only for timeout/error paths where result
        // is undefined.)
        const finalRunId = capturedByCallback
          ? capturedRunId
          : (result.runId ?? "");

        // Task #2086: workflow_run is unified to "call → wait for completion"
        // (sync mode). The legacy `sync: false` fire-and-forget branch is
        // removed; callers needing post-completion polling should use
        // `workflow_run_status` on the returned run_id.
        //
        // Treat paused as success at the tool boundary — pausing for ask_user
        // is a normal state, not a failure. The CLI shows the pause + query
        // to the user (see renderRunResult 'paused' branch) so they can
        // resume.
        //
        // Task #2391 — v0.7.3 unknown-error fix: when the engine resolves
        // with `status === "failed"` (or "stopped") but rejects the promise,
        // we previously returned the raw RunResult nested at output.output
        // with no top-level ToolResult.error. agent-component.ts then hit
        // `toolResult.result.error || "Unknown error"`, dropping the
        // diagnostic into the literal fallback string and persisting 8
        // bare "Unknown error" tool messages in sessions.db during Task
        // #2387 (parts length 140, 8/8 = 100%).
        //
        // The fix below detects the resolved-but-failed case, classifies
        // the engine error (sanitize + cap), and ALWAYS sets top-level
        // `ToolResult.error` so the LLM sees a structured diagnostic
        // instead of the bare fallback. The existing `agent-component.ts`
        // `composeToolOutputForLLM` fallback (Task #2391 GREEN-B) still
        // covers the case where some upstream layer strips our
        // top-level error — so we now have defense in depth.
        const resolvedStatus = result.status;
        const isResolvedFailure =
          resolvedStatus === "failed" || resolvedStatus === "stopped";

        // Run the engine error through the same sanitization pipeline as
        // the catch path so secrets are redacted and length is capped
        // before being surfaced as `ToolResult.error` (RED-5 / RED-6).
        const sensitiveForResolved = collectSensitiveValues(
          input,
          errorMessageBaseFor(result.error ?? ""),
        );
        const sanitizedResolvedMessage = sanitizeErrorMessage(
          errorMessageBaseFor(result.error ?? ""),
          sensitiveForResolved,
        );
        const resolvedErrorClassification = result.error
          ? classifyError(new Error(result.error))
          : "[ErrorType=EmptyMessage]";
        const resolvedErrorMessage = capErrorLength(
          sanitizedResolvedMessage.length > 0
            ? sanitizedResolvedMessage
            : "Workflow reported status=failed without an error message (runId=" + finalRunId + ")",
        );

        if (isResolvedFailure) {
          const failureCode = result.error
            ? "WORKFLOW_FAILED"
            : "WORKFLOW_FAILED_NO_MESSAGE";
          return {
            success: false,
            output: {
              run_id: finalRunId,
              session_id: result.sessionId ?? finalRunId,
              status: resolvedStatus,
              error: result.error,
              error_code: failureCode,
              error_message: result.error ? sanitizedResolvedMessage : "",
              // Keep at most 4 lines of stack-like text so the LLM can
              // see WHICH node/line failed without a 50KB stack dump.
              error_stack_summary: extractStackSummary(result.error ?? ""),
              output: result.output,
              duration_ms: result.durationMs || durationMs,
              ...(result.pendingNodeId ? { pending_node_id: result.pendingNodeId } : {}),
              ...(result.query ? { query: result.query } : {}),
              ...(result.agentSessionId ? { agent_session_id: result.agentSessionId } : {}),
            },
            error: `${resolvedErrorMessage} ${resolvedErrorClassification} (runId: ${finalRunId})`,
            metadata: {
              execution_time_ms: durationMs,
              run_id: finalRunId,
              timeout_ms: effectiveTimeout,
            },
          };
        }

        return {
          success: resolvedStatus === "completed" || resolvedStatus === "paused",
          output: {
            run_id: finalRunId,
            status: resolvedStatus,
            output: result.output,
            error: result.error,
            duration_ms: result.durationMs || durationMs,
            // surface ask_user fields so the CLI can render them (Task #1980+follow-up)
            ...(result.pendingNodeId ? { pending_node_id: result.pendingNodeId } : {}),
            ...(result.query ? { query: result.query } : {}),
            ...(result.agentSessionId ? { agent_session_id: result.agentSessionId } : {}),
          },
          metadata: {
            execution_time_ms: durationMs,
            run_id: finalRunId, // Task #1840: always include run_id in metadata
            // Task #4604 (D2): surface the budget actually applied so callers
            // can tell "definition-derived" from "caller-specified".
            timeout_ms: effectiveTimeout,
          },
        };
      } catch (error) {
        // Clear timeout on error
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        durationMs = Date.now() - startTime;

        // Task #2391 — v0.7.3 unknown-error hardening: classify and normalize
        // the thrown value first so we never feed an empty / non-string
        // message into the agent. The original `errorMessage` derivation
        // (`error instanceof Error ? error.message : String(error)`) was
        // broken because:
        //   - an Error with empty message → `""`
        //   - a thrown `null` → `"null"`
        //   - a thrown `undefined` → `"undefined"`
        //   - a thrown plain object → `"[object Object]"`
        // All four would either leak through as garbage or get swallowed
        // by the agent-component.ts:1694 fallback to "Unknown error".
        const errorClassification = classifyError(error);
        const rawErrorMessage = normalizeErrorMessage(error);

        // Build a non-empty `errorMessage` for the user-visible payload.
        // Even when the upstream message is empty, we always carry the
        // classification tag so the LLM has a stable diagnostic.
        const errorMessageBase = rawErrorMessage.length > 0
          ? rawErrorMessage
          : `${errorClassification} (no message from thrown value)`;

        // Task #1840: always surface run_id in error responses so the caller
        // can still query status / resume. capturedRunId may have been
        // populated by onSessionCreated before the failure, OR (in the
        // resume path) be the session id passed in by the caller.
        //
        // Task #2100 — Bug 1 fix applied here: never fall back to "".
        // Use `fallbackRunId` (synthesized at the top of execute()) so
        // the caller ALWAYS has a non-empty, `workflow_`-prefixed runId
        // even when onSessionCreated never fired (e.g. timeout wins
        // before the engine createSession completes).
        const errorRunId = capturedRunId ?? reservedRunId;

        // Sanitize via the shared helper (same logic the success path
        // uses when it detects status=failed). The helper walks input
        // values + process.env credential-named vars + env values that
        // appear verbatim in the error message. Keeping one source of
        // truth here means new credential patterns only need to be added
        // once.
        const sensitiveValues = collectSensitiveValues(input, errorMessageBase);
        const sanitizedMessage = sanitizeErrorMessage(errorMessageBase, sensitiveValues);

        // Handle specific error types — note we test against the SANITIZED
        // message (after secrets are redacted) so e.g. a "Workflow not
        // found" message containing a secret in the workflow name still
        // gets matched correctly while secrets stay redacted.
        if (sanitizedMessage.includes("Workflow not found")) {
          return buildErrorReturn({
            errorRunId,
            status: "failed",
            errorMessage: `Workflow not found: ${workflow_name}`,
            durationMs,
          });
        }

        const isTimeoutLike =
          sanitizedMessage.includes("abort") ||
          sanitizedMessage.includes("timed out") ||
          sanitizedMessage.includes("execution timeout:");

        if (isTimeoutLike) {
          // The engine's internal timeout can win before the outer tool timer,
          // so request cancellation from this catch path only when the outer
          // timer has not already issued the same request.
          if (!timedOut) {
            attemptStopOnTimeout(workflowService, errorRunId, "timed out");
          }
          return buildErrorReturn({
            errorRunId,
            status: "timeout",
            errorMessage: `Workflow execution timed out or was aborted: ${workflow_name}`,
            durationMs,
          });
        }

        // Safe logging - don't throw if logger is not available. We log
        // the FULL raw error (forensic value) but only the SANITIZED +
        // CAPPED message goes into the tool result (LLM-facing).
        if (logger?.error) {
          logger.error(`Failed to run workflow: ${workflow_name}`, {
            error: rawErrorMessage,
            errorClassification,
            // we intentionally do NOT log the input or env here
          });
        }

        // Compose the final user-visible error. We always include the
        // classification tag (so the LLM can distinguish empty / non-error
        // / object cases) and the sanitized + capped message. The runId
        // is appended later by buildErrorReturn.
        const composed = rawErrorMessage.length > 0
          ? `Failed to run workflow ${workflow_name}: ${sanitizedMessage} ${errorClassification}`
          : `Failed to run workflow ${workflow_name} ${errorClassification}: ${sanitizedMessage}`;

        return buildErrorReturn({
          errorRunId,
          status: "failed",
          errorMessage: capErrorLength(composed),
          durationMs,
        });
      }
    },
  };

  const runner = new RunWorkflowToolRunner(tool.execute);

  /**
   * Task #2144 — wrap the runner's execute with detach-on-success.
   *
   * Task #2190 — PRE-execution attach is now done INSIDE the inner execute
   * (right after `synthFallbackRunId()`), so the wrapper is mostly a
   * pass-through. We still keep the detach-on-success hook here because:
   * - The wrapper has access to `result.success` and `result.metadata.run_id`
   * - On success path we should clear the registry entry so a later
   *   stop_task doesn't try to stopRun an already-completed workflow.
   * - Failure/timeout/error paths intentionally keep the registration
   *   so propagateStopToWorkflowRuns can clean up via stopRun.
   *
   * The wrapper delegates to a dedicated `RunWorkflowLifecycleTracer` which
   * emits the `workflow.run-tool.pre-attach` span (covers the attach /
   * replace / detach three-phase orchestration). The inner
   * `RunWorkflowToolRunner` continues to emit `workflow.run-workflow-tool.execute`.
   *
   * No hooks / no bgTaskId → the inner execute still short-circuits the
   * PRE-attach path (it checks `getCurrentBgTaskId()` itself), preserving
   * the byte-identical main-session behavior.
   */
  const wrappedExecute = async (
    args: Parameters<Tool["execute"]>[0],
    ctx: ToolContext
  ): Promise<ToolResult> => {
    const bgTaskId = getCurrentBgTaskId();
    const lifecycleTracer = new RunWorkflowLifecycleTracer(
      runner,
      bgTaskId,
      hooks,
    );
    return lifecycleTracer.execute(args, ctx);
  };

  return {
    ...tool,
    execute: wrappedExecute.bind({} as Tool),
  };
}

/**
 * Default workflow_run tool instance (lazy initialization)
 * This is a placeholder that should be replaced with the actual tool
 * created via createRunWorkflowTool(workflowService) in the application
 */
let _runWorkflowTool: Tool | null = null;
let _workflowService: WorkflowService | null = null;

/**
 * Initialize the workflow_run tool with a WorkflowService
 * 
 * @param workflowService - The WorkflowService instance
 */
export function initRunWorkflowTool(workflowService: WorkflowService): void {
  _workflowService = workflowService;
  _runWorkflowTool = createRunWorkflowTool(workflowService);
}

/**
 * Get the workflow_run tool instance
 * 
 * @throws Error if the tool has not been initialized
 */
export function getRunWorkflowTool(): Tool {
  if (!_runWorkflowTool || !_workflowService) {
    throw new Error(
      "workflow_run tool not initialized. Call initRunWorkflowTool(workflowService) first."
    );
  }
  return _runWorkflowTool;
}

/**
 * Reset the workflow_run tool (for testing)
 */
export function resetRunWorkflowTool(): void {
  _runWorkflowTool = null;
  _workflowService = null;
}

// Re-export the tool interface for type checking
export type RunWorkflowTool = ReturnType<typeof createRunWorkflowTool>;

/**
 * Backward-compatible alias: create a tool named "run-workflow" for existing consumers.
 * The old tool name "run-workflow" is deprecated in favor of "workflow_run".
 * 
 * @deprecated Use createRunWorkflowTool() which produces a tool named "workflow_run"
 */
export function createLegacyRunWorkflowTool(workflowService: WorkflowService): Tool {
  const tool = createRunWorkflowTool(workflowService);
  return {
    ...tool,
    name: "run-workflow",
  };
}
