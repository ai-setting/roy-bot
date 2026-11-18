/**
 * Shared npm prefix resolution for MCP and LSP tooling.
 *
 * Cursor remote environments often set npm prefix to a path without lib/.
 */

import fs from "fs";
import { execSync } from "child_process";
import os from "os";
import path from "path";

function pathExistsSync(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function getFallbackNpmPrefixPath(): string {
  return path.join(os.homedir(), ".local", "share", "roy-bot", "npm-prefix");
}

/** Prefix is usable when either lib/ or bin/ exists (some installs only have bin). */
export function isUsableNpmPrefix(prefix: string): boolean {
  return (
    pathExistsSync(path.join(prefix, "lib")) ||
    pathExistsSync(path.join(prefix, "bin"))
  );
}

export function ensureNpmPrefixDirs(prefix: string): void {
  fs.mkdirSync(path.join(prefix, "lib"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
}

export function ensureFallbackNpmPrefix(): string {
  const fallback = getFallbackNpmPrefixPath();
  ensureNpmPrefixDirs(fallback);
  return fallback;
}

export function readNpmConfigPrefix(): string | undefined {
  try {
    const prefix = execSync("npm config get prefix", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return prefix || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return a writable npm prefix, creating the roy-bot fallback when needed.
 */
export function resolveNpmPrefix(): string {
  const candidates = [
    process.env.NPM_CONFIG_PREFIX,
    process.env.npm_config_prefix,
    readNpmConfigPrefix(),
    path.join(os.homedir(), ".npm-global"),
  ].filter(Boolean) as string[];

  for (const prefix of candidates) {
    if (isUsableNpmPrefix(prefix)) {
      return prefix;
    }
  }

  return ensureFallbackNpmPrefix();
}

export function resolveGlobalNodeModulesPath(): string {
  return path.join(resolveNpmPrefix(), "lib", "node_modules");
}

export function resolveGlobalBinPath(): string {
  return path.join(resolveNpmPrefix(), "bin");
}
