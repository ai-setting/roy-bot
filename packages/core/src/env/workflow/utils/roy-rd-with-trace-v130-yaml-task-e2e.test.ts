/**
 * RED test (Task #2241): roy-rd-with-trace v1.3.0 must include
 * Step 6.0.5 — dependency pre-scan (fail-fast before build/test).
 *
 * Rationale:
 *   - v1.2.0's CLI E2E pipeline started with `bun install` only as a
 *     side-effect of `bun test` — if a transitive dependency (e.g. chalk)
 *     was missing, build/test/cli_smoke all crashed with
 *     "Cannot find module 'X'" only AFTER the failure was hard to
 *     diagnose. The trace_check + task_e2e stages were silently
 *     skipped because the upstream gate failed.
 *   - v1.3.0 adds:
 *     (a) Step 6.0.5 dependency pre-check, executed BEFORE build/test
 *     (b) Auto `bun install` + chalk sub-dep validation + retry rule
 *     (c) `prescanWorkflowFile` static analysis: detects 4 kinds of
 *         dependency inconsistency in workflow YAMLs (depends_on missing
 *         node, edges missing node, edges↔depends_on direction
 *         mismatch, entry node missing)
 *     (d) `prescan_status` field in cli-e2e-test output schema;
 *         FAIL → fail-fast, skip build/test/cli_smoke/trace_check
 *
 * Strategy: load the YAML, parse with WorkflowDefinitionSchema, and assert:
 *   - workflow version is "1.3.0"
 *   - cli-e2e-test prompt contains:
 *       * "Step 6.0.5" (or "依赖前置检查" / "依赖一致性检查")
 *       * `prescanWorkflowFile` reference
 *       * `prescan_status` schema field
 *       * `bun install` mention with chalk validation
 *   - cli-e2e-test schema has `prescan_status` field
 *   - description includes v1.3.0 changelog entry
 *   - dependency-prescan.ts file exists with the 4 check functions
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflowFile } from '../types/workflow';

const ROOT = path.resolve(__dirname, '../../../../../..');
const YAML_PATH = path.join(ROOT, 'workflows/roy-rd-with-trace.workflow.yaml');
const PRESCAN_PATH = path.join(
  ROOT,
  'packages/core/src/env/workflow/utils/dependency-prescan.ts'
);

describe('roy-rd-with-trace.workflow.yaml v1.3.0 task-specific E2E', () => {
  it('workflow version is bumped to 1.3.0', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    expect(parsed.definition.version).toBe('1.3.0');
  });

  it('description changelog lists v1.3.0 entry', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const expectContainsV130Changelog =
      /v1\.3\.0[\s\S]*(?:Step 6\.0\.5|依赖前置检查|dependency-prescan)/m.test(
        content
      );
    expect(expectContainsV130Changelog).toBe(true);
  });

  it('cli-e2e-test prompt includes Step 6.0.5 dependency pre-check', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    // Look for the section headers (### Step 6.0.5 / ### Step 6.1) within the
    // cli-e2e-test prompt specifically, not the v1.2.0 changelog that mentions
    // "Step 6.1.6" earlier.
    const cliE2ESectionStart = content.indexOf('id: cli-e2e-test');
    expect(cliE2ESectionStart).toBeGreaterThan(-1);
    const cliE2ESlice = content.slice(cliE2ESectionStart);

    const step605Idx = cliE2ESlice.indexOf('### Step 6.0.5');
    const step61Idx = cliE2ESlice.indexOf('### Step 6.1');
    expect(step605Idx).toBeGreaterThan(-1);
    expect(step61Idx).toBeGreaterThan(-1);
    expect(step605Idx).toBeLessThan(step61Idx); // 6.0.5 must come before 6.1
  });

  it('cli-e2e-test prompt references prescanWorkflowFile', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    expect(content).toContain('prescanWorkflowFile');
    expect(content).toContain('dependency-prescan');
  });

  it('cli-e2e-test prompt mentions bun install + chalk validation', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    expect(content).toMatch(/bun install/);
    expect(content).toMatch(/chalk/);
  });

  it('cli-e2e-test schema has prescan_status field', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');

    const cliE2ENode = parsed.definition.nodes.find(
      (n: any) => n.id === 'cli-e2e-test'
    );
    expect(cliE2ENode).toBeTruthy();

    const schemaProps =
      (cliE2ENode as any)?.config?.output?.schema?.properties ?? {};
    expect(schemaProps).toHaveProperty('prescan_status');
    expect(schemaProps).toHaveProperty('prescan_findings');
  });

  it('dependency-prescan.ts file exists with the 4 check functions', () => {
    expect(fs.existsSync(PRESCAN_PATH)).toBe(true);
    const content = fs.readFileSync(PRESCAN_PATH, 'utf-8');
    expect(content).toMatch(/checkDependsOnNodesExist/);
    expect(content).toMatch(/checkEdgesNodesExist/);
    expect(content).toMatch(/checkEdgesDependsOnConsistency/);
    expect(content).toMatch(/checkEntryNodeExists/);
    expect(content).toMatch(/prescanWorkflowFile/);
  });

  it('prescan status FAIL → cli_e2e_status FAIL fail-fast rule documented', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    // The rule: prescan FAIL → skip build/test/cli_smoke/trace_check
    expect(content).toMatch(/prescan_status.*FAIL/);
    expect(content).toMatch(/fail-fast|fail.fast/);
  });
});
