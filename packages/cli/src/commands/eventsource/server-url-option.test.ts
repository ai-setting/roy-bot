/**
 * @fileoverview Tests for shared `server-url-option.ts` helper.
 *
 * 目的：消除 eventsource add/update 命令里重复的 --server-url 定义 +
 * scheme 校验 + 末尾 / trim 逻辑。
 *
 * 行为约定：
 * - `addServerUrlOption(yargs)` — 给 yargs 加 `--server-url/-s` 选项 +
 *   同时注册 `--im-server-url`（向后兼容 alias，不抛 deprecation warning）
 * - `resolveServerUrl(serverUrl, fallback)` —
 *   1. serverUrl 为空 → 返回 fallback
 *   2. 否则 trim 末尾 / 后返回
 *   3. 若 trim 后不以 http:// / https:// / ws:// / wss:// 开头 →
 *      console.error + process.exit(1)
 *
 * 优先级：--server-url > BOUNTY_SERVER_URL env > http://localhost:8787 (fallback)
 *
 * 测试策略：
 * - 单元测试 helper 函数
 * - 静态测试 helper 输出（确保 alias 存在 + description 合理）
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yargs from "yargs";

import {
  addServerUrlOption,
  resolveServerUrl,
} from "./server-url-option";

describe("addServerUrlOption", () => {
  /**
   * T1: 注册了 server-url 和 alias
   */
  test("T1: adds --server-url with -s alias and description", async () => {
    const parser = addServerUrlOption(yargs() as any);
    const parsed = await new Promise<any>((resolveFn) => {
      parser.parse(
        ["--server-url", "https://bounty.example.com"],
        { run: () => {} } as any,
        (_err: any, argv: any) => resolveFn(argv),
      );
    });
    expect(parsed["server-url"]).toBe("https://bounty.example.com");
    expect(parsed.serverUrl).toBe("https://bounty.example.com"); // camelCase
  });

  /**
   * T2: --im-server-url 作为 alias 仍然可用（向后兼容）
   */
  test("T2: --im-server-url alias is also registered (backward compat)", async () => {
    const parser = addServerUrlOption(yargs() as any);
    const parsed = await new Promise<any>((resolveFn) => {
      parser.parse(
        ["--im-server-url", "ws://localhost:4005/ws"],
        { run: () => {} } as any,
        (_err: any, argv: any) => resolveFn(argv),
      );
    });
    expect(parsed["im-server-url"]).toBe("ws://localhost:4005/ws");
    expect(parsed.imServerUrl).toBe("ws://localhost:4005/ws");
  });

  /**
   * T3: --server-url 可选（不强制）
   */
  test("T3: --server-url is optional (not demandOption)", async () => {
    const parser = addServerUrlOption(yargs() as any);
    const parsed = await new Promise<any>((resolveFn) => {
      parser.parse([], { run: () => {} } as any, (_err: any, argv: any) =>
        resolveFn(argv),
      );
    });
    expect(parsed["server-url"]).toBeUndefined();
    expect(parsed["im-server-url"]).toBeUndefined();
  });

  /**
   * T7: 静态 grep 验证 source 注册了 server-url 和 im-server-url 两个 key
   */
  test("T7: source file declares both server-url and im-server-url options", () => {
    const src = readFileSync(
      resolve(import.meta.dir, "./server-url-option.ts"),
      "utf-8",
    );
    // 必须同时存在两个 option 注册
    expect(src).toMatch(/['"]server-url['"]/);
    expect(src).toMatch(/['"]im-server-url['"]/);
    expect(src).toMatch(/alias:\s*['"]s['"]/);
    // description 应包含关键提示
    expect(src).toMatch(/Must start with/);
    expect(src).toMatch(/Trailing slashes are auto-trimmed/);
  });
});

describe("resolveServerUrl", () => {
  let exitSpy: any;
  let errSpy: any;

  beforeEach(() => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`EXIT_${code}`);
    }) as any);
  });

  afterEach(() => {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  /**
   * T2: undefined → 返回 fallback
   */
  test("T2: undefined --server-url returns the fallback", () => {
    expect(resolveServerUrl(undefined, "http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(resolveServerUrl("", "ws://fallback.example.com:4005/ws")).toBe(
      "ws://fallback.example.com:4005/ws",
    );
  });

  /**
   * T3: trim 末尾 /
   */
  test("T3: trailing slash on --server-url is auto-trimmed", () => {
    expect(resolveServerUrl("http://localhost:8787/", "fallback")).toBe(
      "http://localhost:8787",
    );
    expect(resolveServerUrl("ws://localhost:4005/ws/", "fallback")).toBe(
      "ws://localhost:4005/ws",
    );
    // 多重 / 也 trim
    expect(resolveServerUrl("http://localhost:8787///", "fallback")).toBe(
      "http://localhost:8787",
    );
    // 无尾 / 不变
    expect(resolveServerUrl("http://localhost:8787", "fallback")).toBe(
      "http://localhost:8787",
    );
  });

  /**
   * T4: 无 scheme 报错 + exit 1
   */
  test("T4: --server-url without scheme should error and exit 1", () => {
    expect(() =>
      resolveServerUrl("localhost:8787", "http://localhost:8787"),
    ).toThrow("EXIT_1");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const errOutput = String(errSpy.mock.calls[0]?.[0] ?? "");
    expect(errOutput).toContain("Invalid --server-url");
    expect(errOutput).toContain("localhost:8787");

    // ftp 也不行
    expect(() =>
      resolveServerUrl("ftp://bounty.example.com", "http://localhost:8787"),
    ).toThrow("EXIT_1");
  });

  /**
   * T5: http:// / https:// 都接受
   */
  test("T5a: http:// is accepted", () => {
    expect(resolveServerUrl("http://localhost:8787", "fallback")).toBe(
      "http://localhost:8787",
    );
  });

  test("T5b: https:// is accepted", () => {
    expect(
      resolveServerUrl("https://bounty.example.com", "fallback"),
    ).toBe("https://bounty.example.com");
  });

  test("T5c: ws:// is accepted (for IM WebSocket server, backward compat)", () => {
    expect(resolveServerUrl("ws://localhost:4005/ws", "fallback")).toBe(
      "ws://localhost:4005/ws",
    );
  });

  test("T5d: wss:// is accepted (for IM WebSocket server with TLS)", () => {
    expect(
      resolveServerUrl("wss://im.example.com/ws", "fallback"),
    ).toBe("wss://im.example.com/ws");
  });

  /**
   * T6: 优先级链 (通过 mock env 验证)
   * --server-url > BOUNTY_SERVER_URL env > fallback
   *
   * 注：BOUNTY_SERVER_URL env 优先级由调用方解析（helper 只接受一个值），
   * 但我们验证：当 serverUrl 为空时返回 fallback（fallback 通常已经是
   * 解析 env 后的结果，由调用方传入）。
   */
  test("T6: precedence --server-url > env > fallback", () => {
    // 模拟调用方解析 env 的逻辑：
    // const envUrl = process.env.BOUNTY_SERVER_URL;
    // const fallback = envUrl || "http://localhost:8787";
    // const final = resolveServerUrl(opts.serverUrl, fallback);
    const fallback = "http://from-env:8787"; // 假设 env 已解析进 fallback
    // 1) --server-url 优先
    expect(resolveServerUrl("https://from-cli:8787", fallback)).toBe(
      "https://from-cli:8787",
    );
    // 2) 没有 --server-url，用 fallback (env)
    expect(resolveServerUrl(undefined, fallback)).toBe(fallback);
    // 3) 都没有，用默认
    expect(resolveServerUrl(undefined, "http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
  });
});