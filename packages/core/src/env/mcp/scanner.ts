/**
 * @fileoverview MCP 服务器路径扫描器
 * 
 * 扫描 mcpPaths 目录，发现所有 MCP 服务器
 * 每个子目录视为一个 MCP 服务器
 */

import fs from "fs/promises";
import path from "path";
import { createLogger } from "../log-trace/logger";
import { resolvePackageRunnerCommand } from "./command-resolver";
import type { McpPath } from "./config";
import type { DiscoveredMcpServer } from "./types";

const logger = createLogger("mcp-scanner");

/**
 * 入口脚本候选文件名
 */
const ENTRY_SCRIPT_CANDIDATES = [
  "server.mjs",
  "server.ts",
  "server.js",
  "index.mjs",
  "index.ts",
  "index.js",
  "src/server.mjs",
  "src/server.ts",
  "src/server.js",
  "src/index.mjs",
  "src/index.ts",
  "src/index.js",
];

/**
 * 展开路径（支持 ~ 展开）
 */
function expandPath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

/**
 * 检查路径是否存在
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 config.jsonc 文件内容
 */
async function parseConfigJsonc(configPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    const cleaned = configContent
      .replace(/\/\*[\s\S]*?\*\//g, "") // 移除多行注释
      .replace(/^\s*\/\/.*$/gm, ""); // 移除单行注释
    return JSON.parse(cleaned);
  } catch (error) {
    logger.warn(`[McpScanner] Failed to parse config: ${configPath}`, { error });
    return undefined;
  }
}

/**
 * 检查 config.command 中的相对路径是否与 entryPath 对应
 */
function relativeCommandMatchesEntry(
  cmdPath: string,
  entryPath: string,
  serverDir: string
): boolean {
  if (path.resolve(serverDir, cmdPath) === entryPath) {
    return true;
  }

  return ENTRY_SCRIPT_CANDIDATES.some(
    (candidate) =>
      cmdPath === candidate && entryPath === path.join(serverDir, candidate)
  );
}

/**
 * 构建入口脚本的默认命令
 * 
 * 如果 config.jsonc 中有 command，检查其路径是否兼容
 * 否则使用 entryPath
 * 
 * 路径兼容性规则：
 * - 绝对路径：直接使用
 * - 相对路径且存在对应文件：使用 entryPath
 * - 相对路径但不存在：使用 entryPath
 */
function buildDefaultCommand(
  entryPath: string | null,
  directoryConfig: Record<string, unknown> | undefined,
  serverDir: string
): string[] | undefined {
  // 如果 config 中有 command
  if (directoryConfig?.command) {
    const cmd = directoryConfig.command as string[];
    const cmdPath = cmd[cmd.length - 1];
    
    // 检查是否是绝对路径
    if (cmdPath?.startsWith("/")) {
      // 绝对路径，直接使用
      return cmd;
    }
    
    // 相对路径：检查是否与 entryPath 匹配
    if (cmdPath && entryPath) {
      if (relativeCommandMatchesEntry(cmdPath, entryPath, serverDir)) {
        return ["bun", "run", entryPath];
      }
    }
    
    // 其他情况：如果有 entryPath，使用它
    if (entryPath) {
      return ["bun", "run", entryPath];
    }
    
    // 没有 entryPath，解析 npx/npm exec 为本地 bin（若已安装）
    return resolvePackageRunnerCommand(cmd, serverDir);
  }
  
  // 使用 entryPath
  return entryPath ? ["bun", "run", entryPath] : undefined;
}

/**
 * MCP 服务器扫描器
 * 
 * 扫描多个路径下的 MCP 服务器子目录
 */
export class McpScanner {
  private mcpPaths: McpPath[];
  private serversMap: Map<string, DiscoveredMcpServer>;

  constructor(mcpPaths: McpPath[]) {
    this.mcpPaths = mcpPaths;
    this.serversMap = new Map();
  }

  /**
   * 扫描所有 mcpPaths
   */
  async scan(): Promise<Map<string, DiscoveredMcpServer>> {
    this.serversMap.clear();

    for (const mcpPath of this.mcpPaths) {
      await this.scanPath(mcpPath);
    }

    logger.info(`[McpScanner] Scanned ${this.serversMap.size} MCP servers`);
    return this.serversMap;
  }

  /**
   * 扫描单个路径
   */
  private async scanPath(mcpPath: McpPath): Promise<void> {
    const expandedPath = expandPath(mcpPath.path);

    if (!(await pathExists(expandedPath))) {
      logger.info(`[McpScanner] Path not found, skipping: ${expandedPath}`);
      return;
    }

    logger.info(`[McpScanner] Scanning: ${expandedPath}`);

    try {
      const entries = await fs.readdir(expandedPath, { withFileTypes: true });

      for (const entry of entries) {
        // Handle symlinks - check if the target is a directory
        const fullPath = path.join(expandedPath, entry.name);
        const stat = await fs.stat(fullPath);
        
        // Skip non-directories (but allow symlinked directories)
        if (!stat.isDirectory()) continue;

        await this.discoverServer(entry.name, fullPath, mcpPath.type);
      }
    } catch (error) {
      logger.warn(`[McpScanner] Failed to scan path: ${expandedPath}`, { error });
    }
  }

  /**
   * 发现单个 MCP 服务器
   */
  private async discoverServer(
    name: string,
    serverDir: string,
    sourceType: string
  ): Promise<void> {
    // 查找入口脚本
    const entryPath = await this.findEntryScript(serverDir);

    // 查找配置文件
    const configPath = path.join(serverDir, "config.jsonc");
    const packagePath = path.join(serverDir, "package.json");

    // 加载目录配置
    let directoryConfig: Record<string, unknown> | undefined;
    if (await pathExists(configPath)) {
      directoryConfig = await parseConfigJsonc(configPath);
    }

    // 构建默认命令（如果 config 中的路径不兼容）
    const defaultCommand = buildDefaultCommand(entryPath, directoryConfig, serverDir);

    const server: DiscoveredMcpServer = {
      name,
      serverDir,
      entryPath: entryPath || undefined,
      configPath: await pathExists(configPath) ? configPath : undefined,
      packagePath: await pathExists(packagePath) ? packagePath : undefined,
      directoryConfig,
      defaultCommand,
    };

    // 检测路径冲突
    if (this.serversMap.has(name)) {
      logger.warn(`[McpScanner] Server "${name}" already discovered, skipping duplicate from ${sourceType}`);
      return;
    }

    this.serversMap.set(name, server);
    logger.debug(`[McpScanner] Discovered server: ${name} from ${sourceType}`);
  }

  /**
   * 查找入口脚本
   */
  private async findEntryScript(serverDir: string): Promise<string | null> {
    for (const candidate of ENTRY_SCRIPT_CANDIDATES) {
      const entryPath = path.join(serverDir, candidate);
      if (await pathExists(entryPath)) {
        return entryPath;
      }
    }

    return null;
  }

  /**
   * 获取扫描结果
   */
  getServers(): Map<string, DiscoveredMcpServer> {
    return this.serversMap;
  }
}
