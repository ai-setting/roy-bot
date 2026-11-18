/**
 * @fileoverview Tests for Task #2926 workflow-definition sanitizer.
 *
 * These tests are written FIRST (RED), then the sanitizer is implemented.
 *
 * Bug repros come from Task #2924's runtime SQLite patch of
 * `query-wiki-iteration-tasks v2.4.0`:
 *   - Line 138: `python3 -c "; import json, sys; ..."` → SyntaxError
 *   - Line 149: `python3 -c "; import secrets, hashlib, base64; ..."` → SyntaxError
 *   - Line 152: `STATE="roys-$(date +%s)-$RANDOM"` → dash + set -u crashes
 */

import { describe, expect, test } from 'bun:test';
import {
  sanitizeShellScript,
  sanitizeWorkflowDefinition,
} from './workflow-sanitize';

describe('sanitizeShellScript — bug 1 (python3 -c "; ...")', () => {
  test('drops leading "; " inside python3 -c "..." argument', () => {
    const input = 'python3 -c "; import json, sys; print(json.dumps({\\"k\\": 1}))"';
    const out = sanitizeShellScript(input);
    expect(out).toBe('python3 -c "import json, sys; print(json.dumps({\\"k\\": 1}))"');
  });

  test('drops leading ";" (no space) inside python3 -c "..." argument', () => {
    const input = 'python3 -c ";import secrets, hashlib, base64; print(\\"x\\")"';
    const out = sanitizeShellScript(input);
    expect(out).toBe('python3 -c "import secrets, hashlib, base64; print(\\"x\\")"');
  });

  test('leaves already-correct python3 -c untouched', () => {
    const input = 'python3 -c "import json, sys; print(1)"';
    const out = sanitizeShellScript(input);
    expect(out).toBe(input);
  });

  test('does not touch python3 -c bodies that do not start with semicolon', () => {
    const input = 'python3 -c "x=1; y=2; print(x+y)"';
    expect(sanitizeShellScript(input)).toBe(input);
  });
});

describe('sanitizeShellScript — bug 2 (bare $RANDOM under dash + set -u)', () => {
  test('wraps bare $RANDOM with ${RANDOM:-0}', () => {
    const input = 'STATE="roys-$(date +%s)-$RANDOM"';
    const out = sanitizeShellScript(input);
    expect(out).toBe('STATE="roys-$(date +%s)-${RANDOM:-0}"');
  });

  test('leaves ${RANDOM:-0} already-wrapped form untouched', () => {
    const input = 'STATE="roys-$(date +%s)-${RANDOM:-0}"';
    expect(sanitizeShellScript(input)).toBe(input);
  });

  test('leaves ${RANDOM} (no default) untouched', () => {
    const input = 'STATE="x-$RANDOM"'; // becomes x-${RANDOM}
    const out = sanitizeShellScript(input);
    expect(out).toBe('STATE="x-${RANDOM:-0}"'); // we still wrap the bare form
  });

  test('does not touch $RANDOM9 (variable with extra characters)', () => {
    const input = 'echo $RANDOM9';
    expect(sanitizeShellScript(input)).toBe(input);
  });

  test('does not touch ${RANDOM_VAR} (different variable)', () => {
    const input = 'echo ${RANDOM_VAR}';
    expect(sanitizeShellScript(input)).toBe(input);
  });
});

describe('sanitizeShellScript — composition', () => {
  test('fixes both bugs in one multi-line script', () => {
    const input = [
      'set -u',
      'STATE="roys-$(date +%s)-$RANDOM"',
      'KEY=$(python3 -c "; import secrets; print(secrets.token_urlsafe(16))")',
    ].join('\n');
    const out = sanitizeShellScript(input);
    expect(out).toContain('${RANDOM:-0}');
    expect(out).toContain('python3 -c "import secrets;');
    expect(out).not.toContain('python3 -c ";');
    expect(out).not.toMatch(/\$RANDOM[^A-Za-z0-9_{:!-]/);
  });

  test('returns empty / non-string input untouched', () => {
    expect(sanitizeShellScript('')).toBe('');
  });

  test('returns null / undefined input untouched', () => {
    expect(sanitizeShellScript(null as any)).toBe(null);
    expect(sanitizeShellScript(undefined as any)).toBe(undefined);
  });
});

describe('sanitizeWorkflowDefinition — node walking', () => {
  test('fixes bugs in config.inputs.command (Task #2924 path)', () => {
    const def = {
      name: 'demo',
      version: '1.0',
      nodes: [
        {
          id: 'get-jwt',
          type: 'tool',
          config: {
            tool: 'bash',
            inputs: {
              command: [
                'set -u',
                'STATE="roys-$(date +%s)-$RANDOM"',
                'PAYLOAD=$(python3 -c "; import json; print(json.dumps({\\"k\\":1}))")',
              ].join('\n'),
            },
          },
        },
      ],
    } as any;

    const out = sanitizeWorkflowDefinition(def);
    const cmd = out.nodes[0].config.inputs.command;
    expect(cmd).toContain('${RANDOM:-0}');
    expect(cmd).toContain('python3 -c "import json;');
    expect(cmd).not.toContain('python3 -c ";');
  });

  test('fixes bugs in config.input.command (engine alias)', () => {
    const def = {
      name: 'demo',
      version: '1.0',
      nodes: [
        {
          id: 'get-jwt',
          type: 'tool',
          config: {
            tool: 'bash',
            input: {
              command: 'STATE="x-$RANDOM"',
            },
          },
        },
      ],
    } as any;

    const out = sanitizeWorkflowDefinition(def);
    expect(out.nodes[0].config.input.command).toContain('${RANDOM:-0}');
  });

  test('fixes bugs in config.command (single-param tool top-level)', () => {
    const def = {
      name: 'demo',
      version: '1.0',
      nodes: [
        {
          id: 'echo-step',
          type: 'tool',
          config: {
            tool: 'echo',
            command: 'STATE="x-$RANDOM"',
          },
        },
      ],
    } as any;

    const out = sanitizeWorkflowDefinition(def);
    expect(out.nodes[0].config.command).toContain('${RANDOM:-0}');
  });

  test('leaves a clean workflow untouched (returns same shape, may not deep-equal)', () => {
    const def = {
      name: 'clean',
      version: '1.0',
      nodes: [
        {
          id: 'a',
          type: 'tool',
          config: { tool: 'bash', inputs: { command: 'echo hello $RANDOM9' } },
        },
      ],
    } as any;

    const out = sanitizeWorkflowDefinition(def);
    expect(out.nodes[0].config.inputs.command).toBe('echo hello $RANDOM9');
  });

  test('does not mutate the original definition (immutability)', () => {
    const original = {
      name: 'demo',
      version: '1.0',
      nodes: [
        {
          id: 'a',
          type: 'tool',
          config: {
            tool: 'bash',
            inputs: { command: 'STATE="x-$RANDOM"' },
          },
        },
      ],
    } as any;
    const before = JSON.stringify(original);
    sanitizeWorkflowDefinition(original);
    expect(JSON.stringify(original)).toBe(before);
  });

  test('handles definition without nodes (defensive)', () => {
    const def = { name: 'broken', version: '1.0' } as any;
    expect(() => sanitizeWorkflowDefinition(def)).not.toThrow();
  });
});
