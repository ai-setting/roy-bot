/**
 * @fileoverview tasks create — `--goals` option description contract (Task #4942)
 *
 * Bug (found in Task #4889 Phase 2c, root cause ②):
 *   `packages/cli/src/commands/tasks/create.ts` declared
 *     .option("goals", { description: "目标和预期产出" })
 *   i.e. ONE vague sentence, with no mention of the "numbered sub-items"
 *   (编号子项) requirement. `roy-bot tasks create` is the most common
 *   task-creation entry point for runtime agents, so the help text is the
 *   ONLY place an agent can learn the rule. Result: agents passed `-` bullet
 *   lists or one long sentence as goals, which is one root cause of poor
 *   operation-record quality.
 *
 * The rule already exists as a single source of truth in core:
 *   packages/core/src/env/task/prompt/task-discipline.ts  → TASK_DISCIPLINE_GOALS
 *   (consumed by the task_create tool at create-tool.ts:150)
 *
 * These tests lock in:
 *   1. The `--goals` description carries the numbered-sub-item anchors
 *      (编号子项 / 逐条验收 / numbered sub-items).
 *   2. It mentions the longterm/cycle exemption (no per-item acceptance).
 *   3. Every numbered example line in the description is DERIVED from the
 *      core constant (verbatim substring of TASK_DISCIPLINE_GOALS) — a
 *      drift guard proving the CLI does not maintain a private copy.
 *   4. The description stays short enough to be usable as help text.
 *   5. The real yargs builder surfaces the description (not just the constant).
 *
 * Why dynamic import: mirrors update-parent-id.test.ts — a static import of
 * "./create" evaluates environment.service at parse time, before mock.module()
 * registrations take effect, which pulls real core source into the runner.
 */

import { describe, it, expect, mock } from "bun:test";

// === Module mocks (registered BEFORE dynamic import of "./create") ===
mock.module("../../services/environment.service", () => ({
  EnvironmentService: class {
    async create(_opts: any) {
      /* no-op */
    }
    getEnvironment() {
      return undefined;
    }
    async dispose() {
      /* no-op */
    }
  },
}));

const { CreateCommand, GOALS_OPTION_DESCRIPTION } = await import("./create");
const { TASK_DISCIPLINE_GOALS } = await import("@ai-setting/roy-bot-core");

/**
 * Collect the goal-option description registered on the real yargs builder.
 *
 * We feed the builder a recording stub rather than a real yargs instance:
 * `.positional()` throws unless called inside a genuine command builder, and
 * spinning up a whole command just to read one description is overkill.
 */
function buildGoalsOptionDescription(): string {
  const builder = CreateCommand.builder;
  expect(typeof builder).toBe("function");

  const recorded: Record<string, any> = {};
  const chainable = {
    positional: () => chainable,
    option: (name: string, opts: any) => {
      recorded[name] = opts;
      return chainable;
    },
    // yargs also verb-lists options as `options()` on some callsites.
    options: (spec: Record<string, any>) => {
      Object.assign(recorded, spec);
      return chainable;
    },
  };

  (builder as any)(chainable);
  return String(recorded.goals?.description ?? "");
}

describe("tasks create — --goals description carries the numbered-sub-item rule", () => {
  it("mentions numbered sub-items (编号子项 / numbered sub-items)", () => {
    const description = String(GOALS_OPTION_DESCRIPTION);
    expect(description.includes("编号子项")).toBe(true);
    expect(description.toLowerCase().includes("numbered sub-items")).toBe(true);
  });

  it("mentions per-item acceptance (逐条验收)", () => {
    expect(String(GOALS_OPTION_DESCRIPTION).includes("逐条验收")).toBe(true);
  });

  it("mentions the longterm/cycle exemption", () => {
    const description = String(GOALS_OPTION_DESCRIPTION);
    expect(description.includes("longterm")).toBe(true);
    expect(description.includes("cycle")).toBe(true);
  });

  it("does NOT endorse a flat `-` bullet list as the goals format", () => {
    // The old failure mode was agents emitting "- item" lists. The description
    // must steer away from that, i.e. it should say NOT to use `-` lists.
    const description = String(GOALS_OPTION_DESCRIPTION);
    expect(description.includes("`-`") || description.includes("不要用")).toBe(true);
  });

  it("derives every numbered example line from the core single source of truth", () => {
    const description = String(GOALS_OPTION_DESCRIPTION);
    const numberedLines = description
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\s+\S/.test(line));

    // There must be at least the 3 canonical examples (实现/测试/文档).
    expect(numberedLines.length).toBeGreaterThanOrEqual(3);

    // Drift guard: each example must exist verbatim in the core constant.
    // If core renames an example (e.g. "实现 X" → "落地 X"), this test breaks
    // instead of the CLI silently carrying a stale private copy.
    for (const line of numberedLines) {
      expect(TASK_DISCIPLINE_GOALS.includes(line)).toBe(true);
    }
  });

  it("stays short enough to remain usable as CLI help text", () => {
    // Full discipline text is ~1200 chars; the CLI brief must be a digest.
    expect(String(GOALS_OPTION_DESCRIPTION).length).toBeLessThan(700);
  });

  it("is wired into the real yargs builder for the goals option", () => {
    const builtDescription = buildGoalsOptionDescription();
    expect(builtDescription.length).toBeGreaterThan(0);
    expect(builtDescription.includes("编号子项")).toBe(true);
    expect(builtDescription).toBe(String(GOALS_OPTION_DESCRIPTION));
  });
});
