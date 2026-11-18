/**
 * @fileoverview 共享 idempotency-key 派生器（Task #4137 P1）
 *
 * 用途：把"出站消息 idempotency-key 派生"逻辑抽出来，让：
 *     - PerTaskGroupChatPlugin.buildSendToChatArgs
 *     - LarkCliTaskNotifyHook.buildReplyArgs
 *   共用同一份派生规则（hash 来源 / 截断 / 兜底）。
 *
 * 设计：飞书 lark-cli `im +messages-send --idempotency-key <key>` 限制 ≤ 50 字符，
 * 因此派生后必须截断。Bun.hash 默认无依赖，hash 命中率高。
 */

const MAX_KEY_LEN = 50;
const KEY_PREFIX = "roy-";

/**
 * 派生 ≤50 字符的 idempotency-key
 *
 * @param parts - 拼接来源（如 chatId / taskId / type / content 截断 / messageId）
 *               任意 string | number | undefined 都会被 stringify 拼到 source 串
 * @returns ≤ 50 字符的 idempotency-key（"roy-" 前缀）
 */
export function deriveIdempotencyKey(parts: Array<string | number | undefined | null>): string {
  const source = parts
    .filter((p) => p !== undefined && p !== null)
    .map((p) => String(p))
    .join("-");

  let key: string;
  try {
    // Bun 内置 hash，无 import 依赖；fallback 用 sanitize slice
    key = `${KEY_PREFIX}${Bun.hash(source).toString(36).slice(0, 16)}`;
  } catch {
    // Bun.hash 在非 bun runtime 下抛错 → 退化到字符级 sanitize
    key = `${KEY_PREFIX}${source.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 40)}`;
  }
  if (key.length > MAX_KEY_LEN) key = key.slice(0, MAX_KEY_LEN);
  return key;
}