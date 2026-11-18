/**
 * RED test (Task #2175): the `roy-rd-with-trace` workflow YAML must use a
 * *correct* trace_check SQL query.
 *
 * Observed bug (run workflow_1784498394013_fallback_reubfg):
 *   - cli-e2e-test repeatedly returned `cli_e2e_status=FAIL` even though
 *     build/test/cli_smoke all passed (build_ok=true, test_ok=true,
 *     cli_smoke_ok=true).
 *   - Root cause: prompt Step 6.1.5.2 contained
 *       `sqlite3 "$SPANS_DB" "SELECT DISTINCT trace_id FROM spans ORDER BY start_time DESC LIMIT 10"`
 *     (a) wrong table name: spans (plural) → span (singular is the actual table)
 *     (b) too-tight window: high-volume background traces (e.g.
 *         `task.background.stopProgressReporter`) fill the top-10 window
 *         and crowd out the user-app's `tool.component.execute` /
 *         `agent.component.executeTool` spans.
 *
 * Test strategy: load the YAML, parse with WorkflowDefinitionSchema,
 * find the cli-e2e-test node, extract ONLY SQL inside ```bash``` blocks
 * (i.e. actual commands the agent will run), and assert:
 *   1. No `FROM spans` (broken plural-table form) appears.
 *   2. Any `LIMIT N` is preceded by `WHERE name IN (...)` so background
 *      singletons cannot crowd out the user-app instrumentation spans.
 *
 * This is a RED regression test: it currently fails because the YAML
 * still contains the broken `FROM spans` / `LIMIT 10` query in the
 * Step 6.1.5.2 code block.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflowFile } from '../types/workflow';

const ROOT = path.resolve(__dirname, '../../../../../..');
const YAML_PATH = path.join(ROOT, 'workflows/roy-rd-with-trace.workflow.yaml');

/**
 * Extract every SQL string that appears inside a fenced bash code block
 * (````bash ... ````). We deliberately ignore inline comments and prose
 * so that documentation referencing the old broken query doesn't trip
 * the test.
 */
function extractSqlFromBashBlocks(prompt: string): string[] {
  const sqls: string[] = [];
  const re = /```bash\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const block = m[1];
    // Pull out every `"SELECT ... FROM ... ORDER BY ... LIMIT ..."` literal.
    const sqlRe = /"((?:SELECT|UPDATE|INSERT|DELETE)[^"]+)"/gi;
    let sm: RegExpExecArray | null;
    while ((sm = sqlRe.exec(block)) !== null) {
      sqls.push(sm[1]);
    }
  }
  return sqls;
}

describe('roy-rd-with-trace.workflow.yaml trace_check SQL (Task #2175)', () => {
  it('loads and parses the workflow YAML', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    expect(parsed.definition.name).toBe('roy-rd-with-trace');
  });

  it('cli-e2e-test node prompt must NOT use the broken table name "FROM spans"', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const cliE2eNode = parsed.definition.nodes.find((n: any) => n.id === 'cli-e2e-test');
    expect(cliE2eNode).toBeDefined();
    const prompt = (cliE2eNode as any)?.config?.prompt ?? '';

    const sqls = extractSqlFromBashBlocks(prompt);
    expect(sqls.length).toBeGreaterThan(0);

    for (const sql of sqls) {
      // RED assertion: the broken plural-table SQL must be gone.
      expect(sql).not.toMatch(/FROM\s+spans\b/i);
      // And the correct singular-table form must be present in trace_check SQL.
      if (/trace_id/i.test(sql)) {
        expect(sql).toMatch(/FROM\s+span\b/i);
      }
    }
  });

  it('cli-e2e-test trace_check query must guard any LIMIT by WHERE name IN', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const cliE2eNode = parsed.definition.nodes.find((n: any) => n.id === 'cli-e2e-test');
    const prompt = (cliE2eNode as any)?.config?.prompt ?? '';

    const sqls = extractSqlFromBashBlocks(prompt);
    expect(sqls.length).toBeGreaterThan(0);

    for (const sql of sqls) {
      if (/trace_id/i.test(sql) && /LIMIT\s+\d+/i.test(sql)) {
        // The vulnerable pattern: strict time-bracket window with no name filter.
        // The fix requires `WHERE name IN (<expected span names>)` to narrow
        // the candidate set BEFORE the LIMIT applies, so background singletons
        // cannot crowd out user-app instrumentation spans.
        expect(sql).toMatch(/WHERE\s+name\s+IN/i);
      }
    }
  });

  it('final-verify node must also avoid the broken FROM spans / bare LIMIT 10', async () => {
    const content = fs.readFileSync(YAML_PATH, 'utf-8');
    const parsed = await parseWorkflowFile(content, 'roy-rd-with-trace.workflow.yaml');
    const fvNode = parsed.definition.nodes.find((n: any) => n.id === 'final-verify');
    expect(fvNode).toBeDefined();
    const prompt = (fvNode as any)?.config?.prompt ?? '';

    const sqls = extractSqlFromBashBlocks(prompt);
    for (const sql of sqls) {
      expect(sql).not.toMatch(/FROM\s+spans\b/i);
      if (/trace_id/i.test(sql) && /LIMIT\s+\d+/i.test(sql)) {
        expect(sql).toMatch(/WHERE\s+name\s+IN/i);
      }
    }
  });
});