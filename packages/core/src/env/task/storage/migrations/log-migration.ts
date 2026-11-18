/**
 * @fileoverview Migration logging helper.
 *
 * Task #4619 — the task migrations used to print with `console.log`, which
 * is **stdout**.
 *
 * That is fatal for a stdio MCP server: the MCP stdio transport is
 * newline-delimited JSON-RPC on stdout, and one stray non-JSON line makes
 * the client drop the server (Claude Code reports
 * `mcp_servers: [{"name":"plugin:roy-task:roy-task","status":"failed"}]`).
 *
 * Measured: the plugin's MCP server emitted **24 of 26 stdout lines** that
 * were not JSON — 5 migration banners plus core's `[INFO]` trace lines.
 *
 * ## Task #4721 — 为什么不写 stderr（而是走 logger）
 *
 * #4619 把 stdout 换成 stderr，问题在 **TUI 场景**（`roy-bot interactive`）
 * 暴露了：stderr **同样**是终端输出，而 opentui 只拦截 stdout
 * （`@opentui/core` 的 `interceptStdoutWrite`），stderr 完全不捕获 ⇒ 迁移
 * 日志直接落到终端当前光标位置。
 *
 * `roy-bot interactive` 是 split-footer 模式 ⇒ 当前光标在**动态区**里 ⇒
 * 日志与 TUI 重绘**逐字符交错** ⇒ 用户看到底部乱流（截图实证）：
 *
 * ```
 * └ig-ati-n 003─ -tarting mig-ati─
 * ⋮ Generating response…e_type already exists, skipping rename of action_type
 * ```
 *
 * ⇒ **正确做法：走 logger**（core 的统一日志通路）：
 *   - 永远写日志文件（app.log）⇒ 诊断信息不丢
 *   - console 输出受 `isQuietMode()` / `isStdoutStrictMode()` 控制
 *     —— TUI 场景 quiet 模式开启 ⇒ 不写终端；MCP 场景 stdout 严格模式
 *     ⇒ 走 stderr（诊断通道，符合 MCP 惯例）
 *   - **stdout 永远纯净**（MCP JSON-RPC 协议不被破坏）
 */

import { createLogger } from "../../../log-trace/logger";

/**
 * Migration logger.
 *
 * Category `task:migration` ⇒ 可以用 `LOG_LEVEL_TASK:MIGRATION` / 配置
 * `log_trace.logging.levels` 单独调级别（默认级别以下不落盘）。
 */
const migrationLogger = createLogger("task:migration");

/**
 * Print one migration diagnostic.
 *
 * ⚠️ **不要**改回 `process.stderr.write` / `console.log`：
 *   - `console.log` 会破坏 MCP stdio 的 JSON-RPC 协议（#4619）
 *   - `process.stderr.write` 会撞 TUI 的动态区（#4721 底部乱流）
 *
 * 走 logger：写文件 + 受 quiet/stdout-strict 模式控制的 console 输出。
 *
 * ## Task #4721（交叉验证 MAJOR-3）：为什么用 `warn` 而不是 `info`
 *
 * core 的 `Logger.log()` 在**非 quiet**模式下会把日志打到 console：
 *
 * ```ts
 * if (!isQuietMode()) {
 *   if (stdoutStrictMode) { console.error(formatted); }   // ← stderr
 *   else { consoleMethod(formatted); }                     // ← **stdout**（info/warn）
 * }
 * ```
 *
 * ⚠️ `setStdoutStrictMode(true)` 在**生产路径从未被调用**（只��测试里调）⇒
 *   MCP 场景下 `stdoutStrictMode` 恒为 false ⇒ **`info` 级日志会打到 stdout**
 *   ⇒ **破坏 MCP 的 JSON-RPC 协议**（#4619 的问题被重新引入）。
 *
 * ⇒ 用 `warn` 级：非 strict 模式下走 `console.warn`（Bun 的 `console.warn`
 *   写 **stderr**，不会污染 stdout）⇒ stdout 永远纯净 ✔
 *   而 strict 模式下走 `console.error`（stderr）⇒ 同样是诊断通道 ✔
 */
export function logMigration(message: string): void {
  // ⚠️ 用 warn 而不是 info —— 理由见上方注释（MCP stdout 纯净性）。
  migrationLogger.warn(message);
}
