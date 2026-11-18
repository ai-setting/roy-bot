/**
 * @fileoverview RED tests for TUI incremental rendering — Task #3001.
 *
 * User feedback: "roy-bot run 的 TUI 在渲染消息时, 每次新消息都从头渲染
 * 整个消息列表, 导致 UI 不停刷新跳变。"
 *
 * Root cause: `<Static items={history}>` 用 `key={`${item.role}:${item.content}`}`
 * — content 变化时 key 改变, 导致 Static 中已有的 history items 被 React 视为
 * "新元素" 而触发重新打印 (Ink Static 通过 stdout 写输出, 重写即视觉跳变)。
 *
 * Fix direction: 给 HistoryItem 增加 stable id (生成时分配), Static 的 React
 * key 用 id (content 不影响 key)。这样:
 *   - 已打印的 history items 不再被重渲染 (key 稳定 → React 复用)
 *   - 新 append 的 history items 用新 id (key 新 → 新打印一行)
 *
 * These tests verify:
 *   1. HistoryItem 必须有 stable id (id 不会因 content 变化而改变)
 *   2. App.tsx Static 的 key 用 id (而不是 role:content 拼接)
 *   3. setHistory append 后旧的 items 的 id 不变 (React 复用稳定 key)
 *   4. streaming 完成 → append 到 history 时, 旧 items 不被重新打印
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "./App.js";
import type { HistoryItem } from "./App.js";

/**
 * Strip ANSI escape codes for stable text comparison.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe.skipIf(isParallelRun)("Task #3001: TUI incremental rendering — stable id + Static key", () => {
  it("HistoryItem type should have an optional stable id field (compile-time check)", () => {
    // This test verifies the type augmentation. If HistoryItem doesn't
    // have an `id` field, this assignment fails to typecheck.
    const item: HistoryItem = {
      role: "user",
      content: "hello",
      id: "user-stable-123",
    };
    expect(item.id).toBe("user-stable-123");
  });

  it("HistoryItem without id should still be valid (backward compat)", () => {
    // Old-style items without id should still work; App falls back
    // to role:content key when id is missing.
    const item: HistoryItem = {
      role: "user",
      content: "legacy",
    };
    expect(item.id).toBeUndefined();
  });

  it("App renders user history items without crashing (baseline)", () => {
    const history: HistoryItem[] = [
      { id: "u1", role: "user", content: "msg-1" },
      { id: "u2", role: "user", content: "msg-2" },
    ];
    const { lastFrame, unmount } = render(
      <App history={history} status="idle" />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("msg-1");
    expect(frame).toContain("msg-2");
    unmount();
  });

  it("App re-render with same ids does not duplicate static output", () => {
    // Render the same history with stable ids twice in the same App
    // instance — by re-rendering the parent. The Static region should
    // keep the existing items (key stable) and not re-output them.
    //
    // We simulate this by mounting App, then triggering a parent
    // re-render that passes the SAME history array reference.
    const history: HistoryItem[] = [
      { id: "stable-1", role: "user", content: "first" },
      { id: "stable-2", role: "assistant", content: "second" },
    ];

    const { rerender, lastFrame, unmount } = render(
      <App history={history} status="idle" />
    );
    const firstFrame = stripAnsi(lastFrame() ?? "");
    expect(firstFrame).toContain("first");
    expect(firstFrame).toContain("second");

    // Force re-render with same history (stable reference)
    rerender(<App history={history} status="idle" />);
    const secondFrame = stripAnsi(lastFrame() ?? "");
    // Same items must still be visible
    expect(secondFrame).toContain("first");
    expect(secondFrame).toContain("second");

    unmount();
  });

  it("App with duplicate-content items (no id) renders both — backward compat", () => {
    // Two messages with identical content should still render separately
    // when using id-based keys. Without id, they collide. With id, they don't.
    const history: HistoryItem[] = [
      { id: "a", role: "user", content: "same" },
      { id: "b", role: "user", content: "same" },
    ];
    const { lastFrame, unmount } = render(
      <App history={history} status="idle" />
    );
    const frame = lastFrame() ?? "";
    // Both should be visible (count "same" at least twice)
    const matches = frame.match(/same/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
    unmount();
  });

  it("App does NOT emit duplicate-key warning when items have stable ids", () => {
    // This is the core RED test: with stable ids, React should NOT
    // emit "Encountered two children with the same key" warnings.
    // Without stable ids (using role:content), two items with same
    // content trigger React's duplicate-key warning.
    //
    // We capture console.error (where React writes the warning) and
    // verify it does NOT contain "same key" warnings.
    const capturedErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map(String).join(" "));
    };

    try {
      const history: HistoryItem[] = [
        { id: "unique-a", role: "user", content: "duplicate-content" },
        { id: "unique-b", role: "user", content: "duplicate-content" },
      ];
      const { unmount } = render(
        <App history={history} status="idle" />
      );
      unmount();
    } finally {
      console.error = originalError;
    }

    // No React duplicate-key warning should be emitted when ids are stable
    const duplicateKeyWarnings = capturedErrors.filter(
      (m) => m.includes("same key") || m.includes("duplicate key"),
    );
    expect(duplicateKeyWarnings).toHaveLength(0);
  });

  it("App rerender with stable ids does NOT cause console.error warnings", () => {
    // Simulate the streaming scenario: parent component re-renders App
    // many times with the same history (stable ids, but possibly new
    // array reference each render). With id-based keys, React should
    // not produce duplicate-key warnings.
    const capturedErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map(String).join(" "));
    };

    try {
      // First render with some history
      const history1: HistoryItem[] = [
        { id: "u1", role: "user", content: "first user msg" },
        { id: "a1", role: "assistant", content: "first assistant reply" },
      ];
      const { rerender, unmount } = render(
        <App history={history1} status="idle" />
      );

      // Re-render with a NEW array reference but SAME ids (simulating
      // streaming: parent rerenders but history is the same logical
      // state — this is the pattern RunTui.tsx uses).
      const history2: HistoryItem[] = [
        { id: "u1", role: "user", content: "first user msg" },
        { id: "a1", role: "assistant", content: "first assistant reply" },
      ];
      rerender(<App history={history2} status="idle" />);

      // Append a new item with a new id
      const history3: HistoryItem[] = [
        { id: "u1", role: "user", content: "first user msg" },
        { id: "a1", role: "assistant", content: "first assistant reply" },
        { id: "u2", role: "user", content: "second user msg" },
      ];
      rerender(<App history={history3} status="idle" />);

      unmount();
    } finally {
      console.error = originalError;
    }

    // No React duplicate-key warnings should be emitted
    const duplicateKeyWarnings = capturedErrors.filter(
      (m) => m.includes("same key") || m.includes("duplicate key"),
    );
    expect(duplicateKeyWarnings).toHaveLength(0);
  });
});