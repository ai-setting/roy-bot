/**
 * @fileoverview Task #5036 — 提示消息里嵌入「跳转到任务卡片」的可点击链接
 *
 * ## 用户诉求（飞书 2026-11-05）
 *
 * > 「这种提示消息（`✅ Task #4954「…」已完成（耗时 1h5m）`）能否利用**持久化的
 * >   卡片消息信息**为每个提示消息嵌入一个链接可以点击跳到对应的卡片消息呢。
 * >   否则还要点开 pin 来找对应的卡片消息。」
 *
 * ## 链接格式（实测结论，非臆测）
 *
 * 飞书**没有**「按 message_id 直接跳消息」的 applink。唯一权威格式来自飞书
 * 自己的 `message_app_link` 字段：
 *
 *     https://applink.feishu.cn/client/chat/open?openChatId=<oc_xxx>&position=<N>
 *
 * - 官方文档 `open.feishu.cn/.../open-a-chat-page` 只列 `openId` / `openChatId`；
 *   `position` 是飞书 Message API 附加的消息序号参数
 * - larksuite/cli 源码 `shortcuts/im/convert_lib/content_convert.go` 的
 *   `assembleMessageAppLink()` 在服务端没给 link 时也是用 `chat_id` +
 *   `message_position` 拼这个 URL（thread 场景换成 `/client/thread/open`）
 * - `position` 可以为 0 或负数（PR #668 明确要求接受）
 *
 * ⚠️ **`position` 拿不到时降级为 chat 级链接**（`?openChatId=<oc>`，官方文档
 *   保证的会话跳转）。比精确跳卡差一点，但**远好于让用户翻 pin**。
 *
 * ## 为什么需要两跳（store → mget）
 *
 * - `im +messages-send` 的返回体只有 `{message_id, chat_id, create_time}`，
 *   **不含 position**（见 send skill "Return Value"）⇒ 发卡时拿不到 position
 * - `im +messages-mget --message-ids om_xxx` 才返回 `message_app_link` 与
 *   `message_position`（实测 ~1.1s，含 CLI 启动）
 *
 * ⇒ 发卡时**不**额外查（不拖慢发卡），只在**发提示消息时**按需解析一次，
 *   并做进程内缓存（同一任务的卡片 position 不会变）。
 *
 * ## 全链路 best-effort
 *
 * 任何一步失败（无记录 / sqlite 打不开 / mget 超时 / JSON 异常）都**只**导致
 * 「这条消息没有链接」，绝不允许影响提示消息本身的送达。
 */

import { spawn } from "node:child_process";

/** 默认 applink 基址（飞书；Lark 国际版租户可传 applink.larksuite.com） */
export const FEISHU_APPLINK_BASE = "https://applink.feishu.cn";

/** 解析 position 的硬超时（mget 实测 ~1.1s，留足 3x 余量） */
const DEFAULT_LOOKUP_TIMEOUT_MS = 3_500;

// ============================================================================
// 纯函数：链接拼装
// ============================================================================

/**
 * 归一化飞书 `message_position`。
 *
 * 飞书 API 的 position 是**字符串**（如 `"127"`），并且 PR #668 明确要求
 * 接受 `0` 与**负数**（`-1` 表示"会话最末"这类语义）⇒ 不能用 `n > 0` 过滤，
 * 只排除 `NaN` / 空串 / 非有限值。
 */
export function normalizeMessagePosition(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.trunc(value)) : undefined;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return undefined;
    if (!/^-?\d+$/.test(t)) return undefined;
    return t;
  }
  return undefined;
}

/**
 * 拼「打开聊天 / 跳到消息」的 applink。
 *
 * @returns 无 chatId（或全空白）时 `undefined` —— 调用方据此降级为"不附链接"
 */
export function buildCardOpenUrl(input: {
  chatId?: string;
  position?: unknown;
  appLinkBase?: string;
}): string | undefined {
  const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
  if (!chatId) return undefined;

  const base = (input.appLinkBase || FEISHU_APPLINK_BASE).replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("openChatId", chatId);

  const position = normalizeMessagePosition(input.position);
  if (position !== undefined) params.set("position", position);

  return `${base}/client/chat/open?${params.toString()}`;
}

/**
 * 渲染「跳卡」那一行的 Markdown 链接。
 *
 * 飞书 `--markdown` 会转成 post 的 `md` 节点，`[text](url)` 在其中是**真可点击**
 * 链接（`md` 节点按 Markdown 渲染）。
 *
 * @returns 无 url 时返回空串（调用方拼行时自然不产出空行）
 */
export function buildCardLinkLine(url?: string): string {
  if (!url) return "";
  return `[📌 查看任务卡片](${url})`;
}

/**
 * 把链接行插进提示文案。
 *
 * 位置：**紧跟标题行之后、帮助句之前** —— 用户一眼看到"在哪看详情"，
 * 而不是滑到最底部才看到。
 *
 * 没有 url ⇒ **原样返回**（零痕迹降级，不会留空行）。
 */
export function appendCardLinkLine(text: string, url?: string): string {
  const line = buildCardLinkLine(url);
  if (!line) return text;

  const idx = text.indexOf("\n");
  if (idx === -1) return `${text}\n${line}`;
  return `${text.slice(0, idx)}\n${line}${text.slice(idx)}`;
}

// ============================================================================
// 纯函数：解析 mget 响应
// ============================================================================

/**
 * 从 `im +messages-mget` 的 JSON 里提取卡片消息的 position。
 *
 * 取值优先级：
 *   1. `message_app_link` 里的 `position` 查询参数（**服务端算好的，最权威**）
 *   2. `message_position` 字段（CLI 从 API 透传）
 *
 * @param raw JSON 字符串或已解析对象；任何异常一律 `undefined`
 */
export function extractMessagePosition(raw: unknown): string | undefined {
  let obj: any = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== "object") return undefined;

  const messages = obj?.data?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const msg = messages[0];
  if (!msg || typeof msg !== "object") return undefined;

  // 1) 服务端 message_app_link 里的 position 最权威
  const link = msg.message_app_link;
  if (typeof link === "string" && link) {
    try {
      const pos = new URL(link).searchParams.get("position");
      const normalized = normalizeMessagePosition(pos);
      if (normalized !== undefined) return normalized;
    } catch {
      // link 非法 → 落到字段兜底
    }
  }

  // 2) 字段兜底
  return normalizeMessagePosition(msg.message_position);
}

// ============================================================================
// 带副作用的解析（mget 子进程 + 缓存）
// ============================================================================

export interface LookupMessagePositionOptions {
  messageId: string;
  profile?: string;
  timeoutMs?: number;
  /**
   * ★ Task #5080：子进程句柄回调（可选）。
   *
   * 内层上界（`resolveCardLinkForTask` 的 `lookupTimeoutMs`，缺省 1200ms）
   * 到点时，调用方可以借此**立刻**杀掉那个还在跑的 `lark-cli` 子进程 ——
   * 否则它要等自己的 3500ms 定时器才退出，白白多挂 ~2.3s 孤儿进程。
   */
  onSpawn?: (proc: { kill: (signal?: NodeJS.Signals) => boolean }) => void;
}

/**
 * 查一条消息在会话里的 position（best-effort，失败返回 `undefined`）。
 *
 * ⚠️ **永不 reject** —— 调用方是提示消息发送链路，绝不允许因为"查不到位置"
 *    把提示消息本身搞丢。
 */
export function lookupMessagePosition(
  options: LookupMessagePositionOptions,
): Promise<string | undefined> {
  const { messageId, profile } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  if (!messageId) return Promise.resolve(undefined);

  const args = ["im", "+messages-mget", "--message-ids", messageId, "--as", "bot"];
  if (profile) args.unshift("--profile", profile);

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("lark-cli", args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(undefined);
      return;
    }

    // ★ Task #5080：把句柄交给调用方，让它能在内层上界到点时立刻回收子进程
    try {
      options.onSpawn?.(proc);
    } catch {
      // 回调异常不影响查询本身
    }

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    // stderr 故意丢弃：本函数是 best-effort，噪音无价值
    proc.stderr?.on("data", () => {});

    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
      finish(undefined);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    proc.on("close", (code: number | null) => {
      finish(code === 0 ? extractMessagePosition(stdout) : undefined);
    });
    proc.on("error", () => finish(undefined));
  });
}

/** 卡片记录的最小形状（只取本模块要用的字段，便于测试注入） */
export interface CardLinkRecord {
  messageId?: string;
  chatId?: string;
  profile?: string;
}

export interface ResolveCardLinkDeps {
  /** 按 taskId 取持久化卡片记录（缺省/返回 undefined ⇒ 降级不附链接） */
  getCardRecord?: (taskId: number) => CardLinkRecord | undefined;
  /** 查 position（缺省走 `lookupMessagePosition`；测试注入假实现） */
  lookupPosition?: (opts: LookupMessagePositionOptions) => Promise<string | undefined>;
  /** 覆盖基址（测试 / Lark 国际版） */
  appLinkBase?: string;
  /**
   * ★ Task #5080：position 查询的**本地**硬超时（毫秒）。
   *
   * 为什么需要（这正是 #5080 的根因）：
   *   `lookupPosition` 内部会 spawn `lark-cli im +messages-mget`。在机器负载高
   *   （实测 load=5.93）时这一跳可以远超预期（生产 span 实测 5664ms），而
   *   `event-handler.ts` 的回执预算只有 2500ms ⇒ 超时即**整条链接都没了**。
   *
   *   现在 position 查询**自带**上界：超时/异常 ⇒ 降级成 **chat 级**链接
   *   （`?openChatId=<oc>`，零 IO、立刻可得），而不是把「没有链接」抛给上层。
   *
   * 缺省 1200ms：略高于实测 ~1.05s 的常态值，留一点余量；又明显低于回执的
   * 2500ms 预算 ⇒ **只要有卡片记录，就一定能带上链接**。
   */
  lookupTimeoutMs?: number;
}

/** ★ Task #5080：position 查询的缺省本地超时（ms）。 */
const DEFAULT_POSITION_LOOKUP_TIMEOUT_MS = 1_200;

/**
 * ★ Task #5080：给 position 查询加**本地**上界。
 *
 * 与 `event-handler.ts` 的回执预算是**两层**独立的兜底：
 *   - 本层：position 查询卡住 ⇒ 降级 chat 级链接（**有链接**）
 *   - 外层：连 chat 级链接都来不及算 ⇒ 放弃（**没链接**）
 *
 * 修复前只有外层，所以「position 慢」被放大成「完全没有链接」。
 *
 * ★ 上界到点时**顺手回收子进程**：`lookupMessagePosition` 自己有 3500ms 的
 *   定时器，不主动 kill 的话会多挂 ~2.3s 孤儿 lark-cli 进程。
 *   （只有默认实现能拿到句柄；测试注入的假 lookup 没有子进程，跳过。）
 */
async function lookupPositionBounded(
  lookup: (opts: LookupMessagePositionOptions) => Promise<string | undefined>,
  opts: LookupMessagePositionOptions,
  timeoutMs: number,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let spawned: { kill: (signal?: NodeJS.Signals) => boolean } | undefined;

  const effectiveOpts: LookupMessagePositionOptions = {
    ...opts,
    onSpawn: (proc) => {
      spawned = proc;
      opts.onSpawn?.(proc);
    },
  };

  try {
    return await Promise.race([
      lookup(effectiveOpts).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    // ★ 上界到点 ⇒ 回收还在跑的子进程（best-effort，失败无所谓）
    if (spawned) {
      try {
        spawned.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  }
}

/**
 * 解析某个 Task 的卡片跳转链接（best-effort，失败返回 `undefined`）。
 *
 * 两跳：
 *   1. 持久层记录 → 立刻得到 **chat 级**链接（零 IO，`?openChatId=<oc>`）
 *   2. 有 messageId → 再查 position 精化成 **消息级**链接；查不到就保留 chat 级
 *
 * ⚠️ **永不 reject**：任何异常都降级为"没有链接"。
 *
 * ★ Task #5080：第 2 跳现在**自带本地超时**（`deps.lookupTimeoutMs`，缺省
 *   1200ms）。查不到 / 超时 / 抛错 ⇒ 一律返回 **chat 级**链接（不是 undefined）。
 *   修复前这里会无限期 `await` lookup，于是一次慢 spawn 会把**本该零成本**
 *   的 chat 级链接拖到外层预算超时 ⇒ 回执彻底没有链接（生产实测 task 5077）。
 */
export async function resolveCardLinkForTask(
  taskId: number,
  deps: ResolveCardLinkDeps = {},
): Promise<string | undefined> {
  if (!Number.isFinite(taskId) || taskId <= 0) return undefined;

  let record: CardLinkRecord | undefined;
  try {
    record = deps.getCardRecord?.(taskId);
  } catch {
    return undefined; // sqlite 故障 → 静默降级
  }
  if (!record?.chatId) return undefined;

  const baseUrl = buildCardOpenUrl({
    chatId: record.chatId,
    appLinkBase: deps.appLinkBase,
  });
  if (!baseUrl) return undefined;
  if (!record.messageId) return baseUrl;

  const lookup = deps.lookupPosition ?? lookupMessagePosition;
  const position = await lookupPositionBounded(
    lookup,
    {
      messageId: record.messageId,
      ...(record.profile ? { profile: record.profile } : {}),
    },
    deps.lookupTimeoutMs ?? DEFAULT_POSITION_LOOKUP_TIMEOUT_MS,
  );

  if (position === undefined) return baseUrl;
  return (
    buildCardOpenUrl({
      chatId: record.chatId,
      position,
      appLinkBase: deps.appLinkBase,
    }) ?? baseUrl
  );
}

// ============================================================================
// 进程内缓存（同一任务卡片的 position 不会变）
// ============================================================================

const cardLinkCache = new Map<number, string>();
/** 缓存上限：超出即整体清空（简单且足够——命中率不是关键指标，避免无界增长） */
const MAX_CACHE_ENTRIES = 500;

/**
 * 带缓存的解析（生产默认实现）。
 *
 * 为什么缓存：终态回执 + 若干条 telemetry 心跳指向**同一张卡**，每次都跑
 * 一次 mget（~1.1s）纯属浪费。缓存的是**结果**（含 chat 级降级结果），
 * 所以连续失败也不会反复打 lark-cli。
 *
 * ★ Task #5080：改用 `getCachedCardLink` / `cacheCardLink` 这对底层原语，
 *   与解析器（`card-link-resolver.ts`）共用同一份缓存 —— 避免出现两份
 *   各自维护的缓存（那会让「解析器缓存了精确链接、带缓存版却不知道」
 *   这种不一致）。本函数仍是**公开 API**（解析器内部链路 + 测试共用）。
 */
export async function resolveCardLinkCached(
  taskId: number,
  deps: ResolveCardLinkDeps = {},
): Promise<string | undefined> {
  const hit = getCachedCardLink(taskId);
  if (hit !== undefined) return hit;

  const url = await resolveCardLinkForTask(taskId, deps);
  if (url) cacheCardLink(taskId, url);
  return url;
}

/** 清空缓存（测试用） */
export function clearCardLinkCache(): void {
  cardLinkCache.clear();
}

/**
 * ★ Task #5080：读进程内缓存（供解析器分层用）。
 *
 * @returns 命中返回 URL；未命中返回 `undefined`
 */
export function getCachedCardLink(taskId: number): string | undefined {
  return cardLinkCache.get(taskId);
}

/**
 * ★ Task #5080：写进程内缓存（供解析器分层用）。
 *
 * 与 `resolveCardLinkCached` 的差别：这里**允许覆盖**已有条目 ——
 * 解析器先给 chat 级链接、再升级成带 position 的精确链接时需要它。
 */
export function cacheCardLink(taskId: number, url: string): void {
  if (cardLinkCache.size >= MAX_CACHE_ENTRIES && !cardLinkCache.has(taskId)) {
    cardLinkCache.clear();
  }
  cardLinkCache.set(taskId, url);
}
