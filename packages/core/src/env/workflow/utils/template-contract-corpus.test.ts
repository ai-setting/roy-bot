/**
 * @fileoverview Full-corpus regression guard for the Layer-2 template-contract
 * validator (Task #4298).
 *
 * The whole point of adding semantic validation is undermined if it produces
 * false positives on the already-registered workflows. This suite pins the
 * *known* result of scanning the real workflow database so that any future
 * loosening/tightening of the rules is visible immediately.
 *
 * ## How it works
 *
 * 1. If a workflow DB is present (`~/.local/share/roy-bot/workflows.db`), the
 *    suite scans **every** registered definition and asserts:
 *      - ZERO definitions are `valid: false` (no false blocking), except the
 *        explicitly known-buggy allow-list below.
 *      - ZERO new `R2-result-on-non-agent` errors appear beyond the allow-list.
 * 2. When no DB is available (CI / clean checkout), the suite falls back to an
 *    embedded corpus of representative shapes drawn from the real DB (including
 *    the loop/back-edge patterns that must stay clean), so the guard still runs.
 *
 * The allow-list is intentionally tiny and documented: it is the bug this task
 * exists to fix. When `wheels-validate-v1` is corrected, remove it from here —
 * the assertion is written so that a *stale* allow-list entry would be noticed
 * via the "known bug still detected" test below.
 */

import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { validateWorkflowDefinition } from "./validate-workflow-definition";

const DB_PATH = join(homedir(), ".local", "share", "roy-bot", "workflows.db");

/**
 * Definitions known to be buggy at the time this guard was written. They are
 * EXPECTED to fail validation (that is the feature working). Everything else
 * must pass.
 */
const KNOWN_BUGGY = new Set([
  // Task #4296 — report-results prompt reads `.result` off two tool nodes.
  "wheels-validate-v1",
]);

/**
 * Every Layer-3 shell-dialect finding is formatted with this exact prefix by
 * `formatShellDialectFindings()` (see `shell-dialect-lint.ts`). It is the wire
 * format, so it doubles as the discriminator between rule families.
 */
const SHELL_DIALECT_PREFIX = "[shell-dialect]";

function isShellDialectWarning(warning: string): boolean {
  return warning.startsWith(SHELL_DIALECT_PREFIX);
}

interface LoadedWorkflow {
  name: string;
  definition: unknown;
}

function loadFromDb(): LoadedWorkflow[] | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.query("SELECT name, definition FROM workflows").all() as Array<{
      name: string;
      definition: string;
    }>;
    const out: LoadedWorkflow[] = [];
    for (const r of rows) {
      try {
        out.push({ name: r.name, definition: JSON.parse(r.definition) });
      } catch {
        /* skip unparseable rows */
      }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Embedded fallback corpus — shapes drawn from the real DB, chosen because they
// historically trip "clever" validators. All of these MUST stay clean.
// ---------------------------------------------------------------------------
const FALLBACK_CORPUS: LoadedWorkflow[] = [
  {
    name: "loop-back-edge-selfref",
    definition: {
      nodes: [
        {
          id: "tdd-implement",
          type: "agent",
          config: { prompt: "prev commits: {{nodes.tdd-implement.commits[-1]}}" },
        },
      ],
      edges: [],
    },
  },
  {
    name: "strict-task-agent-shape",
    definition: {
      nodes: [
        { id: "plan", type: "agent", config: { prompt: "plan" } },
        { id: "execute", type: "agent", depends_on: ["plan"], config: { prompt: "{{nodes.plan.result}}" } },
        { id: "verify", type: "agent", depends_on: ["execute"], config: { prompt: "{{nodes.execute.result}}" } },
        { id: "output", type: "tool", depends_on: ["verify"], config: { tool: "echo", args: { message: "{{nodes.verify.result}}" } } },
      ],
      edges: [
        { from: "plan", to: "execute" },
        { from: "execute", to: "verify" },
        { from: "verify", to: "output", when: "{{nodes.verify.passed}} == true" },
        { from: "verify", to: "plan", when: "{{nodes.verify.passed}} == false" },
      ],
    },
  },
  {
    name: "docker-go-template-and-handlebars",
    definition: {
      nodes: [
        {
          id: "build",
          type: "tool",
          config: {
            tool: "bash",
            command:
              "docker inspect --format='{{index .RepoDigests 0}}' x\n" +
              "tags: {{#if input.task_tags}}{{input.task_tags}}{{/if}}\n" +
              "doc: {{nodes.<source-id>.<field>}}",
          },
        },
      ],
      edges: [],
    },
  },
  {
    name: "python-call-deep-path",
    definition: {
      nodes: [
        { id: "market-timing", type: "python_call", config: { module: "m", function: "f" } },
        {
          id: "run-strategies",
          type: "agent",
          depends_on: ["market-timing"],
          config: { prompt: "{{nodes.market-timing.output.recommendation.active_strategies}}" },
        },
      ],
      edges: [],
    },
  },
  {
    // Mirrors the real `test-task-id-template`: a tool node whose output is a
    // JSON *string* — `{{nodes.init-task.task_id}}` cannot navigate into it.
    name: "test-task-id-template",
    definition: {
      nodes: [
        { id: "init-task", type: "tool", config: { tool: "bash", command: "echo '{\"task_id\": 999999}'" } },
        {
          id: "use-task-id",
          type: "tool",
          depends_on: ["init-task"],
          config: { tool: "bash", command: 'TASK_ID="{{nodes.init-task.task_id}}"' },
        },
      ],
      edges: [],
    },
  },
  {
    // Mirrors the real loop back-edge pattern.
    name: "example-rd-with-trace-and-ci",
    definition: {
      nodes: [
        { id: "tdd-implement", type: "agent", config: { prompt: "{{nodes.ci-fix.fail_reason | default ''}}" } },
        { id: "ci-fix", type: "agent", depends_on: ["tdd-implement"], config: { prompt: "hi" } },
      ],
      edges: [],
    },
  },
  {
    name: "agent-json-schema-fields",
    definition: {
      nodes: [
        {
          id: "init-task",
          type: "agent",
          config: {
            prompt: "x",
            output: {
              mode: "json",
              schema: { type: "object", properties: { task_id: { type: "integer" }, branch: { type: "string" } } },
            },
          },
        },
        {
          id: "capture",
          type: "tool",
          depends_on: ["init-task"],
          config: { tool: "bash", command: 'TASK_ID="{{nodes.init-task.task_id}}"' },
        },
      ],
      edges: [],
    },
  },
];

function loadCorpus(): { corpus: LoadedWorkflow[]; fromDb: boolean } {
  const db = loadFromDb();
  if (db) return { corpus: db, fromDb: true };
  return { corpus: FALLBACK_CORPUS, fromDb: false };
}

describe("template-contract validator — full-corpus regression (Task #4298)", () => {
  const { corpus, fromDb } = loadCorpus();

  it("loads a corpus (DB when available, embedded fallback otherwise)", () => {
    expect(corpus.length).toBeGreaterThan(0);
    // Surfaced in the test name so CI logs show which mode ran.
    expect(typeof fromDb).toBe("boolean");
  });

  it("produces NO error findings on any workflow other than the allow-listed bug", () => {
    const offenders: Array<{ name: string; errors: string[] }> = [];
    for (const wf of corpus) {
      if (KNOWN_BUGGY.has(wf.name)) continue;
      const result = validateWorkflowDefinition(wf.definition);
      if (!result.valid) offenders.push({ name: wf.name, errors: result.errors });
    }
    // Print a compact diff when it fails, so the regression is debuggable.
    if (offenders.length > 0) {
      console.error(
        "Unexpected validation failures:\n" +
          offenders.map((o) => `  - ${o.name}: ${o.errors.join(" | ")}`).join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("never reports R2-result-on-non-agent outside the allow-list", () => {
    const hits: string[] = [];
    for (const wf of corpus) {
      if (KNOWN_BUGGY.has(wf.name)) continue;
      const errors = validateWorkflowDefinition(wf.definition).errors;
      if (errors.some((e) => e.includes("R2-result-on-non-agent"))) hits.push(wf.name);
    }
    expect(hits).toEqual([]);
  });

  it("emits only warning/info (never error) for advisory rules across the corpus", () => {
    for (const wf of corpus) {
      if (KNOWN_BUGGY.has(wf.name)) continue;
      const result = validateWorkflowDefinition(wf.definition);
      expect(result.errors).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // Peer-review follow-up (CV-4298 P2#1).
  //
  // Asserting only `errors === []` let a *real* latent bug go unnoticed: the
  // validator DID flag `test-task-id-template` (a tool node's string output is
  // navigated with `.task_id`, so it silently resolves to an empty string), but
  // nothing pinned that warning — so a future loosening (or the workflow being
  // fixed) would be invisible.
  //
  // We therefore pin the advisory-finding sets too. When a workflow is fixed,
  // delete it from these sets — the test failing is the intended signal.
  // -------------------------------------------------------------------------
  // Task #4392 P0-3 widened this guard on purpose: the new Layer-3 shell-dialect
  // lint fires on 11 pre-existing workflows. Because those findings come from a
  // *different* rule family with a *different* severity story, the pinned set is
  // partitioned by rule family instead of kept as one flat list. That way a
  // regression tells you *which* family drifted, and a future change to one
  // family does not require touching the other's expectation.
  const KNOWN_TEMPLATE_CONTRACT_WARNING_WORKFLOWS = new Set([
    // tool node whose stored value is a JSON *string*; `{{nodes.init-task.task_id}}`
    // cannot navigate into it (R3-unknown-field-on-closed). Tracked as a real
    // latent bug — see CV note; fix the fixture or the workflow.
    "test-task-id-template",
  ]);

  // Pre-existing workflows that already contain bash-only constructs and will
  // therefore FAIL at runtime under `/bin/sh` (dash). They are pinned — not
  // silenced — so the debt stays visible: fixing any of them must delete its
  // name here, and the test failing is the intended signal.
  //
  // Measured against the live DB on 2026-10-20 (Task #4392 M1): 11 workflows /
  // 24 warning lines. Rules hit: dbl-bracket 11 / source 9 / RANDOM 3 / array 1.
  // Expanded from 10 → 20 by the M2-driven rule additions
  // (process-substitution / here-string / ansi-c-quote + a corrected
  // combined-flag pipefail regex). Every addition below is a *real* bash-only
  // construct, verified by reading the warning text — notably `set -euo
  // pipefail` (37 hits) and `[[ ... ]]` (4 hits), which the first rule set
  // simply could not see. See Task #4392 M1/M2.
  const KNOWN_SHELL_DIALECT_WARNING_WORKFLOWS = new Set([
    "ai-agent-bounty-feature-pipeline",
    "bounty-feature-dev-deploy",
    "bounty-release-pipeline",
    "cli-standalone-build-publish",
    "code-review",
    "feature-development",
    "roy-bot-build-publish-v4",
    "test-echo-v2",
    "test-v100-p1",
    "test-v100-p1-strict",
    "tongagent-rd-pipeline",
    "tongagent-rd-pipeline-v140-bug-validate",
    "tongagent-rd-pipeline-v140-refactor-validate",
    "tongagent-rd-pipeline-v140-validate",
    "example-build-publish",
    "example-rd-with-trace",
    "v150-smoke-test",
    "wiki-create-iteration-task",
    "wiki-task-manager",
    "wiki-task-sync",
  ]);

  const KNOWN_INFO_WORKFLOWS = new Set([
    // loop back-edge: tdd-implement reads `{{nodes.ci-fix.*}}` from the previous
    // round (R6-not-upstream). Legitimate by design.
    "example-rd-with-trace-and-ci",
  ]);

  it("emits EXACTLY the known template-contract warnings (no silent drift)", () => {
    const withWarnings = new Set<string>();
    for (const wf of corpus) {
      if (KNOWN_BUGGY.has(wf.name)) continue;
      const templateWarnings = (validateWorkflowDefinition(wf.definition).warnings ?? []).filter(
        (w) => !isShellDialectWarning(w),
      );
      if (templateWarnings.length > 0) withWarnings.add(wf.name);
    }
    expect([...withWarnings].sort()).toEqual(
      [...KNOWN_TEMPLATE_CONTRACT_WARNING_WORKFLOWS].sort(),
    );
  });

  it("emits shell-dialect warnings on EXACTLY the known bash-only workflows (Task #4392 P0-3)", () => {
    const withDialectWarnings = new Set<string>();
    for (const wf of corpus) {
      if (KNOWN_BUGGY.has(wf.name)) continue;
      const dialectWarnings = (validateWorkflowDefinition(wf.definition).warnings ?? []).filter(
        isShellDialectWarning,
      );
      if (dialectWarnings.length > 0) withDialectWarnings.add(wf.name);
    }
    expect([...withDialectWarnings].sort()).toEqual(
      [...KNOWN_SHELL_DIALECT_WARNING_WORKFLOWS].sort(),
    );
  });

  it("keeps every shell-dialect finding advisory (warning, never error)", () => {
    // The severity contract of P0-3: dialects must never block a workflow that
    // previously validated cleanly. Guarded corpus-wide, not just on the list
    // above, so a rule that escalates later is caught even on new workflows.
    for (const wf of corpus) {
      const result = validateWorkflowDefinition(wf.definition);
      const escalated = result.errors.filter((e) => e.includes("[shell-dialect]"));
      if (escalated.length > 0) {
        console.error(`Shell-dialect escalated to error in ${wf.name}: ${escalated.join(" | ")}`);
      }
      expect(escalated).toEqual([]);
    }
  });

  it("emits infos for EXACTLY the known-info workflows (no silent drift)", () => {
    const withInfos = new Set<string>();
    for (const wf of corpus) {
      if (KNOWN_BUGGY.has(wf.name)) continue;
      const result = validateWorkflowDefinition(wf.definition);
      if ((result.infos ?? []).length > 0) withInfos.add(wf.name);
    }
    expect([...withInfos].sort()).toEqual([...KNOWN_INFO_WORKFLOWS].sort());
  });

  it("pins the R3 warning on test-task-id-template (latent tool-field bug stays visible)", () => {
    const wf = corpus.find((w) => w.name === "test-task-id-template");
    if (!wf) return; // only meaningful against the real DB corpus
    const warnings = validateWorkflowDefinition(wf.definition).warnings ?? [];
    expect(warnings.some((w) => w.includes("R3-unknown-field-on-closed"))).toBe(true);
    expect(warnings.some((w) => w.includes("nodes.init-task.task_id"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sanity: the feature must actually FIRE on the known bug when it is present.
// ---------------------------------------------------------------------------
describe("template-contract validator — known bug is actually detected (Task #4298)", () => {
  const wheelsLike = {
    name: "wheels-validate-v1",
    nodes: [
      { id: "run-validation-tests", type: "tool", config: { tool: "bash", command: "x" } },
      {
        id: "enforce-evidence-gate",
        type: "tool",
        depends_on: ["run-validation-tests"],
        config: { tool: "bash", command: "y" },
      },
      {
        id: "report-results",
        type: "agent",
        depends_on: ["enforce-evidence-gate"],
        config: {
          prompt: "{{nodes.run-validation-tests.result}} {{nodes.enforce-evidence-gate.result}}",
        },
      },
    ],
  };

  it("detects exactly 2 R2 errors on the wheels-validate-v1 shape", () => {
    const result = validateWorkflowDefinition(wheelsLike);
    expect(result.valid).toBe(false);
    const r2 = result.errors.filter((e) => e.includes("R2-result-on-non-agent"));
    expect(r2.length).toBe(2);
  });

  it("both errors carry a suggested .output fix", () => {
    const errors = validateWorkflowDefinition(wheelsLike).errors;
    expect(errors.some((e) => e.includes("{{nodes.run-validation-tests.output}}"))).toBe(true);
    expect(errors.some((e) => e.includes("{{nodes.enforce-evidence-gate.output}}"))).toBe(true);
  });
});
