/**
 * @fileoverview Migration Smoke Tests (v0.14 strict email-only)
 *
 * 验证 v0.14 strict email-only 行为：
 * 1. 老 config (with `address` field) 加载应该 ERROR
 * 2. 新 config (with `email` field only) 加载应该 OK
 * 3. 老 config (with `options.address`) 加载应该 ERROR
 * 4. validateConfig 错误信息包含迁移指引
 *
 * Task #2129
 */

import { describe, test, expect } from "bun:test";
import { bountyIMHandler, assertNoLegacyAddressField, BountyIMInstance } from "./bounty-im-handler";
import type { EventSourceConfig } from "./types";

describe("v0.14 migration smoke (Task #2129)", () => {
  test("v0.14: legacy top-level address field triggers hard error", () => {
    const legacyConfig: EventSourceConfig = {
      id: "test-legacy",
      name: "Legacy Config",
      type: "bounty-im",
      enabled: true,
      // v0.12/v0.13 legacy field
      address: "uuid@bounty.example.com",
      imServerUrl: "ws://localhost:4005/ws",
    };

    expect(() => assertNoLegacyAddressField(legacyConfig)).toThrow(/legacy 'address' field/);
  });

  test("v0.14: legacy options.address triggers hard error", () => {
    const legacyConfig: EventSourceConfig = {
      id: "test-legacy-opts",
      name: "Legacy Config",
      type: "bounty-im",
      enabled: true,
      imServerUrl: "ws://localhost:4005/ws",
      options: {
        address: "uuid@bounty.example.com",
      },
    };

    expect(() => assertNoLegacyAddressField(legacyConfig)).toThrow(/legacy 'address' field/);
  });

  test("v0.14: empty address field is allowed (treated as missing)", () => {
    // 空字符串 / undefined 不应触发 hard error
    expect(() =>
      assertNoLegacyAddressField({
        id: "test-empty",
        name: "Test",
        type: "bounty-im",
        enabled: true,
        address: "",
        email: "alice@bounty.example.com",
        imServerUrl: "ws://localhost:4005/ws",
      } as EventSourceConfig),
    ).not.toThrow();

    expect(() =>
      assertNoLegacyAddressField({
        id: "test-no-addr",
        name: "Test",
        type: "bounty-im",
        enabled: true,
        email: "alice@bounty.example.com",
        imServerUrl: "ws://localhost:4005/ws",
      } as EventSourceConfig),
    ).not.toThrow();
  });

  test("v0.14: error message contains migration guidance", () => {
    try {
      assertNoLegacyAddressField({
        id: "test-msg",
        name: "Test",
        type: "bounty-im",
        enabled: true,
        address: "uuid@bounty.example.com",
        imServerUrl: "ws://localhost:4005/ws",
      } as EventSourceConfig);
      // should not reach here
      expect(true).toBe(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 错误信息应该包含：v0.14 strict email-only + 迁移指引
      expect(msg).toContain("v0.14 strict email-only");
      expect(msg).toContain("Migration");
      expect(msg).toContain("email");
    }
  });

  test("v0.14: validateConfig on legacy config returns errors (not silent pass)", () => {
    const errors = bountyIMHandler.validateConfig({
      id: "test-validate-legacy",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      address: "uuid@bounty.example.com", // legacy
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);

    // 至少要有一个错误：legacy address + email missing
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) => /legacy.*address|email.*required/i.test(e)),
    ).toBe(true);
  });

  test("v0.14: validateConfig on v0.14 strict config passes (email-only)", () => {
    const errors = bountyIMHandler.validateConfig({
      id: "test-validate-v014",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      email: "alice@bounty.example.com", // v0.14 唯一 identity
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);

    expect(errors).toEqual([]);
  });

  test("v0.14: BountyIMInstance.start() throws on legacy address field", async () => {
    const inst = new BountyIMInstance({
      id: "test-start-legacy",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      address: "uuid@bounty.example.com", // legacy
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);

    inst.onEvent(() => {});

    // start() 应该抛出包含 legacy 'address' 信息的错误
    await expect(inst.start()).rejects.toThrow(/legacy 'address' field/);
  });
});