/**
 * @fileoverview Task #5165 — 企微长连接 WebSocket 桥
 *
 * ## 为什么自实现（不用 @wecom/aibot-node-sdk）
 *
 * 1. core 已依赖 `ws@^8.16.0`（bounty-im-handler 同款用法），
 *    不新增任何 npm 依赖（npm 官方 registry 挂，见 Task #5142）；
 * 2. 协议极简（4 种帧），SDK 的认证/心跳/重连语义已全部吃透
 *    （读 SDK dist/index.cjs.js 源码取证，Task #5142）；
 * 3. 避免第三方依赖供应链风险。
 *
 * ## 协议（官方文档 101463 + SDK 源码取证）
 *
 * - 认证帧：`{cmd:"aibot_subscribe", headers:{req_id}, body:{bot_id, secret}}`
 *   响应：无 cmd，`headers.req_id` 前缀 `aibot_subscribe_`，`errcode==0` 成功
 * - 心跳：`{cmd:"ping", headers:{req_id}}`，响应 req_id 前缀 `ping_`，建议 30s
 * - 消息：`{cmd:"aibot_msg_callback", headers:{req_id}, body:{msgid,...}}`
 * - 事件：`{cmd:"aibot_event_callback", headers:{req_id}, body:{...}}`
 * - 回复：`{cmd:"aibot_respond_msg", headers:{req_id:原样透传}, body:{...}}`
 * - 断线重连：指数退避；认证失败与断线**独立计数**
 * - ⚠️ 每机器人同一时刻只允许 1 条长连接（新连接踢旧连接）
 *
 * @see packages/core/src/env/event-source/wecom-ws-bridge.test.ts
 * @see docs/research/2026-11-07-wecom-cli-and-roy-bot-es.md
 */

import type { WebSocket } from "ws";

/** 企微长连接默认地址（官方文档 101463） */
export const WECOM_WS_URL = "wss://openws.work.weixin.qq.com";

/** 心跳间隔（官方建议 30s） */
export const WECOM_HEARTBEAT_INTERVAL_MS = 30_000;

/** 重连基础延迟（指数退避起点） */
export const WECOM_RECONNECT_BASE_DELAY_MS = 1_000;

/** 重连最大延迟（指数退避封顶） */
export const WECOM_RECONNECT_MAX_DELAY_MS = 60_000;

/** 默认最大重连次数（断线场景） */
export const WECOM_MAX_RECONNECT_ATTEMPTS = 10;

/** 默认最大认证失败次数（凭据错误重试无用） */
export const WECOM_MAX_AUTH_FAILURE_ATTEMPTS = 5;

// =============================================================================
// req_id 生成（对齐 SDK generateReqId：`<prefix>_<ts>_<random>`）
// =============================================================================

function randomString(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 生成 `<prefix>_<timestamp>_<random>` 形态的 req_id（对齐官方 SDK） */
export function generateWecomReqId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomString()}`;
}

// =============================================================================
// 协议帧构造与判定
// =============================================================================

/** 通用帧形状（收发共用） */
export interface WecomFrame {
  cmd?: string;
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
  errcode?: number;
  errmsg?: string;
}

/** 构造认证帧（aibot_subscribe） */
export function buildWecomAuthFrame(
  botId: string,
  secret: string,
): WecomFrame & { cmd: string; body: Record<string, unknown> } {
  return {
    cmd: "aibot_subscribe",
    headers: { req_id: generateWecomReqId("aibot_subscribe") },
    body: { bot_id: botId, secret },
  };
}

/** 构造心跳帧（ping） */
export function buildWecomHeartbeatFrame(): WecomFrame & { cmd: string } {
  return {
    cmd: "ping",
    headers: { req_id: generateWecomReqId("ping") },
  };
}

/**
 * 构造回复帧（aibot_respond_msg，Task #5174）。
 *
 * ★ 协议硬约束（官方文档 101463 + SDK 源码取证）：
 * - `headers.req_id` 必须**原样透传**原消息帧的 req_id
 *   （服务端靠它把回复关联到原消息/会话）；
 * - body 是消息体（msgtype: text / markdown / image / ...）；
 * - 收到回调后 24h 内可回复；限频 30 条/分钟。
 *
 * @param reqId 原消息帧的 req_id（空则抛错 —— 关联缺失等于发不出去）
 * @param body  消息体（如 `{msgtype:"text", text:{content:"..."}}`）
 */
export function buildWecomRespondFrame(
  reqId: string,
  body: Record<string, unknown>,
): WecomFrame & { cmd: string; body: Record<string, unknown> } {
  const id = reqId.trim();
  if (!id) {
    throw new Error(
      "buildWecomRespondFrame: req_id is required (reply must reference the original message frame)",
    );
  }
  return {
    cmd: "aibot_respond_msg",
    headers: { req_id: id },
    body,
  };
}

/** 便捷构造：text 回复帧 */
export function buildWecomRespondTextFrame(
  reqId: string,
  content: string,
): WecomFrame & { cmd: string; body: Record<string, unknown> } {
  return buildWecomRespondFrame(reqId, {
    msgtype: "text",
    text: { content },
  });
}

/** 判定是否认证响应（req_id 前缀 `aibot_subscribe_`，无论成败） */
export function isWecomAuthResponse(frame: WecomFrame): boolean {
  if (frame.cmd) return false;
  const reqId = frame.headers?.req_id ?? "";
  return reqId.startsWith("aibot_subscribe_");
}

/** 判定是否心跳响应（req_id 前缀 `ping_`） */
export function isWecomHeartbeatResponse(frame: WecomFrame): boolean {
  if (frame.cmd) return false;
  const reqId = frame.headers?.req_id ?? "";
  return reqId.startsWith("ping_");
}

/**
 * 判定是否「服务端踢线」事件帧（Task #5203）。
 *
 * ## 为什么需要它（真网根因）
 *
 * 企微「每机器人同一时刻只允许 1 条长连接」——新连接建起来会把旧连接踢掉。
 * 踢线时服务端**只发一个事件帧** `disconnected_event`，
 * **TCP 连接并不关闭**（socket 仍 ESTAB，心跳 ping/pong 仍正常往返）。
 *
 * ⇒ 原实现只在 `ws.on("close")` 时重连 ⇒ 被踢线的 bridge **永远不重连**，
 *   变成「心跳正常但业务流量全丢」的僵尸连接（真网现象：用户点卡片按钮，
 *   回调送不达 ES，app.log 里只有 disconnected_event，没有 template_card_event）。
 *
 * @see https://developer.work.weixin.qq.com/document/path/101463（长连接规范）
 */
export function isWecomDisconnectedEvent(frame: unknown): boolean {
  if (!frame || typeof frame !== "object") return false;
  const f = frame as {
    cmd?: string;
    body?: { event?: { eventtype?: string } };
  };
  if (f.cmd !== "aibot_event_callback") return false;
  return f.body?.event?.eventtype === "disconnected_event";
}

/**
 * 清洗帧中的 secret 字段（DS review B1，Task #5165）。
 *
 * 浅拷贝 + 删除顶层与 body 层的 `secret` —— 服务端 echo 请求体时
 * 防止认证 secret 经 onMessage → rawEvent 泄漏给 LLM。
 */
export function sanitizeWecomFrame(frame: WecomFrame): WecomFrame {
  const clean: WecomFrame = { ...frame };
  if ("secret" in clean) delete clean.secret;
  if (clean.body && typeof clean.body === "object") {
    clean.body = { ...clean.body };
    if ("secret" in clean.body) delete clean.body.secret;
  }
  return clean;
}

// =============================================================================
// WsBridge — 连接 / 认证 / 心跳 / 重连 / 消息分发
// =============================================================================

/** 指数退避延迟：`min(base * 2^(n-1), max)` */
function backoffDelay(attempt: number, base: number, max: number): number {
  return Math.min(base * Math.pow(2, attempt - 1), max);
}

/** WsBridge 配置 */
export interface WecomWsBridgeOptions {
  botId: string;
  secret: string;
  /** 覆盖默认 ws 地址（测试 / 内网代理用） */
  wsUrl?: string;
  /** WebSocket 工厂（测试注入 mock；生产用 `new (await import('ws')).WebSocket`） */
  wsFactory?: (url: string) => WebSocket;
  heartbeatIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxReconnectAttempts?: number;
  maxAuthFailureAttempts?: number;
}

/**
 * 企微长连接桥（对齐官方 SDK 语义，自实现于 ws）。
 *
 * 状态机：
 *   connect() → open → 发认证帧 → 认证响应
 *     ├─ errcode==0 → authenticated → 启动心跳
 *     └─ errcode!=0 → auth 失败计数 → 指数退避重连
 *   close/error → 断线计数 → 指数退避重连
 *   stop() → 手动关闭，不再重连
 *
 * ⚠️ 每机器人同一时刻只允许 1 条长连接（新连接踢旧连接）。
 */
export class WecomWsBridge {
  private opts: Required<
    Pick<
      WecomWsBridgeOptions,
      | "heartbeatIntervalMs"
      | "reconnectBaseDelayMs"
      | "reconnectMaxDelayMs"
      | "maxReconnectAttempts"
      | "maxAuthFailureAttempts"
    >
  >;
  private readonly botId: string;
  private readonly secret: string;
  private wsFactory: (url: string) => WebSocket;
  private wsUrl: string;
  private ws?: WebSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private authFailureAttempts = 0;
  private manualClose = false;
  private lastCloseWasAuthFailure = false;
  private stopped = false;

  private onMessageCb?: (frame: WecomFrame) => void;
  private onAuthenticatedCb?: () => void;
  private onReconnectingCb?: (attempt: number) => void;
  private onErrorCb?: (err: Error) => void;

  constructor(opts: WecomWsBridgeOptions) {
    this.opts = {
      heartbeatIntervalMs:
        opts.heartbeatIntervalMs ?? WECOM_HEARTBEAT_INTERVAL_MS,
      reconnectBaseDelayMs:
        opts.reconnectBaseDelayMs ?? WECOM_RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs:
        opts.reconnectMaxDelayMs ?? WECOM_RECONNECT_MAX_DELAY_MS,
      maxReconnectAttempts:
        opts.maxReconnectAttempts ?? WECOM_MAX_RECONNECT_ATTEMPTS,
      maxAuthFailureAttempts:
        opts.maxAuthFailureAttempts ?? WECOM_MAX_AUTH_FAILURE_ATTEMPTS,
    };
    this.botId = opts.botId;
    this.secret = opts.secret;
    this.wsUrl = opts.wsUrl ?? WECOM_WS_URL;
    this.wsFactory = opts.wsFactory ?? ((url) => {
      // 生产路径：动态 import ws（bounty-im-handler 同款，bundler 可内联）
      throw new Error(
        "wsFactory is required in production (inject WebSocket from 'ws')",
      );
    });
  }

  onMessage(cb: (frame: WecomFrame) => void): void {
    this.onMessageCb = cb;
  }
  onAuthenticated(cb: () => void): void {
    this.onAuthenticatedCb = cb;
  }
  onReconnecting(cb: (attempt: number) => void): void {
    this.onReconnectingCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.onErrorCb = cb;
  }

  /** 建立连接（open 后自动发认证帧） */
  connect(): void {
    if (this.stopped) return;
    const ws = this.wsFactory(this.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.lastCloseWasAuthFailure = false;
      this.sendFrame(buildWecomAuthFrame(this.optsBotId(), this.optsSecret()));
    });

    ws.on("message", (data: unknown) => {
      try {
        const raw = String(data).replace(/[\x00-\x08\x0B-\x0D\x0E-\x1F]/g, "");
        const frame = JSON.parse(raw) as WecomFrame;
        this.handleFrame(frame);
      } catch {
        // 非 JSON 帧：忽略（服务端异常帧不拖垮连接）
      }
    });

    ws.on("close", () => {
      this.stopHeartbeat();
      if (this.manualClose || this.stopped) return;
      this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      this.onErrorCb?.(err);
    });
  }

  private optsBotId(): string {
    return this.botId;
  }
  private optsSecret(): string {
    return this.secret;
  }

  /** 处理服务端帧（认证响应 / 心跳响应 / 消息 / 事件） */
  private handleFrame(frame: WecomFrame): void {
    // 认证响应（优先判定）
    if (isWecomAuthResponse(frame)) {
      if ((frame.errcode ?? 0) !== 0) {
        this.lastCloseWasAuthFailure = true;
        this.onErrorCb?.(
          new Error(
            `wecom auth failed: ${frame.errmsg ?? "?"} (code=${frame.errcode})`,
          ),
        );
        this.ws?.terminate(); // 触发 close → auth 重连路径
        return;
      }
      // 认证成功：重置计数 + 启动心跳
      this.reconnectAttempts = 0;
      this.authFailureAttempts = 0;
      this.startHeartbeat();
      this.onAuthenticatedCb?.();
      return;
    }
    // 心跳响应：无需处理（保活由服务端判定）
    if (isWecomHeartbeatResponse(frame)) return;
    // ★ Task #5203：服务端踢线（disconnected_event）—— TCP 不会关闭，
    //   必须**主动重连**，否则 bridge 变僵尸连接（心跳正常但业务流量全丢）。
    //   该事件不是业务事件 ⇒ 不透传给 onMessage（上层会误当普通事件）。
    if (isWecomDisconnectedEvent(frame)) {
      this.lastCloseWasAuthFailure = false;
      this.onErrorCb?.(
        new Error(
          "wecom disconnected_event: server kicked this connection " +
            "(bot allows only 1 long connection) — reconnecting",
        ),
      );
      // 停心跳 + 主动重连（旧 socket 已失效，直接丢弃）
      this.stopHeartbeat();
      const stale = this.ws;
      this.ws = undefined;
      // 关闭旧连接（服务端已踢线，close 事件不会重复排重连——有去重守卫）
      try {
        stale?.close?.();
      } catch {
        // 旧连接关闭失败不影响重连
      }
      this.scheduleReconnect();
      return;
    }
    // 消息 / 事件帧 → 上层
    // ★ DS review B1（Task #5165）：透传前清洗 secret 字段 ——
    //   服务端某些错误响应会 echo 请求体（含认证 secret），
    //   不清洗的话 secret 会经 rawEvent 进入 LLM 上下文泄漏。
    this.onMessageCb?.(sanitizeWecomFrame(frame));
  }

  private sendFrame(frame: WecomFrame): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch (err) {
      this.onErrorCb?.(err as Error);
    }
  }

  /**
   * 发送回复帧（aibot_respond_msg，Task #5174）。
   *
   * best-effort 语义：返回错误而不抛 —— 调用方（handler）在
   * 事件回调里，抛错会打断事件处理链。
   *
   * @param reqId 原消息帧的 req_id（原样透传）
   * @param body  消息体
   * @returns 发送失败时返回 Error；成功返回 undefined
   */
  respond(reqId: string, body: Record<string, unknown>): Error | undefined {
    if (this.stopped || this.manualClose) {
      return new Error("wecom bridge stopped, cannot respond");
    }
    if (!this.ws || this.ws.readyState !== 1) {
      return new Error("wecom bridge not connected, cannot respond");
    }
    try {
      let frame: WecomFrame;
      try {
        frame = buildWecomRespondFrame(reqId, body);
      } catch (err) {
        return err as Error;
      }
      this.ws.send(JSON.stringify(frame));
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * 主动推送帧（Task #5203：aibot_send_msg 直发 template_card）。
   *
   * 与 respond 的区别：respond 必须关联原消息 req_id（被动回复），
   * sendCmd 是**主动推送**（req_id 由开发者自行生成，用于关联
   * 请求与响应）—— 不依赖用户消息触发。
   *
   * best-effort 语义同 respond：返回错误而不抛。
   *
   * @param cmd  命令类型（如 "aibot_send_msg"）
   * @param body 消息体
   */
  sendCmd(
    cmd: string,
    body: Record<string, unknown>,
  ): Error | undefined {
    if (this.stopped || this.manualClose) {
      return new Error("wecom bridge stopped, cannot send");
    }
    if (!this.ws || this.ws.readyState !== 1) {
      return new Error("wecom bridge not connected, cannot send");
    }
    try {
      this.ws.send(
        JSON.stringify({
          cmd,
          headers: { req_id: generateWecomReqId(cmd) },
          body,
        } satisfies WecomFrame),
      );
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * 发送自定义帧（req_id 由调用方透传，Task #5203 回归修复）。
   *
   * ★ 为什么需要：卡片更新（aibot_respond_update_msg）必须
   *   **原样透传** template_card_event 回调帧的 req_id
   *   （5 秒窗口关联），而 sendCmd 自己生成 req_id、
   *   respond() 硬包成 aibot_respond_msg —— 两者都不满足。
   *
   * best-effort 语义同 respond/sendCmd：返回错误而不抛。
   *
   * @param frame 完整帧（cmd + headers.req_id + body）
   */
  sendFrameWithReqId(frame: {
    cmd: string;
    headers: { req_id: string };
    body: Record<string, unknown>;
  }): Error | undefined {
    if (this.stopped || this.manualClose) {
      return new Error("wecom bridge stopped, cannot send");
    }
    if (!this.ws || this.ws.readyState !== 1) {
      return new Error("wecom bridge not connected, cannot send");
    }
    if (!frame.headers?.req_id?.trim()) {
      return new Error(
        "sendFrameWithReqId: req_id is required (must reference the original frame)",
      );
    }
    try {
      this.ws.send(JSON.stringify(frame));
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendFrame(buildWecomHeartbeatFrame());
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** 指数退避重连（认证失败与断线独立计数） */
  private scheduleReconnect(): void {
    if (this.manualClose || this.stopped) return;
    // ★ Task #5203 去重：disconnected_event 触发的重连 + 随后的 socket
    //   close 事件会各调一次 ⇒ 只排一个定时器，避免退避计数翻倍。
    if (this.reconnectTimer) return;
    const isAuthFailure = this.lastCloseWasAuthFailure;
    if (isAuthFailure) {
      if (this.authFailureAttempts >= this.opts.maxAuthFailureAttempts) {
        this.onErrorCb?.(
          new Error(
            `wecom auth failed ${this.authFailureAttempts} times, giving up`,
          ),
        );
        return;
      }
      this.authFailureAttempts++;
    } else {
      if (this.reconnectAttempts >= this.opts.maxReconnectAttempts) {
        this.onErrorCb?.(
          new Error(
            `wecom reconnect exhausted (${this.reconnectAttempts} attempts)`,
          ),
        );
        return;
      }
      this.reconnectAttempts++;
    }
    const attempt = isAuthFailure
      ? this.authFailureAttempts
      : this.reconnectAttempts;
    const delay = backoffDelay(
      attempt,
      this.opts.reconnectBaseDelayMs,
      this.opts.reconnectMaxDelayMs,
    );
    this.onReconnectingCb?.(attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.manualClose || this.stopped) return;
      this.connect();
    }, delay);
  }

  /** 手动停止（不再重连） */
  stop(): void {
    this.stopped = true;
    this.manualClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      this.ws?.close();
    } catch {
      /* 已关闭 */
    }
    this.ws = undefined;
  }
}
