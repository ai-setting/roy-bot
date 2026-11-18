/**
 * @fileoverview EventSource Update Command
 *
 * 更新已注册的事件源配置
 *
 * 注意：
 * - 只更新指定的字段，其他字段保留
 * - type 字段不允许修改（需通过 unregister + register 重新创建）
 * - 如果事件源正在运行，会先停止（不自动重启，由用户手动 start 生效）
 *
 * v0.14 (Task #2129): bounty-im 严格邮箱-only
 * - --email: 单独更新注册邮箱
 * - --profile: 从 ~/.config/bounty/profiles/<name>.json 读 email + api_base 批量更新
 * - --address 选项已彻底移除（v0.12/v0.13 不再支持）
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { EventSourceComponentInterface, EventSourceConfig } from "@ai-setting/roy-bot-core";
import {
  addServerUrlOption,
  resolveServerUrl,
} from "./server-url-option";
import { readBountyProfile, profileToWsUrl } from "../../lib/bounty-profile-reader";
import {
  parseScheduleOptionAllowEmpty,
  validateScheduleEntries,
  mergeEventSourceOptions,
} from "./schedule-option";

export interface EventSourceUpdateOptions {
  id: string;
  config?: string;
  interval?: number;
  eventTypes?: string;
  command?: string;
  url?: string;
  cron?: string;
  prompt?: string;
  name?: string;
  enabled?: boolean;
  /**
   * Agent IM 注册邮箱（bounty-im 类型用，v0.14 strict email-only）
   */
  email?: string;
  /**
   * Profile 名称（bounty-im 类型用，与 --email 互斥）
   */
  profile?: string;
  imServerUrl?: string;
  /**
   * 是否跳过 TLS 证书校验（bounty-im 类型用）
   */
  tlsSkipVerify?: boolean;
}

/**
 * 找到匹配的事件源（支持前缀匹配）
 */
function findSource(
  esComponent: EventSourceComponentInterface,
  id: string,
): { source: EventSourceConfig; fullId: string } | null {
  const sources = esComponent.list();
  const matched = sources.find(
    (s) => s.id === id || s.id.startsWith(id),
  );
  if (!matched) return null;
  return { source: matched, fullId: matched.id };
}

export const EventSourceUpdateCommand: CommandModule<object, object> = {
  command: "update <id>",
  describe: "更新事件源配置（部分更新，type 不可改）",

  builder: (yargs) =>
    addServerUrlOption(
      yargs
        .positional("id", {
          describe: "事件源 ID（支持前缀匹配）",
          type: "string",
          demandOption: true,
        })
        .option("name", {
          describe: "事件源名称",
          type: "string",
        })
        .option("interval", {
          alias: "i",
          describe: "定时器间隔（毫秒）",
          type: "number",
        })
        .option("event-types", {
          alias: "e",
          describe: "事件类型过滤（逗号分隔）",
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
            "'im.message.receive_v1,card.action.trigger'）；一个 key = 一个 consume 子进程",
          type: "string",
        })
        .option("url", {
          alias: "u",
          describe: "WebSocket URL",
          type: "string",
        })
        .option("cron", {
          describe: "Cron 表达式",
          type: "string",
        })
        .option("prompt", {
          describe: "自定义 prompt 消息（timer 类型）",
          type: "string",
        })
        .option("schedule", {
          describe:
            "固定时刻触发配置（timer 类型），JSON 数组：" +
            '\'[{"time":"10:00","prompt":"早报"},{"time":"20:00","prompt":"晚报"}]\'。' +
            "与 --interval 互斥。",
          type: "string",
        })
        .option("session-id", {
          describe:
            "事件路由到的 session ID（timer 类型 schedule 模式）。" +
            "用于让定时总结跑在独立 session，而不是主会话。",
          type: "string",
        })
        .option("enabled", {
          describe: "是否启用",
          type: "boolean",
        })
        .option("email", {
          describe: "Agent IM 注册邮箱（bounty-im 类型用，v0.14 strict email-only；与 --profile 互斥）",
          type: "string",
        })
        .option("profile", {
          describe: "Profile 名称（bounty-im 类型用，从 ~/.config/bounty/profiles/<name>.json 读取并自动更新 email + imServerUrl）",
          type: "string",
        })
        .option("status-notifications", {
          type: "boolean",
          describe:
            "是否推送状态通知文本消息（true = 恢复旧文本推送；false = 只发卡片）（Task #5360）",
        })
        .option("tls-skip-verify", {
          describe: "跳过 TLS 证书校验（bounty-im 类型用，wss:// 自签名场景，生产环境不推荐）",
          type: "boolean",
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

      // 查找事件源（支持前缀匹配）
      const match = findSource(esComponent, a.id);
      if (!match) {
        output.error(`❌ 事件源不存在: ${a.id}`);
        const all = esComponent.list();
        if (all.length > 0) {
          output.info("");
          output.info(chalk.gray("可用的事件源:"));
          for (const s of all) {
            output.info(`  - ${s.id.substring(0, 8)}: ${s.name} (${s.type})`);
          }
        }
        process.exit(1);
      }

      // v0.14: --email 和 --profile 互斥（仅 bounty-im 类型生效）
      if (match.source.type === "bounty-im" && a.email && a.profile) {
        output.error(
          chalk.red(
            `\n✗ --email 和 --profile 互斥（profile 文件已包含 email）。请选择其一。\n`,
          ),
        );
        process.exit(1);
      }

      // v0.14: --profile 解析 → 批量更新 email + imServerUrl
      let profileEmail: string | undefined;
      let profileApiBase: string | undefined;
      if (a.profile && match.source.type === "bounty-im") {
        const profile = readBountyProfile(a.profile);
        if (!profile) {
          output.error(
            chalk.red(
              `\n✗ Profile '${a.profile}' 不存在或格式错误。期望路径：~/.config/bounty/profiles/${a.profile}.json\n`,
            ),
          );
          process.exit(1);
        }
        profileEmail = profile.email;
        profileApiBase = profile.api_base;
      }

      // 构建 partial（只包含实际传入的字段）
      const partial: Partial<EventSourceConfig> = {};

      if (a.name !== undefined) partial.name = a.name;
      if (a.interval !== undefined) partial.interval = a.interval;
      if (a.eventTypes !== undefined) {
        partial.eventTypes = a.eventTypes.split(",").map((s: string) => s.trim()).filter(Boolean);
      }
      if (a.command !== undefined) partial.command = a.command;
      // ★ Task #4339：lark-cli 多 EventKey（一个 key 一个 consume 子进程）
      if (a.eventKeys !== undefined) {
        partial.eventKeys = String(a.eventKeys)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (a.url !== undefined) partial.url = a.url;
      if (a.cron !== undefined) partial.cron = a.cron;
      if (a.enabled !== undefined) partial.enabled = a.enabled;
      // v0.14: --email 直接更新顶层 email 字段
      if (a.email !== undefined) partial.email = a.email;
      // v0.14: --profile 触发批量更新（email + imServerUrl）
      if (profileEmail !== undefined) partial.email = profileEmail;
      if (a.serverUrl !== undefined || a.imServerUrl !== undefined || profileApiBase !== undefined) {
        // 优先级: --server-url > --im-server-url (向后兼容 alias) > profile.api_base > BOUNTY_SERVER_URL env > fallback
        // 仅当用户显式传入时更新（保持 partial update 语义）
        const envUrl = process.env.BOUNTY_SERVER_URL;
        const fallback = envUrl || "http://localhost:8787";
        if (a.serverUrl !== undefined || a.imServerUrl !== undefined) {
          partial.imServerUrl = resolveServerUrl(
            a.serverUrl ?? a.imServerUrl,
            fallback,
          );
        } else if (profileApiBase !== undefined) {
          // profile 提供 api_base → 自动转 ws:// scheme + 补 /ws path
          partial.imServerUrl = profileToWsUrl(profileApiBase);
        }
      }
      if (a.tlsSkipVerify !== undefined) partial.tlsSkipVerify = a.tlsSkipVerify === true;
      // ★ Task #5360（补充需求）：状态通知文本开关。
      //   不传 ⇒ 不改该键（partial 语义）；传 => 显式写入布尔（含 false）。
      if (a.statusNotifications !== undefined) {
        partial.statusNotifications = a.statusNotifications === true;
      }

      // ★ review N3：已有 schedule 的源传 --interval → 中文友好提示。
      //   core 的 validateConfig 也会报（英文），但 CLI 先拦更友好。
      const existingSchedule = (match.source.options as Record<string, unknown> | undefined)?.schedule;
      if (a.interval !== undefined && existingSchedule !== undefined && a.schedule === undefined) {
        output.error(
          chalk.red(
            `\n✗ 该事件源已配置 schedule（固定时刻触发），与 --interval 互斥。\n` +
              `\n  请改用 --schedule 更新，或先用 --schedule '[]' 清除后再设 --interval。\n`,
          ),
        );
        process.exit(1);
      }

      // ★ Task #4815：options 累积式合并。
      //   旧写法是三段各自 `partial.options = { ...existingOptions, X }`，
      //   每段都以 match.source.options 为基线 → 同时传 --prompt/--schedule/--session-id
      //   时，后面的会把前面的覆盖掉（--schedule 被静默丢弃）。
      //   现在改成：以 existingOptions 为基线，一次性合并所有要改的 key。
      const existingOptions = (match.source.options as Record<string, unknown> | undefined) ?? {};
      const optionsPatch: Record<string, unknown> = {};
      // ★ review N1：显式标记「用户明确要求清空 schedule」。
      //   不能靠 `optionsPatch.schedule === undefined` 判断 —— 用户**没传** --schedule 时
      //   它同样是 undefined，会误删已有 schedule（静默丢配置 + 行为退化）。
      let scheduleCleared = false;
      if (a.prompt !== undefined) {
        // 与 add.ts 一致：prompt 存到 options.prompt
        optionsPatch.prompt = a.prompt;
      }
      // ★ Task #4815：--schedule 存到 options.schedule（覆盖式）
      if (a.schedule !== undefined) {
        // ★ M-7：允许空数组 → 清除 schedule（退回 interval 模式）
        const schedule = parseScheduleOptionAllowEmpty(a.schedule);
        if (schedule === undefined) {
          output.error(
            chalk.red(
              `\n✗ --schedule 必须是合法的 JSON 数组，例如：` +
                `\n  '[{"time":"10:00","prompt":"早报"}]'\n` +
                `\n  （传 '[]' 可清除 schedule，退回 interval 模式）\n`,
            ),
          );
          process.exit(1);
        }
        // ★ Task #4815：schedule 语义校验（time 格式 / prompt 必填）
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
        // ★ M-1：--schedule 与 --interval 互斥（与 add.ts 对称的前置校验）
        if (a.interval !== undefined) {
          output.error(
            chalk.red(
              `\n✗ --schedule 与 --interval 互斥。` +
                `\n  固定时刻触发用 --schedule；周期性触发用 --interval。\n`,
            ),
          );
          process.exit(1);
        }
        if (schedule.length === 0) {
          // 清空 schedule（显式意图）
          scheduleCleared = true;
          // ★ review N2：清空 schedule 后若没有 interval，timer 会回落到
          //   默认 10 分钟 interval 模式（周期触发默认 SelfReminder）——
          //   用户以为「停掉定时」，实际变成周期噪音。
          //   这里要求显式指定 --interval，避免意外行为变化。
          if (a.interval === undefined && match.source.interval === undefined) {
            output.error(
              chalk.red(
                `\n✗ 清除 schedule 需要同时指定 --interval（毫秒）。` +
                  `\n  否则 timer 会回落到默认 interval 模式（每 10 分钟触发一次默认提醒）。\n` +
                  `\n  示例：--schedule '[]' --interval 3600000\n` +
                  `\n  若只是想停用该事件源，用 'roy-bot eventsource remove <id>'。\n`,
              ),
            );
            process.exit(1);
          }
        } else {
          optionsPatch.schedule = schedule;
          // ★ schedule 与 interval 互斥：更新 schedule 时清掉 interval
          if (partial.interval === undefined && match.source.interval !== undefined) {
            partial.interval = undefined;
          }
        }
      }
      // ★ Task #4815：--session-id 存到 options.sessionId
      if (a.sessionId !== undefined) {
        optionsPatch.sessionId = a.sessionId;
      }
      if (Object.keys(optionsPatch).length > 0 || scheduleCleared) {
        partial.options = mergeEventSourceOptions(existingOptions, optionsPatch);
        // ★ M-7 / review N1：只有**用户明确要求清空**时才删掉 schedule key。
        //   （不能用 `optionsPatch.schedule === undefined` 判断——用户没传 --schedule
        //   时它也是 undefined，会误删已有 schedule。）
        if (scheduleCleared) {
          delete (partial.options as Record<string, unknown>).schedule;
        }
      }

      if (Object.keys(partial).length === 0) {
        output.error("❌ 请至少提供一个要更新的字段（如 --interval, --prompt 等）");
        process.exit(1);
      }

      // 调用 component.update
      try {
        const result = await (esComponent as any).update(match.fullId, partial);

        // 友好输出
        output.success(chalk.green(`✅ 事件源已更新: ${match.source.name}`));
        output.log("");
        output.log(chalk.bold("修改字段:"));
        const before = match.source;
        const after = result.updated;
        for (const field of result.fields as string[]) {
          const beforeVal = JSON.stringify((before as any)[field] ?? (before as any).options?.[field]);
          const afterVal = JSON.stringify((after as any)[field] ?? (after as any).options?.[field]);
          output.log(
            `  ${chalk.cyan(field)}: ${chalk.gray(beforeVal)} ${chalk.gray("→")} ${chalk.green(afterVal)}`,
          );
        }
        output.log("");

        if (result.wasRunning) {
          output.info(chalk.yellow(`⚠️  事件源在更新前正在运行，已自动停止。请使用 'roy-bot eventsource start ${match.fullId.substring(0, 8)}' 手动启动以应用新配置。`));
        }
      } catch (error) {
        output.error(`❌ 更新失败: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }

    } finally {
      await envService.dispose();
    }
  },
};
