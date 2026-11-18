import { describe, expect, test } from "bun:test";
import {
  CATEGORY_KEYS,
  computeInvocationHash,
  parseFailureIds,
  type Category,
} from "../capture-rd-pipeline-baseline";

describe("capture-rd-pipeline-baseline helpers", () => {
  test("computes an invocation hash from normalized command lines", () => {
    expect(computeInvocationHash(["  bun test  ", "bun --cwd packages/core run typecheck"]))
      .toBe(computeInvocationHash(["bun test", "bun --cwd packages/core run typecheck"]));
    expect(computeInvocationHash(["bun test"]))
      .not.toBe(computeInvocationHash(["bun test packages/core"]));
  });

  test("extracts stable test failure IDs from Bun output", () => {
    const output = [
      "packages/core/src/foo.test.ts:",
      "(fail) Foo > rejects invalid input [2.3ms]",
    ].join("\n");
    expect(parseFailureIds("test", output, 1)).toEqual([
      "test:packages/core/src/foo.test.ts:Foo_rejects_invalid_input:E_TEST_FAILURE",
    ]);
  });

  test("extracts lint warning IDs with file, rule, and line", () => {
    const output = "packages/cli/src/foo.ts:12:7  warning  Unexpected console  no-console";
    expect(parseFailureIds("lint", output, 0)).toEqual([
      "lint:packages/cli/src/foo.ts:no-console:12",
    ]);
  });

  test("extracts TypeScript diagnostic IDs", () => {
    const output = "packages/core/src/foo.ts(8,11): error TS2322: Type X is not assignable";
    expect(parseFailureIds("typecheck", output, 2)).toEqual([
      "typecheck:packages/core/src/foo.ts:TS2322:8",
    ]);
  });

  test("returns no failure ID for an unparseable capture so diff can fail closed", () => {
    expect(parseFailureIds("build", "", 1)).toEqual([]);
  });

  test("supports every baseline category", () => {
    const categories: Category[] = [...CATEGORY_KEYS];
    expect(categories).toEqual(["test", "lint", "typecheck", "build", "cli-smoke"]);
  });
});
