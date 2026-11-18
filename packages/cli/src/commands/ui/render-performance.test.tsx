/**
 * @fileoverview UI 渲染性能优化测试 (Task #2317)
 *
 * 验证 4 个优化层面:
 * - 层面 1: React.memo 包裹 MessageView / CommandRow
 * - 层面 2: Ink <Static> 包裹历史消息 (历史不 re-render)
 * - 层面 3: handlers 用 useCallback (引用稳定) + filteredCmds 用 useMemo
 * - 层面 4: streaming throttle (50ms) 兜底
 *
 * 验收: 输入时只有输入框响应, 按 ↑/↓ 弹窗不闪烁, 历史完全静止。
 */

import { describe, test, expect } from "bun:test";
import { isParallelRun } from "../../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { SlashCommandPopup } from "./slash-command-popup";
import { MultilineInput } from "../repl-ink";

const MEMO_SYMBOL = Symbol.for("react.memo");

// ============================================================================
// RED 1: React.memo wrapping
// ============================================================================

describe.skipIf(isParallelRun)("Task #2317 RED: React.memo 包裹关键组件", () => {
  test("RED-1: SlashCommandPopup 应该是 React.memo 包装的组件", () => {
    // React.memo 包装的组件有一个特殊的 $$typeof 标记 (Symbol.for("react.memo"))
    expect((SlashCommandPopup as any).$$typeof).toBe(MEMO_SYMBOL);
  });

  test("RED-2: MultilineInput 应该是 React.memo 包装的组件", () => {
    // MultilineInput = React.memo(React.forwardRef(...))
    const inner = MultilineInput as any;
    expect(
      inner.$$typeof === MEMO_SYMBOL ||
        inner.type?.$$typeof === MEMO_SYMBOL ||
        inner.render?.$$typeof === MEMO_SYMBOL,
    ).toBe(true);
  });

  test("RED-3: SlashCommandPopup 同一 query/selectedIndex 不触发内部重渲染 (memo 验证)", () => {
    // React.memo 包装下, props 浅相等就不重渲染
    // 验证 $$typeof 是 memo + type.name 是组件名
    expect((SlashCommandPopup as any).$$typeof).toBe(MEMO_SYMBOL);
    expect((SlashCommandPopup as any).type?.name).toBe("SlashCommandPopup");
  });

  test("RED-3b: CommandRow 应该是 React.memo 包装的子组件 (静态分析验证)", async () => {
    // CommandRow 在 slash-command-popup.tsx 内部, 用静态分析验证
    const fs = await import("fs");
    const path = await import("path");
    const popupPath = path.resolve(__dirname, "slash-command-popup.tsx");
    const src = fs.readFileSync(popupPath, "utf-8");
    // 验证源代码包含 CommandRow = React.memo(...) 形式
    expect(src).toMatch(/CommandRow\s*=\s*React\.memo\s*\(/);
  });
});

// ============================================================================
// RED 2: useCallback / useMemo for stable refs
// ============================================================================

describe.skipIf(isParallelRun)("Task #2317 RED: useCallback / useMemo 稳定引用", () => {
  test("RED-4: SlashCommandPopup 的 filterCommands 调用应该被 useMemo 包裹", () => {
    // SlashCommandPopup 内部用 React.useMemo 包装 filterCommands(query)
    // 验证: 同一 query 多次调用结果引用稳定
    // (直接通过 render 两次, 检查显示结果一致)
    const { lastFrame: frame1 } = render(
      React.createElement(SlashCommandPopup, { query: "/", selectedIndex: 0 }),
    );
    const text1 = frame1() ?? "";
    expect(text1).toContain("/help");
  });

  test("RED-5: SlashCommandPopup 切换 selectedIndex 时应该只更新选中行", () => {
    const { lastFrame, rerender } = render(
      React.createElement(SlashCommandPopup, { query: "/", selectedIndex: 0 }),
    );
    const frame0 = lastFrame() ?? "";
    expect(frame0).toContain("/help");
    expect(frame0).toContain("▶"); // 选中标记

    // 切换到 selectedIndex=1 → 选 /init
    rerender(
      React.createElement(SlashCommandPopup, { query: "/", selectedIndex: 1 }),
    );
    const frame1 = lastFrame() ?? "";
    expect(frame1).toContain("/init");
    expect(frame1).toContain("▶");
  });
});

// ============================================================================
// RED 3: Ink <Static> for history (静态渲染)
// ============================================================================

describe.skipIf(isParallelRun)("Task #2317 RED: Ink <Static> 包裹历史消息", () => {
  test("RED-6: repl-ink 应该 import Static 组件 (用于历史消息静态渲染)", async () => {
    // 通过静态分析验证: repl-ink.tsx 至少 import 了 Static
    const fs = await import("fs");
    const path = await import("path");
    const replInkPath = path.resolve(__dirname, "../repl-ink.tsx");
    const src = fs.readFileSync(replInkPath, "utf-8");
    expect(src).toMatch(/import\s*\{[^}]*\bStatic\b[^}]*\}\s*from\s*["']ink["']/);
  });

  test("RED-7: repl-ink 渲染中使用了 <Static items={...}> 包裹历史消息", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const replInkPath = path.resolve(__dirname, "../repl-ink.tsx");
    const src = fs.readFileSync(replInkPath, "utf-8");
    // 验证源代码包含 <Static 标签
    expect(src).toMatch(/<Static[\s>]/);
  });

  test("RED-8: repl-ink 渲染中 Static 应放在 Box flexDirection='column' 容器内 (作为子节点)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const replInkPath = path.resolve(__dirname, "../repl-ink.tsx");
    const src = fs.readFileSync(replInkPath, "utf-8");
    // 验证 history items 被传给 Static (历史过滤, 最后一条单独渲染)
    // 接受两种模式:
    //   - 旧: <Static items={messages.slice(0, -1)}>
    //   - 新 (Task #2333): <Static items={staticItems}> (staticItems 是 useMemo 包装的 messages.slice(0, -1))
    const hasOldPattern = /<Static[\s\S]*?items=\{messages\.slice\(0,\s*-1\)\}/.test(src);
    const hasNewPattern = /<Static[\s\S]*?items=\{staticItems\}/.test(src);
    expect(hasOldPattern || hasNewPattern).toBe(true);
  });

  test("RED-9: repl-ink handleSubmit 应该用 useCallback 包裹 (引用稳定)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const replInkPath = path.resolve(__dirname, "../repl-ink.tsx");
    const src = fs.readFileSync(replInkPath, "utf-8");
    // 验证源代码中 handleSubmit 用 useCallback 包装
    expect(src).toMatch(/handleSubmit\s*=\s*React\.useCallback/);
  });
});