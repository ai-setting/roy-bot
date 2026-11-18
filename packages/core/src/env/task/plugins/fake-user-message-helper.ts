/**
 * @fileoverview Shared meta-protocol helper for `toolResult.result.metadata.toAddFakeUserMessage`
 *
 * Task #2580 (round 2) — Extracted shared helper for the meta-protocol
 * used by `agent:after.tool` plugins. Both `AutoTaskPlugin` (delegate hint)
 * and `MaxIterationReminderPlugin` (max-iteration final reminder) write
 * to the same `toolResult.result.metadata.toAddFakeUserMessage` field.
 *
 * ## Why a shared helper
 *
 * When both plugins fire on the same iteration (e.g., `threshold === maxIter-1`),
 * they would both write to the same metadata field. The second write would
 * silently overwrite the first, losing one of the reminders.
 *
 * The shared helper provides **deterministic merge**:
 * - Tracks each message's `kind` ("delegate" vs "max-iter")
 * - Merges so the final message order is: `[delegate..., max-iter...]`
 *   (max-iter is always the "last word" / final instruction)
 * - Both reminders are preserved (no silent overwrite)
 *
 * ## Why this is NOT a side-channel
 *
 * - Uses the EXISTING `toolResult.result.metadata.toAddFakeUserMessage` field
 * - No new fields on `HookContext` or `AgentContext`
 * - No new AgentComponent helper
 * - The `__fakeUserMessageKind` side field is a small internal marker that
 *   AgentComponent's `consumeMetaProtocolUserMessage` does NOT read or
 *   delete — it only reads `toAddFakeUserMessage` and deletes that.
 * - Both plugins and AgentComponent keep using the same meta-protocol path
 *   introduced by Task #2170.
 *
 * ## Observability (Task #2580 round 3)
 *
 * The helper is wrapped with `wrapFunction` to expose a stable span name
 * `plugin.fake-user-message.enqueue` (see `enqueueToAddFakeUserMessage`
 * export below). The span's `attributes` capture:
 *   - `kind` ("delegate" or "max-iter")
 *   - `will-merge` (true if existing metadata was present)
 *   - `merged-final-kind` (the kind of the final merged message)
 *
 * This is the primary evidence point for verifying in trace that a plugin
 * actually wrote the meta-protocol field at iter=9 (maxIter-1).
 */

import { wrapFunction } from "../../log-trace/decorator";
import type { ModelMessage } from "ai";

/**
 * Kinds of fake user messages. Used for deterministic merge ordering.
 *
 * Priority (KIND_PRIORITY below): "max-iter" > "task-ops" > "delegate"
 * - "max-iter" reminders contain "不要再调用任何工具，直接总结" (final instruction)
 * - "task-ops" reminders contain "task_operation_list" (Task #5081:
 *   sub-agent awareness of others' task operations)
 * - "delegate" reminders contain "use delegate_task" (earlier hint)
 *
 * The final merged message always ends with the max-iter reminder.
 */
export type FakeUserMessageKind = "delegate" | "task-ops" | "max-iter";

/**
 * Merge priority per kind — higher value = appears later in the
 * merged message / wins the finalKind. Task #5081: "task-ops" sits
 * between "delegate" (business hint) and "max-iter" (final word).
 */
export const KIND_PRIORITY: Record<FakeUserMessageKind, number> = {
  delegate: 10,
  "task-ops": 20,
  "max-iter": 30,
};

/**
 * Hidden metadata field used to remember the kind of the existing
 * `toAddFakeUserMessage` message. AgentComponent's
 * `consumeMetaProtocolUserMessage` does NOT read this field, so it does
 * not interfere with the existing meta-protocol.
 */
const KIND_FIELD = "__fakeUserMessageKind" as const;

/**
 * Ensure `toolResult.result.metadata` exists. Mutates the input.
 *
 * @returns the metadata object, or undefined if `toolResult` is missing
 *   (caller should skip in that case)
 */
function ensureMetadata(toolResult: any): Record<string, unknown> | undefined {
  if (!toolResult) return undefined;
  if (!toolResult.result) toolResult.result = {};
  if (!toolResult.result.metadata) toolResult.result.metadata = {};
  return toolResult.result.metadata;
}

function stringContent(msg: ModelMessage): string {
  const c = (msg as any)?.content;
  return typeof c === "string" ? c : JSON.stringify(c);
}

/**
 * Internal implementation of the enqueue helper. Not exported directly;
 * instead `enqueueToAddFakeUserMessage` (the wrapped version) is exported
 * so that every call goes through the trace span.
 *
 * @internal
 */
function enqueueToAddFakeUserMessageImpl(
  toolResult: any,
  newMsg: ModelMessage,
  newKind: FakeUserMessageKind,
): { willMerge: boolean; finalKind: FakeUserMessageKind } {
  const meta = ensureMetadata(toolResult);
  if (!meta) return { willMerge: false, finalKind: newKind };

  const existing = meta.toAddFakeUserMessage as ModelMessage | undefined;
  const existingKind = meta[KIND_FIELD] as FakeUserMessageKind | undefined;

  if (!existing) {
    // First write: just set it
    meta.toAddFakeUserMessage = newMsg;
    meta[KIND_FIELD] = newKind;
    return { willMerge: false, finalKind: newKind };
  }

  // Merge deterministically (Task #5081: priority-based ordering):
  //   - "max-iter" goes at the END (final instruction)
  //   - "delegate" goes before "task-ops"; "task-ops" before "max-iter"
  //   - Same kind → append (newer after older)
  let merged: ModelMessage;
  if (KIND_PRIORITY[newKind] >= KIND_PRIORITY[existingKind ?? newKind]) {
    // New kind is equal-or-higher priority → new message goes AFTER
    merged = {
      role: "user",
      content: `${stringContent(existing)}\n\n${stringContent(newMsg)}`,
    } as ModelMessage;
  } else {
    // New kind is lower priority → new message goes BEFORE
    merged = {
      role: "user",
      content: `${stringContent(newMsg)}\n\n${stringContent(existing)}`,
    } as ModelMessage;
  }
  meta.toAddFakeUserMessage = merged;
  const finalKind: FakeUserMessageKind =
    KIND_PRIORITY[newKind] >= KIND_PRIORITY[existingKind ?? newKind]
      ? newKind
      : (existingKind ?? newKind);
  meta[KIND_FIELD] = finalKind;
  return { willMerge: true, finalKind };
}

/**
 * Enqueue a fake user message via the meta-protocol field
 * `toolResult.result.metadata.toAddFakeUserMessage`.
 *
 * If the field is empty, sets it. If the field is already set (by another
 * plugin firing in the same `agent:after.tool` invocation), merges the new
 * message with the existing one deterministically:
 *   - "max-iter" messages always go AFTER (final instruction at the end)
 *   - "delegate" messages go BEFORE if existing was max-iter; otherwise
 *     normal "newer wins" by appending (rare; two delegates on same iter)
 *
 * Both reminders are preserved — no silent overwrite.
 *
 * The original kind marker is stored in `__fakeUserMessageKind` (hidden
 * metadata field) and is NOT read by AgentComponent's
 * `consumeMetaProtocolUserMessage`. AgentComponent only reads
 * `toAddFakeUserMessage` and deletes it; other metadata fields are
 * untouched.
 *
 * @param toolResult - `ctx.toolResult` (mutated in-place)
 * @param newMsg - The new fake user message
 * @param newKind - Kind of the new message (determines merge order)
 */
export const enqueueToAddFakeUserMessage = wrapFunction(
  enqueueToAddFakeUserMessageImpl,
  "plugin.fake-user-message.enqueue",
  {
    recordParams: false,
    recordResult: false,
    log: true,
    resultFilter: (result: { willMerge: boolean; finalKind: FakeUserMessageKind }) => ({
      "fake-user-message.will_merge": result.willMerge,
      "fake-user-message.final_kind": result.finalKind,
    }),
  },
) as typeof enqueueToAddFakeUserMessageImpl;
