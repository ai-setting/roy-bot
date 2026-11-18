/**
 * @fileoverview LSP Check Command
 */

import { CommandModule } from "yargs";
import { createInstaller, LSP_PACKAGES, LSPConfigLoader } from "@ai-setting/roy-bot-coder-harness";

/**
 * 创建 lsp check 命令
 */
export const LspCheckCommand: CommandModule = {
  command: "check [server-id]",
  describe: "Check LSP server status and configuration",

  builder: (yargs) =>
    yargs
      .positional("server-id", {
        describe: "Check specific server (e.g., typescript)",
        type: "string",
      })
      .option("verbose", {
        alias: "v",
        type: "boolean",
        default: false,
        description: "Show detailed information",
      })
      .option("json", {
        type: "boolean",
        default: false,
        description: "Output as JSON",
      }),

  handler: async (argv) => {
    const installer = createInstaller();
    const configLoader = new LSPConfigLoader();
    const config = configLoader.load();

    if (argv.json) {
      const servers = argv.serverId 
        ? LSP_PACKAGES.filter((p) => p.serverId === argv.serverId)
        : LSP_PACKAGES;

      const result = {
        config: config.toJSON(),
        servers: servers.map((pkg) => ({
          serverId: pkg.serverId,
          npmPackage: pkg.npmPackage,
          description: pkg.description,
          installed: installer.isInstalled(pkg.npmPackage),
          verify: installer.verify(pkg.serverId),
        })),
      };
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("\n⚙️  LSP Configuration\n");
    console.log(`  Config Path: ${configLoader.getConfigPath()}`);
    console.log(`  Install Path: ${config.installPath}`);
    console.log(`  Preload: ${config.preload ? "enabled" : "disabled"}`);
    console.log(`  Idle Timeout: ${config.idleTimeout}ms`);

    const servers = argv.serverId 
      ? LSP_PACKAGES.filter((p) => p.serverId === argv.serverId)
      : LSP_PACKAGES;

    console.log("\n📦 LSP Servers Status\n");

    let hasIssues = false;
    for (const pkg of servers) {
      const verify = installer.verify(pkg.serverId);
      const installed = verify.installed ? "✓ Installed" : "✗ Not installed";
      
      console.log(`  ${pkg.serverId.padEnd(12)} ${pkg.description}`);
      console.log(`    ${installed}`);
      console.log(`    Package: ${pkg.npmPackage}`);

      if (verify.binary) {
        console.log(`    Binary in PATH: ${verify.binary}`);
      } else if (verify.installed) {
        console.log(`    Warning: Installed but not in PATH`);
        hasIssues = true;
      }
    }

    console.log();
    if (hasIssues) {
      console.log("⚠️  Some servers are installed but not in PATH.");
      console.log("    Run 'npm config get prefix' to check npm global path\n");
    }
  },
};
