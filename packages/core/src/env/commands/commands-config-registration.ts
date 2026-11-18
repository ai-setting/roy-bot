/**
 * @fileoverview Commands Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import type { ComponentRegistration } from "../../config/config-component";

/**
 * Commands Component 默认配置值（占位，实际值在 registerConfig 中动态设置）
 * 
 * 注意：这些默认值在 CommandsComponent.registerConfig() 中
 * 通过 configComponent.set() 设置到 ConfigComponent，使用基于 HOME 的绝对路径
 */
export const COMMANDS_DEFAULTS: Record<string, unknown> = {
  "command.userCommandsDir": undefined, // 动态设置：${HOME}/.roy-bot/commands
  "command.projectCommandsDir": undefined, // 动态设置：${cwd}/.roy/commands
  "command.cacheDir": undefined, // 动态设置：${HOME}/.cache/roy-bot/commands
};

/**
 * Commands Component 配置注册常量
 * 
 * 定义了所有 Commands 相关的配置项和来源
 */
export const COMMANDS_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "command",
  
  sources: [
    { type: "env", envPrefix: "COMMAND", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "command.userCommandsDir", sources: ["env", "file"] },
    { key: "command.projectCommandsDir", sources: ["env", "file"] },
    { key: "command.cacheDir", sources: ["env", "file"] },
  ],
};
