import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { SkillToolSchema, type SkillToolParams, type SkillListItem } from "../types";

/**
 * 构建 SkillTool 的 description
 */
export function buildSkillDescription(items: SkillListItem[]): string {
  const lines = [
    "Load a skill by name. Available skills:",
    "",
    "## Available Skills",
    "",
  ];

  if (items.length === 0) {
    lines.push("No skills available.");
  } else {
    for (const item of items) {
      lines.push(`- **${item.name}**: "${item.description}"`);
    }
  }

  lines.push("");
  lines.push("Use the 'skill' parameter to specify which skill to load.");

  return lines.join("\n");
}

/**
 * 创建 SkillTool
 *
 * @param getSkillList - 获取 skill 列表的回调
 * @param getSkill - 获取单个 skill 的回调
 */
export function createSkillTool(
  getSkillList: () => SkillListItem[],
  getSkill: (name: string) => { content: string } | undefined
): Tool {
  return {
    name: "skill",
    description: buildSkillDescription(getSkillList()),
    parameters: SkillToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = SkillToolSchema.parse(args) as SkillToolParams;

      try {
        const entry = getSkill(params.skill);
        if (!entry) {
          return {
            success: false,
            output: "",
            error: `Skill not found: ${params.skill}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        return {
          success: true,
          output: entry.content,
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          metadata: { execution_time_ms: 0 },
        };
      }
    },
  };
}
