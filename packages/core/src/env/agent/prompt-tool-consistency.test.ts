/**
 * @fileoverview Built-in Prompt × Available Tools Consistency Test
 *
 * 验证每个 built-in agent 的 systemPrompt 中**正面提及的工具名**（放在反引号里）
 * 都真实存在于该 agent 的 (allowedTools - deniedTools) 集合里。
 *
 * 背景：/tmp/prompt-hallucination-audit.md（Task #2033）发现 4 处定向幻觉。
 * 这个测试是 P2 防护措施，未来如果有人修改 prompt 不慎引入类似幻觉，
 * 会被这个测试自动捕获。
 *
 * ⚠️ 测试策略：
 * 1. 仅扫描 markdown 表格（`| ... | ... |` 形式）里的第一列（工具名列）。
 * 2. 排除明显不是工具名的 token（CLI 子命令、参数、agent 名等）。
 * 3. 对于 `delegate_task` prompt 模板里"传给子 agent"的工具名，在 default 的
 *    `subAgentTemplateTokens` 例外列表里。
 *
 * 局限性：
 * - 仅检查 markdown 表格里的工具名（最常见的提示位置）。
 * - 不检查代码块（```...```）里零散的工具引用 — 那些更可能是参数示例，
 *   误报率高。
 * - 对于负向提示（"禁止使用 X"）暂不做精细识别，靠人工维护 denylist + table 提取。
 *
 * 维护说明：
 * 每次新增/修改内置 agent 时，必须同步更新 BUILT_IN_AGENT_TOOL_PROFILES。
 */

import { describe, expect, test } from "vitest";
import { builtInPrompts } from "../prompt/prompts-index";

/**
 * 抓取 markdown 工具表格里第一列的所有反引号包裹的 token。
 * 一个 markdown 表格的格式是：
 *   | 工具 | 类别 | 描述 |
 *   |------|------|------|
 *   | `bash` | ... | ... |
 *   | `read_file` | ... | ... |
 *
 * 表格以 `| ` 开头，下一行为分隔（包含 `---`），之后是数据行。
 * 表格结束于第一个不以 `|` 开头的非空行。
 */
function extractTableFirstColumnTokens(text: string): string[] {
  const out = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 检测表格开头：`| Header | ... |`
    if (!line.match(/^\|\s*\S.*\|\s*$/)) continue;
    // 必须是"工具"或"Tool"或"Command"开头
    const firstCellMatch = line.match(/^\|\s*([^|]+?)\s*\|/);
    if (!firstCellMatch) continue;
    const firstCell = firstCellMatch[1].trim().toLowerCase();
    if (!["工具", "tool", "command", "subcommand"].includes(firstCell)) continue;

    // 负向跳过：如果表格上方（<=6 行）的标题/section 标题含"禁止"/"禁用"/"denied"/"不支持"等
    // 关键词，则这个表格是"禁止使用"表，跳过。
    const NEGATIVE_HEADER_PATTERNS = [
      /禁止使用/,
      /禁止调用/,
      /禁用/,
      /不要使用/,
      /不支持/,
      /不能使用/,
      /不可用/,
      /denied/i,
      /❌\s*(?:禁止|不可|不能)/,
    ];
    let isNegativeTable = false;
    for (let k = Math.max(0, i - 6); k < i; k++) {
      const prevLine = lines[k];
      if (NEGATIVE_HEADER_PATTERNS.some((re) => re.test(prevLine))) {
        isNegativeTable = true;
        break;
      }
    }
    if (isNegativeTable) continue;

    // 接下来扫描数据行（直到遇到非表格行）
    for (let j = i + 1; j < lines.length; j++) {
      const dataLine = lines[j];
      if (!dataLine.match(/^\|/)) break; // 表格结束
      const cells = dataLine.split("|").map((c) => c.trim()).filter((c) => c !== "");
      if (cells.length === 0) continue;
      const firstDataCell = cells[0];
      // 抓取第一个 cell 里所有反引号包裹的 token
      const re = /`([a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9]|[a-zA-Z])`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(firstDataCell)) !== null) {
        out.add(m[1]);
      }
    }
  }
  return Array.from(out);
}

/**
 * 内置 agent 的 prompt → (allowedTools, deniedTools) 映射表。
 *
 * 来源（截至 Task #2033）：
 * - `default` agent: packages/core/src/env/environment.ts:253-281
 * - `roy` agent: packages/core/src/env/agent/agent-registry.ts (`registerRoyAgent`)
 * - `workflow-agent`/`json-extract`/`workflow-extract`/`compact`/`compact-hint`: agent-registry.ts
 * - `memory-extract-{project,global}`: packages/cli/src/commands/memory/record.ts:101-119
 *
 * 维护说明：每次新增/修改内置 agent 时，必须同步更新这张表，否则测试会失败。
 */
const BUILT_IN_AGENT_TOOL_PROFILES: ReadonlyArray<{
  /** 关键 prompt 名字（在 builtInPrompts 里） */
  promptName: keyof typeof builtInPrompts;
  /** 对应的 agent 名（用于错误信息） */
  agentName: string;
  /** 白名单（undefined 表示不过滤） */
  allowedTools?: string[];
  /** 黑名单 */
  deniedTools: string[];
  /**
   * 子智能体上下文例外：这些 token 出现在 prompt 的工具表中时，是因为"传给子 agent 看的"，
   * 不算 default 自己的工具引用。
   * 当前仅 default agent 有这种情况（delegate_task prompt 模板里的工具名）。
   */
  subAgentTemplateTokens?: readonly string[];
}> = [
  {
    promptName: "default",
    agentName: "default",
    // ★ Task #5007 — 验收权移交 default agent：task_complete 从 deniedTools 移出
    //   （default 负责最终验收，触发 goal 检查 decision model）；task_cancel 同理可用。
    //   task_create / task_update / task_operation_* 仍禁用 ⇒ default 只验收不执行。
    deniedTools: [
      "echo",
      "glob",
      "grep",
      "write_file",
      "edit_file",
      "task_create",
      "task_update",
      "task_delete",
      "task_operation_create",
      "task_operation_update",
      "task_operation_delete",
      "skill",
      "record_memory",
      "recall_memory",
      "search_sessions",
      "get_session",
      "write_memory",
      "mcp_1",
      "mcp_2",
      "mcp_3",
      "mcp_4",
      "mcp_5",
    ],
    subAgentTemplateTokens: [
      // 这些工具名在 default prompt 中出现在 delegate_task prompt 模板里
      // （作为"指示子 agent 使用"的指令），不算 default 自己的工具
      "task_create",
      "task_update",
      "task_operation_create",
      "task_operation_update",
      "task_delete",
    ],
  },
  {
    promptName: "roy",
    agentName: "roy",
    // ★ Task #5007 — task_complete 移交 default agent（roy 只执行 + 记操作记录）
    deniedTools: ["delegate_task", "stop_task", "task_complete"],
  },
  {
    // Task #2247: workflow-runner 扩展工具集（移除白名单，Roy 风格 + 保留 deniedTools 安全约束）
    // 工具表更新见 prompts-index.ts 'workflow-runner' 段
    promptName: "workflow-runner",
    agentName: "workflow-runner",
    // 移除 allowedTools 白名单（Roy 风格：除 deniedTools 外全部可用）
    allowedTools: undefined,
    deniedTools: ["delegate_task", "stop_task"],
  },
  {
    promptName: "json-extract",
    agentName: "json-extract",
    allowedTools: ["workflow_submit_output"],
    deniedTools: [],
  },
  {
    promptName: "workflow-extract",
    agentName: "workflow-extract",
    allowedTools: [
      "workflow_get",
      "workflow_list",
      "workflow_add",
      "workflow_validate",
    ],
    deniedTools: [],
  },
  {
    promptName: "compact",
    agentName: "compact",
    allowedTools: ["workflow_submit_output"],
    deniedTools: [],
  },
  {
    promptName: "compact-hint",
    agentName: "compact-hint",
    allowedTools: ["workflow_submit_output"],
    deniedTools: [],
  },
  {
    promptName: "project-memory",
    agentName: "memory-extract-project",
    allowedTools: ["search_sessions", "get_session", "write_memory", "bash", "glob", "read_file"],
    deniedTools: [],
  },
  {
    promptName: "global-memory",
    agentName: "memory-extract-global",
    allowedTools: ["search_sessions", "get_session", "write_memory"],
    deniedTools: [],
  },
  {
    // Task #2348: task-organizer 任务树整理子智能体
    // 15 个任务管理工具白名单：核心 CRUD + 观察 + 批量 + operation
    // 详细工具集见 agent-registry.ts `registerTaskOrganizer()`
    promptName: "task-organizer",
    agentName: "task-organizer",
    allowedTools: [
      "task_create",
      "task_get",
      "task_list",
      "task_update",
      "task_delete",
      "task_complete",
      "task_tree",
      "task_search",
      "task_batch_archive",
      "task_batch_delete",
      "task_operation_create",
      "task_operation_get",
      "task_operation_list",
      "task_operation_update",
      "task_operation_delete",
    ],
    deniedTools: ["delegate_task", "stop_task"],
  },
];

describe("Built-in Prompt × Available Tools Consistency (Task #2033 P2)", () => {
  for (const profile of BUILT_IN_AGENT_TOOL_PROFILES) {
    describe(`${profile.agentName} (prompt=${String(profile.promptName)})`, () => {
      const prompt = builtInPrompts[profile.promptName];
      test("prompt must exist", () => {
        expect(prompt, `builtInPrompts[${String(profile.promptName)}] must exist`).toBeDefined();
      });

      test("工具表第一列的所有工具名都必须真实可用", () => {
        if (!prompt) return;

        // 计算实际可用工具集合
        const allowedSet = new Set(profile.allowedTools ?? []);
        const deniedSet = new Set(profile.deniedTools);
        // allowedTools 未定义（白名单模式关闭）→ 所有不在 deniedTools 里的工具都可用
        const availableAllowsAnything = !profile.allowedTools;

        // 提取工具表里的工具名
        const tokens = extractTableFirstColumnTokens(prompt);
        const subAgentSet = new Set<string>(profile.subAgentTemplateTokens ?? []);

        const violations: string[] = [];
        for (const tok of tokens) {
          if (subAgentSet.has(tok)) continue;
          if (availableAllowsAnything) {
            // 只检查是否在 deniedTools 里
            if (deniedSet.has(tok)) violations.push(tok);
          } else {
            // 必须在 allowedTools 里且不在 deniedTools 里
            if (!allowedSet.has(tok) || deniedSet.has(tok)) {
              violations.push(tok);
            }
          }
        }

        if (violations.length > 0) {
          const allowedDesc = profile.allowedTools
            ? `allowedTools=${JSON.stringify(profile.allowedTools)}`
            : "(all tools allowed except deniedTools)";
          throw new Error(
            `${profile.agentName}: prompt 工具表里有这些工具名，但它们对该 agent 不可用：` +
              JSON.stringify(violations) +
              `\n${allowedDesc}\ndeniedTools=${JSON.stringify(profile.deniedTools)}`,
          );
        }
        expect(violations).toEqual([]);
      });
    });
  }
});