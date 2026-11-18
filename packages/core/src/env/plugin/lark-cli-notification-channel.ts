/**
 * @fileoverview LarkCliNotificationChannel
 *
 * @deprecated 自 v2 起默认通道改为 `EventBusNotificationChannel`。
 *             LarkCliNotificationChannel 保留为可选/opt-in 实现，
 *             新代码请用 EventBusNotificationChannel + env-level event
 *             subscriber 自行投递到飞书。
 *
 * ## 保留原因
 *
 * - 部分现有 Plugin 通过 `PluginEnv.notify` 期望直接发飞书（不通过 event bus）
 * - 兼容旧 Plugin 配置（lark-cli 是历史默认通道）
 *
 * ## 路由逻辑
 *
 * - canRoute = true 仅当 `envContext.replyChannel` 存在，且
 *   - type 含 "lark"（不区分大小写）
 *   - 至少有 chatId 或 messageId
 *
 * ## spawn lark-cli
 *
 * - messageId 走 `lark-cli im +messages-reply --message-id <id> --markdown <md> --as bot`
 * - chatId 走 `lark-cli im +messages-send --chat-id <id> --markdown <md> --as bot`
 * - profile 不为 undefined 时在 args 头部插入 `--profile <name>`
 *
 * ⚠️ **两支都必须显式 `--as bot`**（Task #4557）。chatId 分支历史上漏了，
 * 不带 flag 时 lark-cli 用默认身份 = **user（真人账号）** 发出 →
 * `lark-cli event consume im.message.receive_v1` 只看「是不是 user 发的」→
 * 自己的通知被同一个 consumer 回灌成「用户消息」→ 又跑一次完整 agent run。
 * Task #4552 在同类路径实测回灌率 **5/11 = 45%**，补 flag 后 **0/5 = 0%**
 * （证据：本机 E2E 报告 `reports/4552-a1-real-e2e.md` §6（`reports/` 被 .gitignore 忽略，未入库））。
 * 本 channel 虽 `@deprecated` 但仍是 opt-in 可启用实现，所以同样必须修。
 * 失败即 reject → 由 `send()` 层 swallow + warn，**绝不降级成 user**。
 *
 * ## 失败处理
 *
 * - spawn 失败 / exit code != 0 → swallow（log warn，notification 失败不污染 Plugin 主流程）
 */

import { spawn } from "node:child_process";
import { createLogger } from "../log-trace/logger";
import type {
  EnvContextLike,
  NotificationChannel,
  NotificationOptions,
  NotificationSendExtras,
} from "./notification-channel";
import { normalizeLarkAtMentions } from "../lark-mention-utils";

const logger = createLogger("plugin:notification:lark-cli");

/**
 * Lark-cli Notification Channel（legacy / @deprecated）
 *
 * 行为：
 * - 通过 spawn lark-cli 子进程投递到飞书
 * - 路由依据 envContext.replyChannel
 *
 * @example
 * ```ts
 * // opt-in legacy channel
 * component.setNotificationChannels([
 *   new LarkCliNotificationChannel(),
 *   EventBusNotificationChannel(), // 兜底
 * ]);
 * ```
 */
export class LarkCliNotificationChannel implements NotificationChannel {
  readonly name = "lark-cli";

  /**
   * 仅当 replyChannel 含 lark 类型且有 chatId/messageId 时路由
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
    if (!channel.type || !channel.type.toLowerCase().includes("lark")) {
      return false;
    }
    if (!channel.chatId && !channel.messageId) {
      return false;
    }
    return true;
  }

  /**
   * spawn lark-cli 发飞书消息
   */
  async send(
    options: NotificationOptions,
    extras: NotificationSendExtras,
    envContext: EnvContextLike
  ): Promise<void> {
    const replyChannel = envContext.replyChannel;
    if (!replyChannel) {
      logger.debug(
        `[lark-cli] No replyChannel for plugin '${extras.pluginName}', skip`
      );
      return;
    }

    const chatId = replyChannel.chatId;
    const messageId = replyChannel.messageId;
    const profile = replyChannel.profile;

    if (!chatId && !messageId) {
      logger.debug(
        `[lark-cli] replyChannel has no chatId/messageId for plugin '${extras.pluginName}', skip`
      );
      return;
    }

    const message = `${options.title}\n\n${options.content}`;

    try {
      await this.spawnLarkMessage({ chatId, messageId, content: message, profile });
      logger.info(
        `[lark-cli] Notification sent for plugin '${extras.pluginName}': ${options.type}`
      );
    } catch (err) {
      logger.warn(
        `[lark-cli] Failed to send notification for plugin '${extras.pluginName}' (${options.type}): ${err}`
      );
      // swallow - notification failure must not break plugin main flow
    }
  }

  /**
   * spawn `lark-cli im +messages-{reply,send}` 子进程
   */
  private spawnLarkMessage(options: {
    chatId?: string;
    messageId?: string;
    content: string;
    profile?: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const { chatId, messageId, content, profile } = options;

      let args: string[];

      // ★ Task #3993：规范化 @-mention 语法（自闭合 → 空闭合）
      const normalizedContent = normalizeLarkAtMentions(content);

      if (messageId) {
        args = [
          "im",
          "+messages-reply",
          "--message-id",
          messageId,
          "--markdown",
          normalizedContent,
          "--as",
          "bot",
        ];
      } else {
        args = [
          "im",
          "+messages-send",
          "--chat-id",
          chatId!,
          "--markdown",
          normalizedContent,
          // ★ Task #4557：显式 bot 身份（原实现漏了 → 默认 user 身份 →
          // 被 lark-cli 自己的 event consume 回灌成「用户消息」→ 再跑一次
          // 完整 agent run。Task #4552 实测回灌率 45%，修好后 0%）。
          // 失败即 reject，绝不降级成 user。
          "--as",
          "bot",
        ];
      }

      // profile 注入 (#1637): 多 appId 场景下指定 lark-cli profile
      if (profile) {
        args.unshift("--profile", profile);
      }

      const proc = spawn("lark-cli", args, {
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
          reject(new Error(`lark-cli exited with code ${code}: ${stderr}`));
        }
      });

      proc.on("error", (error) => {
        reject(error);
      });
    });
  }
}
