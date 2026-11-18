/**
 * @fileoverview tasks list command - JSON output structure tests
 *
 * Regression coverage for the structural inconsistency between:
 *   - packages/core/src/env/task/tools/list-tool.ts  (FIXED in #1470)
 *   - packages/cli/src/commands/tasks/list.ts        (this file's TARGET)
 *
 * Both code paths construct their own JSON. The tool path already places
 * `total` first, includes a `truncated` flag, and echoes `depth`; the
 * CLI path previously placed `total` second, lacked `truncated`, and
 * lacked `depth` echo. These tests assert the CLI path now matches the
 * tool path.
 *
 * Tests verify:
 *   1. `total` is the FIRST key in the serialized JSON output
 *      (so it survives tail-truncation in any downstream consumer).
 *   2. `truncated` is true when total > count (pagination truncated data).
 *   3. `truncated` is false when total === count (no truncation).
 *   4. `tasks` is the LAST key in the serialized JSON output
 *      (so the array is the candidate for tail-truncation, not the metadata).
 *   5. (S-1) `buildListTasksJson` accepts `depth` and surfaces it in JSON.
 *   6. (S-1) Output key order is exactly:
 *        total, count, truncated, limit, offset, depth, tasks
 *      (Object.keys + JSON literal order both asserted).
 *   7. (S-1) CLI integration: `tasks list --depth 2 --json` output
 *      contains `"depth": 2`.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;

import yargs from "yargs";
import type { Task } from "@ai-setting/roy-bot-core";

// =============================================================================
// Module-level mocks for handler integration tests (Task #1951)
//
// These mocks let us invoke `ListCommand.handler(args)` directly without
// spinning up a real EnvironmentService (which would require a temp
// directory, in-memory session storage, real TaskComponent registration,
// etc.). The previous tests in the `Task #1943` block used
// `fs.readFileSync(... "list.ts")` to assert source-string patterns —
// brittle and silently broken by any cosmetic edit. The replacement
// tests at the bottom of this file exercise the actual runtime path:
//
//   - tests 1 & 2 use the REAL yargs parser driven by `ListCommand.builder`
//     to verify --graph and -g are registered (no source-string matching).
//   - test 3 invokes the real `ListCommand.handler` with mocked services
//     and verifies the runtime routing (`--graph` branch wins over `--json`).
//
// We use `mock.module()` (registered BEFORE the dynamic import of
// `./list` below) so the handler's `import { EnvironmentService }`
// binding picks up the mock when it does `new EnvironmentService(output)`.
// `_build-list-json` is NOT mocked — the existing JSON-structure tests
// need the real `buildListTasksJson` function.
//
// Pattern adapted from packages/cli/src/commands/sessions/list.test.ts.
// =============================================================================

const capturedOutput: { lines: string[]; json: unknown } = {
  lines: [],
  json: null,
};

const fakeTaskComponent: {
  listTasks: ReturnType<typeof mock>;
  getTask: ReturnType<typeof mock>;
} = {
  listTasks: mock(async (_opts?: unknown) => ({
    tasks: [] as Task[],
    total: 0,
  })),
  getTask: mock(async (_id: number) => undefined),
};

const fakeEnvService: {
  create: ReturnType<typeof mock>;
  getEnvironment: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
} = {
  create: mock(async () => undefined),
  getEnvironment: mock(() => ({
    getComponent: (name: string) =>
      name === "task" ? fakeTaskComponent : undefined,
  })),
  dispose: mock(async () => undefined),
};

const OutputServiceMock: ReturnType<typeof mock> = mock(() => ({
  configure: mock(() => undefined),
  log: mock((line: string) => {
    capturedOutput.lines.push(line);
  }),
  error: mock(() => undefined),
  json: mock((obj: unknown) => {
    capturedOutput.json = obj;
  }),
}));

const EnvironmentServiceMock: ReturnType<typeof mock> = mock(
  () => fakeEnvService,
);

mock.module("../../services/environment.service", () => ({
  EnvironmentService: EnvironmentServiceMock,
}));

mock.module("../../services/output.service", () => ({
  OutputService: OutputServiceMock,
}));

// Mock the task-graph helpers so we can verify which branch the handler
// took (graph vs json) without depending on the actual tree rendering.
// The existing JSON-structure tests don't touch these functions.
const mockExpandParentChain = mock(async (_c: unknown, tasks: Task[]) => tasks);
const mockBuildTaskTree = mock((_tasks: Task[]): unknown[] => []);
const mockRenderTaskTree = mock(
  (_trees: unknown, _opts?: unknown) => "RENDERED_TREE_OUTPUT",
);

mock.module("./task-graph", () => ({
  expandParentChain: mockExpandParentChain,
  buildTaskTree: mockBuildTaskTree,
  renderTaskTree: mockRenderTaskTree,
}));

// `mock.module()` only applies to modules loaded AFTER it registers, so
// we MUST use a dynamic `import()` here — a static top-level
// `import { ListCommand } from "./list"` would already have evaluated
// `./list`'s transitive graph before our mocks took effect.
const listModule = await import("./list");
const { ListCommand, buildListTasksJson } = listModule;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Sample Task",
    description: "",
    status: "todo",
    priority: "medium",
    type: "normal",
    progress: 0,
    current_status: "",
    goals_and_expected_deliverables: "",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    project_path: "unknown",
    context: "{}",
    ...overrides,
  };
}

describe.skipIf(isParallelRun)("buildListTasksJson - CLI JSON output structure (bug fix: total position + truncated flag)", () => {
  it("should place `total` as the FIRST key in the serialized JSON output (regression: structural parity with tool path)", () => {
    const tasks = [makeTask({ id: 1, title: "A" }), makeTask({ id: 2, title: "B" })];
    const result = buildListTasksJson(tasks, /* total */ 2, {
      limit: 20,
      offset: 0,
    });
    const serialized = JSON.stringify(result);

    // The serialized JSON's literal first key MUST be "total".
    expect(serialized.startsWith('{"total":')).toBe(true);
  });

  it("should set `truncated: true` when total > count (pagination in effect)", () => {
    // 5 tasks in DB, but only 2 returned because limit=2.
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })];
    const result = buildListTasksJson(tasks, /* total */ 5, {
      limit: 2,
      offset: 0,
    });

    expect(result.total).toBe(5);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("should set `truncated: false` when total === count (no pagination truncation)", () => {
    // 1 task in DB, default limit 20 → no truncation.
    const tasks = [makeTask({ id: 1 })];
    const result = buildListTasksJson(tasks, /* total */ 1, {
      limit: 20,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.count).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("should place `tasks` as the LAST key in the serialized JSON output (metadata-first ordering)", () => {
    const tasks = [makeTask({ id: 1 })];
    const result = buildListTasksJson(tasks, /* total */ 1, {
      limit: 20,
      offset: 0,
    });
    const serialized = JSON.stringify(result);

    // The serialized JSON MUST end with the tasks array closing bracket
    // `]}` so that tail-truncation (if applied by a downstream consumer)
    // cuts the array, not the summary metadata that precedes it.
    expect(serialized.endsWith("]}")).toBe(true);

    // The literal first key MUST be "total" (also covered by test 1, but
    // restated here to anchor the ordering test).
    const totalIndex = serialized.indexOf('"total":');
    expect(totalIndex).toBeGreaterThanOrEqual(0);

    // The literal last key in the outer object MUST be "tasks".
    // Use Object.keys order which preserves insertion order for
    // non-integer-like keys (which is what we use here).
    const keys = Object.keys(result);
    expect(keys[0]).toBe("total");
    expect(keys[keys.length - 1]).toBe("tasks");

    // The "tasks" key in the serialized JSON must appear AFTER "total".
    const tasksIndex = serialized.indexOf('"tasks":');
    expect(tasksIndex).toBeGreaterThan(totalIndex);
  });
});

describe.skipIf(isParallelRun)("buildListTasksJson - S-1 polish: depth field echo (consistency with tool path)", () => {
  it("should accept a `depth` argument and surface it as `depth` in the JSON output", () => {
    const tasks = [makeTask({ id: 1, title: "A" }), makeTask({ id: 2, title: "B" })];
    // S-1: buildListTasksJson MUST accept `depth` and put it in the output.
    const result = buildListTasksJson(tasks, /* total */ 2, {
      limit: 20,
      offset: 0,
      depth: 2,
    });

    // The result object MUST have a `depth` property equal to 2.
    expect(result.depth).toBe(2);

    // The serialized JSON MUST contain `"depth":2` (compact form).
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('"depth":2');
  });

  it("should emit keys in the exact order: total, count, truncated, limit, offset, depth, tasks", () => {
    const tasks = [makeTask({ id: 1, title: "A" })];
    const result = buildListTasksJson(tasks, /* total */ 1, {
      limit: 20,
      offset: 0,
      depth: 2,
    });

    // (a) Object.keys order MUST match the canonical sequence. This relies
    //     on the JS spec guarantee that Object.keys preserves insertion
    //     order for string keys (which our builder controls directly).
    expect(Object.keys(result)).toEqual([
      "total",
      "count",
      "truncated",
      "limit",
      "offset",
      "depth",
      "tasks",
    ]);

    // (b) The serialized JSON MUST place these keys in the same order at
    //     the byte level. JSON.stringify preserves insertion order, so the
    //     raw string keys MUST appear in the literal sequence total → ... → tasks.
    const serialized = JSON.stringify(result);
    const orderInJson = [
      serialized.indexOf('"total":'),
      serialized.indexOf('"count":'),
      serialized.indexOf('"truncated":'),
      serialized.indexOf('"limit":'),
      serialized.indexOf('"offset":'),
      serialized.indexOf('"depth":'),
      serialized.indexOf('"tasks":'),
    ];
    // All seven positions must be present (>= 0), and strictly increasing.
    for (const pos of orderInJson) {
      expect(pos).toBeGreaterThanOrEqual(0);
    }
    const sorted = [...orderInJson].sort((a, b) => a - b);
    expect(orderInJson).toEqual(sorted);

    // The serialized JSON MUST begin with `{"total":` and end with `]}`
    // (mirroring the existing ordering invariants).
    expect(serialized.startsWith('{"total":')).toBe(true);
    expect(serialized.endsWith("]}")).toBe(true);
  });
});

describe.skipIf(isParallelRun)("tasks list CLI integration - S-1 polish: --depth echoed in JSON", () => {
  it("should emit `\"depth\": 2` when invoked as `tasks list --depth 2 --json`", async () => {
    // Locate the compiled CLI binary in the workspace.
    // We invoke the actual `roy-bot` binary (after build) so we exercise
    // the end-to-end path: yargs handler → buildListTasksJson → stdout.
    const { spawn } = await import("child_process");
    const { existsSync } = await import("fs");
    const cliRoot = import.meta.dir
      .replace(/\/src\/commands\/tasks$/, "");
    const binPath = `${cliRoot}/dist/bin/roy-bot.js`;

    // If the binary isn't built yet, skip with a clear reason. This keeps
    // the test suite runnable before `bun run build` without false-failing.
    if (!existsSync(binPath)) {
      // Surface the missing dependency rather than silently passing.
      throw new Error(
        `CLI binary not built: expected ${binPath}. Run 'bun run build' in packages/cli first.`,
      );
    }

    const child = spawn("bun", [binPath, "tasks", "list", "--depth", "2", "--json"], {
      cwd: cliRoot,
      env: {
        ...process.env,
        // Disable color/TTY so output is stable across environments.
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

    const exitCode: number = await new Promise((resolve) => {
      child.on("close", resolve);
    });

    const out = stdout.join("");
    // Parse the first top-level JSON object from stdout (the CLI may emit
    // log lines before/after; we want the JSON blob).
    const jsonStart = out.indexOf("{");
    const jsonEnd = out.lastIndexOf("}");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    expect(jsonEnd).toBeGreaterThan(jsonStart);
    const parsed = JSON.parse(out.slice(jsonStart, jsonEnd + 1));

    expect(exitCode).toBe(0);
    // S-1: the CLI MUST echo `depth: 2` when --depth 2 is passed.
    expect(parsed.depth).toBe(2);
  });
});


describe.skipIf(isParallelRun)("Task #1943 / Task #1951: tasks list --graph option", () => {
  /**
   * Helper: drive `ListCommand.builder` with the REAL yargs parser to
   * verify an option is actually registered. This is the same pattern
   * used by `packages/cli/src/commands/sessions/messages.test.ts` —
   * far more robust than reading list.ts as a string and matching
   * `.option(...)` regexes.
   */
  function parseWithBuilder(argv: string[]): {
    graph?: boolean;
    json?: boolean;
    [k: string]: unknown;
  } {
    // The static TypeScript type of `ListCommand.builder` says it could
    // be undefined (the `CommandModule` interface allows it). At runtime
    // it's always defined for our commands; cast through `unknown`.
    const builderFn = ListCommand.builder as unknown as (y: typeof yargs) => ReturnType<typeof yargs>;
    const parser = builderFn(yargs());
    return parser.parse(argv) as ReturnType<typeof parseWithBuilder>;
  }

  /**
   * Helper: invoke the real `ListCommand.handler` with mocked services.
   * Anything we need to assert (output lines, json emitted, calls into
   * `expandParentChain`/`buildTaskTree`/`renderTaskTree`) is captured
   * by the module-level mocks at the top of this file.
   */
  async function invoke(opts: Record<string, unknown>): Promise<void> {
    await (ListCommand.handler as unknown as (a: Record<string, unknown>) => Promise<void>)(opts);
  }

  function resetMocks(): void {
    capturedOutput.lines = [];
    capturedOutput.json = null;
    fakeTaskComponent.listTasks.mockClear();
    fakeTaskComponent.getTask.mockClear();
    fakeEnvService.create.mockClear();
    fakeEnvService.getEnvironment.mockClear();
    fakeEnvService.dispose.mockClear();
    OutputServiceMock.mockClear();
    EnvironmentServiceMock.mockClear();
    mockExpandParentChain.mockClear();
    mockBuildTaskTree.mockClear();
    mockRenderTaskTree.mockClear();
  }

  beforeEach(() => {
    resetMocks();
  });

  it("yargs builder registers --graph option (replaces fs.readFileSync regex)", () => {
    // Drive the actual yargs parser through ListCommand.builder and
    // verify the --graph flag is recognized.
    const parsed = parseWithBuilder(["--graph"]);
    expect(parsed.graph).toBe(true);
  });

  it("yargs builder registers -g alias for --graph (replaces fs.readFileSync regex)", () => {
    // Same builder, but feed it the short alias. Parsing should
    // resolve `-g` to `args.graph === true` like `--graph` does.
    const parsed = parseWithBuilder(["-g"]);
    expect(parsed.graph).toBe(true);
  });

  it("handler: --graph branch is checked BEFORE --json when both flags are set (replaces fs.readFileSync string-index test)", async () => {
    // Behavioral test: invoke the real handler with graph:true AND
    // json:true. Because the handler checks `if (args.graph)` BEFORE
    // `if (args.json)` (mirroring sessions/list.ts ordering), the graph
    // path must run and the graph path RETURNS EARLY. We verify via:
    //   (a) `expandParentChain` was called   → graph path active
    //   (b) tree rendering was sent to OutputService.log
    //   (c) `OutputService.json(...)` was NEVER called
    //   (d) `buildListTasksJson` was NEVER called (its source-object
    //       isn't mocked, but if the JSON branch had won, the captured
    //       JSON output would be set — it isn't, so the JSON branch
    //       was correctly skipped).
    await invoke({
      graph: true,
      json: true,
      limit: 20,
      offset: 0,
    });

    // (a) graph path was taken
    expect(mockExpandParentChain).toHaveBeenCalledTimes(1);
    expect(mockBuildTaskTree).toHaveBeenCalledTimes(1);
    expect(mockRenderTaskTree).toHaveBeenCalledTimes(1);

    // (b) the tree rendering reached OutputService.log
    expect(capturedOutput.lines).toContain("RENDERED_TREE_OUTPUT");

    // (c) the JSON branch never ran
    expect(capturedOutput.json).toBeNull();
    expect(OutputServiceMock).toHaveBeenCalledTimes(1);  // exactly one OutputService was constructed
    // And the resulting object's .json() method must not have been called.
    const instance = OutputServiceMock.mock.results[0]!.value as { json: ReturnType<typeof mock> };
    expect(instance.json).not.toHaveBeenCalled();
  });
});


describe.skipIf(isParallelRun)("Task #1818: tasks list CLI options", () => {
  it("--offset option accepts -o alias", () => {
    // 通过 yargs schema 直接验证 -o alias
    // 由于 ListCommand 是一个 yargs CommandModule，它的 builder 接受 yargs 实例
    // 这里我们只验证 builder 的输出 schema
    // （更深的集成测试需要 spy mock，参见 list.test.ts:CLI integration tests）

    // 通过读取 list.ts 源代码验证 -o alias 存在
    const fs = require("fs");
    const path = require("path");
    const srcPath = path.join(__dirname, "list.ts");
    const src = fs.readFileSync(srcPath, "utf8");
    expect(src).toContain('alias: "o"');
    expect(src).toContain('"offset"');
  });

  it("quiet output uses renderQuietLine: '<id>\\t<title>' (Task #1818 user feedback)", () => {
    // 验证 list.ts 的 quiet 分支使用 renderQuietLine 输出 "id\ttitle" 格式
    // （第二轮回 user feedback：显示 id 和 name，# Total: N header）
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "list.ts"), "utf8");
    expect(src).toContain('renderQuietHeader(total, "task")');
    expect(src).toContain("renderQuietLine(t.id, t.title)");
  });
});
