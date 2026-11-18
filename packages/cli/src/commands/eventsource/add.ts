/**
 * @fileoverview EventSource Add Command
 *
 * 添加新的事件源
 *
 * v0.14 (Task #2129): bounty-im 严格邮箱-only
 * - --email: v0.14 唯一入参（注册邮箱）
 * - --profile: 从 ~/.config/bounty/profiles/<name>.json 读 email + agent_id + api_base
 * - --email 和 --profile 互斥（profile 已包含 email）
 * - --address 选项已彻底移除（v0.12/v0.13 不再支持）
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import { generateId } from "@ai-setting/roy-bot-core";
import type { EventSourceComponentInterface } from "@ai-setting/roy-bot-core";
import {
  addServerUrlOption,
  resolveServerUrl,
} from "./server-url-option";
import { readBountyProfile, profileToWsUrl } from "../../lib/bounty-profile-reader";
import {
  parseScheduleOption,
  validateScheduleEntries,
  mergeEventSourceOptions,
} from "./schedule-option";

// EventSourceType 改为 string，支持任意类型
type EventSourceType = string;

// 生成事件源 ID
function uuid(): string {
  return generateId();
}

export interface EventSourceAddOptions {
  name: string;
  type: EventSourceType;
  eventTypes?: string;
  command?: string;
  url?: string;
  interval?: number;
  cron?: string;
  profile?: string;
  /**
   * Agent IM 注册邮箱（bounty-im 类型用，v0.14 strict email-only）
   */
  email?: string;
  /**
   * IM Server WebSocket URL（bounty-im 类型用，如 ws://localhost:4005/ws）
   */
  imServerUrl?: string;
  /**
   * 是否跳过 TLS 证书校验（bounty-im 类型用，wss:// 自签名场景）
   *
   * 仅在 imServerUrl 是 wss:// 且服务端用自签名/内部 CA 证书时设为 true。
   * 生产环境不推荐。
   */
  tlsSkipVerify?: boolean;
  /**
   * Mattermost 频道名（bounty-cli 类型用，启动时执行
   * `bounty event consume --channel <name>`）
   */
  channel?: string;
  config?: string;
}

export const EventSourceAddCommand: CommandModule<object, object> = {
  command: "add <name> <type>",
  describe: "添加新的事件源",

  builder: (yargs) =>
    addServerUrlOption(
      yargs
        .positional("name", {
          describe: "事件源名称",
          type: "string",
          demandOption: true,
        })
        .positional("type", {
          describe: "事件源类型（如 lark-cli, wecom-cli, bounty-cli, bounty-im, timer, websocket 或第三方自定义类型）",
          type: "string",
          demandOption: true,
          // 不再硬编码 choices，支持任意类型
        })
        .option("event-types", {
          alias: "e",
          describe: "事件类型过滤（逗号分隔，支持通配符如 im.message.*）",
          type: "string",
        })
        .option("command", {
          alias: "c",
          describe: "执行的命令（lark-cli 类型）",
          type: "string",
        })
        .option("event-keys", {
          describe:
            "lark-cli 要消费的 EventKey 列表（逗号分隔，如 " +
            "'im.message.receive_v1,card.action.trigger'）。" +
            "lark-cli `event consume` 只接受一个 key，多个 key = 多个 consume 子进程",
          type: "string",
        })
        .option("url", {
          alias: "u",
          describe: "WebSocket URL",
          type: "string",
        })
        .option("interval", {
          alias: "i",
          describe: "定时器间隔（毫秒）",
          type: "number",
        })
        .option("cron", {
          describe: "Cron 表达式",
          type: "string",
        })
        .option("profile", {
          describe: "Profile 名称（lark-cli / bounty-im / bounty-cli 类型用，从 ~/.config/bounty/profiles/<name>.json 读取配置；多 appId / 多账户场景必要，参考 #1637）",
          type: "string",
        })
        .option("email", {
          describe: "Agent IM 注册邮箱（bounty-im 类型用，v0.14 strict email-only；与 --profile 互斥）",
          type: "string",
        })
        .option("status-notifications", {
          type: "boolean",
          describe:
            "是否推送状态通知文本消息（默认 false = 只发卡片；true = 恢复旧的文本推送）" +
            "（Task #5360）",
        })
        .option("tls-skip-verify", {
          describe: "跳过 TLS 证书校验（bounty-im 类型用，wss:// 自签名场景，生产环境不推荐）",
          type: "boolean",
          default: false,
        })
        .option("channel", {
          describe: "Mattermost 频道名（bounty-cli 类型用，启动时执行 `bounty event consume --channel <name>`；与 --command 互斥）",
          type: "string",
        })
        .option("bot-id", {
          describe:
            "企业微信智能机器人 BotID（wecom-cli 类型用）。" +
            "在企微管理后台「智能机器人」→ API 模式 → 开启长连接后获取。",
          type: "string",
        })
        .option("secret", {
          describe:
            "企业微信智能机器人 Secret（wecom-cli 类型用，长连接专用密钥）。" +
            "⚠️ 与「接收消息回调地址」模式的 Token/EncodingAESKey 不是同一个东西。",
          type: "string",
        })
        .option("webhook", {
          describe: "企业微信群机器人 webhook URL（wecom-cli 类型用，可选）",
          type: "string",
        })
        .option("prompt", {
          describe: "自定义 prompt 消息（timer 类型，替换默认 SelfReminder 内容）",
          type: "string",
        })
        .option("schedule", {
          describe:
            "固定时刻触发配置（timer 类型），JSON 数组：" +
            '\'[{"time":"10:00","prompt":"早报"},{"time":"17:00","prompt":"午后"},{"time":"20:00","prompt":"晚报"}]\'。' +
            "与 --interval 互斥。",
          type: "string",
        })
        .option("session-id", {
          describe:
            "事件路由到的 session ID（timer 类型 schedule 模式）。" +
            "用于让定时总结跑在独立 session，而不是主会话。",
          type: "string",
        }),
    ),

  async handler(args) {
    const a = args as any;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: a.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const esComponent = env.getComponent("event-source") as unknown as EventSourceComponentInterface | undefined;

      if (!esComponent) {
        output.error("EventSourceComponent not available");
        process.exit(1);
      }

      // 解析事件类型
      const eventTypes = a.eventTypes?.split(",").map((s: string) => s.trim());

      // ★ Task #4339：lark-cli 多 EventKey（一个 key 一个 consume 子进程）
      const eventKeys: string[] | undefined =
        typeof a.eventKeys === "string"
          ? (a.eventKeys as string).split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
      if (eventKeys && eventKeys.some((k: string) => k.includes("*"))) {
        output.error(
          chalk.red(
            `\n✗ --event-keys 不支持通配符（如 im.*）：lark-cli event consume 只接受精确 EventKey。\n` +
              `  用 \`lark-cli event list\` 查可用 key。\n`,
          ),
        );
        process.exit(1);
      }

      // v0.14: bounty profile 解析（仅 bounty-im 类型）
      // 优先级：--profile 提供的 profile.email > --email
      let resolvedEmail: string | undefined = a.email;
      let resolvedProfileName: string | undefined = a.profile;
      let profileApiBase: string | undefined;

      if (a.type === "bounty-im") {
        // 互斥校验：--email 和 --profile 不能同时用（profile 已包含 email）
        if (a.email && a.profile) {
          output.error(
            chalk.red(
              `\n✗ --email 和 --profile 互斥（profile 文件已包含 email）。请选择其一。\n`,
            ),
          );
          process.exit(1);
        }
        if (a.profile) {
          const profile = readBountyProfile(a.profile);
          if (!profile) {
            output.error(
              chalk.red(
                `\n✗ Profile '${a.profile}' 不存在或格式错误。期望路径：~/.config/bounty/profiles/${a.profile}.json\n`,
              ),
            );
            process.exit(1);
          }
          resolvedEmail = profile.email;
          profileApiBase = profile.api_base;
        }
      }

      // 解析 server URL
      // 优先级（bounty-im 类型）：
      //   --server-url/--im-server-url > profile.api_base > BOUNTY_SERVER_URL env > http://localhost:8787 (fallback)
      // 优先级（其他类型）：
      //   --server-url/--im-server-url > BOUNTY_SERVER_URL env > http://localhost:8787 (fallback)
      const envUrl = process.env.BOUNTY_SERVER_URL;
      const fallback = envUrl || "http://localhost:8787";
      let resolvedServerUrl: string;
      if (a.serverUrl || a.imServerUrl) {
        resolvedServerUrl = resolveServerUrl(a.serverUrl || a.imServerUrl, fallback);
      } else if (a.type === "bounty-im" && profileApiBase) {
        // profile 提供 api_base → 自动转 ws:// scheme + 补 /ws path
        resolvedServerUrl = profileToWsUrl(profileApiBase);
      } else {
        resolvedServerUrl = resolveServerUrl(undefined, fallback);
      }

      // bounty-cli 校验：--channel 必填（除非用户给了 --command 覆盖默认行为）
      if (a.type === "bounty-cli") {
        if (!a.channel && !a.command) {
          output.error(
            chalk.red(
              `\n✗ bounty-cli 类型需要 --channel <频道名>（或 --command 覆盖默认命令）\n`,
            ),
          );
          process.exit(1);
        }
      }

      // ★ Task #5142：wecom-cli 校验：--bot-id 与 --secret 必填
      //   （长连接模式必需的两项凭证；缺了就无法订阅 aibot_subscribe）
      if (a.type === "wecom-cli") {
        const missing: string[] = [];
        if (!a.botId) missing.push("--bot-id");
        if (!a.secret) missing.push("--secret");
        if (missing.length > 0) {
          output.error(
            chalk.red(
              `\n✗ wecom-cli 类型需要 ${missing.join(" 和 ")}\n` +
                `  在企微管理后台「智能机器人」→ API 模式 → 开启「长连接」后获取 BotID / Secret。\n` +
                `  注意：Secret 是长连接专用密钥，与「接收消息回调地址」模式的 Token/EncodingAESKey 不同。\n`,
            ),
          );
          process.exit(1);
        }
      }

      // ★ Task #4815：解析 --schedule（timer 固定时刻多触发）
      const schedule = parseScheduleOption(a.schedule);
      if (a.schedule !== undefined && schedule === undefined) {
        output.error(
          chalk.red(
            `\n✗ --schedule 必须是合法的 JSON 数组，例如：` +
              `\n  '[{"time":"10:00","prompt":"早报"}]'\n`,
          ),
        );
        process.exit(1);
      }
      // ★ Task #4815：schedule 语义校验（time 格式 / prompt 必填）
      //   不在 CLI 层校验的话，非法配置会在 register() 里抛栈。
      if (schedule !== undefined) {
        const scheduleErrors = validateScheduleEntries(schedule);
        if (scheduleErrors.length > 0) {
          output.error(
            chalk.red(
              `\n✗ --schedule 配置不合法：\n` +
                scheduleErrors.map((e) => `  - ${e}`).join("\n") +
                `\n`,
            ),
          );
          process.exit(1);
        }
      }

      // ★ Task #4815：schedule 与 interval 互斥
      if (schedule !== undefined && a.interval !== undefined) {
        output.error(
          chalk.red(
            `\n✗ --schedule 与 --interval 互斥。` +
              `\n  固定时刻触发用 --schedule；周期性触发用 --interval。\n`,
          ),
        );
        process.exit(1);
      }

      // 构建 options（prompt / schedule / sessionId 统一放这里）
      const eventSourceOptions: Record<string, unknown> = {};
      if (a.prompt) eventSourceOptions.prompt = a.prompt;
      if (schedule !== undefined) eventSourceOptions.schedule = schedule;
      if (a.sessionId) eventSourceOptions.sessionId = a.sessionId;
      const mergedOptions = mergeEventSourceOptions(undefined, eventSourceOptions);

      // 构建配置
      const config = {
        id: uuid(),
        name: a.name,
        type: a.type as EventSourceType,
        enabled: true,
        eventTypes,
        ...(eventKeys && eventKeys.length > 0 ? { eventKeys } : {}),
        // ★ Task #5360（补充需求）：状态通知文本开关。
        //   不传 ⇒ **不写该键**（默认 false，保持配置文件干净）。
        //   传 => 显式写入布尔值（含 false，保留"显式关"的信息）。
        ...(typeof a.statusNotifications === "boolean"
          ? { statusNotifications: a.statusNotifications }
          : {}),
        command: a.command,
        url: a.url,
        interval: a.interval,
        cron: a.cron,
        profile: a.profile,
        // v0.14: bounty-im identity = email ONLY
        email: resolvedEmail,
        imServerUrl: resolvedServerUrl,
        tlsSkipVerify: a.tlsSkipVerify === true,
        // bounty-cli 类型：把 --channel 透传到 handler（顶级字段）
        ...(a.type === "bounty-cli" && a.channel ? { channel: a.channel } : {}),
        // ★ Task #5142：wecom-cli 类型：把 --bot-id / --secret / --webhook
        //   透传到 handler（顶级字段 + options 双写，保证 readWecomCliConfig
        //   两条读取路径都能拿到）。
        ...(a.type === "wecom-cli"
          ? {
              botId: a.botId,
              secret: a.secret,
              ...(a.webhook ? { webhook: a.webhook } : {}),
            }
          : {}),
        options:
          Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
      };

      // 注册
      esComponent.register(config);

      // 持久化（暂时禁用，等待实现持久化）
      // await esComponent.saveConfig();

      output.success(chalk.green(`事件源 '${a.name}' 添加成功！`));
      output.log("");
      output.log(`  ID: ${chalk.gray(config.id)}`);
      output.log(`  Type: ${chalk.cyan(a.type)}`);
      if (eventTypes?.length) {
        output.log(`  Event Types: ${chalk.gray(eventTypes.join(", "))}`);
      }
      if (a.command) {
        output.log(`  Command: ${chalk.gray(a.command)}`);
      }
      if (a.type === "wecom-cli") {
        output.log(`  Bot ID: ${chalk.gray(a.botId)}`);
        output.log(`  Secret: ${chalk.gray("***（已保存）")}`);
      }
      if (a.interval) {
        output.log(`  Interval: ${chalk.gray(`${a.interval}ms`)}`);
      }
      if (resolvedProfileName) {
        output.log(`  Profile: ${chalk.gray(resolvedProfileName)}`);
      }
      if (resolvedEmail) {
        output.log(`  Email: ${chalk.gray(resolvedEmail)}`);
      }
      if (a.imServerUrl) {
        output.log(`  IM Server URL: ${chalk.gray(a.imServerUrl)}`);
      }
      if (resolvedServerUrl) {
        output.log(`  Server URL: ${chalk.gray(resolvedServerUrl)}`);
      }
      if (a.tlsSkipVerify) {
        output.log(`  TLS Skip Verify: ${chalk.yellow("⚠ true (自签名场景)")}`);
      }
      if (a.prompt) {
        output.log(`  Prompt: ${chalk.gray(a.prompt.length > 60 ? a.prompt.slice(0, 60) + "..." : a.prompt)}`);
      }
      if (schedule !== undefined) {
        const times = schedule.map((s) => s.time).join(", ");
        output.log(`  Schedule: ${chalk.gray(times)}`);
      }
      if (a.sessionId) {
        output.log(`  Session ID: ${chalk.gray(a.sessionId)}`);
      }
      if (a.channel) {
        output.log(`  Channel: ${chalk.gray(a.channel)}`);
      }
      output.log("");
      output.log(chalk.gray(`使用 'roy-bot eventsource start ${config.id.substring(0, 8)}' 启动它。`));

    } finally {
      await envService.dispose();
    }
  },
};
