#!/usr/bin/env bun
/**
 * Desktop App 生产构建脚本
 *
 * 构建 Vite 前端 + Electron 主进程 + electron-builder 打包
 *
 * 使用：
 *   bun run build:desktop
 */

import path from "path";
import fs from "fs";
import { $ } from "bun";

const ROOT = path.resolve(".");
const PKG_ROOT = path.join(ROOT, "packages", "desktop");

// 获取 desktop 包版本
const PKG_JSON_PATH = path.join(PKG_ROOT, "package.json");
const PKG = JSON.parse(fs.readFileSync(PKG_JSON_PATH, "utf-8"));
const VERSION = PKG.version || "1.0.0";

async function build() {
  console.log(`🏗️  Building Roy Agent Desktop ${VERSION}`);
  console.log("");

  // Step 1: Build Vite frontend
  console.log("Step 1: Building Vite frontend...");
  await $`cd ${PKG_ROOT} && bun run build`;
  console.log("  ✓ Frontend built");
  console.log("");

  // Step 2: Build Electron main process TypeScript
  console.log("Step 2: Building Electron main process...");
  await $`cd ${PKG_ROOT} && npx tsc -p electron/tsconfig.json`;
  console.log("  ✓ Electron main process built");
  console.log("");

  // Step 2.5: Copy vendor dependencies (core dist and @ai-sdk)
  console.log("Step 2.5: Copying vendor dependencies...");
  await $`cd ${PKG_ROOT} && npm run preelectron:build`;
  console.log("  ✓ Vendor dependencies copied");
  console.log("");

  // Step 3: Package with electron-builder
  const platform = process.platform;
  const platformFlag = platform === "win32" ? "--win" : `--${platform}`;

  console.log(`Step 3: Packaging for ${platform}...`);
  await $`cd ${PKG_ROOT} && npx electron-builder --config electron-builder.json ${platformFlag}`;
  console.log("  ✓ Packaged");
  console.log("");

  // Summary
  console.log("═══════════════════════════════════════════");
  console.log(`Build complete! Output: packages/desktop/release/`);
  console.log("═══════════════════════════════════════════");
}

build().catch(console.error);
