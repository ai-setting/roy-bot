/**
 * @fileoverview Tests for ChatCommand (yargs wrapper around <ChatTui>).
 *
 * Task #2610 stage 4.
 */

import { describe, it, expect } from "bun:test";
import { ChatCommand } from "./chat.js";

describe("ChatCommand (yargs)", () => {
  it("exposes command name 'chat <message>'", () => {
    expect(ChatCommand.command).toBe("chat <message>");
  });

  it("has a description", () => {
    expect(ChatCommand.describe ?? "").toContain("single message");
  });

  it("declares a builder function", () => {
    expect(typeof ChatCommand.builder).toBe("function");
  });

  it("declares a handler function", () => {
    expect(typeof ChatCommand.handler).toBe("function");
  });

  it("builder returns an object that can be chained", () => {
    const yargs = {
      positional: () => yargs,
      option: () => yargs,
      // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
      check: () => yargs,
    };
    const result = ChatCommand.builder?.(yargs as never);
    expect(result).toBeDefined();
  });
});