/**
 * @fileoverview LogTrace Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import type { ComponentRegistration } from "../../config/config-component";

/**
 * LogTrace Component 默认配置值
 * 
 * 注意：键使用完整格式（带 "log-trace." 前缀），在 registerConfig 中手动设置
 * 注意：动态默认值（logging.dir, logging.file, logging.maxOutput）在 registerConfig 中单独处理
 */
export const LOG_TRACE_DEFAULTS: Record<string, unknown> = {
  "log-trace.logging.enabled": true,
  "log-trace.logging.level": "info",
  "log-trace.logging.quiet": false,
  "log-trace.tracing.enabled": true,
};

/**
 * LogTrace Component 配置注册常量
 * 
 * 定义了所有 LogTrace 相关的配置项和来源
 * 
 * Source 优先级（数值越大越高）：
 * - project: 25（${cwd}/.roy/config.jsonc，最高优先级）— 由 LogTraceComponent.registerConfig() 手动注册
 * - env:     20（环境变量）
 * - file:    10（全局 XDG 配置，默认）
 * - memory:   0（默认值，代码设置）
 */
export const LOG_TRACE_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "log-trace",
  
  sources: [
    // 注意：project source 不在此处声明 — 需要在 LogTraceComponent 初始化时根据 cwd 手动注册
    // 环境变量
    { type: "env", envPrefix: "LOG_TRACE", priority: 20, watch: false },
  ],
  
  keys: [
    // 优先级：project > env > file
    { key: "log-trace.logging.enabled", sources: ["project", "env", "file"] },
    { key: "log-trace.logging.level", sources: ["project", "env", "file"] },
    { key: "log-trace.logging.quiet", sources: ["project", "env", "file"] },
    { key: "log-trace.logging.dir", sources: ["project", "env", "file"] },
    { key: "log-trace.logging.file", sources: ["project", "env", "file"] },
    { key: "log-trace.logging.maxOutput", sources: ["project", "env", "file"] },
    { key: "log-trace.tracing.enabled", sources: ["project", "env", "file"] },
    { key: "log-trace.tracing.dbPath", sources: ["project", "env", "file"] },
  ],
  // 注意：不使用 defaults 字段，默认值在 registerConfig 中手动 set
};
