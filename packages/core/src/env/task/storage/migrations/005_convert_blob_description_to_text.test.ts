/**
 * @fileoverview Task Migration 005 Test: BLOB description → TEXT
 *
 * Verifies migration 005_convert_blob_description_to_text:
 *  1. Converts BLOB-stored descriptions to TEXT
 *  2. Preserves UTF-8 content
 *  3. Is idempotent (safe to re-run)
 *  4. Skips when task table does not exist (fresh DBs)
 *  5. Skips when no BLOB descriptions exist
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync, existsSync } from "fs";
import { runMigration } from "./005_convert_blob_description_to_text";
import { createCompatibleDatabase } from "../sqlite-task-store";

describe("Migration 005: BLOB description → TEXT", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `task-migration-005-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        unlinkSync(dbPath);
      } catch {
        // best-effort cleanup
      }
    }
  });

  // --------------------------------------------------------------------------
  // Test 1: converts BLOB to TEXT, preserves UTF-8
  // --------------------------------------------------------------------------
  test("MIG005-1: converts BLOB description to TEXT and preserves content", () => {
    const db = createCompatibleDatabase(dbPath);

    // Create minimal task schema (description column is TEXT by affinity,
    // but we can force a BLOB value via X'...' literal)
    db.run(`
      CREATE TABLE task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description BLOB,
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        type TEXT NOT NULL DEFAULT 'normal',
        progress INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        project_path TEXT NOT NULL DEFAULT 'unknown',
        context TEXT
      )
    `);

    const now = Date.now();
    // Insert a row with a BLOB-typed description (X'...' is a BLOB literal)
    db.run(
      `INSERT INTO task (title, description, created_at, updated_at)
       VALUES (?, X'54657374', ?, ?)`,
      "BLOB task",
      now,
      now,
    );
    // Insert a row with a normal TEXT description
    db.run(
      `INSERT INTO task (title, description, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      "Text task",
      "Plain text description",
      now,
      now,
    );

    db.close();

    // Run migration
    const result = runMigration(dbPath);

    expect(result.blobCountBefore).toBe(1);
    expect(result.blobCountAfter).toBe(0);
    expect(result.ran).toBe(true);

    // Verify the BLOB row's description is now TEXT and decodes to the original bytes
    const db2 = createCompatibleDatabase(dbPath);
    const rows = db2
      .query("SELECT id, title, description, typeof(description) as t FROM task ORDER BY id")
      .all() as Array<{ id: number; title: string; description: string; t: string }>;
    db2.close();

    expect(rows.length).toBe(2);
    expect(rows[0].title).toBe("BLOB task");
    expect(rows[0].t).toBe("text");
    expect(rows[0].description).toBe("Test"); // X'54657374' decodes to ASCII "Test"
    expect(rows[1].t).toBe("text");
    expect(rows[1].description).toBe("Plain text description");
  });

  // --------------------------------------------------------------------------
  // Test 2: idempotent (safe to re-run)
  // --------------------------------------------------------------------------
  test("MIG005-2: is idempotent — re-running on migrated DB is a no-op", () => {
    const db = createCompatibleDatabase(dbPath);
    db.run(`
      CREATE TABLE task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO task (title, description, created_at, updated_at)
       VALUES (?, X'48656c6c6f', ?, ?)`,
      "BLOB task",
      Date.now(),
      Date.now(),
    );
    db.close();

    // First run
    const r1 = runMigration(dbPath);
    expect(r1.ran).toBe(true);
    expect(r1.blobCountBefore).toBe(1);
    expect(r1.blobCountAfter).toBe(0);

    // Second run: should detect 0 BLOB rows, ran = false
    const r2 = runMigration(dbPath);
    expect(r2.ran).toBe(false);
    expect(r2.blobCountBefore).toBe(0);
    expect(r2.blobCountAfter).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test 3: skips when task table does not exist
  // --------------------------------------------------------------------------
  test("MIG005-3: skips gracefully when task table does not exist", () => {
    // Don't create any tables — just run the migration
    const result = runMigration(dbPath);
    expect(result.ran).toBe(false);
    expect(result.blobCountBefore).toBe(0);
    expect(result.blobCountAfter).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test 4: no-op when no BLOB descriptions exist
  // --------------------------------------------------------------------------
  test("MIG005-4: no-op when all descriptions are already TEXT", () => {
    const db = createCompatibleDatabase(dbPath);
    db.run(`
      CREATE TABLE task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO task (title, description, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      "Text task",
      "Already text",
      Date.now(),
      Date.now(),
    );
    db.close();

    const result = runMigration(dbPath);
    expect(result.ran).toBe(false);
    expect(result.blobCountBefore).toBe(0);
  });
});
