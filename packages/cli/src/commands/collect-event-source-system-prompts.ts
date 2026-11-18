/**
 * Collect EventSource systemPrompt Preloads (Phase 3)
 *
 * 功能：把 `interactive --es <id>` 启用的所有 event source 的 systemPrompt
 * 一次性 resolve 并收集起来。
 *
 * 这把 systemPrompt 注入从 "event-time only" 扩展为:
 *   - EventSource 启动后立即 preload
 *   - 适用于所有对话 (普通用户输入 + event-triggered dispatches)
 *
 * 设计动机:
 *   1. 当 user 用 `interactive --es bounty-im --es bounty-im-publisher` 时,
 *      AI 不仅应在收到 message event 时知道它有 bounty IM context,
 *      而且任何"我是什么 agent / 我能用 bounty com send --server-url X"
 *      这种语义应在会话启动时即注入 system prompt。
 *   2. 多个 event source 共享 session — 每个 source 有独立 systemPrompt。
 */

import type {
  EventSourceConfig,
  EventSourceComponentInterface,
} from "@ai-setting/roy-bot-core";
import {
  resolveBountyIMSystemPrompt,
  resolveLarkChannelSystemPrompt,
} from "@ai-setting/roy-bot-core";

/**
 * 单个 event source 的 resolved systemPrompt 信息
 */
export interface ResolvedEventSourcePrompt {
  /** source ID */
  id: string;
  /** source type (如 'bounty-im', 'lark-cli' 等) */
  type: string;
  /** resolved prompt text (user-config 或 default) */
  prompt: string;
}

/**
 * 解析一个 event source config 的 systemPrompt:
 * - bounty-im: 用 resolveBountyIMSystemPrompt (含 default 工厂)
 * - lark-cli: ★ ES-M1（Task #5144）用 resolveLarkChannelSystemPrompt
 *   （lean 模式默认注入渠道静态 prompt；legacy 模式返回
 *   config.systemPrompt 原值，未设置则 undefined → 跳过）
 * - 其他 type: 读 config.systemPrompt (没设置则 undefined)
 */
function resolveSystemPromptForSource(
  config: EventSourceConfig
): string | undefined {
  if (config.type === "bounty-im") {
    const imServerUrl =
      (config as any).imServerUrl ||
      (config.options && (config.options as any).imServerUrl);
    const address =
      (config as any).address ||
      (config.options && (config.options as any).address) ||
      "unknown";
    return resolveBountyIMSystemPrompt({
      configSystemPrompt: config.systemPrompt,
      currentAddress: address,
      imServerUrl,
    });
  }
  if (config.type === "lark-cli") {
    return resolveLarkChannelSystemPrompt(config);
  }
  return config.systemPrompt;
}

/**
 * 主函数: 加载所有 --es 配置并解析它们的 systemPrompt
 */
export function collectEventSourceSystemPrompts(
  eventSourceIds: string[],
  eventSourceComponent: EventSourceComponentInterface
): ResolvedEventSourcePrompt[] {
  const result: ResolvedEventSourcePrompt[] = [];
  for (const id of eventSourceIds) {
    const config = eventSourceComponent.get(id);
    if (!config) continue;
    const prompt = resolveSystemPromptForSource(config);
    if (!prompt) continue;
    result.push({ id, type: config.type, prompt });
  }
  return result;
}

/**
 * 把 ResolvedEventSourcePrompt[] 拼成单个 string (用于 metadata.systemPrompt 注入)
 * 用 "\n\n---\n\n" 分隔多个 source 让 LLM 看清边界
 */
export function joinResolvedSystemPrompts(
  prompts: ResolvedEventSourcePrompt[]
): string {
  return prompts.map((p) => p.prompt).join("\n\n---\n\n");
}
