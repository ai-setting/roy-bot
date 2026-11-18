/**
 * @fileoverview LSP 插件模块导出
 * 
 * 改造说明：
 * - 所有语言 LSP 插件继承 BasePlugin
 * - 不再导出 LSPPluginRegistry（已废弃）
 */

export { BaseLanguageLSPPlugin, type LanguageLSPPluginConfig, type PreloadMode } from "./base-plugin";
export { TSLSPPlugin, createTSLSPPlugin } from "./tslsp-plugin";
export { PyLSPPlugin, createPyLSPPlugin } from "./pylsp-plugin";
export { MDLSPPlugin, createMDLSPPlugin } from "./mdlsp-plugin";
