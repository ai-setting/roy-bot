/**
 * solid-jsx-preload.ts — bunfig preload 入口（Task #4278 片1 地基；片2 修正）。
 *
 * ## 片2 修正（关键 bug 修复）
 *
 * 片1 认为「solid-js server→client runtime 重定向」可用。**片2 实测推翻**：
 *
 *   - bun 的 runtime plugin (`Bun.plugin`) 的 `onLoad`/`onResolve` filter
 *     **对 `node_modules` 下的文件不会触发**（实测打日志 0 命中）。
 *     所以片1 里给 `solid-js/dist/server.js` 注册的重定向**从未生效**。
 *   - `solid-js` 的 `exports["."]` 里 `node`/`worker`/`deno` 条件都指向
 *     `dist/server.js`（SSR 构建）；bun 默认走 `node` 条件，于是
 *     `solid-js` → **server 构建**，而 `@opentui/solid/index.bun.js`
 *     也 `from "solid-js"`（同一 server 构建）—— 两者一致，但**都是 SSR**。
 *   - 后果：`createEffect` 永不 flush、`onMount` 永不执行、`createSignal`
 *     setter 不触发重渲染 → **整个 Solid TUI 完全非响应式**（静态首帧能画，
 *     之后任何时候都不更新）。片1 的「启动截图通过」正是因为只验证了静态首帧。
 *
 * **正确修复**：让 bun 解析 `solid-js` 时使用 `browser` 条件（其 `exports` 指向
 * `dist/solid.js` = 真正的 client 构建）。`browser` 必须写在**最前**才会覆盖
 * `node`。实测两种有效路径：
 *   1. runtime：`BUN_OPTIONS="--conditions=browser"`（或 `bun --conditions=browser`）
 *   2. bundle：`Bun.build({ conditions: ["browser", ...] })`
 * 见 `scripts/build-cli-dev.ts` / `build-cli-prod.ts` / `build-standalone.ts`。
 *
 * ## 本 preload 的职责
 *
 * 仅用于 `bun run <源码>`（dev/调试）。注册官方 Solid 转译插件
 * （`@opentui/solid/preload`），它做两件事：
 *   1. 把 `solid-js` / `solid-js/store` 的 `dist/server.js` 转译为 client 构建
 *   2. 对非 node_modules 的 `*.tsx?` 跑 babel-preset-solid
 *
 * ⚠️ 历史坑（片1 记录，仍然成立）：在 `bun run` 下注册**全局 tsx onLoad** 会
 * 干扰 bun 内置 loader，实测把 `interactive-ink-escape-e2e-task-2297` 从 PASS
 * 打成 FAIL。因此这里**保持 opt-in**（`ROY_SOLID_JSX=1`），默认只做 runtime
 * 重定向，保证「run 链路 + 全量测试零影响」。
 *
 * 用法：
 *   # 打包产物（interactive 实际路径）—— 由 build 脚本带 browser 条件，开箱即用
 *   bun packages/cli/dist/bin/roy-bot.js interactive
 *
 *   # 直接跑 tui-solid 源码（调试/单测）
 *   ROY_SOLID_JSX=1 bun run packages/cli/src/tui-solid/<file>.tsx
 */
import { registerSolidRuntimeRedirect, registerScopedSolidTransform } from "./solid-jsx-plugin.ts";

registerSolidRuntimeRedirect();

if (process.env.ROY_SOLID_JSX === "1") {
  registerScopedSolidTransform();
}
