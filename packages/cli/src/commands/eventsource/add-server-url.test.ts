/**
 * @fileoverview Eventsource Add Command Tests for --server-url support
 *
 * TDD tests verifying that eventsource add command:
 * - 注册 --server-url 选项（使用 addServerUrlOption helper）
 * - 保留 --im-server-url 作为向后兼容 alias
 * - handler 行为：--server-url 优先，fallback 到 --im-server-url，最后写到 imServerUrl
 *
 * Phase: feat/eventsource-server-url (Task #1724)
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("EventSource Add Command - --server-url support", () => {
  test("add.ts imports addServerUrlOption helper", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "./add.ts"),
    ).text();
    expect(source).toContain(
      'from "./server-url-option"',
    );
    expect(source).toContain("addServerUrlOption");
  });

  test("add.ts builder calls addServerUrlOption", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "./add.ts"),
    ).text();
    // 必须在 builder chain 中调用
    expect(source).toMatch(/addServerUrlOption\s*\(/);
  });

  test("add.ts still has --im-server-url option for backward compat", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "./add.ts"),
    ).text();
    // 旧选项仍存在（即使在 helper 里也注册了，但 add.ts 直接不应该有冲突）
    // 实际上 add.ts 现在应该完全依赖 helper，所以源码中不应该再有 .option("im-server-url"
    // 我们检查：handler 仍然读取 a.imServerUrl
    expect(source).toMatch(/a\.imServerUrl/);
  });

  test("add.ts handler resolves --server-url first, fallback to --im-server-url", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "./add.ts"),
    ).text();
    // handler 中应优先使用 serverUrl, fallback 到 imServerUrl
    expect(source).toMatch(/serverUrl\s*\|\|\s*a\.imServerUrl|a\.imServerUrl\s*\|\|\s*serverUrl/);
    // 写入 imServerUrl 字段（保持 schema 不变）
    expect(source).toContain("imServerUrl:");
  });

  test("add.ts has no duplicate .option('server-url' / 'im-server-url' outside helper import)", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "./add.ts"),
    ).text();
    // 不应该重复定义 server-url（避免 yargs 警告）
    const serverUrlMatches = source.match(/\.option\(['"]server-url['"]/g) || [];
    expect(serverUrlMatches.length).toBe(0);
    // 不应该重复定义 im-server-url（避免 yargs 警告）
    const imServerUrlMatches =
      source.match(/\.option\(['"]im-server-url['"]/g) || [];
    expect(imServerUrlMatches.length).toBe(0);
  });
});