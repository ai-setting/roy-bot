/**
 * @fileoverview which 命令实现
 * 
 * 在 PATH 中查找可执行文件
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs";

/**
 * 在 PATH 中查找可执行文件
 * 
 * @param command 命令名称
 * @returns 命令的完整路径，如果找不到返回 null
 */
export function which(command: string): string | null {
  // 如果是绝对路径，直接检查是否存在
  if (path.isAbsolute(command)) {
    return fs.existsSync(command) ? command : null;
  }

  // 获取 PATH 环境变量
  const PATH = process.env.PATH ?? "";
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const paths = PATH.split(pathSeparator);

  // Windows 下还要检查 PATHEXT
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];

  for (const dir of paths) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, command + ext);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  // 尝试使用系统 which 命令（仅在非 Windows 平台）
  // Windows 没有原生的 which 命令，需要使用 PowerShell 的 Get-Command 或手动遍历
  if (process.platform !== "win32") {
    try {
      const result = execSync(`which ${command}`, { encoding: "utf-8" });
      const trimmed = result.trim();
      return trimmed || null;
    } catch {
      // fall through to return null
    }
  }
  
  return null;
}
