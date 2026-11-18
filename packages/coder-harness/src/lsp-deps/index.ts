/**
 * @fileoverview LSP 依赖管理模块
 *
 * 导出 LSP 依赖安装和验证功能
 */

export { LSPDependencyInstaller, LSP_PACKAGES, createInstaller } from "./installer";
export type { LSPPackage, InstallOptions, InstallTarget } from "./installer";
export { LSPConfig, LSPConfigLoader, getDefaultLSPConfig, createLSPConfigLoader } from "./config";
export type { LSPConfigOptions } from "./config";
