/**
 * @fileoverview BountyCli EventSource Handler
 *
 * Built-in handler for `bounty-cli` event source. Spawns the
 * `@ai-setting/bounty-cli` Go binary (a `lark-cli`-style Mattermost
 * event-source CLI) and forwards its NDJSON event stream into the
 * roy-bot event bus.
 *
 * ## Wire format
 *
 * `bounty event consume --channel <name>` emits one JSON object per line
 * (NDJSON). Each object is a bounty Event struct:
 *
 *   {
 *     "event_id": "...",
 *     "event_type": "mm.message.posted",
 *     "source_time": "...",
 *     "app_id": "...",
 *     "tenant_key": "...",
 *     "payload": { ... MM post data ... },
 *     "timestamp": "2026-..."
 *   }
 *
 * Status messages are written to stderr (not stdout).
 *
 * ## Configuration
 *
 * EventSourceConfig requires:
 * - `channel` (top-level): Mattermost channel name (positional arg)
 * - `profile` (optional): bounty profile name (multi-account scenario, #1637)
 *
 * Optional:
 * - `command` (top-level): override the default command line (advanced)
 *
 * ## Reply channel
 *
 * The reply channel uses `type: "bounty-cli"` so that
 * `BountyCliNotificationChannel` (packages/core/src/env/plugin) picks up
 * notification sends and routes them to `bounty event publish`.
 */

import { ChildProcess, spawn } from "child_process";
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

// =============================================================================
// BountyCliInstance - 实现 EventSourceInstance 接口
// =============================================================================

/**
 * 从 EventSourceConfig 中读取 channel / profile 字段
 *
 * 优先级：
 * - 顶级字段 config.channel / config.profile（推荐）
 * - options.channel / options.profile（向后兼容）
 */
function readBountyCliConfig(config: EventSourceConfig): {
  channel: string | undefined;
  profile: string | undefined;
  customCommand: string | undefined;
} {
  const topChannel = (config as { channel?: unknown }).channel as string | undefined;
  const topProfile = (config as { profile?: unknown }).profile as string | undefined;
  const topCommand = (config as { command?: unknown }).command as string | undefined;

  const optionsChannel = config.options?.channel as string | undefined;
  const optionsProfile = config.options?.profile as string | undefined;

  return {
    channel: topChannel || optionsChannel,
    profile: topProfile || optionsProfile,
    customCommand: topCommand,
  };
}

/**
 * 构造默认的 bounty CLI 命令
 *
 * 输出 NDJSON 到 stdout，状态信息到 stderr。
 *
 * @example
 *   bounty event consume --channel town-square
 *   bounty --profile agent-a event consume --channel town-square
 */
function buildDefaultCommand(profile: string | undefined, channel: string): string {
  const profileFlag = profile ? `--profile ${profile} ` : "";
  return `bounty ${profileFlag}event consume --channel ${channel}`;
}

/**
 * 解析 bounty Event NDJSON 行，转成 roy-bot EventSourceEvent
 *
 * 提取：
 * - event_id / event_type → metadata
 * - payload → metadata.payload
 * - app_id → metadata.appId
 * - 通道名 → metadata.channelName
 * - 频道 ID（如果 payload 里有 channel_id）→ replyChannel.params.channelId
 *
 * payload 是 MM post 结构 { id, channel_id, user_id, message, ... }，
 * 把 message / id 提取到 metadata.chatId / messageId 用于 reply。
 */
function translateEvent(
  raw: Record<string, unknown>,
  fallbackChannel: string,
): {
  metadata: EventMetadata;
  replyChannel: ReplyChannel;
} {
  const eventId = String(raw.event_id ?? "");
  const eventType = String(raw.event_type ?? "");
  const sourceTime = raw.source_time ? String(raw.source_time) : undefined;
  const appId = raw.app_id ? String(raw.app_id) : undefined;
  const tenantKey = raw.tenant_key ? String(raw.tenant_key) : undefined;
  const payload = (raw.payload ?? {}) as Record<string, unknown>;

  // 从 MM post payload 提取关键字段
  const mmPost = payload as {
    id?: string;
    channel_id?: string;
    user_id?: string;
    message?: string;
    channel_name?: string;
  };
  const messageId = mmPost.id;
  const channelId = mmPost.channel_id;
  const channelName = mmPost.channel_name ?? fallbackChannel;
  const userId = mmPost.user_id;

  const metadata: EventMetadata = {
    sourceType: "bounty-cli",
    eventId,
    eventType,
    sourceTime,
    appId,
    tenantKey,
    channelName,
    chatType: "mattermost",
    payload,
  };

  // 把 payload 关键字段提到顶层，便于 plugin / agent 直接读取
  (metadata as Record<string, unknown>).userId = userId;
  (metadata as Record<string, unknown>).message = mmPost.message;

  const replyChannel: ReplyChannel = {
    type: "bounty-cli",
    appId,
    params: {
      channelId,
      channelName,
    },
    // top-level 兼容字段（plugin may use chatId as fallback）
    chatId: channelId,
    messageId,
  };

  return { metadata, replyChannel };
}

/**
 * 默认推荐动作 prompt
 *
 * 给 LLM/agent 一个清晰指引：用 `bounty event publish --channel <name> --text "..."` 投递回复。
 */
function buildBountyCliRecommendedAction(input: {
  profile: string | undefined;
  channelName: string;
}): RecommendedAction {
  const { profile, channelName } = input;
  const profileFlag = profile ? ` --profile ${profile}` : "";

  return {
    description:
      "Reply to a bounty-cli (Mattermost) event via the `bounty event publish` subcommand.",
    command: `bounty${profileFlag} event publish --channel ${channelName} --text "<reply text>"`,
    notes: [
      `--channel accepts both channel NAME (e.g. ${channelName}) and channel ID.`,
      profile
        ? `Use --profile ${profile} if you have multiple Mattermost accounts configured.`
        : "Omit --profile if you only have one Mattermost account.",
    ],
  };
}

/**
 * BountyCli EventSourceInstance
 *
 * 启动 bounty event consume 子进程，读取 NDJSON 事件，forward 到 eventHandler。
 */
class BountyCliInstance implements EventSourceInstance {
  private config: EventSourceConfig;
  private status: EventSourceStatus = "created";
  private child?: ChildProcess;
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

  getStatus(): EventSourceStatus {
    return this.status;
  }

  setEventHandler(handler: EventSourceEventHandler): void {
    this.eventHandler = handler;
  }

  setStatus(status: EventSourceStatus): void {
    this.status = status;
  }

  async start(): Promise<void> {
    if (this.status === "running") return;
    this.setStatus("starting");

    const { channel, profile, customCommand } = readBountyCliConfig(this.config);
    if (!channel && !customCommand) {
      throw new Error("bounty-cli event source requires 'channel' (or 'command') in config");
    }

    const command = customCommand || buildDefaultCommand(profile, channel!);

    // 用 shell: true + exec <command> 保持 stdin 打开
    this.child = spawn(`exec ${command}`, [], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    this.child.stdout?.on("data", (data: Buffer) => {
      const str = data.toString();
      stdoutBuffer += str;
      this.processStdout(stdoutBuffer, channel ?? "");
      stdoutBuffer = "";
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      stderrBuffer += output;
      // stderr 是状态 / 日志；尝试解析 NDJSON 以防 status 也走 stderr
      this.processStderr(stderrBuffer);
      stderrBuffer = "";
    });

    this.child.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGINT" && signal !== "SIGTERM") {
        this.setStatus("error");
      } else {
        this.setStatus("stopped");
      }
    });

    this.child.on("error", (err) => {
      console.error(`[bounty-cli] spawn error: ${err.message}`);
      this.setStatus("error");
    });

    this.setStatus("running");
  }

  /**
   * 处理 stdout NDJSON 流
   *
   * 按换行切分，每行 parse 成 JSON Event。
   */
  private processStdout(buffer: string, fallbackChannel: string): void {
    const lines = buffer.split("\n");
    // 最后一段可能不完整，留给下次
    const tail = lines.pop() ?? "";
    this.buffer = tail;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleEventLine(trimmed, fallbackChannel);
    }
  }

  /**
   * 处理 stderr 流（状态信息 / 警告）
   *
   * stderr 不应该被解析为事件，但尝试 NDJSON 容错（有些实现把 status 帧走 stderr）。
   */
  private processStderr(buffer: string): void {
    // 容错：如果某行是 JSON 对象且包含 event_id，按事件处理；否则丢弃
    const lines = buffer.split("\n");
    const tail = lines.pop() ?? "";
    // stderr 的尾段不缓存（避免污染下次读取）
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("{") && trimmed.includes("event_id")) {
        this.handleEventLine(trimmed, readBountyCliConfig(this.config).channel ?? "");
      }
      // 其他 stderr 行被丢弃（child_process 的 pipe 不会回显给用户）
    }
    if (tail.trim().length > 0) {
      this.buffer = tail;
    } else {
      this.buffer = "";
    }
  }

  /**
   * 处理单行 JSON 事件
   */
  private handleEventLine(line: string, fallbackChannel: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      console.error(`[bounty-cli] failed to parse event line: ${line.slice(0, 200)}`);
      return;
    }

    const { metadata, replyChannel } = translateEvent(raw, fallbackChannel);

    const event: EventSourceEvent = {
      metadata,
      rawEvent: raw,
      replyChannel,
      recommendedAction: buildBountyCliRecommendedAction({
        profile: readBountyCliConfig(this.config).profile,
        channelName: String(metadata.channelName ?? fallbackChannel),
      }),
    };

    if (this.eventHandler) {
      try {
        this.eventHandler(event);
      } catch (err) {
        console.error(`[bounty-cli] event handler threw: ${err}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "created") return;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGINT");
      // 给子进程一个 graceful shutdown window
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.child && !this.child.killed) {
            this.child.kill("SIGKILL");
          }
          resolve();
        }, 3000);
        if (this.child) {
          this.child.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        } else {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    this.setStatus("stopped");
  }
}

// =============================================================================
// BountyCliHandler (EventSourceHandler 实现)
// =============================================================================

export const bountyCliHandler: EventSourceHandler = {
  type: "bounty-cli",

  validateConfig(config: EventSourceConfig): string[] {
    const errors: string[] = [];
    if (!config.id) errors.push("EventSource ID is required");
    if (!config.name) errors.push("EventSource name is required");

    const { channel, customCommand } = readBountyCliConfig(config);
    if (!channel && !customCommand) {
      errors.push(
        "Bounty CLI 'channel' (top-level channel or options.channel) is required",
      );
    }
    return errors;
  },

  createInstance(config: EventSourceConfig): EventSourceInstance {
    return new BountyCliInstance(config);
  },
};