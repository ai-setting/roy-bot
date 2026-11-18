/**
 * Shared CLI helper for the `--server-url` option (eventsource commands).
 *
 * 目的：消除 eventsource add/update 命令里重复的 --server-url 定义 +
 * scheme 校验 + 末尾 / trim 逻辑。
 *
 * 行为约定：
 * - `addServerUrlOption(yargs)` — 给 yargs 加 `--server-url/-s` 选项，
 *   同时注册 `--im-server-url` 作为向后兼容 alias（保留旧用法）
 * - `resolveServerUrl(serverUrl, fallback)` —
 *   1. serverUrl 为空 → 返回 fallback
 *   2. 否则 trim 末尾 / 后返回
 *   3. 若 trim 后不以 http:// / https:// / ws:// / wss:// 开头 →
 *      console.error + process.exit(1)
 *
 * 设计要点：
 * - alias 用 `s` 而非 `u`（`u` 被 `--url` 占用，`e` 被 `--event-types` 占用，
 *   `i` 被 `--interval` 占用）
 * - 同时注册 `--im-server-url` 为独立 option（而非 yargs alias 关键字），
 *   避免 yargs 把两个 option 收集成数组
 * - 优先级：`--server-url` > `BOUNTY_SERVER_URL` env > `http://localhost:8787` (fallback)
 *   注：env 解析由调用方完成，helper 只接受一个 string 值
 *
 * Phase: feat/eventsource-server-url (Task #1724)
 */

import type { Argv } from "yargs";
import chalk from "chalk";

/**
 * 给 yargs 实例添加 `--server-url / -s` 选项 + `--im-server-url` 向后兼容 alias。
 *
 * 典型用法：
 *   builder: (y) =>
 *     addServerUrlOption(
 *       y.option('address', { type: 'string' })
 *     )
 *
 * 同时提供两个 long 选项而不是用 yargs alias 关键字，因为：
 * - yargs alias 会让两个 key 都指向同一个值数组，对 type=string 不友好
 * - 用户可能想用不同的名字传不同的概念（虽然这里语义相同，但行为可预测）
 */
export function addServerUrlOption<T extends object>(yargs: Argv<T>): Argv<T> {
  return yargs
    .option("server-url", {
      alias: "s",
      type: "string",
      description:
        "Service base URL (e.g., http://localhost:8787, ws://localhost:4005/ws, " +
        "or https://bounty.example.com). When set, overrides BOUNTY_SERVER_URL env var " +
        "and default. Must start with http://, https://, ws://, or wss://. " +
        "Trailing slashes are auto-trimmed.",
    })
    .option("im-server-url", {
      type: "string",
      description:
        "[Deprecated alias for --server-url] IM Server WebSocket URL " +
        "(bounty-im type). Prefer --server-url / -s for new code.",
    }) as Argv<T>;
}

/**
 * 解析 --server-url 值，返回可用于连接 server 的 base URL。
 *
 * @param serverUrl CLI 传入的 --server-url 值（可能 undefined、空串、合法 URL、非 scheme 字符串）
 * @param fallback  默认值（通常由调用方解析 BOUNTY_SERVER_URL env 后传入）
 * @returns         可直接使用的 base URL（无尾 /）
 *
 * 副作用：当 serverUrl 存在但无效（非 http/https/ws/wss 开头）时，
 * console.error + process.exit(1)。
 *
 * 返回值保证：要么是符合 scheme 的 trimmed base URL，要么是 fallback。
 */
export function resolveServerUrl(
  serverUrl: string | undefined,
  fallback: string,
): string {
  if (!serverUrl) return fallback;
  const trimmed = serverUrl.replace(/\/+$/, "");
  // 同时接受 http/https (REST API) + ws/wss (IM WebSocket)
  if (!/^(https?|wss?):\/\//.test(trimmed)) {
    console.error(
      chalk.red(
        `\n✗ Invalid --server-url: "${serverUrl}". Must start with http://, https://, ws://, or wss://\n`,
      ),
    );
    process.exit(1);
  }
  return trimmed;
}