/**
 * @fileoverview LSP Server 实现
 * 
 * 定义 LSP 服务器配置和管理
 */

import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs/promises";
import { which } from "../util/which";
import { LSPClient, createLSPClient } from "./client";
import { MarkdownLSPClient } from "./markdown-client";
import { resolvePackageEntry } from "./server-paths";
import type { LSPServerInfo, LSPManagerConfig } from "../types/linter";
import { LSPDependencyInstaller, LSP_PACKAGES } from "../lsp-deps/installer";

/**
 * LSP 服务器类
 * 
 * 封装 LSP 服务器的启动和管理
 */
export class LSPServer {
  private info: LSPServerInfo;
  private config: LSPManagerConfig;

  constructor(info: LSPServerInfo, config: LSPManagerConfig) {
    this.info = info;
    this.config = config;
  }

  /**
   * 获取服务器 ID
   */
  get id(): string {
    return this.info.id;
  }

  /**
   * 获取支持的扩展名
   */
  get extensions(): string[] {
    return this.info.extensions;
  }

  /**
   * 查找项目根目录
   * 
   * 向上查找 rootPattern 中的文件
   */
  async findRoot(filePath: string, workspaceRoot?: string): Promise<string | null> {
    const stopAt = workspaceRoot ?? path.parse(filePath).root;
    let currentDir = path.dirname(filePath);

    while (currentDir !== stopAt && currentDir !== "/") {
      // 检查排除模式
      if (this.info.excludePattern) {
        for (const pattern of this.info.excludePattern) {
          const excludePath = path.join(currentDir, pattern);
          try {
            await fs.access(excludePath);
            // 找到了排除文件，返回 null
            return null;
          } catch {
            // 文件不存在，继续向上查找
          }
        }
      }

      // 检查根目录标识文件
      for (const pattern of this.info.rootPattern) {
        const rootFile = path.join(currentDir, pattern);
        try {
          await fs.access(rootFile);
          return currentDir;
        } catch {
          // 文件不存在，继续向上查找
        }
      }

      currentDir = path.dirname(currentDir);
    }

    // 没有找到，返回 workspaceRoot 或文件所在目录
    return workspaceRoot ?? path.dirname(filePath);
  }

  /**
   * 检查二进制是否存在
   */
  async checkBinary(): Promise<string | null> {
    const cmd = this.info.command[0];
    const binaryPath = which(cmd);
    if (binaryPath) return binaryPath;

    // 如果配置了自动下载，尝试下载
    if (this.config.autoDownload) {
      return this.downloadBinary();
    }

    return null;
  }

  /**
   * 检查文件是否是 Python 脚本（通过检查 shebang）
   */
  private async checkIfPythonScript(filePath: string): Promise<boolean> {
    const fs = require("fs") as typeof import("fs");
    try {
      const fd = await fs.promises.open(filePath, "r");
      const buffer = Buffer.alloc(128);
      const { bytesRead } = await fd.read(buffer, 0, 128, 0);
      await fd.close();

      if (bytesRead < 2) return false;

      // 检查是否以 #! 开头
      if (buffer[0] !== 0x23 || buffer[1] !== 0x21) return false;

      const shebang = buffer.slice(2, bytesRead).toString("utf-8");
      // 检查 shebang 是否包含 python
      return shebang.includes("python") || shebang.includes("pypy");
    } catch {
      return false;
    }
  }

  /**
   * 查找 Python 解释器
   * 优先使用 shebang 中指定的路径，其次使用系统 python
   */
  private findPythonInterpreter(): string {
    const fs = require("fs") as typeof import("fs");
    try {
      const content = fs.readFileSync(this.info.command[0], "utf-8");
      const shebangMatch = content.match(/^#!\s*([^\s]+)/);
      if (shebangMatch) {
        const shebangPath = shebangMatch[1];
        // 如果 shebang 是绝对路径，检查是否存在
        if (path.isAbsolute(shebangPath) && fs.existsSync(shebangPath)) {
          return shebangPath;
        }
      }
    } catch {
      // 忽略读取错误
    }

    // 回退到系统 python
    const systemPython = which("python3") || which("python");
    return systemPython || "python";
  }

  /**
   * 下载 LSP 服务器二进制
   * 
   * 使用 LSPDependencyInstaller 自动下载缺失的包
   */
  protected async downloadBinary(): Promise<string | null> {
    try {
      const installer = new LSPDependencyInstaller({
        target: "global",
        installPath: this.config.installPath,
      });

      // 查找对应的包
      const pkg = LSP_PACKAGES.find((p) => p.serverId === this.info.id);
      if (!pkg) {
        console.debug(`[LSPServer] No package registered for server: ${this.info.id}`);
        return null;
      }

      // 安装包
      const success = installer.install(this.info.id, { verbose: false });
      if (!success) {
        console.debug(`[LSPServer] Failed to install ${pkg.npmPackage}`);
        return null;
      }

      // 返回安装后的二进制路径
      const binaryPath = which(this.info.command[0]);
      return binaryPath;
    } catch (error) {
      console.debug(`[LSPServer] Error downloading binary:`, error);
      return null;
    }
  }

  /**
   * 查找全局安装的 TypeScript 包路径
   */
  private findGlobalTypeScript(): string | null {
    const fs = require("fs") as typeof import("fs");

    // 尝试从 bun 全局包目录查找
    const bunGlobalPath = path.resolve(process.env.BUN_INSTALL ?? "~/.bun", "lib/node_modules/typescript");
    if (fs.existsSync(bunGlobalPath)) {
      return bunGlobalPath;
    }

    // 尝试从 npm 全局包目录查找
    const npmGlobalPath = path.resolve(process.env.NPM_CONFIG_PREFIX ?? "/usr/local", "lib/node_modules/typescript");
    if (fs.existsSync(npmGlobalPath)) {
      return npmGlobalPath;
    }

    // 尝试项目根目录的 node_modules/typescript
    const projectRoot = path.resolve(__dirname, "../../../../"); // 从 dist/lsp 到项目根
    const projectTSPath = path.join(projectRoot, "node_modules/typescript");
    if (fs.existsSync(projectTSPath)) {
      return projectTSPath;
    }

    // 尝试常见的全局包位置
    const commonPaths = [
      "~/.bun/lib/node_modules/typescript",
      "/usr/local/lib/node_modules/typescript",
      "/root/.npm-global/lib/node_modules/typescript",
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * 创建 LSP Client
   */
  async createClient(root: string): Promise<LSPClient | null> {
    // 检查二进制
    const binaryPath = await this.checkBinary();
    if (!binaryPath) {
      console.warn(`LSP server binary not found: ${this.info.command[0]}`);
      return null;
    }

    // 检查是否是 Python 脚本（shebang 脚本）
    // 如果是 Python 脚本，需要通过 python 解释器执行
    const isPythonScript = await this.checkIfPythonScript(binaryPath);

    // 启动进程
    const args = isPythonScript
      ? [binaryPath, ...(this.info.args ?? ["--stdio"])]
      : (this.info.args ?? ["--stdio"]);

    // 确定实际要执行的命令
    const command = isPythonScript ? this.findPythonInterpreter() : binaryPath;

    // 为 TypeScript 语言服务器配置全局 TypeScript 路径
    const env = { ...process.env };
    if (this.info.id === "typescript") {
      // 查找全局 TypeScript 包路径
      const globalTSPath = this.findGlobalTypeScript();
      if (globalTSPath) {
        // typescript-language-server 使用 TSSERVER_PATH 环境变量
        env.TSSERVER_PATH = globalTSPath;
      }
    }

    const proc = spawn(command, args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    // 处理进程错误
    proc.on("error", (err) => {
      console.error(`LSP server process error: ${this.info.id} - ${err.message}`);
    });

    // 创建客户端
    try {
      const client = await createLSPClient(proc, this.info, `file://${root}`, this.config.initTimeout);
      return client;
    } catch (error) {
      console.error(`Failed to create LSP client: ${error}`);
      proc.kill();
      return null;
    }
  }
}

/**
 * LSP 服务器注册表
 */
export class LSPServerRegistry {
  private static servers: Map<string, LSPServerInfo> = new Map();

  static {
    // 注册内置服务器
    this.register({
      id: "typescript",
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
      rootPattern: ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"],
      excludePattern: ["deno.json", "deno.jsonc"],
      command: ["typescript-language-server", "--stdio"],
    });

    this.register({
      id: "python",
      extensions: [".py"],
      rootPattern: ["pyproject.toml", "requirements.txt", "setup.py", ".python-version", "Pipfile"],
      command: ["pyright-langserver", "--stdio"],
      initializationOptions: {
        // Pyright 初始化选项
        pythonVersion: 312, // Python 3.12
        typeCheckingMode: "basic",
        reportMissingImports: true,
        reportMissingTypeStubs: false,
      },
    });

    this.register({
      id: "vue",
      extensions: [".vue"],
      rootPattern: ["package.json"],
      command: ["vue-language-server", "--stdio"],
    });

    this.register({
      id: "css",
      extensions: [".css", ".scss", ".sass", ".less"],
      rootPattern: ["package.json"],
      command: ["vscode-css-language-server", "--stdio"],
    });

    this.register({
      id: "html",
      extensions: [".html", ".htm"],
      rootPattern: ["package.json"],
      command: ["vscode-html-language-server", "--stdio"],
    });

    this.register({
      id: "json",
      extensions: [".json", ".jsonc"],
      rootPattern: ["package.json"],
      command: ["vscode-json-language-server", "--stdio"],
    });

    // Markdown：使用 @ai-setting/markdown-language-server。
    // 注意：该包附带的 cli.js 是个针对全局 install 的 stub，本地 install
    // 跑不起来；这里通过 require.resolve 直接定位到包内 out/node/main.js，
    // 用 node 进程 spawn。同时通过 clientFactory 指定使用 MarkdownLSPClient
    // 子类，以便注册 `markdown/parse` 处理器并发送 markdown.validate.* 配置。
    const mdEntry = resolvePackageEntry(
      "@ai-setting/markdown-language-server",
      "out/node/main.js"
    );
    if (mdEntry) {
      this.register({
        id: "markdown",
        extensions: [".md", ".markdown"],
        rootPattern: ["package.json", ".git"],
        // 注意：LSPServer.createClient 只把 command[0] 当 binary、用 args 做参数，
        // 所以 main.js 路径必须放在 args 里（在 --stdio 之前）。
        command: ["node"],
        args: [mdEntry, "--stdio"],
        clientFactory: (proc, info, rootUri, initTimeout) =>
          new MarkdownLSPClient(proc as ChildProcess, info, rootUri, initTimeout),
      });
    }
  }

  /**
   * 注册服务器
   */
  static register(info: LSPServerInfo): void {
    this.servers.set(info.id, info);
  }

  /**
   * 获取服务器
   */
  static get(id: string): LSPServerInfo | undefined {
    return this.servers.get(id);
  }

  /**
   * 获取所有服务器 ID
   */
  static getServerIds(): string[] {
    return Array.from(this.servers.keys());
  }

  /**
   * 创建服务器实例
   */
  static create(id: string, config: LSPManagerConfig): LSPServer | null {
    const info = this.get(id);
    if (!info) return null;
    return new LSPServer(info, config);
  }
}
