/**
 * @fileoverview WorkflowExtractorAgent - 工作流提取 Agent
 *
 * 负责从自然语言描述或 Task 对话历史中提取 Workflow YAML。
 *
 * 升级说明（v2）：
 * - prompt 内容已迁移到 `prompts-index.ts` 的 `builtInPrompts['workflow-extract']`
 * - 通过 `AgentRegistry.registerWorkflowExtractAgent()` 注册为内置 agent
 * - 此文件保留工具函数（formatExtractorInput / parseExtractorOutput）供 task-tag-plugin 使用
 * - `WORKFLOW_EXTRACTOR_PROMPT` 保留为 alias（向后兼容），实际指向 built-in prompt
 */

import { WORKFLOW_EXTRACT_PROMPT } from "../../prompt/prompts-index";
import type { Task, TaskOperation } from "../types";
import type { SessionMessage } from "../../session/session-component";
import type { WorkflowDefinition } from "../../workflow/types";

/**
 * Workflow Extractor Agent System Prompt（向后兼容 alias）
 *
 * @deprecated
 * 历史：之前直接定义在此文件。现在统一从 `prompts-index.ts` 的
 * `builtInPrompts['workflow-extract']` 读取，并 re-export 为 `WORKFLOW_EXTRACT_PROMPT`。
 *
 * 这个常量保留只是为了**向后兼容**：旧代码可能仍 import 此名称。
 * 新代码应使用 `import { WORKFLOW_EXTRACT_PROMPT } from "../../prompt/prompts-index"`。
 */
export const WORKFLOW_EXTRACTOR_PROMPT = WORKFLOW_EXTRACT_PROMPT;

/**
 * 格式化提取器输入 - 从 Task 提取
 */
export function formatExtractorInput(params: {
  task: Task;
  operations: TaskOperation[];
  messages: SessionMessage[];
}): string {
  const lines: string[] = [];
  
  // Task Info
  lines.push("# 任务信息");
  lines.push(`- 标题: ${params.task.title}`);
  if (params.task.description) {
    lines.push(`- 描述: ${params.task.description}`);
  }
  if (params.task.goals_and_expected_deliverables) {
    lines.push(`- 目标: ${params.task.goals_and_expected_deliverables}`);
  }
  lines.push("");
  
  // Operations
  if (params.operations.length > 0) {
    lines.push("# 操作记录");
    for (const op of params.operations) {
      lines.push(`- [${op.actionType}] ${op.actionTitle}`);
      if (op.actionDescription) {
        lines.push(`  ${op.actionDescription.slice(0, 200)}`);
      }
    }
    lines.push("");
  }
  
  // Messages
  lines.push("# Session 消息历史");
  lines.push("(以下是相关的对话历史，请从中提取 Workflow)");
  for (const msg of params.messages.slice(-50)) { // 限制消息数量
    const content = typeof msg.content === 'string' 
      ? msg.content 
      : JSON.stringify(msg.content);
    const truncated = content.slice(0, 500);
    lines.push(`**${msg.role}**: ${truncated}${content.length > 500 ? '...' : ''}`);
  }
  lines.push("");
  
  lines.push("## 任务");
  lines.push("请分析以上信息，构建一个可复用的 Workflow。");
  lines.push("使用迭代式流程：生成 YAML → validate 验证 → 修正错误 → 重复直到通过验证。");
  
  return lines.join("\n");
}

/**
 * 格式化提取器输入 - 从自然语言描述提取
 */
export function formatExtractorInputFromDescription(params: {
  description: string;
}): string {
  const lines: string[] = [];
  
  lines.push("# Workflow 描述");
  lines.push(params.description);
  lines.push("");
  
  lines.push("## 任务");
  lines.push("请根据以上描述，构建一个可复用的 Workflow。");
  lines.push("使用迭代式流程：生成 YAML → validate 验证 → 修正错误 → 重复直到通过验证。");
  
  return lines.join("\n");
}

/**
 * 解析提取器输出
 */
export async function parseExtractorOutput(output: string): Promise<WorkflowDefinition | null> {
  // 提取 YAML 代码块
  const yamlMatch = output.match(/```yaml\n?([\s\S]*?)\n?```/) ||
                    output.match(/```\n?([\s\S]*?)\n?```/) ||
                    output.match(/(\|[\s\S]*?)(?:\n\n|$)/);
  
  const yamlContent = yamlMatch?.[1] || output;
  
  try {
    // 动态导入 yaml 包（与 workflow.ts 中的模式一致）
    const YAML = await import("yaml");
    const parsed = YAML.parse(yamlContent) as WorkflowDefinition;
    
    // 验证必要字段
    if (!parsed.name || !parsed.nodes || !Array.isArray(parsed.nodes)) {
      return null;
    }
    
    // 至少 2 个节点
    if (parsed.nodes.length < 2) {
      return null;
    }
    
    // 确保 version 有默认值
    parsed.version = parsed.version || "1.0";
    
    return parsed;
  } catch {
    return null;
  }
}
