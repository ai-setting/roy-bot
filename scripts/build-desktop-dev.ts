#!/usr/bin/env bun
/**
 * Desktop App 开发构建脚本
 *
 * 特点：
 * 1. 清理旧的构建产物
 * 2. 构建 core 包（生成 core/dist）
 * 3. 构建 Vite 前端
 * 4. 构建 Electron 主进程 (ESM 格式)
 * 5. 复制 core dist 到 vendor/core-dist（供 Electron 运行时使用）
 *
 * 使用：
 *   bun run build:desktop:dev    # 清理 + 重新构建
 *   bun run build:desktop:dev && bun run desktop:dev  # 构建 + 启动开发模式
 */

import path from "path";
import fs from "fs";
import { mkdir, rm, access } from "node:fs/promises";
import { $ } from "bun";

const ROOT = path.resolve(".");
const CORE_ROOT = path.join(ROOT, "packages", "core");
const DESKTOP_ROOT = path.join(ROOT, "packages", "desktop");

// ============================================================
// 清理函数
// ============================================================

async function clean() {
  console.log("🧹 Cleaning desktop build artifacts...\n");

  // 必须清理的目录
  const dirsToClean = [
    path.join(DESKTOP_ROOT, "dist"), // Vite 前端构建输出
    path.join(DESKTOP_ROOT, "electron", "dist"), // Electron 主进程构建
    path.join(DESKTOP_ROOT, "vendor"), // vendor/core-dist
  ];

  // 确保 vendor 目录存在（后面会用到）
  const vendorDir = path.join(DESKTOP_ROOT, "vendor");
  fs.mkdirSync(vendorDir, { recursive: true });

  for (const dir of dirsToClean) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      if (files.length > 0) {
        // 使用 fs.rm 替代 shell rm -rf，跨平台兼容
        await rm(dir, { recursive: true, force: true });
        console.log(`  ✓ Cleaned ${path.relative(ROOT, dir)}`);
      } else {
        console.log(`  ✓ ${path.relative(ROOT, dir)}/ already empty`);
      }
    }
  }

  console.log("");
}

// ============================================================
// 构建函数
// ============================================================

async function buildCore() {
  console.log("📦 Building core package...\n");

  // 检查 core 是否有 package.json scripts build
  const corePkgJson = path.join(CORE_ROOT, "package.json");
  if (!fs.existsSync(corePkgJson)) {
    throw new Error(`Core package.json not found: ${corePkgJson}`);
  }

  const pkg = JSON.parse(fs.readFileSync(corePkgJson, "utf-8"));
  if (!pkg.scripts?.build) {
    console.log("  ⚠ Core package has no build script, skipping...\n");
    return;
  }

  await $`cd ${CORE_ROOT} && bun run build`;
  console.log("  ✓ Core built");
  console.log("");
}

async function buildFrontend() {
  console.log("⚡ Building Vite frontend...\n");
  await $`cd ${DESKTOP_ROOT} && bun run build`;
  console.log("  ✓ Frontend built");
  console.log("");
}

async function buildElectron() {
  console.log("⚡ Building Electron main process...\n");

  // Step 1: Compile TypeScript to JavaScript
  await $`cd ${DESKTOP_ROOT} && npx tsc -p electron/tsconfig.json`;
  console.log("  ✓ TypeScript compiled");

  // Step 2: Bundle to ESM using esbuild
  await $`cd ${DESKTOP_ROOT} && node electron/build-preload.js`;
  console.log("  ✓ Bundled to ESM (.js) for Electron");

  console.log("");
}

async function copyCoreDist() {
  console.log("📁 Copying core dist to vendor/core-dist...\n");

  const srcDir = path.join(CORE_ROOT, "dist");
  const destDir = path.join(DESKTOP_ROOT, "vendor", "core-dist");

  if (!fs.existsSync(srcDir)) {
    console.log(`  ⚠ Core dist not found: ${srcDir}`);
    console.log("  ⚠ Skipping copy. Make sure core is built.\n");
    return;
  }

  // 清理已存在的目标
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  // 复制
  fs.cpSync(srcDir, destDir, { recursive: true });

  console.log(`  ✓ Copied core/dist → vendor/core-dist`);
  console.log("");
}

// ============================================================
// 主流程
// ============================================================

async function build() {
  console.log("═══════════════════════════════════════════");
  console.log("  Desktop Dev Build");
  console.log("  Clean + Rebuild all artifacts");
  console.log("═══════════════════════════════════════════");
  console.log("");

  // Step 1: Clean
  await clean();

  // Step 2: Build core
  await buildCore();

  // Step 3: Build frontend
  await buildFrontend();

  // Step 4: Build electron main process
  await buildElectron();

  // Step 5: Copy core dist to vendor
  await copyCoreDist();

  // Summary
  console.log("═══════════════════════════════════════════");
  console.log("  Build complete!");
  console.log("");
  console.log("  Next steps:");
  console.log("    bun run desktop:dev");
  console.log("");
  console.log("  Or use the combined command:");
  console.log("    bun run build:desktop:dev && bun run desktop:dev");
  console.log("═══════════════════════════════════════════");
}

build().catch(console.error);
