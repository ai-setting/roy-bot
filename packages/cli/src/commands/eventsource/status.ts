/**
 * @fileoverview EventSource Status Command
 * 
 * 查看事件源状态
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { EventSourceComponentInterface, EventSourceStatus } from "@ai-setting/roy-bot-core";

export interface EventSourceStatusOptions {
  id?: string;
  config?: string;
  json?: boolean;
}

const STATUS_COLORS: Record<EventSourceStatus, (text: string) => string> = {
  created: chalk.gray,
  starting: chalk.yellow,
  running: chalk.green,
  stopping: chalk.yellow,
  stopped: chalk.gray,
  error: chalk.red,
};

const STATUS_ICONS: Record<EventSourceStatus, string> = {
  created: "○",
  starting: "◐",
  running: "●",
  stopping: "◑",
  stopped: "○",
  error: "✗",
};

const STATUS_LABELS: Record<EventSourceStatus, string> = {
  created: "已创建",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  error: "错误",
};

export const EventSourceStatusCommand: CommandModule<object, EventSourceStatusOptions> = {
  command: "status [id]",
  aliases: ["stat"],
  describe: "查看事件源状态",

  builder: (yargs) =>
    yargs
      .positional("id", {
        describe: "事件源 ID（可选，查看所有或单个）",
        type: "string",
      })
      .option("json", {
        alias: "j",
        describe: "JSON 格式输出",
        type: "boolean",
        default: false,
      }),

  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: args.config });
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

      // 如果指定了 ID，查看单个
      if (args.id) {
        const sources = esComponent.list();
        const matchedSource = sources.find(
          (s) => s.id === args.id || s.id.startsWith(args.id!)
        );

        if (!matchedSource) {
          output.error(`事件源不存在: ${args.id}`);
          process.exit(1);
        }

        const status = esComponent.getStatus(matchedSource.id) || "unknown";
        const statusColor = STATUS_COLORS[status as EventSourceStatus] || chalk.gray;

        if (args.json) {
          output.json({
            id: matchedSource.id,
            name: matchedSource.name,
            type: matchedSource.type,
            status,
            enabled: matchedSource.enabled,
            eventTypes: matchedSource.eventTypes,
            config: {
              command: matchedSource.command,
              interval: matchedSource.interval,
              url: matchedSource.url,
            },
          });
          return;
        }

        output.log(chalk.bold("事件源详情"));
        output.log("─".repeat(50));
        output.log(`  ID:       ${chalk.gray(matchedSource.id)}`);
        output.log(`  Name:     ${chalk.cyan(matchedSource.name)}`);
        output.log(`  Type:     ${chalk.cyan(matchedSource.type)}`);
        output.log(`  Status:   ${statusColor(`${STATUS_ICONS[status as EventSourceStatus]} ${STATUS_LABELS[status as EventSourceStatus]}`)}`);
        output.log(`  Enabled:  ${matchedSource.enabled ? chalk.green("是") : chalk.gray("否")}`);
        
        if (matchedSource.eventTypes?.length) {
          output.log(`  Events:   ${chalk.gray(matchedSource.eventTypes.join(", "))}`);
        }
        if (matchedSource.command) {
          output.log(`  Command:  ${chalk.gray(matchedSource.command)}`);
        }
        if (matchedSource.interval) {
          output.log(`  Interval: ${chalk.gray(`${matchedSource.interval}ms`)}`);
        }
        if (matchedSource.url) {
          output.log(`  URL:      ${chalk.gray(matchedSource.url)}`);
        }
        output.log("");
        return;
      }

      // 查看所有状态
      const sources = esComponent.list();

      if (sources.length === 0) {
        output.log(chalk.yellow("没有配置的事件源"));
        return;
      }

      if (args.json) {
        const sourcesWithStatus = sources.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          status: esComponent.getStatus(s.id) || "unknown",
          enabled: s.enabled,
        }));
        output.json({ sources: sourcesWithStatus, count: sources.length });
        return;
      }

      output.log(chalk.bold("事件源状态概览"));
      output.log("─".repeat(60));

      for (const source of sources) {
        const status = esComponent.getStatus(source.id) || "unknown";
        const statusColor = STATUS_COLORS[status as EventSourceStatus] || chalk.gray;
        const icon = STATUS_ICONS[status as EventSourceStatus] || "?";
        const label = STATUS_LABELS[status as EventSourceStatus] || status;

        output.log("");
        output.log(`  ${chalk.cyan(source.name)} ${chalk.gray(`(${source.type})`)}`);
        output.log(`  └─ Status: ${statusColor(`${icon} ${label}`)}`);
        output.log(`     ID: ${chalk.gray(source.id.substring(0, 8))}...`);
      }

      output.log("");
      const runningCount = sources.filter(
        (s) => esComponent.getStatus(s.id) === "running"
      ).length;
      output.log(
        chalk.green(`✅ ${runningCount}/${sources.length} 运行中`)
      );

    } finally {
      await envService.dispose();
    }
  },
};
