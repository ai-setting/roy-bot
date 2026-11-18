/**
 * PythonCallNode - workflow node type that invokes a Python function via subprocess.
 *
 * Task #1998: 投资选股 workflow 解耦 CLI/bash 依赖
 *
 * Decouples workflows from hardcoded paths like:
 *   `~/work/.../.venv/bin/python scripts/foo.py --arg1`
 *
 * Instead, a workflow declares:
 *   ```yaml
 *   - id: market-timing
 *     type: python_call
 *     config:
 *       module: investment_strategy.scripts.market_timing
 *       function: run
 *       args:
 *         base_top_n: "{{input.base_top_n}}"
 *       cwd: /path/to/repo          # optional
 *       python: /usr/bin/python3   # optional, default: python3
 *       timeout: 60000              # optional, ms, default: 60000
 *   ```
 *
 * Execution model:
 *   - Spawn: `<python> -c "<source>"`
 *     where `<source>` imports the module, calls the function with the args,
 *     and prints the return value as JSON to stdout.
 *   - stdout is parsed as JSON if possible; otherwise returned as a string.
 *   - Non-zero exit → result.error is populated.
 *   - Timeout → kills subprocess and returns timeout error.
 *
 * Security (MVP):
 *   - Module must match the allow-list (default: `investment_strategy.*`).
 *   - Function name must be a bare identifier (regex /^[A-Za-z_]\w*$/).
 *   - This is a guard rail against arbitrary code execution — not a full sandbox.
 *     Workflow authors are trusted operators; the allow-list prevents accidental
 *     `module: os` / `module: subprocess` misuse.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { TracedAs } from '../../log-trace/decorator';
import type {
  Node,
  NodeDefinition,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../types';

/**
 * Allow-list configuration for Python module names.
 *
 * - `prefix`: each entry matches modules that start with `<entry>.` or equal `<entry>`.
 * - Default: `{ prefix: ['investment_strategy'] }`.
 *
 * Pass an empty `{ prefix: [] }` to disable (NOT recommended in production).
 */
export interface PythonCallAllowList {
  prefix: string[];
}

/**
 * Per-node constructor options.
 */
export interface PythonCallNodeOptions {
  allowList?: PythonCallAllowList;
  /**
   * Override spawn factory (for tests / Effect-based executors).
   * Signature mirrors `child_process.spawn`.
   */
  spawnFn?: typeof spawn;
}

/**
 * Static type for the `config` field of a python_call node.
 */
export interface PythonCallNodeConfig {
  module: string;
  function: string;
  args?: Record<string, unknown>;
  cwd?: string;
  python?: string;
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PYTHON = 'python3';

/**
 * Default allow-list: only `investment_strategy.*` modules.
 *
 * This is the safe default. Operators who want to run a different package
 * can pass `{ allowList: { prefix: ['my_pkg', 'investment_strategy'] } }`
 * to the constructor.
 */
const DEFAULT_ALLOW_LIST: PythonCallAllowList = {
  prefix: ['investment_strategy'],
};

/**
 * Identifier regex for Python function names.
 * Restricts to `[A-Za-z_][A-Za-z0-9_]*` — no dots, no operators.
 */
const FUNCTION_NAME_REGEX = /^[A-Za-z_]\w*$/;

/**
 * Python identifier regex for module names.
 * Allows dotted paths like `pkg.sub.mod`, each segment must be a valid identifier.
 */
const MODULE_NAME_REGEX = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

/**
 * Build the inline Python source that imports a module, calls a function with
 * the given JSON args, and prints the return value as JSON.
 *
 * The contract with the Python side:
 *   - The function may return: dict, list, str, int, float, bool, or None
 *   - Result is encoded as JSON via `json.dumps(..., ensure_ascii=False, default=str)`
 *     so non-trivial objects don't blow up.
 *   - Exit code 0 → success; non-zero → failure.
 *   - Exceptions → printed to stderr, exit code 1.
 */
function buildPythonSource(module: string, functionName: string): string {
  // The args dict is injected via a sentinel: we write it to a temp file
  // is overkill; instead, we pass via stdin pipe.
  // Source: import → call fn(**args) → json.dump result.
  return [
    'import sys, json, traceback',
    `_args = json.loads(sys.stdin.read() or "{}")`,
    `from ${module} import ${functionName} as _fn`,
    `try:`,
    `    _result = _fn(**_args)`,
    `    sys.stdout.write(json.dumps(_result, ensure_ascii=False, default=str))`,
    `    sys.stdout.write("\\n")`,
    `    sys.exit(0)`,
    `except Exception as _e:`,
    `    sys.stderr.write("".join(traceback.format_exception(type(_e), _e, _e.__traceback__)))`,
    `    sys.exit(1)`,
  ].join('\n');
}

/**
 * PythonCallNode — see file header for design.
 */
export class PythonCallNode implements Node {
  readonly type = 'python_call';
  readonly id: string;

  private readonly allowList: PythonCallAllowList;
  private readonly spawnFn: typeof spawn;

  constructor(
    private definition: NodeDefinition,
    options: PythonCallNodeOptions = {},
  ) {
    this.id = definition.id;
    this.allowList = options.allowList ?? DEFAULT_ALLOW_LIST;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /**
   * Validate that `module` is in the allow-list.
   * Returns null when OK, or an error message string.
   */
  private checkAllowList(module: string): string | null {
    if (!Array.isArray(this.allowList.prefix) || this.allowList.prefix.length === 0) {
      // Allow-list disabled — caller opted in.
      return null;
    }
    for (const prefix of this.allowList.prefix) {
      if (module === prefix || module.startsWith(prefix + '.')) {
        return null;
      }
    }
    return `Module "${module}" is not allowed by the python_call allow-list (allowed prefixes: ${this.allowList.prefix.join(', ')})`;
  }

  /**
   * Parse JSON emitted by the Python wrapper, including JSON-encoded strings.
   * If stdout is not valid JSON, preserve the raw output while removing only
   * trailing newlines.
   */
  private parseOutput(stdout: string): unknown {
    const trimmed = stdout.trim();
    if (trimmed === '') return '';

    try {
      // PythonCallNode serializes every return value with json.dumps, including
      // strings. Parse all valid JSON values so string results are not returned
      // with their serialization quotes.
      return JSON.parse(trimmed);
    } catch {
      return stdout.replace(/\n+$/, '');
    }
  }

  @TracedAs('workflow.python_call.execute')
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const startTime = Date.now();

    // Use pre-resolved config when available (avoids duplicate template resolution)
    const rawConfig = (context.resolvedConfig ?? this.definition.config ?? {}) as unknown as PythonCallNodeConfig;

    try {
      // ---- 1. Validate required fields ----
      const module = typeof rawConfig.module === 'string' ? rawConfig.module.trim() : '';
      const functionName = typeof rawConfig.function === 'string' ? rawConfig.function.trim() : '';
      const args = (rawConfig.args && typeof rawConfig.args === 'object' && !Array.isArray(rawConfig.args))
        ? (rawConfig.args as Record<string, unknown>)
        : {};
      const cwd = typeof rawConfig.cwd === 'string' && rawConfig.cwd ? rawConfig.cwd : undefined;
      const pythonBin = typeof rawConfig.python === 'string' && rawConfig.python ? rawConfig.python : DEFAULT_PYTHON;
      const timeoutMs = typeof rawConfig.timeout === 'number' && rawConfig.timeout > 0
        ? rawConfig.timeout
        : DEFAULT_TIMEOUT_MS;

      if (!module) {
        throw new Error(
          `PythonCallNode "${this.id}": config.module is required`,
        );
      }
      if (!functionName) {
        throw new Error(
          `PythonCallNode "${this.id}": config.function is required`,
        );
      }
      if (!MODULE_NAME_REGEX.test(module)) {
        throw new Error(
          `PythonCallNode "${this.id}": config.module "${module}" is not a valid Python module path`,
        );
      }
      if (!FUNCTION_NAME_REGEX.test(functionName)) {
        throw new Error(
          `PythonCallNode "${this.id}": config.function "${functionName}" is invalid (must match ${FUNCTION_NAME_REGEX})`,
        );
      }

      // ---- 2. Allow-list check ----
      const allowErr = this.checkAllowList(module);
      if (allowErr) {
        throw new Error(allowErr);
      }

      // ---- 3. Template-resolve args (if not already resolved) ----
      const hasResolvedConfig = context.resolvedConfig !== undefined;
      const resolvedArgs = hasResolvedConfig
        ? args
        : (context.templateResolver
            ? context.templateResolver.resolveValue(args)
            : args);

      // ---- 4. Build source & spawn ----
      const source = buildPythonSource(module, functionName);
      const child: ChildProcess = this.spawnFn(
        pythonBin,
        ['-c', source],
        {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        },
      );

      // ---- 5. Wire stdin (args) ----
      const payload = JSON.stringify(resolvedArgs);
      child.stdin?.end(payload);

      // ---- 6. Collect stdout / stderr with timeout ----
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const result = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        timedOut: boolean;
      }>((resolve, reject) => {
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const onClose = (code: number | null) => {
          if (timer) clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode: code,
            timedOut,
          });
        };

        const onError = (err: Error) => {
          if (timer) clearTimeout(timer);
          reject(err);
        };

        child.once('close', onClose);
        child.once('error', onError);

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            try {
              // Try to kill the process group first (POSIX), then the child itself
              if (typeof child.pid === 'number') {
                try {
                  process.kill(-child.pid, 'SIGTERM');
                } catch {
                  child.kill('SIGTERM');
                }
              } else {
                child.kill('SIGTERM');
              }
            } catch {
              // ignore kill errors
            }
            // Give it a brief grace period, then SIGKILL
            setTimeout(() => {
              if (!child.killed) {
                try {
                  child.kill('SIGKILL');
                } catch {
                  // ignore
                }
              }
            }, 200);
            // Surface the timeout as an error to the waiter
            reject(new Error(
              `PythonCallNode "${this.id}": execution timed out after ${Math.round(timeoutMs / 1000)}s`,
            ));
          }, timeoutMs);
        }
      });

      // ---- 7. Interpret result ----
      if (result.timedOut) {
        // Already rejected above; this branch is defensive
        throw new Error(
          `PythonCallNode "${this.id}": execution timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      }
      if (result.exitCode !== 0) {
        const stderrTail = result.stderr
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .slice(-20)
          .join('\n');
        throw new Error(
          `PythonCallNode "${this.id}": python exit code ${result.exitCode} (module=${module}, fn=${functionName})\n${stderrTail}`,
        );
      }

      const output = this.parseOutput(result.stdout);

      return {
        output,
        error: undefined,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        output: undefined,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs: Date.now() - startTime,
      };
    }
  }
}