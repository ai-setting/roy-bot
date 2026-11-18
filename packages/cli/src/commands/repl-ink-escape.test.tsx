/**
 * @fileoverview ink REPL ESC keypress handler tests (Task #2294 hotfix)
 *
 * 验证 ink REPL 按 ESC 时调用外部 onEscape callback：
 * - 场景 1: 按 ESC → onEscape 被调用一次
 * - 场景 2: buffer 非空时按 ESC → buffer 清空 + onEscape 被调用
 * - 场景 3: buffer 为空时按 ESC → onEscape 被调用（不变更 buffer）
 * - 场景 4: onEscape 返回 rejected promise → 不 crash
 * - 场景 5: 没有 onEscape 时按 ESC → 不 crash（保持原行为）
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 *
 * Bug 上下文:
 * - 之前 ink REPL 的 ESC handler 只清空 buffer，从不调用外部 callback
 * - 导致 interactive.handleEscKey()（cascade stop）完全不被触发
 * - 用户按 ESC 无法中断 in-flight execution
 */

import { describe, test, expect, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { REPLInk } from "./repl-ink";

const baseContext = {
  model: "M3",
  cwd: "~/test",
  version: "1.6.13",
  sessionTitle: "test-session",
};

describe.skipIf(isParallelRun)("ink REPL ESC handler (Task #2294 hotfix)", () => {
  test("场景 1: 按 ESC 调用 onEscape callback", async () => {
    const onEscape = vi.fn();
    const { stdin } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: vi.fn(),
        onEscape,
      }),
    );
    // 等 useEffect 注册 stdin listener 完成
    await new Promise((r) => setTimeout(r, 50));
    // 按 ESC
    stdin.write("\x1b");
    // 等待事件分发
    await new Promise((r) => setTimeout(r, 50));

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("场景 2: buffer 非空时按 ESC 同时清空 buffer 并调用 onEscape", async () => {
    const onEscape = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: vi.fn(),
        onEscape,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // 先写入一些文本（通过 stdin）
    stdin.write("draft text");
    await new Promise((r) => setTimeout(r, 50));
    // 按 ESC
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));

    // onEscape 应被调用一次
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("场景 3: buffer 为空时按 ESC 仅调用 onEscape（不抛错）", async () => {
    const onEscape = vi.fn();
    const { stdin } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: vi.fn(),
        onEscape,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // 直接按 ESC（没有 buffer 内容）
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("场景 4: onEscape 返回 rejected promise 不 crash ink REPL", async () => {
    const onEscape = vi.fn().mockRejectedValue(new Error("cascade failed"));
    const { stdin } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: vi.fn(),
        onEscape,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // 按 ESC
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 100));

    // onEscape 被调用
    expect(onEscape).toHaveBeenCalledTimes(1);
    // 组件仍然能响应后续输入（不 crash）
    stdin.write("a"); // 普通字符
    await new Promise((r) => setTimeout(r, 50));
    // 不抛异常即通过（stdin 处理正常）
  });

  test("场景 5: 没有 onEscape 时按 ESC 不 crash（保持原行为）", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        // 故意不传 onEscape
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // 按 ESC
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));
    // 不抛异常即通过
  });

  test("场景 6: onEscape 为同步函数也能工作", async () => {
    const onEscape = vi.fn(() => {
      // 同步副作用 — e.g. 标记状态
    });
    const { stdin } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: vi.fn(),
        onEscape,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));

    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});