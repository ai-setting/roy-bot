/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5086 P5 RED —— theme token 集 + dark/light 切换。
 *
 * 本文件刻意**先写失败**：在 GREEN 实现落地之前，`tui-solid/theme.ts`
 * 只导出 `getTheme`（Ink 时代的 11 字段），`useTuiTheme` 与 `TUI_TOKENS`
 * 还不存在 ⇒ import 即抛 `SyntaxError: Export named '...' not found`。
 *
 * 落地契约（GREEN 时必须满足）：
 *   1. `TUI_TOKENS` 导出 15 个 token 名（13 必选 + info + backgroundElement）。
 *   2. `useTuiTheme(mode)` 返回 `TuiSolidTheme`（每个 token 一个 hex 色值，
 *      外加 `user/assistant/tool` 语义兼容层与 `borderUser`）。
 *   3. dark 主题逐值对齐 opencode.json（/tmp/opencode-src/packages/tui/
 *      src/theme/assets/opencode.json）：
 *        primary #fab283, secondary #5c9cf5, accent #9d7cd8,
 *        error #e06c75, warning #f5a742, success #7fd88f, info #56b6c2,
 *        text #eeeeee, textMuted #808080,
 *        background #0a0a0a, backgroundPanel #141414, backgroundElement #1e1e1e,
 *        border #484848, borderActive #606060, borderSubtle #3c3c3c.
 *   4. light 主题同形状，逐值对齐 opencode.json 的 light 列。
 *   5. `NO_COLOR` 降级保留：`getNoColorTheme()` 全部 token = ""。
 *   6. 换主题 ⇒ 全 UI 色变：dark.primary ≠ light.primary（≠ ""/undefined）。
 *   7. 兼容层：`theme.user` 仍存在且非空（RoleLabel/StatusBar 消费）。
 */

import { describe, expect, it } from "bun:test";
import { TUI_TOKENS, useTuiTheme, getNoColorTheme } from "./theme.js";

describe("P5 theme token 集（RED）", () => {
  it("TUI_TOKENS 含 13 个 P5 必选 token", () => {
    const required = [
      "primary",
      "secondary",
      "accent",
      "error",
      "warning",
      "success",
      "text",
      "textMuted",
      "background",
      "backgroundPanel",
      "backgroundElement",
      "border",
      "borderActive",
      "borderSubtle",
    ] as const;
    for (const k of required) {
      expect(TUI_TOKENS).toContain(k);
    }
  });

  it("dark 主题逐值对齐 opencode.json", () => {
    const t = useTuiTheme("dark");
    expect(t.primary).toBe("#fab283");
    expect(t.secondary).toBe("#5c9cf5");
    expect(t.accent).toBe("#9d7cd8");
    expect(t.error).toBe("#e06c75");
    expect(t.warning).toBe("#f5a742");
    expect(t.success).toBe("#7fd88f");
    expect(t.info).toBe("#56b6c2");
    expect(t.text).toBe("#eeeeee");
    expect(t.textMuted).toBe("#808080");
    expect(t.background).toBe("#0a0a0a");
    expect(t.backgroundPanel).toBe("#141414");
    expect(t.backgroundElement).toBe("#1e1e1e");
    expect(t.border).toBe("#484848");
    expect(t.borderActive).toBe("#606060");
    expect(t.borderSubtle).toBe("#3c3c3c");
  });

  it("light 主题同形状且 ≠ dark（换主题全 UI 色变）", () => {
    const d = useTuiTheme("dark");
    const l = useTuiTheme("light");
    for (const k of TUI_TOKENS) {
      expect(typeof l[k]).toBe("string");
      expect(l[k]).toMatch(/^#[0-9a-f]{6}$/);
      expect(l[k]).not.toBe(d[k]);
    }
    // 抽查 light 关键值对齐 opencode.json light 列
    expect(l.background).toBe("#ffffff");
    expect(l.text).toBe("#1a1a1a");
    expect(l.secondary).toBe("#7b5bb6");
    expect(l.accent).toBe("#d68c27");
    expect(l.primary).toBe("#3b7dd8");
  });

  it("NO_COLOR 降级：所有 token = 空字符串", () => {
    const t = getNoColorTheme();
    for (const k of TUI_TOKENS) {
      expect(t[k]).toBe("");
    }
    // 语义兼容层同样降级
    expect(t.user).toBe("");
    expect(t.assistant).toBe("");
    expect(t.tool).toBe("");
    expect(t.borderUser).toBe("");
  });

  it("语义兼容层：user/assistant/tool 仍暴露（RoleLabel/StatusBar 消费）", () => {
    const t = useTuiTheme("dark");
    expect(t.user).toBe(t.secondary);
    expect(t.assistant).toBe(t.primary);
    expect(t.tool).toBe(t.warning);
    expect(t.borderUser).toBe(t.secondary);
    expect(t.muted).toBe(t.textMuted);
  });
});
