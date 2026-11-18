/**
 * Workflow JSON output extraction via agent:after.react + json-extract sub-agent.
 *
 * Architecture (decoupled, sub-agent based + tool self-recording):
 * 1. Main agent runs its normal ReAct loop (plan/execute/verify) — it does NOT
 *    know about JSON output. The main agent's tool list is clean.
 * 2. After ReAct finishes, this plugin is invoked on `agent:after.react`.
 * 3. The plugin creates a dynamic `workflow_submit_output` tool bound to
 *    `hookCtx` and calls the `json-extract` sub-agent via
 *    `agentComponent.run('json-extract', '', { sessionId, extraTools, ... })`.
 * 4. The `json-extract` sub-agent (built-in) has one allowed tool:
 *    `workflow_submit_output`. It reads session history and calls the tool
 *    with the structured JSON answer.
 * 5. The tool itself (not this plugin) writes the validated JSON to
 *    `hookCtx.structuredOutputExtracted`. The plugin just reads it back
 *    afterwards — no result.toolCalls inspection, no re-validation.
 *
 * No fallback: if the sub-agent fails to call the tool, we log a warning and
 * return undefined. We do NOT substitute a hardcoded model.
 */

import type { AgentComponent } from '../../agent/agent-component';
import type { AgentContext, HookContext as AgentHookContext } from '../../agent/types';
import type { HookContext as GlobalHookContext } from '../../hook/types';
import { globalHookManager } from '../../hook/global-hook-manager';
import { AskUserError } from '../types/workflow-hil';
import { createSubmitJsonOutputTool } from '../tools/submit-json-output-tool';
import type { JsonSchemaObject } from '../utils/json-schema-to-zod';
import { createLogger } from '../../log-trace/logger';

import type { ModelMessage } from 'ai';

/**
 * Extract plain text from the LAST assistant message in hookCtx.messages.
 *
 * Used by the workflow JSON output extraction plugin to derive a minimal
 * user query for the json-extract sub-agent, completely bypassing the
 * main session history.
 *
 * The sub-agent only sees:
 *   - system prompt (json-extract's own prompt)
 *   - user message: this extracted final response
 *   - tool: workflow_submit_output
 *
 * This eliminates the long-standing non-deterministic failure modes caused
 * by:
 *   - main agent using echo to dump JSON (then sub-agent sees echo calls
 *     inconsistent with its own tool set)
 *   - main agent using markdown ```json{...}``` blocks (then sub-agent
 *     "decides" JSON is already produced and stops without tool call)
 *   - main agent history containing multiple iterations, error retries,
 *     or reasoning parts that confuse the sub-agent
 *
 * Returns `undefined` if no assistant message exists or no text content
 * can be extracted.
 */
function extractLastAssistantText(messages: ReadonlyArray<ModelMessage> | undefined): string | undefined {
  if (!messages || messages.length === 0) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') {
      continue;
    }
    const content = msg.content;
    if (typeof content === 'string') {
      return content.trim() || undefined;
    }
    if (Array.isArray(content)) {
      const textParts = content
        .filter((p): p is { type: 'text'; text: string } =>
          typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text'
        )
        .map(p => p.text);
      const combined = textParts.join('\n').trim();
      return combined || undefined;
    }
  }
  return undefined;
}

import { wrapFunction } from '../../log-trace/decorator';

const logger = createLogger('WorkflowJsonOutputPlugin');

export const WORKFLOW_JSON_OUTPUT_SOURCE_ID = 'workflow';
export const WORKFLOW_JSON_OUTPUT_PLUGIN_NAME = 'json-output';
export const WORKFLOW_JSON_OUTPUT_PLUGIN_KEY = `${WORKFLOW_JSON_OUTPUT_SOURCE_ID}:${WORKFLOW_JSON_OUTPUT_PLUGIN_NAME}`;

const HOOK_POINT = 'agent:after.react';
const HOOK_NAME = `${WORKFLOW_JSON_OUTPUT_PLUGIN_NAME}:${HOOK_POINT}`;

let registered = false;

/**
 * 注入的 agentComponent（用于在 hook 中调用 json-extract sub-agent）
 *
 * 在 registerWorkflowJsonOutputPlugin() 时注入，由 AgentComponentAdapter
 * （持有 AgentComponent 引用）在构造时调用。
 */
let agentComponentRef: AgentComponent | null = null;

export function isWorkflowJsonOutputEnabled(
  pluginEnabled?: Record<string, boolean>
): boolean {
  return pluginEnabled?.[WORKFLOW_JSON_OUTPUT_PLUGIN_KEY] === true;
}

/**
 * 注册 workflow JSON output plugin
 *
 * @param options.agentComponent — AgentComponent 实例，用于在 hook 中调用
 *                                  json-extract sub-agent
 */
export function registerWorkflowJsonOutputPlugin(options: {
  agentComponent: AgentComponent;
} | void = undefined): void {
  if (registered) {
    return;
  }

  if (options?.agentComponent) {
    agentComponentRef = options.agentComponent;
  }

  registered = true;

  globalHookManager.register(HOOK_POINT, {
    name: HOOK_NAME,
    pluginName: WORKFLOW_JSON_OUTPUT_PLUGIN_NAME,
    sourceId: WORKFLOW_JSON_OUTPUT_SOURCE_ID,
    priority: 100,
    description:
      'Extract structured JSON output by invoking the json-extract sub-agent on the main session history',
    execute: async (wrapper: GlobalHookContext<unknown>) => {
      const hookCtx = wrapper.data as AgentHookContext & {
        structuredOutputExtracted?: Record<string, unknown>;
      };
      await tracedRunWorkflowJsonOutputExtraction(hookCtx);
    },
  });

  logger.info('Workflow JSON output plugin registered on agent:after.react');
}

export function unregisterWorkflowJsonOutputPlugin(): void {
  globalHookManager.unregister(HOOK_POINT, HOOK_NAME);
  registered = false;
  agentComponentRef = null;
}

/**
 * For tests: set the agentComponent reference directly.
 */
export function __setPluginAgentComponentForTest(agentComponent: AgentComponent | null): void {
  agentComponentRef = agentComponent;
}

/**
 * Run JSON output extraction via the json-extract sub-agent.
 *
 * The plugin calls `agentComponent.run('json-extract', '', { ... })` which:
 * - Reuses the main session history (filterHistory=false in agent registry)
 * - Injects `workflow_submit_output` as an extra tool
 * - Disables session persistence (persistSession=false)
 * - Uses the same abort signal
 *
 * The sub-agent has maxIterations=1 and a single allowed tool, so it can only
 * call `workflow_submit_output` and stop.
 *
 * The submit tool is constructed with `hookCtx` and is responsible for
 * writing the validated JSON to `hookCtx.structuredOutputExtracted`. This
import type { ModelMessage } from 'ai';
import { z } from 'zod';

// ============================================================================
// Provider-compatibility helpers (Task #2175)
// ============================================================================

/**
 * First-party provider IDs that reliably accept `toolChoice: "required"`.
 * Anything else is treated as OpenAI-compatible and gated by
 * `capabilities.reasoning` to avoid conflict with thinking-mode.
 */
const FIRST_PARTY_PROVIDERS = new Set(['openai', 'anthropic', 'google']);

/**
 * Narrow source interface for `resolveProviderToolChoice`.
 *
 * Replaces the unsafe `agentComponent: any` parameter (Task #2177 review
 * finding C-1 + A-1). Any object that exposes a `configComponent.get(key)`
 * satisfies this contract — AgentComponent, mock test doubles, and future
 * first-party wrappers all work.
 *
 * Exported so callers can type-narrow their inputs without `any`-cast.
 */
export interface ProviderConfigSource {
  configComponent?: {
    get(key: string): unknown;
  };
}

/**
 * Read the active provider's reasoning capability from ConfigComponent.
 *
 * Pure read with safe fallbacks — never throws. Returns undefined when:
 *   - source is null (e.g., uninitialized / tests skip configComponent)
 *   - configComponent is unreachable
 *   - llm.defaultProvider is unset
 *   - llm.providers.<id>.capabilities is not configured
 *   - configComponent.get() throws (corrupted config) — see readProviderReasoning try/catch
 *
 * Note (Task #2177 review A-1): `BaseComponent.getConfigComponent()` is
 * `protected`, and `AgentComponent.configComponent` is `private`. Plugins
 * live outside both classes — there is no clean public API to reach
 * ConfigComponent. The narrow `ProviderConfigSource` interface is the
 * safe middle ground until full DI via
 * `registerWorkflowJsonOutputPlugin({ agentComponent, configComponent })`
 * is wired (deferred to a future Task).
 */
function readProviderReasoning(
  source: ProviderConfigSource | null | undefined,
): { providerId: string; reasoning: boolean } | undefined {
  if (!source) return undefined;
  const configComponent = source.configComponent;
  if (!configComponent) return undefined;

  // Selective catch (Task #2181 finding #2 — Task #2177 review op #16537):
  // Each configComponent.get() must distinguish two error classes:
  //   - ConfigValidationError / ConfigError (corrupted user config) →
  //     silent recovery, return undefined so caller falls back to
  //     toolChoice='required' (back-compat — preserves Task #2175 EDGE-2).
  //   - Other errors (TypeError / ReferenceError / programmer bugs) →
  //     BUBBLE UP so the bug is visible, not hidden behind a silent
  //     toolChoice decision.
  // Detection: since `ConfigValidationError` is not yet exported as a class
  // (planned for packages/core/src/config/config-component.ts in a future
  // Task), we discriminate by `error.name` which matches the convention
  // established by zod-derived errors. If a future Task introduces a
  // `ConfigValidationError` class, switch this to `instanceof` check.
  const isConfigError = (e: unknown): boolean =>
    e instanceof Error &&
    (e.name === "ConfigValidationError" || e.name === "ConfigError");

  let providerId: string | undefined;
  try {
    providerId = configComponent.get("llm.defaultProvider") as string | undefined;
  } catch (e) {
    if (isConfigError(e)) return undefined;
    throw e;
  }
  if (!providerId) return undefined;

  let capabilities: { reasoning?: boolean } | undefined;
  try {
    const capKey = `llm.providers.${providerId}.capabilities`;
    capabilities = configComponent.get(capKey) as { reasoning?: boolean } | undefined;
  } catch (e) {
    if (isConfigError(e)) return undefined;
    throw e;
  }

  return { providerId, reasoning: capabilities?.reasoning === true };
}

/**
 * Resolve effective toolChoice for the json-extract sub-agent.
 *
 * Rules (Task #2175):
 *   1. First-party providers (openai/anthropic/google) → "required"
 *   2. OpenAI-compatible providers with `capabilities.reasoning === true`
 *      (deepseek / volcengine / qwen-thinking / ...) → "auto" + rely on
 *      `maxIterations=5` retry (agent-registry.ts:432).
 *   3. Everything else (unknown / no config) → "required" (back-compat).
 *
 * Anthropic + reasoning rationale (Task #2181, finding A-3 partial — Task #2177
 * review op #16537):
 *   Anthropic Claude with extended thinking (`thinking.type=enabled`) is
 *   treated as first-party and unconditionally returns `'required'`.
 *   This is supported by AI SDK v4+: Claude Sonnet 4.5 / Opus 4 with
 *   extended thinking accepts `tool_choice: "required"` (per Anthropic
 *   docs: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking).
 *   The provider returns a 400 error if the model rejects
 *   `tool_choice: "required"` — it does NOT silently drop the argument.
 *   The OpenAI-compatible branch (`'auto'`) is reserved for providers
 *   where reasoning silently DROPS `tool_choice` instead of erroring
 *   (deepseek / volcengine / qwen-thinking observed behavior in Task #2175).
 *   TODO(validation): confirm against real Anthropic SDK behavior in a
 *   future R&D Task.
 *
 * Known limitation (Task #2177 review B-3): this function does NOT consult
 * session-level provider overrides (e.g. `hookCtx.context.metadata.llmProvider`).
 * Only the global `llm.defaultProvider` is read. If a future Task needs
 * per-session override, update the EDGE-3 test in
 * `workflow-json-output-plugin-provider-compat.test.ts` and document the
 * override precedence rules.
 *
 * Exported for unit testing.
 */
export function resolveProviderToolChoice(
  source: ProviderConfigSource | null | undefined,
): "required" | "auto" {
  const ctx = readProviderReasoning(source);
  if (!ctx) return "required";

  if (FIRST_PARTY_PROVIDERS.has(ctx.providerId)) {
    return "required";
  }

  if (ctx.reasoning) {
    // Thinking-mode OpenAI-compatible provider — toolChoice=required
    // may silently drop with reasoning.ignore=true. Use "auto" + maxIterations.
    return "auto";
  }

  return "required";
}

/**
 * Workflow JSON output extraction via agent:after.react + json-extract sub-agent.
 *
 * Architecture (v3 — clean extraction, Issue #1694 root-cause fix):
 *
 *   1. Main agent runs its normal ReAct loop. It may produce JSON in any of:
 *      - Plain text: {"x": 1, ...}
 *      - Markdown code block: ```json\n{"x": 1, ...}\n```
 *      - Tool-call input (e.g., echo's message field): {"x": 1, ...}
 *      The main agent does NOT know about workflow_submit_output. Its only
 *      contract is "produce a JSON object somewhere in its final output".
 *
 *   2. After ReAct finishes, this plugin is invoked on `agent:after.react`.
 *
 *   3. The plugin extracts JSON from the main agent's final output via
 *      `extractJsonFromAgentOutput()` (tries multiple patterns + validates
 *      against the JSON schema).
 *
 *   4. The plugin constructs a SINGLE user query message containing the
 *      pre-extracted JSON and calls the `json-extract` sub-agent with:
 *        - `messages: [{ role: "user", content: "Submit this JSON: ..." }]`
 *          (Layer 1+2 messages override — bypasses main session history,
 *           eliminating pollution risk)
 *        - `toolChoice: "required"` (forces LLM to call workflow_submit_output,
 *           eliminating the non-deterministic "markdown makes me stop" bug)
 *        - `extraTools: [workflow_submit_output]`
 *        - `persistSession: false`
 *
 *   5. The submit tool (not this plugin) writes the validated JSON to
 *      `hookCtx.structuredOutputExtracted`. The plugin just reads it back.
 *
 * Why this works where the previous design failed:
 *   - Previous: sub-agent reuses main session history. The history contains
 *     echo tool-calls + markdown code blocks + thinking blocks, all of which
 *     pollute the sub-agent's reasoning and cause non-deterministic
 *     finishReason=stop (no tool call).
 *   - Now: sub-agent sees ONLY one user message with the pre-extracted JSON
 *     and the schema prompt. The LLM cannot be confused by polluted history
 *     because there is no polluted history.
 */

export async function runWorkflowJsonOutputExtraction(
  hookCtx: AgentHookContext & { structuredOutputExtracted?: Record<string, unknown> }
): Promise<void> {
  const schema = hookCtx.context.metadata?.outputSchema as JsonSchemaObject | undefined;
  if (!schema) {
    return;
  }

  if (hookCtx.error instanceof AskUserError) {
    return;
  }

  if (hookCtx.structuredOutputExtracted) {
    return;
  }

  if (!agentComponentRef) {
    logger.warn(
      'Workflow JSON extraction: agentComponent not registered. ' +
        'Plugin cannot invoke json-extract sub-agent. ' +
        'Ensure registerWorkflowJsonOutputPlugin({ agentComponent }) was called.'
    );
    return;
  }

  // (3) Extract last assistant text from the main agent's output.
  //     We do NOT parse JSON ourselves — that's the sub-agent's job.
  //     We just pass the raw text so the json-extract LLM can read,
  //     understand, and call workflow_submit_output on its own.
  const assistantText = extractLastAssistantText(hookCtx.messages);
  if (!assistantText) {
    logger.warn(
      'Workflow JSON extraction: no assistant text found in main agent output. ' +
        'The agent must produce a final text response (plain or markdown).'
    );
    return;
  }

  // (4) Build the user query: hand off the raw assistant text to the
  //     json-extract sub-agent, along with the schema so it knows what
  //     fields to produce. The sub-agent's LLM processes the text and
  //     calls workflow_submit_output with the extracted JSON.
  const submitTool = createSubmitJsonOutputTool(schema, hookCtx);
  const submitToolAsExtra = {
    name: submitTool.name,
    description: submitTool.description ?? '',
    parameters: submitTool.parameters as any,
    execute: submitTool.execute,
  };
  const userQuery = [
    'The main agent has produced the following final response.',
    'Extract the structured JSON from it and submit via workflow_submit_output.',
    '',
    '--- START of main agent response ---',
    assistantText,
    '--- END of main agent response ---',
    '',
    'Your ONLY job: call workflow_submit_output with the extracted JSON.',
    'Do NOT output any text — just call the tool.',
  ].join('\n');

  const messagesOverride: ModelMessage[] = [
    {
      role: 'user',
      content: userQuery,
    },
  ];

  // See `resolveProviderToolChoice()` above for the decision tree.
  // The cast `as unknown as ProviderConfigSource | null` is the single
  // boundary where AgentComponent (private configComponent) crosses the
  // narrow interface boundary; a future Task should add DI to remove
  // this cast (Task #2177 review A-1 deferred).
  const resolvedToolChoice = resolveProviderToolChoice(
    agentComponentRef as unknown as ProviderConfigSource | null,
  );

  const extractContext: AgentContext = {
    // Layer 1+2 (Task #1694): bypass main session history. The sub-agent
    // sees ONLY this one user message + its own system prompt.
    messages: messagesOverride,
    extraTools: [submitToolAsExtra as any],
    persistSession: false,
    abort: hookCtx.context.abort,
    // Force LLM to call at least one tool. Since the sub-agent has exactly
    // ONE tool (workflow_submit_output), this is functionally equivalent
    // to forcing that specific tool when supported by the provider.
    //
    // Task #2175: restore `toolChoice: "required"` (it was incorrectly
    // removed in commit 70b2e569). Without it, the LLM may decide to
    // finish with empty plain-text output instead of calling
    // workflow_submit_output, producing `_extraction_failed=true`
    // placeholders (Issue #1694 / observed in run
    // workflow_1784498394013_fallback_reubfg).
    //
    // Provider-compat: deepseek/volcengine/qwen-thinking reasoning-mode
    // providers get "auto" + maxIterations retry (see resolveProviderToolChoice).
    toolChoice: resolvedToolChoice,
  };

  try {
    const result = await agentComponentRef.run('json-extract', '', extractContext);

    if (result.error) {
      logger.warn(
        `Workflow JSON extraction: json-extract sub-agent returned error: ${result.error}`
      );
      return;
    }

    if (hookCtx.structuredOutputExtracted) {
      logger.info(
        'Workflow JSON output extracted via json-extract sub-agent (clean override) ' +
          `(iterations=${result.iterations}, toolCalls=${result.toolCalls?.length ?? 0})`
      );
    } else {
      logger.warn(
        'Workflow JSON extraction: json-extract sub-agent did not call workflow_submit_output. ' +
          'toolChoice=required failed to force tool call — investigate provider support.'
      );
    }
  } catch (error) {
    logger.error(
      `Workflow JSON extraction: json-extract sub-agent threw: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Extract a JSON object from the main agent's final output.
 *
 * Tries multiple patterns (in order):
 *   1. `hookCtx.llmOutput.content` (if non-empty)
 *   2. Last assistant message text part
 *   3. Last assistant message tool-call input (string or { message: ... })
 *
 * Within each pattern, tries (in order):
 *   1. Direct JSON.parse
 *   2. Markdown ```json ... ``` code block
 *   3. First {...} substring
 *
 * Returns null if all attempts fail.
 *
 * Exported for testing.
 */
export function extractJsonFromAgentOutput(
  hookCtx: AgentHookContext
): Record<string, unknown> | null {
  // Try llmOutput.content first (most reliable — guaranteed to be the
  // final LLM output, not earlier assistant turns).
  if (hookCtx.llmOutput?.content && typeof hookCtx.llmOutput.content === 'string') {
    const json = tryParseJsonFromText(hookCtx.llmOutput.content);
    if (json) return json;
  }

  // Walk messages from the end, find last assistant message
  const messages = hookCtx.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const part of content as Array<Record<string, unknown>>) {
      // Try text parts (assistant's final analysis text)
      if (part.type === 'text' && typeof part.text === 'string') {
        const json = tryParseJsonFromText(part.text);
        if (json) return json;
      }
      // Try tool-call parts (e.g., echo({ message: "{...}" }))
      if (part.type === 'tool-call') {
        const input = part.input;
        if (typeof input === 'string') {
          const json = tryParseJsonFromText(input);
          if (json) return json;
        }
        if (input && typeof input === 'object') {
          // echo tool takes { message: string }
          const inputObj = input as Record<string, unknown>;
          if (typeof inputObj.message === 'string') {
            const json = tryParseJsonFromText(inputObj.message);
            if (json) return json;
          }
          // Some tools take { value: any } or { data: any }
          if ('value' in inputObj) {
            const json = tryParseJsonFromValue(inputObj.value);
            if (json) return json;
          }
          if ('data' in inputObj) {
            const json = tryParseJsonFromValue(inputObj.data);
            if (json) return json;
          }
        }
      }
    }
    // Only check the LAST assistant message — earlier turns are not relevant
    break;
  }

  return null;
}

/**
 * Try to parse a JSON object from arbitrary text using 3 strategies:
 *   1. Whole text is JSON
 *   2. Markdown ```json ... ``` code block
 *   3. First {...} substring
 *
 * Returns null if no valid JSON object is found.
 *
 * 2026-10-16：实现已抽到 `src/utils/loose-json`（session 压缩的 checkpoint
 * 降级路径也要用同一个解析器，避免 session → workflow/plugins 反向耦合）。
 * 此处 re-export，历史 import 路径（含测试）不变。
 */
import { tryParseJsonFromText } from '../../../utils/loose-json';
export { tryParseJsonFromText };

/**
 * Helper: like tryParseJsonFromText but for already-parsed values.
 */
function tryParseJsonFromValue(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    return tryParseJsonFromText(value);
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Build the user query message that asks the json-extract sub-agent to
 * submit the pre-extracted JSON via workflow_submit_output.
 *
 * The query is intentionally simple and direct. The sub-agent's system
 * prompt already explains what workflow_submit_output is and why it must
 * be called. This user message just provides the data.
 */
function buildJsonSubmitUserQuery(json: Record<string, unknown>): string {
  return [
    'Submit the following JSON via the workflow_submit_output tool.',
    '',
    'JSON to submit:',
    '```json',
    JSON.stringify(json, null, 2),
    '```',
    '',
    'Call workflow_submit_output with the JSON object above as your argument.',
    'Do not output any text — just call the tool.',
  ].join('\n');
}
// Wrap with @TracedAs decorator for debugging
export const tracedRunWorkflowJsonOutputExtraction = wrapFunction(
  runWorkflowJsonOutputExtraction,
  'workflow.json_output.extraction',
  { recordParams: true, recordResult: true, log: true }
);
