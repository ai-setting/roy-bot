/**
 * @roy-bot/coder - Coder Harness
 *
 * Programming-focused Environment for roy-bot.
 *
 * Core Philosophy:
 * - Core (@ai-setting/roy-bot-core) is scenario-agnostic
 * - Coder Harness (@roy-bot/coder) extends core with programming-specific capabilities
 *
 * Plugins (LSPPlugin, CodeCheckPlugin, ReminderPlugin, TSLSPPlugin, PyLSPPlugin, MDLSPPlugin)
 * all inherit BasePlugin and use unified init(env: PluginEnv) lifecycle.
 */

// Re-export core types for convenience
export { BaseEnvironment } from "@ai-setting/roy-bot-core";
export type { Environment } from "@ai-setting/roy-bot-core";
export type { Component } from "@ai-setting/roy-bot-core";

// ============================================================================
// BasePlugin (统一插件基类)
// ============================================================================

export { BasePlugin } from "@ai-setting/roy-bot-core";
export type { PluginEnv, HookHandler } from "@ai-setting/roy-bot-core";

// ============================================================================
// LSP Module
// ============================================================================

export { LSPClient, createLSPClient } from "./lsp/client";
export { LSPServer, LSPServerRegistry } from "./lsp/server";
export { LSPManager, createGlobalLSPManager, globalLSPManager } from "./lsp/manager";
export type { HealthCheckResult, ConnectionStats } from "./lsp/manager";
export {
  getServerId,
  getLanguageId,
  isSupported,
  getExtensionsByServer,
  LANGUAGE_EXTENSIONS,
  SERVER_BY_EXTENSION,
} from "./lsp/language-map";

// ============================================================================
// Language LSP Plugins (统一插件架构)
// ============================================================================

export { TSLSPPlugin, createTSLSPPlugin } from "./lsp/plugins/tslsp-plugin";
export type { TSLSPPluginConfig } from "./lsp/plugins/tslsp-plugin";

export { PyLSPPlugin, createPyLSPPlugin } from "./lsp/plugins/pylsp-plugin";
export type { PyLSPPluginConfig } from "./lsp/plugins/pylsp-plugin";

export { MDLSPPlugin, createMDLSPPlugin } from "./lsp/plugins/mdlsp-plugin";
export type { MDLSPPluginConfig } from "./lsp/plugins/mdlsp-plugin";

// ============================================================================
// Plugins (统一插件架构)
// ============================================================================

// LSP Plugin - 代码智能查询（统一入口）
export { LSPPlugin, createLSPPlugin } from "./plugins/lsp-plugin";
export type { LSPQueryResult, LSPPluginConfig } from "./plugins/lsp-plugin";

// Code Check Plugin - 外部命令检查
export { CodeCheckPlugin, createCodeCheckPlugin } from "./plugins/code-check-plugin";
export type { CodeCheckPluginConfig, CodeCheckResult } from "./plugins/code-check-plugin";

// Reminder Plugin - 最大迭代次数提醒
export { ReminderPlugin, createReminderPlugin } from "./plugins/reminder-plugin";
export type { ReminderPluginConfig } from "./plugins/reminder-plugin";

// ============================================================================
// Types
// ============================================================================

export type {
  Diagnostic,
  Range,
  Position,
  LintResult,
  LinterPluginConfig,
  LSPServerInfo,
  LSPManagerConfig,
} from "./types/linter";

export { DiagnosticSeverity } from "./types/linter";

export type {
  TypeCheckPluginConfig,
  TypeCheckManagerConfig,
  TypeCheckIssue,
  TypeCheckResult,
  TypeCheckEngine,
} from "./types/linter";

// ============================================================================
// LSP Dependency Management
// ============================================================================

export {
  LSPDependencyInstaller,
  LSP_PACKAGES,
  createInstaller,
  LSPConfig,
  LSPConfigLoader,
  getDefaultLSPConfig,
  createLSPConfigLoader,
} from "./lsp-deps/index";

export type {
  LSPPackage,
  InstallOptions,
  InstallTarget,
  LSPConfigOptions,
} from "./lsp-deps/index";
