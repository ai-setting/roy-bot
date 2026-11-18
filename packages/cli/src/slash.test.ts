/**
 * @fileoverview Tests for slash command dispatcher.
 *
 * Task #2610 stage 3.
 */

import { describe, it, expect } from "bun:test";
import {
  dispatchSlashCommand,
  CLEAR_SENTINEL,
  type SlashContext,
} from "./slash.js";

const ctx: SlashContext = {
  model: "openai/gpt-4o",
  workdir: "/tmp/test",
  maxLines: 500,
  userTurnCount: 3,
  assistantTurnCount: 3,
};

describe("dispatchSlashCommand", () => {
  it("returns 'pass' for non-slash input", () => {
    const r = dispatchSlashCommand("hello world", ctx);
    expect(r.kind).toBe("pass");
  });

  it("returns 'pass' for empty input", () => {
    const r = dispatchSlashCommand("", ctx);
    expect(r.kind).toBe("pass");
  });

  it("returns 'pass' for whitespace-only input", () => {
    const r = dispatchSlashCommand("   ", ctx);
    expect(r.kind).toBe("pass");
  });

  it("handles /help with command list", () => {
    const r = dispatchSlashCommand("/help", ctx);
    expect(r.kind).toBe("handled");
    if (r.kind === "handled") {
      expect(r.message).toContain("/clear");
      expect(r.message).toContain("/exit");
      expect(r.message).toContain("/help");
    }
  });

  it("returns 'exit' for /exit", () => {
    expect(dispatchSlashCommand("/exit", ctx).kind).toBe("exit");
  });

  it("returns 'exit' for /quit (alias)", () => {
    expect(dispatchSlashCommand("/quit", ctx).kind).toBe("exit");
  });

  it("returns CLEAR_SENTINEL for /clear", () => {
    const r = dispatchSlashCommand("/clear", ctx);
    expect(r.kind).toBe("handled");
    if (r.kind === "handled") {
      expect(r.message).toBe(CLEAR_SENTINEL);
    }
  });

  it("returns current model for /model", () => {
    const r = dispatchSlashCommand("/model", ctx);
    expect(r.kind).toBe("handled");
    if (r.kind === "handled") {
      expect(r.message).toContain("openai/gpt-4o");
    }
  });

  it("handles missing model gracefully in /model", () => {
    const r = dispatchSlashCommand("/model", {
      ...ctx,
      model: undefined,
    });
    expect(r.kind).toBe("handled");
    if (r.kind === "handled") {
      expect(r.message).toContain("default");
    }
  });

  it("returns turn counts for /history", () => {
    const r = dispatchSlashCommand("/history", ctx);
    expect(r.kind).toBe("handled");
    if (r.kind === "handled") {
      expect(r.message).toContain("3");
    }
  });

  it("returns working directory for /workdir", () => {
    const r = dispatchSlashCommand("/workdir", ctx);
    expect(r.kind).toBe("handled");
    if (r.kind === "handled") {
      expect(r.message).toContain("/tmp/test");
    }
  });

  it("sets max-lines for /max-lines with valid number", () => {
    const r = dispatchSlashCommand("/max-lines 200", ctx);
    expect(r.kind).toBe("set-max-lines");
    if (r.kind === "set-max-lines") {
      expect(r.value).toBe(200);
    }
  });

  it("accepts zero (no limit) for /max-lines", () => {
    const r = dispatchSlashCommand("/max-lines 0", ctx);
    expect(r.kind).toBe("set-max-lines");
    if (r.kind === "set-max-lines") {
      expect(r.value).toBe(0);
    }
  });

  it("rejects negative /max-lines", () => {
    const r = dispatchSlashCommand("/max-lines -1", ctx);
    expect(r.kind).toBe("unknown");
  });

  it("rejects non-numeric /max-lines", () => {
    const r = dispatchSlashCommand("/max-lines abc", ctx);
    expect(r.kind).toBe("unknown");
  });

  it("rejects unknown commands", () => {
    const r = dispatchSlashCommand("/foobar", ctx);
    expect(r.kind).toBe("unknown");
  });

  it("is case-insensitive on command name", () => {
    expect(dispatchSlashCommand("/EXIT", ctx).kind).toBe("exit");
    expect(dispatchSlashCommand("/Help", ctx).kind).toBe("handled");
  });

  it("ignores leading whitespace before slash", () => {
    expect(dispatchSlashCommand("  /help  ", ctx).kind).toBe("handled");
  });

  it("handles slash followed by nothing", () => {
    const r = dispatchSlashCommand("/", ctx);
    expect(r.kind).toBe("unknown");
  });
});