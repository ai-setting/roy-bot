/**
 * True ink REPL E2E test for Task #2297.
 *
 * The runner is spawned in a fresh Bun process. This is intentional: several
 * historical ESC tests use Bun's global mock.module() for core's
 * cascadeStopSessionTree; running the real path in a child prevents those
 * test doubles from changing this integration test's behavior when the whole
 * commands directory runs in parallel.
 *
 * The child runner renders the real REPLInk component with
 * ink-testing-library, drives query text + Enter + ESC bytes, and uses the
 * production REPL.start() -> startInk() callback chain.
 */

import { describe, test, expect } from "bun:test";

const runnerPath = new URL(
  "./interactive-ink-escape-e2e-task-2297.runner.tsx",
  import.meta.url,
).pathname;

async function runRealInkRunner(): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn({
    cmd: [process.execPath, runnerPath],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: await stdoutPromise,
    stderr: await stderrPromise,
  };
}

describe("real ink REPL ESC → cascade stop (Task #2297)", () => {
  test("starts Ink, submits a query, and ESC aborts the in-flight cascade", async () => {
    const result = await runRealInkRunner();

    // Keep the complete child output available in the assertion failure; it
    // contains the structured cascade log and is useful for diagnosing PTY/
    // Ink regressions.
    expect(
      result.exitCode,
      `real Ink runner failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain("TASK2297_REAL_INK_E2E_PASS");
    expect(result.stdout).toContain('"abortCount":1');
    expect(result.stdout).toContain('"streamAborted":true');
    expect(result.stdout).toContain('"isExecuting":false');
    expect(result.stdout).toContain("task-2297-child-session");
  });
});
