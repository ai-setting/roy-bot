/**
 * @fileoverview Eventsource Add Command Tests for bounty-cli (v0.3.0+)
 *
 * TDD tests verifying that eventsource add command supports bounty-cli:
 * - --channel option (required for bounty-cli type)
 * - Channel passed through to handler (top-level config.channel field)
 * - --profile option works for bounty profile selection
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";

describe("EventSource Add Command - bounty-cli support", () => {
  test("add.ts should declare --channel option with bounty-cli description", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    expect(source).toContain('.option("channel"');
    // describe 文本应提及 bounty-cli 类型（不管前后顺序）
    expect(source).toMatch(/bounty-cli.*channel|channel.*bounty-cli/i);
  });

  test("add.ts handler validates --channel is required when type=bounty-cli (no --command)", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    expect(source).toContain('a.type === "bounty-cli"');
    // error message should mention --channel
    expect(source).toMatch(/bounty-cli.*channel|channel.*required/i);
  });

  test("add.ts handler forwards --channel to config.channel for bounty-cli", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    // handler 应把 channel 写到 config 顶级字段
    expect(source).toMatch(/channel:\s*a\.channel/);
  });

  test("add.ts should NOT include --channel in options (top-level field for handler)", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    // channel 必须在顶级（handler 直接读 config.channel）
    expect(source).not.toContain("options: { channel:");
  });

  test("add.ts type positional describe mentions bounty-cli as a known type", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    expect(source).toMatch(/bounty-cli.*timer|lark-cli.*bounty-cli/);
  });
});