/**
 * @fileoverview clipboard-helper — 读系统剪贴板图片
 *
 * 设计目标：
 * 1. 测试可覆盖：用 ROY_CLIPBOARD_MOCK_PATH / ROY_CLIPBOARD_MOCK_FAIL
 *    覆盖真实子进程调用，单元测试不真调 xclip/pngpaste
 * 2. 生产可用：macOS 用 pngpaste，Linux 用 xclip -selection clipboard -t image/png
 * 3. 安全 fallback：工具不可用 / 剪贴板无图片 → 返回 null（不抛错）
 *
 * 借鉴 opencode: clipboard.ts 同样用 child_process 调系统命令
 */

import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { sniffMimeType } from "@ai-setting/roy-bot-core";

// ============================================================================
// Types
// ============================================================================

export interface ClipboardReadResult {
  /** 剪贴板图片原始 buffer */
  buffer: Buffer;
  /** 嗅探出的 mime（image/png | image/jpeg 等） */
  mime: string;
}

// ============================================================================
// Mock mode detection
// ============================================================================

/**
 * 是否处于 mock 模式
 *
 * - ROY_CLIPBOARD_MOCK_PATH: 指向一个 fake 图片文件 → readClipboardImage 读这个文件
 * - ROY_CLIPBOARD_MOCK_FAIL=true: mock 失败 → 返回 null
 *
 * 测试时设置任一即可覆盖真实子进程调用。
 */
export function isClipboardMockActive(): boolean {
  return Boolean(
    process.env.ROY_CLIPBOARD_MOCK_PATH ||
    process.env.ROY_CLIPBOARD_MOCK_FAIL
  );
}

// ============================================================================
// Platform detection
// ============================================================================

/**
 * 选第一个可用的剪贴板命令
 *
 * - macOS: 优先 pngpaste（专业工具），fallback osascript
 * - Linux: xclip -selection clipboard -t image/png -o
 * - Windows: powershell Get-Clipboard -Format Image（未实现）
 *
 * 返回 null 表示平台不支持。
 */
function pickClipboardCommand(): { cmd: string; args: string[] } | null {
  const platform = process.platform;

  if (platform === "darwin") {
    // macOS: 尝试 pngpaste
    return { cmd: "pngpaste", args: [] };
  }

  if (platform === "linux") {
    return {
      cmd: "xclip",
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
    };
  }

  return null;
}

// ============================================================================
// readClipboardImage — main entry
// ============================================================================

/**
 * 读系统剪贴板图片
 *
 * @returns 成功返回 { buffer, mime }，失败（工具不可用 / 剪贴板无图片）返回 null
 */
export async function readClipboardImage(): Promise<ClipboardReadResult | null> {
  // 1. mock 模式: env var 覆盖
  if (process.env.ROY_CLIPBOARD_MOCK_FAIL === "true") {
    return null;
  }
  if (process.env.ROY_CLIPBOARD_MOCK_PATH) {
    return await readMockFromPath(process.env.ROY_CLIPBOARD_MOCK_PATH);
  }

  // 2. 真实模式: 调系统命令
  const cmdSpec = pickClipboardCommand();
  if (!cmdSpec) {
    return null;
  }

  const stdout = await execAsync(cmdSpec.cmd, cmdSpec.args).catch(() => null);
  if (!stdout || stdout.length === 0) {
    return null;
  }

  const buffer = Buffer.from(stdout);
  const mime = sniffMimeType(buffer);

  // 只接受图片
  if (!mime.startsWith("image/")) {
    return null;
  }

  return { buffer, mime };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function readMockFromPath(filePath: string): Promise<ClipboardReadResult | null> {
  try {
    const buffer = await readFile(filePath);
    const mime = sniffMimeType(buffer, filePath);
    if (!mime.startsWith("image/")) {
      return null;
    }
    return { buffer, mime };
  } catch {
    return null;
  }
}

/**
 * exec 的 promise 包装 — 拿 stdout bytes
 */
function execAsync(cmd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    exec(
      `${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
      { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        if (!stdout) {
          resolve(null);
          return;
        }
        resolve(stdout as Buffer);
      }
    );
  });
}
