/**
 * @fileoverview Global HookManager - 全局 Hook 单例
 * 
 * 所有 Component 的 Hook 都注册到统一的全局实例
 */

import { HookManager } from "./hook-manager";
import type { HookContext, HookResult } from "./types";

// ========================================================================
// 全局单例
// ========================================================================

/**
 * 全局 HookManager 实例
 * 
 * 所有 Agent/LLM/Tool hooks 都注册到这个实例
 */
export const globalHookManager = new HookManager<unknown>();

// ========================================================================
// Hook 点命名规范
// ========================================================================

/**
 * Agent Hook 点（新版统一命名）
 */
export const AgentHookPoints = {
  BEFORE_START: "agent:before.start",
  BEFORE_LLM: "agent:before.llm",
  AFTER_LLM: "agent:after.llm",
  BEFORE_TOOL: "agent:before.tool",
  AFTER_TOOL: "agent:after.tool",
  ON_ITERATION: "agent:on.iteration",
  ON_THRESHOLD: "agent:on.threshold",
  AFTER_COMPLETE: "agent:after.complete",
  ON_ERROR: "agent:on.error",
} as const;

/**
 * LLM Hook 点
 */
export const LLMHookPoints = {
  BEFORE_INVOKE: "llm:before.invoke",
  AFTER_INVOKE: "llm:after.invoke",
  ON_STREAM: "llm:on.stream",
} as const;

/**
 * Tool Hook 点
 */
export const ToolHookPoints = {
  BEFORE_EXECUTE: "tool:before.execute",
  AFTER_EXECUTE: "tool:after.execute",
  BEFORE_REGISTER: "tool:before.register",
  AFTER_REGISTER: "tool:after.register",
  ON_ERROR: "tool:on.error",
} as const;

// ========================================================================
// 旧版 Hook 点别名（兼容）
// ========================================================================

/**
 * 旧版 Tool Hook 点别名映射（向后兼容）
 */
export const LegacyToolHookPoints = {
  BEFORE_EXECUTE: "tool:before.execute",
  AFTER_EXECUTE: "tool:after.execute",
  BEFORE_REGISTER: "tool:before.register",
  AFTER_REGISTER: "tool:after.register",
  ON_ERROR: "tool:on.error",
  // 旧版别名
  BEFORE_TOOL: "before.tool",
  AFTER_TOOL: "after.tool",
} as const;

// ========================================================================
// 别名注册表（用于自动注册别名）
// ========================================================================

const hookPointAliases: Record<string, string> = {
  // Tool hooks 别名映射
  "before.tool": "tool:before.execute",
  "after.tool": "tool:after.execute",
  // LLM hooks 别名映射
  "llm.before-invoke": "llm:before.invoke",
  "llm.after-invoke": "llm:after.invoke",
  "llm.stream": "llm:on.stream",
  // Prompt hooks 别名映射
  // 旧版格式 -> 新版统一格式
  "prompt.before-render": "prompt:before.render",
  "prompt.after-render": "prompt:after.render",
  // 新版统一格式 -> 旧版格式
  "prompt:before.render": "prompt.before-render",
  "prompt:after.render": "prompt.after-render",
  // 带横线的格式 -> 旧版格式
  "prompt:after-render": "prompt.after-render",
  "prompt:before-render": "prompt.before-render",
};

/**
 * 初始化别名 HookManager
 * 
 * 将所有注册到旧版 hook 点的 hooks 自动复制到新版 hook 点
 */
function setupAliasHooks(): void {
  // 监听 hooks 的注册，自动创建别名
  const originalRegister = globalHookManager.register.bind(globalHookManager);
  
  globalHookManager.register = function(hookPoint: string, hook: any): void {
    // 调用原始注册
    originalRegister(hookPoint, hook);
    
    // 如果有别名，也注册到别名点
    const alias = hookPointAliases[hookPoint];
    if (alias) {
      originalRegister(alias, hook);
    }
  };
}

// 在模块加载时设置别名
setupAliasHooks();

// ========================================================================
// 便捷执行方法
// ========================================================================

/**
 * 执行 Agent Hook（不带干预）
 */
export async function executeAgentHook(
  hookPoint: string,
  data: unknown,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await globalHookManager.execute(hookPoint, data, metadata);
}

/**
 * 执行 Agent Hook（带干预检查）
 */
export async function executeAgentHookWithIntervention(
  hookPoint: string,
  data: unknown,
  metadata: Record<string, unknown> = {}
): Promise<HookResult> {
  return globalHookManager.executeWithIntervention(hookPoint, data, metadata);
}

/**
 * 执行 LLM Hook（不带干预）
 */
export async function executeLLMHook(
  hookPoint: string,
  data: unknown,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await globalHookManager.execute(hookPoint, data, metadata);
}

/**
 * 执行 Tool Hook（不带干预）
 */
export async function executeToolHook(
  hookPoint: string,
  data: unknown,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await globalHookManager.execute(hookPoint, data, metadata);
}
