/**
 * @fileoverview Task #5109 P7 —— `/theme` 运行时切换（TDD RED 先行）。
 *
 * ## 背景
 *
 * P5（Task #5086）的 `resolveSolidTheme(env)` 是**启动前**按环境变量解析：
 *   - `NO_COLOR` 真值 / `TERM=dumb` ⇒ NO_COLOR 主题；
 *   - `ROY_TUI_THEME=light` ⇒ light；
 *   - 其余 ⇒ dark。
 *
 * P7 要求：**运行中** `/theme` 切 dark/light，全 UI 色变（不换进程、不重挂组件）。
 *
 * ## 设计
 *
 * 新增**运行时 mode 状态**（模块级，可被子组件观察）：
 *   - `setTuiThemeMode(mode)` —— 显式设置（dark/light）；null = 恢复 env 初始值。
 *   - `getTuiThemeMode()` —— 读当前运行时 mode（未设置时返回 env 解析值）。
 *   - `resetTuiThemeMode()` —— 回到 env 初始值。
 *
 * `resolveSolidTheme()` 改为：**运行时 mode 优先，env 仅作初始值**。
 * NO_COLOR / TERM=dumb 的降级仍然优先于一切（环境级硬降级，不接受运行时覆盖）。
 */

import { describe, expect, it } from "bun:test";
import {
  getTuiThemeMode,
  resetTuiThemeMode,
  resolveSolidTheme,
  setTuiThemeMode,
  useTuiThemeReactive,
} from "./theme.js";

describe("tui-solid P7 theme — 运行时 mode 切换", () => {
  it("默认读 env（ROY_TUI_THEME=light）", () => {
    resetTuiThemeMode();
    const mode = getTuiThemeMode({ ROY_TUI_THEME: "light" } as NodeJS.ProcessEnv);
    expect(mode).toBe("light");
  });

  it("默认 dark（无 env）", () => {
    resetTuiThemeMode();
    expect(getTuiThemeMode({} as NodeJS.ProcessEnv)).toBe("dark");
  });

  it("setTuiThemeMode 覆盖 env", () => {
    resetTuiThemeMode();
    setTuiThemeMode("light");
    expect(getTuiThemeMode({} as NodeJS.ProcessEnv)).toBe("light");
    resetTuiThemeMode();
  });

  it("resetTuiThemeMode 回到 env", () => {
    resetTuiThemeMode();
    setTuiThemeMode("light");
    resetTuiThemeMode();
    expect(getTuiThemeMode({} as NodeJS.ProcessEnv)).toBe("dark");
  });

  it("resolveSolidTheme 使用运行时 mode", () => {
    resetTuiThemeMode();
    setTuiThemeMode("light");
    const theme = resolveSolidTheme({} as NodeJS.ProcessEnv);
    expect(theme.mode).toBe("light");
    expect(theme.primary).toBe("#3b7dd8");
    resetTuiThemeMode();
  });

  it("resolveSolidTheme 切回 dark", () => {
    resetTuiThemeMode();
    setTuiThemeMode("dark");
    const theme = resolveSolidTheme({} as NodeJS.ProcessEnv);
    expect(theme.mode).toBe("dark");
    expect(theme.primary).toBe("#fab283");
    resetTuiThemeMode();
  });

  it("useTuiThemeReactive 在切换后返回新主题", () => {
    resetTuiThemeMode();
    setTuiThemeMode("dark");
    const theme = useTuiThemeReactive();
    expect(theme.mode).toBe("dark");
    setTuiThemeMode("light");
    // Proxy：每次属性访问实时取值 ⇒ 切换后立即反映新主题。
    expect(theme.mode).toBe("light");
    expect(theme.primary).toBe("#3b7dd8");
    resetTuiThemeMode();
  });

  it("useTuiThemeReactive 的属性访问在 signal 变化后重新求值", () => {
    resetTuiThemeMode();
    setTuiThemeMode("dark");
    const theme = useTuiThemeReactive();
    const before = theme.primary;
    setTuiThemeMode("light");
    const after = theme.primary;
    expect(before).toBe("#fab283");
    expect(after).toBe("#3b7dd8");
    resetTuiThemeMode();
  });

  it("NO_COLOR 环境优先于运行时 mode", () => {
    resetTuiThemeMode();
    setTuiThemeMode("light");
    const theme = resolveSolidTheme({ NO_COLOR: "1" } as NodeJS.ProcessEnv);
    expect(theme.mode).toBe("noColor");
    expect(theme.primary).toBe("");
    resetTuiThemeMode();
  });

  it("TERM=dumb 环境优先于运行时 mode", () => {
    resetTuiThemeMode();
    setTuiThemeMode("light");
    const theme = resolveSolidTheme({ TERM: "dumb" } as NodeJS.ProcessEnv);
    expect(theme.mode).toBe("noColor");
    resetTuiThemeMode();
  });
});
