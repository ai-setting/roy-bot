/**
 * @fileoverview Snapshot-style test: 端到端 welcome card 输出
 *
 * Task #2252: 验证整个 REPL 启动流程能正确打印欢迎卡 + 状态栏
 *
 * 模拟一次完整的启动序列：
 *   1. 创建 REPL with model + version options
 *   2. mock stdout
 *   3. 调用 REPL.printHeader()
 *   4. 断言输出含 box-drawing 边框 + 像素 logo + model/version/sessionTitle
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as chalkNs from "chalk";
import { REPL } from "../run";

const chalk = chalkNs.default;

describe("REPL welcome card integration (Task #2252)", () => {
  let originalLevel: 0 | 1 | 2 | 3;
  let originalIsTTY: boolean | undefined;
  let stdoutWrites: string[] = [];
  let origWrite: any;
  let origLog: any;

  beforeEach(() => {
    originalLevel = chalk.level as 0 | 1 | 2 | 3;
    chalk.level = 0; // 强制无颜色输出，简化断言
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    stdoutWrites = [];
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((data: any, ...args: any[]) => {
      stdoutWrites.push(String(data));
      return true;
    }) as any;
    // console.log uses an internal cached reference; mock by intercepting _write
    origLog = console.log;
    console.log = (...args: any[]) => {
      stdoutWrites.push(args.map(a => String(a)).join(" ") + "\n");
    };
  });

  afterEach(() => {
    chalk.level = originalLevel;
    if (originalIsTTY === undefined) {
      // @ts-ignore
      delete process.stdout.isTTY;
    } else {
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    }
    process.stdout.write = origWrite;
    console.log = origLog;
  });

  test("REPL.printHeader() should print welcome card with model + version", () => {
    const repl = new REPL({
      sessionId: "test-id",
      sessionTitle: "test-session",
      model: "MiniMax-M3",
      version: "1.6.13",
      onExecute: async () => "ok",
      onStatus: async () => ({ sessionId: "x", sessionTitle: "y", messageCount: 0, tokenCount: 0 }),
      onSwitchSession: async (id) => ({ sessionId: id, sessionTitle: "x" }),
      onCompact: async () => {},
      onShutdown: async () => {},
    });
    // 调用 printHeader（private 方法）
    (repl as any).printHeader();
    const all = stdoutWrites.join("");
    // 包含 box-drawing 边框
    expect(all).toContain("\u256D"); // ╭
    expect(all).toContain("\u256E"); // ╮
    // Task #2274 P1: model/session 不再在欢迎卡（移到 status bar ctx）
    // 仅 version 仍在标题内
    expect(all).toContain("1.6.13");
    // 包含 Tips (1 条具体的)
    expect(all).toContain("/help");
    expect(all).toContain("Show all commands");
    // 包含 What's new (1 条具体的)
    expect(all).toContain("Welcome card");
    // 关闭（防止 readline 监听泄漏到下一个测试）
    repl.shutdown();
  });

  test("REPL.setMode('executing') should update status bar", () => {
    const repl = new REPL({
      sessionId: "x",
      sessionTitle: "y",
      onExecute: async () => "ok",
      onStatus: async () => ({ sessionId: "x", sessionTitle: "y", messageCount: 0, tokenCount: 0 }),
      onSwitchSession: async (id) => ({ sessionId: id, sessionTitle: "x" }),
      onCompact: async () => {},
      onShutdown: async () => {},
    });
    const writesBefore = stdoutWrites.length;
    repl.setMode("executing", "bash");
    const after = stdoutWrites.slice(writesBefore).join("");
    // executing 模式 + detail=bash 应该含 "executing" 和 "bash"
    expect(after).toContain("executing");
    expect(after).toContain("bash");
    repl.shutdown();
  });

  test("REPL.setMode('ready') should show ready status", () => {
    const repl = new REPL({
      sessionId: "x",
      sessionTitle: "y",
      onExecute: async () => "ok",
      onStatus: async () => ({ sessionId: "x", sessionTitle: "y", messageCount: 0, tokenCount: 0 }),
      onSwitchSession: async (id) => ({ sessionId: id, sessionTitle: "x" }),
      onCompact: async () => {},
      onShutdown: async () => {},
    });
    const writesBefore = stdoutWrites.length;
    repl.setMode("ready");
    const after = stdoutWrites.slice(writesBefore).join("");
    expect(after).toContain("ready");
    repl.shutdown();
  });
});
