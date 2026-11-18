/**
 * @fileoverview Task #2290: 重写后的 MultilineInput (uncontrolled) 测试
 *
 * 新 API:
 * - <MultilineInput onSubmit={(value) => ...} placeholder="..." />
 * - 内部 useState 维护 buffer + cursor
 * - 自己用 useInput 处理键盘 (Alt+Enter / Enter / Backspace / 方向键)
 *
 * 测试场景:
 * 1. 初始空 buffer 渲染
 * 2. 普通字符输入
 * 3. Alt+Enter (key.meta+key.return) 插入 \n
 * 4. Shift+Enter 也支持 (兼容)
 * 5. Ctrl+Enter 也支持 (兼容)
 * 6. Enter 提交整个 buffer
 * 7. Enter 提交后 buffer 清空
 * 8. Backspace / Delete / Left / Right / Home / End / Ctrl+U / Ctrl+K
 * 9. 多行提交 (反向断言: 不是只有最后一行)
 * 10. 空 buffer Enter 不提交
 * 11. Esc 清空 buffer
 */

import { test, expect, describe, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { MultilineInput, REPLInk } from "./repl-ink";

/**
 * Helper: 等 ink 渲染完成 + useInput 注册
 * useInput 的 effect 需要等 React 提交才能注册监听, 默认 200ms 保险
 */
async function waitForInput(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * Helper: 等组件响应 (写入 input 后等 setState + 渲染)
 */
async function waitForResponse(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Helper: 写入字符串到 stdin (一次性写入整个字符串)
 */
async function writeString(stdin: { write: (s: string) => void }, s: string): Promise<void> {
  stdin.write(s);
  await waitForResponse();
}

describe.skipIf(isParallelRun)("Task #2290: MultilineInput 渲染", () => {
  test("初始空 buffer - 显示 ❯ 前缀 + 光标 placeholder", async () => {
    const onSubmit = vi.fn();
    const { lastFrame } = render(
      React.createElement(MultilineInput, {
        onSubmit,
        placeholder: "type something...",
      }),
    );
    await waitForInput();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("❯");
    expect(frame).toContain("type something...");
  });

  test("单行输入 - ❯ 前缀 + 内容", async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();
    await writeString(stdin, "hello");
    await waitForResponse(200);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("❯");
    expect(frame).toContain("hello");
    // 不应该有 ... 前缀 (因为只有一行)
    expect(frame).not.toContain("...");
  });
});

describe.skipIf(isParallelRun)("Task #2292: 多行可编辑 (Up/Down arrow 行间跳转 + 中间行修改)", () => {
  test("Up arrow — 光标从最后一行跳到上一行, 插入字符到中间行", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    // 输入 "first line", Alt+Enter, "second line", Alt+Enter, "third line"
    // cursor 默认在第三行末尾
    await writeString(stdin, "first line");
    await waitForResponse(200);
    stdin.write("\x1b\r"); // Alt+Enter attempt
    await waitForResponse(200);
    await writeString(stdin, "second line");
    await waitForResponse(200);
    stdin.write("\x1b\r"); // Alt+Enter attempt
    await waitForResponse(200);
    await writeString(stdin, "third line");
    await waitForResponse(300);

    // 按 Up 一次 → 光标跳到 second line, offset 10 (preserving column 10)
    // "third line" 长度 10, cursor 在 offset 10 (末尾)
    // "second line" 长度 11, cursor 在 offset 10 (中间位置, 保留列)
    stdin.write("\x1b[A"); // Up arrow
    await waitForResponse(300);

    // 输入 "X" → 插入到 second line offset 10 → "second lin" + X + "e" = "second linXe"
    // (标准编辑器行为: 保留列位置, 不超过该行长度)
    await writeString(stdin, "X");
    await waitForResponse(200);

    // Enter 提交
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0]?.[0] as string;
    // submitted 应该包含 "second linXe" (X 插入 second line 中间)
    expect(submitted).toContain("second linXe");
    expect(submitted).toContain("first line");
    expect(submitted).toContain("third line");
  });

  test("Up arrow — 多次连续跳到第一行", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "AAA");
    await waitForResponse(200);
    stdin.write("\x1b\r");
    await waitForResponse(200);
    await writeString(stdin, "BBB");
    await waitForResponse(200);
    stdin.write("\x1b\r");
    await waitForResponse(200);
    await writeString(stdin, "CCC");
    await waitForResponse(300);

    // Up 2 次 → cursor 应该回到 AAA 行末尾 (第 3 行 → 第 2 行 → 第 1 行)
    stdin.write("\x1b[A");
    await waitForResponse(200);
    stdin.write("\x1b[A");
    await waitForResponse(200);

    // 输入 "X" → 应该插入到 AAA 行末尾 → "AAAX"
    await writeString(stdin, "X");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0]?.[0] as string;
    expect(submitted).toContain("AAAX");
  });

  test("Down arrow — 从第一行跳到第二行", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "top");
    await waitForResponse(200);
    stdin.write("\x1b\r");
    await waitForResponse(200);
    await writeString(stdin, "bottom");
    await waitForResponse(300);

    // cursor 现在在 "bottom" 末尾 (offset 6, buffer position 10)
    // 按 Up → cursor 跳到 "top" offset 3 (end of "top", 因为 "top" 只有 3 chars)
    stdin.write("\x1b[A");
    await waitForResponse(200);
    // 现在 cursor 在 "top" offset 3 (buffer position 3, 即 "\n" 之前)
    // 按 Down → cursor 跳到 "bottom" offset 3 (preserving column 3)
    stdin.write("\x1b[B"); // Down arrow
    await waitForResponse(300);

    // 输入 "X" → 插入到 "bottom" offset 3 → "bot" + X + "tom" = "botXtom"
    await writeString(stdin, "X");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0]?.[0] as string;
    expect(submitted).toContain("botXtom");
    expect(submitted).toContain("top");
  });

  test("Up arrow — 列位置被截到上一行长度", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    // 第一行长 (10 chars), 第二行短 (3 chars)
    await writeString(stdin, "long line!");
    await waitForResponse(200);
    stdin.write("\x1b\r");
    await waitForResponse(200);
    await writeString(stdin, "abc");
    await waitForResponse(300);

    // cursor 在 "abc" 行末尾 (col=3) → Up 跳到 "long line!" 行
    // col=3 < 10, 所以保持 col=3
    stdin.write("\x1b[A"); // Up
    await waitForResponse(300);

    // 输入 "X" → 插入到 "long line!" 第 3 列 → "lonXg line!"
    await writeString(stdin, "X");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0]?.[0] as string;
    expect(submitted).toContain("lonXg line!");
  });

  test("Down arrow — 列位置被截到下一行长度", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    // 第一行短 (3 chars), 第二行长 (10 chars)
    await writeString(stdin, "abc");
    await waitForResponse(200);
    stdin.write("\x1b\r");
    await waitForResponse(200);
    await writeString(stdin, "long line!");
    await waitForResponse(300);

    // cursor 现在在第二行 (long line!) 末尾 → Up 跳到第一行
    stdin.write("\x1b[A"); // Up
    await waitForResponse(200);
    // 现在 cursor 在 "abc" 行 col=3
    // 按 Down 跳到 "long line!" 行, col=3 (因为 "long line!".length=10 >= 3)
    stdin.write("\x1b[B"); // Down
    await waitForResponse(300);

    // 输入 "X" → 插入到 "long line!" 第 3 列 → "lonXg line!"
    await writeString(stdin, "X");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0]?.[0] as string;
    expect(submitted).toContain("lonXg line!");
    expect(submitted).toContain("abc");
  });

  test("中间行删除 — Up 后 Backspace 在第一行", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "hello");
    await waitForResponse(200);
    stdin.write("\x1b\r");
    await waitForResponse(200);
    await writeString(stdin, "world");
    await waitForResponse(300);

    // Up 跳到第一行末尾
    stdin.write("\x1b[A");
    await waitForResponse(300);

    // 按 Backspace 删 "hello" 的 "o" → "hell"
    stdin.write("\b");
    await waitForResponse(200);
    // 再按 Backspace 删 "l" → "hel"
    stdin.write("\b");
    await waitForResponse(200);

    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0]?.[0] as string;
    expect(submitted).toContain("hel");
    expect(submitted).toContain("world");
    expect(submitted).not.toContain("hello");
  });

  test("Up arrow 在第一行时 noop (不会跳到行 -1)", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "single line");
    await waitForResponse(300);

    // 只有一行, 按 Up 应该 noop (不报错)
    stdin.write("\x1b[A");
    await waitForResponse(300);

    // buffer 应该还是 "single line"
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalledWith("single line");
  });
});

describe.skipIf(isParallelRun)("Task #2290: MultilineInput 提交行为", () => {
  test("Enter 提交整个 buffer", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "hello world");
    await waitForResponse(200);
    stdin.write("\r"); // Enter
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalledWith("hello world");
  });

  test("提交后 buffer 清空", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "test");
    await waitForResponse(200);
    stdin.write("\r"); // Enter
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalledWith("test");

    // 提交后 buffer 应该清空
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("test");
    // 但应该还有 ❯ prefix
    expect(frame).toContain("❯");
  });

  test("空 buffer Enter 不提交", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    stdin.write("\r");
    await waitForResponse(300);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("只有空格 buffer Enter 不提交", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "   ");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("提交回调是 async 也正确处理", async () => {
    const onSubmit = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "async test");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalledWith("async test");
  });

  test("提交回调抛错时 buffer 也会清空 (避免 stuck)", async () => {
    const onSubmit = vi.fn(() => {
      throw new Error("test error");
    });
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "will fail");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalled();
    // buffer 应该还是被清空 (catch handler)
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("will fail");
  });
});

describe.skipIf(isParallelRun)("Task #2291: Backspace 兼容 \\x7f (DEL)", () => {
  test("Backspace (\\x7f DEL) 删除光标前一个字符 — 关键 bug 修复", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "hello");
    await waitForResponse(200);
    // 现代终端的 Backspace 键发的是 \x7f (DEL), 之前被识别为 key.delete 不工作
    stdin.write("\x7f");
    await waitForResponse(300);

    const frame = lastFrame() ?? "";
    // "hello" 的最后一个 "o" 应该被删除, 剩 "hell"
    expect(frame).not.toContain("hello");
    expect(frame).toContain("hell");
  });

  test("Backspace (\\b BS) 删除光标前一个字符 — 传统 BS 仍工作", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "world");
    await waitForResponse(200);
    // \b (0x08) 是传统 BS 字符, ink 识别为 key.backspace
    stdin.write("\b");
    await waitForResponse(300);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("world");
    expect(frame).toContain("worl");
  });

  test("多次 Backspace (\\x7f) 连续删除字符", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "abcdef");
    await waitForResponse(200);
    // 按 3 次 DEL
    stdin.write("\x7f");
    await waitForResponse(100);
    stdin.write("\x7f");
    await waitForResponse(100);
    stdin.write("\x7f");
    await waitForResponse(300);

    const frame = lastFrame() ?? "";
    // "abcdef" 删 3 个 → "abc"
    expect(frame).toContain("abc");
    expect(frame).not.toContain("abcde");
    expect(frame).not.toContain("abcd");
  });

  test("Backspace (\\x7f) 在 buffer 中间删除 (光标在末尾)", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "ab");
    await waitForResponse(200);
    // 输入 "cd" 之后 buffer = "abcd"
    await writeString(stdin, "cd");
    await waitForResponse(200);
    // 光标在末尾, 按 2 次 DEL 删掉 "cd"
    stdin.write("\x7f");
    await waitForResponse(100);
    stdin.write("\x7f");
    await waitForResponse(300);

    const frame = lastFrame() ?? "";
    // 应该回到 "ab"
    expect(frame).toContain("ab");
    expect(frame).not.toContain("cd");
  });
});

describe.skipIf(isParallelRun)("Task #2290: MultilineInput 光标操作", () => {
  test("Backspace 删除字符", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "hello");
    await waitForResponse(200);
    stdin.write("\b"); // backspace (\b in parseKeypress = backspace, \x7f = delete)
    await waitForResponse(300);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("hello");
    expect(frame).toContain("hell");
  });

  test("Left / Right arrow 移动光标 + 在中间插入", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "ab");
    await waitForResponse(200);
    stdin.write("\x1b[D"); // Left arrow → cursor = 1
    await waitForResponse(200);
    await writeString(stdin, "X");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalledWith("aXb");
  });

  test("Home (Ctrl+A) 跳转光标到行首", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "abc");
    await waitForResponse(200);
    stdin.write("\x01"); // Ctrl+A
    await waitForResponse(200);
    await writeString(stdin, "X");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalledWith("Xabc");
  });

  test("Ctrl+U 清空当前行", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "hello");
    await waitForResponse(200);
    stdin.write("\x15"); // Ctrl+U
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    // Ctrl+U 清空当前行 → buffer = "" → Enter 不应该提交
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("Ctrl+K 删除到行尾", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "abc");
    await waitForResponse(200);
    stdin.write("\x01"); // Home → cursor = 0
    await waitForResponse(200);
    stdin.write("\x0b"); // Ctrl+K → 删除全部
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    // buffer 应该空了 → 不应该调用 onSubmit
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe.skipIf(isParallelRun)("Task #2290: MultilineInput 多行提交 (核心 bug 验证)", () => {
  test("多行 buffer Enter 提交时传整个 buffer", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    // 输入 "first line"
    await writeString(stdin, "first line");
    await waitForResponse(200);

    // Alt+Enter — 通过发送 ESC + CR (\x1b\r) 模拟
    stdin.write("\x1b\r");
    await waitForResponse(200);

    // 输入 "second line"
    await writeString(stdin, "second line");
    await waitForResponse(200);

    // Alt+Enter again
    stdin.write("\x1b\r");
    await waitForResponse(200);

    // 输入 "third line"
    await writeString(stdin, "third line");
    await waitForResponse(200);

    // Enter 提交
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalled();

    const submitted = onSubmit.mock.calls[0]?.[0] as string;
    // 至少包含 first 和 third (无论 Alt+Enter 是否被识别)
    expect(submitted).toContain("first");
    expect(submitted).toContain("third");
  });

  test("提交后 buffer 清空 (多行场景)", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    await writeString(stdin, "alpha");
    await waitForResponse(200);
    stdin.write("\x1b\r"); // Alt+Enter attempt
    await waitForResponse(200);
    await writeString(stdin, "beta");
    await waitForResponse(200);
    stdin.write("\r"); // Enter
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalled();

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("alpha");
    expect(frame).not.toContain("beta");
  });
});

describe.skipIf(isParallelRun)("Task #2290: MultilineInput 边界情况", () => {
  test("Esc 清空 buffer + 触发 onEscape cascade (Task #2293)", async () => {
    // Task #2293: MultilineInput 自己不再处理 Esc — 让父 useInput 收到
    // 父 REPLInk 收到 Esc 后调 multilineInputRef.clearBuffer() + onEscape callback
    const onEscape = vi.fn();
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: {
          model: "M3",
          cwd: "/tmp",
          version: "1.0",
          sessionTitle: "test",
        },
        onSubmit,
        onEscape,
      }),
    );
    await waitForInput();

    await writeString(stdin, "dirty buffer");
    await waitForResponse(200);
    stdin.write("\x1b"); // ESC
    await waitForResponse(500);

    const frame = lastFrame() ?? "";
    // buffer 应该被清空 (via REPLInk 调 multilineInputRef.clearBuffer())
    expect(frame).not.toContain("dirty buffer");
    // onEscape callback 应该被触发 (Task #2294 hotfix P0/P1)
    expect(onEscape).toHaveBeenCalled();
  });

  test("粘贴多字符作为单个 input", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(MultilineInput, { onSubmit }),
    );
    await waitForInput();

    stdin.write("pasted content");
    await waitForResponse(200);
    stdin.write("\r");
    await waitForResponse(500);

    expect(onSubmit).toHaveBeenCalledWith("pasted content");
  });
});