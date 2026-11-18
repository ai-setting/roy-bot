/**
 * @fileoverview LSP Install Command
 */

import { CommandModule } from "yargs";
import { createInstaller, LSP_PACKAGES } from "@ai-setting/roy-bot-coder-harness";

/**
 * 创建 lsp install 命令
 */
export const LspInstallCommand: CommandModule = {
  command: "install [languages...]",
  describe: "Install LSP server dependencies",

  builder: (yargs) =>
    yargs
      .positional("languages", {
        describe: "Languages to install (e.g., typescript, python)",
        type: "string",
      })
      .option("global", {
        alias: "g",
        type: "boolean",
        default: true,
        description: "Install globally",
      })
      .option("local", {
        alias: "l",
        type: "string",
        description: "Install to local path",
      })
      .option("all", {
        alias: "a",
        type: "boolean",
        default: false,
        description: "Install all available LSP servers",
      })
      .option("check", {
        type: "boolean",
        default: false,
        description: "Only check if installed, don't install",
      })
      .option("verbose", {
        alias: "v",
        type: "boolean",
        default: false,
        description: "Verbose output",
      }),

  handler: async (argv) => {
    const installer = createInstaller({
      target: argv.local ? "local" : "global",
      installPath: argv.local as string,
    });

    const languages = argv.languages as string[] | undefined;

    if (argv.check) {
      // Check mode
      const installed = installer.getInstalledPackages();
      const missing = installer.getMissingDependencies();
      
      console.log("\n📦 LSP Server Status\n");
      
      for (const pkg of LSP_PACKAGES) {
        const isInstalled = installed.includes(pkg.serverId);
        const status = isInstalled ? "✓ installed" : "✗ not installed";
        console.log(`  ${status.padEnd(20)} ${pkg.serverId.padEnd(12)} ${pkg.description}`);
      }
      
      console.log(`\n${installed.length}/${LSP_PACKAGES.length} installed\n`);
      
      if (missing.length > 0) {
        console.log("Run 'roy-bot lsp install' to install missing servers\n");
      }
      return;
    }

    if (languages && languages.length > 0) {
      // Install specific languages
      const success: string[] = [];
      const failed: string[] = [];

      for (const lang of languages) {
        const langLower = lang.toLowerCase();
        if (installer.install(langLower, { verbose: !!argv.verbose })) {
          success.push(langLower);
        } else {
          failed.push(langLower);
        }
      }

      console.log(`\n📦 Installation Summary\n`);
      if (success.length > 0) {
        console.log(`  ✓ Installed: ${success.join(", ")}`);
      }
      if (failed.length > 0) {
        console.log(`  ✗ Failed: ${failed.join(", ")}`);
      }
      console.log();
    } else if (argv.all) {
      // Install all
      console.log("\n📦 Installing all LSP servers...\n");
      const result = installer.installAll({ verbose: !!argv.verbose });
      
      console.log(`\n📦 Installation Summary\n`);
      if (result.success.length > 0) {
        console.log(`  ✓ Installed: ${result.success.join(", ")}`);
      }
      if (result.failed.length > 0) {
        console.log(`  ✗ Failed: ${result.failed.join(", ")}`);
      }
      console.log();
    } else {
      // Show available
      console.log("\n📦 Available LSP Servers\n");
      for (const pkg of LSP_PACKAGES) {
        const isInstalled = installer.isInstalled(pkg.npmPackage);
        const status = isInstalled ? "✓" : "○";
        console.log(`  ${status} ${pkg.serverId.padEnd(12)} ${pkg.description}`);
      }
      console.log("\n  Run 'roy-bot lsp install <language>' to install specific servers");
      console.log("  Run 'roy-bot lsp install --all' to install all servers\n");
    }
  },
};
