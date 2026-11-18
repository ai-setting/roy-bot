/**
 * @fileoverview Tests for Session.parentSessionId field (TDD for Task #1739)
 *
 * Verifies that:
 *  1. CreateSessionOptions accepts a new top-level `parentSessionId` field
 *     in addition to the legacy `parentID` alias.
 *  2. The created Session object exposes BOTH `parentSessionId` and `parentID`
 *     with the same value (parentID is the deprecated alias for backward compat).
 *  3. listSessions returns sessions with `parentSessionId` populated.
 *  4. Sessions created without a parent have `parentSessionId === null`.
 *  5. Backward compatibility: when only `parentID` is passed, `parentSessionId`
 *     is also set.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { SessionComponent } from "./session-component";
import { MemorySessionStore } from "./storage/memory";
import { SQLiteSessionStore } from "./storage/sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("Session.parentSessionId — top-level parent session field (Task #1739)", () => {
  describe("SessionComponent with MemorySessionStore", () => {
    let component: SessionComponent;
    let store: MemorySessionStore;

    beforeEach(() => {
      component = new SessionComponent();
      store = new MemorySessionStore();
      (component as any).store = store;
      (component as any).hooksConfig = {};
    });

    it("accepts parentSessionId in CreateSessionOptions and exposes it on the Session", async () => {
      const parent = await component.create({ title: "parent" });
      const child = await component.create({
        title: "child",
        parentSessionId: parent.id,
      });

      expect(child.parentSessionId).toBe(parent.id);
    });

    it("stores parentSessionId as null when no parent is provided", async () => {
      const session = await component.create({ title: "lone" });
      expect(session.parentSessionId).toBeNull();
    });

    it("mirrors parentSessionId into legacy parentID alias for backward compat", async () => {
      const parent = await component.create({ title: "parent" });
      const child = await component.create({
        title: "child",
        parentSessionId: parent.id,
      });

      expect(child.parentID).toBe(parent.id);
    });

    it("still honors legacy parentID option and mirrors it into parentSessionId", async () => {
      const parent = await component.create({ title: "parent" });
      const child = await component.create({
        title: "child",
        parentID: parent.id,
      });

      expect(child.parentSessionId).toBe(parent.id);
      expect(child.parentID).toBe(parent.id);
    });

    it("listSessions returns sessions with parentSessionId field", async () => {
      const parent = await component.create({ title: "parent" });
      await component.create({ title: "child-a", parentSessionId: parent.id });
      await component.create({ title: "child-b", parentSessionId: parent.id });
      await component.create({ title: "lone" });

      const all = await store.list();
      const byTitle = Object.fromEntries(all.map((s) => [s.title, s]));

      expect(byTitle["parent"]!.parentSessionId).toBeNull();
      expect(byTitle["child-a"]!.parentSessionId).toBe(parent.id);
      expect(byTitle["child-b"]!.parentSessionId).toBe(parent.id);
      expect(byTitle["lone"]!.parentSessionId).toBeNull();
    });

    // Issue #6: empty string parentSessionId must be normalized to null so it
    // doesn't leak into graph layout as a "real" parent reference.
    it("normalizes empty-string parentSessionId to null (Memory store, Issue #6)", async () => {
      const session = await store.create({
        title: "lone",
        parentSessionId: "",
      });
      expect(session.parentSessionId).toBeNull();
    });

    it("normalizes whitespace-only parentSessionId to null (Memory store, Issue #6)", async () => {
      const session = await store.create({
        title: "lone",
        parentSessionId: "   ",
      });
      expect(session.parentSessionId).toBeNull();
    });
  });

  describe("SQLiteSessionStore persistence", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "session-parentid-test-"));
    });

    function cleanup() {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    it("persists parentSessionId through SQLite and exposes it on list/get", async () => {
      const dbPath = join(tmpDir, "sessions.db");
      const store = new SQLiteSessionStore(dbPath);
      const parent = await store.create({ title: "wf-run" });
      const child = await store.create({
        title: "agent-sub",
        parentSessionId: parent.id,
      });

      expect(child.parentSessionId).toBe(parent.id);
      expect(child.parentID).toBe(parent.id);

      const fresh = new SQLiteSessionStore(dbPath);
      const reloaded = await fresh.get(child.id);
      expect(reloaded).toBeDefined();
      expect(reloaded!.parentSessionId).toBe(parent.id);
      expect(reloaded!.parentID).toBe(parent.id);

      const reloadedParent = await fresh.get(parent.id);
      expect(reloadedParent!.parentSessionId).toBeNull();

      const all = await fresh.list();
      const parentRow = all.find((s) => s.id === parent.id);
      const childRow = all.find((s) => s.id === child.id);
      expect(parentRow?.parentSessionId).toBeNull();
      expect(childRow?.parentSessionId).toBe(parent.id);

      cleanup();
    });

    it("treats old rows without parent_id as null (backward compat)", async () => {
      const dbPath = join(tmpDir, "sessions.db");
      const store = new SQLiteSessionStore(dbPath);
      // Force initialize so db is available
      await (store as any).initialize();
      // Manually insert a row with no parent_id (simulating legacy data)
      (store as any).db.prepare(`
        INSERT INTO session (id, title, directory, parent_id, created_at, updated_at, message_count, metadata)
        VALUES (?, ?, ?, NULL, ?, ?, 0, '{}')
      `).run("legacy_session", "Legacy", "/tmp", Date.now(), Date.now());

      const loaded = await store.get("legacy_session");
      expect(loaded).toBeDefined();
      expect(loaded!.parentSessionId).toBeNull();

      cleanup();
    });

    // Issue #6: SQLite must normalize empty/whitespace parentSessionId to null,
    // both at write and read time.
    it("normalizes empty-string parentSessionId to null at write time (SQLite, Issue #6)", async () => {
      const dbPath = join(tmpDir, "sessions.db");
      const store = new SQLiteSessionStore(dbPath);
      const session = await store.create({
        title: "lone",
        parentSessionId: "",
      });
      expect(session.parentSessionId).toBeNull();
      // Reload from a fresh store to confirm persistence, not just in-memory normalization
      const fresh = new SQLiteSessionStore(dbPath);
      const reloaded = await fresh.get(session.id);
      expect(reloaded!.parentSessionId).toBeNull();
      cleanup();
    });
  });
});
