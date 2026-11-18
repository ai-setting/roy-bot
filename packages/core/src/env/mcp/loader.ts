/**
 * @fileoverview MCP 服务器加载器
 * 
 * 负责连接和管理 MCP 客户端
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "../log-trace/logger";
import {
  augmentNpmEnvForPackageRunner,
} from "./command-resolver";
import type {
  McpServerConfig,
  McpServerLocalConfig,
  McpServerRemoteConfig,
  DiscoveredMcpServer,
} from "./types";

const logger = createLogger("mcp-loader");

// Auth.json 路径
const AUTH_JSON_PATH = path.join(os.homedir(), ".roy-bot", "auth.json");

/**
 * MCP 客户端条目
 */
export interface McpClientEntry {
  name: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  config: McpServerConfig;
}

/**
 * MCP 服务器加载器
 * 
 * 负责：
 * 1. 构建默认配置
 * 2. 合并显式配置
 * 3. 连接/断开 MCP 服务器
 */
export class McpLoader {
  private clients: Map<string, McpClientEntry> = new Map();
  private defaultTimeout: number;

  constructor(defaultTimeout: number = 30000) {
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * 构建默认配置（从扫描结果）
   * 
   * @param server - 扫描发现的 MCP 服务器信息
   * @returns MCP 服务器配置
   */
  buildDefaultConfig(server: DiscoveredMcpServer): McpServerConfig {
    // 检查是否是远程配置
    if (server.directoryConfig?.type === "remote") {
      const remoteConfig: McpServerRemoteConfig = {
        type: "remote",
        url: server.directoryConfig.url as string,
        enabled: (server.directoryConfig.enabled as boolean) ?? true,
        headers: server.directoryConfig.headers as Record<string, string>,
        timeout: (server.directoryConfig.timeout as number) ?? this.defaultTimeout,
      };
      return remoteConfig;
    }

    // 构建本地配置 - 优先使用 scanner 解析的 defaultCommand
    const command = server.defaultCommand
      ?? (server.entryPath
        ? ["bun", "run", server.entryPath]
        : ["bun", "run", server.name]);

    const localConfig: McpServerLocalConfig = {
      type: "local",
      command,
      ...(server.serverDir ? { cwd: server.serverDir } : {}),
      environment: server.directoryConfig?.environment as Record<string, string>,
      enabled: (server.directoryConfig?.enabled as boolean) ?? true,
      timeout: (server.directoryConfig?.timeout as number) ?? this.defaultTimeout,
    };

    return localConfig;
  }

  /**
   * 合并配置（显式配置覆盖默认配置）
   */
  mergeConfig(
    defaultConfig: McpServerConfig,
    explicitConfig?: Partial<McpServerConfig>
  ): McpServerConfig {
    if (!explicitConfig) {
      return defaultConfig;
    }

    // 如果明确禁用
    if (explicitConfig.enabled === false) {
      return { ...defaultConfig, enabled: false };
    }

    // 合并配置
    if (defaultConfig.type === "local" && (!explicitConfig.type || explicitConfig.type === "local")) {
      return {
        ...defaultConfig,
        ...explicitConfig,
        type: "local",
      };
    }

    if (defaultConfig.type === "remote" && (!explicitConfig.type || explicitConfig.type === "remote")) {
      return {
        ...defaultConfig,
        ...explicitConfig,
        type: "remote",
      };
    }

    return explicitConfig as McpServerConfig;
  }

  /**
   * 连接到 MCP 服务器
   */
  async connect(
    name: string,
    config: McpServerConfig
  ): Promise<McpClientEntry> {
    if (config.enabled === false) {
      throw new Error(`MCP server ${name} is disabled`);
    }

    logger.info(`[McpLoader] Connecting to ${name}...`);

    let client: Client;
    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (config.type === "local") {
      const localConfig = config as McpServerLocalConfig;
      
      // 合并环境变量，注入 minimax API key
      const env = augmentNpmEnvForPackageRunner(
        localConfig.command,
        { ...localConfig.environment }
      );
      await this.injectMinimaxEnv(env);

      transport = new StdioClientTransport({
        command: localConfig.command[0],
        args: localConfig.command.slice(1),
        env,
        ...(localConfig.cwd ? { cwd: localConfig.cwd } : {}),
        stderr: "pipe",
      });
      this.attachStderrDrain(name, transport);

      client = new Client({ name, version: "1.0.0" });
      await client.connect(transport);
    } else {
      const remoteConfig = config as McpServerRemoteConfig;
      transport = new StreamableHTTPClientTransport(
        new URL(remoteConfig.url),
        {
          requestInit: remoteConfig.headers
            ? { headers: remoteConfig.headers }
            : undefined,
        }
      );
      client = new Client({ name, version: "1.0.0" });
      await client.connect(transport);
    }

    const entry: McpClientEntry = { name, client, transport, config };
    this.clients.set(name, entry);

    logger.info(`[McpLoader] Connected to ${name}`);
    return entry;
  }

  /**
   * 断开连接
   */
  async disconnect(name: string): Promise<void> {
    const entry = this.clients.get(name);
    if (!entry) return;

    try {
      await entry.client.close();
    } catch (error) {
      logger.warn(`[McpLoader] Error closing client for ${name}`, { error });
    }

    await this.closeTransport(entry.transport, name);

    this.clients.delete(name);
    logger.info(`[McpLoader] Disconnected from ${name}`);
  }

  private attachStderrDrain(serverName: string, transport: StdioClientTransport): void {
    const stderrStream = transport.stderr;
    if (!stderrStream) {
      return;
    }

    stderrStream.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug(`[McpLoader] ${serverName} stderr: ${text}`);
      }
    });

    stderrStream.on("error", (error) => {
      logger.debug(`[McpLoader] ${serverName} stderr stream error`, { error });
    });
  }

  private async closeTransport(
    transport: StdioClientTransport | StreamableHTTPClientTransport,
    name: string
  ): Promise<void> {
    try {
      const transportAny = transport as {
        close?: () => Promise<void> | void;
        _process?: { pid?: number; killed?: boolean; kill?: (signal?: string) => void };
        process?: { pid?: number; killed?: boolean; kill?: (signal?: string) => void };
      };

      if (typeof transportAny.close === "function") {
        await transportAny.close();
      }

      const child = transportAny._process ?? transportAny.process;
      if (child?.pid && !child.killed) {
        child.kill?.("SIGTERM");
      }
    } catch (error) {
      logger.warn(`[McpLoader] Error closing transport for ${name}`, { error });
    }
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    for (const name of this.clients.keys()) {
      await this.disconnect(name);
    }
  }

  /**
   * 获取客户端
   */
  getClient(name: string): McpClientEntry | undefined {
    return this.clients.get(name);
  }

  /**
   * 获取所有客户端
   */
  getAllClients(): Map<string, McpClientEntry> {
    return this.clients;
  }

  /**
   * 检查是否已连接
   */
  isConnected(name: string): boolean {
    return this.clients.has(name);
  }

  /**
   * 从 auth.json 加载 minimax API key
   */
  async loadMinimaxApiKey(): Promise<string | undefined> {
    try {
      const content = await fs.readFile(AUTH_JSON_PATH, "utf-8");
      const auth = JSON.parse(content);
      return auth.providers?.minimax?.apiKey;
    } catch (error) {
      logger.debug("[McpLoader] Failed to load minimax API key from auth.json", { error });
      return undefined;
    }
  }

  /**
   * 注入 minimax 环境变量到 env 对象
   * 
   * 如果已存在 MINIMAX_API_KEY，不会覆盖
   */
  async injectMinimaxEnv(env: Record<string, string>): Promise<void> {
    if (env["MINIMAX_API_KEY"]) {
      // 已有 API key，不覆盖
      return;
    }

    const apiKey = await this.loadMinimaxApiKey();
    if (apiKey) {
      env["MINIMAX_API_KEY"] = apiKey;
      env["MINIMAX_API_HOST"] = "https://api.minimaxi.com";
    }
  }
}
