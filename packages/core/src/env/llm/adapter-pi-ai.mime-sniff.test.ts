/**
 * pi-ai adapter mimeType sniff tests (TDD RED for Task #2888 follow-up)
 *
 * Background:
 *   Task #2812 fixed the "vision input modality" gate by changing
 *   `resolvePiModel()` fallback to `input: ["text", "image"]`. That made
 *   pi-ai pass image content parts through instead of replacing them with
 *   the placeholder text "(image omitted: ...)".
 *
 *   But Task #2888's diagnosis showed a SECOND bug: `toPiMessages()`
 *   hardcodes `mimeType: "image/*"` on every emitted image block. Some
 *   upstream vision APIs (e.g. MiniMax) reject the wildcard with HTTP 400:
 *     "image data url media type \"image/*\" not supported"
 *
 *   This file RED-tests the fix: `toPiMessages` must sniff the real MIME
 *   from (a) buffer magic bytes, (b) `data:` URL prefix, (c) HTTP URL suffix,
 *   or (d) the explicit `mediaType` field — and refuse to emit `"image/*"`
 *   silently.
 */
import { describe, test, expect } from "bun:test";
import { toPiMessages } from "./adapter-pi-ai";
import type { LLMMessage } from "./types";

// Realistic PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A (plus filler)
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
]);

// Realistic JPEG magic bytes: FF D8 FF E0
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

// Realistic GIF magic bytes: 47 49 46 38 39 61
const GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
]);

// Realistic WebP: "RIFF" .... "WEBP"
const WEBP_BYTES = (() => {
  const arr = new Uint8Array(16);
  arr.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  arr.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return arr;
})();

function findImageBlock(piMessages: any[]): any {
  for (const msg of piMessages) {
    if (Array.isArray(msg.content)) {
      const block = msg.content.find((c: any) => c.type === "image");
      if (block) return block;
    }
  }
  return undefined;
}

describe("toPiMessages - mimeType sniff (Task #2888 follow-up)", () => {
  // Test 1: jpeg buffer → mimeType: image/jpeg
  test("image with Uint8Array buffer (jpeg magic bytes) → mimeType = 'image/jpeg'", () => {
    const messages: LLMMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", image: JPEG_BYTES },
      ],
    }];
    const result = toPiMessages(messages);
    const imageBlock = findImageBlock(result as any[]);
    expect(imageBlock).toBeDefined();
    expect(imageBlock.mimeType).toBe("image/jpeg");
    expect(imageBlock.mimeType).not.toBe("image/*");
  });

  // Test 2: png buffer → mimeType: image/png
  test("image with Uint8Array buffer (png magic bytes) → mimeType = 'image/png'", () => {
    const messages: LLMMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", image: PNG_BYTES },
      ],
    }];
    const result = toPiMessages(messages);
    const imageBlock = findImageBlock(result as any[]);
    expect(imageBlock).toBeDefined();
    expect(imageBlock.mimeType).toBe("image/png");
  });

  // Test 3: gif buffer → mimeType: image/gif
  test("image with Uint8Array buffer (gif magic bytes) → mimeType = 'image/gif'", () => {
    const messages: LLMMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", image: GIF_BYTES },
      ],
    }];
    const result = toPiMessages(messages);
    const imageBlock = findImageBlock(result as any[]);
    expect(imageBlock).toBeDefined();
    expect(imageBlock.mimeType).toBe("image/gif");
  });

  // Test 4: webp buffer → mimeType: image/webp
  test("image with Uint8Array buffer (webp magic bytes) → mimeType = 'image/webp'", () => {
    const messages: LLMMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", image: WEBP_BYTES },
      ],
    }];
    const result = toPiMessages(messages);
    const imageBlock = findImageBlock(result as any[]);
    expect(imageBlock).toBeDefined();
    expect(imageBlock.mimeType).toBe("image/webp");
  });

  // Test 5: data: URL → mimeType sniffed from data URL prefix
  test("image with data:base64 URL → mimeType sniffed from data URL prefix", () => {
    const messages: LLMMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    }];
    const result = toPiMessages(messages);
    const imageBlock = findImageBlock(result as any[]);
    expect(imageBlock).toBeDefined();
    expect(imageBlock.mimeType).toBe("image/png");
    expect(imageBlock.mimeType).not.toBe("image/*");
  });

  // Test 6: http URL with .jpg suffix → mimeType sniffed from URL suffix
  test("image with http URL ending in .jpg → mimeType sniffed from URL suffix", () => {
    const messages: LLMMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", image: "https://example.com/photo.jpg" },
      ],
    }];
    const result = toPiMessages(messages);
    const imageBlock = findImageBlock(result as any[]);
    expect(imageBlock).toBeDefined();
    expect(imageBlock.mimeType).toBe("image/jpeg");
  });

  // Test 7: undetectable MIME (no magic, no prefix, no suffix) → throw clear error
  // CRITICAL: must NOT silently emit "image/*" wildcard
  test("image with no detectable MIME (unknown URL, no buffer magic) → throw clear error", () => {
    const messages: LLMMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", image: "https://example.com/unknown-content-12345" },
      ],
    }];
    expect(() => toPiMessages(messages)).toThrow(/cannot determine image MIME/i);
  });

  // Test 8: regression — no image, just text → no image block emitted
  test("text-only message → no image block, no 'image/*' leak", () => {
    const messages: LLMMessage[] = [{
      role: "user",
      content: "Just text, no images.",
    }];
    const result = toPiMessages(messages);
    expect(result).toHaveLength(1);
    expect(findImageBlock(result as any[])).toBeUndefined();
  });
});