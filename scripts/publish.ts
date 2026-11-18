#!/usr/bin/env bun

/**
 * Publish script for monorepo packages
 * 
 * Handles workspace:* → version replacement before publishing
 * Publish order: core → coder-harness → ontology-harness → cli
 * Note: Standalone is published separately via publish-full.ts
 */

import { $ } from "bun";
import { cpSync, existsSync, readFileSync, writeFileSync } from "fs";
import { rm } from "node:fs/promises";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

interface Package {
  name: string;
  version: string;
  dir: string;
}

interface PublishOptions {
  dryRun: boolean;
  tag: string;
}

// Package publishing order (dependencies must come first)
const PACKAGES: Package[] = [
  { name: "@ai-setting/roy-bot-core", dir: "packages/core", version: "" },
  { name: "@ai-setting/roy-bot-coder-harness", dir: "packages/coder-harness", version: "" },
  { name: "@ai-setting/roy-bot-ontology-harness", dir: "packages/ontology-harness", version: "" },
  { name: "@ai-setting/roy-bot-cli", dir: "packages/cli", version: "" },
];

// Workspace dependencies to replace
const WORKSPACE_DEPS = [
  "@ai-setting/roy-bot-core",
  "@ai-setting/roy-bot-coder-harness",
  "@ai-setting/roy-bot-ontology-harness",
];

function getPackageJson(dir: string): any {
  const path = join(rootDir, dir, "package.json");
  if (!existsSync(path)) {
    throw new Error(`package.json not found: ${dir}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function setPackageJson(dir: string, pkg: any): void {
  const path = join(rootDir, dir, "package.json");
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
}

function backupPackageJson(dir: string): void {
  const src = join(rootDir, dir, "package.json");
  const backup = join(rootDir, dir, "package.json.bak");
  cpSync(src, backup);
}

function restorePackageJson(dir: string): void {
  const src = join(rootDir, dir, "package.json");
  const backup = join(rootDir, dir, "package.json.bak");
  if (existsSync(backup)) {
    cpSync(backup, src);
  }
}

function replaceWorkspaceDeps(pkg: any, versions: Map<string, string>): any {
  const updated = { ...pkg, dependencies: { ...pkg.dependencies } };
  
  for (const dep of WORKSPACE_DEPS) {
    if (updated.dependencies && updated.dependencies[dep]) {
      // workspace:* → ^x.x.x
      const version = versions.get(dep);
      if (version) {
        updated.dependencies[dep] = `^${version}`;
        console.log(`  ${pkg.name}: ${dep} "workspace:*" → "^${version}"`);
      }
    }
  }
  
  return updated;
}

async function buildPackage(pkg: Package): Promise<void> {
  console.log(`\n📦 Building ${pkg.name}...`);
  
  // Clean dist - 使用 fs.rm 替代 shell rm -rf，跨平台兼容
  const distDir = join(rootDir, pkg.dir, "dist");
  await rm(distDir, { recursive: true, force: true });
  
  // Build with bunup
  await $`cd ${rootDir} && bun run build`.quiet();
}

async function publishPackage(pkg: Package, options: PublishOptions): Promise<void> {
  const pkgPath = join(rootDir, pkg.dir);
  const pkgJson = getPackageJson(pkg.dir);
  const version = pkgJson.version;
  
  console.log(`\n📦 Publishing ${pkg.name}@${version}...`);
  
  // Prepare files array - only include dist
  const files = ["dist/**/*", "README.md"];
  
  if (options.dryRun) {
    console.log(`  [DRY RUN] Would publish ${pkg.name}@${version}`);
    console.log(`  [DRY RUN] Files: ${files.join(", ")}`);
    return;
  }
  
  // Create .npmignore to ensure only dist is published
  const npmignorePath = join(pkgPath, ".npmignore");
  writeFileSync(npmignorePath, `src/
*.ts
!*.d.ts
node_modules/
dist/**/*.map
*.log
.env
.env.*
!.env.example
`);
  
  try {
    // Publish to npm
    const tagArg = options.tag ? `--tag ${options.tag}` : "";
    const result = await $`cd ${pkgPath} && npm publish --access public ${tagArg}`.text();
    console.log(`  ${result}`);
  } finally {
    // Clean up .npmignore
    if (existsSync(npmignorePath)) {
      await Bun.write(npmignorePath, "");
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options: PublishOptions = {
    dryRun: args.includes("--dry-run") || args.includes("-n"),
    tag: args.find(arg => arg.startsWith("--tag="))?.split("=")[1] || "",
  };
  
  console.log("🚀 Starting publish process...\n");
  console.log(`   Dry run: ${options.dryRun}`);
  console.log(`   Tag: ${options.tag || "latest"}`);
  
  // Collect versions from package.json files
  const versions = new Map<string, string>();
  for (const pkg of PACKAGES) {
    const pkgJson = getPackageJson(pkg.dir);
    versions.set(pkg.name, pkgJson.version);
    console.log(`   ${pkg.name}: ${pkgJson.version}`);
  }
  
  // Process each package
  for (const pkg of PACKAGES) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  Processing: ${pkg.name}`);
    console.log("=".repeat(60));
    
    // Backup original package.json
    backupPackageJson(pkg.dir);
    
    try {
      // Get package.json and replace workspace deps
      const pkgJson = getPackageJson(pkg.dir);
      const updatedPkg = replaceWorkspaceDeps(pkgJson, versions);
      
      // Write updated package.json
      setPackageJson(pkg.dir, updatedPkg);
      
      // Build
      await buildPackage(pkg);
      
      // Publish
      await publishPackage(pkg, options);
      
      console.log(`\n✅ ${pkg.name} published successfully!`);
    } catch (error) {
      console.error(`\n❌ Failed to publish ${pkg.name}:`, error);
      throw error;
    } finally {
      // Always restore original package.json
      restorePackageJson(pkg.dir);
    }
  }
  
  console.log(`\n${"=".repeat(60)}`);
  console.log("  🎉 All packages published successfully!");
  console.log("=".repeat(60));
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
