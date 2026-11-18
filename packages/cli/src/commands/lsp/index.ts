/**
 * @fileoverview LSP Command Group
 */

import { CommandModule } from "yargs";
import { LspInstallCommand } from "./install";
import { LspListCommand } from "./list";
import { LspCheckCommand } from "./check";

/**
 * LSP Command
 */
export const LspCommand: CommandModule = {
  command: "lsp",
  describe: "Manage LSP (Language Server Protocol) servers",

  builder: (yargs) =>
    yargs
      .command(LspInstallCommand)
      .command(LspListCommand)
      .command(LspCheckCommand)
      .demandCommand()
      .help(),

  handler: () => {
    console.log("Use 'roy-bot lsp --help' for usage information");
  },
};

export { LspInstallCommand } from "./install";
export { LspListCommand } from "./list";
export { LspCheckCommand } from "./check";
