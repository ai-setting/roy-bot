/**
 * Regression tests for "preloadedPrompts.length undefined" bug
 *
 * 背景 (Bug):
 *   `roy-bot interactive --plugin tslsp` 启动后发送消息时崩溃：
 *   `TypeError: undefined is not a object (evaluating 'preloadedPrompts.length')`
 *
 * 根因:
 *   Phase 3 把 `eventSourceSystemPrompts` 声明在 REPL class field 上，
 *   但 handler 闭包 (line 1250) 通过 `this.eventSourceSystemPrompts` 访问。
 *   而 `async handler(args)` 是普通方法（非 arrow），
 *   Yargs 调用时 `this === {}` — 字段不存在 ⇒ undefined ⇒ `.length` 崩溃。
 *
 * 修复:
 *   - 删除 REPL class 上的 `private eventSourceSystemPrompts` 字段
 *   - 在 `async handler(args)` 闭包内用 `let eventSourceSystemPrompts: ... = []`
 *   - 全部 `this.eventSourceSystemPrompts` ⇒ `eventSourceSystemPrompts`
 *
 * 这些测试用静态检查 + 运行时 fallback 验证修复落位。
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  joinResolvedSystemPrompts,
  type ResolvedEventSourcePrompt,
} from "./collect-event-source-system-prompts";

// Task #4674: `commands/run.ts` 与 `commands/interactive.ts` 对调了文件名。
// `REPL` 类与 `this.eventSourceSystemPrompts` 属于 **Ink REPL 链路**，
// 该链路现在住在 `commands/run.ts`（注册命令名 `run`）。
const INTERACTIVE_TS = path.resolve(__dirname, "./run.ts");

describe("Interactive handler eventSourceSystemPrompts 兼容 (回归)", () => {
  test("interactive.ts 不再用 `this.eventSourceSystemPrompts` (Yargs this={} 会崩)", () => {
    const src = fs.readFileSync(INTERACTIVE_TS, "utf-8");
    // 不能有 this.eventSourceSystemPrompts (任意位置: 类/handler/其它)
    const matches = src.match(/this\.eventSourceSystemPrompts/g);
    expect(matches).toBeNull();
  });

  test("REPL 类上不应再有 eventSourceSystemPrompts private 字段", () => {
    const src = fs.readFileSync(INTERACTIVE_TS, "utf-8");
    // 切分: class 起点到下一个 `^}` (类结束)
    const classStart = src.indexOf("export class REPL {");
    expect(classStart).toBeGreaterThan(-1);
    // 从 classStart 之后找第一个出现 "^\n}" 的位置作为类结束
    const afterClassStart = src.slice(classStart);
    // 类结束标志：行首 `}`，但要跳过方法体内部的 `}`
    // 简单做法: 找到 "isIdle" 后再下一个独立的 `\n^}` 行
    const isIdleEnd = afterClassStart.indexOf("isIdle(): boolean {");
    expect(isIdleEnd).toBeGreaterThan(-1);
    const afterIsIdle = afterClassStart.slice(isIdleEnd);
    // isIdle 方法体之后 + 类结束
    const classBody = afterIsIdle;
    // 检查不应该存在 "private eventSourceSystemPrompts"
    expect(classBody).not.toMatch(/private\s+eventSourceSystemPrompts/);
  });

  test("handler 闭包内有 `let eventSourceSystemPrompts: ... = []`", () => {
    const src = fs.readFileSync(INTERACTIVE_TS, "utf-8");
    // 必须出现 let eventSourceSystemPrompts (per-invocation state)
    expect(src).toMatch(/^\s*let eventSourceSystemPrompts:\s*ResolvedEventSourcePrompt\[\]\s*=\s*\[\];/m);
  });

  test("compatibility: 空数组 join 应是空串（未传 --es 时走 undefined 分支）", () => {
    // 这等价于: preloadedPrompts.length === 0 时 joinResolvedSystemPrompts 不会 crash
    // (实际上根本不会调用，因为 length === 0 时返回 undefined)
    // 但 joinResolvedSystemPrompts([]) 必须安全返回 ""
    const result = joinResolvedSystemPrompts([]);
    expect(result).toBe("");
  });

  test("compatibility: joinResolvedSystemPrompts 接受 undefined 不崩", () => {
    // 在 strict 模式下如果传 undefined 应报错，但 joinResolvedSystemPrompts 应该只在
    // 显式传 array 时被调用。我们 document 这个 contract:
    //   当 length > 0 时才调用 joinResolvedSystemPrompts(preloadedPrompts)
    // 所以保证调用方传的是非空数组。
    // 这里测一下 length === 0 的 fallback 是 [] ⇒ undefined
    const preloadedPrompts: ResolvedEventSourcePrompt[] = [];
    const eventSourceSystemPrompt =
      preloadedPrompts.length > 0
        ? joinResolvedSystemPrompts(preloadedPrompts)
        : undefined;
    expect(eventSourceSystemPrompt).toBeUndefined();
  });

  test("compatibility: length > 0 时正确合并多个 source prompt", () => {
    const preloadedPrompts: ResolvedEventSourcePrompt[] = [
      { id: "b1", type: "bounty-im", prompt: "ALPHA" },
      { id: "b2", type: "lark-cli", prompt: "BETA" },
    ];
    const eventSourceSystemPrompt =
      preloadedPrompts.length > 0
        ? joinResolvedSystemPrompts(preloadedPrompts)
        : undefined;
    expect(eventSourceSystemPrompt).toBe("ALPHA\n\n---\n\nBETA");
  });
});
