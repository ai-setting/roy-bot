/**
 * @fileoverview MCP Reload Command
 * 
 * 命令：roy mcp reload
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { McpComponent } from "@ai-setting/roy-bot-core";

interface ReloadOptions {
  config?: string;
}

export const ReloadCommand: CommandModule<object, ReloadOptions> = {
  command: "reload",
  aliases: ["r"],
  describe: "重新加载 MCP 服务器",
  
  builder: (yargs) =>
    yargs,
  
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
      const mcpComponent = env.getComponent("mcp") as McpComponent | undefined;

      if (!mcpComponent) {
        output.error("McpComponent not available");
        process.exit(1);
      }

      output.log(chalk.cyan("Reloading MCP servers..."));

      await mcpComponent.reload();

      const servers = mcpComponent.listServers();
      const connected = servers.filter(s => s.status === "connected").length;
      const errors = servers.filter(s => s.status === "error").length;

      output.log(chalk.green(`✓ Reloaded ${servers.length} servers`));
      
      if (connected > 0) {
        output.log(chalk.green(`  • ${connected} connected`));
      }
      
      if (errors > 0) {
        output.warn(`  • ${errors} failed`);
        for (const server of servers.filter(s => s.status === "error")) {
          output.log(chalk.gray(`    - ${server.name}: ${server.error}`));
        }
      }
    } catch (error) {
      output.error(`Failed to reload MCP servers: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
