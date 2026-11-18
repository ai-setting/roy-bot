/**
 * TDD: colorWorkflowStatus / colorAgentSessionStatus — must support 'failed' and 'stopped' (Task #2178 BUG-CLI)
 *
 * Strategy: import the color helpers directly. They wrap chalk functions, so we
 * verify the returned function is callable and that the input string passes
 * through (chalk may add ANSI codes in test env, so we check the input appears
 * within the result).
 */

import { describe, it, expect } from 'bun:test';
import chalk from 'chalk';
import {
  colorWorkflowStatus,
  colorAgentSessionStatus,
} from './get';

describe('colorWorkflowStatus — extended status palette (Task #2178)', () => {
  it('returns a function for every supported status', () => {
    expect(typeof colorWorkflowStatus('running')).toBe('function');
    expect(typeof colorWorkflowStatus('paused')).toBe('function');
    expect(typeof colorWorkflowStatus('completed')).toBe('function');
    expect(typeof colorWorkflowStatus('failed')).toBe('function');
    expect(typeof colorWorkflowStatus('stopped')).toBe('function');
  });

  it('failed uses red color (matches chalk.red semantics)', () => {
    const fn = colorWorkflowStatus('failed');
    const out = fn('failed');
    // chalk.red('failed') wraps in ANSI red; should at least contain 'failed'
    expect(out).toContain('failed');
    // The wrapper should be chalk.red (i.e., produce the same output as chalk.red)
    expect(out).toBe(chalk.red('failed'));
  });

  it('stopped uses magenta color', () => {
    const fn = colorWorkflowStatus('stopped');
    const out = fn('stopped');
    expect(out).toContain('stopped');
    expect(out).toBe(chalk.magenta('stopped'));
  });

  it('running uses green', () => {
    expect(colorWorkflowStatus('running')('running')).toBe(chalk.green('running'));
  });

  it('paused uses yellow', () => {
    expect(colorWorkflowStatus('paused')('paused')).toBe(chalk.yellow('paused'));
  });

  it('completed uses gray', () => {
    expect(colorWorkflowStatus('completed')('completed')).toBe(chalk.gray('completed'));
  });
});

describe('colorAgentSessionStatus — extended status palette (Task #2178)', () => {
  it('returns a function for every supported status', () => {
    expect(typeof colorAgentSessionStatus('active')).toBe('function');
    expect(typeof colorAgentSessionStatus('paused')).toBe('function');
    expect(typeof colorAgentSessionStatus('completed')).toBe('function');
    expect(typeof colorAgentSessionStatus('failed')).toBe('function');
    expect(typeof colorAgentSessionStatus('stopped')).toBe('function');
  });

  it('failed uses red', () => {
    expect(colorAgentSessionStatus('failed')('failed')).toBe(chalk.red('failed'));
  });

  it('stopped uses magenta', () => {
    expect(colorAgentSessionStatus('stopped')('stopped')).toBe(chalk.magenta('stopped'));
  });

  it('active uses green', () => {
    expect(colorAgentSessionStatus('active')('active')).toBe(chalk.green('active'));
  });

  it('paused uses yellow', () => {
    expect(colorAgentSessionStatus('paused')('paused')).toBe(chalk.yellow('paused'));
  });

  it('completed uses gray', () => {
    expect(colorAgentSessionStatus('completed')('completed')).toBe(chalk.gray('completed'));
  });
});

// =========================================================================
// User-reported scenario: end-to-end color verification (Task #2178)
// =========================================================================

describe('User-reported scenario — end-to-end color (Task #2178)', () => {
  it('renders the exact workflow_1784508256666_fallback_hry0kq data with correct colors', () => {
    // User observed:
    //   workflow.status = 'stopped'
    //   agentSessions[0] = { nodeId: 'init-task', status: 'active' }
    //   agentSessions[1] = { nodeId: 'plan',      status: 'paused' }
    // After the fix, CLI must render:
    //   - status='stopped'   in magenta
    //   - agent.status='active' in green
    //   - agent.status='paused' in yellow
    const statusColor = colorWorkflowStatus('stopped');
    const initTaskColor = colorAgentSessionStatus('active');
    const planColor = colorAgentSessionStatus('paused');

    expect(statusColor('stopped')).toBe(chalk.magenta('stopped'));
    expect(initTaskColor('active')).toBe(chalk.green('active'));
    expect(planColor('paused')).toBe(chalk.yellow('paused'));
  });

  it('renders the post-fix state (after node.completed + stop) with correct colors', () => {
    // After fix is deployed and a new workflow is run + stopped:
    //   - workflow.status = 'stopped' (magenta)
    //   - agentSessions[0] = { nodeId: 'init-task', status: 'completed' } (gray)
    //   - agentSessions[1] = { nodeId: 'plan',      status: 'stopped'   } (magenta)
    const statusColor = colorWorkflowStatus('stopped');
    const initTaskColor = colorAgentSessionStatus('completed');
    const planColor = colorAgentSessionStatus('stopped');

    expect(statusColor('stopped')).toBe(chalk.magenta('stopped'));
    expect(initTaskColor('completed')).toBe(chalk.gray('completed'));
    expect(planColor('stopped')).toBe(chalk.magenta('stopped'));
  });
});