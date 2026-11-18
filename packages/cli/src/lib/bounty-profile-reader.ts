/**
 * @fileoverview Bounty Profile Reader
 *
 * 读取 bounty CLI 的 profile 配置（v0.13.0+ 引入，对齐 `~/.config/bounty/profiles/<name>.json`）
 *
 * 用法：
 * ```ts
 * const profile = readBountyProfile("testuser");
 * // profile = { email: "alice@...", agent_id: "uuid", api_base: "http://localhost:4005" }
 *
 * const wsUrl = profileToWsUrl(profile.api_base);
 * // wsUrl = "ws://localhost:4005/ws"
 * ```
 *
 * 设计要点：
 * - 文件路径硬编码为 `~/.config/bounty/profiles/<name>.json`（对齐 bounty CLI v0.13 实际写入路径）
 * - 不存在的 profile 返回 null（不抛错，由调用方决定如何处理）
 * - 字段缺失时静默返回 undefined（容错优先于强校验 — profile 文件可能是人工编辑的）
 * - profileToWsUrl 处理 scheme swap (http → ws) + 自动补 /ws path
 *
 * Phase: v0.13 bounty profile integration (Task #2110)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Bounty profile schema (v0.13.0+)
 *
 * 与 ai-agent-bounty `src/cli/types.ts#BountyProfile` 对齐：
 * - email: 注册邮箱（v0.13+ agent identity）
 * - agent_id: 历史 UUID（兼容字段，handler 可选使用）
 * - api_base: HTTP API base URL（用于 com send 等 REST 命令）
 */
export interface BountyProfile {
  email: string;
  agent_id: string;
  api_base: string;
}

/**
 * 读 bounty profile 文件，返回 profile 对象或 null（文件不存在时）。
 *
 * @param name - profile 名称（如 `testuser`）
 * @param profilesDir - 可选：自定义 profiles 目录（测试用）。默认 `~/.config/bounty/profiles/`
 * @returns 完整 profile；文件不存在 → null；文件存在但字段缺失 → 返回 undefined 字段
 */
export function readBountyProfile(
  name: string,
  profilesDir?: string,
): BountyProfile | null {
  if (!name) return null;
  const dir = profilesDir ?? join(homedir(), ".config", "bounty", "profiles");
  const profilePath = join(dir, `${name}.json`);
  if (!existsSync(profilePath)) return null;
  try {
    const raw = readFileSync(profilePath, "utf-8");
    const data = JSON.parse(raw) as Partial<BountyProfile>;
    return {
      email: typeof data.email === "string" ? data.email : (undefined as unknown as string),
      agent_id: typeof data.agent_id === "string" ? data.agent_id : (undefined as unknown as string),
      api_base: typeof data.api_base === "string" ? data.api_base : (undefined as unknown as string),
    };
  } catch {
    // JSON 解析失败 → 返回 null（调用方决定如何处理）
    return null;
  }
}

/**
 * 将 profile.api_base (http://host:port) 转换为 bounty-im WebSocket URL。
 *
 * - http://  → ws://
 * - https:// → wss://
 * - 自动补 /ws path（对齐 ai-agent-bounty server 的 WS 路由）
 * - 已有 ws:// / wss:// scheme 直接返回（idempotent）
 * - 自动 trim 末尾 /
 *
 * @example
 * profileToWsUrl("http://localhost:4005")  // "ws://localhost:4005/ws"
 * profileToWsUrl("https://bounty.example.com/")  // "wss://bounty.example.com/ws"
 */
export function profileToWsUrl(apiBase: string): string {
  let url = apiBase.replace(/\/+$/, "");
  // Idempotent: 已经是 ws/wss scheme 不变
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    // 如果已有 /ws 路径就不重复加
    if (url.endsWith("/ws")) return url;
    return `${url}/ws`;
  }
  // http/https → ws/wss
  if (url.startsWith("https://")) {
    url = "wss://" + url.slice("https://".length);
  } else if (url.startsWith("http://")) {
    url = "ws://" + url.slice("http://".length);
  }
  // 补 /ws path
  if (!url.endsWith("/ws")) {
    url = `${url}/ws`;
  }
  return url;
}
