/**
 * @fileoverview Session Graph — pure functions for hierarchical session display
 *
 * Provides two pure functions used by the `sessions list --graph` command:
 *  - `buildSessionTree(sessions)` walks the parent/child links in a flat list
 *    of sessions and returns roots, orphans, and cycle members.
 *  - `renderSessionTree(built)` formats the structure as an ASCII tree.
 *
 * Both functions are pure (no I/O) so they can be unit-tested in isolation.
 */

import type { Session, SessionComponent } from "@ai-setting/roy-bot-core";

// ============================================================================
// Types
// ============================================================================

/** A node in the built tree, holding a session and its children. */
export interface SessionNode {
  session: Session;
  children: SessionNode[];
}

/** Result of buildSessionTree. */
export interface SessionTree {
  /** Sessions at the top of the tree (no parentSessionId, or null/undefined).
   *  Their children are attached recursively. */
  roots: SessionNode[];
  /** Sessions whose parentSessionId points to a session NOT in the input.
   *  These are listed as top-level [orphan] entries after the roots. */
  orphans: Session[];
  /** Sessions that participate in a cycle (would otherwise cause infinite recursion). */
  cycles: Set<string>;
}

// ============================================================================
// buildSessionTree
// ============================================================================

/**
 * Build a forest from a flat list of sessions.
 *
 * Rules:
 *  - A session with `parentSessionId` null/undefined/empty is a ROOT.
 *  - A session whose `parentSessionId` points to a session NOT in the input
 *    is reported as an ORPHAN (still rendered, but flagged).
 *  - A cycle (A → B → A or A → A) is broken: the back-edge session is
 *    added to `cycles` and recursion stops. The cycle members are still
 *    surfaced as roots so the user can see them.
 *
 * @param sessions Flat list of sessions (any order, no requirement for parents
 *                 to come before children)
 */
export function buildSessionTree(sessions: Session[]): SessionTree {
  const byId = new Map<string, Session>();
  // Pre-compute parent → children index for O(N) lookups in `build()`.
  // Without this, `build()` would scan every session on each recursion
  // (O(N²) total) — see Issue #4.
  const childrenByParent = new Map<string, Session[]>();
  for (const s of sessions) {
    byId.set(s.id, s);
    const pid = s.parentSessionId;
    if (pid !== null && pid !== undefined && pid !== "") {
      const bucket = childrenByParent.get(pid);
      if (bucket) bucket.push(s);
      else childrenByParent.set(pid, [s]);
    }
  }

  const cycleMembers = new Set<string>();
  const consumed = new Set<string>();

  function build(session: Session, ancestorStack: Set<string>): SessionNode {
    const node: SessionNode = { session, children: [] };
    const candidates = childrenByParent.get(session.id) ?? [];

    for (const candidate of candidates) {
      if (ancestorStack.has(candidate.id)) {
        // Back-edge → cycle
        cycleMembers.add(candidate.id);
        cycleMembers.add(session.id);
        continue;
      }
      if (consumed.has(candidate.id)) {
        // Already attached under another branch — skip to avoid duplicates.
        continue;
      }
      consumed.add(candidate.id);

      const nextStack = new Set(ancestorStack);
      nextStack.add(session.id);
      const child = build(candidate, nextStack);
      node.children.push(child);
    }

    return node;
  }

  const roots: SessionNode[] = [];
  const orphans: Session[] = [];

  for (const s of sessions) {
    const parentId = s.parentSessionId;
    const hasParentId =
      parentId !== null && parentId !== undefined && parentId !== "";

    if (!hasParentId) {
      if (consumed.has(s.id)) continue;
      consumed.add(s.id);
      const node = build(s, new Set([s.id]));
      roots.push(node);
    } else if (!byId.has(parentId)) {
      orphans.push(s);
    }
    // else: will be attached when its parent's build() runs
  }

  // After the main pass, anything left unattached is part of a cycle.
  // (e.g. a → b → a: neither was a root, neither had a missing parent, but
  // they were never attached because build(a) was never called.)
  if (consumed.size + orphans.length < sessions.length) {
    for (const s of sessions) {
      if (consumed.has(s.id)) continue;
      if (orphans.includes(s)) continue;
      // Detect cycle membership by walking the parent chain.
      const visited = new Set<string>();
      let cur: Session | undefined = s;
      while (cur) {
        if (visited.has(cur.id)) {
          // Mark everyone in the loop as a cycle member
          for (const v of visited) cycleMembers.add(v);
          cycleMembers.add(s.id);
          break;
        }
        visited.add(cur.id);
        const pid = cur.parentSessionId;
        if (pid === null || pid === undefined || pid === "") break;
        cur = byId.get(pid);
      }
      consumed.add(s.id);
      const node = build(s, new Set([s.id]));
      roots.push(node);
    }
  }

  return { roots, orphans, cycles: cycleMembers };
}

// ============================================================================
// renderSessionTree
// ============================================================================

const TREE_BRANCH = "├── ";
const TREE_LAST = "└── ";
const TREE_VERTICAL = "│   ";
const TREE_EMPTY = "    ";

/** Options controlling how the tree is rendered. */
export interface RenderOptions {
  /**
   * When `true`, session ids are truncated to the legacy 8-char prefix
   * (stripped of `session_` / `workflow_` etc.). Default is `false`:
   * the full session id (with its prefix) is shown.
   */
  useShortId?: boolean;
}

/**
 * Render a built tree as an ASCII tree.
 *
 * The output starts with a `Session Tree` header. Orphans and cycle members
 * are annotated with `[orphan]` / `[cycle]` markers respectively.
 */
export function renderSessionTree(
  tree: SessionTree,
  options: RenderOptions = {}
): string {
  if (tree.roots.length === 0 && tree.orphans.length === 0) {
    return "No sessions.";
  }

  const lines: string[] = ["Session Tree"];

  // Render roots
  for (let i = 0; i < tree.roots.length; i++) {
    const isLast = i === tree.roots.length - 1 && tree.orphans.length === 0;
    renderNode(tree.roots[i]!, "", isLast, lines, tree.cycles, options);
  }

  // Render orphans at the end with a marker
  if (tree.orphans.length > 0) {
    for (let i = 0; i < tree.orphans.length; i++) {
      const s = tree.orphans[i]!;
      const isLast = i === tree.orphans.length - 1;
      const branch = isLast ? TREE_LAST : TREE_BRANCH;
      lines.push(`${branch}${formatNodeLabel(s, true, false, options)}`);
    }
  }

  return lines.join("\n");
}

function renderNode(
  node: SessionNode,
  prefix: string,
  isLast: boolean,
  lines: string[],
  cycles: Set<string>,
  options: RenderOptions
): void {
  const branch = isLast ? TREE_LAST : TREE_BRANCH;
  const isCycle = cycles.has(node.session.id);
  lines.push(
    `${prefix}${branch}${formatNodeLabel(node.session, false, isCycle, options)}`
  );

  const childPrefix = prefix + (isLast ? TREE_EMPTY : TREE_VERTICAL);
  for (let i = 0; i < node.children.length; i++) {
    const isChildLast = i === node.children.length - 1;
    renderNode(node.children[i]!, childPrefix, isChildLast, lines, cycles, options);
  }
}

/**
 * Format a single node's display label.
 *   `<id> <sourceLabel> (<status>) <createdAt>`
 * Plus an `[orphan]` or `[cycle]` marker for non-tree sessions.
 *
 * By default the full session id is rendered (e.g. `session_abcdef1234567890`).
 * Pass `options.useShortId = true` to fall back to the legacy 8-char prefix
 * (e.g. `abcdef12`), which is useful for very wide terminal widths.
 */
export function formatNodeLabel(
  session: Session,
  isOrphan: boolean,
  isCycle = false,
  options: RenderOptions = {}
): string {
  const idStr = options.useShortId ? shortSessionId(session.id) : session.id;
  const sourceLabel = inferSourceLabel(session);
  const status = inferStatus(session);
  const created = new Date(session.createdAt).toISOString().slice(0, 16).replace("T", " ");
  const parts = [idStr, sourceLabel];
  if (status) parts.push(`(${status})`);
  parts.push(created);
  let label = parts.join(" ");
  if (isOrphan) label = `[orphan] ${label}`;
  if (isCycle) label = `[cycle] ${label}`;
  return label;
}

/**
 * Short, recognizable id (8 chars after stripping common prefixes like
 * `session_` or `workflow_` so the meaningful portion survives).
 * Examples:
 *   session_abcdef1234567890      → abcdef12
 *   workflow_1700000000000_1_xxx  → 17000000
 *   chat_short                    → chat_sho (literal first 8)
 */
export function shortSessionId(id: string): string {
  // Strip a leading prefix (everything up to and including the first `_`)
  const underscoreIdx = id.indexOf("_");
  const stripped =
    underscoreIdx > 0 && underscoreIdx < id.length - 8
      ? id.slice(underscoreIdx + 1)
      : id;
  return stripped.length > 8 ? stripped.slice(0, 8) : stripped;
}

/**
 * Best-effort source label from metadata.type.
 *
 * Issue #7: title-prefix inference (e.g. "if title starts with 'workflow'")
 * is misleading — a chat titled "Workflow fishing discussion" must NOT be
 * labelled as a workflow. We therefore rely solely on metadata.type:
 *  - workflow / agent / subagent / chat → corresponding label
 *  - anything else (including no metadata) → "chat" as a safe default.
 *
 * Downstream code that needs accurate workflow/agent labelling should
 * ensure metadata.type is set at session creation (Task #1739's design).
 */
export function inferSourceLabel(session: Session): string {
  const meta = session.metadata as Record<string, unknown> | undefined;
  const type = meta?.type;
  if (type === "workflow") {
    const name = meta?.workflowName as string | undefined;
    return name ? `workflow/${name}` : "workflow";
  }
  if (type === "agent") return "agent";
  if (type === "subagent" || type === "sub-agent") return "[subagent]";
  // Default: treat as a chat session.
  return "chat";
}

/** Best-effort status from metadata.status. */
export function inferStatus(session: Session): string | null {
  const meta = session.metadata as Record<string, unknown> | undefined;
  const status = meta?.status;
  if (typeof status === "string" && status.length > 0) return status;
  return null;
}

// ============================================================================
// expandSessionAncestors (Task #1955)
//
// `sessions list --limit N --graph` only returns N sessions. If a returned
// session points to a parent that is OUTSIDE that --limit window,
// `buildSessionTree` will promote the child to root (orphan), and the tree
// loses its hierarchy.
//
// `expandSessionAncestors` fixes this by BFS-fetching any missing ancestors
// referenced via `parentSessionId`. It returns a new array: the original
// sessions PLUS the newly fetched ancestors, suitable for handing to
// `buildSessionTree` to produce a complete tree.
//
// Cycle protection: a `visited: Set<string>` ensures we never re-fetch
// an ancestor we've already pulled (and never infinite-loop on data
// that has a cycle like A→B→A).
// ============================================================================

/**
 * Expand a flat session list by fetching any missing ancestors referenced
 * via `parentSessionId`. Returns a new array containing the original
 * sessions PLUS any newly fetched ancestors.
 *
 * The BFS starts from the seed `sessions` and walks the `parentSessionId`
 * pointers in increasing-distance order. If an ancestor's grandparent is
 * still missing, that one is fetched next, and so on — until the chain
 * either resolves to a root, an already-known session, or to a parent
 * that does not exist in the store (in which case `get` returns
 * null/undefined and we skip silently).
 *
 * The returned array order is "original sessions first (in original input
 * order), then any newly fetched ancestors appended". This is *not* used
 * for sorting or display — `buildSessionTree` handles ordering.
 *
 * Side effects: calls `sessionComponent.get(id)` at most N times, where
 * N is the number of distinct missing ancestors reachable from the
 * input via the `parentSessionId` chain.
 *
 * Note: uses `sessionComponent.get` (NOT `.getSession`) — the latter is
 * the simplified Memory Agent API (`{sessionId, title, messages}`) and
 * lacks the full `Session` shape (with `parentSessionId`, `metadata`,
 * `createdAt`, etc.) required by `buildSessionTree`.
 *
 * @param sessionComponent The SessionComponent instance to fetch parents from.
 * @param sessions         Flat list of sessions to expand.
 * @returns                New array: input sessions ∪ fetched ancestors.
 */
export async function expandSessionAncestors(
  sessionComponent: SessionComponent,
  sessions: Session[]
): Promise<Session[]> {
  // 1) Build a working map keyed by id. We mutate the Map through the
  //    BFS but produce a fresh array at the end so we never alter the
  //    caller's reference.
  const sessionById = new Map<string, Session>();
  for (const s of sessions) sessionById.set(s.id, s);

  // 2) Seed queue with parent ids that are MISSING from the seed list.
  //    `visited` doubles as both a "do not re-enqueue" guard AND the
  //    cycle-breaker: if A→B→A appears, the second time we see A it's
  //    already in `visited` so it won't be pushed again.
  const queue: string[] = [];
  const visited = new Set<string>();

  for (const s of sessions) {
    const pid = s.parentSessionId;
    if (
      pid !== null &&
      pid !== undefined &&
      pid !== "" &&
      !sessionById.has(pid) &&
      !visited.has(pid)
    ) {
      queue.push(pid);
      visited.add(pid);
    }
  }

  // 3) BFS fetch. For each queued id, ask the store for the session. If
  //    the store returns null/undefined (parent deleted, bad data), skip
  //    silently — don't crash the user's tree view. Newly fetched sessions
  //    that themselves have a parent we don't know yet get enqueued.
  while (queue.length > 0) {
    const id = queue.shift()!;
    const parent = await sessionComponent.get(id);
    if (!parent) continue; // parent was deleted or never existed
    sessionById.set(parent.id, parent);
    const ppid = parent.parentSessionId;
    if (
      ppid !== null &&
      ppid !== undefined &&
      ppid !== "" &&
      !sessionById.has(ppid) &&
      !visited.has(ppid)
    ) {
      queue.push(ppid);
      visited.add(ppid);
    }
  }

  // 4) Return values. We seed the result with the ORIGINAL input order so
  //    that any consumer that relied on input order sees the same first
  //    N sessions in the same positions; newly fetched ancestors follow.
  const orderedIds: string[] = [];
  for (const s of sessions) {
    if (!orderedIds.includes(s.id)) orderedIds.push(s.id);
  }
  for (const id of sessionById.keys()) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }
  return orderedIds.map((id) => sessionById.get(id)!);
}
