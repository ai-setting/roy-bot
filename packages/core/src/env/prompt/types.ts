/**
 * @fileoverview PromptComponent Types
 */

import { z } from "zod";

// ============================================================================
// Config Schema
// ============================================================================

/**
 * 单个 Prompt 路径配置（外部加载）
 */
export const PromptPathSchema = z.object({
  /** 路径类型 */
  type: z.enum(["file", "directory"]),
  
  /** 路径 */
  path: z.string(),
  
  /** 名称（可选，用于覆盖文件名校验） */
  name: z.string().optional(),
  
  /** 是否递归加载子目录（仅 directory 类型） */
  recursive: z.boolean().default(true),
  
  /** 文件扩展名过滤（仅 directory 类型） */
  extension: z.string().default(".md"),
});

export type PromptPath = z.infer<typeof PromptPathSchema>;

/**
 * PromptComponent 配置 Schema
 */
export const PromptConfigSchema = z.object({
  /** 外部 Prompt 路径列表（可选） */
  promptPaths: z.array(PromptPathSchema).default([]),
  
  /** 默认 prompt 名称 */
  defaultName: z.string().default("default"),
  
  /** 变量前缀 */
  variablePrefix: z.string().default("{{"),
  
  /** 变量后缀 */
  variableSuffix: z.string().default("}}"),
  
  /** 严格模式：变量未定义时报错 */
  strictMode: z.boolean().default(false),
});

export type PromptConfig = z.infer<typeof PromptConfigSchema>;

// ============================================================================
// Prompt Entity
// ============================================================================

/**
 * Prompt 来源类型
 */
export type PromptSource = "built-in" | "file" | "directory" | "inline";

/**
 * Prompt 条目
 */
export interface PromptEntry {
  /** 唯一名称 */
  name: string;
  
  /** Prompt 内容 */
  content: string;
  
  /** 来源 */
  source: PromptSource;
  
  /** 原始文件路径 */
  filePath?: string;
  
  /** 是否可覆盖（内置 prompt 不可覆盖） */
  overridable: boolean;
  
  /** 加载时间 */
  loadedAt: number;
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Prompt Hook 点常量
 */
export const PromptHookPoints = {
  BEFORE_RENDER: "prompt.before-render",
  AFTER_RENDER: "prompt.after-render",
} as const;

/**
 * Prompt Hook 上下文（用于统一 Hook 系统）
 */
export interface PromptHookContext {
  /** Prompt 名称 */
  name: string;
  
  /** 原始内容 */
  originalContent: string;
  
  /** 渲染后的内容（after hook 可修改） */
  renderedContent: string;
  
  /** 渲染变量 */
  variables: Record<string, string>;

  /**
   * 渲染该 prompt 的 agent 类型（primary / sub / summary / workflow）。
   *
   * 用途：`prompt.after-render` hook 需要区分「面向用户的入口 agent」与
   * 「内部流水线子 agent」，从而决定是否注入 user-facing 内容
   * （如 Commands Arsenal 自定义命令文档）。
   *
   * 调用方在渲染某个 agent 的 prompt 时必须传入；未传（如 CLI 直接展示 prompt、
   * workflow 内联 prompt）时视为**非 primary**，hook 不做 user-facing 注入。
   *
   * 历史背景（Issue #1694 → 2026-10-16 compact 事故）：此前用「子 agent 名单黑名单」
   * 排除 json-extract / workflow-extract，新增的内置子 agent（compact / compact-hint）
   * 被漏掉 → 它们的 system prompt 被追加了一整段 Commands Arsenal，其中写着
   * "Use them directly via bash when needed"，而它们并没有 bash 工具
   * → `Tool not found: bash` → 压缩写出空 checkpoint，657 条消息被静默丢弃。
   * 现改为**显式正向判定**（只有 primary 才注入），默认不注入，新子 agent 自动安全。
   */
  agentType?: string;
}

/**
 * Render Hook 上下文（别名，保持向后兼容）
 */
export type RenderHookContext = PromptHookContext;

/**
 * Prompt Hook（使用统一 Hook 接口）
 */
export interface PromptHook {
  name: string;
  priority?: number;
  execute(ctx: { data: PromptHookContext; phase: "before" | "after" }): void | Promise<void>;
}

/**
 * Prompt Hook Map（保持向后兼容）
 */
export type PromptHookMap = {
  "before.render"?: PromptHook[];
  "after.render"?: PromptHook[];
};
