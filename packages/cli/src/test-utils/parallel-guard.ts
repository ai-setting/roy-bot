/**
 * Ink parallel test guard.
 *
 * Under `bun test --parallel 4`, ink's `render()` and `<Static>` share
 * process-wide state (stdout, virtual terminal) and 232 .tsx tests
 * cause race conditions. Each ink render test can opt out by wrapping
 * itself in `describe.skipIf(isParallelRun)(...)`.
 *
 * Reference: global memory chapter "Bun Test 并发加速".
 */
export const isParallelRun = "BUN_TEST_WORKER_ID" in (process.env ?? {});
