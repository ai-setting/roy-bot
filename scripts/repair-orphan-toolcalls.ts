#!/usr/bin/env bun
/**
 * Orphan tool-call scan & repair (Task #4992, P0).
 *
 * Orphan semantics = AI SDK v6 POSITIONAL pending-set
 * (node_modules/ai/dist/index.mjs:1359-1387):
 *   - assistant tool-call → id added to the pending set;
 *   - tool-result → id removed;
 *   - a user/system message with a non-empty pending set → those
 *     pending calls are orphans (the converter would throw here);
 *   - end-of-history pending calls are orphans too.
 * A tool-result arriving AFTER the next user/system message does NOT
 * pair with its call.
 *
 * Usage:
 *   bun scripts/repair-orphan-toolcalls.ts <db_path>                 # scan & report
 *   bun scripts/repair-orphan-toolcalls.ts <db_path> --repair <session_id>
 *       [--reason "<text>"] [--include-archived]
 *
 * Scan mode is strictly read-only. Repair mode:
 *  - pairs EVERY positional orphan with a placeholder tool-result
 *    message INSERTED BETWEEN the orphan assistant message and the
 *    following user/system message (timestamp inside
 *    [assistantTs, boundaryTs) — the next user boundary's timestamp
 *    minus 1). Never touches any existing row: INSERT only.
 *  - end-of-history orphans get a placeholder at session end
 *    (timestamp = lastTs + 1).
 *  - the post-repair verification uses the SAME pending-set
 *    semantics (no false green).
 */

import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: bun scripts/repair-orphan-toolcalls.ts <db_path> [--repair <session_id>] [--reason <text>] [--include-archived]");
  process.exit(2);
}

const dbPath = args[0]!;
const repairIdx = args.indexOf("--repair");
const repairSession = repairIdx >= 0 ? args[repairIdx + 1] : undefined;
const reasonIdx = args.indexOf("--reason");
const reason = reasonIdx >= 0 ? (args[reasonIdx + 1] ?? "") : "run interrupted (Task #4992 backfill)";
const includeArchived = args.includes("--include-archived");

const ORPHAN_PREFIX = "[Tool result missing: run interrupted]";

const db = new Database(dbPath);

interface Part { type: string; toolCallId?: string; toolName?: string; [k: string]: unknown }
interface Row { id: string; session_id: string; role: string; content: string; timestamp: number; parts: string | null; is_archived: number; metadata: string | null }

function parseParts(raw: string | null): Part[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── 1. Load messages ─────────────────────────────────────────
const archivedFilter = includeArchived ? "" : "AND is_archived = 0";
const rows: Row[] = [];
{
  const CHUNK = 200_000;
  const stmt = db.prepare(
    `SELECT id, session_id, role, content, timestamp, parts, is_archived, metadata
     FROM message WHERE 1=1 ${archivedFilter} ORDER BY session_id, timestamp, rowid
     LIMIT ? OFFSET ?`
  );
  let offset = 0;
  for (;;) {
    const chunk = stmt.all(CHUNK, offset) as Row[];
    rows.push(...chunk);
    if (chunk.length < CHUNK) break;
    offset += CHUNK;
  }
}

const bySession = new Map<string, Row[]>();
for (const r of rows) {
  const list = bySession.get(r.session_id) ?? [];
  list.push(r);
  bySession.set(r.session_id, list);
}

// ── 2. Positional orphan scan (pending-set state machine) ────
interface Orphan {
  /** The assistant message carrying the pending tool-call. */
  assistant: Row;
  /** The boundary (user/system) message the orphan collides with;
   *  null = end of history. */
  boundary: Row | null;
  toolCallId: string;
  toolName: string;
}
const orphansBySession = new Map<string, Orphan[]>();

for (const [sessionId, msgs] of bySession) {
  const pending = new Map<string, { toolName: string; assistant: Row }>();
  const found: Orphan[] = [];
  const reported = new Set<string>();

  const flush = (boundary: Row | null) => {
    for (const [id, meta] of pending) {
      if (!reported.has(id)) {
        reported.add(id);
        found.push({ assistant: meta.assistant, boundary, toolCallId: id, toolName: meta.toolName });
      }
    }
    pending.clear();
  };

  for (const m of msgs) {
    const parts = parseParts(m.parts);
    // Removals first, then additions (mirrors the converter).
    for (const p of parts) {
      if (p.type === "tool-result" && typeof p.toolCallId === "string") {
        pending.delete(p.toolCallId);
      }
    }
    for (const p of parts) {
      if (p.type === "tool-call" && typeof p.toolCallId === "string" && !pending.has(p.toolCallId)) {
        pending.set(p.toolCallId, { toolName: p.toolName ?? "unknown", assistant: m });
      }
    }
    if ((m.role === "user" || m.role === "system") && pending.size > 0) {
      flush(m);
    }
  }
  // End of history.
  if (pending.size > 0) flush(null);
  if (found.length > 0) orphansBySession.set(sessionId, found);
}

// ── 3. Report ────────────────────────────────────────────────
const totalOrphans = [...orphansBySession.values()].reduce((s, l) => s + l.length, 0);
console.log(`[scan] db=${dbPath} semantics=positional-pending-set`);
console.log(`[scan] sessions=${bySession.size} messages=${rows.length} orphan_tool_calls=${totalOrphans} across ${orphansBySession.size} session(s)`);

for (const [sessionId, list] of [...orphansBySession.entries()].sort()) {
  console.log(`[orphan] session=${sessionId} count=${list.length}`);
  for (const o of list) {
    const b = o.boundary ? `boundary_msg=${o.boundary.id}(${o.boundary.role})@${o.boundary.timestamp}` : "end-of-history";
    console.log(`  - call=${o.toolCallId} tool=${o.toolName} assistant=${o.assistant.id} ts=${o.assistant.timestamp} ${b}`);
  }
}

// ── 4. Repair (single session, explicit) ─────────────────────
if (!repairSession) process.exit(0);

const list = orphansBySession.get(repairSession);
if (!list || list.length === 0) {
  console.log(`[repair] session ${repairSession} has 0 positional orphans — nothing to do.`);
  process.exit(0);
}

const now = Date.now();
const insert = db.prepare(
  `INSERT INTO message (id, session_id, role, content, timestamp, parts, is_archived, metadata)
   VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
);

// Group by (assistant, boundary) pair so the batch timestamp ordering
// stays inside the [assistantTs, boundaryTs) window.
const insertions: Array<{ orphan: Orphan; ts: number; risk: boolean }> = [];
// Occupied timestamps in this session (any message).
const occupiedTs = new Set<number>(
  (bySession.get(repairSession) ?? []).map((m) => m.timestamp),
);
for (const o of list) {
  if (o.boundary) {
    // Strictly before the boundary user message. When the
    // assistant and the user share the same millisecond
    // (equal-ts flush), (assistantTs, boundaryTs) is empty —
    // fall back to boundaryTs-1 or, if occupied, boundaryTs
    // (rowid ordering puts our INSERT after BOTH — flagged).
    const aTs = o.assistant.timestamp;
    const bTs = o.boundary.timestamp;
    const candidate = bTs > aTs ? bTs - 1 : bTs - 1;
    const risk = candidate <= aTs || occupiedTs.has(candidate);
    const ts = risk
      ? (occupiedTs.has(candidate) ? bTs : candidate)
      : candidate;
    insertions.push({ orphan: o, ts, risk });
  } else {
    insertions.push({ orphan: o, ts: Math.max(now, o.assistant.timestamp + 1), risk: false });
  }
}
insertions.sort((a, b) => a.ts - b.ts);
// Ensure ascending timestamps per insertion (stable ORDER BY readback).
insertions.sort((a, b) => a.ts - b.ts);

let inserted = 0;
const repairTx = db.transaction(() => {
  for (const { orphan: o, ts, risk } of insertions) {
    const placeholder: Part = {
      type: "tool-result",
      toolCallId: o.toolCallId,
      toolName: o.toolName,
      output: JSON.stringify({ error: `${ORPHAN_PREFIX} ${reason}` }),
      state: "completed",
    };
    const id = `msg_${crypto.randomUUID()}`;
    insert.run(
      id,
      repairSession,
      "tool",
      "",
      ts,
      JSON.stringify([placeholder]),
      JSON.stringify({
        type: "tool_result",
        repaired_by: "repair-orphan-toolcalls.ts (Task #4992 R3 positional)",
        repaired_at: now,
        paired_assistant: o.assistant.id,
        boundary: o.boundary ? o.boundary.id : "end-of-history",
        ...(risk ? { equal_ts_risk: true } : {}),
      }),
    );
    inserted++;
    console.log(`[repair] + placeholder for ${o.toolCallId} (tool=${o.toolName}) ts=${ts} as ${id}`);
  }
});
repairTx();

console.log(`[repair] done: inserted=${inserted} placeholder message(s) into session=${repairSession}`);

// ── 5. Post-repair verification (SAME pending-set semantics) ─
const postRows = db.prepare(
  `SELECT id, role, timestamp, parts FROM message WHERE session_id = ? ORDER BY timestamp`
).all(repairSession) as Row[];
const postPending = new Set<string>();
let postOrphans = 0;
for (const m of postRows) {
  const parts = parseParts(m.parts);
  for (const p of parts) {
    if (p.type === "tool-result" && typeof p.toolCallId === "string") postPending.delete(p.toolCallId);
    if (p.type === "tool-call" && typeof p.toolCallId === "string") postPending.add(p.toolCallId);
  }
  if ((m.role === "user" || m.role === "system") && postPending.size > 0) postOrphans += postPending.size, postPending.clear();
}
postOrphans += postPending.size;
console.log(`[verify] session=${repairSession} orphan_after=${postOrphans} (expected 0)`);
if (postOrphans > 0) process.exit(1);
console.log("[verify] OK — session positional orphan count is zero.");
