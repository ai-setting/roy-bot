/**
 * @fileoverview Eventsource Add Command Tests for bounty-im
 *
 * TDD tests verifying that eventsource add command supports bounty-im:
 * - v0.14 strict email-only: --email (required) or --profile (auto-fills email)
 * - --server-url / --im-server-url option (registered via addServerUrlOption helper)
 * - bounty-im type persistence with top-level email/imServerUrl fields
 *
 * Phase history:
 * - feat/eventsource-server-url (Task #1724)
 * - v0.13: email-first + profile (Task #2110)
 * - v0.14: strict email-only, --address removed (Task #2129)
 *
 * v0.14 changelog:
 * - --address flag REMOVED (was v0.12 <uuid>@<host> compat)
 * - config.address field REMOVED from bounty-im handler
 * - bounty-im identity = email ONLY
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";

describe("EventSource Add Command - bounty-im support", () => {
  test("add.ts should use addServerUrlOption helper (registers server-url + im-server-url)", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    // 不再直接 .option('im-server-url')（已移到 helper）
    // 但 add.ts 必须 import + 调用 addServerUrlOption
    expect(source).toContain("addServerUrlOption");
    expect(source).toContain('from "./server-url-option"');
  });

  test("add.ts should resolve imServerUrl via resolveServerUrl helper", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    // imServerUrl 来自 resolveServerUrl 而非直接 a.imServerUrl（增强校验）
    expect(source).toContain("resolveServerUrl");
    expect(source).toContain("imServerUrl: resolvedServerUrl");
  });

  test("add.ts should not put imServerUrl in options (v0.14 schema)", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    // imServerUrl 必须是顶级字段
    expect(source).not.toContain("options: { imServerUrl:");
  });
});

// =============================================================================
// v0.14 strict email-only support (Task #2129)
// =============================================================================

describe("EventSource Add Command - v0.14 strict email-only", () => {
  test("v0.14: add.ts should declare --email option with v0.14 description", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    expect(source).toContain('.option("email"');
    // v0.14 strict：description 包含 "v0.14" 或 "strict" 字样
    expect(source).toMatch(/email.*v0\.14|email.*strict|email.*only/i);
  });

  test("v0.14: add.ts should declare --profile option for bounty-im type", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    expect(source).toContain('.option("profile"');
    expect(source).toMatch(/profile.*bounty/);
  });

  test("v0.14: add.ts should NOT declare --address option (REMOVED in v0.14)", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    // v0.14 彻底移除 --address flag
    expect(source).not.toMatch(/\.option\(\s*["']address["']/);
    // description 中的 "Agent IM 地址" 也应该消失
    expect(source).not.toContain("Agent IM 地址");
  });

  test("v0.14: add.ts handler should NOT include address field in config", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    // config 对象中不应该有 address: 字段
    expect(source).not.toMatch(/address:\s*a\.address/);
    // handler 不应该有 a.address 引用
    expect(source).not.toMatch(/a\.address/);
  });

  test("v0.14: add.ts handler resolves --email to config.email field", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    // handler 必须把 a.email（或解析后的 email）写入顶层 config.email
    expect(source).toMatch(/email:\s*resolvedEmail|email:\s*a\.email/);
    expect(source).not.toMatch(/email:\s*a\.profile/);
  });

  test("v0.14: add.ts handler rejects --email and --profile simultaneously", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    const hasEmailProfileMutex =
      /a\.email\s*&&\s*a\.profile/.test(source) ||
      /a\.profile\s*&&\s*a\.email/.test(source);
    expect(hasEmailProfileMutex).toBe(true);
    const hasExitOnConflict =
      /互斥/.test(source) ||
      /cannot\s*use\s*both/.test(source) ||
      /both\s*cannot/.test(source);
    expect(hasExitOnConflict).toBe(true);
  });

  test("v0.14: add.ts imports bounty profile reader helper", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "add.ts"),
    ).text();
    expect(source).toContain("bounty-profile-reader");
    expect(source).toContain("readBountyProfile");
  });
});