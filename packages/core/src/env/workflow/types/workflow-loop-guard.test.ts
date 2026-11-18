/**
 * LoopGuardConfig schema tests.
 *
 * TDD: RED phase for Step 1 of the loop_guard engine feature.
 * Validates that the LoopGuardConfigSchema is wired into NodeDefinition
 * and accepts/validates the generalized `value_unchanged` shape.
 *
 * Design (Task #2283):
 * - LoopGuardConfig.type === 'value_unchanged' (single, generic type)
 * - previous_signal: any TemplateResolver path
 * - current_signal_command: any shell command
 * - cwd: optional working directory override
 * - max_consecutive_no_progress: default 1
 * - fail_message: optional custom failure message
 *
 * @see /tmp/loop-guard-engine-design.md
 */

import { describe, expect, it } from 'vitest';

import { NodeDefinitionSchema } from './workflow';
import type { LoopGuardConfig } from './workflow';

describe('LoopGuardConfig schema', () => {
  describe('node integration', () => {
    it('parses a node that has a complete loop_guard config block', () => {
      const node = {
        id: 'tdd-implement',
        type: 'agent',
        config: {
          loop_guard: {
            type: 'value_unchanged',
            previous_signal: '{{nodes.tdd-implement.commits[-1]}}',
            current_signal_command: 'git -C ~/work/foo rev-parse HEAD',
            cwd: '~/work/foo',
            max_consecutive_no_progress: 2,
            fail_message: 'no progress: HEAD unchanged after back-edge re-entry',
          } satisfies LoopGuardConfig,
        },
      };

      const parsed = NodeDefinitionSchema.parse(node);
      expect(parsed.id).toBe('tdd-implement');
      expect(parsed.type).toBe('agent');
      const cfg = parsed.config as { loop_guard?: LoopGuardConfig };
      expect(cfg.loop_guard).toBeDefined();
      expect(cfg.loop_guard?.type).toBe('value_unchanged');
      expect(cfg.loop_guard?.previous_signal).toBe(
        '{{nodes.tdd-implement.commits[-1]}}',
      );
      expect(cfg.loop_guard?.current_signal_command).toBe(
        'git -C ~/work/foo rev-parse HEAD',
      );
      expect(cfg.loop_guard?.cwd).toBe('~/work/foo');
      expect(cfg.loop_guard?.max_consecutive_no_progress).toBe(2);
      expect(cfg.loop_guard?.fail_message).toBe(
        'no progress: HEAD unchanged after back-edge re-entry',
      );
    });

    it('accepts a node without loop_guard (backward compatibility)', () => {
      const node = {
        id: 'simple-node',
        type: 'tool',
        config: {
          tool: 'echo',
          message: 'hello',
        },
      };

      const parsed = NodeDefinitionSchema.parse(node);
      const cfg = parsed.config as { loop_guard?: LoopGuardConfig };
      expect(cfg.loop_guard).toBeUndefined();
    });
  });

  describe('value validation', () => {
    it('rejects unknown loop_guard.type (only value_unchanged is supported)', () => {
      const node = {
        id: 'bad',
        type: 'agent',
        config: {
          loop_guard: {
            type: 'git_head_unchanged', // legacy/draft — not allowed
            previous_signal: '{{nodes.foo.commits[-1]}}',
            current_signal_command: 'git rev-parse HEAD',
          },
        },
      };

      expect(() => NodeDefinitionSchema.parse(node)).toThrow();
    });

    it('rejects empty previous_signal', () => {
      const node = {
        id: 'bad',
        type: 'agent',
        config: {
          loop_guard: {
            type: 'value_unchanged' as const,
            previous_signal: '',
            current_signal_command: 'git rev-parse HEAD',
          },
        },
      };

      expect(() => NodeDefinitionSchema.parse(node)).toThrow();
    });

    it('rejects empty current_signal_command', () => {
      const node = {
        id: 'bad',
        type: 'agent',
        config: {
          loop_guard: {
            type: 'value_unchanged' as const,
            previous_signal: '{{nodes.foo.x}}',
            current_signal_command: '',
          },
        },
      };

      expect(() => NodeDefinitionSchema.parse(node)).toThrow();
    });

    it('rejects max_consecutive_no_progress less than 1', () => {
      const node = {
        id: 'bad',
        type: 'agent',
        config: {
          loop_guard: {
            type: 'value_unchanged' as const,
            previous_signal: '{{nodes.foo.x}}',
            current_signal_command: 'true',
            max_consecutive_no_progress: 0,
          },
        },
      };

      expect(() => NodeDefinitionSchema.parse(node)).toThrow();
    });

    it('defaults max_consecutive_no_progress to 1 when omitted', () => {
      const node = {
        id: 'tdd',
        type: 'agent',
        config: {
          loop_guard: {
            type: 'value_unchanged' as const,
            previous_signal: '{{nodes.tdd.commits[-1]}}',
            current_signal_command: 'git rev-parse HEAD',
          },
        },
      };

      const parsed = NodeDefinitionSchema.parse(node);
      const cfg = parsed.config as { loop_guard?: LoopGuardConfig };
      expect(cfg.loop_guard?.max_consecutive_no_progress).toBe(1);
    });
  });
});
