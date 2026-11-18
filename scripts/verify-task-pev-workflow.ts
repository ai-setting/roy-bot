#!/usr/bin/env bun
/**
 * Verify task-pev-agent workflow via CLI (fresh run + optional resume loop).
 *
 * Usage:
 *   bun run scripts/verify-task-pev-workflow.ts
 *   bun run scripts/verify-task-pev-workflow.ts --resume <runId> --input "Yes"
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../packages/cli/dist/bin/roy-bot.js');
const WORKFLOW = resolve(import.meta.dir, '../task-pev-agent.workflow.yaml');

const DEFAULT_TASK =
  'Build a 3-step checklist for making tea, including safety note about hot water';

function parseArgs() {
  const args = process.argv.slice(2);
  let sessionId: string | undefined;
  let input: string | undefined;
  let task = DEFAULT_TASK;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id' || args[i] === '--resume') {
      sessionId = args[++i];
    } else if (args[i] === '--input') {
      input = args[++i];
    } else if (args[i] === '--task') {
      task = args[++i];
    }
  }

  return { sessionId, input, task };
}

function runWorkflow(opts: {
  sessionId?: string;
  input?: string;
  task?: string;
}): { ok: boolean; stdout: string; status?: string; runId?: string } {
  const cmd = [CLI, 'workflow', 'run'];

  if (opts.sessionId) {
    cmd.push('task-pev-agent', '--session-id', opts.sessionId);
    if (opts.input) {
      cmd.push('--input', opts.input);
    }
  } else {
    cmd.push(WORKFLOW, '--file', '--input', JSON.stringify({ task: opts.task }));
  }

  const result = spawnSync('bun', cmd, {
    encoding: 'utf-8',
    cwd: resolve(import.meta.dir, '..'),
  });

  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const statusMatch = stdout.match(/Workflow (paused|completed successfully)/);
  const runIdMatch = stdout.match(/Run ID: (\S+)/);

  return {
    ok: result.status === 0,
    stdout,
    status: statusMatch?.[1] === 'completed successfully' ? 'completed' : statusMatch?.[1],
    runId: runIdMatch?.[1],
  };
}

const { sessionId, input, task } = parseArgs();

if (sessionId) {
  console.log(`🔄 Resuming session ${sessionId} with input: ${input ?? '(none)'}`);
  const result = runWorkflow({ sessionId, input });
  console.log(result.stdout);
  process.exit(result.ok ? 0 : 1);
}

console.log('🚀 Fresh run task-pev-agent workflow');
console.log(`   Task: ${task}\n`);

const first = runWorkflow({ task });
console.log(first.stdout);

if (!first.ok) {
  console.error('❌ CLI failed');
  process.exit(1);
}

if (first.status === 'completed') {
  console.log('\n✅ Workflow completed on first run');
  process.exit(0);
}

if (first.status === 'paused' && first.runId) {
  console.log('\n⏸ Workflow paused (likely ask_user). Auto-resuming with "Proceed with defaults"...');
  const second = runWorkflow({
    sessionId: first.runId,
    input: 'Proceed with reasonable defaults for anything unclear',
  });
  console.log(second.stdout);

  if (second.status === 'completed') {
    console.log('\n✅ Workflow completed after resume');
    process.exit(0);
  }

  if (second.status === 'paused' && second.runId) {
    console.log('\n⏸ Still paused. Resume manually:');
    console.log(
      `   bun run workflow:pev -- --session-id ${second.runId} --input "<your answer>"`
    );
    process.exit(0);
  }
}

console.error('\n❌ Unexpected workflow state');
process.exit(1);
