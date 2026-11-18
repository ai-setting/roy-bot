#!/usr/bin/env bun
/**
 * Verify task-pev-agent scenarios:
 * 1. interrupt + resume (ask_user at plan)
 * 2. verify FAILED → loop back to plan (plan sub-session keeps history)
 *
 * Usage: bun run scripts/verify-task-pev-scenarios.ts
 */

import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const CLI = resolve(ROOT, 'packages/cli/dist/bin/roy-bot.js');
const WORKFLOW = resolve(ROOT, 'workflows/task-pev-agent.workflow.yaml');
const DB_PATH = `${process.env.HOME}/.local/share/roy-bot/sessions.db`;

function runWorkflow(opts: {
  sessionId?: string;
  input?: string;
  task?: string;
}): { ok: boolean; stdout: string; status?: string; runId?: string } {
  const cmd = [CLI, 'workflow', 'run'];

  if (opts.sessionId) {
    cmd.push('task-pev-agent', '--session-id', opts.sessionId);
    if (opts.input) cmd.push('--input', opts.input);
  } else {
    cmd.push(WORKFLOW, '--file', '--input', JSON.stringify({ task: opts.task }));
  }

  const result = spawnSync('bun', cmd, { encoding: 'utf-8', cwd: ROOT });
  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const statusMatch = stdout.match(/Workflow (paused|completed successfully)/);
  const runIdMatch = stdout.match(/Run ID: (\S+)/);

  return {
    ok: result.status === 0,
    stdout,
    status:
      statusMatch?.[1] === 'completed successfully' ? 'completed' : statusMatch?.[1],
    runId: runIdMatch?.[1],
  };
}

function wfSessionId(runId: string): string {
  return runId.startsWith('workflow_') ? runId : `workflow_${runId}`;
}

function getAgentSessions(wfId: string) {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db
    .query<{ agentSessions: string | null }, [string]>(
      `SELECT json_extract(metadata,'$.agentSessions') as agentSessions FROM session WHERE id = ?`
    )
    .get(wfId);
  db.close();
  if (!row?.agentSessions) return [] as Array<{ nodeId: string; sessionId: string }>;
  return JSON.parse(row.agentSessions) as Array<{ nodeId: string; sessionId: string }>;
}

function getSubSessionMessages(sessionId: string) {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .query<{ rowid: number; role: string; content: string }, [string]>(
      `SELECT rowid, role, content FROM message WHERE session_id = ? ORDER BY rowid`
    )
    .all(sessionId);
  db.close();
  return rows;
}

function getWorkflowMessages(wfId: string) {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .query<{ role: string; content: string; type: string | null; nodeId: string | null }, [string]>(
      `SELECT role, substr(content,1,120) as content,
              json_extract(metadata,'$.type') as type,
              json_extract(metadata,'$.nodeId') as nodeId
       FROM message WHERE session_id = ? ORDER BY rowid`
    )
    .all(wfId);
  db.close();
  return rows;
}

console.log('='.repeat(60));
console.log('Scenario 1: interrupt + resume');
console.log('='.repeat(60));

const s1First = runWorkflow({ task: 'Build something useful' });
console.log(s1First.stdout.split('\n').slice(-8).join('\n'));

if (s1First.status !== 'paused' || !s1First.runId) {
  console.error('❌ Expected paused at plan ask_user');
  process.exit(1);
}
console.log('✅ Paused as expected');

const s1Resume = runWorkflow({
  sessionId: s1First.runId,
  input: 'A simple todo list web app with add and delete',
});
console.log(s1Resume.stdout.split('\n').slice(-6).join('\n'));

if (s1Resume.status !== 'completed') {
  console.error('❌ Expected completed after resume');
  process.exit(1);
}
console.log('✅ Resume completed workflow');

const s1Wf = wfSessionId(s1First.runId);
const s1Plan = getAgentSessions(s1Wf).find((s) => s.nodeId === 'plan');
if (!s1Plan) {
  console.error('❌ plan sub-session not found');
  process.exit(1);
}
const s1Msgs = getSubSessionMessages(s1Plan.sessionId);
console.log(`\nplan sub-session (${s1Plan.sessionId}): ${s1Msgs.length} messages`);
for (const m of s1Msgs) {
  console.log(`  [${m.rowid}] ${m.role}: ${m.content.slice(0, 100).replace(/\n/g, ' ')}`);
}
const hasAskUser = s1Msgs.some((m) => m.role === 'tool' || m.role === 'assistant');
const hasUserResume = s1Msgs.some((m) => m.role === 'user');
if (!hasAskUser || !hasUserResume) {
  console.error('❌ plan history missing ask_user or resume user message');
  process.exit(1);
}
console.log('✅ plan sub-session has ask_user + resume history\n');

console.log('='.repeat(60));
console.log('Scenario 2: verify FAILED → re-plan (same plan sub-session history)');
console.log('='.repeat(60));

const failTask =
  'Create a 3-step checklist for making tea. [strict-verify:__REQUIRED_EXEC_TOKEN__]';

const s2First = runWorkflow({ task: failTask });
console.log(s2First.stdout.split('\n').slice(-20).join('\n'));

const s2Wf = wfSessionId(s2First.runId!);
const wfMsgs = getWorkflowMessages(s2Wf);

const planStarts = wfMsgs.filter(
  (m) => m.type === 'workflow.node.start' && m.nodeId === 'plan'
);
const verifyEnds = wfMsgs.filter(
  (m) => m.type === 'workflow.node.end' && m.nodeId === 'verify'
);

console.log(`\nWorkflow message stats:`);
console.log(`  plan starts: ${planStarts.length}`);
console.log(`  verify ends: ${verifyEnds.length}`);
console.log(`  workflow status: ${s2First.status ?? 'unknown'}`);

const planRanTwice = planStarts.length >= 2;
const verifyFailedOnce =
  s2First.stdout.includes('"passed": false') ||
  s2First.stdout.includes('"passed":false') ||
  s2First.stdout.includes('"result": "FAILED"') ||
  wfMsgs.some(
    (m) =>
      m.nodeId === 'verify' &&
      (m.content.includes('"passed": false') ||
        m.content.includes('"passed":false') ||
        m.content.includes('FAILED'))
  );

if (!s2First.runId) {
  console.error('❌ No runId');
  process.exit(1);
}

const s2Plan = getAgentSessions(s2Wf).find((s) => s.nodeId === 'plan');
if (!s2Plan) {
  console.error('❌ plan sub-session not found');
  process.exit(1);
}

const s2Msgs = getSubSessionMessages(s2Plan.sessionId);
console.log(`\nplan sub-session (${s2Plan.sessionId}): ${s2Msgs.length} messages`);
for (const m of s2Msgs) {
  console.log(`  [${m.rowid}] ${m.role}: ${m.content.slice(0, 120).replace(/\n/g, ' ')}`);
}

const assistantTurns = s2Msgs.filter((m) => m.role === 'assistant').length;
if (planRanTwice && assistantTurns < 2) {
  console.error('❌ plan ran twice in workflow but sub-session has < 2 assistant turns');
  process.exit(1);
}

if (planRanTwice && assistantTurns >= 2) {
  console.log('✅ verify FAILED loop triggered second plan run');
  console.log(`✅ plan sub-session reused (${s2Plan.sessionId}) with ${assistantTurns} assistant turn(s)`);
} else if (verifyFailedOnce && planRanTwice) {
  console.log('✅ verify returned FAILED and plan re-ran');
} else {
  console.error('❌ FAILED loop not observed (need plan starts >= 2 and growing sub-session history)');
  process.exit(1);
}

console.log('\n' + '='.repeat(60));
console.log('Summary');
console.log('='.repeat(60));
console.log('✅ Scenario 1: interrupt + resume — PASS');
console.log('✅ Scenario 2: FAILED loop + plan history — PASS');
