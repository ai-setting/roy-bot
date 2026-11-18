/**
 * @fileoverview ink REPL 简化测试 (Task #2279)
 */

import { describe, test, expect, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import * as React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import TextInput from "ink-text-input";

function SimpleREPL({ onSubmit }: { onSubmit: (s: string) => void }) {
  const [buf, setBuf] = React.useState("");
  return (
    <Box>
      <Text color="red">❯ </Text>
      <TextInput
        value={buf}
        onChange={setBuf}
        onSubmit={(v) => {
          if (v.trim()) onSubmit(v);
          setBuf("");
        }}
      />
    </Box>
  );
}

describe.skipIf(isParallelRun)("ink 基础测试 (Task #2279)", () => {
  test("ink-testing-library render 基本组件", () => {
    const { lastFrame } = render(<SimpleREPL onSubmit={() => {}} />);
    expect(lastFrame()).toBeDefined();
  });

  test("单行 Enter 提交", () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<SimpleREPL onSubmit={onSubmit} />);
    stdin.write("hello");
    stdin.write("\r");
    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  test("空 Enter 不提交", () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<SimpleREPL onSubmit={onSubmit} />);
    stdin.write("\r");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("多轮提交", () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<SimpleREPL onSubmit={onSubmit} />);
    stdin.write("first");
    stdin.write("\r");
    expect(onSubmit).toHaveBeenCalledWith("first");
    stdin.write("second");
    stdin.write("\r");
    expect(onSubmit).toHaveBeenCalledWith("second");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  test("bracketed paste 多行（不立即提交）", () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<SimpleREPL onSubmit={onSubmit} />);

    // 模拟 bracketed paste：3 行
    stdin.write("\x1b[200~pasted line one\npasted line two\npasted line three\x1b[201~");

    // onSubmit 还不应被调用
    expect(onSubmit).not.toHaveBeenCalled();

    // 验证 lastFrame 包含所有 3 行
    const frame = lastFrame();
    expect(frame).toContain("pasted line one");
    expect(frame).toContain("pasted line two");
    expect(frame).toContain("pasted line three");
  });

  test("bracketed paste 后按 Enter 整段提交", () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<SimpleREPL onSubmit={onSubmit} />);

    // bracketed paste
    stdin.write("\x1b[200~line1\nline2\x1b[201~");
    // 按 Enter 提交
    stdin.write("\r");

    // 验证 onSubmit 收到完整多行内容
    expect(onSubmit).toHaveBeenCalledWith("line1\nline2");
  });
});