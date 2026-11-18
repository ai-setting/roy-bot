import { describe, test, expect } from "bun:test";
import { PiAiAdapter, EmbeddingNotSupportedError } from "./adapter-pi-ai";

describe("PiAiAdapter.embed", () => {
  test("throws an explicit unsupported error", async () => {
    await expect(new PiAiAdapter().embed({ provider: "anthropic", modelId: "model", input: "hi", apiKey: "test" }))
      .rejects.toBeInstanceOf(EmbeddingNotSupportedError);
  });
});
