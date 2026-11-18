/**
 * Bounty IM EventSource Handler
 *
 * Built-in handler for bounty-IM event source (roy-bot core)
 *
 * Decoupled from ai-agent-bounty's bountyConfig:
 * - email / imServerUrl must be explicit (no env var fallback)
 * - Uses component's eventHandler chain instead of dynamic env import
 * - handleRule.agent is forwarded into metadata (aligned with larkCli handler)
 *
 * v0.14 (Task #2129): strict email-only
 * - bounty IM identity = email (注册邮箱) ONLY
 * - address 字段彻底移除（v0.12/v0.13 不再支持）
 * - 启动时 hard error on 历史 address field
 *
 * 启动方式：
 *   roy-bot interactive --es <source-id>
 *   或
 *   roy-bot eventsource start <source-id>
 *
 * 配置文件 ~/.roy-bot/event-sources.json 中应包含：
 * {
 *   "id": "bounty-im-auto",
 *   "name": "Bounty IM (Auto)",
 *   "type": "bounty-im",
 *   "email": "alice@bounty.example.com",
 *   "imServerUrl": "ws://localhost:4005/ws"
 * }
 */

import type {
  EventSourceHandler,
  EventSourceInstance,
  EventSourceConfig,
  EventSourceEvent,
  EventSourceEventHandler,
  EventSourceStatus,
  EventMetadata,
  ReplyChannel,
  RecommendedAction,
} from "./types";

// ============================================================================
// BountyIMInstance - 实现 EventSourceInstance 接口
// ============================================================================

type WebSocket = import('ws').WebSocket;

/**
 * 从 EventSourceConfig 中读取 email/imServerUrl
 *
 * v0.14: bounty IM identity = email ONLY
 * - 顶级字段 config.email / config.imServerUrl（推荐）
 * - options.email / options.imServerUrl（向后兼容 ai-agent-bounty 老配置）
 * - **不再支持 address 字段**（v0.12/v0.13 已彻底移除）
 * - 不允许 fallback — bountyConfig 是 ai-agent-bounty 私有配置
 */
function readBountyIMConfig(config: EventSourceConfig): {
  email: string | undefined;
  imServerUrl: string | undefined;
} {
  const topLevelUrl = (config as { imServerUrl?: unknown }).imServerUrl as string | undefined;
  const topLevelEmail = (config as { email?: unknown }).email as string | undefined;
  const optionsUrl = config.options?.imServerUrl as string | undefined;
  const optionsEmail = config.options?.email as string | undefined;

  return {
    email: topLevelEmail || optionsEmail,
    imServerUrl: topLevelUrl || optionsUrl,
  };
}

/**
 * v0.14 启动时迁移检查：如果用户 config 仍有历史 `address` 字段（v0.12/v0.13），
 * 给 hard error 提示用户迁移。
 *
 * 设计选择（HARD ERROR）：
 * - 与 bounty v0.14 strict philosophy 一致
 * - 不做静默 fallback，避免"看起来 work 但行为不一致"问题
 *
 * @throws Error if address field is detected
 */
export function assertNoLegacyAddressField(config: EventSourceConfig): void {
  const legacyTopLevel = (config as { address?: unknown }).address;
  const legacyInOptions = config.options?.address;
  const legacyValue =
    (typeof legacyTopLevel === "string" && legacyTopLevel.trim() !== "" && legacyTopLevel) ||
    (typeof legacyInOptions === "string" && legacyInOptions.trim() !== "" && legacyInOptions);
  if (legacyValue) {
    throw new Error(
      `[BountyIM] v0.14 strict email-only: legacy 'address' field is no longer supported. ` +
        `Found: address="${legacyValue}". ` +
        `Migration: remove the 'address' field and add 'email' (your registered bounty email) ` +
        `to event-sources.json. Example: { "id": "<source-id>", "type": "bounty-im", ` +
        `"email": "<you@bounty.example.com>", "imServerUrl": "<ws-url>" }`,
    );
  }
}

/**
 * 从 EventSourceConfig 中读取 tlsSkipVerify
 *
 * 优先级（自上而下）：
 * 1. 顶级字段 config.tlsSkipVerify（推荐）
 * 2. options.tlsSkipVerify（向后兼容）
 * 3. undefined（默认严格 TLS 验证，Node.js ws 库行为）
 */
function readBountyIMTlsSkipVerify(config: EventSourceConfig): boolean {
  const topLevel = (config as { tlsSkipVerify?: unknown }).tlsSkipVerify;
  const fromOptions = config.options?.tlsSkipVerify;

  const raw = topLevel !== undefined ? topLevel : fromOptions;
  return raw === true;
}

/**
 * 决定当前进程是否需要写 `NODE_TLS_REJECT_UNAUTHORIZED=0` 来强制跳过 TLS 证书校验。
 *
 * ## 背景
 *
 * `ws@^8.16.0` 库的 `WebSocket` 构造选项里 `rejectUnauthorized: false` 在 **Node.js** runtime
 * 下能正确禁用 TLS 证书验证；但 **bun** runtime 下该 per-WebSocket 选项被 bun 的 TLS 层
 * 忽略（Bun 优先读取自身的 global TLS 配置）。这是已知 quirk，详见 bun issue tracker。
 *
 * bun 的 TLS 层会正确响应 `NODE_TLS_REJECT_UNAUTHORIZED=0` 环境变量，所以这是唯一在
 * bun dev 模式下能强制跳过自签名证书校验的途径。
 *
 * ## 用户强约束（Phase B.9）
 *
 * 1. **绝对不允许**在 Node.js 生产环境下写 env var。
 * 2. **绝对不允许**影响同进程其他 TLS 连接（这种"全进程 TLS skip"是已知副作用，
 *    docs/event-source.md#tls-skip-verify 已注明）。
 *
 * 因此该 helper 同时检查两个条件：
 * - `tlsSkipVerify === true`（用户显式开启）
 * - runtime 是 bun（通过可选的 `isBunRuntimeOverride` 测试注入；默认用 `typeof Bun` 检测）
 *
 * @param tlsSkipVerify - 用户配置：是否要跳过 TLS 验证
 * @param isBunRuntimeOverride - 测试 seam：默认 `typeof Bun !== "undefined"`；
 *   测试可显式注入 `false` 模拟 Node.js runtime。
 *
 * @see docs/event-source.md#tls-skip-verify (Phase B.9)
 */
/**
 * 构建 BountyIM 默认 systemPrompt（Phase B.11+）
 *
 * 当用户没有显式配置 EventSourceConfig.systemPrompt 时使用此默认值。
 * 目的：让 agent 处理 bounty-IM 消息时，知道自己的 email、IM server URL、回复命令。
 *
 * 这对于 REPL dispatch 后正确生成回复消息至关重要——
 * 没有这段 prompt，agent 不知道自己是哪个 email，也不知道用什么命令回复。
 *
 * v0.14 strict: 只支持 email 命令格式（`--from-email/--to-email`）。
 * 不再有 `currentAddress` / `-f/-t` alias fallback（v0.12/v0.13 已彻底移除）。
 */
export function buildDefaultBountyIMSystemPrompt(input: {
  currentEmail?: string;
  imServerUrl?: string;
}): string {
  const server = input.imServerUrl || "ws://localhost:4005/ws";
  // 映射规则（Phase B.11+ P1-2 bug fix）：
  // - wss:// → https://  (TLS WebSocket → HTTPS)
  // - ws://  → http://   (plain WebSocket → HTTP, 旧规则错误地映射成 https)
  // 这样 agent 用 dev ws (http) 不会触发 TLS handshake 失败。
  const httpScheme = server.startsWith("wss://") ? "https://" : "http://";
  const endpoint = server.replace(/^wss?:\/\//, httpScheme).replace(/\/ws$/, "");
  // 强约束 prompt (Phase B.11+ P1-3): 上一版 v1.5.102 的"详细版"prompt
  // 含 ~30 行 flags 表 + 等价 HTTP 等，LLM 注意力被稀释，跳过 --server-url 导致
  // 走默认 localhost:4000（dev）→ connect fail。
  //
  // 改进：单一 inline 命令 + 显式"必须 --server-url"提醒 + 简洁上下文。
  //
  // v0.14: identity = email, 命令格式 `--from-email/--to-email`。
  //        如果 currentEmail 未提供（不太可能），给占位符。
  const email = input.currentEmail || "<your-registered-email>";
  const command = `bounty com send --server-url ${endpoint} --from-email ${email} --to-email <recipient-email> --body "..."`;
  const tlsCommand = `  bounty com send --server-url ${endpoint} --from-email ${email} --to-email <recipient-email> --body "..."`;
  const rule = `规则：from-email 永远固定为 ${email}; to-email 是收到消息的 from 字段。`;
  return [
    "你正在通过 Bounty IM 与其他 agent 通信。",
    "",
    `你的 IM 身份（v0.14 strict email-only）：${email}`,
    `IM Server：${endpoint} (k8s remote server)`,
    "",
    "回复收到的消息时，**必须**使用以下命令格式（注意 --server-url 不可省略，省略会默认连 localhost:4000 而失败）：",
    "",
    `  ${command}`,
    "",
    "如果遇到 TLS 错误（自签名证书），加 -k：",
    tlsCommand,
    "",
    rule,
  ].join("\n");
}

/**
 * v0.14.1+ email-display fix:
 * 把 IM WebSocket 入站 URL (wss://host:port/ws) 转成出站 HTTP API URL
 * (https://host:port) 供 `bounty com send --server-url <...>` 使用。
 *
 * 这是推荐回复模板里 `${imServerUrl}` 直接拿来当 `--server-url` 用的根本 bug——
 * IM 入站走 wss，但 HTTP API 必须用 https。
 *
 * 规则（与 buildDefaultBountyIMSystemPrompt 一致；独立抽出便于复用 + 单测）：
 * - `wss://host[:port]/path` → `https://host[:port]`
 * - `ws://host[:port]/path`  → `http://host[:port]`
 * - 末尾 `/ws` 自动剥离
 */
export function translateImServerUrlToHttpApi(imServerUrl: string): string {
  const httpScheme = imServerUrl.startsWith("wss://") ? "https://" : "http://";
  // IM WebSocket URL 约定是 `ws(s)://host[:port]/ws`；剥离末尾 `/ws`（精确锚定），
  // 保留其它路径（如 `/ws/api/v2` 这种少见配置）原样不动。
  return imServerUrl.replace(/^wss?:\/\//, httpScheme).replace(/\/ws$/, "");
}

/**
 * v0.14.1+ email-display fix:
 * 解析 canonical `<uuid>@<host>` 形式到注册邮箱。
 *
 * 设计选择：
 * - canonical = `<uuid>@host` (uuid 模式) → 返回 null（client 端没有 db，
 *   不能确定；让 caller 决定是显示 canonical 还是 `<recipient-registered-email>`
 *   占位符）
 * - canonical = `<uuid>@authenticated` → 返回 profileEmail（best effort：
 *   用于回包命令 `--from-email`，因为服务端 routing 这一侧能看到的就是当
 *   前 WS subscriber 的 UUID）
 * - canonical = 已经是 email 形式（`xxx@yyy.zzz`）→ 原样返回
 *
 * 注意：这只是 best-effort 的 client-side resolver。最权威的 email 始终
 * 来自服务端：`msg.fromEmail`（服务端把 `<uuid>@authenticated` 解析成
 * sender 注册邮箱后通过 WS push 下来）。caller 应该总是优先用
 * `msg.fromEmail`，本函数仅作 fallback。
 */
export function resolveCanonicalToEmail(
  canonical: string | undefined | null,
  profileEmail: string | undefined | null,
): string | null {
  if (!canonical) return null;
  const trimmed = canonical.trim();
  if (!trimmed) return null;

  // 1) canonical UUID 形式优先识别 → 走 uuid 解析分支
  const UUID_HOST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@(.+)$/i;
  const match = trimmed.match(UUID_HOST);
  if (match) {
    const host = match[1];
    if (host === "authenticated") {
      // 发送方 UUID 的 `@authenticated` 后缀 → 用 profile email 顶替（best effort）
      return profileEmail?.trim() || null;
    }
    // 其它 host（如 `<uuid>@bounty.example.example.com`）client 端无法 resolve
    return null;
  }

  // 2) 否则视为 email 形式 → 原样返回
  // 严格 email 校验：local@domain.tld（避免把乱七八糟的字符串当 email）
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return trimmed;
  }

  // 3) 既不是 canonical 也不是 email 形式
  return null;
}

/**
 * 决定当前 instance 的 systemPrompt（Phase B.11+）
 *
 * 优先级：
 * 1. config.systemPrompt（用户显式配置）
 * 2. 默认 prompt（通过 buildDefaultBountyIMSystemPrompt 构造）
 *
 * v0.14: 不再接受 currentAddress 参数（identity = email only）。
 */
export function resolveBountyIMSystemPrompt(input: {
  configSystemPrompt?: string;
  currentEmail?: string;
  imServerUrl?: string;
}): string {
  return input.configSystemPrompt || buildDefaultBountyIMSystemPrompt(input);
}

/**
 * 检测当前 agent 自己发出去的消息被 server 推回 (Task #2136)
 *
 * 背景：bounty IM server 在某些情况下会把 agent 自己的 outbound 消息
 * 推回给自己，造成 self-echo（用户日志里 [From user@example.com] 后
 * 的 `--to-email` 也是 user@example.com）。
 *
 * 优先级：
 * 1) 优先用 server enrichment 的注册邮箱 `msg.fromEmail`（v0.14.1+）
 *    → 注册邮箱是 v0.14 strict 的 canonical identity，最精确
 * 2) fallback: 客户端从 canonical `<uuid>@<host>` 形式推断
 *    - pre-v0.14.1 server 不会 enrich fromEmail
 *    - 比对 from 和 to 在 "@" 之前的 UUID 部分
 *      如果相同，说明是同一个 agent（不管 host 后缀）
 * 3) 都没有信息 → 返回 false（保守放行，让下游处理）
 *
 * @param msg bounty WS event.data（包含 from / to / fromEmail 字段）
 * @param currentEmail 当前 instance 的注册邮箱（config.email）
 * @returns true 表示这条消息是自己发的，应该 skip
 */
export function isSelfEcho(msg: unknown, currentEmail: string | undefined): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;

  // 1) 注册邮箱比对（v0.14.1+ server enrichment path）
  const fromEmailRaw = typeof m.fromEmail === "string" ? m.fromEmail.trim() : "";
  const currentTrim = typeof currentEmail === "string" ? currentEmail.trim() : "";
  if (fromEmailRaw && currentTrim) {
    return fromEmailRaw.toLowerCase() === currentTrim.toLowerCase();
  }

  // 2) canonical UUID 比对（pre-v0.14.1 server fallback）
  //    只在 from 和 to 的 local part 都是 UUID 形式时才比较
  //    避免把 email local part（如 "alice"）误判成 UUID
  const fromAddr = typeof m.from === "string" ? m.from : undefined;
  const toAddr = typeof m.to === "string" ? m.to : undefined;
  if (fromAddr && toAddr) {
    const fromLocal = fromAddr.split("@")[0]?.trim();
    const toLocal = toAddr.split("@")[0]?.trim();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (fromLocal && toLocal && UUID_RE.test(fromLocal) && UUID_RE.test(toLocal)) {
      return fromLocal.toLowerCase() === toLocal.toLowerCase();
    }
  }

  // 3) 信息不足 → 不判定为 self-echo
  return false;
}

/**
 * 检测消息的收件人（msg.to）是不是当前 agent（Task #2136）
 *
 * 返回 true 表示"这条消息不属于我"，应该 skip。
 *
 * 用途：
 * - v0.14 strict 1-to-1 routing：msg.to 必须指向当前 agent
 * - 防止 server 误推其他 agent 的消息给当前 instance
 * - 防止 broadcast / leak 类型的 noise
 *
 * 判定逻辑（避免 mixed-form 误判）：
 * - msg.to 空 → false（broadcast / 未指定，让其通过）
 * - currentEmail 空 → false（无 identity 比对信息）
 * - msg.to 与 currentEmail 都是 email → 完整匹配才算 "to me"
 * - msg.to 与 currentEmail 都是 canonical UUID 形式 → 比较 "@" 之前的 UUID
 * - 一 email 一 canonical（mixed）→ false（incomparable，兼容 pre-v0.14 server）
 *
 * @param msg bounty WS event.data（包含 to 字段）
 * @param currentEmail 当前 instance 的注册邮箱 / 身份
 * @returns true 表示 msg.to 指向别人，应该 skip
 */
export function isWrongAddress(msg: unknown, currentEmail: string | undefined): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  const toAddr = typeof m.to === "string" ? m.to.trim() : "";
  if (!toAddr) return false; // 未指定 to → broadcast / unknown → 让其通过

  const currentTrim = typeof currentEmail === "string" ? currentEmail.trim() : "";
  if (!currentTrim) return false; // 无 identity 信息 → 让其通过

  // 区分 canonical UUID-form（`<uuid>@<host>`）vs email-form（`local@domain.tld`）
  // 简单 email 校验：local@domain.tld（不能含 UUID，因为 UUID 含 "-"）
  // canonical UUID form 的 host 通常是 "authenticated" 或 bounty server host
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const toLocal = toAddr.split("@")[0] ?? "";
  const currentLocal = currentTrim.split("@")[0] ?? "";

  const toIsEmail = EMAIL_RE.test(toAddr) && !UUID_RE.test(toLocal);
  const currentIsEmail = EMAIL_RE.test(currentTrim) && !UUID_RE.test(currentLocal);
  const toIsUuid = UUID_RE.test(toLocal);
  const currentIsUuid = UUID_RE.test(currentLocal);

  // 都是 email 形式 → 直接比对
  if (toIsEmail && currentIsEmail) {
    return toAddr.toLowerCase() !== currentTrim.toLowerCase();
  }

  // 都是 canonical UUID 形式 → 比较 UUID 部分（忽略 host 后缀）
  if (toIsUuid && currentIsUuid) {
    return toLocal.toLowerCase() !== currentLocal.toLowerCase();
  }

  // mixed（一个 email，一个 canonical）→ incomparable，保守放行
  // 例：v0.14 client（identity=email）+ pre-v0.14 server（to=<uuid>@host）
  //   → server 仍在用 canonical addressing，无法 client-side map UUID → email
  //   → 放行，让既有逻辑（warn + 继续处理）兜底
  return false;
}

export function shouldWriteBunTlsSkipEnv(
  tlsSkipVerify: boolean,
  isBunRuntimeOverride?: boolean,
): boolean {
  const isBun = isBunRuntimeOverride ?? (typeof Bun !== "undefined");
  return tlsSkipVerify === true && isBun;
}

export class BountyIMInstance implements EventSourceInstance {
  private config: EventSourceConfig;
  private status: EventSourceStatus = "created";
  private ws: WebSocket | null = null;
  private buffer: string = "";
  private eventHandler?: EventSourceEventHandler;

  /**
   * Environment 引用（由 EventSourceComponent.startSource 调用 setEnvironment 注入）
   */
  private environment?: { getComponent?: (name: string) => unknown };

  constructor(config: EventSourceConfig) {
    this.config = config;
  }

  /**
   * 注入 Environment 引用（实现 EventSourceInstance.setEnvironment）
   */
  setEnvironment(env: unknown): void {
    this.environment = env as { getComponent?: (name: string) => unknown };
  }

  /**
   * 获取当前配置的 email（v0.14 strict single canonical identity）
   *
   * v0.14: bounty IM identity 只用 email 字段，address 字段不再支持。
   */
  private getCurrentIdentity(): { email: string | undefined } {
    const { email } = readBountyIMConfig(this.config);
    return { email };
  }

  /**
   * 获取当前配置的地址（v0.14: 就是 email）
   *
   * v0.14 strict: address 字段不再支持，identity = email。
   * 保留方法名（向后兼容现有调用方），内部直接返回 email。
   */
  private getCurrentAddress(): string {
    const { email } = readBountyIMConfig(this.config);
    return email || "unknown";
  }

  /**
   * 获取当前 instance 的 systemPrompt（Phase B.11+）
   *
   * 优先用 config.systemPrompt，否则用默认 prompt。
   * 该 prompt 会透传到 EventSourceEvent.metadata.systemPrompt，
   * 由 run.ts 在 dispatch env event 时注入到 agent system prompt。
   *
   * ★ ES-M1（Task #5144 / 方案 M2）：结果缓存为实例字段 ——
   * 构造一次，每条消息事件不再重新 resolve。同一渠道输出
   * 逐字节稳定（resolveBountyIMSystemPrompt 只读 config，
   * 本就确定；缓存进一步杜绝未来混入事件级变量导致的字节漂移，
   * 保护 LLM prompt cache 前缀一致性）。
   */
  private cachedSystemPrompt?: string;
  private systemPromptResolved = false;

  private getCurrentSystemPrompt(): string {
    if (!this.systemPromptResolved) {
      const { email, imServerUrl } = readBountyIMConfig(this.config);
      this.cachedSystemPrompt = resolveBountyIMSystemPrompt({
        configSystemPrompt: this.config.systemPrompt,
        currentEmail: email,
        imServerUrl,
      });
      this.systemPromptResolved = true;
    }
    return this.cachedSystemPrompt!;
  }

  getStatus(): EventSourceStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.status === "running") return;

    this.setStatus("starting");

    // v0.14: 启动时 hard error on 历史 address field
    assertNoLegacyAddressField(this.config);

    const { email, imServerUrl } = readBountyIMConfig(this.config);

    if (!imServerUrl) {
      throw new Error("imServerUrl is required for bounty-im event source");
    }

    const wsUrl = new URL(imServerUrl);
    // v0.14: 唯一路径 — WS 连接 query 只发 ?email=<email>
    if (email) {
      wsUrl.searchParams.set("email", email);
    }

    console.log(`[BountyIM] Connecting to ${wsUrl.toString()}...`);

    try {
      const { WebSocket } = await import("ws");
      // tlsSkipVerify 控制 rejectUnauthorized 透传给 ws 库
      // - 默认 false（严格 TLS 验证）
      // - tlsSkipVerify=true → rejectUnauthorized=false（自签名证书场景）
      // - imServerUrl 是 ws:// 时该字段被 Node.js 忽略，安全无副作用
      const tlsSkipVerify = readBountyIMTlsSkipVerify(this.config);

      // Phase B.9: bun runtime 下 ws 库的 per-WebSocket `rejectUnauthorized:false`
      // 被 bun 的 TLS 层忽略，必须通过 `NODE_TLS_REJECT_UNAUTHORIZED=0` 环境变量
      // 才能真正禁用证书校验。Node.js runtime（生产目标）原生支持
      // per-WebSocket `rejectUnauthorized` 选项，不需要此 env var 兜底。
      //
      // 注意副作用：当 helper 返回 true 时，**整个进程**的 TLS 校验都会被禁用
      // （包括 MCP / plugins / tool node 等同进程其他 TLS 调用）。这是 bun
      // runtime 下唯一可用的方案，且仅在 dev/local 场景下生效——生产目标为 Node.js。
      //
      // 进一步收敛副作用：只在 `imServerUrl` 是 `wss://` 时写 env var。
      // `ws://` 不走 TLS 通道，env var 写了也是白写，但会无谓影响同进程其他
      // wss 连接 — 没必要。
      //
      // 详见 docs/event-source.md#tls-skip-verify。
      //
      // TODO: 未来若 bun/Node 提供 per-request CA / per-handshake override API，
      // 直接去掉 env var 兜底，恢复纯 per-WebSocket 配置。
      const isWss = imServerUrl.startsWith("wss://");
      if (isWss && shouldWriteBunTlsSkipEnv(tlsSkipVerify)) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      }

      this.ws = new WebSocket(wsUrl.toString(), {
        headers: this.config.headers,
        rejectUnauthorized: !tlsSkipVerify,
      });

      this.ws.on("open", () => {
        console.log(`[BountyIM] Connected${email ? ` as ${email}` : ""}`);
        this.setStatus("running");
      });

      this.ws.on("message", (data: Buffer | string) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("error", (error: Error) => {
        console.error(`[BountyIM] Error:`, error.message);
        this.setStatus("error");
      });

      this.ws.on("close", () => {
        console.log(`[BountyIM] Connection closed`);
        this.setStatus("stopped");
      });

      // Note: 不在这里 await 'open' 事件，避免阻塞调用方。
      // start() 完成后状态为 "starting"，收到 'open' 后变为 "running"。
      // 调用方可通过监听 status 变化或下次 onEvent 触发判断连接是否成功。

    } catch (error) {
      this.setStatus("error");
      throw new Error(`Failed to connect to Bounty IM server: ${error}`);
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "created") return;

    this.setStatus("stopping");

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setStatus("stopped");
  }

  onEvent(handler: EventSourceEventHandler): void {
    this.eventHandler = handler;
  }

  offEvent(): void {
    this.eventHandler = undefined;
  }

  private setStatus(status: EventSourceStatus): void {
    this.status = status;
  }

  /**
   * 发送 ACK 到 IM 服务器，标记 message 已处理。
   *
   * Task #2136：self-echo filter + wrong-address filter 在 skip 时也调用此 helper，
   * 让 server 端把消息标记为 delivered / acked，避免 reconnect 时重复 push。
   *
   * 静默处理失败（仅 log error，不抛）——ACK 是 best-effort，主流程不能被 ACK 失败阻塞。
   */
  private sendAck(messageId: unknown): void {
    if (!messageId || !this.ws) return;
    try {
      this.ws.send(
        JSON.stringify({ event: "ack", data: { messageIds: [messageId] } }),
      );
    } catch (ackErr) {
      console.error(`[BountyIM] 发送 ACK 失败:`, ackErr);
    }
  }

  private handleMessage(data: string): void {
    this.buffer += data;

    // Try to parse as complete JSON
    try {
      JSON.parse(this.buffer);
      // Complete JSON, process it
      this.processLine(this.buffer);
      this.buffer = "";
    } catch {
      // Not complete JSON yet, wait for more data
    }
  }

  private processLine(rawData: string): void {
    try {
      let rawEvent: unknown;
      try {
        rawEvent = JSON.parse(rawData);
      } catch {
        rawEvent = {
          event: "message",
          data: { content: { type: "text", body: rawData } },
        };
      }

      const evt = rawEvent as Record<string, unknown>;
      const msg = (evt.data as Record<string, unknown>) || {};

      // 跳过非消息事件（如 connected、pong 等）
      if (evt.event !== "message") {
        return;
      }

      // Phase B.10: Bounty k8s server ALWAYS pushes messages with status='delivered'
      // (it's set to delivered by handleMessage before socket.send). The previous
      // filter that skipped non-pending messages dropped ALL real-time pushes.
      //
      // Idempotency on reconnect is guaranteed by the server side:
      // `getPendingMessages(address)` filters SQL `WHERE status = 'pending'`
      // so already-delivered messages are NOT re-pushed on reconnect.
      //
      // Therefore: any 'message' event received via this WS connection is
      // intended to be dispatched (either realtime push or first-time historical
      // push from handleOpen). No status filter here.

      const eventType = `bounty-im.${evt.event || "message"}`;

      // 提取消息关键信息
      const fromAddress = msg.from as string || "unknown";
      // v0.14: getCurrentAddress() 返回 email（identity = email only）
      const currentEmail = this.getCurrentIdentity().email || "unknown";
      const toAddress = msg.to as string || currentEmail;

      // Task #2136: client-side self-echo + wrong-address filter
      // ---------------------------------------------------
      // 1) Self-echo: 自己发的消息被 server 推回 → skip（避免 agent 看到自己的 outbound）
      // 2) Wrong-address: msg.to 不是当前 agent → skip（v0.14 strict 1-to-1 routing）
      // 两种 skip 都仍然发送 ACK，让 server 标记 delivered，避免 reconnect 时再 push 一次。
      if (isSelfEcho(msg, currentEmail)) {
        console.log(
          `[BountyIM] Skipped self-echo: from=${msg.from ?? "?"} to=${msg.to ?? "?"}`,
        );
        this.sendAck(msg.id);
        return;
      }
      if (isWrongAddress(msg, currentEmail)) {
        console.warn(
          `[BountyIM] Skipped wrong-address event: to=${msg.to ?? "?"} currentEmail=${currentEmail}`,
        );
        this.sendAck(msg.id);
        return;
      }

      // v0.14: identity = email only, toAddress 应 == currentEmail
      if (msg.to && msg.to !== currentEmail) {
        console.warn(`[BountyIM] Warning: message.to (${msg.to}) !== current email (${currentEmail})`);
      }

      const msgContent = msg.content as Record<string, unknown>;
      const content = msgContent?.type === "text" ? String(msgContent.body || "") : "";

      // 读取 imServerUrl + email 用于 replyChannel
      const { imServerUrl, email } = readBountyIMConfig(this.config);

      // 提取 handleRule.agent（事件处理时使用的 agent 名称，对齐 larkCli handler）
      const agent = this.config.handleRule?.agent;

      // v0.14.1+ email-display fix:
      // 1) 优先用服务端 push 时 enrichment 的 `msg.fromEmail`（注册邮箱）。
      // 2) fallback: 客户端 resolver 把 `<uuid>@authenticated` 映射到当前 profile email。
      // 3) 都没有时回退到 canonical（LLM 至少能看到原始地址）。
      const fromEmailRaw = msg.fromEmail as string | undefined;
      const fromEmailResolved = resolveCanonicalToEmail(fromAddress, email);
      const senderEmail: string =
        (typeof fromEmailRaw === "string" && fromEmailRaw.trim() !== "" && fromEmailRaw.trim()) ||
        fromEmailResolved ||
        fromAddress;

      // 构建 metadata（参考 lark-cli 实现 + 增加 agent）
      const metadata: EventMetadata = {
        eventType,
        senderId: fromAddress,  // 保留 canonical 用于 routing / backward compat
        senderEmail,            // v0.14.1+: 注册邮箱（LLM 友好）
        chatId: toAddress,      // 当前 agent 的地址作为 chatId
        agent,
      };

      // v0.14.1+ email-display fix:
      // 推荐回复模板里：
      //   - `--server-url` 必须是 http(s)://，不能直接用 imServerUrl (wss://)
      //   - `--from-email` 用当前 profile email（已配置就不用占位符）
      //   - `--to-email` 用注册邮箱 (senderEmail)；没有时用占位符
      const httpApiUrl = imServerUrl ? translateImServerUrlToHttpApi(imServerUrl) : "<your-server-url>";
      const fromEmailForCmd = email || "<your-registered-email>";
      const toEmailForCmd = senderEmail !== fromAddress
        ? senderEmail
        : "<recipient-registered-email>";

      const replyCommandHint = `bounty com send --server-url ${httpApiUrl} --from-email ${fromEmailForCmd} --to-email ${toEmailForCmd} --body "..."`;
      const inlineReplyHint = `bounty com send --server-url ${httpApiUrl} --from-email ${fromEmailForCmd} --to-email ${toEmailForCmd} --body "回复内容"`;

      // 推荐动作：告诉 Agent 如何回复（参考 lark-cli recommendedAction）
      let recommendedAction: RecommendedAction | undefined;
      // Task #2136: 即使 self-echo filter 被绕过，fromAddress === toAddress 时
      // 也不生成 reply template（defense-in-depth — 防止 phantom 💡 回复: 提示）
      if (evt.event === "message" && fromAddress !== toAddress) {
        recommendedAction = {
          action: `处理消息并通过 bounty com send 回复发件人。使用格式：${replyCommandHint}`,
          replyTo: {
            chatId: fromAddress,  // 回复目标：发件人
          },
        };
      }

      // 反馈通道：包含回复所需的信息
      const replyChannel: ReplyChannel = {
        type: "bounty-im",
        chatId: fromAddress,  // 回复目标：发件人
        params: {
          from: email || toAddress,  // v0.14: 当前 agent email 作为发件人
          to: fromAddress,  // 回复给发件人
          imServerUrl,
        },
      };

      // 构建用户可见的消息（包含 recommendedAction 提示）
      // 格式：显示发件人（优先注册邮箱）+ 消息内容 + 回复命令提示
      const displayFrom = senderEmail;
      const displayMessage = content
        ? `[From ${displayFrom}] ${content}\n\n💡 回复: ${inlineReplyHint}`
        : this.formatMessage(rawEvent);

      const event: EventSourceEvent = {
        id: `es-${this.config.id}-${Date.now()}`,
        // Phase B.11: 对齐 LarkCli 模式（BountyIMInstance.handleMessage），
        // event.type 用 "event-source.event.<sourceType>" 形式。
        // 这样 `run.ts` 的 eventTypes: ["event-source.event.*"] 能命中 BountyIM 事件，
        // REPL 才会像处理飞书事件一样自动 dispatch 到 agent。
        // 真实的 bounty event type（如 "bounty-im.message"）放到 metadata.sourceMessageType。
        type: "event-source.event.bounty-im",
        timestamp: Date.now(),
        metadata: {
          source: "event-source",
          sourceId: this.config.id,
          sourceMessageType: eventType,
          systemPrompt: this.getCurrentSystemPrompt(),
          agent,
        },
        payload: {
          sourceId: this.config.id,
          sourceType: "bounty-im",
          rawEvent,
          message: displayMessage,  // 使用包含回复提示的消息
          metadata,
          recommendedAction,
          replyChannel,
          timestamp: Date.now(),
        },
      };

      // 调用 EventSourceEventHandler（供其他组件使用）
      // 组件注册的 handler 会自动处理 env.pushEnvEvent 转发
      this.eventHandler?.(event);

      // 处理完成后发送 ACK 到 IM 服务器，更新消息状态为 acked
      // 防止消息因状态停留在 pending/delivered 而被重复投递或处理
      // Task #2136: 抽出 sendAck helper 复用（filter skip 路径也用）
      if (msg.id) {
        console.log(`[BountyIM] 已发送 ACK for message: ${msg.id}`);
      }
      this.sendAck(msg.id);
    } catch (err) {
      console.error(`[BountyIM] Error processing message:`, err);
    }
  }

  private formatMessage(rawEvent: unknown): string {
    const evt = rawEvent as Record<string, unknown>;
    if (evt.event === "connected") {
      return `✅ 已连接到 bounty IM 服务器`;
    }
    if (evt.event === "message") {
      const msg = (evt.data as Record<string, unknown>) || {};
      const from = (msg.from as string) || "unknown";
      let content = "未知内容";
      if ((msg.content as Record<string, unknown>)?.type === "text") {
        content = String((msg.content as Record<string, unknown>)?.body || "");
      }
      return `[${from}] ${content}`;
    }
    return `事件: ${evt.event || "unknown"}`;
  }
}

// ============================================================================
// BountyIMHandler - 实现 EventSourceHandler 接口
// ============================================================================

export const bountyIMHandler: EventSourceHandler = {
  type: "bounty-im",

  validateConfig(config: EventSourceConfig): string[] {
    const errors: string[] = [];

    if (!config.id) errors.push("EventSource ID is required");
    if (!config.name) errors.push("EventSource name is required");

    // v0.14: 启动时 hard error on 历史 address field
    try {
      assertNoLegacyAddressField(config);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    const { imServerUrl, email } = readBountyIMConfig(config);

    // v0.14: bounty IM identity = email ONLY（不再支持 address 字段）
    if (!email) {
      errors.push(
        "Bounty IM email is required (v0.14 strict email-only; top-level email or options.email)",
      );
    }

    // email 格式校验（宽松 RFC 5322 简化版：local@domain）
    if (email !== undefined && email !== "") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push("Bounty IM email format invalid (expected: user@domain.tld)");
      }
    }

    if (!imServerUrl) {
      errors.push("Bounty IM imServerUrl is required (top-level imServerUrl or options.imServerUrl)");
    } else if (!imServerUrl.startsWith("ws://") && !imServerUrl.startsWith("wss://")) {
      errors.push("Bounty IM imServerUrl must start with ws:// or wss://");
    }

    return errors;
  },

  createInstance(config: EventSourceConfig): EventSourceInstance {
    return new BountyIMInstance(config);
  },
};