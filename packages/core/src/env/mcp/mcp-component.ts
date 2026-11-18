/**
 * @fileoverview MCP Component 主组件
 * 
 * MCP 客户端管理组件
 */

import { z } from "zod";
import { BaseComponent, type ComponentConfig } from "../component";
import { createLogger } from "../log-trace/logger";
import { McpScanner } from "./scanner";
import { McpLoader } from "./loader";
import { adaptMcpTool } from "./tool/adapter";
import { ComponentError, ErrorCodes } from "../errors";
import {
  DEFAULT_MCP_CONFIG,
  MCP_CONFIG_KEYS,
  type McpComponentConfig,
  type McpComponentOptions,
} from "./config";
import { MCP_CONFIG_REGISTRATION, MCP_DEFAULTS } from "./mcp-config-registration";
import type { McpServerStatus, McpServerConfig } from "./types";
import type { ToolComponent } from "../tool/index";
import type { ToolInfo } from "../tool/types";
import type { ConfigComponent } from "../../config/config-component";
import { toEnvKey } from "../../config/env-key";

const logger = createLogger("mcp");

/**
 * McpComponent
 * 
 * MCP 客户端管理组件
 * 
 * 功能：
 * 1. 配置管理（支持 file/env/object 三层配置）
 * 2. 扫描 MCP 服务器
 * 3. 连接/断开 MCP 服务器
 * 4. 注册 MCP tools 到 ToolComponent
 */
export class McpComponent extends BaseComponent {
  readonly name = "mcp";
  readonly version = "1.0.0";

  private config!: McpComponentConfig;
  private toolComponent?: ToolComponent;
  private configComponent?: ConfigComponent;
  private scanner?: McpScanner;
  private loader?: McpLoader;
  private serverStatus: Map<string, McpServerStatus> = new Map();
  private registeredTools: Map<string, ToolInfo> = new Map();

  constructor() {
    super();
  }

  // ========================================================================
  // Component Lifecycle
  // ========================================================================

  async init(config?: ComponentConfig): Promise<void> {
    await super.init(config);

    const options = config?.options as unknown as McpComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new ComponentError(
        "ConfigComponent is required for McpComponent initialization",
        ErrorCodes.MCP_INIT_FAILED
      );
    }

    this.configComponent = options.configComponent;
    await this.registerConfig(options);

    logger.info("[McpComponent] Initialized");
  }

  async start(): Promise<void> {
    await super.start();

    // 获取 ToolComponent
    this.toolComponent = this.env?.getComponent("tool") as ToolComponent | undefined;
    if (!this.toolComponent) {
      logger.warn("[McpComponent] ToolComponent not found, skipping tool registration");
    }

    // 扫描并连接 MCP 服务器
    await this.loadServers();

    this.setStatus("running");
    logger.info(`[McpComponent] Started with ${this.serverStatus.size} servers`);
  }

  async stop(): Promise<void> {
    // 取消注册所有工具
    for (const toolName of this.registeredTools.keys()) {
      this.toolComponent?.unregister(toolName);
    }

    // 断开所有连接
    if (this.loader) {
      await this.loader.disconnectAll();
    }

    await super.stop();
    logger.info("[McpComponent] Stopped");
  }

  // ========================================================================
  // Configuration
  // ========================================================================

  private async registerConfig(options: McpComponentOptions): Promise<void> {
    const configComponent = this.configComponent;
    if (!configComponent) return;

    const { envPrefix, config } = options;

    // 1. 使用 registerComponent 注册 MCP_CONFIG_REGISTRATION
    // 这会自动注册 sources、keys 和 defaults
    configComponent.registerComponent(MCP_CONFIG_REGISTRATION);

    // 2. 加载配置（从 env/file 等来源）
    // 注意：load() 不会覆盖内存中已有的默认值
    await configComponent.load("mcp");

    // 3. 处理环境变量覆盖（确保环境变量能覆盖默认值）
    const prefix = envPrefix !== undefined ? envPrefix : "MCP";
    for (const key of MCP_CONFIG_KEYS) {
      const envKey = toEnvKey(key, prefix);
      const value = process.env[envKey];
      if (value !== undefined) {
        try {
          await configComponent.set(key, JSON.parse(value));
        } catch {
          await configComponent.set(key, value);
        }
      }
    }

    // 4. 直接配置对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 5. 设置默认值（只有当配置不存在时）
    for (const [key, value] of Object.entries(MCP_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    // 6. 解析最终配置
    const configData: Record<string, unknown> = {};
    for (const key of MCP_CONFIG_KEYS) {
      const value = configComponent.get(key);
      if (value !== undefined) {
        configData[key.replace(/^mcp\./, "")] = value;
      }
    }

    // 合并直接传入的 config（最高优先级）
    if (config) {
      Object.assign(configData, config);
    }

    // 验证配置
    const parsed = z.object({
      mcpPaths: z.array(z.object({
        type: z.enum(["user", "project", "custom"]),
        path: z.string(),
      })),
      servers: z.record(z.string(), z.any()).optional(),
      timeout: z.number().optional(),
      enabled: z.boolean().optional(),
    }).safeParse(configData);

    if (parsed.success) {
      this.config = {
        ...DEFAULT_MCP_CONFIG,
        ...(parsed.data as McpComponentConfig),
      };
    } else {
      logger.warn("[McpComponent] Invalid config, using defaults", {
        errors: parsed.error.errors,
      });
      this.config = DEFAULT_MCP_CONFIG;
    }
  }

  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "mcp"
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const configKey = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(result, this.flattenConfig(value as Record<string, unknown>, configKey));
      } else {
        result[configKey] = value;
      }
    }
    return result;
  }

  // ========================================================================
  // Server Management
  // ========================================================================

  private async loadServers(): Promise<void> {
    if (!this.config.enabled) {
      logger.info("[McpComponent] MCP is disabled");
      return;
    }

    if (!this.config.mcpPaths || this.config.mcpPaths.length === 0) {
      logger.info("[McpComponent] No MCP paths configured");
      return;
    }

    // 初始化加载器和扫描器
    this.loader = new McpLoader(this.config.timeout);
    this.scanner = new McpScanner(this.config.mcpPaths);

    // 扫描服务器
    const discoveredServers = await this.scanner.scan();

    // 连接每个服务器
    for (const [name, server] of discoveredServers) {
      const defaultConfig = this.loader.buildDefaultConfig(server);
      const explicitConfig = this.config.servers?.[name];
      const finalConfig = this.loader.mergeConfig(defaultConfig, explicitConfig);

      if (finalConfig.enabled === false) {
        this.serverStatus.set(name, {
          name,
          status: "disconnected",
          toolsCount: 0,
        });
        continue;
      }

      try {
        const entry = await this.loader.connect(name, finalConfig);
        const tools = await this.registerServerTools(entry);

        this.serverStatus.set(name, {
          name,
          status: "connected",
          toolsCount: tools.length,
        });
      } catch (error) {
        this.serverStatus.set(name, {
          name,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        logger.error(`[McpComponent] Failed to connect to ${name}`, { error });
      }
    }

    // 处理配置中额外定义的服务器
    for (const [name, serverConfig] of Object.entries(this.config.servers ?? {})) {
      if (discoveredServers.has(name)) continue;

      try {
        const entry = await this.loader.connect(name, serverConfig);
        const tools = await this.registerServerTools(entry);

        this.serverStatus.set(name, {
          name,
          status: "connected",
          toolsCount: tools.length,
        });
      } catch (error) {
        this.serverStatus.set(name, {
          name,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async registerServerTools(
    entry: Awaited<ReturnType<McpLoader["connect"]>>
  ): Promise<ToolInfo[]> {
    if (!this.toolComponent) return [];

    const tools: ToolInfo[] = [];
    try {
      const listResult = await entry.client.listTools();

      for (const mcpTool of listResult.tools) {
        const tool = adaptMcpTool(mcpTool, entry.client, entry.name);
        this.toolComponent.register(tool);
        this.registeredTools.set(tool.name, tool);
        tools.push(tool);
      }

      logger.info(`[McpComponent] Registered ${tools.length} tools from ${entry.name}`);
    } catch (error) {
      logger.warn(`[McpComponent] Failed to list tools for ${entry.name}`, { error });
    }

    return tools;
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /**
   * 获取服务器状态
   */
  getServerStatus(name: string): McpServerStatus | undefined {
    return this.serverStatus.get(name);
  }

  /**
   * 列出所有服务器
   */
  listServers(): McpServerStatus[] {
    return Array.from(this.serverStatus.values());
  }

  /**
   * 列出所有 MCP 工具
   */
  listTools(): ToolInfo[] {
    return Array.from(this.registeredTools.values());
  }

  /**
   * 重新加载所有服务器
   */
  async reload(): Promise<void> {
    logger.info("[McpComponent] Reloading...");

    // 断开所有连接
    if (this.loader) {
      await this.loader.disconnectAll();
    }

    // 取消注册所有工具
    for (const toolName of this.registeredTools.keys()) {
      this.toolComponent?.unregister(toolName);
    }
    this.registeredTools.clear();
    this.serverStatus.clear();

    // 重新加载
    await this.loadServers();
  }
}
