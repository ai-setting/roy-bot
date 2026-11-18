/**
 * @fileoverview Tests for session-graph pure functions (TDD for Task #1739)
 *
 * buildSessionTree + renderSessionTree handle:
 *  - empty input
 *  - single root with no children
 *  - parent-child chains
 *  - multiple roots
 *  - orphan sessions (parentSessionId points to a missing session)
 *  - cycles (A → B → A)
 *  - self-references (A.parentSessionId === A.id)
 *  - sessions with missing/undefined parentSessionId (legacy data)
 *
 * The output is an ASCII tree with markers for orphan/cycle.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  buildSessionTree,
  renderSessionTree,
  formatNodeLabel,
  inferSourceLabel,
  expandSessionAncestors,
} from "./session-graph";
import type { Session, SessionComponent } from "@ai-setting/roy-bot-core";

function mkSession(
  id: string,
  partial: Partial<Session> & { createdAt?: number; metadata?: any } = {}
): Session {
  return {
    id,
    title: `Session ${id}`,
    directory: "/tmp",
    parentSessionId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messageCount: 0,
    metadata: {},
    ...partial,
  };
}

describe("buildSessionTree", () => {
  it("returns empty roots/orphans/cycles for empty input", () => {
    const tree = buildSessionTree([]);
    expect(tree.roots).toEqual([]);
    expect(tree.orphans).toEqual([]);
    expect(tree.cycles).toEqual(new Set());
  });

  it("treats a single session with no parent as a root", () => {
    const s = mkSession("a");
    const tree = buildSessionTree([s]);
    expect(tree.roots.map((n) => n.session.id)).toEqual(["a"]);
    expect(tree.orphans).toEqual([]);
    expect(tree.cycles).toEqual(new Set());
  });

  it("groups child sessions under their parent", () => {
    const parent = mkSession("p");
    const child1 = mkSession("c1", { parentSessionId: "p" });
    const child2 = mkSession("c2", { parentSessionId: "p" });
    const grand = mkSession("g", { parentSessionId: "c1" });

    const tree = buildSessionTree([parent, child1, child2, grand]);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.session.id).toBe("p");
    expect(tree.roots[0]!.children.map((c) => c.session.id).sort()).toEqual([
      "c1",
      "c2",
    ]);
    const c1 = tree.roots[0]!.children.find((c) => c.session.id === "c1")!;
    expect(c1.children.map((c) => c.session.id)).toEqual(["g"]);
  });

  it("handles multiple independent roots", () => {
    const a = mkSession("a");
    const b = mkSession("b");
    const c1 = mkSession("c1", { parentSessionId: "a" });

    const tree = buildSessionTree([a, b, c1]);
    expect(tree.roots.map((n) => n.session.id).sort()).toEqual(["a", "b"]);
    expect(tree.orphans).toEqual([]);
  });

  it("flags orphan sessions (parent does not exist in input)", () => {
    const orphan = mkSession("o", { parentSessionId: "ghost" });
    const tree = buildSessionTree([orphan]);
    expect(tree.roots).toEqual([]);
    expect(tree.orphans.map((s) => s.id)).toEqual(["o"]);
  });

  it("survives a 2-node cycle without infinite recursion", () => {
    const a = mkSession("a", { parentSessionId: "b" });
    const b = mkSession("b", { parentSessionId: "a" });
    const tree = buildSessionTree([a, b]);
    // Whichever we pick as the entry point, the other becomes the parent
    // and we'd recurse — must be cut by cycle detection.
    expect(tree.cycles.size).toBeGreaterThanOrEqual(1);
    // The total nodes visited (roots + orphans + cycle members) should be 2
    const totalNodes =
      tree.roots.reduce((acc, n) => acc + 1 + countDeep(n), 0) + tree.orphans.length;
    expect(totalNodes).toBe(2);
  });

  it("survives a self-reference without infinite recursion", () => {
    const a = mkSession("a", { parentSessionId: "a" });
    const tree = buildSessionTree([a]);
    expect(tree.cycles.has("a")).toBe(true);
    const totalNodes =
      tree.roots.reduce((acc, n) => acc + 1 + countDeep(n), 0) + tree.orphans.length;
    expect(totalNodes).toBe(1);
  });

  it("treats sessions with parentSessionId === null as roots", () => {
    const a = mkSession("a", { parentSessionId: null });
    const tree = buildSessionTree([a]);
    expect(tree.roots.map((n) => n.session.id)).toEqual(["a"]);
  });

  it("treats sessions with parentSessionId === undefined as roots (legacy data)", () => {
    const a: Session = {
      ...mkSession("a"),
      parentSessionId: undefined as any, // simulate legacy
    };
    const tree = buildSessionTree([a]);
    expect(tree.roots.map((n) => n.session.id)).toEqual(["a"]);
  });
});

describe("renderSessionTree", () => {
  it("renders 'No sessions.' for empty input", () => {
    expect(renderSessionTree(buildSessionTree([]))).toBe("No sessions.");
  });

  it("renders a single root with a leaf line", () => {
    const s = mkSession("a", {
      title: "Workflow X",
      metadata: { type: "workflow", status: "running" },
    });
    const out = renderSessionTree(buildSessionTree([s]));
    expect(out).toContain("Session Tree");
    expect(out).toContain("workflow");
    expect(out).toContain("running");
  });

  it("renders children under their parent with tree branches", () => {
    const p = mkSession("p", {
      title: "Parent",
      metadata: { type: "workflow" },
    });
    const c1 = mkSession("c1", {
      title: "Child1",
      parentSessionId: "p",
      metadata: { type: "agent" },
    });
    const c2 = mkSession("c2", {
      title: "Child2",
      parentSessionId: "p",
      metadata: { type: "agent" },
    });
    // Grandchild to force the `│` vertical bar continuation line
    const g1 = mkSession("g1", {
      title: "Grand1",
      parentSessionId: "c1",
      metadata: { type: "agent" },
    });
    const out = renderSessionTree(buildSessionTree([p, c1, c2, g1]));
    // p has 2 children, so c1 line uses TREE_BRANCH (├── ) and c2 uses LAST (└── )
    // g1 is the last child of c1, so its line is `└── g1` after the `│   ` prefix
    expect(out).toContain("├── c1");
    expect(out).toContain("└── c2");
    expect(out).toContain("│");
    expect(out).toContain("└── g1");
  });

  it("renders orphans with a [orphan] marker", () => {
    const orphan = mkSession("o", { parentSessionId: "missing" });
    const out = renderSessionTree(buildSessionTree([orphan]));
    expect(out).toContain("[orphan]");
  });

  it("renders cycles with a [cycle] marker and does not loop", () => {
    const a = mkSession("a", { parentSessionId: "b" });
    const b = mkSession("b", { parentSessionId: "a" });
    const out = renderSessionTree(buildSessionTree([a, b]));
    expect(out).toContain("[cycle]");
    // Should not have more than 2 sessions
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThan(5);
  });

  it("default: includes the FULL session id in the rendered node (no truncation)", () => {
    const s = mkSession("session_abcdef1234567890");
    const out = renderSessionTree(buildSessionTree([s]));
    // Bug fix: do NOT truncate to 8 chars by default. Show full id.
    expect(out).toContain("session_abcdef1234567890");
    // Make sure the truncated form is NOT present (unless it happens to be a substring,
    // which is not the case here since "abcdef12" is not a substring of the full id).
    expect(out).not.toMatch(/\babcdef12\b/);
  });

  it("default: formatNodeLabel returns the full session id (no truncation)", () => {
    const s = mkSession("session_abcdef1234567890");
    const label = formatNodeLabel(s, false);
    expect(label).toContain("session_abcdef1234567890");
  });

  it("with useShortId=true, truncates session id to first 8 meaningful chars", () => {
    const s = mkSession("session_abcdef1234567890");
    const label = formatNodeLabel(s, false, false, { useShortId: true });
    // Legacy behavior: strip the `session_` prefix and keep first 8 chars
    expect(label).toContain("abcdef12");
    // The full id should NOT be present when useShortId is enabled
    expect(label).not.toContain("session_abcdef1234567890");
  });

  it("renderSessionTree respects useShortId option for all nodes", () => {
    const parent = mkSession("session_abcdef1234567890");
    const child = mkSession("session_child9876543210", {
      parentSessionId: "session_abcdef1234567890",
    });
    const out = renderSessionTree(buildSessionTree([parent, child]), { useShortId: true });
    // Both nodes should show 8-char prefix
    expect(out).toContain("abcdef12");
    expect(out).toContain("child987");
    // Neither should show the full id when useShortId is true
    expect(out).not.toContain("session_abcdef1234567890");
    expect(out).not.toContain("session_child9876543210");
  });

  it("default renderSessionTree shows full id for parent AND child (no truncation)", () => {
    const parent = mkSession("session_abcdef1234567890");
    const child = mkSession("session_child9876543210", {
      parentSessionId: "session_abcdef1234567890",
    });
    const out = renderSessionTree(buildSessionTree([parent, child]));
    expect(out).toContain("session_abcdef1234567890");
    expect(out).toContain("session_child9876543210");
  });
});

// Helper for cycle tests
function countDeep(node: { children: any[] }): number {
  let n = 0;
  for (const c of node.children) {
    n += 1 + countDeep(c);
  }
  return n;
}

describe("inferSourceLabel (Issue #7)", () => {
  it("returns the workflow type from metadata.type", () => {
    expect(inferSourceLabel(mkSession("a", { metadata: { type: "workflow", workflowName: "demo" } })))
      .toBe("workflow/demo");
    expect(inferSourceLabel(mkSession("a", { metadata: { type: "workflow" } })))
      .toBe("workflow");
  });

  it("returns 'agent' from metadata.type", () => {
    expect(inferSourceLabel(mkSession("a", { metadata: { type: "agent" } })))
      .toBe("agent");
  });

  it("returns '[subagent]' from metadata.type", () => {
    expect(inferSourceLabel(mkSession("a", { metadata: { type: "subagent" } })))
      .toBe("[subagent]");
    expect(inferSourceLabel(mkSession("a", { metadata: { type: "sub-agent" } })))
      .toBe("[subagent]");
  });

  it("returns 'chat' from metadata.type", () => {
    expect(inferSourceLabel(mkSession("a", { metadata: { type: "chat" } })))
      .toBe("chat");
  });

  // Issue #7: title-prefix fallback is misleading. A chat titled
  // "Workflow fishing discussion" must NOT be labelled "workflow".
  it("does NOT infer 'workflow' from a title like 'Workflow fishing discussion'", () => {
    const s = mkSession("a", { title: "Workflow fishing discussion" });
    expect(inferSourceLabel(s)).not.toBe("workflow");
    expect(inferSourceLabel(s)).not.toMatch(/^workflow/);
  });

  it("does NOT infer 'agent' from a title like 'Agent Smith vs workflow'", () => {
    const s = mkSession("a", { title: "Agent Smith vs workflow" });
    expect(inferSourceLabel(s)).not.toBe("agent");
  });

  it("defaults to 'chat' when metadata.type is missing (no title guessing)", () => {
    expect(inferSourceLabel(mkSession("a"))).toBe("chat");
    expect(inferSourceLabel(mkSession("a", { title: "Anything" }))).toBe("chat");
  });
});

// ============================================================================
// expandSessionAncestors (Task #1955)
//
// Used by `sessions list --graph` so the tree stays complete even when the
// `--limit/--offset` window excludes the ancestors themselves.
// Without this, `buildSessionTree` would treat those children as orphans
// (promoted to root) and the tree would appear flat.
//
// Test scope: pure async function over a mocked SessionComponent (no fs, no
// chalk dep, no console output — verifiable in isolation). Uses `.get` (NOT
// `.getSession`) since `.getSession` returns the simplified Memory Agent
// shape, but we need the full Session for buildSessionTree.
// ============================================================================

describe("expandSessionAncestors", () => {
  it("returns an empty array for empty input", async () => {
    const fake = { get: mock(async () => undefined) } as unknown as SessionComponent;
    const out = await expandSessionAncestors(fake, []);
    expect(out).toEqual([]);
    // No fetches on empty input.
    expect((fake.get as any).mock.calls.length).toBe(0);
  });

  it("returns the original array (no fetches) when no session has a parentSessionId", async () => {
    const s1 = mkSession("session_a");
    const s2 = mkSession("session_b");
    const fake = { get: mock(async () => undefined) } as unknown as SessionComponent;
    const out = await expandSessionAncestors(fake, [s1, s2]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.id)).toEqual(["session_a", "session_b"]);
    expect((fake.get as any).mock.calls.length).toBe(0);
  });

  it("returns the original array when every parentSessionId resolves locally (no fetches needed)", async () => {
    // parent is in the list, so no expansion needed.
    const parent = mkSession("session_parent");
    const child = mkSession("session_child", { parentSessionId: "session_parent" });
    const fake = { get: mock(async () => undefined) } as unknown as SessionComponent;
    const out = await expandSessionAncestors(fake, [parent, child]);
    expect(out.map((s) => s.id).sort()).toEqual(["session_child", "session_parent"]);
    expect((fake.get as any).mock.calls.length).toBe(0);
  });

  it("fetches exactly one missing parent when one child points outside the list (calls get 1x)", async () => {
    const outsideParent = mkSession("session_outside");
    const child = mkSession("session_child", { parentSessionId: "session_outside" });
    const fake = {
      get: mock(async (id: string) => (id === "session_outside" ? outsideParent : undefined)),
    } as unknown as SessionComponent;
    const out = await expandSessionAncestors(fake, [child]);
    expect(out.map((s) => s.id).sort()).toEqual(["session_child", "session_outside"]);
    expect((fake.get as any).mock.calls.length).toBe(1);
    expect((fake.get as any).mock.calls[0]).toEqual(["session_outside"]);
  });

  it("chains multi-level missing ancestors via repeated get calls", async () => {
    // Seed list contains only "session_c" (parent=session_b). We need to
    // fetch session_b, then session_b's parent (session_a), and verify
    // both are added.
    const grand = mkSession("session_a");
    const parent = mkSession("session_b", { parentSessionId: "session_a" });
    const child = mkSession("session_c", { parentSessionId: "session_b" });
    const fake = {
      get: mock(async (id: string) => {
        if (id === "session_b") return parent;
        if (id === "session_a") return grand;
        return undefined;
      }),
    } as unknown as SessionComponent;

    const out = await expandSessionAncestors(fake, [child]);
    expect(out.map((s) => s.id).sort()).toEqual(["session_a", "session_b", "session_c"]);
    // Should have called get for session_b (the child's missing parent)
    // then session_a (the parent's missing parent).
    expect((fake.get as any).mock.calls.length).toBe(2);
    expect((fake.get as any).mock.calls[0]).toEqual(["session_b"]);
    expect((fake.get as any).mock.calls[1]).toEqual(["session_a"]);
  });

  it("cycles safely (A.parent=B, B.parent=A) — does not infinite loop", async () => {
    const a = mkSession("session_a", { parentSessionId: "session_b" });
    const b = mkSession("session_b", { parentSessionId: "session_a" });
    const fake = {
      get: mock(async (id: string) =>
        id === "session_b" ? b : id === "session_a" ? a : undefined
      ),
    } as unknown as SessionComponent;
    // Should resolve quickly (cycle protection via visited Set<string>).
    const out = await expandSessionAncestors(fake, [a]); // a's parent (session_b) will fetch
    // We started with [a]; the chain brings in [b]. b's parent is "session_a"
    // which is already in the map, so BFS stops.
    expect(out.map((s) => s.id).sort()).toEqual(["session_a", "session_b"]);
    // Should be exactly 1 fetch: one for the seed missing parent (session_b),
    // and the next parent is already known so BFS stops.
    expect((fake.get as any).mock.calls.length).toBe(1);
  });

  it("does not refetch a parent already present locally (dedup)", async () => {
    const parent = mkSession("session_parent");
    const c1 = mkSession("session_c1", { parentSessionId: "session_parent" });
    const c2 = mkSession("session_c2", { parentSessionId: "session_parent" });
    const c3 = mkSession("session_c3", { parentSessionId: "session_parent" });
    const fake = { get: mock(async () => undefined) } as unknown as SessionComponent;
    const out = await expandSessionAncestors(fake, [parent, c1, c2, c3]);
    expect(out).toHaveLength(4);
    // parent is local to all 3 children — no fetches.
    expect((fake.get as any).mock.calls.length).toBe(0);
  });

  it("treats null / undefined / empty-string parentSessionId as no parent (no fetch)", async () => {
    const s1 = mkSession("session_a", { parentSessionId: null });
    const s2 = mkSession("session_b", { parentSessionId: undefined });
    const s3 = mkSession("session_c", { parentSessionId: "" });
    const fake = { get: mock(async () => undefined) } as unknown as SessionComponent;
    const out = await expandSessionAncestors(fake, [s1, s2, s3]);
    expect(out).toHaveLength(3);
    expect((fake.get as any).mock.calls.length).toBe(0);
  });

  it("skips silently when get returns null/undefined for a missing parent", async () => {
    // child points at parent id="session_ghost" which doesn't exist in the store.
    // We should NOT throw and we should still return the original child.
    const child = mkSession("session_c", { parentSessionId: "session_ghost" });
    const fake = {
      get: mock(async () => undefined),
    } as unknown as SessionComponent;
    const out = await expandSessionAncestors(fake, [child]);
    expect(out.map((s) => s.id)).toEqual(["session_c"]);
    expect((fake.get as any).mock.calls.length).toBe(1);
  });
});
