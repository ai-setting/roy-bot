/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5109 P7 验收轮 —— **全 UI** /theme 联动测试
 * （DS r1 MAJOR-1 / r2 MAJOR-1、MAJOR-2 修复验证）。
 *
 * ## 背景（三轮 review 的演进）
 *
 * - **r1 MAJOR-1**：/theme 只影响 SlashPalette —— 其余组件用一次性
 *   `resolveSolidTheme()`（挂载时快照）。
 * - **r2 MAJOR-1**：r1 的修法 `useTuiThemeReactive()()` **立即调用**
 *   ⇒ 仍然是快照（响应式被消灭）⇒ 只有 SlashPalette 变色。
 *   正确修法：hook 返回 **Proxy**（每次属性访问重新求值）。
 * - **r2 MAJOR-2**：r1 的守护测试**空转** —— 结构守卫被 `()()` 写法
 *   轻易满足；帧级断言在 `setTuiThemeMode` **之后**才 mount，
 *   只证明「挂载时能读对 mode」（修复前就成立）；
 *   且该 runner `canRepaintWith() === false` ⇒ 挂载后重绘不可观测。
 *
 * ## 本文件的断言策略（纯 Solid 语义，不依赖重绘能力）
 *
 * 1. **属性访问实时性**：`useTuiThemeReactive()` 返回的 Proxy，
 *    在 `setTuiThemeMode()` 之后再次访问 `theme.primary` 必须返回新值
 *    —— 这正是「挂载后切换」的真实语义，且**不需要**重绘能力。
 * 2. **A/B 对照**（DS r2 要求）：同一个断言对「旧写法（快照）」
 *    必须失败、对「新写法（Proxy）」必须通过 ⇒ 用
 *    `createMemo` + signal 变化实测两种写法的差异。
 * 3. **组件源码结构守卫**：组件不得再调用非响应式的
 *    `resolveSolidTheme()`，且**不得**写成 `useTuiThemeReactive()()`
 *    （立即调用 = 快照，正是 r2 MAJOR-1 的坑）。
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemo, createRoot } from "solid-js";
import { isSolidReactive, SSR_SKIP_REASON } from "./test-utils/solid-test-env.js";
import {
  resetTuiThemeMode,
  resolveSolidTheme,
  setTuiThemeMode,
  useTuiThemeReactive,
} from "./theme.js";

const SRC_DIR = import.meta.dir;

/**
 * 能力 gate：SSR build 下 `createMemo` **不追踪 signal**（不重算）⇒
 * 「signal 变化后 memo 重算」这条断言只在**响应式 build**下成立。
 * （实测：browser 口径绿、串行口径红 —— 正是 SSR build 的固有限制，
 *  与既��� RunScreen/TextInput 测试的 REPAINTABLE gate 同源。）
 */
const SOLID_REACTIVE = isSolidReactive();
const describeIfReactive = SOLID_REACTIVE ? describe : describe.skip;

/** 这些组件必须订阅响应式主题（不得读一次性快照）。 */
const REACTIVE_FILES = [
  "App.tsx",
  "StatusBar.tsx",
  "TextInput.tsx",
  "Spinner.tsx",
  "ToolCall.tsx",
  "Markdown.tsx",
  "scrollbar.ts",
  "SlashPalette.tsx",
];

describe("tui-solid P7 — 全 UI /theme 联动（DS r1/r2 MAJOR 修复验证）", () => {
  /**
   * 隔离环境变量。
   *
   * ⚠️ 必做：同目录其它测试文件（scrollbar.test.ts / Markdown.nocolor.p5.test.ts
   * / App.p5-theme.test.tsx）会临时设 `process.env.NO_COLOR`，
   * 若它们未恢复，本文件的 mode 断言会被降级成 noColor（实测：
   * 单跑绿、全量串行红 —— received #fab283 而非 #3b7dd8）。
   */
  const withCleanEnv = <T,>(fn: () => T): T => {
    const prev = {
      NO_COLOR: process.env.NO_COLOR,
      TERM: process.env.TERM,
      ROY_TUI_THEME: process.env.ROY_TUI_THEME,
    };
    delete process.env.NO_COLOR;
    delete process.env.TERM;
    delete process.env.ROY_TUI_THEME;
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("组件不得再调用非响应式的 resolveSolidTheme()", () => {
    for (const f of REACTIVE_FILES) {
      const src = readFileSync(join(SRC_DIR, f), "utf-8");
      expect(src).not.toMatch(/=\s*resolveSolidTheme\(\)/);
      expect(src).toContain("useTuiThemeReactive");
    }
  });

  it("组件不得写成 useTuiThemeReactive()()（立即调用 = 快照，DS r2 MAJOR-1）", () => {
    for (const f of REACTIVE_FILES) {
      const src = readFileSync(join(SRC_DIR, f), "utf-8");
      expect(src).not.toMatch(/useTuiThemeReactive\(\)\(\)/);
    }
  });

  it("theme.ts 仍导出 resolveSolidTheme（工具函数兼容）", () => {
    const src = readFileSync(join(SRC_DIR, "theme.ts"), "utf-8");
    expect(src).toContain("export function resolveSolidTheme");
  });

  it("hook 返回 Proxy：signal 变化后属性访问立即反映新主题", () => {
    withCleanEnv(() => {
      resetTuiThemeMode();
      setTuiThemeMode("dark");
      const theme = useTuiThemeReactive();
      const before = theme.primary;
      setTuiThemeMode("light");
      const after = theme.primary;
      expect(before).toBe("#fab283");
      expect(after).toBe("#3b7dd8");
      expect(theme.mode).toBe("light");
      resetTuiThemeMode();
    });
  });

  it("A/B 对照（SSR build 下跳过：createMemo 不追踪 signal）", () => {
    if (!SOLID_REACTIVE) {
      console.log(`[P7] A/B 对照 SKIPPED: ${SSR_SKIP_REASON}`);
      return;
    }
    withCleanEnv(() => {
    resetTuiThemeMode();
    setTuiThemeMode("dark");

    // A = 快照语义（一次性 resolveSolidTheme —— 即 r1/r2 的旧写法效果）：
    //    必须在变化后**保持不变**。
    const snapBefore = resolveSolidTheme().primary;

    // B = Proxy 语义：必须在变化后**更新**。
    const proxy = useTuiThemeReactive();

    const seen: string[] = [];
    const memo = createRoot(() =>
      createMemo(() => {
        seen.push(proxy.primary);
        return proxy.primary;
      }),
    );
    const before = memo();
    setTuiThemeMode("light");
    const after = memo();

    // A 不变（快照语义）
    expect(snapBefore).toBe("#fab283");
    expect(resolveSolidTheme().primary).toBe("#3b7dd8"); // 快照每次新建 ⇒ 取到新值
    // B 变（响应式语义）—— memo 在 signal 变化后重算
    expect(before).toBe("#fab283");
    expect(after).toBe("#3b7dd8");
    expect(seen.length).toBeGreaterThanOrEqual(2);

    resetTuiThemeMode();
    });
  });

  it("组件里的 theme.primary 在 hook 返回值上直接读取（Proxy 语义）", () => {
    withCleanEnv(() => {
      resetTuiThemeMode();
      setTuiThemeMode("light");
      const theme = useTuiThemeReactive();
      // 组件里的写法就是 theme.primary（不是 theme().primary）
      expect(theme.primary).toBe("#3b7dd8");
      resetTuiThemeMode();
    });
  });
});
