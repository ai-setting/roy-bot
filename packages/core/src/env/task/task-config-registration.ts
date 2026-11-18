/**
 * @fileoverview Task Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import type { ComponentRegistration } from "../../config/config-component";

/**
 * Task Component 默认配置值
 * 
 * 注意：键使用完整格式（带 "task." 前缀），在 registerConfig 中手动设置
 * 注意：dbPath 的默认值由 SQLiteTaskStore 决定，放在这里是为了让 show-config 能显示
 */
export const TASK_DEFAULTS: Record<string, unknown> = {
  // "sqlite"（默认，本地库）| "remote"（指向常驻 roy-task-service）
  "task.storage.type": "sqlite",
  "task.storage.dbPath": undefined, // 由 SQLiteTaskStore 使用默认路径
  // remote 模式必填（Task #5440）：service 地址，如 http://127.0.0.1:7820
  "task.storage.endpoint": undefined,
  // remote 模式可选：Bearer token，需与 service 的 TASK_AUTH_TOKEN 一致
  "task.storage.authToken": undefined,

  // ★ Task #5580（2026-11-15 补充需求）：lark 卡片开关（config.jsonc 可配）
  //
  // - emitTaskCard：task hook 触发的**任务卡片**（用户主关注，pin）
  // - emitSessionCard：sub-session 生命周期触发的 **session 卡片**（调试）
  // 两者并存（用户 2026-11-13 定稿）；设 false 可单独关闭某一种。
  // 改 config.jsonc 即生效（FileSource watch 默认开 ⇒ 热更新，无需重启 ES）。
  "task.plugins.larkCard.emitTaskCard": true,
  "task.plugins.larkCard.emitSessionCard": true,
};

/**
 * Task Component 配置注册常量
 * 
 * 定义了所有 Task 相关的配置项和来源
 */
export const TASK_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "task",
  
  sources: [
    { type: "env", envPrefix: "TASK", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "task.storage.type", sources: ["env", "file"] },
    { key: "task.storage.dbPath", sources: ["env", "file"] },
    // Task #5440 — remote 模式（task-service）连接配置
    { key: "task.storage.endpoint", sources: ["env", "file"] },
    { key: "task.storage.authToken", sources: ["env", "file"] },
    // ★ Task #5580 — lark 卡片开关（config.jsonc 热更新）
    { key: "task.plugins.larkCard.emitTaskCard", sources: ["env", "file"] },
    { key: "task.plugins.larkCard.emitSessionCard", sources: ["env", "file"] },
  ],
  // 注意：不使用 defaults 字段，默认值在 registerConfig 中手动 set
};
