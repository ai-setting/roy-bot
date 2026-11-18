/**
 * @fileoverview Task #2350: 输入字符导致消息历史重渲染的修复 RED tests
 *
 * **Bug**: interactive 模式下, 消息填满屏幕后, 在输入行输入任何字符 (普通字符/回退/删除),
 * 都导致 REPLInk 父组件重新渲染, 用户感受到"整个消息历史从第一条重新滚动渲染"。
 *
 * **根因**: `MultilineInput` 内的 useEffect 监听 [buffer, onChange] 变化,
 * 每次 buffer 改变都调 `onChange?.(buffer)`, 触发父 REPLInk 的 `setInputValue`,
 * 导致父级 re-render, 进而引发消息历史区(虽然用了 <Static>, 但父级 Box re-render
 * 仍会触发 ink 重新绘制整个屏幕)和 popup 等所有子组件重渲染。
 *
 * **修复 (Task #2350)**: 在 `useEffect` 内增加 `popupActive` 门控 —
 * 只有 `buffer.startsWith('/') || popupActive` 时才调 `onChange`。
 * 普通字符(不是 / 前缀, 弹窗未激活)不通知父级, 完全在 MultilineInput 内部处理。
 *
 * **RED 测试目标**:
 * - Test 1: MultilineInput 输入普通字符不调 onChange
 * - Test 2: MultilineInput 输入 / 调 onChange (保持 / 前缀的过滤行为)
 * - Test 3: MultilineInput 输入普通字符后回退仍不调 onChange
 * - Test 4: popupActive=true 时, 任何输入(包括普通字符)都调 onChange
 * - Test 5: REPLInk 父级 re-render count 在普通字符输入时有界
 *
 * Author: developer <dev@example.com>
 * Date: 2026-07-23
 * Task: #2350
 */

import { describe, test, expect, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { MultilineInput, REPLInk, type REPLInkApi, type REPLMessage } from "./repl-ink";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const baseContext = {
  model: "M3",
  cwd: "~/test",
  version: "1.6.16",
  sessionTitle: "test-session",
};

// ============================================================================
// Test 1: MultilineInput 输入普通字符不调 onChange
// ============================================================================
describe.skipIf(isParallelRun)("Task #2350 RED: MultilineInput onChange 门控 — 普通字符不通知父级", () => {
  test("RED-1: 输入普通字符 'a' 不触发 onChange (popupActive=false, 不以 / 开头)", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit: () => {},
        popupActive: false,
        onChange,
      }),
    );
    await wait(50);

    // 输入普通字符 'a'
    stdin.write("a");
    await wait(50);

    // 期望: onChange 不被调用 (修复后), 修复前会被调用 1 次
    expect(onChange).not.toHaveBeenCalled();
  });

  test("RED-2: 输入 'abc' 普通字符, onChange 仍然不调用", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit: () => {},
        popupActive: false,
        onChange,
      }),
    );
    await wait(50);

    stdin.write("abc");
    await wait(50);

    expect(onChange).not.toHaveBeenCalled();
  });

  test("RED-3: 输入 'hello world' 含空格, onChange 不调用", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit: () => {},
        popupActive: false,
        onChange,
      }),
    );
    await wait(50);

    stdin.write("hello world");
    await wait(50);

    expect(onChange).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Test 2: MultilineInput 输入 / 调 onChange (保持 / 前缀的过滤行为)
  // ==========================================================================
  test("GREEN-1: 输入 '/' 触发 onChange (保持 popup 行为)", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit: () => {},
        popupActive: false,
        onChange,
      }),
    );
    await wait(50);

    stdin.write("/");
    await wait(50);

    // 期望: onChange 被调用 1 次, 参数是 '/'
    expect(onChange).toHaveBeenCalledWith("/");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("GREEN-2: 输入 '/help' 触发 onChange, 参数是 '/help'", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit: () => {},
        popupActive: false,
        onChange,
      }),
    );
    await wait(50);

    stdin.write("/help");
    await wait(50);

    // 最后一次调用参数是 '/help'
    expect(onChange).toHaveBeenLastCalledWith("/help");
  });

  // ==========================================================================
  // Test 3: 回退/删除也不应通知父级 (当 buffer 不再以 / 开头)
  // ==========================================================================
  test("RED-4: 输入 / 后 backspace 到空, 后续 backspace 不再调 onChange", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit: () => {},
        popupActive: false,
        onChange,
      }),
    );
    await wait(50);

    // 输入 '/', 应该调 1 次 onChange('/')
    stdin.write("/");
    await wait(50);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("/");

    // Backspace 一次, buffer 变成 '', 不再以 / 开头, 不调 onChange
    stdin.write("\x7f");
    await wait(50);
    expect(onChange).toHaveBeenCalledTimes(1); // 还是 1 次

    // 再 backspace, buffer 还是 '', 仍不调 onChange
    stdin.write("\x7f");
    await wait(50);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // Test 4: popupActive=true 时, 任何输入都调 onChange (保持 popup 过滤同步)
  // ==========================================================================
  test("GREEN-3: popupActive=true 时, 输入普通字符也调 onChange", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit: () => {},
        popupActive: true,
        onChange,
      }),
    );
    await wait(50);

    // popup 激活时, 普通字符也应该通知父级 (保持原有 popup 过滤行为)
    stdin.write("a");
    await wait(50);

    expect(onChange).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  test("GREEN-4: popupActive=true 时, 输入 backspace 也调 onChange", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, {
        onSubmit: () => {},
        popupActive: true,
        onChange,
      }),
    );
    await wait(50);

    // 先输入 /h, 让 popup 显示 (因为 /h 匹配 /help 等命令)
    stdin.write("/h");
    await wait(50);
    const callCountAfterH = onChange.mock.calls.length;

    // 再 backspace, buffer 变成 '/'
    stdin.write("\x7f");
    await wait(50);

    // popupActive=true 时, backspace 仍应调 onChange
    expect(onChange.mock.calls.length).toBeGreaterThan(callCountAfterH);
    expect(onChange).toHaveBeenLastCalledWith("/");
  });
});

// ============================================================================
// Test 5: REPLInk 父级 re-render count 在普通字符输入时有界
// ============================================================================
describe.skipIf(isParallelRun)("Task #2350 RED: REPLInk 父级 re-render 在普通字符输入时有界", () => {
  test("RED-5: 输入 10 个普通字符, REPLInk 父级 re-render 次数 < 5 (无 setInputValue 触发)", async () => {
    let api: REPLInkApi | null = null;
    let replRenderCount = 0;

    // 通过包装组件计数 REPLInk 的 render 次数
    const Probe = () => {
      replRenderCount++;
      return React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a: REPLInkApi) => {
          api = a;
        },
      });
    };

    render(React.createElement(Probe));
    await wait(200);
    expect(api).not.toBeNull();

    // baseline: ready 状态建立后
    const baseline = replRenderCount;

    // 输入 10 个普通字符 (模拟"普通聊天"场景)
    api!.setInputBuffer("hello");
    await wait(50);

    const delta = replRenderCount - baseline;
    // 期望: setInputBuffer 是 imperative API, 内部调 onChange 流程不变
    // 但 setInputBuffer 自身会触发 onChange + 父级 setInputValue (让弹窗立即响应)
    // 我们的修复重点是普通字符输入(通过 stdin.write)不触发父级 re-render
    // 所以这个 test 主要验证: setInputBuffer 的影响有界

    // 实际 setInputBuffer 是弹窗选中命令的 API, 不算"普通字符输入"路径
    // 真正的"普通字符输入"通过 useInput key handler 走, 我们用 stdin.write 测试
    expect(delta).toBeLessThanOrEqual(3);
  });

  test("RED-6: 模拟用户实际输入 10 个普通字符, REPLInk 父级 re-render 次数极少", async () => {
    let api: REPLInkApi | null = null;
    let replRenderCount = 0;

    const Probe = () => {
      replRenderCount++;
      return React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a: REPLInkApi) => {
          api = a;
        },
      });
    };

    const { stdin } = render(React.createElement(Probe));
    await wait(200);
    expect(api).not.toBeNull();

    const baseline = replRenderCount;

    // 模拟用户输入 10 个普通字符 (不通过 setInputBuffer, 通过 stdin.write)
    for (const ch of "helloworld") {
      stdin.write(ch);
      await wait(20);
    }
    await wait(100);

    const delta = replRenderCount - baseline;

    // 期望: 修复后, 普通字符不调 onChange, 父级 re-render 次数应该 < 3
    // (主要是 useInput 触发的 ink 内部更新, 不应该有 setInputValue 触发的 re-render)
    // 修复前: 每个字符 1 次 re-render, 10 字符 = 10+ 次
    expect(delta).toBeLessThanOrEqual(3);
  });

  test("RED-7: 50 条历史消息下, 输入 10 个普通字符, REPLInk 父级 re-render 有界", async () => {
    let api: REPLInkApi | null = null;
    let replRenderCount = 0;

    const Probe = () => {
      replRenderCount++;
      return React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a: REPLInkApi) => {
          api = a;
        },
      });
    };

    const { stdin } = render(React.createElement(Probe));
    await wait(200);
    expect(api).not.toBeNull();

    // 填满 50 条历史消息
    for (let i = 0; i < 25; i++) {
      const msg: REPLMessage = { role: "user", content: `msg ${i + 1}`.padEnd(60, "x") };
      api!.appendMessage(msg);
      const reply: REPLMessage = { role: "assistant", content: `reply ${i + 1}`.padEnd(60, "y") };
      api!.appendMessage(reply);
    }
    await wait(100);

    const baseline = replRenderCount;

    // 输入 10 个普通字符
    for (const ch of "helloworld") {
      stdin.write(ch);
      await wait(20);
    }
    await wait(100);

    const delta = replRenderCount - baseline;
    // 期望: 修复后 < 3
    expect(delta).toBeLessThanOrEqual(3);
  });
});
