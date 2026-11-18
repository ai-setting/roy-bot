/**
 * Task #2156 (A-path fix) — End-to-end test: prove that the actual
 * `roy-rd-with-trace.workflow.yaml`'s `tdd-implement` prompt, when the YAML's
 * own back-edge `code-review → tdd-implement` re-runs tdd-implement, receives
 * a resolved prompt that contains the previous code-review output via the
 * standard `{{nodes.code-review.*}}` template.
 *
 * Why this test:
 * - engine.ts:1405-1415 preserves the completed source node output during
 *   back-edge reset (minimal engine-only fix).
 * - We added Step 4.0.4 in `tdd-implement` prompt that references
 *   `{{nodes.code-review.review_status}}` and tells the agent to read the
 *   blocking findings via `task_operation_list`.
 * - This test loads the real YAML file (mocking agent types) and verifies
 *   end-to-end that:
 *     1. The tdd-implement prompt is resolved correctly with `nodes.*` data
 *        available to the agent on back-edge re-entry.
 *     2. `blocking_findings_addressed` schema field is present.
 *     3. The next run actually receives the previous review's blocking content.
 *
 * No real LLM is invoked; everything uses `mock-agent` via NodeRegistry stub.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';
import { WorkflowEngine } from './engine';
import { NodeRegistry } from './node-registry';
import type { NodeDefinition, WorkflowDefinition } from '../types';

// Test file: packages/core/src/env/workflow/engine/yaml-back-edge-review-e2e.test.ts
// YAML lives at worktree root. Resolve __dirname -> 6 levels up.
const WORKFLOW_YAML_PATH = resolve(
  __dirname,
  '..', // engine/ -> workflow/
  '..', // workflow/ -> env/
  '..', // env/ -> src/
  '..', // src/ -> core/
  '..', // core/ -> packages/
  '..', // packages/ -> worktree root
  'roy-rd-with-trace.workflow.yaml',
);

interface YamlNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  depends_on?: string[];
}

interface YamlDoc {
  name: string;
  version: string;
  config?: Record<string, unknown>;
  nodes: YamlNode[];
  edges: Array<{ from: string; to: string; when?: string }>;
}

// Build a WorkflowDefinition from the real YAML, restricted to the back-edge
// loop nodes (tdd-implement <-> code-review), plus a noop `plan` node (because
// tdd-implement depends_on plan in the real workflow). All agent types are
// replaced by `mock-agent`.
function buildRealYamlWorkflow(): WorkflowDefinition {
  const raw = readFileSync(WORKFLOW_YAML_PATH, 'utf-8');
  const parsed = yaml.parse(raw) as YamlDoc;

  // Take only the back-edge loop nodes. We strip depends_on so that the
  // sub-YAML does not require the full plan → setup-worktree → init-task
  // chain. Edge-driven ordering is sufficient for our test (entry=plan
  // starts the loop).
  const targetIds = new Set(['plan', 'tdd-implement', 'code-review']);
  const nodes: NodeDefinition[] = parsed.nodes
    .filter((n) => targetIds.has(n.id))
    .map(
      (n) =>
        ({
          id: n.id,
          type: 'mock-agent',
          config: (n.config as Record<string, unknown>) ?? {},
        }) as unknown as NodeDefinition,
    );

  // Take only the relevant edges.
  const edges = parsed.edges.filter(
    (e) =>
      (e.from === 'plan' && e.to === 'tdd-implement') ||
      (e.from === 'tdd-implement' && e.to === 'code-review') ||
      (e.from === 'code-review' && e.to === 'tdd-implement'),
  );

  const cfg = (parsed.config ?? {}) as Record<string, unknown>;

  return {
    name: parsed.name + '-e2e-mock',
    version: parsed.version,
    config: {
      loopEnabled: cfg.loopEnabled === undefined ? true : Boolean(cfg.loopEnabled),
      maxIterations: typeof cfg.maxIterations === 'number' ? cfg.maxIterations : 10,
      parallel_limit: null,
      timeout: null,
      debug: false,
      strict: false,
    } as WorkflowDefinition['config'],
    entry: 'plan',
    nodes,
    edges,
    inputs: {},
    outputs: [],
    metadata: { tags: [] },
  };
}

describe('roy-rd-with-trace YAML — back-edge review feedback consumption', () => {
  let tddPrompts: string[];
  let reviewPrompts: string[];
  let tddAttempts: number;
  let reviewAttempts: number;

  beforeEach(() => {
    tddPrompts = [];
    reviewPrompts = [];
    tddAttempts = 0;
    reviewAttempts = 0;
  });

  it('tdd-implement second execution receives resolved {{nodes.code-review.*}} content', async () => {
    const registry = new NodeRegistry();
    registry.register('mock-agent', (definition: NodeDefinition) => ({
      id: definition.id,
      type: definition.type,
      execute: async (ctx: any) => {
        // Capture the resolved prompt string the agent would receive.
        const prompt = String(ctx.resolvedConfig?.prompt ?? '');

        if (definition.id === 'plan') {
          // Noop — pass through with empty data.
          return { output: { plan_doc: '', expected_traces: [] } };
        }

        if (definition.id === 'tdd-implement') {
          tddAttempts += 1;
          tddPrompts.push(prompt);
          if (tddAttempts === 1) {
            return {
              output: {
                tdd_status: 'PASS',
                test_count_added: 0,
                test_count_passing: 0,
                pre_existing_failures: 0,
                files_modified: [],
                commits: ['baseline-sha-X'],
                blocking_findings_addressed: [],
                implemented_traces: [],
              },
            };
          }
          // Second run (back-edge re-entry): reproduce that the agent
          // consumed the review feedback by emitting addressed list.
          return {
            output: {
              tdd_status: 'PASS',
              test_count_added: 1,
              test_count_passing: 1,
              pre_existing_failures: 0,
              files_modified: [],
              commits: ['addressed-sha-Y'],
              blocking_findings_addressed: [
                {
                  id: 'fix back-edge stale output',
                  status: 'addressed',
                  note: 'addressed after re-entry consumption',
                },
              ],
              implemented_traces: [],
            },
          };
        }

        if (definition.id === 'code-review') {
          reviewAttempts += 1;
          reviewPrompts.push(prompt);
          if (reviewAttempts === 1) {
            // First code-review run: emit NEEDS_FIX with a blocking finding.
            return {
              output: {
                review_status: 'NEEDS_FIX',
                severity: {
                  blocking: ['fix back-edge stale output'],
                  important: [],
                  minor: [],
                  nit: [],
                },
                test_coverage: 'see step 4.4',
                api_design: 'see step 5.2',
                recommendation: 'consume nodes.code-review.* on re-entry',
                commits_reviewed: ['baseline-sha-X'],
              },
            };
          }
          // After re-entry, second code-review accepts the addressed list.
          return {
            output: {
              review_status: 'PASS',
              severity: { blocking: [], important: [], minor: [], nit: [] },
              test_coverage: 'ok',
              api_design: 'ok',
              recommendation: 'proceed',
              commits_reviewed: ['addressed-sha-Y'],
            },
          };
        }

        return { output: {} };
      },
    }));

    const engine = new WorkflowEngine(registry);
    const wf = buildRealYamlWorkflow();
    const result = await engine.runWorkflow(wf, {
      workflowInput: {
        task_id: 2156,
        project_path: '~',
        branch_name: 'fix-rd-review-loop-feedback',
        base_branch: 'main',
      },
    });

    // Workflow must complete successfully.
    expect(result.status).toBe('completed');

    // The full back-edge loop must run twice for each node.
    expect(tddAttempts).toBe(2);
    expect(reviewAttempts).toBe(2);

    // Step 4.0.4 introduces the back-edge guard. The {{nodes.code-review.*}}
    // template reference is in the prompt; on the second (back-edge) execution
    // it must be resolved to the actual code-review output values.
    const firstTddPrompt = tddPrompts[0]!;
    const secondTddPrompt = tddPrompts[1]!;

    // Both prompts contain the YAML's literal text "Step 4.0.4" etc.
    expect(firstTddPrompt).toContain('Step 4.0.4');
    expect(secondTddPrompt).toContain('Step 4.0.4');

    // CRITICAL: On the FIRST execution, the {{nodes.code-review.review_status}}
    // template MUST remain UNRESOLVED (since code-review has not run yet).
    // On the SECOND execution (after back-edge re-entry), it MUST be
    // RESOLVED to "NEEDS_FIX" — proving the engine filter preserves source.
    expect(firstTddPrompt).toContain('{{nodes.code-review.review_status}}');
    expect(secondTddPrompt).not.toContain('{{nodes.code-review.review_status}}');
    // Step 4.0.4 wraps the resolved value in backticks: "`NEEDS_FIX` 存在".
    expect(secondTddPrompt).toContain('`NEEDS_FIX`');

    // The Step 4.0.4 prompt text must reference the standard
    // `nodes.code-review.*` template and `task_operation_list` consumption
    // path. (Sanity check that the YAML actually contains our changes.)
    expect(secondTddPrompt).toContain('task_operation_list');
    expect(secondTddPrompt).toContain('blocking_findings_addressed');

    // Final workflow output must reflect the second-loop tdd-implement data.
    expect(result.status).toBe('completed');
    const tddOutput = (result.output?.['tdd-implement'] ?? {}) as {
      commits?: string[];
      blocking_findings_addressed?: Array<{
        id: string;
        status: string;
      }>;
    };
    expect(tddOutput.commits).toEqual(['addressed-sha-Y']);
    expect(tddOutput.blocking_findings_addressed?.[0]?.status).toBe('addressed');
  });

  it('roy-rd-with-trace YAML Step 4.0.4 prompt explicitly references nodes.code-review.* template', () => {
    // Read the raw YAML and verify the prompt contains the required
    // template + tool hooks. Catches accidental regressions in future
    // edits to the workflow file.
    const raw = readFileSync(WORKFLOW_YAML_PATH, 'utf-8');

    // Step 4.0.4 must exist inside the file (post-engine-fix extension).
    expect(raw).toContain('### Step 4.0.4');
    expect(raw).toContain('{{nodes.code-review.review_status}}');
    expect(raw).toContain('task_operation_list');
    expect(raw).toContain('action_type="review"');

    // Output schema must include blocking_findings_addressed.
    expect(raw).toContain('blocking_findings_addressed:');
    // ...and the property must be in properties (not just description).
    expect(raw).toMatch(/blocking_findings_addressed:\s*\n\s+type:\s*array/);
    // Items have {id, status, note}.
    expect(raw).toContain('"addressed" | "not_addressed" | "not_applicable"');

    // forbidden-review-specific-fields: must NOT re-introduce
    // loop.* templates or max_review_iterations / no_progress_guard.
    expect(raw).not.toContain('{{loop.feedback');
    expect(raw).not.toContain('{{loop.iteration_count');
    expect(raw).not.toContain('review_feedback_received');
    expect(raw).not.toContain('review_iteration');
    expect(raw).not.toContain('max_review_iterations');
    expect(raw).not.toContain('no_progress_guard');
  });
});
