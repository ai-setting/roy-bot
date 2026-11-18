/**
 * @fileoverview Orphan tool-call repair (Task #4992, P0).
 *
 * ── What is an orphan tool-call? ──────────────────────────────
 *
 * The AI SDK v6 prompt converter (`convertToLanguageModelPrompt`,
 * node_modules/ai/dist/index.mjs:1359-1387) validates pairing with a
 * POSITIONAL pending-set state machine, not a global id set:
 *
 *   - an assistant tool-call ADDs its id to the pending set;
 *   - a tool-result REMOVES its id from the pending set;
 *   - when a user/system message is reached and the pending set is
 *     NOT empty, it throws AI_MissingToolResultsError — the run dies.
 *
 * Therefore a tool-result that arrives AFTER the next user/system
 * message does NOT pair with its tool-call. An orphan is any
 * tool-call still pending when the next user/system message arrives
 * (or at end-of-history).
 *
 * ── How are orphans produced? ──────────────────────────────────
 *
 * When the context threshold is exceeded, `LLMComponent.finalizeOutput()`
 * throws a `ContextError` AFTER the LLM already returned tool calls. The
 * `AgentComponent` catch block persists that assistant message for the
 * compaction pipeline, but (before Defence 1) never wrote the placeholder
 * tool-results — the iteration's `iterAllToolCalls` still holds the
 * PREVIOUS iteration's value. Result: pending tool-calls land in
 * sessions.db with no positional pairing → next AI SDK fallback throws
 * `AI_MissingToolResultsError` and kills the run (production kill chain:
 * Task #4983, session_1bba0d11).
 *
 * ── Two defences, one helper ───────────────────────────────────
 *
 * 1. Defence 1 (produce-side): AgentComponent emits placeholders when
 *    persisting the ContextError assistant message — root cause.
 * 2. Defence 2 (consume-side): the AI SDK fallback path (invoke.ts) runs
 *    `repairOrphanSdkMessages()` on the history BEFORE `streamText()`, so
 *    ANY source of orphans (legacy sessions, crashes, ...) can no longer
 *    throw `AI_MissingToolResultsError`. Defence in depth.
 */

import type { LLMMessage } from "./types";
import type { ModelMessage } from "ai";

/** Placeholder text written for a tool call whose run was interrupted. */
export const ORPHAN_PLACEHOLDER_PREFIX = "[Tool result missing: run interrupted]";

export interface OrphanToolCall {
  toolCallId: string;
  toolName: string;
  /**
   * Index of the message that triggered the orphan detection
   * (the user/system boundary, or the last message for
   * end-of-history orphans). The repair inserts the placeholder
   * result at exactly this boundary, matching AI SDK semantics.
   */
  messageIndex: number;
}

export interface OrphanRepairResult<M = LLMMessage> {
  messages: M[];
  orphans: OrphanToolCall[];
  repairedCount: number;
}

/** Extract the canonical tool name from either ToolCall shape. */
function toolNameOf(tc: { name?: string; function?: { name?: string } }): string {
  return tc.function?.name || tc.name || "unknown";
}

// ============================================================================
// Shared positional pending-set engine (mirrors AI SDK v6 exactly)
// ============================================================================

type PendingEvent = {
  /** Ids ADDED to the pending set (assistant tool-calls). */
  added: Array<{ id: string; name: string }>;
  /** Ids REMOVED from the pending set (tool-results). */
  removed: string[];
};

function extractPendingEvent(
  msg: Record<string, unknown>,
  events: PendingEvent[],
): void {
  const added: Array<{ id: string; name: string }> = [];
  const removed: string[] = [];

  // Assistant tool-calls: LLMMessage shape (`msg.toolCalls`) and
  // SDK shape (tool-call parts inside `msg.content`).
  const toolCalls = msg.toolCalls as
    | Array<{ id?: string; name?: string; function?: { name?: string } }>
    | undefined;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (tc?.id) added.push({ id: tc.id, name: toolNameOf(tc) });
    }
  }
  const content = msg.content as unknown;
  if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) {
      if (!part) continue;
      if (part.type === "tool-call" && typeof part.toolCallId === "string") {
        added.push({
          id: part.toolCallId,
          name: typeof part.toolName === "string" ? part.toolName : "unknown",
        });
      }
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        removed.push(part.toolCallId);
      }
    }
  }
  // Flat tool message shape (`{ role: "tool", toolCallId, ... }`).
  if (msg.role === "tool" && typeof msg.toolCallId === "string") {
    removed.push(msg.toolCallId);
  }

  events.push({ added, removed });
}

/**
 * Scan a message history for orphan tool-calls with POSITIONAL
 * pending-set semantics — the exact model AI SDK v6 uses in
 * `convertToLanguageModelPrompt` (node_modules/ai/dist/index.mjs:1359-1387):
 *
 *   - assistant tool-call → id added to the pending set;
 *   - tool-result → id removed;
 *   - on user/system message with a non-empty pending set → those
 *     pending calls are orphans (AI SDK would throw here);
 *   - at end of history, still-pending calls are orphans too.
 *
 * A tool-result that appears after the next user/system message can
 * never satisfy its tool-call — matching the AI SDK behavior exactly.
 *
 * Pure function — does not mutate the input.
 */
export function findOrphanToolCalls(messages: LLMMessage[]): OrphanToolCall[] {
  const events: PendingEvent[] = [];
  const roles: Array<"system" | "user" | "assistant" | "tool"> = [];
  for (const msg of messages) {
    roles.push(msg.role);
    extractPendingEvent(msg as unknown as Record<string, unknown>, events);
  }
  return collectOrphans(roles, events);
}

function collectOrphans(
  roles: Array<"system" | "user" | "assistant" | "tool">,
  events: PendingEvent[],
): OrphanToolCall[] {
  const pending = new Map<string, string>(); // id → toolName
  const orphans: OrphanToolCall[] = [];
  const reported = new Set<string>();

  for (let index = 0; index < roles.length; index++) {
    const { added, removed } = events[index]!;

    // 1. Removals first (a result may legitimately pair with a call
    //    added earlier in the SAME message stream — e.g. SDK shape
    //    where a tool message follows its assistant).
    for (const id of removed) pending.delete(id);

    // 2. Additions.
    for (const { id, name } of added) {
      if (!pending.has(id)) pending.set(id, name);
    }

    // 3. Boundary check — user/system with a non-empty pending set
    //    is exactly where AI SDK v6 throws MissingToolResultsError
    //    (node_modules/ai/dist/index.mjs:1375-1387).
    const role = roles[index]!;
    if ((role === "user" || role === "system") && pending.size > 0) {
      for (const [id, name] of pending) {
        if (!reported.has(id)) {
          reported.add(id);
          orphans.push({ toolCallId: id, toolName: name, messageIndex: index });
        }
      }
      // AI SDK throws here; for scanning we report and CONTINUE with a
      // cleared set (the repair inserts results exactly at this point,
      // so after repair no pending id can survive this boundary).
      pending.clear();
    }
  }

  // End-of-history pending calls are orphans too (the converter's
  // final check, index.mjs:1387-1390). They are flagged with
  // a DISTINCT marker so the repair functions can append
  // them AFTER the last message (a boundary orphan must be
  // inserted BEFORE its boundary message instead).
  for (const [id, name] of pending) {
    if (!reported.has(id)) {
      reported.add(id);
      orphans.push({
        toolCallId: id,
        toolName: name,
        messageIndex: roles.length, // sentinel: end-of-history
      });
    }
  }
  return orphans;
}

/**
 * Repair a history by inserting one placeholder `tool` message per
 * orphan tool-call AT THE ORPHAN BOUNDARY (just before the user/system
 * message that triggers the AI SDK throw, or appended at end of
 * history). This restores positional pairing per AI SDK v6 semantics.
 *
 * - Input is NOT mutated; when there are no orphans the SAME array
 *   reference is returned (zero-copy fast path).
 * - The placeholder output is a JSON string
 *   `{ error: "[Tool result missing: run interrupted] <reason>" }`.
 */
export function repairOrphanToolCalls(
  messages: LLMMessage[],
  options?: { reason?: string },
): OrphanRepairResult<LLMMessage> {
  const events: PendingEvent[] = [];
  const roles: Array<"system" | "user" | "assistant" | "tool"> = [];
  for (const msg of messages) {
    roles.push(msg.role);
    extractPendingEvent(msg as unknown as Record<string, unknown>, events);
  }
  const orphans = collectOrphans(roles, events);
  if (orphans.length === 0) {
    return { messages, orphans: [], repairedCount: 0 };
  }

  const reason = options?.reason ?? "context limit or crash";
  const output = JSON.stringify({ error: `${ORPHAN_PLACEHOLDER_PREFIX} ${reason}` });

  // Group placeholders by insertion index (the boundary message index;
  // for end-of-history orphans the index is the LAST message, and the
  // placeholder goes AFTER it).
  const byIndex = new Map<number, OrphanToolCall[]>();
  for (const orphan of orphans) {
    const list = byIndex.get(orphan.messageIndex) ?? [];
    list.push(orphan);
    byIndex.set(orphan.messageIndex, list);
  }

  const result: LLMMessage[] = [];
  const endGroup = byIndex.get(messages.length);
  messages.forEach((msg, index) => {
    const group = byIndex.get(index);
    // Placeholders go BEFORE the boundary message (converter
    // accepts [.., tool, user] adjacency).
    if (group) {
      for (const orphan of group) {
        result.push({
          role: "tool",
          content: output,
          toolCallId: orphan.toolCallId,
          name: orphan.toolName,
        });
      }
    }
    result.push(msg);
  });
  if (endGroup) {
    // End-of-history orphans: append AFTER the last message.
    for (const orphan of endGroup) {
      result.push({
        role: "tool",
        content: output,
        toolCallId: orphan.toolCallId,
        name: orphan.toolName,
      });
    }
  }

  return { messages: result, orphans, repairedCount: orphans.length };
}

// ============================================================================
// AI SDK ModelMessage variant (defence 2 wiring in invoke.ts)
// ============================================================================

/**
 * Same positional repair as `repairOrphanToolCalls`, but for AI SDK
 * `ModelMessage[]` (post-`convertToSDKMessages`). In this shape the
 * assistant tool-calls live inside `content` as `tool-call` parts, and
 * tool results are `tool` role messages whose `content` is an array of
 * `tool-result` parts.
 *
 * The placeholder result is emitted in the exact AI SDK v6 wire shape:
 * `{ role: "tool", content: [{ type: "tool-result", toolCallId, toolName,
 *   output: { type: "text", value } }] }`.
 */
export function repairOrphanSdkMessages(
  messages: ModelMessage[],
  options?: { reason?: string },
): OrphanRepairResult<ModelMessage> & { messages: ModelMessage[] } {
  const events: PendingEvent[] = [];
  const roles: Array<"system" | "user" | "assistant" | "tool"> = [];
  for (const msg of messages) {
    roles.push(msg.role as "system" | "user" | "assistant" | "tool");
    extractPendingEvent(msg as unknown as Record<string, unknown>, events);
  }
  const orphans = collectOrphans(roles, events);
  if (orphans.length === 0) {
    return { messages, orphans: [], repairedCount: 0 };
  }

  const reason = options?.reason ?? "context limit or crash";
  const value = JSON.stringify({ error: `${ORPHAN_PLACEHOLDER_PREFIX} ${reason}` });

  const byIndex = new Map<number, OrphanToolCall[]>();
  for (const orphan of orphans) {
    const list = byIndex.get(orphan.messageIndex) ?? [];
    list.push(orphan);
    byIndex.set(orphan.messageIndex, list);
  }

  const result: ModelMessage[] = [];
  const endGroup = byIndex.get(messages.length);
  const placeholder = (orphan: OrphanToolCall) =>
    ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: orphan.toolCallId,
          toolName: orphan.toolName,
          output: { type: "text", value },
        },
      ],
    }) as ModelMessage;
  messages.forEach((msg, index) => {
    const group = byIndex.get(index);
    if (group) {
      for (const orphan of group) {
        result.push(placeholder(orphan));
      }
    }
    result.push(msg);
  });
  if (endGroup) {
    for (const orphan of endGroup) {
      result.push(placeholder(orphan));
    }
  }

  return { messages: result, orphans, repairedCount: orphans.length };
}
