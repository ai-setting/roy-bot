/**
 * @fileoverview SessionManager attachedImages 测试
 *
 * TDD RED: 验证 attach / list / clear / getForQuery 行为
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ContentPart } from "@ai-setting/roy-bot-core";
import { SessionManager } from "./session-manager";
import { OutputService } from "../../services/output.service";

function makeTmp(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "session-attach-test-"));
}

function pngMagicBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

function makeManager(): SessionManager {
  const sessionComponent: any = {
    create: vi.fn().mockResolvedValue({ id: "session-1" }),
    setActiveSession: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ id: "session-1", title: "Test" }),
    getActiveSession: vi.fn().mockResolvedValue({ id: "session-1", title: "Test" }),
    compact: vi.fn(),
  };
  const output = new OutputService();
  output.configure({ quiet: true });
  return new SessionManager({
    sessionComponent,
    output,
    quiet: true,
  });
}

describe("SessionManager — attachedImages", () => {
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    manager = makeManager();
    tmpDir = makeTmp();
  });

  test("starts with empty attachedImages", () => {
    expect(manager.listAttachments()).toEqual([]);
  });

  test("attachImage adds a ContentPart to the list", async () => {
    const png = path.join(tmpDir, "a.png");
    await fs.writeFile(png, pngMagicBuffer());

    await manager.attachImage(png);

    const list = manager.listAttachments();
    expect(list.length).toBe(1);
    expect(list[0].type).toBe("image");
  });

  test("attachImage dedupes by path", async () => {
    const png = path.join(tmpDir, "a.png");
    await fs.writeFile(png, pngMagicBuffer());

    await manager.attachImage(png);
    await manager.attachImage(png);
    await manager.attachImage(png);

    expect(manager.listAttachments().length).toBe(1);
  });

  test("attachImage accepts multiple distinct paths", async () => {
    const a = path.join(tmpDir, "a.png");
    const b = path.join(tmpDir, "b.png");
    await fs.writeFile(a, pngMagicBuffer());
    await fs.writeFile(b, pngMagicBuffer());

    await manager.attachImage(a);
    await manager.attachImage(b);

    expect(manager.listAttachments().length).toBe(2);
  });

  test("attachImage accepts URL strings (passes through)", async () => {
    const url = "https://example.com/cat.jpg";
    await manager.attachImage(url);

    const list = manager.listAttachments();
    expect(list[0]).toEqual({ type: "image", image: url });
  });

  test("attachImage throws on non-existent local path", async () => {
    const missing = path.join(tmpDir, "nope.png");
    await expect(manager.attachImage(missing)).rejects.toThrow();
  });

  test("clearAttachments empties the list", async () => {
    const png = path.join(tmpDir, "a.png");
    await fs.writeFile(png, pngMagicBuffer());
    await manager.attachImage(png);
    expect(manager.listAttachments().length).toBe(1);

    manager.clearAttachments();
    expect(manager.listAttachments().length).toBe(0);
  });

  test("getQueryPayload assembles text + attachments as ContentPart[]", async () => {
    const png = path.join(tmpDir, "a.png");
    await fs.writeFile(png, pngMagicBuffer());
    await manager.attachImage(png);

    const payload = await manager.getQueryPayload("describe this");
    expect(Array.isArray(payload)).toBe(true);
    const parts = payload as ContentPart[];
    expect(parts[0]).toEqual({ type: "text", text: "describe this" });
    expect(parts[1].type).toBe("image");
  });

  test("getQueryPayload returns string when no attachments (backward compat)", async () => {
    const payload = await manager.getQueryPayload("plain text");
    expect(typeof payload).toBe("string");
    expect(payload).toBe("plain text");
  });

  test("getQueryPayload with empty text + attachments still produces ContentPart[] (text empty string OK)", async () => {
    const url = "https://example.com/x.png";
    await manager.attachImage(url);
    const payload = await manager.getQueryPayload("");
    expect(Array.isArray(payload)).toBe(true);
    const parts = payload as ContentPart[];
    expect(parts[0]).toEqual({ type: "text", text: "" });
    expect(parts[1].type).toBe("image");
  });

  test("clearAttachments is idempotent (calling twice is safe)", () => {
    manager.clearAttachments();
    manager.clearAttachments();
    expect(manager.listAttachments().length).toBe(0);
  });
});
