/**
 * @fileoverview EventSource Update Command - v0.14 strict email-only (Task #2129)
 *
 * v0.14 适配验证：update.ts 不应再有 --address option。
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";

describe("EventSource Update Command - v0.14 strict email-only", () => {
  test("v0.14: update.ts should NOT declare --address option (REMOVED in v0.14)", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "update.ts"),
    ).text();
    // v0.14 彻底移除 --address flag
    expect(source).not.toMatch(/\.option\(\s*["']address["']/);
    // description 中的 "Agent IM 地址" 也应该消失
    expect(source).not.toContain("Agent IM 地址");
  });

  test("v0.14: update.ts handler should NOT process address field", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "update.ts"),
    ).text();
    // handler 不应该引用 a.address
    expect(source).not.toMatch(/a\.address/);
    // partial 中不应该有 address: 字段
    expect(source).not.toMatch(/partial\.address\s*=/);
  });

  test("v0.14: update.ts should still declare --email and --profile options", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "update.ts"),
    ).text();
    expect(source).toContain('.option("email"');
    expect(source).toContain('.option("profile"');
  });
});