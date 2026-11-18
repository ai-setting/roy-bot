/**
 * @fileoverview bounty-profile-reader unit tests
 *
 * 验证 readBountyProfile / profileToWsUrl 的契约：
 * - 不存在 → 返回 null
 * - 存在 → 解析 {email, agent_id, api_base}
 * - JSON 损坏 → 返回 null
 * - profileToWsUrl: http → ws, https → wss, 已 ws/wss 保持 + 自动补 /ws
 *
 * Phase v0.13 (Task #2110)
 *
 * 注意：bun runtime 下 os.homedir() 不读 process.env.HOME（只读启动时的 env），
 * 所以测试用 readBountyProfile(name, profilesDir) 的可选参数注入临时目录。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBountyProfile, profileToWsUrl } from "./bounty-profile-reader";

describe("readBountyProfile", () => {
  let fakeProfilesDir: string;

  beforeEach(() => {
    fakeProfilesDir = mkdtempSync(join(tmpdir(), "bounty-profiles-"));
  });

  afterEach(() => {
    rmSync(fakeProfilesDir, { recursive: true, force: true });
  });

  test("returns null when name is empty", () => {
    expect(readBountyProfile("", fakeProfilesDir)).toBeNull();
  });

  test("returns null when profile file does not exist", () => {
    expect(readBountyProfile("nonexistent", fakeProfilesDir)).toBeNull();
  });

  test("returns parsed profile when file exists", () => {
    writeFileSync(
      join(fakeProfilesDir, "alice.json"),
      JSON.stringify({
        email: "alice@bounty.example.com",
        agent_id: "uuid-123",
        api_base: "http://localhost:4005",
      }),
    );

    const profile = readBountyProfile("alice", fakeProfilesDir);
    expect(profile).not.toBeNull();
    expect(profile?.email).toBe("alice@bounty.example.com");
    expect(profile?.agent_id).toBe("uuid-123");
    expect(profile?.api_base).toBe("http://localhost:4005");
  });

  test("returns null when JSON is corrupted", () => {
    writeFileSync(join(fakeProfilesDir, "broken.json"), "this is not json");
    expect(readBountyProfile("broken", fakeProfilesDir)).toBeNull();
  });

  test("reads from default ~/.config/bounty/profiles/ when no dir given (integration)", () => {
    // 实际 home 目录可能存在也可能不存在（取决于环境），所以这里只验证不抛错
    const result = readBountyProfile("definitely-does-not-exist-anywhere");
    // 没有该 profile → null（不应抛错）
    expect(result).toBeNull();
  });
});

describe("profileToWsUrl", () => {
  test("http → ws + /ws path", () => {
    expect(profileToWsUrl("http://localhost:4005")).toBe(
      "ws://localhost:4005/ws",
    );
  });

  test("https → wss + /ws path", () => {
    expect(profileToWsUrl("https://bounty.example.com")).toBe(
      "wss://bounty.example.com/ws",
    );
  });

  test("trims trailing slash", () => {
    expect(profileToWsUrl("http://localhost:4005/")).toBe(
      "ws://localhost:4005/ws",
    );
  });

  test("idempotent for ws:// (already has /ws)", () => {
    expect(profileToWsUrl("ws://localhost:4005/ws")).toBe(
      "ws://localhost:4005/ws",
    );
  });

  test("idempotent for ws:// without /ws path", () => {
    expect(profileToWsUrl("ws://localhost:4005")).toBe(
      "ws://localhost:4005/ws",
    );
  });

  test("idempotent for wss:// already has /ws", () => {
    expect(profileToWsUrl("wss://bounty.example.com/ws")).toBe(
      "wss://bounty.example.com/ws",
    );
  });
});
