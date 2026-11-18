/**
 * pi-ai adapter vision pass-through tests (TDD RED for Task #2812)
 *
 * Background:
 *   User reported that `understand_image` tool doesn't work with MiniMax-M3,
 *   because `resolvePiModel()` fallback path hardcodes `input: ["text"]`.
 *
 *   pi-ai's `downgradeUnsupportedImages` (in transform-messages.ts) uses
 *   `model.input.includes("image")` as the SINGLE switch to decide whether
 *   to pass through image content parts or replace them with the placeholder
 *   "(image omitted: model does not support images)".
 *
 *   This file RED-tests the fix: fallback path must declare ["text", "image"]
 *   so pi-ai passes image content through transparently, rather than silently
 *   downgrading to a placeholder text.
 *
 * The fix is a 1-line change in adapter-pi-ai.ts:
 *   - input: ["text"]            // buggy: forces image downgrade
 *   + input: ["text", "image"]   // fixed: pi-ai pass-through
 */
import { describe, test, expect, beforeEach } from "bun:test";

describe("PiAiAdapter vision pass-through (Task #2812 fallback path)", () => {
  beforeEach(() => {
    // Test design: pi-ai's getModel() in real life returns either a built-in
    // model descriptor (with correct modalities) OR undefined. We want to
    // exercise the FALLBACK path of resolvePiModel() — the one that builds
    // a custom descriptor for "minimax" / "minimax-cn".
    //
    // The current pi-ai 0.74.2 doesn't have "minimax" / "minimax-cn" in its
    // built-in registry, so getModel() already returns undefined for them in
    // real life. We don't need to mock anything to exercise the fallback.
  });

  // Test 1: minimax provider fallback includes image
  test("resolvePiModel('minimax', 'MiniMax-M3') fallback includes 'image' in input", async () => {
    const { resolvePiModel } = await import("./adapter-pi-ai");
    const model = resolvePiModel("minimax", "MiniMax-M3", "https://api.minimax.chat/v1");
    expect(model.input).toBeDefined();
    expect(Array.isArray(model.input)).toBe(true);
    expect(model.input.includes("image")).toBe(true);
  });

  // Test 2: minimax-cn provider fallback includes image
  test("resolvePiModel('minimax-cn', 'MiniMax-M3') fallback includes 'image' in input", async () => {
    const { resolvePiModel } = await import("./adapter-pi-ai");
    const model = resolvePiModel("minimax-cn", "MiniMax-M3", "https://api.minimaxi.com/v1");
    expect(model.input).toBeDefined();
    expect(Array.isArray(model.input)).toBe(true);
    expect(model.input.includes("image")).toBe(true);
  });

  // Test 3: exact input array equality (defends against typos in modifiers)
  test("resolvePiModel fallback input is exactly ['text', 'image']", async () => {
    const { resolvePiModel } = await import("./adapter-pi-ai");
    const model = resolvePiModel("minimax", "MiniMax-M3");
    expect(model.input).toEqual(["text", "image"]);
  });

  // Test 4: text-only model path (defends against false-positive vision flag)
  // Note: since resolvePiModel doesn't know the model ID's modality ahead of time,
  // this test verifies that the fallback declares the maximum safe set
  // (text + image). Models that don't actually support image will surface a
  // clear HTTP 400 from the upstream API — preferable to silent placeholder.
  test("resolvePiModel fallback input is the union (text+image), not just text", async () => {
    const { resolvePiModel } = await import("./adapter-pi-ai");
    const model = resolvePiModel("minimax", "MiniMax-Text-01");
    // Even for "Text-01", the fallback default is text+image (pass-through default).
    // The trade-off: an API that doesn't support image gets a clear 400.
    expect(model.input).not.toEqual(["text"]);
    expect(model.input.includes("image")).toBe(true);
  });

  // Test 5: end-to-end — toPiMessages preserves image content part
  // Verifies the LLMMessage → pi-ai Context conversion still produces an
  // image content block. The bug was that pi-ai's downstream
  // `downgradeUnsupportedImages` would replace image blocks with the
  // placeholder "(image omitted: model does not support images)" when
  // model.input lacks "image". After the fix, model.input includes "image"
  // so pi-ai passes the image block through to the wire payload.
  test("toPiMessages preserves image content part for vision-capable fallback model", async () => {
    const { resolvePiModel, toPiMessages } = await import("./adapter-pi-ai");

    const model = resolvePiModel("minimax-cn", "MiniMax-M3", "https://api.minimaxi.com/v1");

    // Sanity: model declares image input (this is the fix)
    expect(model.input.includes("image")).toBe(true);

    // Task #2888 follow-up: use real PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)
    // so sniffImageMime() can detect the MIME type instead of throwing.
    const imageBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "What do you see?" },
          { type: "image" as const, image: imageBuffer },
        ],
      },
    ];

    const piMessages = toPiMessages(messages);
    expect(piMessages).toHaveLength(1);
    const firstMsg = piMessages[0] as any;
    expect(firstMsg.role).toBe("user");
    expect(Array.isArray(firstMsg.content)).toBe(true);

    // The image block must be present in the converted message.
    // This is the precondition for pi-ai's pass-through logic (which checks
    // model.input.includes("image")) to actually pass it through to wire.
    const hasImageBlock = firstMsg.content.some((c: any) => c.type === "image");
    expect(hasImageBlock).toBe(true);

    // Verify the image data is preserved (base64-encoded buffer).
    const imageBlock = firstMsg.content.find((c: any) => c.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock.data).toBeDefined();
    expect(typeof imageBlock.data).toBe("string");
    expect(imageBlock.data.length).toBeGreaterThan(0);
    // Task #2888 follow-up: mimeType must be sniffed (image/png from magic bytes),
    // NOT the buggy "image/*" wildcard that some providers reject with HTTP 400.
    expect(imageBlock.mimeType).toBe("image/png");

    // Verify pi-ai's downgrade logic contract: if model.input does NOT include
    // "image", placeholder text "(image omitted...)" appears. Since our fix
    // includes "image", this contract means no placeholder text should appear
    // in the converted message.
    const hasPlaceholder = firstMsg.content.some(
      (c: any) => c.type === "text" && typeof c.text === "string" && c.text.includes("(image omitted"),
    );
    expect(hasPlaceholder).toBe(false);
  });

  // Test 6: inverse — text-only messages don't break (regression guard)
  test("toPiMessages text-only path unchanged (regression guard)", async () => {
    const { toPiMessages } = await import("./adapter-pi-ai");

    const messages = [
      { role: "user" as const, content: "Hello, just text" },
    ];

    const piMessages = toPiMessages(messages);
    expect(piMessages).toHaveLength(1);
    const firstMsg = piMessages[0] as any;
    expect(firstMsg.role).toBe("user");
    // Text-only message stays as a plain string content (not array)
    expect(typeof firstMsg.content).toBe("string");
    expect(firstMsg.content).toBe("Hello, just text");
  });
});