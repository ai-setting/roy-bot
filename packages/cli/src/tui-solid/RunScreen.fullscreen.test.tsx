/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #4954 P0 — **全屏架构切换**（split-footer → alternate-screen）。
 *
 * ## 方案
 * docs/task-4954-interactive-tui-opencode-alignment-plan.md §4-P0：
 *   - renderer `screenMode: "alternate-screen"`（或省略，opentui 默认即 alt-screen）
 *   - `externalOutputMode: "passthrough"`（capture-stdout 与 split-footer 强绑定，
 *     切 alt-screen 必须同改，否则 resolveModes throw）
 *   - 历史承载：writeToScrollback 强校验 split-footer ⇒ 历史改渲染进
 *     scrollbox 树（rows signal），输入框 flex 常驻底部
 *
 * ## 断言策略（结构性，不依赖重绘）
 * - 读 `renderer.screenMode`（公开 getter，renderer.d.ts:453）——
 *   需要从组件里拿到 renderer：用 `mountInteractiveScreen` 的返回路径不可行
 *   （testRender 自建 renderer），改为**直接断言 interactive.ts 的 renderer 配置源码**？
 *   ❌ 不做源码字符串断言（测试纪律）。
 * - ✅ 改为「行为断言」：alt-screen 的关键行为差 = **不向 stdout 输出
 *   `ESC[?1049h` 之外的、混入内容区的外部写入**——这在 unit 环境难测。
 * - ✅ 最终选择：**专项 RED 断言 renderer options 解析**——把 renderer
 *   options 构造抽成纯函数 `resolveFullscreenRendererOptions()`，
 *   测纯函数（对齐 scrollback-replay.ts 的纯函数模式）。
 */

import { describe, expect, it } from "bun:test";
import { resolveFullscreenRendererOptions } from "./fullscreen-options.js";

describe("Task #4954 P0 — fullscreen renderer options", () => {
  it("selects alternate-screen mode", () => {
    const opts = resolveFullscreenRendererOptions();
    expect(opts.screenMode).toBe("alternate-screen");
  });

  it("does NOT use capture-stdout (incompatible with alt-screen)", () => {
    const opts = resolveFullscreenRendererOptions();
    expect(opts.externalOutputMode).not.toBe("capture-stdout");
    expect(opts.externalOutputMode).toBe("passthrough");
  });

  it("keeps mouse enabled and avoids exit-on-ctrl-c", () => {
    const opts = resolveFullscreenRendererOptions();
    expect(opts.useMouse).toBe(true);
    expect(opts.exitOnCtrlC).toBe(false);
  });

  it("does not set a fixed footerHeight (flex layout anchors input instead)", () => {
    const opts = resolveFullscreenRendererOptions();
    expect(opts.footerHeight).toBeUndefined();
  });

  it("clears on shutdown so the alt screen is released cleanly", () => {
    const opts = resolveFullscreenRendererOptions();
    // alternate-screen 退出时清屏 + 恢复主屏（opentui destroy 行为），
    // clearOnShutdown=false 会保留最后一帧 —— 全屏模式下应清掉。
    expect(opts.clearOnShutdown).toBe(true);
  });
});
