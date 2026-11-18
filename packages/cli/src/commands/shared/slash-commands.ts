/**
 * @fileoverview slash-commands — REPL 多模态 slash command 解析
 *
 * 支持：
 * - /attach <path>    加入 attach 列表（路径/URL/data:base64）
 * - /list              查看当前 session attach 列表
 * - /clear             清空 attach 列表（不影响 console clear / 其他用途）
 * - /paste             从剪贴板读图加入 attach 列表
 *
 * 设计取舍：
 * - 大小写不敏感（命令部分）
 * - path 接受任意字符串，包括空格（不解析引号）
 * - 返回 null 表示非 slash command，让 caller 走普通消息路径
 */

export type SlashCommandType = "attach" | "list" | "clear" | "paste";

export type SlashCommand =
  | { type: "attach"; path: string }
  | { type: "list" }
  | { type: "clear" }
  | { type: "paste" };

/**
 * 解析用户输入为 slash command
 *
 * @param input 用户原始输入（已 trim 空白）
 * @returns SlashCommand 对象，如果不是 slash command 返回 null
 */
export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  // 拆第一个 token 作为命令,余下作为 args
  const spaceIdx = trimmed.indexOf(" ");
  const cmdRaw = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const argsRaw = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (cmdRaw) {
    case "/attach":
      return { type: "attach", path: argsRaw };
    case "/list":
      return { type: "list" };
    case "/clear":
      return { type: "clear" };
    case "/paste":
      return { type: "paste" };
    default:
      return null;
  }
}
