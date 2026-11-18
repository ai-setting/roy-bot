/**
 * @fileoverview BountyCliNotificationChannel
 *
 * 仿 `LarkCliNotificationChannel` 设计，spawn `bounty event publish` 子进程
 * 投递到 Mattermost。
 *
 * ## 路由逻辑
 *
 * - canRoute = true 仅当 `envContext.replyChannel` 存在
 *   - type 含 "bounty-cli"（不区分大小写）
 *   - 至少有 channelId 或 messageId
 *
 * ## spawn bounty-cli
 *
 * - `bounty event publish --channel <channelId> --text <text>` 投递到 Mattermost
 * - profile 不为 undefined 时在 args 头部插入 `--profile <name>` flag
 * - 也支持 channelName（按 Mattermost 频道名称）
 *
 * ## 失败处理
 *
 * - spawn 失败 / exit code != 0 → swallow（log warn，notification 失败不污染 Plugin 主流程）
 *
 * ## 与 bounty-cli 的关系
 *
 * bounty-cli 是独立的 Go 二进制（@ai-setting/bounty-cli npm 包，
 * https://github.com/ai-setting/bounty-cli）。它通过 postinstall 自动下载。
 * 用户安装 `@ai-setting/bounty-cli` 后，`bounty` 命令即可在 PATH 中使用。
 */

import { spawn } from "node:child_process";
import { createLogger } from "../log-trace/logger";
import type {
  EnvContextLike,
  NotificationChannel,
  NotificationOptions,
  NotificationSendExtras,
} from "./notification-channel";

const logger = createLogger("plugin:notification:bounty-cli");

/**
 * BountyCli Notification Channel
 *
 * @example
 * ```ts
 * // 注册 bounty-cli 通道（用于 Mattermost 投递）
 * component.setNotificationChannels([
 *   new BountyCliNotificationChannel(),
 *   EventBusNotificationChannel(), // 兜底
 * ]);
 * ```
 */
export class BountyCliNotificationChannel implements NotificationChannel {
  readonly name = "bounty-cli";

  /**
   * 仅当 replyChannel 含 bounty-cli 类型且有 channelId/messageId/channelName 时路由
   */
  canRoute(
    _options: NotificationOptions,
    _extras: NotificationSendExtras,
    envContext: EnvContextLike
  ): boolean {
    const channel = envContext.replyChannel;
    if (!channel) {
      return false;
    }
    if (!channel.type || !channel.type.toLowerCase().includes("bounty-cli")) {
      return false;
    }
    // 至少需要一个目标：top-level chatId/messageId 或 params.channelId/channelName
    const params = channel.params ?? {};
    if (
      !channel.chatId &&
      !channel.messageId &&
      !params.channelId &&
      !params.channelName
    ) {
      return false;
    }
    return true;
  }

  /**
   * spawn bounty event publish 发 Mattermost 消息
   */
  async send(
    options: NotificationOptions,
    extras: NotificationSendExtras,
    envContext: EnvContextLike
  ): Promise<void> {
    const replyChannel = envContext.replyChannel;
    if (!replyChannel) {
      logger.debug(
        `[bounty-cli] No replyChannel for plugin '${extras.pluginName}', skip`
      );
      return;
    }

    const messageId = replyChannel.messageId;
    const profile = replyChannel.profile;
    const params = replyChannel.params ?? {};
    const channelId = params.channelId as string | undefined;
    const channelName = params.channelName as string | undefined;

    if (!messageId && !channelId && !channelName) {
      logger.debug(
        `[bounty-cli] replyChannel has no channelId/channelName/messageId for plugin '${extras.pluginName}', skip`
      );
      return;
    }

    const message = `${options.title}\n\n${options.content}`;

    try {
      await this.spawnBountyPublish({
        channelId,
        channelName,
        messageId,
        content: message,
        profile,
      });
      logger.info(
        `[bounty-cli] Notification sent for plugin '${extras.pluginName}': ${options.type}`
      );
    } catch (err) {
      logger.warn(
        `[bounty-cli] Failed to send notification for plugin '${extras.pluginName}' (${options.type}): ${err}`
      );
      // swallow - notification failure must not break plugin main flow
    }
  }

  /**
   * spawn `bounty event publish` 子进程
   *
   * - messageId 优先：用 `bounty event reply`（如果存在）或附加到 publish 的 text
   * - channelId 优先：用 `--channel <id>`
   * - channelName：用 `--channel <name>`（按名称）
   */
  private spawnBountyPublish(options: {
    channelId?: string;
    channelName?: string;
    messageId?: string;
    content: string;
    profile?: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const { channelId, channelName, content, profile } = options;

      // 优先按 ID，否则按名称
      const channel = channelId ?? channelName;
      if (!channel) {
        // 没有 channel，只有 messageId：仅记录，不发送
        // （bounty-cli v0.3.0 没有 reply 子命令，messageId 场景留给未来扩展）
        resolve();
        return;
      }

      const args = ["event", "publish", "--channel", channel, "--text", content];

      // profile 注入（多 appId 场景下指定 bounty profile）
      if (profile) {
        args.unshift("--profile", profile);
      }

      const proc = spawn("bounty", args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer | string) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer | string) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`bounty exited with code ${code}: ${stderr}`));
        }
      });

      proc.on("error", (error) => {
        reject(error);
      });
    });
  }
}