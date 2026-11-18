/**
 * Resolve MCP local commands and sanitize npm/npx runtime env.
 */

import fs from "fs";
import path from "path";
import {
  ensureFallbackNpmPrefix,
  isUsableNpmPrefix,
} from "./npm-prefix";

const PACKAGE_RUNNERS = new Set(["npx", "npm", "bunx", "yarn"]);

function pathExistsSync(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function extractPackageName(command: string[]): string | undefined {
  if (command.length < 2) {
    return undefined;
  }

  const runner = path.basename(command[0]);

  if (runner === "npx" || runner === "bunx") {
    return command[1];
  }

  if (runner === "npm" && command[1] === "exec") {
    const separatorIndex = command.indexOf("--");
    if (separatorIndex >= 0) {
      return command[separatorIndex + 1];
    }
    return command[2];
  }

  if (runner === "yarn" && command[1] === "dlx") {
    return command[2];
  }

  return undefined;
}

function isPackageRunnerCommand(command: string[]): boolean {
  if (command.length < 2) {
    return false;
  }
  const runner = path.basename(command[0]);
  if (!PACKAGE_RUNNERS.has(runner)) {
    return false;
  }
  if (runner === "npm") {
    return command[1] === "exec";
  }
  if (runner === "yarn") {
    return command[1] === "dlx";
  }
  return true;
}

/**
 * Prefer a locally installed binary over npx/npm exec when available.
 */
export function resolvePackageRunnerCommand(
  command: string[],
  serverDir: string
): string[] {
  if (!isPackageRunnerCommand(command)) {
    return command;
  }

  const packageName = extractPackageName(command);
  if (!packageName) {
    return command;
  }

  const localBin = path.join(serverDir, "node_modules", ".bin", packageName);
  if (pathExistsSync(localBin)) {
    return [localBin];
  }

  return command;
}

/**
 * When npm prefix is broken (common in Cursor remote), point npm/npx
 * at a writable fallback prefix to avoid ENOENT stderr spam.
 */
export function augmentNpmEnvForPackageRunner(
  command: string[],
  env: Record<string, string>
): Record<string, string> {
  if (!isPackageRunnerCommand(command)) {
    return env;
  }

  const prefix =
    env.NPM_CONFIG_PREFIX ??
    process.env.NPM_CONFIG_PREFIX ??
    process.env.npm_config_prefix;

  if (prefix && isUsableNpmPrefix(prefix)) {
    return env;
  }

  return {
    ...env,
    NPM_CONFIG_PREFIX: ensureFallbackNpmPrefix(),
  };
}
