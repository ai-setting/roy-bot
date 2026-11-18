/**
 * @fileoverview Eventsource Update Command Tests for --server-url support
 *
 * TDD tests verifying that eventsource update command:
 * - 注册 --server-url 选项（使用 addServerUrlOption helper）
 * - 保留 --im-server-url 作为向后兼容 alias
 * - handler 行为：--server-url 优先，fallback 到 --im-server-url，最后写到 imServerUrl
 *
 * Phase: feat/eventsource-server-url (Task #1724)
 */

import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

describe("EventSource Update Command - --server-url support", () => {
  test("update.ts imports addServerUrlOption helper", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "./update.ts"),
    ).text();
    expect(source).toContain('from "./server-url-option"');
    expect(source).toContain("addServerUrlOption");
  });

  test("update.ts builder calls addServerUrlOption", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "./update.ts"),
    ).text();
    expect(source).toMatch(/addServerUrlOption\s*\(/);
  });

  test("update.ts handler resolves --server-url first, fallback to --im-server-url", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "./update.ts"),
    ).text();
    // handler 中应优先使用 serverUrl, fallback 到 imServerUrl（用 ?? 或 ||）
    expect(source).toMatch(
      /a\.serverUrl\s*(?:\|\||\?\?)\s*a\.imServerUrl/,
    );
    // 写入 imServerUrl 字段（partial.imServerUrl = ...，保持 schema 不变）
    expect(source).toMatch(/partial\.imServerUrl\s*=/);
  });

  test("update.ts has no duplicate .option('server-url' / 'im-server-url' outside helper import)", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "./update.ts"),
    ).text();
    // 不应该重复定义 server-url（避免 yargs 警告）
    const serverUrlMatches =
      source.match(/\.option\(['"]server-url['"]/g) || [];
    expect(serverUrlMatches.length).toBe(0);
    // 不应该重复定义 im-server-url（避免 yargs 警告）
    const imServerUrlMatches =
      source.match(/\.option\(['"]im-server-url['"]/g) || [];
    expect(imServerUrlMatches.length).toBe(0);
  });
});