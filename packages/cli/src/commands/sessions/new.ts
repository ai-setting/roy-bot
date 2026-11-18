/**
 * @fileoverview Sessions New Command
 * 
 * 命令：roy-bot sessions new
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, Session } from "@ai-setting/roy-bot-core";

interface NewOptions {
  title?: string;
  directory?: string;
  active?: boolean;
  json?: boolean;
  config?: string;
}

export const NewCommand: CommandModule<object, NewOptions> = {
  command: "new [options]",
  aliases: ["create"],
  describe: "创建新会话",

  builder: (yargs) =>
    yargs
      .option("title", { alias: "t", type: "string" })
      .option("directory", { alias: "d", type: "string" })
      .option("active", { alias: "s", type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),

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
      const sessionComponent = env.getComponent("session") as SessionComponent | undefined;

      if (!sessionComponent) {
        output.error("SessionComponent not available");
        process.exit(1);
      }

      const session: Session = await sessionComponent.create({
        title: args.title,
        directory: args.directory || process.cwd(),
      });

      if (args.active) {
        await sessionComponent.setActiveSession(session.id);
      }

      if (args.json) {
        output.json({
          success: true,
          session: {
            id: session.id,
            title: session.title,
            directory: session.directory,
            createdAt: new Date(session.createdAt).toISOString(),
          },
        });
      } else {
        output.success(chalk.green("✓") + " Session created: " + session.id);
        output.info("Title: " + session.title);
        output.info("Directory: " + session.directory);
      }
    } catch (error) {
      output.error(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
