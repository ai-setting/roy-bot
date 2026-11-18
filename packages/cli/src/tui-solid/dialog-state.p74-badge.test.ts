/**
 * @fileoverview Task #5138 P7.4 —— /model 弹窗「当前全局 default」badge 测试。
 *
 * ⚠️ DS review r2 MINOR-2/MINOR-3 修订：初版此文件名为「弹窗打开后 items
 * 含 current badge」，但实际断言的是 readModelsFromConfig 的字段（绕开了
 * UI），测试名实不符 + 含死代码（currentHome/realOs/void）。
 *
 * 本版：badge 文案判定已抽为**纯函数** `modelDialogBadge`
 * （dialog-state.ts）⇒ 直接单测其优先级语义：
 *   current（全局 default）> provider default > 无 badge。
 * UI 侧的真终端证据见 scripts/tui-solid/capture-4954/capture-xterm-p74.py
 * 与 /tmp/tui-p74/02-model-dialog.png。
 */

import { describe, expect, it } from "bun:test";
import { modelDialogBadge } from "./dialog-state.js";

describe("dialog-state — modelDialogBadge (P7.4 bug3 弹窗高亮)", () => {
  it("marks the current global default with 'current'", () => {
    expect(modelDialogBadge({ isCurrentDefault: true })).toBe("current");
  });

  it("falls back to 'provider default' when only the provider default matches", () => {
    expect(modelDialogBadge({ isProviderDefault: true })).toBe("provider default");
  });

  it("prefers 'current' when both flags are set", () => {
    expect(
      modelDialogBadge({ isCurrentDefault: true, isProviderDefault: true }),
    ).toBe("current");
  });

  it("returns undefined when neither flag is set", () => {
    expect(modelDialogBadge({})).toBeUndefined();
    expect(modelDialogBadge({ isCurrentDefault: false, isProviderDefault: false })).toBeUndefined();
  });
});
