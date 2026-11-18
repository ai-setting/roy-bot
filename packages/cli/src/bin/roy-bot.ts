#!/usr/bin/env node

/**
 * @roy-bot/cli - CLI entry point
 */

import { runCli } from "../cli";

runCli().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
