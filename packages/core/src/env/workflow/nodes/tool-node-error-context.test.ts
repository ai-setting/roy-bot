/**
 * @fileoverview TDD RED — ToolNode error messages must carry enough context to
 * diagnose the failure without a trace lookup (Task #4392 P0-2).
 *
 * Module under test: `packages/core/src/env/workflow/nodes/tool-node.ts`
 *
 * Background (Task #4385 §3.7 / §5.5 diff-1):
 *   When a bash tool exits non-zero **with an empty stderr**, `extractErrorFromWrapper`
 *   synthesizes the bare string `Tool exited with code N`. The command that was run
 *   and the stdout that the script produced are both discarded, so the agent (and the
 *   human reading `workflow.node.end`) sees only "exit code 2" with zero context.
 *
 *   Measured impact in #4385: 27 occurrences of `exit 2` in the creator sessions,
 *   plus 291 failed runs whose `session.metadata.error` was `null` — the only place
 *   the real reason survived was the raw `workflow.node.end` message.
 *
 * Contract after GREEN:
 *   1. Empty stderr + non-zero exit → error message MUST contain
 *      (a) the exit code, (b) a normalized/truncated form of the command,
 *      (c) the tail of stdout (or an explicit "(no stdout)" marker).
 *   2. Non-empty stderr is still preferred over the synthesized message — no
 *      regression for the loud-failure case — but it is **redacted** first
 *      (Task #4419): a failing command echoes its own request line (`set -x`,
 *      `curl -v`), so stderr is just as credential-bearing as stdout.
 *   3. Secrets are masked: the command shown in the error must go through the same
 *      redaction used elsewhere, or at minimum must not leak `PASSWORD=...` style
 *      values. (Asserted via the shared redact helper's behaviour.)
 */

import { describe, it, expect } from "bun:test";
import { ToolNode, type Tool, type ToolRegistry } from "./tool-node";
import type { NodeDefinition, NodeExecutionContext } from "../types";

// =============================================================================
// Helpers
// =============================================================================

type Exec = (input: any, context?: any) => Promise<any>;

function makeRegistry(execute: Exec): ToolRegistry {
  const tool: Tool = { name: "bash", execute } as unknown as Tool;
  return {
    getTool: (_name: string) => ({ tool, enabled: true, source: "test" }),
    hasTool: (_name: string) => true,
  } as unknown as ToolRegistry;
}

function makeContext(command: string): NodeExecutionContext {
  return {
    runId: "test-run",
    sessionId: "test-run",
    workflowName: "test-wf",
    nodeId: "broken-node",
    input: {},
    previousOutputs: new Map(),
    nodeOutputs: new Map(),
    abortSignal: new AbortController().signal,
    config: { tool: "bash", command },
    resolvedConfig: { tool: "bash", command },
  } as unknown as NodeExecutionContext;
}

function makeDefinition(): NodeDefinition {
  return {
    id: "broken-node",
    type: "tool",
    name: "BROKEN",
    config: { tool: "bash", command: "true" },
  } as unknown as NodeDefinition;
}

function execWith(registry: ToolRegistry, command: string) {
  const node = new ToolNode(makeDefinition(), registry);
  return node.execute(makeContext(command));
}

/** Builds the exact wrapper shape the real bash tool returns on failure. */
function bashFailure(exitCode: number, stdout: string, stderr: string) {
  return {
    success: false,
    output: stdout.length > 0 ? stdout : "(no output)",
    error: stderr.length > 0 ? stderr : undefined,
    metadata: { exit_code: exitCode, stderr, stdout, timed_out: false },
  };
}

// =============================================================================
// RED Tests
// =============================================================================

describe("ToolNode: exit-code failure must carry command + stdout context (Task #4392 P0-2)", () => {
  it("RED: empty stderr → error contains exit code, command and stdout tail", async () => {
    const registry = makeRegistry(async () => {
      // Mirrors `/bin/sh: 1: set: Illegal option -o pipefail` style silent failure:
      // the tool swallows stderr, so we must reconstruct context ourselves.
      return bashFailure(
        2,
        "checking wheels...\nfound 0 wheel\nFATAL: nothing to validate",
        ""
      );
    });

    const result = await execWith(
      registry,
      "cd /tmp/wheels && ./validate.sh --python cp312"
    );

    expect(result.error).toBeDefined();
    const msg =
      result.error instanceof Error ? result.error.message : String(result.error);

    // (a) exit code preserved
    expect(msg).toContain("2");
    // (b) command context present (normalized whitespace, truncated)
    expect(msg).toContain("validate.sh");
    expect(msg).toContain("cp312");
    // (c) stdout tail present — this is what actually localizes the bug
    expect(msg).toContain("FATAL: nothing to validate");
  });

  it("RED: empty stderr AND empty stdout → explicit '(no stdout)' marker, still has command", async () => {
    const registry = makeRegistry(async () => bashFailure(1, "", ""));

    const result = await execWith(registry, "some-silent-script");

    const msg =
      result.error instanceof Error ? result.error.message : String(result.error);
    expect(msg).toContain("1");
    expect(msg).toContain("some-silent-script");
    expect(msg.toLowerCase()).toContain("no stdout");
  });

  it("RED: non-empty stderr is still preferred verbatim (no regression)", async () => {
    const registry = makeRegistry(async () =>
      bashFailure(2, "some stdout", "/bin/sh: 1: set: Illegal option -o pipefail")
    );

    const result = await execWith(registry, "set -o pipefail; ./x.sh");

    const msg =
      result.error instanceof Error ? result.error.message : String(result.error);
    // The loud case must NOT be decorated into something unrecognizable:
    // consumers match on the raw stderr signature (see #4385 §3.2).
    expect(msg).toContain("Illegal option -o pipefail");
  });

  it("RED: very long command is truncated (<= ~200 chars total) so error stays readable", async () => {
    const longCmd = `echo ${"x".repeat(2000)}`;
    const registry = makeRegistry(async () => bashFailure(3, "out", ""));

    const result = await execWith(registry, longCmd);

    const msg =
      result.error instanceof Error ? result.error.message : String(result.error);
    expect(msg.length).toBeLessThan(1000);
    expect(msg).toContain("3");
  });

  it("RED: multiline command is collapsed to a single readable line", async () => {
    const registry = makeRegistry(async () => bashFailure(4, "boom", ""));
    const multiline = "line-one\n  line-two\n\tline-three";

    const result = await execWith(registry, multiline);

    const msg =
      result.error instanceof Error ? result.error.message : String(result.error);
    expect(msg).toContain("line-one");
    // Newlines inside the command excerpt would break one-line log rendering.
    expect(msg.split("\n").length).toBe(1);
  });

  it("RED: secrets in the command are masked in the error message", async () => {
    const registry = makeRegistry(async () => bashFailure(7, "auth failed", ""));

    const result = await execWith(
      registry,
      "twine upload --password=s3cr3t-token dist/*.whl"
    );

    const msg =
      result.error instanceof Error ? result.error.message : String(result.error);
    expect(msg).toContain("twine");
    expect(msg).not.toContain("s3cr3t-token");
  });
});

// =============================================================================
// Task #4419 (from #4417 §B-2) — stdout tail / stderr must ALSO be redacted
//
// Why: this error message flows into `workflow.node.end` → session messages →
// the next turn's LLM context. A single failing `curl -H "Authorization: Bearer
// $TOKEN"` used to leave the real token in the conversation history, and such a
// leak defeats every static secret scanner (the commit really has no hardcoded
// key — the credential arrives at runtime).
//
// These two channels were introduced/reinforced by #4392 P0-2 without putting
// them through `redactCommandSecrets`:
//   1. `stdout tail:` built in `buildExitCodeError` (tool-node.ts:106-108).
//   2. the `stderr`-preferred early return in `extractErrorFromWrapper`
//      (tool-node.ts:408-411), which bypasses `buildExitCodeError` entirely.
// =============================================================================

const S = "SEKRET_";
const leakRe = new RegExp(`${S}\\w+`, "g");

function msgOf(result: { error?: unknown }): string {
  const e = result.error;
  return e instanceof Error ? e.message : String(e ?? "");
}

describe("ToolNode: stdout tail is redacted (§B-2 channel 1)", () => {
  it("RED: token echoed on stdout must not survive in the stdout tail", async () => {
    const registry = makeRegistry(async () =>
      // A `set -x`-style script echoed the request before failing.
      bashFailure(
        1,
        'curl -H "Authorization: Bearer SEKRET_stdout_tok1" https://api.example.com/v1\nFATAL: 401 Unauthorized',
        ""
      )
    );

    const result = await execWith(registry, "curl -H \"Authorization: Bearer SEKRET_cmd_tok0\" https://api.example.com/v1");
    const msg = msgOf(result);

    expect(msg.match(leakRe) ?? []).toEqual([]);
    // Diagnostics must survive — we only mask the credential.
    expect(msg).toContain("FATAL: 401 Unauthorized");
  });

  it("RED: URL query + mysql password on stdout are masked", async () => {
    const registry = makeRegistry(async () =>
      bashFailure(
        2,
        "connecting mysql -pSEKRET_stdout_db1 ...\nfetch https://api.example.com/v1?api_key=SEKRET_stdout_k2 failed",
        ""
      )
    );

    const msg = msgOf(await execWith(registry, "./run.sh"));
    expect(msg.match(leakRe) ?? []).toEqual([]);
    expect(msg).toContain("connecting mysql");
  });

  it("RED: stderr-free failure with clean stdout keeps stdout context intact", async () => {
    const registry = makeRegistry(async () =>
      bashFailure(3, "step 1 ok\nstep 2 ok\nnothing sensitive here", "")
    );
    const msg = msgOf(await execWith(registry, "./run.sh"));
    expect(msg).toContain("nothing sensitive here");
    expect(msg).toContain("3");
  });
});

describe("ToolNode: stderr is redacted (§B-2 channel 2)", () => {
  it("RED: token in stderr must not survive the stderr-preferred branch", async () => {
    const registry = makeRegistry(async () =>
      bashFailure(
        1,
        "",
        'curl: (22) failed for https://api.example.com/v1?token=SEKRET_stderr_t1\nAuthorization: Bearer SEKRET_stderr_t2'
      )
    );

    const msg = msgOf(
      await execWith(registry, "curl https://api.example.com/v1?token=SEKRET_cmd_t3")
    );

    expect(msg.match(leakRe) ?? []).toEqual([]);
    // The actual diagnostic must remain readable.
    expect(msg).toContain("curl: (22)");
    expect(msg).toContain("Authorization: Bearer");
  });

  it("RED: stderr with `curl -u user:pass` echo is masked", async () => {
    const registry = makeRegistry(async () =>
      // `set -x` echoes the expanded command line onto stderr — the classic
      // path by which `curl -u user:pass` ends up in the conversation history.
      bashFailure(
        7,
        "",
        "+ curl -u admin:SEKRET_stderr_pw9 https://x.com\nauth failed (401)"
      )
    );
    const msg = msgOf(await execWith(registry, "curl -u admin:SEKRET_cmd_pw8 https://x.com"));
    expect(msg.match(leakRe) ?? []).toEqual([]);
    expect(msg).toContain("auth failed (401)");
  });

  it("RED: identical-shape clean stderr is returned verbatim (no regression)", async () => {
    const clean = "fatal: repository 'https://github.com/x/y.git' not found";
    const registry = makeRegistry(async () => bashFailure(128, "", clean));
    const msg = msgOf(await execWith(registry, "git clone https://github.com/x/y.git"));
    expect(msg).toBe(clean);
  });
});

// =============================================================================
// R4 (re-review 2026-10-21) — Error 分支同样会进 workflow.node.end
// =============================================================================

describe("ToolNode: thrown / Error-object failures are redacted (§B-2 channel 3)", () => {
  it("★ `{success:false, error: Error}` → engine reads error.message; must be masked", async () => {
    const registry = makeRegistry(async () => ({
      success: false,
      output: "",
      error: new Error(
        "login failed: mysql -pSEKRET_err_pw1 user@db\nAuthorization: Bearer SEKRET_err_t2"
      ),
    }));

    const result = await execWith(registry, "mysql -pSEKRET_cmd_pw3");
    const err = result.error as Error;

    expect(err).toBeInstanceOf(Error);
    // 这就是 engine.ts:1963 写进 workflow.node.end 的字符串
    expect(err.message.match(leakRe) ?? []).toEqual([]);
    expect(err.message).toContain("login failed");
    // 原始错误对象保留在 cause 里，便于本地排查
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it("★ tool throws an Error → caught branch must be masked too", async () => {
    const registry = makeRegistry(async () => {
      throw new Error("boom: curl -H 'Authorization: Bearer SEKRET_throw_t1' failed");
    });

    const result = await execWith(registry, "curl https://x");
    const err = result.error as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message.match(leakRe) ?? []).toEqual([]);
    expect(err.message).toContain("boom");
  });

  it("clean Error passes through unchanged (identity preserved, no needless clone)", async () => {
    const original = new Error("fatal: repository not found");
    const registry = makeRegistry(async () => ({
      success: false,
      output: "",
      error: original,
    }));

    const result = await execWith(registry, "git clone https://github.com/x/y.git");

    expect(result.error).toBe(original);
  });
});
