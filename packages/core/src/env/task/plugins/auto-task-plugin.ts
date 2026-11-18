/**
 * @fileoverview AutoTaskPlugin v5.2 — uses shared meta-protocol helper
 *
 * 在 ReAct 循环达到 iteration 阈值（默认 20）时，在 agent:after.tool hook 中：
 * 1. 检测 iteration === threshold && agent.name === agentName
 * 2. per-query 去重（通过 traceId）
 * 3. 调用 `enqueueToAddFakeUserMessage(ctx.toolResult, msg, "delegate")`：
 *    设置 hookCtx.toolResult.result.metadata.toAddFakeUserMessage = {role:"user", ...}
 *    与 MaxIterReminderPlugin 共享同一字段，确定性合并
 * 4. React 循环在 pushMessage(tool result) 之后读取此 metadata 并 push user message
 * 5. 保证 messages 顺序：[assistant(tool_calls), tool(result), user(reminder)] ✅
 *    满足 AI SDK 要求 tool_call 与 tool_result 必须相邻
 *
 * v5.2 相比 v5.1 的核心改进（Task #2580 round 2）：
 * - ✅ 不再直接设置 `metadata.toAddFakeUserMessage = msg`（可能覆盖其他 plugin）
 * - ✅ 改用共享 helper `enqueueToAddFakeUserMessage`，确定性合并多个 reminder
 * - ✅ 在同一边界（如 threshold === maxIter-1）与 MaxIterReminderPlugin 协同工作
 */

import { createLogger } from "../../log-trace/logger";
import { wrapFunction } from "../../log-trace/decorator";
import type { Plugin, HookContext, HookResult } from "../../agent/types";
import type { ModelMessage } from "ai";
import { enqueueToAddFakeUserMessage } from "./fake-user-message-helper";

const logger = createLogger("AutoTaskPlugin");

export interface AutoTaskPluginConfig {
  /**
   * ReAct iteration 阈值（达到该 iteration 时触发提醒；默认 20）
   *
   * 如果你的场景是「永不提醒」，请传 `threshold: Infinity`（或在注册时关闭插件）。
   */
  threshold?: number;
  /** 仅在该 agent name 下触发（默认 "default"） */
  agentName?: string;
}

/**
 * 创建 AutoTaskPlugin v5.2
 *
 * 在 agent:after.tool hook 中，检测 iteration 达到阈值时：
 * 1. 通过共享 helper 设置 hookCtx.toolResult.result.metadata.toAddFakeUserMessage
 * 2. React 循环在 pushMessage(tool result) 之后读取此 metadata 并 push user message
 * 3. 下一轮 LLM 调用会看到 user reminder，agent 自主决定调用 delegate_task
 */
export function createAutoTaskPlugin(config?: AutoTaskPluginConfig): Plugin {
  const threshold = config?.threshold ?? 20;
  const agentName = config?.agentName ?? "default";
  /** 已处理的最新的 traceId（per-query 去重） */
  let lastProcessedTraceId = "";

  async function executeImpl(ctx: HookContext): Promise<HookResult> {
    try {
      logger.info(`[AutoTaskPlugin:ENTER] agentName=${ctx.agent.name} iteration=${ctx.iteration} threshold=${threshold}`);

      // 只对指定 agent 生效
      if (ctx.agent.name !== agentName) return { continue: true };

      // 仅在迭代次数精确等于阈值时触发
      if (ctx.iteration !== threshold) return { continue: true };

      // 使用 traceId 作为 per-query 标识进行去重
      const traceId = ctx.context?.traceId ?? ctx.context?.sessionId ?? "unknown";
      if (traceId === lastProcessedTraceId) {
        logger.debug(`[AutoTaskPlugin] skip - traceId=${traceId.slice(0, 20)}... already processed`);
        return { continue: true };
      }
      lastProcessedTraceId = traceId;
      logger.debug(`[AutoTaskPlugin] new query detected (traceId=${traceId.slice(0, 20)}...)`);

      // ===== v5.2 Meta Protocol: shared helper =====
      // React 循环在 pushMessage(tool result) 之后会读取此 metadata 并立即 push user message，
      // 保证 messages 顺序：[assistant(tool_calls), tool(result), user(reminder)]
      const reminderContent =
        `⚠️ **系统提醒**: 你已经调用了 ${ctx.iteration} 次工具，达到 iteration 阈值（默认 ${threshold}）。\n` +
        `当前请求较为复杂，建议通过 \`delegate_task\` 工具将整个任务委托给 \`roy\` sub-agent 处理。` +
        `注意，需要让roy为这个任务调用task create工具来创建任务进行跟踪，这个是必走程序哈。`;

      // 防御性检查：after.tool hook 中 toolResult 必须存在，但若缺失则跳过
      if (!ctx.toolResult) {
        logger.warn(
          `[AutoTaskPlugin] toolResult missing, skip meta-protocol (iteration=${ctx.iteration})`
        );
        return { continue: true };
      }

      // ★ 通过共享 helper 声明 fake user 消息意图 (与 MaxIterReminder 共享同一字段，
      //   确定性合并：max-iter 永远在末尾作为最终指令)
      enqueueToAddFakeUserMessage(
        ctx.toolResult,
        {
          role: "user",
          content: reminderContent,
        } as ModelMessage,
        "delegate",
      );

      logger.info(
        `[AutoTaskPlugin] user reminder meta-protocol set (session=${(ctx.context?.sessionId ?? "unknown").slice(0, 12)}..., iteration=${ctx.iteration})`
      );

      return { continue: true };
    } catch (err) {
      logger.error(
        `[AutoTaskPlugin] hook failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return { continue: true };
    }
  }

  const execute = wrapFunction(executeImpl, "plugin.auto-task.launch-agent", {
    recordParams: false,
    recordResult: true,
    log: true,
  });

  return {
    name: "AutoTaskPlugin",
    version: "5.2.0",
    description: "ReAct iteration 达到阈值时通过共享 meta-protocol helper 注入 user 消息（与 MaxIterReminder 共用字段、确定性合并）",

    hooks: [
      { point: "agent:after.tool", priority: 50 },
    ],

    execute,
  };
}
