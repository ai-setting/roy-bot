/**
 * @fileoverview LSP 依赖安装器
 *
 * 负责安装和验证 LSP 服务器所需的包依赖
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import {
  resolveGlobalBinPath,
  resolveGlobalNodeModulesPath,
} from "./npm-paths";

/**
 * LSP 包依赖信息
 */
export interface LSPPackage {
  /** 包名称 (npm) */
  npmPackage: string;
  /** 语言服务器 ID */
  serverId: string;
  /** 描述 */
  description: string;
}

/**
 * LSP 包依赖列表
 */
export const LSP_PACKAGES: LSPPackage[] = [
  {
    npmPackage: "typescript-language-server",
    serverId: "typescript",
    description: "TypeScript/JavaScript 语言服务器",
  },
  {
    npmPackage: "pyright",
    serverId: "python",
    description: "Python 语言服务器",
  },
  {
    npmPackage: "@vue/language-server",
    serverId: "vue",
    description: "Vue 语言服务器",
  },
  {
    npmPackage: "@vscode/css-language-server",
    serverId: "css",
    description: "CSS/SCSS/Less 语言服务器",
  },
  {
    npmPackage: "@vscode/html-language-server",
    serverId: "html",
    description: "HTML 语言服务器",
  },
  {
    npmPackage: "@vscode/json-language-server",
    serverId: "json",
    description: "JSON 语言服务器",
  },
];

/**
 * 安装目标
 */
export type InstallTarget = "global" | "local";

/**
 * 安装选项
 */
export interface InstallOptions {
  /** 安装目标 */
  target?: InstallTarget;
  /** 指定要安装的语言 */
  languages?: string[];
  /** 安装路径 (local 模式) */
  installPath?: string;
  /** 是否自动安装 */
  autoInstall?: boolean;
}

/**
 * LSP 依赖安装器
 */
export class LSPDependencyInstaller {
  private target: InstallTarget;
  private installPath: string;

  constructor(options: InstallOptions = {}) {
    this.target = options.target ?? "global";
    this.installPath = options.installPath ?? this.getDefaultInstallPath();
  }

  /**
   * 获取默认安装路径
   */
  private getDefaultInstallPath(): string {
    if (this.target === "global") {
      return this.getGlobalNodeModulesPath();
    }
    return path.join(os.homedir(), ".local", "share", "roy-bot", "lsp-servers");
  }

  /**
   * 获取全局 node_modules 路径
   */
  private getGlobalNodeModulesPath(): string {
    return resolveGlobalNodeModulesPath();
  }

  /**
   * 获取全局 bin 路径
   */
  private getGlobalBinPath(): string {
    return resolveGlobalBinPath();
  }

  /**
   * 检查包是否已安装
   */
  isInstalled(packageName: string): boolean {
    if (this.target === "global") {
      const globalPath = path.join(this.getGlobalNodeModulesPath(), packageName);
      return fs.existsSync(globalPath);
    }
    // local 模式检查 installPath
    const localPath = path.join(this.installPath, "node_modules", packageName);
    return fs.existsSync(localPath);
  }

  /**
   * 检查包是否在 PATH 中
   */
  isInPath(packageName: string): boolean {
    try {
      execSync(`which ${packageName.split("/").pop()}`, { encoding: "utf8", stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取已安装的包列表
   */
  getInstalledPackages(): string[] {
    const installed: string[] = [];
    for (const pkg of LSP_PACKAGES) {
      if (this.isInstalled(pkg.npmPackage)) {
        installed.push(pkg.serverId);
      }
    }
    return installed;
  }

  /**
   * 安装指定语言的 LSP 包
   */
  install(serverId: string, options: { verbose?: boolean } = {}): boolean {
    const pkg = LSP_PACKAGES.find((p) => p.serverId === serverId);
    if (!pkg) {
      console.error(`Unknown LSP server: ${serverId}`);
      return false;
    }

    if (this.isInstalled(pkg.npmPackage)) {
      if (options.verbose) {
        console.log(`✓ ${pkg.description} (${pkg.npmPackage}) is already installed`);
      }
      return true;
    }

    console.log(`Installing ${pkg.description} (${pkg.npmPackage})...`);

    try {
      if (this.target === "global") {
        execSync(`npm install -g ${pkg.npmPackage}`, {
          stdio: options.verbose ? "inherit" : "pipe",
        });
      } else {
        // local 模式
        const nodeModulesPath = path.join(this.installPath, "node_modules");
        fs.mkdirSync(nodeModulesPath, { recursive: true });
        execSync(`npm install --prefix ${this.installPath} ${pkg.npmPackage}`, {
          stdio: options.verbose ? "inherit" : "pipe",
        });
      }

      console.log(`✓ ${pkg.description} installed successfully`);
      return true;
    } catch (error) {
      console.error(`✗ Failed to install ${pkg.npmPackage}:`, error);
      return false;
    }
  }

  /**
   * 安装所有 LSP 依赖
   */
  installAll(options: { verbose?: boolean } = {}): { success: string[]; failed: string[] } {
    const success: string[] = [];
    const failed: string[] = [];

    for (const pkg of LSP_PACKAGES) {
      if (this.install(pkg.serverId, options)) {
        success.push(pkg.serverId);
      } else {
        failed.push(pkg.serverId);
      }
    }

    return { success, failed };
  }

  /**
   * 检查缺失的依赖
   */
  getMissingDependencies(): LSPPackage[] {
    return LSP_PACKAGES.filter((pkg) => !this.isInstalled(pkg.npmPackage));
  }

  /**
   * 验证安装
   */
  verify(serverId: string): { installed: boolean; inPath: boolean; binary: string | null } {
    const pkg = LSP_PACKAGES.find((p) => p.serverId === serverId);
    if (!pkg) {
      return { installed: false, inPath: false, binary: null };
    }

    const binaryName = pkg.npmPackage.split("/").pop() ?? pkg.npmPackage;
    return {
      installed: this.isInstalled(pkg.npmPackage),
      inPath: this.isInPath(binaryName),
      binary: this.isInPath(binaryName) ? binaryName : null,
    };
  }
}

/**
 * 创建默认安装器实例
 */
export function createInstaller(options?: InstallOptions): LSPDependencyInstaller {
  return new LSPDependencyInstaller(options);
}
