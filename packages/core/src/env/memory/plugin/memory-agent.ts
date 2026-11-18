/**
 * @fileoverview Memory Agent 核心逻辑 (Simplified)
 * 
 * 简化设计：
 * - 移除 DraftManager（草稿管理已废弃）
 * - 移除 AccessLog（访问日志已废弃）
 * - 只保留核心的 Agent 类型和格式化逻辑
 */

import type { ModelMessage } from "ai";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Memory 作用域类型
 */
export type MemoryScope = "project" | "global";

/**
 * 项目摘要信息
 */
export interface ProjectSummary {
  /** 项目根目录路径 */
  projectPath: string;
  /** 项目名称 */
  projectName: string;
  /** 最后更新时间戳 */
  lastUpdated: number;
  /** 项目 memory.md 摘要（一段话） */
  summary: string;
  /** 简短摘要（几个词） */
  shortSummary: string;
  /** 项目 memory.md 路径 */
  memoryMdPath: string;
}

/**
 * Memory Agent 输入
 */
export interface MemoryAgentInput {
  /** 作用域 */
  scope: MemoryScope;
  /** 基础目录（project: .roy/memory, global: ~/.config/roy-bot/memory） */
  baseDir: string;
  /** 当前 memory.md 内容 */
  currentMemoryMd: string;
  /** 当前对话消息 */
  messages: ModelMessage[];
  /** 项目摘要列表（仅 global scope 使用） */
  projectSummaries?: ProjectSummary[];
}

/**
 * Memory Agent 输出结果
 */
export interface MemoryAgentResult {
  /** 作用域 */
  scope: MemoryScope;
  /** 新的 memory.md 内容（全文） */
  memoryMdContent: string;
  /** 项目摘要（仅 project scope 输出） */
  projectSummary?: ProjectSummary;
  /** 是否有更新 */
  hasUpdates: boolean;
}

/**
 * Memory Agent 配置
 */
export interface MemoryAgentConfig {
  /** Agent 名称 */
  name: string;
  /** System prompt */
  systemPrompt: string;
  /** 最大迭代次数 */
  maxIterations: number;
}

// ============================================================================
// System Prompts (Simplified)
// ============================================================================

/**
 * Project Memory Agent System Prompt
 */
export const PROJECT_MEMORY_AGENT_PROMPT = `你是项目级 Memory Agent，负责整理和更新当前项目的记忆。

## 你的职责

1. **信息收集**：在提取记忆前，先收集项目上下文信息
2. **从对话中提取记忆**：分析 messages，提取与项目相关的知识、决策、解决方案
3. **生成 memory.md**：更新项目记忆索引

## 信息收集步骤（重要！）

在提取记忆之前，请先使用可用工具收集项目上下文：

1. **阅读项目 README**：了解项目概述、功能、使用方法
   - 路径示例：README.md, README.zh-CN.md, docs/README.md

2. **检查设计文档**：了解项目架构和设计决策
   - 路径示例：docs/design.md, docs/ARCHITECTURE.md, docs/superpowers/specs/*.md

3. **查看代码实现**：了解关键模块和实现细节
   - 路径示例：src/**/*.ts, packages/*/src/**/*.ts

4. **回顾现有 memory**：了解已有的项目记忆
   - 路径：当前目录下的 .roy/memory/memory.md

## 输入信息

- 当前项目的 memory.md 内容
- 当前对话消息

## 输出要求

请以 JSON 格式输出结果，包含以下字段：
- memoryMdContent: 新的 memory.md 内容
- projectSummary: 项目摘要（包含 summary, shortSummary 等）
- hasUpdates: 是否有更新

## 记忆组织原则

- 优先记录具体、可操作的记忆（代码位置、配置项、命令）
- 避免过于抽象或通用的描述
- 记录设计决策及其理由`;

/**
 * Global Memory Agent System Prompt
 */
export const GLOBAL_MEMORY_AGENT_PROMPT = `你是全局 Memory Agent，负责整理跨项目的通用记忆。

## 你的职责

1. **聚合项目摘要**：分析 projectSummaries，提取共性知识
2. **维护全局记忆**：更新全局 memory.md
3. **维护项目索引**：在 memory.md 中维护项目列表
4. **提取共性经验**：将项目经验提炼为通用最佳实践

## 输入信息

- 全局 memory.md 内容
- 当前对话消息
- 项目摘要列表（projectSummaries）

## 输出要求

请以 JSON 格式输出结果，包含以下字段：
- memoryMdContent: 新的 memory.md 内容
- hasUpdates: 是否有更新

## 记忆组织原则

- 关注跨项目共性（工作流、规范、偏好）
- 项目索引只记录摘要和路径，不复制内容
- 用户个人偏好（饮食、工作习惯）优先记录`;

// ============================================================================
// Core Functions
// ============================================================================

/**
 * 创建 Memory Agent 配置
 */
export function createMemoryAgent(scope: MemoryScope): MemoryAgentConfig {
  const name = `memory-agent-${scope}-${Date.now()}`;
  const systemPrompt = scope === "project" 
    ? PROJECT_MEMORY_AGENT_PROMPT 
    : GLOBAL_MEMORY_AGENT_PROMPT;
  
  return {
    name,
    systemPrompt,
    maxIterations: 5,
  };
}

/**
 * 格式化 Memory Agent 输入为字符串
 */
export function formatMemoryInput(input: MemoryAgentInput): string {
  const lines: string[] = [];
  
  // Scope header
  lines.push(`# Memory Agent Input (${input.scope} scope)\n`);
  
  // Current memory.md
  lines.push("## Current memory.md");
  lines.push(input.currentMemoryMd || "_No existing memory_");
  lines.push("");
  
  // Messages
  lines.push("## Recent Messages");
  if (input.messages.length === 0) {
    lines.push("_No messages_");
  } else {
    for (const msg of input.messages.slice(-10)) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      lines.push(`**${msg.role}**: ${content.substring(0, 500)}`);
    }
  }
  lines.push("");
  
  // Project Summaries (for global scope)
  if (input.scope === "global" && input.projectSummaries && input.projectSummaries.length > 0) {
    lines.push("## Project Summaries");
    for (const ps of input.projectSummaries) {
      lines.push(`### ${ps.projectName}`);
      lines.push(`Path: ${ps.projectPath}`);
      lines.push(`Last Updated: ${new Date(ps.lastUpdated).toLocaleString()}`);
      lines.push(`Summary: ${ps.summary}`);
      lines.push(`Memory: ${ps.memoryMdPath}`);
      lines.push("---");
    }
    lines.push("");
  }
  
  lines.push("## Task");
  lines.push("请分析以上信息，更新记忆并以 JSON 格式输出结果。");
  
  return lines.join("\n");
}

/**
 * 解析 Memory Agent 输出
 */
export function parseMemoryAgentOutput(output: string, scope: MemoryScope): MemoryAgentResult {
  // Try to extract JSON from output
  let jsonStr = output;
  
  // Try to find JSON in the output
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/) || 
                    output.match(/```\s*([\s\S]*?)\s*```/) ||
                    output.match(/(\{[\s\S]*\})/);
  
  if (jsonMatch) {
    jsonStr = jsonMatch[1] || jsonMatch[0];
  }
  
  try {
    const parsed = JSON.parse(jsonStr);
    
    return {
      scope,
      memoryMdContent: parsed.memoryMdContent || "",
      projectSummary: parsed.projectSummary,
      hasUpdates: parsed.hasUpdates ?? false,
    };
  } catch {
    // Return empty result on parse failure
    return {
      scope,
      memoryMdContent: output, // Use raw output as fallback
      hasUpdates: false,
    };
  }
}

/**
 * 创建默认的 MemoryAgentResult
 */
export function createEmptyResult(scope: MemoryScope): MemoryAgentResult {
  return {
    scope,
    memoryMdContent: "",
    hasUpdates: false,
  };
}

// ============================================================================
// Input Builders
// ============================================================================

/**
 * 构建 Project Memory Agent 输入
 */
export async function buildProjectInput(params: {
  projectPath: string;
  currentMemoryMd: string;
  messages: ModelMessage[];
}): Promise<MemoryAgentInput> {
  const baseDir = params.projectPath + "/.roy/memory";
  
  return {
    scope: "project",
    baseDir,
    currentMemoryMd: params.currentMemoryMd,
    messages: params.messages,
  };
}

/**
 * 构建 Global Memory Agent 输入
 */
export function buildGlobalInput(params: {
  baseDir: string;
  currentMemoryMd: string;
  messages: ModelMessage[];
  projectSummaries?: ProjectSummary[];
}): MemoryAgentInput {
  return {
    scope: "global",
    baseDir: params.baseDir,
    currentMemoryMd: params.currentMemoryMd,
    messages: params.messages,
    projectSummaries: params.projectSummaries,
  };
}

// ============================================================================
// Result Application
// ============================================================================

/**
 * 应用 Memory Agent 结果到文件系统
 *
 * @param result MemoryAgent 结果
 * @param baseDir 基础目录
 */
export async function applyMemoryResult(
  result: MemoryAgentResult,
  baseDir: string
): Promise<void> {
  const fs = await import("fs/promises");
  const path = await import("path");

  // Write memory.md
  const memoryMdPath = path.join(baseDir, "memory.md");
  await fs.mkdir(path.dirname(memoryMdPath), { recursive: true });
  await fs.writeFile(memoryMdPath, result.memoryMdContent, "utf-8");
}

// ============================================================================
// Project Summary Generation
// ============================================================================

/**
 * 生成项目摘要
 */
export function generateProjectSummary(params: {
  projectPath: string;
  projectName: string;
  memoryMdContent: string;
  memoryMdPath: string;
}): ProjectSummary {
  // Extract first paragraph as summary
  const paragraphs = params.memoryMdContent.split(/\n\n+/);
  const firstParagraph = paragraphs[0] || "";
  const summary = firstParagraph.replace(/^#+\s*/g, "").trim() || "No summary available";
  
  // Generate short summary (first sentence, max 50 chars)
  const firstSentence = summary.split(/[.!?]/)[0] || summary;
  const shortSummary = firstSentence.substring(0, 50) + (firstSentence.length > 50 ? "..." : "");
  
  return {
    projectPath: params.projectPath,
    projectName: params.projectName,
    lastUpdated: Date.now(),
    summary,
    shortSummary,
    memoryMdPath: params.memoryMdPath,
  };
}
