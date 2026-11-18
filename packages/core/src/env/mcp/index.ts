/**
 * @fileoverview MCP Component 导出
 */

// 类型
export type {
  McpServerConfig,
  McpServerLocalConfig,
  McpServerRemoteConfig,
  DiscoveredMcpServer,
  McpServerStatus,
} from "./types";

export {
  McpServerConfigSchema,
  McpServerLocalConfigSchema,
  McpServerRemoteConfigSchema,
} from "./types";

// 配置
export {
  DEFAULT_MCP_CONFIG,
  MCP_CONFIG_KEYS,
  getMcpPathPriority,
} from "./config";

export type {
  McpComponentConfig,
  McpComponentOptions,
  McpPath,
} from "./config";

// 组件
export { McpComponent } from "./mcp-component";

// Scanner & Loader
export { McpScanner } from "./scanner";
export { McpLoader, type McpClientEntry } from "./loader";
export {
  resolveNpmPrefix,
  resolveGlobalNodeModulesPath,
  resolveGlobalBinPath,
  ensureFallbackNpmPrefix,
  isUsableNpmPrefix,
} from "./npm-prefix";
export {
  resolvePackageRunnerCommand,
  augmentNpmEnvForPackageRunner,
} from "./command-resolver";

// Tool Adapter
export { adaptMcpTool, createMcpToolsDescription, convertInputSchemaToZod } from "./tool/adapter";
