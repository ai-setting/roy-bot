/**
 * @fileoverview Task #4954 P0 — 全屏 renderer options（**纯函数**，无 JSX）。
 *
 * ## 为什么抽成纯函数
 *
 * 1. `commands/interactive.ts` 的 renderer options 是 P0 的**唯二改动点**
 *    之一（另一个是 RunScreen 历史承载），抽出来可以**独立测**
 *    （对齐 scrollback-replay.ts 的纯函数模式）。
 * 2. opentui 的 `resolveModes` 有两条**强校验**（chunk-node-2rg7pskw.js）：
 *    - `externalOutputMode:"capture-stdout" requires screenMode:"split-footer"`
 *      （否则 throw）
 *    - `writeToScrollback` 同样强校验（切 alt-screen 后**绝不能再调**）
 *    ⇒ 这两个 option 的配对关系是 P0 的灵魂，值得一个模块锁死。
 *
 * @see docs/task-4954-interactive-tui-opencode-alignment-plan.md §4-P0 / §3A.7
 */

export interface FullscreenRendererOptions {
  screenMode: "alternate-screen";
  externalOutputMode: "passthrough";
  exitOnCtrlC: boolean;
  useMouse: boolean;
  autoFocus: boolean;
  clearOnShutdown: boolean;
  openConsoleOnError: boolean;
  /** 全屏 flex 布局下无固定 footer —— 输入框由 flexShrink=0 沉底。 */
  footerHeight?: undefined;
}

/**
 * 全屏（alternate-screen）模式的 renderer options。
 *
 * 对照旧 split-footer 配置（interactive.ts 旧版）：
 *   screenMode:"split-footer" + footerHeight:12 +
 *   externalOutputMode:"capture-stdout" + clearOnShutdown:false
 */
export function resolveFullscreenRendererOptions(): FullscreenRendererOptions {
  return {
    screenMode: "alternate-screen",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    useMouse: true,
    autoFocus: false,
    openConsoleOnError: false,
    // alt-screen 退出时应清屏恢复主屏（split-footer 时代为保留
    // 滚动缓冲而设 false；alt-screen 的滚动缓冲本来就不属于本屏）。
    clearOnShutdown: true,
  };
}
