#!/usr/bin/env bun
/**
 * Reproduce verify FAILED → re-plan loop until maxIterations.
 *
 * Usage: bun run scripts/verify-task-pev-fail-loop.ts
 *
 * Success signals (strict-verify token never appears in execute output):
 * - plan node started >= 2 times (loop observed)
 * - plan starts <= maxIterations + 1 (yaml maxIterations=5 → at most 6)
 * - workflow ends with "exceeded maximum loop iterations" (failed), OR completed after verify passed
 */

import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const CLI = resolve(ROOT, 'packages/cli/dist/bin/roy-bot.js');
const WORKFLOW = resolve(ROOT, 'workflows/task-pev-agent.workflow.yaml');
const DB_PATH = `${process.env.HOME}/.local/share/roy-bot/sessions.db`;
/** Must match task-pev-agent.workflow.yaml config.maxIterations */
const MAX_LOOP_ITERATIONS = 5;

/** Clear task + strict-verify token execute will never include */
const FAIL_LOOP_TASK =
  'Create a 3-step checklist for making black tea: boil water, steep 3 minutes, serve. ' +
  '[strict-verify:__REQUIRED_EXEC_TOKEN__]';

const cmd = [
  CLI,
  'workflow',
  'run',
  WORKFLOW,
  '--file',
  '--input',
  JSON.stringify({ task: FAIL_LOOP_TASK }),
];

console.log('🔄 Reproducing verify FAILED → re-plan loop');
console.log(`   task: ${FAIL_LOOP_TASK}\n`);

const result = spawnSync('bun', cmd, { encoding: 'utf-8', cwd: ROOT });
const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(stdout);

const runId = stdout.match(/Run ID: (\S+)/)?.[1];
if (!runId) {
  console.error('\n❌ No runId in output');
  process.exit(1);
}

const wfId = runId.startsWith('workflow_') ? runId : `workflow_${runId}`;
const db = new Database(DB_PATH, { readonly: true });

const planStarts = db
  .query<{ n: number }, [string]>(
    `SELECT count(*) as n FROM message
     WHERE session_id = ? AND json_extract(metadata,'$.type') = 'workflow.node.start'
       AND json_extract(metadata,'$.nodeId') = 'plan'`
  )
  .get(wfId)?.n ?? 0;

const verifyEnds = db
  .query<{ content: string }[], [string]>(
    `SELECT content FROM message
     WHERE session_id = ? AND json_extract(metadata,'$.type') = 'workflow.node.end'
       AND json_extract(metadata,'$.nodeId') = 'verify'
     ORDER BY rowid`
  )
  .all(wfId);

const planSession = db
  .query<{ sessionId: string | null }, [string]>(
    `SELECT json_extract(value,'$.sessionId') as sessionId
     FROM session, json_each(json_extract(metadata,'$.agentSessions'))
     WHERE session.id = ? AND json_extract(value,'$.nodeId') = 'plan'`
  )
  .get(wfId)?.sessionId;

let planMsgCount = 0;
if (planSession) {
  planMsgCount =
    db
      .query<{ n: number }, [string]>(
        `SELECT count(*) as n FROM message WHERE session_id = ?`
      )
      .get(planSession)?.n ?? 0;
}

db.close();

console.log('\n--- Loop check ---');
console.log(`  plan starts (workflow): ${planStarts}`);
console.log(`  verify ends:          ${verifyEnds.length}`);
console.log(`  plan sub-session:     ${planSession ?? 'n/a'} (${planMsgCount} messages)`);
const failedAtMaxIterations = stdout.includes('exceeded maximum loop iterations');
const completedOk = stdout.includes('completed successfully');
console.log(
  `  workflow status:      ${completedOk ? 'completed' : failedAtMaxIterations ? 'failed (max iterations)' : stdout.includes('paused') ? 'paused' : 'other'}`
);

const sawFailedInOutput =
  stdout.includes('"passed": false') ||
  stdout.includes('"passed":false') ||
  stdout.includes('"result": "FAILED"');
const loopObserved = planStarts >= 2;
const withinMaxIterations = planStarts <= MAX_LOOP_ITERATIONS + 1;
/** With re-run user hints: ~2 * planStarts - 1 messages in the same sub-session */
const expectedPlanMsgRange = [planStarts, planStarts * 2 - 1];

if (loopObserved && withinMaxIterations) {
  console.log('\n✅ Re-plan loop observed (plan ran >= 2 times)');
  console.log(`✅ Plan starts within maxIterations cap (${planStarts} <= ${MAX_LOOP_ITERATIONS + 1})`);
  if (failedAtMaxIterations) {
    console.log('✅ Workflow stopped at maxIterations (verify never passed strict token check)');
  }
  if (planMsgCount >= 2) {
    console.log(`✅ Same plan sub-session accumulated history (${planMsgCount} messages)`);
    if (planMsgCount < expectedPlanMsgRange[0] || planMsgCount > expectedPlanMsgRange[1]) {
      console.log(
        `   ℹ️  Expected ~${expectedPlanMsgRange[0]}-${expectedPlanMsgRange[1]} messages (assistant + re-run user hints)`
      );
    }
  }
  process.exit(0);
}

if (loopObserved && !withinMaxIterations) {
  console.error(
    `\n❌ Loop ran too many times: plan starts=${planStarts}, max allowed=${MAX_LOOP_ITERATIONS + 1}`
  );
  process.exit(1);
}

if (sawFailedInOutput && planStarts === 1) {
  console.log('\n⚠️  verify returned FAILED once but plan did not re-run.');
  console.log('   Check loopEnabled and edges in task-pev-agent.workflow.yaml');
  process.exit(1);
}

console.log('\n❌ No re-plan loop observed.');
console.log('   Common causes:');
console.log('   1. verify returned PASSED (LLM ignored [strict-verify:TOKEN])');
console.log('   2. paused at plan ask_user before reaching verify — use the task above');
console.log('   3. stale workflow — always use task-pev-agent.workflow.yaml --file');
process.exit(1);
