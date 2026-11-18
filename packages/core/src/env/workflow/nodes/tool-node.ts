/**
 * Tool Registry interface for looking up tools
 * Supports both the full ToolRegistration and simplified Tool interface
 */
export interface ToolRegistry {
  // Full registration interface (from ToolComponent)
  getTool?(name: string): ToolRegistration | undefined;
  // Simplified tool interface (from ToolNode's own interface)
  getToolByName?(name: string): Tool | undefined;
  hasTool?(name: string): boolean;
}

/**
 * Tool Registration interface (from ToolComponent)
 */
export interface ToolRegistration {
  tool: Tool;
  enabled: boolean;
  source?: string;
}

/**
 * Tool interface for execution
 */
export interface Tool {
  name: string;
  execute(input: any, context?: any): Promise<any>;
}

/**
 * Default tool execution timeout: 60 seconds.
 * Used when neither input.timeout nor config.timeout provides an override.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * Type guard: returns true iff v is a positive finite number.
 * Used to safely narrow `unknown` timeout values from input/config.
 */
function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Resolve the tool execution timeout (in milliseconds).
 *
 * Precedence: input.timeout > config.timeout > DEFAULT_TOOL_TIMEOUT_MS.
 * Only positive finite numbers are accepted — anything else falls through
 * to the next precedence level.
 */
function getToolTimeoutMs(
  input: unknown,
  config: Record<string, unknown> | undefined
): number {
  if (input && typeof input === 'object') {
    const inputTimeout = (input as { timeout?: unknown }).timeout;
    if (isPositiveNumber(inputTimeout)) {
      return inputTimeout;
    }
  }
  if (config && isPositiveNumber(config.timeout)) {
    return config.timeout as number;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * 脱敏用的尾部窗口余量。
 *
 * 只保留尾部 300 字符，但 token 可能跨在边界上；先取 `tail + slack` 再脱敏，
 * 既能完整匹配跨界 token，又不必对几 MB 的 stdout 全量跑正则。
 */
const REDACT_TAIL_SLACK = 4096;

/** 对 `text` 的尾部 `tailChars` 字符做脱敏（带窗口余量，避免切断 token）。 */
function redactTail(text: string, tailChars: number): string {
  const window =
    text.length > tailChars + REDACT_TAIL_SLACK
      ? text.slice(-(tailChars + REDACT_TAIL_SLACK))
      : text;
  return redactCommandSecrets(window).trim().slice(-tailChars).trim();
}

/**
 * 对 Error 对象脱敏。
 *
 * Task #4419：`engine.ts` 在 AFTER_NODE hook 里取的是 `error.message`，会被
 * 原样写进 `workflow.node.end` → session → 下一轮 LLM context。工具 `throw`
 * 出来的 Error（`new Error(stderr)` 之类）同样可能带着命令行 / 凭据，所以
 * 不能只脱敏字符串分支。
 *
 * 保持 `name` / `stack` / 原始错误链（`cause`），尽量不破坏定位能力。
 */
function redactErrorForOutput(err: Error): Error {
  const message = redactCommandSecrets(err.message);
  const stack = typeof err.stack === 'string' ? redactCommandSecrets(err.stack) : undefined;
  if (message === err.message && stack === err.stack) return err;
  const clone = new Error(message, { cause: err });
  clone.name = err.name;
  if (stack) clone.stack = stack;
  return clone;
}

/**
 * Task #4392 P0-2: Build an actionable error message for a non-zero exit code
 * that came back with **no stderr**.
 *
 * Before this helper, the message was the bare `Tool exited with code N`, so the
 * agent had no idea which command failed or what it printed. #4385 measured 27
 * occurrences of `exit 2` in the workflow-creator sessions where the only
 * surviving evidence was the raw `workflow.node.end` message.
 *
 * The message is intentionally single-line and bounded in size:
 *   `Tool exited with code 2 | command: cd /tmp && ./x.sh --python cp312… |
 *    stdout tail: FATAL: nothing to validate`
 *
 * Secrets (inline `--password=...`, `TOKEN=...`) are masked before inclusion.
 *
 * @param exitCode - The non-zero exit code reported by the tool.
 * @param md - The tool's metadata object (may carry `stdout`).
 * @param toolInput - The resolved tool input (usually `{ command }`).
 */
function buildExitCodeError(
  exitCode: number,
  md: Record<string, unknown>,
  toolInput?: unknown
): string {
  const parts: string[] = [`Tool exited with code ${exitCode}`];

  const rawCommand =
    toolInput && typeof toolInput === 'object'
      ? (toolInput as { command?: unknown; cmd?: unknown }).command ??
        (toolInput as { cmd?: unknown }).cmd
      : undefined;

  if (typeof rawCommand === 'string' && rawCommand.trim().length > 0) {
    const safe = summarizeCommand(redactCommandSecrets(rawCommand));
    if (safe.length > 0) {
      parts.push(`command: ${safe}`);
    }
  }

  // Task #4419 (#4417 §B-2): stdout is attacker-adjacent content — a failing
  // script may echo the very request that carried the credential (`set -x`,
  // `curl -v`, ORM query logs, `docker build` output). Redact *before* slicing
  // the tail so a credential straddling the 300-char boundary is still fully
  // matched by the regex (slicing first could cut a token in half and let the
  // remainder through unmatched).
  const stdout = typeof md.stdout === 'string' ? md.stdout : '';
  // Task #4419 (§B-2 channel 1): redact a bounded tail window, not the whole
  // stdout. Redacting the full buffer is O(size) even when megabytes of output
  // are irrelevant (only 300 chars are kept), while slicing first could cut a
  // token in half and let its tail through unmatched. 4 KB of slack covers any
  // realistic token straddling the boundary.
  const stdoutTail = redactTail(stdout, 300);
  parts.push(stdoutTail.length > 0 ? `stdout tail: ${stdoutTail}` : '(no stdout)');

  return parts.join(' | ');
}

/**
 * ToolNode executes a registered Tool with the provided input.
 * 
 * Input can contain template strings like {{nodeId.output.path}} that will be
 * resolved from previousOutputs via TemplateResolver.
 */
export class ToolNode implements Node {
  readonly type = 'tool';
  readonly id: string;
  
  constructor(
    private definition: NodeDefinition,
    private toolRegistry: ToolRegistry
  ) {
    this.id = definition.id;
  }
  
  @TracedAs('workflow.tool.execute')
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const startTime = Date.now();
    
    try {
      // 1. Get tool name from definition.config.tool or config.toolName
      const toolName = (this.definition.config?.tool ?? this.definition.config?.toolName) as string | undefined;
      
      if (!toolName) {
        throw new Error('Tool name is required. Please specify config.tool or config.toolName in the node definition.');
      }
      
      // 2. Look up tool from registry (support both interfaces)
      let tool: Tool | undefined;
      
      if (this.toolRegistry.getTool) {
        // getTool may return ToolRegistration or Tool depending on implementation
        const result = this.toolRegistry.getTool(toolName);
        if (!result) {
          throw new Error(`Tool not found: ${toolName}`);
        }
        // Check if result has .tool property (ToolRegistration) or is a Tool directly
        if ('tool' in result) {
          tool = (result as ToolRegistration).tool;
        } else {
          tool = result as Tool;
        }
      } else if (this.toolRegistry.getToolByName) {
        // Simplified interface: getToolByName returns Tool directly
        tool = this.toolRegistry.getToolByName(toolName);
      }
      
      if (!tool) {
        throw new Error(`Tool not found: ${toolName}`);
      }
      
      // 3. Prepare input (may reference previous outputs and workflow input)
      // Support multiple formats:
      // - config.input: { param1: value1, param2: value2 }
      // - config.args: { param1: value1, param2: value2 } (alias)
      // - config.command: "string command" (for tools like bash that use command field)
      // - config.message: "string message" (for tools like echo that use message field)
      // 
      // Use pre-resolved config from context if available (avoids duplicate resolution)
      // Falls back to raw config for backward compatibility
      const config = context.resolvedConfig ?? (this.definition.config || {});
      const rawInput = config.input ?? config.inputs ?? config.args;
      const rawCommand = config.command;
      const rawMessage = config.message;
      
      // P3-5: Avoid double resolution - if resolvedConfig is used, values are already resolved
      const hasResolvedConfig = context.resolvedConfig !== undefined;
      
      let input: any;
      
      if (rawCommand !== undefined) {
        // Special case: single command parameter (e.g., bash tool)
        // Use pre-resolved value if available, otherwise resolve
        input = { 
          command: hasResolvedConfig
            ? rawCommand
            : (context.templateResolver 
                ? context.templateResolver.resolveValue(rawCommand)
                : rawCommand)
        };
      } else if (rawMessage !== undefined) {
        // Special case: single message parameter (e.g., echo tool)
        // Use pre-resolved value if available, otherwise resolve
        input = { 
          message: hasResolvedConfig
            ? rawMessage
            : (context.templateResolver 
                ? context.templateResolver.resolveValue(rawMessage)
                : rawMessage)
        };
      } else if (rawInput !== undefined) {
        // Normal case: multiple parameters object
        // Use pre-resolved value if available, otherwise resolve
        input = hasResolvedConfig
          ? rawInput
          : (context.templateResolver
              ? context.templateResolver.resolveValue(rawInput)
              : rawInput);
      } else {
        // No input specified
        input = {};
      }
      
      // 4. Shell escaping for bash commands
      // When template resolution produces content with newlines, quotes, backticks,
      // dollar signs etc. (e.g., echo "{{generate}}"), the raw content breaks shell
      // execution. Escape the content inside echo "..." for safe shell execution.
      if (toolName === 'bash' && typeof input.command === 'string') {
        // Trim trailing newlines (YAML pipe | adds one)
        const trimmed = input.command.replace(/\n+$/, '');
        
        // Check if it's an echo "..." pattern — content inside double quotes.
        // IMPORTANT: single line only — multi-line scripts starting with `echo "..." && \`
        // must NOT be matched, otherwise the whole script gets shell-escaped as a literal.
        const echoMatch = trimmed.match(/^echo\s+"([^\n\r]*)"\s*$/);
        if (echoMatch) {
          // Escape shell-special characters inside the double-quoted string
          let inner = echoMatch[1];
          inner = inner.replace(/\\/g, '\\\\');
          inner = inner.replace(/"/g, '\\"');
          inner = inner.replace(/\$/g, '\\$');
          inner = inner.replace(/\`/g, '\\\`');
          inner = inner.replace(/\n/g, '\\n');
          input.command = 'echo "' + inner + '"';
        }
      }
      
      // 5. Execute tool
      // Try to pass context if the tool supports it, otherwise just pass input
      let output: any;
      try {
        // First try with context (for tools that expect it)
        // Task #1837: runId == sessionId (runId natively carries workflow_ prefix).
        // No need to derive `workflow_${runId}` — context.sessionId is already
        // the canonical identifier. Fallback to context.runId for legacy callers
        // that may still set only the runId field.
        const toolContext = {
          session_id: context.sessionId || context.runId,
          message_id: context.nodeId,
          metadata: {
            workflowRunId: context.runId,
            workflowName: context.workflowName,
            nodeId: context.nodeId,
          },
        };
        
        // Execute tool with timeout to detect hanging
        // Allow override via input.timeout (preferred) or config.timeout (fallback)
        const toolTimeoutMs = getToolTimeoutMs(input, config);
        const executePromise = tool.execute(input, toolContext as any);
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(
              `Tool '${toolName}' execution timeout after ${Math.round(toolTimeoutMs / 1000)} seconds`
            )),
            toolTimeoutMs
          );
        });
        try {
          output = await Promise.race([executePromise, timeoutPromise]);
        } finally {
          // Clear the timeout handle so we don't leak an unneeded timer when
          // the tool resolves/rejects before its allotted time.
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }
        }
      } catch (toolError) {
        // If tool doesn't support context parameter, retry with just input
        if (toolError instanceof TypeError && toolError.message.includes('context') && toolError.message.includes('not a function')) {
          output = await tool.execute(input);
        } else {
          throw toolError;
        }
      }
      
      // Extract output from wrapper format if present.
      // NOTE: ToolNode intentionally does NOT apply output truncation
      // here. Workflow nodes are a raw JSON data layer — truncating a
      // tool's raw output here would corrupt downstream templating
      // (e.g. `{{nodes.foo.output}}` resolving to a truncated banner
      // instead of the actual data). The proper truncation moment is
      // when tool output enters the LLM context, which is owned by
      // AgentComponent's Path A (`isExtraTool`) and Path B
      // (`no-ToolComponent` fallback) — see
      // `agent-component.tool-truncation-bypass.test.ts` and the
      // regression test `tool-node-to-agent-end-to-end-truncation.test.ts`.
      const extractedOutput = this.extractFromWrapper(output);
      
      // Task #2900 P0-A: surface bash tool's {success:false, error:"..."} wrapper
      // so executor sees result.error !== undefined and engine.ts:1675
      // validateAndExecute() correctly skips markCompleted() on failure.
      // Without this, bash failures were silently swallowed as "completed".
      //
      // Task #4392 P0-2: pass the *resolved* input so that a bare exit code can
      // be enriched with the command that actually ran (and its stdout tail).
      const wrapperError = this.extractErrorFromWrapper(output, input);
      
      return {
        output: extractedOutput,
        error: wrapperError,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        output: undefined,
        // Task #4419: 抛出的异常同样会进 workflow.node.end（取 .message），
        // 不能只覆盖 extractErrorFromWrapper 的字符串分支
        error:
          error instanceof Error
            ? redactErrorForOutput(error)
            : new Error(redactCommandSecrets(String(error))),
        durationMs: Date.now() - startTime,
      };
    }
  }
  
  /**
   * Extract the actual output value from wrapper formats.
   * For strings, removes trailing whitespace (especially newlines from bash commands).
   */
  private extractFromWrapper(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value !== 'object') {
      return value;
    }
    let result: unknown;
    if ('output' in value) {
      result = (value as { output: unknown }).output;
    } else if ('result' in value && !('output' in value)) {
      result = (value as { result: unknown }).result;
    } else {
      return value;
    }
    // For string results from tools (like bash), trim trailing whitespace
    // This prevents double newlines when embedding in shell commands
    if (typeof result === 'string') {
      return result.trimEnd();
    }
    return result;
  }

  /**
   * Task #2900 P0-A: Extract error from wrapper format if tool reports failure.
   *
   * Returns the tool's `error` field (string | Error) when `success === false`
   * is present in the wrapper, so that executor.executeWithTimeout() can
   * propagate it as NodeExecutionResult.error. Without this, bash failures
   * silently produced output="" + status=completed in the engine.
   *
   * Returns undefined when:
   *   - value is not an object
   *   - success === true (or success field is missing)
   *   - wrapper has no error string
   *
   * Task #4392 P0-2: when the wrapper signals a non-zero `exit_code` but carries
   * no stderr, the bare `Tool exited with code N` message is useless on its own
   * (#4385 measured 27 such `exit 2` occurrences in the creator sessions, and
   * 291 failed runs whose `session.metadata.error` was null). We therefore append
   * the (redacted, single-line, truncated) command plus a stdout tail.
   */
  private extractErrorFromWrapper(
    value: unknown,
    toolInput?: unknown
  ): string | Error | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (typeof value !== 'object') {
      return undefined;
    }
    const obj = value as Record<string, unknown>;
    // Only treat as failure when the wrapper explicitly signals success=false.
    // Many tools (echo, file-read, etc.) don't return a success flag at all
    // and we must NOT regress them by treating absence-of-success as failure.
    if (obj.success !== false) {
      return undefined;
    }
    // Tool declared failure — surface the error message.
    //
    // Task #4419 (#4417 §B-2): for the bash wrapper, `error` is the tool's
    // stderr, i.e. real-world output of a failing command — it routinely
    // contains the echoed request line (`curl -v`, `set -x`), a URL with
    // `?token=`, or `mysql -p<password>`. This is the branch that actually
    // reaches `workflow.node.end`, so it must be redacted. A clean message is
    // returned unchanged, keeping the loud-failure behaviour.
    const err = obj.error;
    if (typeof err === 'string' && err.length > 0) {
      return redactCommandSecrets(err);
    }
    if (err instanceof Error) {
      // Task #4419: 工具 throw 的 Error 同样会经 engine.ts:1963 的
      // `error.message` 进入 workflow.node.end，必须一起脱敏
      return redactErrorForOutput(err);
    }
    // Fallback: synthesize from metadata so consumers can still detect failure
    const md = obj.metadata as Record<string, unknown> | undefined;
    if (md) {
      if (md.timed_out === true) {
        const ms = typeof md.execution_time_ms === 'number' ? md.execution_time_ms : 0;
        return `Tool execution timed out after ${ms}ms`;
      }
      if (typeof md.exit_code === 'number' && md.exit_code !== 0) {
        // Task #4419 (#4417 §B-2): the stderr-preferred branch returns *before*
        // buildExitCodeError (which does redact), so stderr used to reach the
        // session/LLM context verbatim. Redact here too; a clean stderr passes
        // through unchanged, preserving the loud-failure behaviour.
        const stderr = typeof md.stderr === 'string' ? md.stderr : '';
        return stderr.length > 0
          ? redactCommandSecrets(stderr)
          : buildExitCodeError(md.exit_code, md, toolInput);
      }
    }
    return `Tool execution failed (success=false, no error message)`;
  }

}

// Re-export types from workflow types
import type { Node, NodeDefinition, NodeExecutionContext, NodeExecutionResult } from '../types';
import { TracedAs } from '../../log-trace/decorator';
import { redactCommandSecrets, summarizeCommand } from '../utils/redact-command-secrets';
