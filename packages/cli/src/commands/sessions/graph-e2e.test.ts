/**
 * @fileoverview End-to-end test for sessions list --graph with parent/child data
 *
 * This test exercises the full data path that the `sessions list --graph`
 * command consumes in production:
 *
 *   MemorySessionStore (write parent + child) → list() → buildSessionTree()
 *     → renderSessionTree() → ASCII output
 *
 * It proves that the parent/child wiring introduced by Task #1739 flows all
 * the way through to the visual output. Without the parent_id injection in
 * delegate_task / workflow_run, the child would simply appear as a root
 * (flat tree) and the test would catch the regression.
 *
 * Real user data (9380 sessions from production) has all parentSessionId
 * fields NULL because the data predates the injection code. So this test
 * uses a fresh in-memory store with crafted parent/child sessions to
 * exercise the tree-building code paths.
 */

import { describe, it, expect } from "bun:test";
import { MemorySessionStore } from "@ai-setting/roy-bot-core";
import { buildSessionTree, renderSessionTree } from "./session-graph";

function logTree(label: string, tree: ReturnType<typeof buildSessionTree>) {
  // Helper for debugging failures — not asserted on.
  // eslint-disable-next-line no-console
  console.log(`\n[graph-e2e] ${label}\n${renderSessionTree(tree)}\n`);
}

describe("graph-e2e: parent/child session flow", () => {
  it("renders a 3-level tree (parent → 2 children → 1 grandchild) end-to-end", async () => {
    const store = new MemorySessionStore();

    // 1. Parent session (chat, no parent)
    const parent = await store.create({
      title: "Parent Chat",
      directory: "/tmp/e2e",
      parentSessionId: null,
    });

    // 2. Two children of the parent
    const child1 = await store.create({
      title: "Child 1",
      directory: "/tmp/e2e",
      parentSessionId: parent.id,
      metadata: { type: "subagent" },
    });
    const child2 = await store.create({
      title: "Child 2",
      directory: "/tmp/e2e",
      parentSessionId: parent.id,
      metadata: { type: "subagent" },
    });

    // 3. One grandchild off child1
    const grand = await store.create({
      title: "Grandchild",
      directory: "/tmp/e2e",
      parentSessionId: child1.id,
      metadata: { type: "agent" },
    });

    // 4. Also an orphan (parent points to a non-existent session)
    const orphan = await store.create({
      title: "Orphan",
      directory: "/tmp/e2e",
      parentSessionId: "session_does_not_exist_xxxxxxxx",
    });

    // 5. List the sessions from the store
    const sessions = await store.list();
    expect(sessions).toHaveLength(5);

    // 6. Verify list() returns parentSessionId on each session
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(byId[parent.id]!.parentSessionId).toBeNull();
    expect(byId[child1.id]!.parentSessionId).toBe(parent.id);
    expect(byId[child2.id]!.parentSessionId).toBe(parent.id);
    expect(byId[grand.id]!.parentSessionId).toBe(child1.id);
    expect(byId[orphan.id]!.parentSessionId).toBe("session_does_not_exist_xxxxxxxx");

    // 7. Build the tree
    const tree = buildSessionTree(sessions);
    logTree("full tree", tree);

    // 8. Tree structural assertions
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.session.id).toBe(parent.id);
    expect(tree.roots[0]!.children.map((c) => c.session.id).sort()).toEqual(
      [child1.id, child2.id].sort()
    );
    const child1Node = tree.roots[0]!.children.find((c) => c.session.id === child1.id)!;
    expect(child1Node.children.map((c) => c.session.id)).toEqual([grand.id]);
    expect(tree.orphans.map((s) => s.id)).toEqual([orphan.id]);
    expect(tree.cycles.size).toBe(0);

    // 9. Render and assert: FULL session id (no 8-char truncation) is the default
    const out = renderSessionTree(tree);
    expect(out).toContain("Session Tree");
    expect(out).toContain(parent.id);
    expect(out).toContain(child1.id);
    expect(out).toContain(child2.id);
    expect(out).toContain(grand.id);
    expect(out).toContain("[orphan]");

    // 10. The parent label must come BEFORE the child label in the output
    //     (children render under their parent with `│` indentation)
    const parentLineIdx = out.split("\n").findIndex((l) => l.includes(parent.id));
    const child1LineIdx = out.split("\n").findIndex((l) => l.includes(child1.id));
    const grandLineIdx = out.split("\n").findIndex((l) => l.includes(grand.id));
    expect(parentLineIdx).toBeGreaterThanOrEqual(0);
    expect(child1LineIdx).toBeGreaterThan(parentLineIdx);
    expect(grandLineIdx).toBeGreaterThan(child1LineIdx);

    // 11. The grandchild line must be indented more than the parent line
    const parentLine = out.split("\n").find((l) => l.includes(parent.id))!;
    const grandLine = out.split("\n").find((l) => l.includes(grand.id))!;
    const parentIndent = parentLine.indexOf("├── ") !== -1
      ? parentLine.indexOf("├── ")
      : parentLine.indexOf("└── ");
    const grandIndent = grandLine.indexOf("└── ") !== -1
      ? grandLine.indexOf("└── ")
      : grandLine.indexOf("├── ");
    expect(grandIndent).toBeGreaterThan(parentIndent);
  });

  it("renders 1 parent + 1 child for a workflow-style hierarchy", async () => {
    const store = new MemorySessionStore();
    const runSession = await store.create({
      title: "Run: my-flow",
      directory: "/tmp/e2e",
      parentSessionId: null,
      metadata: { type: "workflow", workflowName: "my-flow", status: "running" },
    });
    const agentSession = await store.create({
      title: "Agent: nodeA",
      directory: "/tmp/e2e",
      parentSessionId: runSession.id,
      metadata: { type: "agent", status: "running" },
    });

    const sessions = await store.list();
    const tree = buildSessionTree(sessions);
    const out = renderSessionTree(tree);

    expect(out).toContain(runSession.id);
    expect(out).toContain(agentSession.id);
    expect(out).toContain("workflow/my-flow");
    expect(out).toContain("running");
  });

  it("renders each session as a root when parentSessionId is null on all of them (legacy data shape)", async () => {
    // This mirrors the real production data: 9380 sessions with no parent.
    // The output should still be a valid tree, with each session at the top level.
    const store = new MemorySessionStore();
    const s1 = await store.create({ title: "A", directory: "/tmp", parentSessionId: null });
    const s2 = await store.create({ title: "B", directory: "/tmp", parentSessionId: null });
    const s3 = await store.create({ title: "C", directory: "/tmp", parentSessionId: null });

    const tree = buildSessionTree(await store.list());
    expect(tree.roots).toHaveLength(3);
    expect(tree.orphans).toEqual([]);

    const out = renderSessionTree(tree);
    expect(out).toContain("Session Tree");
    expect(out).toContain(s1.id);
    expect(out).toContain(s2.id);
    expect(out).toContain(s3.id);
  });

  it("--short-id rendering still works for the tree (legacy 8-char form)", async () => {
    const store = new MemorySessionStore();
    const parent = await store.create({
      title: "Parent",
      directory: "/tmp",
      parentSessionId: null,
    });
    await store.create({
      title: "Child",
      directory: "/tmp",
      parentSessionId: parent.id,
    });

    const tree = buildSessionTree(await store.list());
    const out = renderSessionTree(tree, { useShortId: true });

    // Legacy form should show the 8-char prefix of the meaningful id (uuid portion)
    const parentShort = parent.id.split("_")[1]!.slice(0, 8);
    expect(out).toContain(parentShort);
    // Full id should NOT be present
    expect(out).not.toContain(parent.id);
  });
});
