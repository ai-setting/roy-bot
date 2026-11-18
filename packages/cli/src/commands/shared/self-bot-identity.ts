/**
 * @fileoverview Task #5459 — 解析「我方 bot 自身身份」，供 self-echo 门禁使用
 *
 * ## 为什么需要这个模块
 *
 * `self-echo-filter.ts` 的判定顺序里，**第 0 步**是
 * `senderId ∈ selfBotIds → 丢弃`。这一步是全套门禁的**地基**：
 *
 * - 它是「自己发出的消息回灌」的唯一识别手段（群聊放行后尤其关键）
 * - 它同时是「A/B 两个 bot 在群里互相 @」的**自循环闸门**：
 *   没有它，群聊里每条 bot 消息都会被当协作入站放行 → 两个 bot 无限回灌
 *
 * 但生产 wiring 历史上**从未注入过 selfBotIds**（恒为 `[]`），于是这一步
 * 形同虚设 —— 这也是本任务必须补上的接线。
 *
 * ## 两种身份，两个来源
 *
 * | 身份 | 形态 | 来源 | 成本 |
 * |---|---|---|---|
 * | `app_id` | `cli_xxx` | `~/.lark-cli/config.json` 的 `apps[].appId` | 本地文件，**同步**、零网络 |
 * | bot `open_id` | `ou_xxx` | `lark-cli api GET /open-apis/bot/v3/info --as bot` | 子进程 + 网络，需缓存 |
 *
 * 两种都要收：
 * - 飞书 `chat-messages-list` 里 bot 消息的 `sender.id` 是 **app_id**
 *   （`id_type=app_id`，另有 `open_bot_id`）
 * - 用户实测日志里 `senderId=ou_7122...` 是 **open_id** 形态
 *
 * 少收一种就会漏判（= 自循环闸门失效），所以两路都解析、合并去重。
 *
 * ## 失败策略
 *
 * - 本地配置读不到 → 只返回 `[]`（**不抛**，由调用方决定降级行为）
 * - `bot/v3/info` 调用失败 → 只返回 app_id（best-effort，warn 不 throw）
 *
 * 绝不因为「解析身份失败」而让事件处理链路崩掉。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** lark-cli 配置文件里与身份相关的结构（只取用到的字段）。 */
interface LarkCliAppEntry {
  name?: string;
  appId?: string;
}

interface LarkCliConfig {
  currentApp?: string;
  apps?: LarkCliAppEntry[];
}

/** 默认 lark-cli 配置路径：`~/.lark-cli/config.json`。 */
export function defaultLarkCliConfigPath(): string {
  return join(homedir(), ".lark-cli", "config.json");
}

/**
 * 从 lark-cli 本地配置里**同步**读出本 profile 的 `app_id`。
 *
 * @param profile profile 名（如 `tongzhuli`）。不传 ⇒ 用 `currentApp`。
 * @param configPath 配置文件路径（测试注入用，默认 `~/.lark-cli/config.json`）
 * @returns `cli_xxx` 或 `undefined`（文件缺失 / JSON 坏 / 找不到该 profile）
 *
 * 纯本地文件读取，**不发网络请求** —— 所以可以在事件处理热路径上安全调用
 * （仍有磁盘 IO，调用方应缓存）。
 */
export function readSelfAppIdFromLarkConfig(
  profile?: string,
  configPath: string = defaultLarkCliConfigPath(),
): string | undefined {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as LarkCliConfig;
    const apps = Array.isArray(config.apps) ? config.apps : [];
    const target = profile ?? config.currentApp;
    if (!target) return undefined;
    const hit = apps.find((a) => a?.name === target);
    const appId = hit?.appId;
    return typeof appId === "string" && appId.length > 0 ? appId : undefined;
  } catch {
    return undefined;
  }
}

/** `resolveSelfBotIdentities` 的入参。 */
export interface ResolveSelfBotIdentitiesOptions {
  /** lark-cli profile 名（不传 ⇒ 本地配置的 currentApp） */
  profile?: string;
  /** lark-cli 配置路径（测试注入用） */
  configPath?: string;
  /**
   * 是否查询 bot `open_id`（默认 `true`）。
   *
   * 只有 `sender_id` 是 open_id 形态时才需要它；本地纯函数测试可关掉。
   */
  queryBotOpenId?: boolean;
  /** 执行 lark-cli 命令（测试注入用）；返回 stdout */
  execLarkCli?: (args: string[]) => Promise<string>;
}

/** 解析结果（保留两个身份，便于日志区分）。 */
export interface SelfBotIdentities {
  /** `cli_xxx`（本地配置） */
  appId?: string;
  /** `ou_xxx`（bot 自身 open_id，API 查询） */
  botOpenId?: string;
  /** 合并去重后的 id 列表（直接喂给 `isSelfEchoEvent({ selfBotIds })`） */
  ids: string[];
}

/**
 * 默认的 lark-cli 执行器：跑 `lark-cli [--profile p] api GET /open-apis/bot/v3/info --as bot`
 * 并返回 stdout 文本。
 *
 * 用 `Bun.spawn` / 子进程都行 —— 这里用 `node:child_process` 的
 * `execFile`，避免 shell 注入（profile 名虽然可信，也不必拼字符串）。
 */
async function defaultExecLarkCli(args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  return await new Promise<string>((resolve, reject) => {
    execFile(
      "lark-cli",
      args,
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${err.message}${stderr ? ` | ${stderr.slice(0, 200)}` : ""}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// ============================================================================
// 热路径缓存（★ 关键设计：不能每条事件都 spawn lark-cli）
// ============================================================================

/**
 * `profile → bot open_id` 的**进程内缓存**（只存已解析成功的值）。
 *
 * ## 为什么必须有
 *
 * 门禁跑在 `handleEvent` 的**最前面**，每条事件都会问一次「我是谁」。
 * 若每次都 spawn `lark-cli api GET /open-apis/bot/v3/info`（实测 ~1s），
 * 事件处理会被整体拖慢，且违反「门禁必须廉价」的直觉。
 *
 * 实测教训（Task #5459 第一版）：直接 `await` 网络解析导致 7 个既有时序
 * 敏感的测试（`await sleep(120)` 后断言）失败 —— 真实生产同样会让事件
 * 延迟 1s。所以拆成：
 * - **热路径**（`getCachedSelfBotIds`）：纯内存 + 本地小文件，**同步、微秒级**
 * - **预热**（`warmSelfBotIdentities`）：fire-and-forget 起 lark-cli，完成后填缓存
 */
const botOpenIdCache = new Map<string, string>();
const warmInFlight = new Map<string, Promise<void>>();

/** 缓存键：profile 名（`""` 表示「未指定 profile / 用 currentApp」）。 */
function cacheKeyOf(profile?: string): string {
  return profile ?? "";
}

/**
 * **同步**取我方 bot 身份 id 列表（热路径用）。
 *
 * - `app_id`：读本地 `~/.lark-cli/config.json`（微秒级，总能拿到）
 * - `open_id`：只读**已预热**的缓存（未预热 ⇒ 缺失，不会阻塞）
 *
 * 绝不 spawn 子进程、绝不 await —— 可以在事件处理最前面安全调用。
 */
export function getCachedSelfBotIds(
  profile?: string,
  configPath: string = defaultLarkCliConfigPath(),
): string[] {
  const ids: string[] = [];
  const appId = readSelfAppIdFromLarkConfig(profile, configPath);
  if (appId) ids.push(appId);
  const cachedOpenId = botOpenIdCache.get(cacheKeyOf(profile));
  if (cachedOpenId && !ids.includes(cachedOpenId)) ids.push(cachedOpenId);
  return ids;
}

/**
 * **预热**某个 profile 的 bot `open_id`（fire-and-forget，幂等）。
 *
 * 建议在进程启动时（EventHandler.start / factory）对已知 profile 调一次，
 * 这样真正的事件到来时缓存已就绪，门禁能看到完整身份（app_id + open_id）。
 *
 * 并发调用同一 profile 只会触发一次 lark-cli。
 */
export function warmSelfBotIdentities(
  profile?: string,
  options: { configPath?: string; execLarkCli?: (args: string[]) => Promise<string> } = {},
): Promise<void> {
  const key = cacheKeyOf(profile);
  if (botOpenIdCache.has(key)) return Promise.resolve();
  const existing = warmInFlight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const r = await resolveSelfBotIdentities({
        ...(profile ? { profile } : {}),
        ...(options.configPath ? { configPath: options.configPath } : {}),
        ...(options.execLarkCli ? { execLarkCli: options.execLarkCli } : {}),
      });
      if (r.botOpenId) botOpenIdCache.set(key, r.botOpenId);
    } catch {
      // best-effort：预热失败不影响任何功能（只是少一个 id 口径）
    } finally {
      warmInFlight.delete(key);
    }
  })();
  warmInFlight.set(key, p);
  return p;
}

/** 测试专用：清空预热缓存。 */
export function __resetSelfBotIdentityCacheForTest(): void {
  botOpenIdCache.clear();
  warmInFlight.clear();
}

/**
 * 解析我方 bot 的自身身份（`app_id` + `open_id`），合并为 `ids`。
 *
 * 顺序：先本地配置拿 `appId`（同步、必做）；再（可选）查 API 拿 `open_id`。
 * 任何一步失败都只降级、不抛 —— 事件处理链路不能因身份解析失败而中断。
 */
export async function resolveSelfBotIdentities(
  options: ResolveSelfBotIdentitiesOptions = {},
): Promise<SelfBotIdentities> {
  const appId = readSelfAppIdFromLarkConfig(options.profile, options.configPath);

  let botOpenId: string | undefined;
  if (options.queryBotOpenId !== false) {
    const exec = options.execLarkCli ?? defaultExecLarkCli;
    const args = [
      ...(options.profile ? ["--profile", options.profile] : []),
      "api",
      "GET",
      "/open-apis/bot/v3/info",
      "--as",
      "bot",
    ];
    try {
      const stdout = await exec(args);
      const parsed = JSON.parse(stdout) as {
        data?: { open_id?: string; bot?: { open_id?: string } };
      };
      const openId = parsed?.data?.open_id ?? parsed?.data?.bot?.open_id;
      if (typeof openId === "string" && openId.length > 0) botOpenId = openId;
    } catch {
      // best-effort：拿不到 open_id 就只用 app_id（仍能拦 cc_ 口径的自身回声）
    }
  }

  const ids: string[] = [];
  for (const id of [appId, botOpenId]) {
    if (id && !ids.includes(id)) ids.push(id);
  }

  return {
    ...(appId ? { appId } : {}),
    ...(botOpenId ? { botOpenId } : {}),
    ids,
  };
}
