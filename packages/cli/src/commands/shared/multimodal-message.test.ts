/**
 * @fileoverview assembleMultimodalMessage — 测试
 *
 * TDD RED: 先写测试验证 ContentPart 拼装逻辑
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  assembleMultimodalMessage,
  parseActImageArgs,
} from "./multimodal-message";

// ========================================================================
// Helpers
// ========================================================================

function makeTmp(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "multimodal-test-"));
}

function pngMagicBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

// ========================================================================
// parseActImageArgs — yargs --image 多值解析
// ========================================================================

describe("parseActImageArgs", () => {
  test("returns [] when undefined", () => {
    expect(parseActImageArgs(undefined)).toEqual([]);
  });

  test("returns [] when empty array", () => {
    expect(parseActImageArgs([])).toEqual([]);
  });

  test("normalizes single string to array", () => {
    expect(parseActImageArgs("./a.png")).toEqual(["./a.png"]);
  });

  test("preserves array as-is", () => {
    expect(parseActImageArgs(["./a.png", "./b.png"])).toEqual(["./a.png", "./b.png"]);
  });

  test("strips empty strings from array", () => {
    expect(parseActImageArgs(["./a.png", "", "./b.png"])).toEqual([
      "./a.png",
      "./b.png",
    ]);
  });

  test("deduplicates adjacent duplicates", () => {
    expect(parseActImageArgs(["./a.png", "./a.png", "./b.png"])).toEqual([
      "./a.png",
      "./b.png",
    ]);
  });
});

// ========================================================================
// assembleMultimodalMessage — text + image[] → ContentPart[]
// ========================================================================

describe("assembleMultimodalMessage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmp();
  });

  test("returns plain string when no images", () => {
    const result = assembleMultimodalMessage("hello", []);
    expect(typeof result).toBe("string");
    expect(result).toBe("hello");
  });

  test("returns ContentPart[] when images present (text first, then images)", async () => {
    const png = path.join(tmpDir, "a.png");
    await fs.writeFile(png, pngMagicBuffer());

    const result = await assembleMultimodalMessage("describe", [png]);

    expect(Array.isArray(result)).toBe(true);
    const parts = result as any[];
    expect(parts.length).toBe(2);
    expect(parts[0]).toEqual({ type: "text", text: "describe" });
    expect(parts[1].type).toBe("image");
  });

  test("supports multiple images in order", async () => {
    const a = path.join(tmpDir, "a.png");
    const b = path.join(tmpDir, "b.png");
    await fs.writeFile(a, pngMagicBuffer());
    await fs.writeFile(b, pngMagicBuffer());

    const result = await assembleMultimodalMessage("compare", [a, b]);

    expect(Array.isArray(result)).toBe(true);
    const parts = result as any[];
    expect(parts.length).toBe(3);
    expect(parts[0]).toEqual({ type: "text", text: "compare" });
    expect(parts[1].type).toBe("image");
    expect(parts[2].type).toBe("image");
  });

  test("accepts http(s) URL strings as images", async () => {
    const url1 = "https://example.com/a.png";
    const url2 = "https://example.com/b.png";

    const result = await assembleMultimodalMessage("from web", [url1, url2]);

    expect(Array.isArray(result)).toBe(true);
    const parts = result as any[];
    expect(parts.length).toBe(3);
    expect(parts[1]).toEqual({ type: "image", image: url1 });
    expect(parts[2]).toEqual({ type: "image", image: url2 });
  });

  test("mixes local paths and URLs", async () => {
    const local = path.join(tmpDir, "local.png");
    await fs.writeFile(local, pngMagicBuffer());
    const url = "https://example.com/x.png";

    const result = await assembleMultimodalMessage("mix", [local, url]);

    expect(Array.isArray(result)).toBe(true);
    const parts = result as any[];
    expect(parts.length).toBe(3);
    expect(parts[0]).toEqual({ type: "text", text: "mix" });
    expect(parts[1].type).toBe("image");
    expect(parts[2]).toEqual({ type: "image", image: url });
  });

  test("throws on non-existent local path", async () => {
    const missing = path.join(tmpDir, "nope.png");
    await expect(assembleMultimodalMessage("bad", [missing])).rejects.toThrow();
  });
});