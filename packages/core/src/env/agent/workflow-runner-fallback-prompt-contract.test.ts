import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../../../");
const CORE_SRC = resolve(REPO_ROOT, "packages/core/src");
const PROMPT_FILE = resolve(__dirname, "../prompt/prompts-index.ts");

function grepCount(pattern: string, path: string): number {
  try {
    const output = execFileSync(
      "grep",
      ["-rEn", "--include=*.ts", "--exclude-dir=dist", "--exclude-dir=node_modules", pattern, path],
      { encoding: "utf8" },
    );
    return output.trim() ? output.trim().split("\n").length : 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return 0;
    throw error;
  }
}

function getWorkflowRunnerPrompt(): string {
  const content = readFileSync(PROMPT_FILE, "utf8");
  const match = content.match(/"workflow-runner":\s*`([\s\S]*?)`,\s*\n\s*\/[*]/);
  if (!match) throw new Error("workflow-runner prompt block not found");
  return match[1];
}

describe("Task #2251: runtime fallback state machine removal guards", () => {
  test("controller class has zero occurrences in core source", () => {
    expect(grepCount("WorkflowRunnerFallback" + "Controller", CORE_SRC)).toBe(0);
  });

  test("fallback trace namespace has zero occurrences in core source", () => {
    expect(grepCount("workflow\\.fallback\\" + ".", CORE_SRC)).toBe(0);
  });

  test("fallback controller field has zero occurrences in agent-component", () => {
    const file = resolve(__dirname, "agent-component.ts");
    expect(grepCount("fallback" + "Controller", file)).toBe(0);
  });

  test("workflow result recorder has zero occurrences", () => {
    expect(grepCount("recordWorkflow" + "RunResult", CORE_SRC)).toBe(0);
  });

  test("takeover runtime hook has zero occurrences", () => {
    expect(grepCount("tryFallback" + "Takeover", CORE_SRC)).toBe(0);
  });

  test("runtime controller source file does not exist", () => {
    expect(existsSync(resolve(REPO_ROOT, "packages/core/src/env/workflow/fallback-controller.ts"))).toBe(false);
  });

  test("runtime controller test file does not exist", () => {
    expect(existsSync(resolve(REPO_ROOT, "packages/core/src/env/workflow/fallback-controller.test.ts"))).toBe(false);
  });

  test("runtime wiring integration test file does not exist", () => {
    expect(existsSync(resolve(REPO_ROOT, "packages/core/src/env/agent/workflow-runner-fallback-wiring.test.ts"))).toBe(false);
  });
});

describe("Task #2251: workflow-runner prompt contract", () => {
  let prompt: string;

  beforeAll(() => {
    prompt = getWorkflowRunnerPrompt();
  });

  test("states the consecutive two-failure threshold", () => {
    expect(prompt).toMatch(/连续\s*2\s*次|2\s*consecutive/i);
  });

  test("queries the original run status before takeover", () => {
    expect(prompt).toContain("workflow_run_status");
  });

  test("loads the real workflow definition before takeover", () => {
    expect(prompt).toContain("workflow_get");
  });

  test("treats each node description as a skill contract", () => {
    expect(prompt).toMatch(/节点.{0,10}skill|node.{0,5}description.{0,10}skill/i);
    expect(prompt).toMatch(/目标|goal/i);
    expect(prompt).toMatch(/输入输出|input.{0,5}output/i);
    expect(prompt).toMatch(/依赖|dependenc/i);
    expect(prompt).toMatch(/验证|verif/i);
  });

  test("defines the fallback takeover evidence marker", () => {
    expect(prompt).toContain("FALLBACK_TAKEOVER");
  });

  test("forbids faking workflow engine success", () => {
    expect(prompt).toMatch(/禁止.{0,12}伪造|do\s*not\s*fake/i);
  });

  test("does not call workflow_run again after takeover", () => {
    expect(prompt).toMatch(/接管后.{0,30}不再调\s*workflow_run/i);
  });

  test("makes takeover terminal and non-recursive", () => {
    expect(prompt).toMatch(/接管不可再触发|once\s*taken\s*over/i);
  });

  test("requires the complete takeover evidence schema", () => {
    expect(prompt).toContain("original_run_id");
    expect(prompt).toContain("failed_node");
    expect(prompt).toContain("react_completed_nodes");
    expect(prompt).toContain("verification_evidence");
    expect(prompt).toContain("unfinished_items");
  });
});
