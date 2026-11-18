/**
 * @fileoverview TDD RED — `workflow_validate` must accept a file path
 * (Task #4392 P0-4, derived from #4385 §2 C2 / §5.5 diff-3).
 *
 * Background: the tool had three *aliases* for the same concept
 * (`definition` / `definition_yaml` / `yaml`) but **no** way to say "read this
 * file". LLMs therefore invented `yaml: "$(cat /tmp/x.yaml)"` — and because the
 * tool performs **no shell expansion**, YAML.parse received the literal string
 * `$(cat /tmp/x.yaml)`, which parses to the *string* `"$(cat /tmp/x.yaml)"`
 * rather than an object. That single mismatch produced `Parsed definition is
 * not an object` 30 out of 31 times in the measured corpus (#4385 §2 C2).
 *
 * Contract after GREEN:
 *   1. `file` is accepted and read (relative paths resolved against CWD).
 *   2. `$(cat ...)` in a yaml/definition_yaml string is detected and produces an
 *      actionable error telling the caller to use `file:` instead of a
 *      shell-substitution string.
 *   3. Path traversal outside CWD / /tmp is refused.
 *   4. Missing file → actionable error, not a stack trace.
 *   5. Precedence: `definition` (object) > `file` > `yaml`/`definition_yaml`.
 *   6. The successful result shape is unchanged (`valid`, `errors`, `warnings`, …).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowValidateTool } from "./workflow-validate-tool";

const VALID_YAML = `
name: file-input-test
version: "1.0.0"
nodes:
  - id: only
    type: tool
    name: only
    config:
      tool: echo
      message: hi
`;

const INVALID_YAML = `
name: broken
version: "1.0.0"
nodes:
  - id: a
    type: tool
    name: a
    config:
      tool: echo
      message: hi
    depends_on: [does-not-exist]
`;

describe("workflow_validate: file input (Task #4392 P0-4)", () => {
  let dir: string;
  let tool: ReturnType<typeof createWorkflowValidateTool>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wf-validate-file-"));
    tool = createWorkflowValidateTool({} as any);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("RED: reads a YAML file and validates it", async () => {
    const p = join(dir, "ok.yaml");
    writeFileSync(p, VALID_YAML, "utf-8");

    const res: any = await tool.execute({ file: p }, {} as any);

    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.valid).toBe(true);
    expect(parsed.workflowName).toBe("file-input-test");
  });

  it("RED: reports errors found in the file (success=false, actionable)", async () => {
    const p = join(dir, "bad.yaml");
    writeFileSync(p, INVALID_YAML, "utf-8");

    const res: any = await tool.execute({ file: p }, {} as any);

    expect(res.success).toBe(false);
    const parsed = JSON.parse(res.output);
    expect(parsed.valid).toBe(false);
    expect(parsed.errorCount).toBeGreaterThan(0);
  });

  it("RED: missing file → clear error naming the path", async () => {
    const p = join(dir, "nope.yaml");

    const res: any = await tool.execute({ file: p }, {} as any);

    expect(res.success).toBe(false);
    expect(res.error).toContain("nope.yaml");
    // must not be a raw ENOENT stack trace
    expect(res.error).not.toContain("    at ");
  });

  it("RED: `$(cat /path)` in yaml string is rejected with a fix hint", async () => {
    const p = join(dir, "ok.yaml");
    writeFileSync(p, VALID_YAML, "utf-8");

    const res: any = await tool.execute({ yaml: `$(cat ${p})` }, {} as any);

    expect(res.success).toBe(false);
    expect(res.error).toContain("file");
    // The hint must tell the caller what to do instead.
    expect(res.error.toLowerCase()).toContain("shell");
  });

  it("RED: `$(cat ...)` in definition_yaml is also rejected", async () => {
    const res: any = await tool.execute(
      { definition_yaml: "$(cat /tmp/whatever.yaml)" },
      {} as any
    );

    expect(res.success).toBe(false);
    expect(res.error.toLowerCase()).toContain("shell");
  });

  it("RED: `definition` object wins over `file`", async () => {
    const p = join(dir, "ok.yaml");
    writeFileSync(p, VALID_YAML, "utf-8");

    const res: any = await tool.execute(
      {
        file: p,
        definition: {
          name: "from-object",
          version: "1.0.0",
          nodes: [
            { id: "x", type: "tool", name: "x", config: { tool: "echo", message: "hi" } },
          ],
        },
      },
      {} as any
    );

    expect(res.success).toBe(true);
    expect(JSON.parse(res.output).workflowName).toBe("from-object");
  });

  it("RED: path traversal outside CWD and /tmp is refused", async () => {
    const res: any = await tool.execute({ file: "/etc/passwd" }, {} as any);

    expect(res.success).toBe(false);
    expect(res.error.toLowerCase()).toContain("refus");
  });

  it("RED: file with invalid YAML syntax reports a parse error naming the file", async () => {
    const p = join(dir, "not-yaml.yaml");
    writeFileSync(p, "name: [unclosed\n  :::", "utf-8");

    const res: any = await tool.execute({ file: p }, {} as any);

    expect(res.success).toBe(false);
    expect(res.error.toLowerCase()).toContain("invalid yaml");
  });

  it("RED: file containing a JSON workflow is accepted (JSON is valid YAML)", async () => {
    const p = join(dir, "wf.json");
    writeFileSync(
      p,
      JSON.stringify({
        name: "json-wf",
        version: "1.0.0",
        nodes: [{ id: "n", type: "tool", name: "n", config: { tool: "echo", message: "x" } }],
      }),
      "utf-8"
    );

    const res: any = await tool.execute({ file: p }, {} as any);

    expect(res.success).toBe(true);
    expect(JSON.parse(res.output).workflowName).toBe("json-wf");
  });

  it("RED: shell dialect warnings surface through the file path too", async () => {
    const p = join(dir, "dialect.yaml");
    writeFileSync(
      p,
      `
name: dialect-file
version: "1.0.0"
nodes:
  - id: b
    type: tool
    name: b
    config:
      tool: bash
      command: "set -o pipefail; npm test | tee /tmp/o.log"
`,
      "utf-8"
    );

    const res: any = await tool.execute({ file: p }, {} as any);

    const parsed = JSON.parse(res.output);
    expect(parsed.warningCount).toBe(1);
    expect(parsed.warnings[0]).toContain("[shell-dialect]");
  });

  it("RED: no-input case still produces the legacy three-alias error", async () => {
    const res: any = await tool.execute({}, {} as any);

    expect(res.success).toBe(false);
    expect(res.error).toContain("definition");
  });

  it("RED: `file` is documented in the tool schema description", () => {
    const shape: any = tool.parameters;
    const fields = shape?.shape ?? shape?._def?.shape?.() ?? {};
    expect(Object.keys(fields)).toContain("file");
  });
});
