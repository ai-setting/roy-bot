/**
 * @fileoverview Subagent resolution — built-in specs + AgentRegistry
 */

import {
  AgentRegistry,
  DEFAULT_SUBAGENT_PROMPT,
  type AgentDefinition,
} from "../../agent/agent-registry";
import type { SubAgentSpec } from "./delegate-tool";
import { builtInSubAgents, getSubAgentSpec } from "./delegate-tool";

export interface ResolvedSubAgentConfig {
  subagentType: string;
  description: string;
  basePrompt: string;
  allowedTools?: string[];
  deniedTools: string[];
  fromRegistry: boolean;
}

export function isKnownSubagentType(
  subagentType: string,
  registry?: AgentRegistry
): boolean {
  if (getSubAgentSpec(subagentType)) {
    return true;
  }
  return registry?.hasAgent(subagentType) ?? false;
}

export async function resolveSubAgentConfig(
  subagentType: string,
  options: {
    registry?: AgentRegistry;
    getBuiltIn?: (id: string) => SubAgentSpec | undefined;
  } = {}
): Promise<ResolvedSubAgentConfig | undefined> {
  const getBuiltIn = options.getBuiltIn ?? getSubAgentSpec;
  const builtIn = getBuiltIn(subagentType);
  const agentDef = options.registry?.get(subagentType);

  if (!builtIn && !agentDef) {
    return undefined;
  }

  if (agentDef) {
    return resolveFromRegistry(subagentType, agentDef, builtIn, options.registry);
  }

  return {
    subagentType,
    description: builtIn!.description,
    basePrompt: builtIn!.promptOverride || DEFAULT_SUBAGENT_PROMPT,
    allowedTools: builtIn!.allowedTools,
    deniedTools: builtIn!.deniedTools ?? ["delegate_task", "stop_task"],
    fromRegistry: false,
  };
}

async function resolveFromRegistry(
  subagentType: string,
  agentDef: AgentDefinition,
  builtIn: SubAgentSpec | undefined,
  registry?: AgentRegistry
): Promise<ResolvedSubAgentConfig> {
  const resolvedPrompt = registry
    ? await registry.getSystemPrompt(subagentType)
    : agentDef.systemPrompt;

  return {
    subagentType,
    description: agentDef.description || builtIn?.description || "Custom agent",
    basePrompt:
      resolvedPrompt || builtIn?.promptOverride || DEFAULT_SUBAGENT_PROMPT,
    allowedTools: agentDef.allowedTools ?? builtIn?.allowedTools,
    deniedTools:
      agentDef.deniedTools ??
      builtIn?.deniedTools ??
      ["delegate_task", "stop_task"],
    fromRegistry: true,
  };
}

/**
 * English selection guide appended to delegate_task tool description.
 * Agent details come from the bullet list above (builtInSubAgents + registry).
 */
function buildAgentSelectionGuide(options: { hasCustomAgents: boolean }): string {
  const customAgentNote = options.hasCustomAgents
    ? "- Custom agents from AgentRegistry are listed above."
    : "- Custom agents from AgentRegistry appear above when registered.";

  return `
## Agent Selection Guide

- Choose \`subagent_type\` from the list above; use \`general\` when no specialized agent fits (default).
${customAgentNote}
- For full metadata: \`roy-bot agents list\`, \`roy-bot agents get <name>\`, \`roy-bot prompt list\`.`;
}

/**
 * 获取可用的 subagent 描述列表
 *
 * @param registry AgentRegistry 实例，用于获取自定义 agents
 * @returns 格式化的 agent 描述列表（英文，与 delegate_task tool description 一致）
 */
export function listKnownSubagentDescriptions(registry?: AgentRegistry): string {
  const builtInLines = builtInSubAgents.map(
    (agent) => `- ${agent.id}: ${agent.description}`
  );

  const registryAgents = registry?.list() ?? [];
  const customLines = registryAgents
    .filter((agent) => !builtInSubAgents.some((builtIn) => builtIn.id === agent.name))
    .map((agent) => {
      if (agent.type === "workflow") {
        const workflowInfo = agent.workflow ? ` (workflow: ${agent.workflow})` : "";
        return `- ${agent.name}: ${agent.description || "Workflow agent"}${workflowInfo}`;
      }
      return `- ${agent.name}: ${agent.description || "Custom agent"}`;
    });

  const lines = [...builtInLines, ...customLines];
  const guidance = buildAgentSelectionGuide({ hasCustomAgents: customLines.length > 0 });

  return lines.join("\n") + guidance;
}
