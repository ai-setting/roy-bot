import { describe, test, expect } from "bun:test";
import { extractSystemPrompt, toPiMessages } from "./adapter-pi-ai";

describe("PiAiAdapter message conversion", () => {
  test("merges system messages without putting them in Context.messages", () => {
    const input = [
      { role: "system" as const, content: "first" },
      { role: "user" as const, content: "hello" },
      { role: "system" as const, content: "second" },
    ];
    expect(extractSystemPrompt(input)).toBe("first\n\nsecond");
    expect(toPiMessages(input)).toHaveLength(1);
  });

  test("preserves image and file payloads instead of empty text", () => {
    const [message] = toPiMessages([{ role: "user", content: [
      { type: "image", image: "data:image/png;base64,abc" },
      { type: "file", file: "data:application/pdf;base64,xyz", mediaType: "application/pdf" },
    ] }]);
    expect(message.role).toBe("user");
    if (message.role !== "user" || typeof message.content === "string") throw new Error("expected parts");
    expect(message.content[0]).toMatchObject({ type: "image", data: "data:image/png;base64,abc" });
    expect(message.content[1]).toMatchObject({ type: "text" });
    expect((message.content[1] as any).text).toContain("xyz");
  });
});
