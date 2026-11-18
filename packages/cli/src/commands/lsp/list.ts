/**
 * @fileoverview LSP List Command
 */

import { CommandModule } from "yargs";
import { createInstaller, LSP_PACKAGES } from "@ai-setting/roy-bot-coder-harness";

/**
 * 创建 lsp list 命令
 */
export const LspListCommand: CommandModule = {
  command: "list",
  describe: "List installed LSP servers",

  builder: (yargs) =>
    yargs
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
    const installed = installer.getInstalledPackages();

    if (argv.json) {
      const result = LSP_PACKAGES.map((pkg) => ({
        serverId: pkg.serverId,
        npmPackage: pkg.npmPackage,
        description: pkg.description,
        installed: installed.includes(pkg.serverId),
      }));
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("\n📦 LSP Servers\n");

    for (const pkg of LSP_PACKAGES) {
      const isInstalled = installed.includes(pkg.serverId);
      const status = isInstalled ? "✓" : "○";
      const installedText = isInstalled ? "installed" : "not installed";
      
      console.log(`  ${status} ${pkg.serverId.padEnd(12)} ${pkg.description}`);
      console.log(`    ${pkg.npmPackage} - ${installedText}`);
      
      if (argv.verbose && isInstalled) {
        const verify = installer.verify(pkg.serverId);
        if (verify.binary) {
          console.log(`    Binary: ${verify.binary}`);
        }
      }
    }

    console.log(`\n${installed.length}/${LSP_PACKAGES.length} installed\n`);
  },
};
