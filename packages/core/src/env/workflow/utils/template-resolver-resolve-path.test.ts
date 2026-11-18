/**
 * TemplateResolver.resolvePath() tests.
 *
 * TDD: RED phase for the loop_guard engine feature (Task #2283).
 * resolvePath is a new public helper that returns the value at a
 * pure-template path, including support for array indexing
 * `commits[-1]`, `items[0]`, and the `.length` property.
 *
 * @see /tmp/loop-guard-engine-design.md
 */

import { describe, expect, it } from 'vitest';

import { TemplateResolver } from './template-resolver';

function buildResolver(): TemplateResolver {
  return new TemplateResolver({
    input: { project_path: '/repo', task_id: 2283 },
    previousOutputs: new Map<string, unknown>([
      [
        'tdd-implement',
        {
          tdd_status: 'FAIL',
          commits: ['sha-A', 'sha-B', 'sha-C'],
          test_count_passing: 5,
        },
      ],
      [
        'code-review',
        {
          review_status: 'NEEDS_FIX',
          severity: { blocking: ['fix-1', 'fix-2'], minor: ['nit-1'] },
        },
      ],
    ]),
  });
}

describe('TemplateResolver.resolvePath', () => {
  it('strips {{ }} wrapper and resolves a bare nodes.X path', () => {
    const r = buildResolver();
    expect(r.resolvePath('{{nodes.tdd-implement}}')).toEqual({
      tdd_status: 'FAIL',
      commits: ['sha-A', 'sha-B', 'sha-C'],
      test_count_passing: 5,
    });
  });

  it('resolves a nested nodes.X.Y path', () => {
    const r = buildResolver();
    expect(r.resolvePath('{{nodes.tdd-implement.tdd_status}}')).toBe('FAIL');
    expect(r.resolvePath('{{nodes.tdd-implement.test_count_passing}}')).toBe(5);
  });

  it('resolves deeply nested nodes.X.Y.Z paths', () => {
    const r = buildResolver();
    expect(r.resolvePath('{{nodes.code-review.severity.blocking}}')).toEqual([
      'fix-1',
      'fix-2',
    ]);
  });

  it('resolves array element with positive index (items[0])', () => {
    const r = buildResolver();
    expect(r.resolvePath('{{nodes.tdd-implement.commits[0]}}')).toBe('sha-A');
    expect(r.resolvePath('{{nodes.tdd-implement.commits[2]}}')).toBe('sha-C');
  });

  it('resolves last array element with negative index (commits[-1])', () => {
    const r = buildResolver();
    expect(r.resolvePath('{{nodes.tdd-implement.commits[-1]}}')).toBe('sha-C');
  });

  it('resolves array length (severity.blocking.length)', () => {
    const r = buildResolver();
    expect(r.resolvePath('{{nodes.code-review.severity.blocking.length}}')).toBe(2);
  });

  it('resolves input paths', () => {
    const r = buildResolver();
    expect(r.resolvePath('{{input.project_path}}')).toBe('/repo');
    expect(r.resolvePath('{{input.task_id}}')).toBe(2283);
  });

  it('resolves a path without the {{ }} wrapper (bare path)', () => {
    const r = buildResolver();
    expect(r.resolvePath('nodes.tdd-implement.tdd_status')).toBe('FAIL');
  });

  it('returns undefined for a missing node ID', () => {
    const r = buildResolver();
    expect(r.resolvePath('{{nodes.does-not-exist}}')).toBeUndefined();
  });

  it('returns undefined for an out-of-bounds array index', () => {
    const r = buildResolver();
    expect(r.resolvePath('{{nodes.tdd-implement.commits[99]}}')).toBeUndefined();
  });

  it('returns undefined for an empty path', () => {
    const r = buildResolver();
    expect(r.resolvePath('')).toBeUndefined();
  });
});
