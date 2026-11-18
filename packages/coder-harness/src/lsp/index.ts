/**
 * @fileoverview LSP 模块导出
 */

// 核心类
export { LSPClient, createLSPClient } from "./client";
export { LSPServer, LSPServerRegistry } from "./server";
export { LSPManager } from "./manager";
export { LSPConnectionPool, ConnectionKey } from "./pool";

// 语言映射
export { getLanguageId, getServerId, isSupported, getExtensionsByServer } from "./language-map";

// 类型
export type { LSPServerInfo, LSPManagerConfig } from "../types/linter";
