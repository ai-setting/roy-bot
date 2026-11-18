/**
 * Media utils 测试
 *
 * TDD RED 阶段先写测试，再写实现。
 *
 * 覆盖：
 * - sniffMimeType: PNG/JPEG/GIF/WebP/PDF magic bytes + 扩展名 fallback + 未知类型 fallback
 * - isMediaType: image/audio/video/pdf gate
 * - parseImageInput: 本地路径 / http(s) URL / data:base64 / 不存在路径 / 超大文件
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ATTACH_FILE_MAX_BYTES,
  sniffMimeType,
  isMediaType,
  parseImageInput,
} from "./media";

// ========================================================================
// Helpers
// ========================================================================

function makeTempDir(prefix = "media-test-"): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanDir(dir: string): void {
  try {
    fsSync.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Generate a PNG buffer with given magic bytes header (minimal 1x1 png signature). */
function pngMagicBuffer(): Buffer {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk start
  ]);
}

function jpegMagicBuffer(): Buffer {
  // JPEG SOI marker: FF D8 FF
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}

function gifMagicBuffer(): Buffer {
  // GIF87a / GIF89a: 47 49 46 38 (37 | 39) 61
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
}

function webpMagicBuffer(): Buffer {
  // RIFF....WEBP
  return Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // size placeholder
    Buffer.from([0x57, 0x45, 0x42, 0x50]), // WEBP
  ]);
}

function pdfMagicBuffer(): Buffer {
  // %PDF-
  return Buffer.from("%PDF-1.5\n");
}

// ========================================================================
// ATTACH_FILE_MAX_BYTES
// ========================================================================

describe("ATTACH_FILE_MAX_BYTES", () => {
  test("should be 10 MiB (10 * 1024 * 1024)", () => {
    expect(ATTACH_FILE_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

// ========================================================================
// sniffMimeType — magic byte detection
// ========================================================================

describe("sniffMimeType", () => {
  test("should detect PNG by magic bytes", () => {
    expect(sniffMimeType(pngMagicBuffer())).toBe("image/png");
  });

  test("should detect JPEG by magic bytes", () => {
    expect(sniffMimeType(jpegMagicBuffer())).toBe("image/jpeg");
  });

  test("should detect GIF by magic bytes", () => {
    expect(sniffMimeType(gifMagicBuffer())).toBe("image/gif");
  });

  test("should detect WebP by RIFF/WEBP signature", () => {
    expect(sniffMimeType(webpMagicBuffer())).toBe("image/webp");
  });

  test("should detect PDF by magic bytes", () => {
    expect(sniffMimeType(pdfMagicBuffer())).toBe("application/pdf");
  });

  test("should fallback to extension when magic bytes unknown", () => {
    // random bytes without magic signature, but extension .png
    const buf = Buffer.from("hello world, this is plain text", "utf-8");
    expect(sniffMimeType(buf, "image.png")).toBe("image/png");
  });

  test("should fallback to application/octet-stream when magic + extension both unknown", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(sniffMimeType(buf)).toBe("application/octet-stream");
  });

  test("should prefer magic bytes over extension when both present", () => {
    // Real PNG content but filename says .jpg — magic wins
    expect(sniffMimeType(pngMagicBuffer(), "fake.jpg")).toBe("image/png");
  });

  test("should accept Uint8Array as well as Buffer", () => {
    const u8 = new Uint8Array(pngMagicBuffer());
    expect(sniffMimeType(u8)).toBe("image/png");
  });

  test("should handle empty buffer gracefully", () => {
    expect(sniffMimeType(Buffer.alloc(0), "image.png")).toBe("image/png");
  });
});

// ========================================================================
// isMediaType
// ========================================================================

describe("isMediaType", () => {
  test("image/png → true", () => {
    expect(isMediaType("image/png")).toBe(true);
  });

  test("image/jpeg → true", () => {
    expect(isMediaType("image/jpeg")).toBe(true);
  });

  test("audio/mpeg → true", () => {
    expect(isMediaType("audio/mpeg")).toBe(true);
  });

  test("video/mp4 → true", () => {
    expect(isMediaType("video/mp4")).toBe(true);
  });

  test("application/pdf → true", () => {
    expect(isMediaType("application/pdf")).toBe(true);
  });

  test("text/plain → false", () => {
    expect(isMediaType("text/plain")).toBe(false);
  });

  test("application/octet-stream → false", () => {
    expect(isMediaType("application/octet-stream")).toBe(false);
  });

  test("application/json → false", () => {
    expect(isMediaType("application/json")).toBe(false);
  });
});

// ========================================================================
// parseImageInput
// ========================================================================

describe("parseImageInput", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  test("should load local PNG file → { type: 'image', image: Buffer }", async () => {
    const pngFile = path.join(tmpDir, "test.png");
    await fs.writeFile(pngFile, pngMagicBuffer());

    const part = await parseImageInput(pngFile);

    expect(part.type).toBe("image");
    if (part.type === "image") {
      expect(Buffer.isBuffer(part.image) || part.image instanceof Uint8Array).toBe(true);
    }
  });

  test("should throw on non-existent local path", async () => {
    const missing = path.join(tmpDir, "does-not-exist.png");

    await expect(parseImageInput(missing)).rejects.toThrow();
  });

  test("should accept http(s) URL and return string reference", async () => {
    const url = "https://example.com/cat.png";
    const part = await parseImageInput(url);

    expect(part.type).toBe("image");
    if (part.type === "image") {
      // URL pass-through: keep as string so downstream loads it
      expect(typeof part.image).toBe("string");
      expect(part.image).toBe(url);
    }
  });

  test("should accept data:base64 URL and pass through", async () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const part = await parseImageInput(dataUrl);

    expect(part.type).toBe("image");
    if (part.type === "image") {
      expect(typeof part.image).toBe("string");
      expect(part.image).toBe(dataUrl);
    }
  });

  test("should throw when local file exceeds 10 MiB", async () => {
    const bigFile = path.join(tmpDir, "big.png");
    // Create a file that is 11 MiB
    const fd = await fs.open(bigFile, "w");
    try {
      // Write PNG magic then pad to 11 MiB
      await fd.write(pngMagicBuffer());
      const padding = Buffer.alloc(11 * 1024 * 1024 - pngMagicBuffer().length, 0);
      await fd.write(padding);
    } finally {
      await fd.close();
    }

    await expect(parseImageInput(bigFile)).rejects.toThrow(/10\s*MiB|10\s*MB/i);
  });

  test("should throw on empty string input", async () => {
    await expect(parseImageInput("")).rejects.toThrow();
  });
});