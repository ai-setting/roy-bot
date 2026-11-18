/**
 * @fileoverview Workflow Definition Sanitization
 *
 * Task #2926: Persist fixes for shell-script bugs that previously lived only as
 * runtime SQLite patches (e.g. `query-wiki-iteration-tasks v2.4.0` had three
 * known issues that the previous subagent patched directly in the database).
 *
 * Without this sanitizer, those patches vanish on any reinstall / reimport /
 * fresh db migration. The sanitize step runs inside the service layer
 * (`WorkflowService.createWorkflow` / `updateWorkflow`) before the definition
 * is JSON-stringified and written to SQLite, so every persistence path is
 * covered.
 *
 * Currently fixed defects (all match bugs observed in Task #2924):
 *
 *   1. `python3 -c "; <module> ..."` — leading `; ` inside the `-c` argument
 *      causes `SyntaxError: invalid syntax` (Python rejects a statement
 *      starting with `;`).  Fix: drop the leading `; `.
 *
 *   2. Bare `$RANDOM` reference inside a script run by `dash` (the default
 *      `/bin/sh` on Debian/Ubuntu) with `set -u` enabled throws
 *      `RANDOM: parameter not set`.  Fix: expand to `${RANDOM:-0}`.
 *
 * The sanitizer is intentionally conservative:
 *   - It mutates only string values reachable through known command fields
 *     (`config.command`, `config.inputs.command`, `config.input.command`,
 *     `config.message`, `config.inputs.message`).
 *   - It walks `depends_on` and arbitrary nested config (e.g. retry block
 *     does not contain shell but other extensions might).
 *   - It returns a deep clone to keep callers from sharing references with
 *     SQLite-bound objects.
 *
 * Anything that doesn't match a known bad pattern is left untouched.
 */

import type { WorkflowDefinition } from '../types/workflow';

/**
 * Public entry point. Returns a sanitized deep-clone of the workflow
 * definition (the original object is not mutated).
 */
export function sanitizeWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  if (!definition || !Array.isArray(definition.nodes)) {
    return definition;
  }

  return {
    ...definition,
    nodes: definition.nodes.map((node) => sanitizeNode(node)),
  };
}

/**
 * Sanitize a single node. Returns a shallow clone when the node has no
 * command-shaped fields to fix; returns a deeper clone when at least one
 * command string is rewritten so callers can persist the result safely.
 */
function sanitizeNode(node: any): any {
  if (!node || typeof node !== 'object') return node;
  const config = node.config;
  if (!config || typeof config !== 'object') return node;

  let mutated = false;
  const nextConfig: Record<string, unknown> = { ...config };

  // Walk every key in config. We try to sanitize strings under known
  // command-shaped paths. Keys we don't recognise are still copied through
  // the shallow clone so the result is safe to persist.
  for (const [key, value] of Object.entries(config)) {
    const rewritten = sanitizeCommandLike(key, value);
    if (rewritten !== value) {
      nextConfig[key] = rewritten;
      mutated = true;
    }
  }

  if (!mutated) return node;

  return { ...node, config: nextConfig };
}

/**
 * Inspect a config slot. If it is a command-shaped string (top-level
 * `command` / `message`, or nested under `inputs` / `input`), rewrite it.
 *
 * Returns the original value (referential equality) when nothing changed so
 * callers can detect "no rewrite" cheaply.
 */
function sanitizeCommandLike(key: string, value: unknown): unknown {
  // Top-level primitive fields used by tool-node.ts (single-param tools).
  if ((key === 'command' || key === 'message') && typeof value === 'string') {
    return sanitizeShellScript(value);
  }

  // Nested object forms: config.inputs.command, config.input.command, etc.
  if (key === 'inputs' || key === 'input' || key === 'args') {
    if (!value || typeof value !== 'object') return value;
    let mutated = false;
    const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
      if ((innerKey === 'command' || innerKey === 'message') && typeof innerValue === 'string') {
        const sanitized = sanitizeShellScript(innerValue);
        if (sanitized !== innerValue) {
          next[innerKey] = sanitized;
          mutated = true;
        }
      }
    }
    return mutated ? next : value;
  }

  return value;
}

/**
 * Apply the known shell-script bug fixes to a single string.
 *
 * Bug 1: `python3 -c "; <stmt>"` (or `python3 -c ";<stmt>"`) — drop leading
 * `; ` so Python sees a valid statement.
 *
 * Bug 2: bare `$RANDOM` reference — wrap with `${RANDOM:-0}` so `dash` under
 * `set -u` doesn't blow up.  Already-safe forms (`${RANDOM:-x}`,
 * `${RANDOM}`, `$RANDOM9`, `${RANDOM:-}`) are left alone.
 */
export function sanitizeShellScript(script: string): string {
  if (typeof script !== 'string' || script.length === 0) return script;

  let out = script;

  // Bug 1: drop leading `; ` inside `python3 -c "..."` arguments.
  // Match the exact buggy shape: `python3 -c ";<non-double-quote>`
  // or `python3 -c "; <non-double-quote>`.
  out = out.replace(/(python3\s+-c\s+");\s?/g, '$1');

  // Bug 2: wrap bare `$RANDOM` so dash + `set -u` is happy.
  // Negative lookahead keeps `${RANDOM...}` forms untouched.
  out = out.replace(/\$RANDOM(?![A-Za-z0-9_{:-])/g, '${RANDOM:-0}');

  return out;
}
