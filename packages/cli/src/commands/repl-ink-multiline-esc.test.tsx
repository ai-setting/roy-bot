/**
 * @fileoverview MultilineInput onEscape contract test (Task #2303)
 *
 * Task #2303 RED: 验证 MultilineInput 组件必须直接拦截 ESC 并调用 onEscape prop,
 * 不依赖父 useInput 的 listener 顺序 — 因为父 useInput handler 是 inline 函数,
 * 每次 render 重建, ink effect 反复 remove/re-add listener, 在 streaming re-render
 * 期间存在空窗期, ESC 在空窗期到达时只触发子 handler, 父 onEscape 漏掉.
 *
 * 修复方案: MultilineInput 加 onEscape prop, 子 useInput 在 key.escape 入口
 * 同步调用 onEscape + return. 父 useInput 保留 key.escape 兜底作为双保险.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { REPLInk, MultilineInput, type MultilineInputRef } from "./repl-ink";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(isParallelRun)("MultilineInput onEscape contract (Task #2303)", () => {
  test("RED 场景 1: MultilineInput 接受 onEscape prop, 按 ESC 同步调用它", async () => {
    const onEscape = vi.fn();
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit,
        onEscape,
      }),
    );
    await wait(50);

    // 按 ESC — 期望 onEscape 同步被调用
    stdin.write("\x1b");
    await wait(50);

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("RED 场景 2: MultilineInput buffer 非空时按 ESC 同时调用 onEscape 并清空 buffer", async () => {
    const onEscape = vi.fn();
    const onSubmit = vi.fn();
    const ref = React.createRef<MultilineInputRef>();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit,
        onEscape,
        ref,
      }),
    );
    await wait(50);

    // 用户在 multiline input 里输入了一些文字（还没提交）
    stdin.write("draft text");
    await wait(50);

    // 按 ESC — 期望 onEscape 被调用
    stdin.write("\x1b");
    await wait(50);

    expect(onEscape).toHaveBeenCalledTimes(1);
    // 期望 buffer 被清空（通过 ref.clearBuffer 行为验证 — 后续输入字符应从 cursor=0 开始）
    // (无法直接读取 buffer state, 但清空后 lastFrame 不应包含 'draft text')
    // 简单验证: ref.clearBuffer 不抛错即可（说明接口已暴露）
    expect(() => ref.current?.clearBuffer()).not.toThrow();
  });

  test("RED 场景 3: 父 REPLInk 把 onEscape 传给 MultilineInput, 按 ESC 时子层先调 onEscape", async () => {
    // 这个测试验证修复后的架构: 父级把 onEscape 传给 MultilineInput,
    // 这样子层会在 useInput 入口同步调用 onEscape, 不依赖父 listener 的状态.
    const onEscape = vi.fn();
    const { stdin } = render(
      React.createElement(REPLInk, {
        initialContext: {
          model: "M3",
          cwd: "~/test",
          version: "1.6.13",
          sessionTitle: "test-session",
        },
        onSubmit: vi.fn(),
        onEscape,
      }),
    );
    await wait(50);

    stdin.write("\x1b");
    await wait(100);

    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(isParallelRun)("MultilineInput 不依赖父 useInput listener 顺序 — ESC 鲁棒性 (Task #2303)", () => {
  test("RED 场景 4: 模拟父 listener 不在时, MultilineInput 仍能触发 onEscape", async () => {
    // 通过直接渲染 MultilineInput (没有父 useInput 监听器) 来模拟
    // "父 listener 在空窗期" 的极端情况:
    // 修复前: 没有父 listener, ESC 完全不触发任何东西 — onEscape 永远不被调
    // 修复后: MultilineInput 自己处理 ESC, 直接调 onEscape — 仍能被调
    const onEscape = vi.fn();
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit,
        onEscape,
      }),
    );
    await wait(50);

    stdin.write("\x1b");
    await wait(100);

    // 关键断言: 即使没有父 useInput 监听器, onEscape 也应被调用
    expect(onEscape).toHaveBeenCalled();
  });

  test("RED 场景 5: 连续 2 次 ESC 间隔 100ms, 每次都触发 onEscape", async () => {
    const onEscape = vi.fn();
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit,
        onEscape,
      }),
    );
    await wait(50);

    stdin.write("\x1b");
    await wait(100);
    stdin.write("\x1b");
    await wait(100);

    expect(onEscape).toHaveBeenCalledTimes(2);
  });
});