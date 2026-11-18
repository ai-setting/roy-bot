import { describe, expect, test } from "bun:test";
import {
  CATEGORY_KEYS,
  diffBaselineVsModified,
  type BaselineCaptured,
} from "../verify-rd-pipeline-baseline";

const makeCapture = (
  overrides: Partial<BaselineCaptured> = {},
): BaselineCaptured => ({
  schema: "roy-rd-pipeline-baseline/v1",
  stage: "tdd",
  task_id: 2121,
  captured_at: "2026-07-17T00:00:00.000Z",
  invocation_hash: "hash-same",
  worktree_path: "/tmp/worktree",
  command_lines: ["bun test packages/core --parallel 4"],
  failures: Object.fromEntries(CATEGORY_KEYS.map((category) => [category, []])),
  pass_counts: Object.fromEntries(CATEGORY_KEYS.map((category) => [category, 0])),
  exit_codes: Object.fromEntries(CATEGORY_KEYS.map((category) => [category, 0])),
  log_tail: Object.fromEntries(CATEGORY_KEYS.map((category) => [category, []])),
  ...overrides,
});

const withFailures = (
  capture: BaselineCaptured,
  category: keyof BaselineCaptured["failures"],
  failures: string[],
  exitCode = 1,
): BaselineCaptured => ({
  ...capture,
  failures: { ...capture.failures, [category]: failures },
  exit_codes: { ...capture.exit_codes, [category]: exitCode },
});

describe("diffBaselineVsModified", () => {
  test("passes identical failure sets, including non-zero pre-existing failures", () => {
    const baseline = withFailures(makeCapture(), "test", ["test:a.ts:symbol:1"]);
    const modified = withFailures(makeCapture(), "test", ["test:a.ts:symbol:1"]);
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(true);
    expect(result.new_regressions.test).toEqual([]);
    expect(result.unchanged.test).toEqual(["test:a.ts:symbol:1"]);
  });

  test("passes when modified is a strict subset of baseline", () => {
    const baseline = withFailures(makeCapture(), "test", ["test:a.ts:a:1", "test:b.ts:b:2"]);
    const modified = withFailures(makeCapture(), "test", ["test:a.ts:a:1"]);
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(true);
    expect(result.fixed_pre_existing.test).toEqual(["test:b.ts:b:2"]);
  });

  test("fails only for a new test failure", () => {
    const baseline = withFailures(makeCapture(), "test", ["test:a.ts:a:1"]);
    const modified = withFailures(makeCapture(), "test", ["test:a.ts:a:1", "test:new.ts:new:9"]);
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(false);
    expect(result.new_regressions.test).toEqual(["test:new.ts:new:9"]);
  });

  test("fails for a new lint warning", () => {
    const baseline = makeCapture();
    const modified = withFailures(makeCapture(), "lint", ["lint:src/a.ts:no-console:4"]);
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(false);
    expect(result.new_regressions.lint).toEqual(["lint:src/a.ts:no-console:4"]);
  });

  test("fails for a new typecheck error", () => {
    const baseline = makeCapture();
    const modified = withFailures(makeCapture(), "typecheck", ["typecheck:src/a.ts:TS2322:8"]);
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(false);
    expect(result.new_regressions.typecheck).toEqual(["typecheck:src/a.ts:TS2322:8"]);
  });

  test("fails for a new CLI smoke failure", () => {
    const baseline = makeCapture();
    const modified = withFailures(makeCapture(), "cli-smoke", ["cli-smoke:roy-bot:help:E_EXIT_1"]);
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(false);
    expect(result.new_regressions["cli-smoke"]).toEqual([
      "cli-smoke:roy-bot:help:E_EXIT_1",
    ]);
  });

  test("fails closed when invocation command sets drift", () => {
    const baseline = makeCapture();
    const modified = makeCapture({ invocation_hash: "hash-different" });
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(false);
    expect(result.reasons_for_fail).toContain("command_set_drift");
  });

  test("fails closed when a category is missing from modified capture", () => {
    const baseline = makeCapture();
    const modified = makeCapture({
      failures: { ...makeCapture().failures, lint: undefined as unknown as string[] },
    });
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(false);
    expect(result.reasons_for_fail).toContain("missing_category:lint");
  });

  test("fails closed when capture exits non-zero without a stable failure ID", () => {
    const baseline = makeCapture();
    const modified = makeCapture({
      exit_codes: { ...makeCapture().exit_codes, test: 2 },
      failures: { ...makeCapture().failures, test: [] },
    });
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(false);
    expect(result.reasons_for_fail).toContain("capture_status_invalid:test");
  });

  test("fails closed when worktree changes between captures", () => {
    const baseline = makeCapture();
    const modified = makeCapture({ worktree_path: "/tmp/another-worktree" });
    const result = diffBaselineVsModified(baseline, modified);

    expect(result.pass).toBe(false);
    expect(result.reasons_for_fail).toContain("worktree_drift");
  });
});
