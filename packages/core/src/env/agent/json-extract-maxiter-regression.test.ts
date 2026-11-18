/**
 * @fileoverview Regression test for Task #1826: json-extract sub-agent
 *                  exit-without-tool-call when MiniMax LLM provider
 *                  does not honor `toolChoice=required`.
 *
 * BUG (HEAD~1):
 *   - agent-registry.ts: `maxIterations: 1`
 *     The MiniMax LLM provider does NOT honor the `toolChoice: "required"`
 *     hint set by the workflow-json-output-plugin. On the first attempt,
 *     the LLM may exit with `finishReason: "stop"` (text response) instead
 *     of calling `workflow_submit_output`. With maxIterations=1, the
 *     ReAct loop terminates immediately, and the plugin is forced into
 *     its regex-fallback path (which fails when JSON is wrapped in
 *     markdown ```json``` code blocks).
 *
 *   - prompts-index.ts: prompt did NOT instruct "exit immediately after
 *     successful tool return". The LLM could continue iterating
 *     unnecessarily even when the tool call had succeeded, burning the
 *     single available iteration.
 *
 * FIX (HEAD):
 *   - agent-registry.ts: `maxIterations: 1` → `maxIterations: 5`
 *     Allows up to 5 retries so the LLM can recover when the provider
 *     ignores `toolChoice=required`.
 *
 *   - prompts-index.ts: Added "✅ 关键行为：成功返回立即退出" section,
 *     making step 4 (success → exit immediately) explicit.
 *
 * These assertions would FAIL on HEAD~1 (buggy code) and PASS on HEAD
 * (fixed code). They serve as the regression guard for the fix.
 */

import { describe, it, expect } from 'bun:test';
import { builtInPrompts } from '../prompt/prompts-index';
import { AgentRegistry } from './agent-registry';

describe('json-extract Task #1826 regression', () => {
  describe('agent-registry.ts — maxIterations retry budget', () => {
    it('should register json-extract with maxIterations >= 2 (allow retries when provider ignores toolChoice=required)', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerJsonExtractAgent();

      const agent = registry.get('json-extract');
      expect(agent).toBeDefined();

      // Root-cause assertion: the LLM provider may not honor toolChoice=required
      // on the first try, so maxIterations must be >= 2 to allow retries.
      // On HEAD~1 this was 1 → test FAILS. On HEAD this is 5 → test PASSES.
      expect(agent?.maxIterations).toBeGreaterThanOrEqual(2);

      // Stronger assertion: must be exactly 5 (the chosen retry budget).
      // If a future change relaxes this, the test forces a conscious decision.
      expect(agent?.maxIterations).toBe(5);
    });
  });

  describe('prompts-index.ts — "success → exit immediately" instruction', () => {
    it('should contain a "成功返回立即退出" section so LLM exits after successful tool call', () => {
      const prompt = builtInPrompts['json-extract'];
      expect(prompt).toBeDefined();

      // Root-cause assertion: prompt must explicitly tell the LLM to exit
      // immediately after a successful tool call result. Otherwise the LLM
      // may continue iterating, wasting the (limited) maxIterations budget.
      expect(prompt).toContain('成功返回立即退出');
    });

    it('should declare the retry budget (5 次) in the prompt body', () => {
      const prompt = builtInPrompts['json-extract'];

      // The prompt should declare the retry budget so the LLM knows it
      // has up to 5 attempts.
      expect(prompt).toMatch(/最多\s*5\s*次/);
    });
  });
});