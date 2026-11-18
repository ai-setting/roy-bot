/**
 * @fileoverview Task #5174（用户明令 2026-11-08 11:29）— 企微出站发送器（CLI 主路径）
 *
 * ## 为什么改 CLI
 *
 * 用户明令：「彻底改造下回复出站用 cli 吧，已经验证可以收到消息了，不用 ws 回」。
 * `wecom-cli auth init` 扫码授权已完成（auth show = authorized），CLI 出站实测
 * `success: true`；WS 回帧（`aibot_respond_msg`）保留为 **fallback**。
 *
 * ## CLI 出站的三个硬约束（实测）
 *
 * 1. **msg_type 没有 text** —— 只支持 markdown / image / file / voice / video；
 *    传 `text` 报「存在未知字段'text'」⇒ 统一用 `markdown`。
 * 2. **chat_id 必须是真实 userid**（形如 `wotnB7Wg...`），WS 回调里的
 *    `from.userid`（如 `DongZhaoKun`）会被拒（40073 非法的 chat_id）。
 *    因此需要 `contact users search` 解析 + 内存缓存。
 * 3. 响应是 JSON，成功形如 `{"success": true}`，失败形如
 *    `{"error": {"code": ..., "message": ...}}`。
 *
 * @see Task #5173 操作记录 #40148（实测取证）
 */

import { spawn } from "child_process";
import { getEnvContextOrEmpty } from "../context/env-context";

/** 默认发送硬超时（CLI 正常 < 2s，15s 是充裕余量） */
export const WECOM_CLI_SEND_TIMEOUT_MS = 15_000;

/** contact 解析硬超时 */
export const WECOM_CLI_RESOLVE_TIMEOUT_MS = 15_000;

/**
 * Task #5659：从当前 ALS EnvContext 读取 toolEnv。
 *
 * EnvContext 不存在（CLI 直跑 / 无事件上下文）时返回 {}，
 * 行为与旧版一致。
 */
export function getToolEnvFromContext(): Record<string, string> {
  return getEnvContextOrEmpty().toolEnv ?? {};
}

/**
 * 解析 wecom-cli 可执行文件路径。
 *
 * 优先级：`WECOM_CLI_BIN` 环境变量 → `wecom-cli`（PATH）。
 * 本机 CLI 是 npm 装的平台子包，未在 PATH 里时必须用 env 指定。
 *
 * ## ⚠️ 隔离 HOME 部署必读（Task #5174 实测）
 *
 * CLI 授权凭据在 `$HOME/.config/wecom/credentials.enc`。若 roy-bot 跑在
 * 隔离 HOME（测试 / 多租户）下，**只拷 credentials.enc 无效** ——
 * `auth show` 仍会报 unauthorized。
 *
 * CLI 支持 `WECOM_CLI_CONFIG_DIR` 覆盖配置目录，部署时设置它指向
 * **已授权**的配置目录即可（本机示例：`~/.config/wecom`）。
 * ★ Task #5659：该变量现可经 ES 配置 `toolEnv` 注入 —— handleEvent
 * 写进 EnvContext.toolEnv，本模块 spawn 时自动合并，无需进程级 env。
 */
export function resolveWecomCliBinary(): string {
  const fromEnv = process.env.WECOM_CLI_BIN;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return "wecom-cli";
}

/** 构造 `message aibot send` 的 argv（不含二进制名） */
export function buildWecomCliSendArgs(input: {
  chatId: string;
  content: string;
}): string[] {
  return [
    "message",
    "aibot",
    "send",
    "--chat-id",
    input.chatId,
    "--msg-type",
    "markdown",
    "--markdown",
    JSON.stringify({ content: input.content }),
  ];
}

/** 构造 `contact users search` 的 argv（用于把 WS userid 解析成 CLI chat_id） */
export function buildWecomCliResolveArgs(keywords: string): string[] {
  return ["contact", "users", "search", "--set", `keywords=${keywords}`];
}

/**
 * 解析 CLI 输出（stdout 是 JSON）。
 *
 * - `{"error": {...}}` → 失败（读 error.code / error.message）
 * - `{"success": true}` → 成功
 * - 无法 parse → 失败（把原文片段带出来便于排查）
 */
export function parseWecomCliResult(
  stdout: string,
): { ok: true } | { ok: false; error: string } {
  const text = (stdout ?? "").trim();
  if (!text) return { ok: false, error: "empty stdout" };
  // CLI 可能先打一行 `[wecom] json repair: ...` 之类的噪声，取第一个 `{` 开始
  const start = text.indexOf("{");
  const jsonText = start >= 0 ? text.slice(start) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: `non-JSON stdout: ${text.slice(0, 200)}` };
  }
  const obj = parsed as {
    error?: { code?: number | string; message?: string; type?: string };
    success?: boolean;
  };
  if (obj?.error) {
    const code = obj.error.code ?? "?";
    const message = obj.error.message ?? obj.error.type ?? "unknown error";
    return { ok: false, error: `[code=${code}] ${message}` };
  }
  if (obj?.success === true) return { ok: true };
  // 没有 error 也没显式 success：企微成功响应带 security_notice 等字段，视为成功
  return { ok: true };
}

/** 从 contact search 输出解析真实 userid */
export function parseWecomCliUserSearch(
  stdout: string,
  fallback: string,
): string {
  const text = (stdout ?? "").trim();
  const start = text.indexOf("{");
  if (start < 0) return fallback;
  try {
    const parsed = JSON.parse(text.slice(start)) as {
      users?: Array<{ userid?: string }>;
    };
    const userid = parsed?.users?.[0]?.userid;
    return typeof userid === "string" && userid.length > 0 ? userid : fallback;
  } catch {
    return fallback;
  }
}

/** 执行一次 CLI 调用并收集 stdout（带硬超时，永不挂住） */
function runCli(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(resolveWecomCliBinary(), args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // ★ Task #5659：合并 EnvContext.toolEnv（ES config 注入，
        //   解决 #5654 跨组织泄漏 —— 不同 bot 凭据目录隔离）。
        env: { ...process.env, ...getToolEnvFromContext() },
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        code: null,
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
      finish(null);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", (err: Error) => {
      stderr += err.message;
      finish(null);
    });
    proc.on("close", (code: number | null) => finish(code));
  });
}

/** WS userid → CLI chat_id 的内存缓存（一次进程生命周期内有效） */
const cliChatIdCache = new Map<string, string>();

/** 测试用：清空解析缓存 */
export function __resetWecomCliChatIdCacheForTest(): void {
  cliChatIdCache.clear();
}

/**
 * 把 WS 回调里的 userid 解析成 CLI 可用的 chat_id。
 *
 * 已有缓存 → 直接返回；否则 `contact users search --set keywords=<userid>`
 * 取 `users[0].userid`；解析失败返回原值（让 CLI 自己报 40073，便于排障）。
 */
export async function resolveWecomCliChatId(userId: string): Promise<string> {
  const key = userId.trim();
  if (!key) return key;
  const cached = cliChatIdCache.get(key);
  if (cached) return cached;
  const { stdout } = await runCli(
    buildWecomCliResolveArgs(key),
    WECOM_CLI_RESOLVE_TIMEOUT_MS,
  );
  const resolved = parseWecomCliUserSearch(stdout, key);
  if (resolved !== key) cliChatIdCache.set(key, resolved);
  return resolved;
}

/**
 * 用 CLI 发 markdown 消息（**永不抛**）。
 *
 * @returns `{ok:true}` / `{ok:false, error}`；调用方据此决定是否走 WS fallback
 */
export async function sendWecomCliMarkdown(input: {
  chatId: string;
  content: string;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const content = input.content ?? "";
  if (!input.chatId || content.trim().length === 0) {
    return { ok: false, error: "empty chatId or content" };
  }
  const { stdout, stderr, code } = await runCli(
    buildWecomCliSendArgs({ chatId: input.chatId, content }),
    input.timeoutMs ?? WECOM_CLI_SEND_TIMEOUT_MS,
  );
  const parsed = parseWecomCliResult(stdout);
  if (parsed.ok) return parsed;
  const detail = stderr.trim()
    ? `${parsed.error} | stderr: ${stderr.trim().slice(0, 200)}`
    : parsed.error;
  return { ok: false, error: `${detail} (exit=${code ?? "null"})` };
}
