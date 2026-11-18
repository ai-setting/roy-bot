/**
 * RED test (Task #XXXX): roy-rd-with-trace v1.2.0 must include
 * task-specific CLI E2E verification + Bun-runtime CLI rule.
 *
 * Rationale:
 *   - v1.1.0 only runs `cli_smoke_command` (default: `...roy-bot.js --help`)
 *     which is too shallow — it never exercises the code path the task actually
 *     changed.
 *   - v1.2.0 adds:
 *     (a) inputs.task_e2e_commands  — explicit list of task-related CLI commands
 *     (b) plan 阶段产出 task_e2e_commands 姊妹字段 (next to expected_traces)
 *     (c) cli-e2e-test Step 6.1.6   — runs each command + validates via
 *                                       log / debug trace / debug span
 *     (d) final-verify 第 10 项     — task_specific_e2e_passes 独立复跑
 *     (e) Bun 跑 CLI 铁律            — in BOTH cli-e2e-test and final-verify
 *                                       prompts (the dist CLI is bun-runtime,
 *                                       must NOT be invoked via bash/node)
 *
 * Strategy: load the YAML, parse with WorkflowDefinitionSchema, and assert:
 *   - workflow version is "1.2.0"
 *   - inputs has `task_e2e_commands`
 *   - plan node schema has `task_e2e_commands` (or equivalent field)
 *   - cli-e2e-test prompt contains:
 *       * "Bun 跑 CLI" (or "Bun runtime") rule
 *       * "bun packages/cli/dist/bin/roy-bot.js" full command example
 *       * Step 6.1.6 (or "任务相关" / "task_e2e" markers)
 *   - cli-e2e-test schema has `task_e2e_status` (or equivalent)
 *   - final-verify prompt contains:
 *       * "Bun 跑 CLI" rule
 *       * `task_specific_e2e_passes` checklist item
 *   - final-verify schema has the matching field
 *   - NO `node packages/cli/dist/bin/roy-bot.js` (wrong runtime) appears
 *     in the bun-cli examples
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflowFile } from '../types/workflow';

const ROOT = path.resolve(__dirname, '../../../../../..');
const YAML_PATH = path.join(ROOT, 'workflows/roy-rd-with-trace.workflow.yaml');

describe('roy-rd-with-trace.workflow.yaml task-specific E2E (v1.2.0 — backward compat)', () => {
  it('workflow version is bumped to >=1.2.0 (1.2.0 or 1.3.0)', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    // v1.3.0 (Task #2241) is a backward-compatible upgrade that adds
    // Step 6.0.5 dependency prescan. v1.2.0 features (task_e2e_commands,
    // Bun-runtime CLI rule) must remain present in v1.3.0.
    expect(['1.2.0', '1.3.0']).toContain(parsed.definition.version);
  });

  it('inputs declares task_e2e_commands', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const inputs = (parsed.definition as any).inputs ?? {};
    expect(inputs).toHaveProperty('task_e2e_commands');
  });

  it('plan node schema includes task_e2e_commands field', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const planNode = parsed.definition.nodes.find((n: any) => n.id === 'plan');
    expect(planNode).toBeDefined();
    const schemaProps =
      (planNode as any)?.config?.output?.schema?.properties ?? {};
    const propNames = Object.keys(schemaProps);
    expect(propNames.some((k) => /task_e2e/i.test(k))).toBe(true);
  });

  it('plan node prompt instructs producing task_e2e_commands', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const planNode = parsed.definition.nodes.find((n: any) => n.id === 'plan');
    const prompt = (planNode as any)?.config?.prompt ?? '';
    expect(prompt).toMatch(/task_e2e_commands/i);
  });

  it('cli-e2e-test prompt includes Bun-runtime CLI rule', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const node = parsed.definition.nodes.find((n: any) => n.id === 'cli-e2e-test');
    const prompt = (node as any)?.config?.prompt ?? '';
    // Must mention the bun-runtime rule explicitly
    expect(prompt).toMatch(/Bun 跑 CLI|bun runtime|bun-runtime/i);
    // Must include the canonical full command
    expect(prompt).toMatch(/bun packages\/cli\/dist\/bin\/roy-bot\.js/);
  });

  it('cli-e2e-test prompt includes a Step that runs task-specific CLI commands', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const node = parsed.definition.nodes.find((n: any) => n.id === 'cli-e2e-test');
    const prompt = (node as any)?.config?.prompt ?? '';
    // Either Step 6.1.6 or a labelled "任务相关 CLI E2E" / "task-specific" section
    expect(prompt).toMatch(/6\.1\.6|任务相关 CLI E2E|task[ _-]?specific|task_e2e/i);
  });

  it('cli-e2e-test schema includes task_e2e_status (or equivalent) field', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const node = parsed.definition.nodes.find((n: any) => n.id === 'cli-e2e-test');
    const props = (node as any)?.config?.output?.schema?.properties ?? {};
    const propNames = Object.keys(props);
    expect(propNames.some((k) => /task_e2e/i.test(k))).toBe(true);
  });

  it('final-verify prompt includes Bun-runtime CLI rule', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const node = parsed.definition.nodes.find((n: any) => n.id === 'final-verify');
    const prompt = (node as any)?.config?.prompt ?? '';
    expect(prompt).toMatch(/Bun 跑 CLI|bun runtime|bun-runtime/i);
    expect(prompt).toMatch(/bun packages\/cli\/dist\/bin\/roy-bot\.js/);
  });

  it('final-verify checklist adds task_specific_e2e_passes item', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const node = parsed.definition.nodes.find((n: any) => n.id === 'final-verify');
    const props = (node as any)?.config?.output?.schema?.properties ?? {};
    const checklist = props.checklist ?? {};
    const items = Object.keys(checklist.properties ?? {});
    expect(items).toContain('task_specific_e2e_passes');
  });

  it('no prompt tells the agent to invoke the dist CLI via node', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const offenders: string[] = [];
    for (const node of parsed.definition.nodes) {
      const prompt = (node as any)?.config?.prompt ?? '';
      if (/^\s*node\s+packages\/cli\/dist\/bin\/roy-bot\.js/m.test(prompt)) {
        offenders.push((node as any).id);
      }
    }
    expect(offenders).toEqual([]);
  });
});
