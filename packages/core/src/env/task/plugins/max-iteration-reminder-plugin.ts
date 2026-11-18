/**
 * @fileoverview MaxIterationReminderPlugin — Task #2580 (round 2)
 *
 * ReAct 循环的最大迭代收尾提醒（all-agents scope），与 AutoTaskPlugin
 * 使用**完全相同**的 meta-protocol：在 `agent:after.tool` hook 中通过共享
 * helper `enqueueToAddFakeUserMessage` 设置
 * `ctx.toolResult.result.metadata.toAddFakeUserMessage`。AgentComponent
 * 现有 meta-protocol 消费逻辑（`consumeMetaProtocolUserMessage` +
 * for-loop 结束后 `flushPendingFakeUserMessage`）会按既定时机 flush。
 *
 * ## 为什么 round 2 不用 side-channel
 *
 * - 旧实现（commit f7fd5287）：plugin 直接 push ctx.messages
 * - round 1 旧实现（commit 07945d35）：引入 HookContext.pendingFakeUserMessage +
 *   AgentComponent.flushPendingFakeUserMessageBeforeLlm 新 side-channel
 * - round 2 新实现（本文件）：与 AutoTaskPlugin 完全相同的实现方式，复用
 *   `toolResult.result.metadata.toAddFakeUserMessage` 同一字段、同一个
 *   AgentComponent 消费路径
 *
 * ## Off-by-one 精确处理
 *
 * 目标：让最后一次允许的 LLM iteration (iter === maxIterations) 看到提醒。
 * 因此在 `iteration === maxIterations - 1` 的 `agent:after.tool` 触发——
 * 此时 LLM 已返回 tool_call，工具已执行，after.tool hook 写 metadata；
 * 下一个 iteration === maxIterations 是最后一次 LLM 调用，for-loop 结束后
 * AgentComponent flush metadata → push user(reminder) → 下次 invokeLLM 看到。
 *
 * maxIterations === 1 时 iter === 0 === maxIter-1 = 0 触发，但 iter=1 之前
 * 没有"上一轮"，loop 也不进入 iter=0 的 after.tool（因为 iter=0 时 loop
 * 条件 `iteration < 1` 失败，loop 不执行）。因此 maxIterations <= 1 时
 * **防御性跳过**——不伪造 toolResult，不凭空写入 metadata。
 *
 * ## 与 AutoTaskPlugin v5.2 的关系（共享 helper + 确定性合并）
 *
 * | 维度             | AutoTaskPlugin v5.2                | MaxIterationReminderPlugin (本文件) |
 * | ---------------- | ---------------------------------- | ---------------------------------- |
 * | Hook             | `agent:after.tool`                 | `agent:after.tool`                 |
 * | 触发条件          | `iteration === threshold` (默认 20) | `iteration === maxIterations - 1`  |
 * | 适用范围          | 仅 `agent.name === "default"`       | 所有 agent（default + sub-agents）   |
 * | Meta-protocol 字段 | `ctx.toolResult.result.metadata.toAddFakeUserMessage` | 同左（共享） |
 * | 文案意图          | 建议调 delegate_task 到 roy       | 要求立即总结、不要工具、然后结束     |
 * | 注册方式          | `environment.ts:334` 显式注册       | 通过 `registerAgent()` 自动注册     |
 *
 * 当 `threshold === maxIter-1` 时同轮触发，共享 helper 确定性合并：
 * 最终 user message 顺序为 `[delegate reminder..., max-iter reminder...]`，
 * max-iter "不要再调用任何工具、直接总结" 永远在末尾作为最终指令。
 *
 * ## AI SDK 邻接约束
 *
 * 与 AutoTaskPlugin 完全相同的 flush 时机：for-loop 结束后立即 push user
 * message 到 `messages`，保证 `[assistant(tool_calls), tool(A), tool(B), tool(C), user(reminder)]` 顺序。
 * 不在 tool_results 之间插入 user message，AI SDK v6 邻接天然满足。
 */

import { createLogger } from "../../log-trace/logger";
import { TracedAs } from "../../log-trace/decorator";
import type { Plugin, HookContext, HookResult } from "../../agent/types";
import type { ModelMessage } from "ai";
import { enqueueToAddFakeUserMessage } from "./fake-user-message-helper";

const logger = createLogger("MaxIterationReminderPlugin");

/**
 * 默认 reminder 文案
 *
 * 关键短语：
 * - "已经达到最大 ReAct 迭代次数" → 标记
 * - "{maxIterations}" → 数字占位符
 * - "不要再调用任何工具" → 最终优先指令
 * - "总结" / "目前的进展" → 明确输出结构
 */
const DEFAULT_REMINDER_MESSAGE = `⚠️ **系统提醒**: 你已经达到最大 ReAct 迭代次数（{maxIterations}次）。

**请不要再调用任何工具**，利用目前已有的信息直接给用户一个简洁明了的总结，包括：
1. 目前的进展
2. 已完成的工作
3. 遇到的问题（如有）
4. 下一步建议（如有）

总结后立即结束，不要继续工具调用。`;

export interface MaxIterationReminderPluginConfig {
  /** 自定义提醒消息模板（可选）。支持 `{maxIterations}` 占位符。 */
  messageTemplate?: string;
}

/**
 * MaxIterationReminderPlugin
 *
 * 在 agent:after.tool hook 中检测 `iteration === maxIterations - 1`，
 * 通过共享 helper `enqueueToAddFakeUserMessage` 设置
 * `ctx.toolResult.result.metadata.toAddFakeUserMessage`（kind="max-iter"）。
 * AgentComponent 现有 meta-protocol 消费路径会在 for-loop 结束后 flush。
 *
 * 适用范围：所有 agent（无 agentName 过滤）。
 * 由 `AgentComponent.registerAgent()` 在每个 agent 创建时自动注册。
 *
 * 限制：`maxIterations <= 1` 时无"上一轮 after.tool → 最后一轮 LLM"边界，
 * 防御性跳过（不伪造 toolResult，不凭空写入 metadata）。
 *
 * 注意（2026-10-16）：compact / compact-hint 已从 `maxIterations=1` 改为 3
 * （给「首轮没调对 tool」留一次真正重试），因此它们**会**走本插件：
 * 提醒落在 iteration 2、压制 iteration 3。取 3 而非 2 正是为了让 iteration 2
 * 保持干净（值为 2 时提醒会在 iteration 1 就掐死唯一的重试机会）。
 * 详见 AgentRegistry.registerCompactAgent() 的注释。
 */
export class MaxIterationReminderPlugin {
  readonly name = "MaxIterationReminderPlugin";
  readonly version = "3.0.0"; // 升级：与 AutoTaskPlugin 共享 meta-protocol
  readonly description =
    "在 iteration === maxIterations - 1 时通过共享 meta-protocol helper 注入 fake user 消息；AgentComponent 现有 for-loop 后 flush；适用于所有 agent。maxIterations<=1 防御性跳过。";
  readonly priority = 50; // 与 AutoTaskPlugin 同优先级

  private readonly messageTemplate: string;
  /** per-query (traceId) 去重，确保一次 query 内只声明一次 */
  private readonly injectedTraceIds = new Set<string>();

  constructor(config?: MaxIterationReminderPluginConfig) {
    this.messageTemplate = config?.messageTemplate ?? DEFAULT_REMINDER_MESSAGE;
  }

  /**
   * Hook handler — 在 agent:after.tool 时调用。
   *
   * 注入条件（必须同时满足）：
   * 1. agent 当前 maxIterations > 1（防御性：单轮 agent 无前置迭代可触发）
   * 2. `iteration === maxIterations - 1`（让 iter === maxIterations 的最后
   *    LLM 调用看到此 reminder）
   * 3. 该 traceId 下尚未声明过（幂等保证）
   *
   * 行为：通过共享 helper 写入 `ctx.toolResult.result.metadata.toAddFakeUserMessage`。
   * **不直接 push 到 ctx.messages**（meta-protocol 契约）。
   *
   * Trace span: `plugin.max-iter-reminder.evaluate`
   * - attributes.params: not recorded (HookContext is too large)
   * - log: true (captures logger.info lines for decision + metadata enqueue)
   * - resultFilter: exposes iteration, maxIterations, willSet, kind
   *
   * @returns HookResult `{ continue: true }`，不中断执行
   */
  @TracedAs("plugin.max-iter-reminder.evaluate", {
    recordParams: false,
    recordResult: false,
    log: true,
    resultFilter: (result: any) => {
      const d = result?.__maxIterDecision;
      if (!d) return {};
      return {
        "max-iter.iteration": d.iteration,
        "max-iter.max_iterations": d.maxIterations,
        "max-iter.will_set": d.willSet,
        "max-iter.kind": d.kind,
        "max-iter.reason": d.reason,
        "max-iter.trace_id": d.traceId,
      };
    },
  })
  async execute(ctx: HookContext): Promise<HookResult> {
    const { iteration, maxIterations } = ctx as unknown as {
      iteration: number;
      maxIterations: number;
    };

    const traceId =
      (ctx.context as any)?.traceId ??
      (ctx.context as any)?.sessionId ??
      "unknown";
    const kind = "max-iter";

    // Helper: build a HookResult with attached __maxIterDecision (used by
    // @TracedAs resultFilter to expose decision attributes).
    const makeResult = (willSet: boolean, reason: string): HookResult => {
      const decision = { willSet, iteration, maxIterations, kind, reason, traceId };
      return { continue: true, __maxIterDecision: decision } as any;
    };

    // Defensive: required fields must exist
    if (typeof iteration !== "number" || typeof maxIterations !== "number") {
      logger.debug(
        `[MaxIterReminder] skip — non-numeric iter=${iteration} or maxIter=${maxIterations}`,
      );
      return makeResult(false, "non-numeric-iter-or-maxIter");
    }

    // ★ maxIterations <= 1 防御性跳过 (Task #2580 round 2 明确要求)
    // 单轮 one-shot agent（compact/compact-hint）没有"上一轮 after.tool →
    // 最后一轮 LLM"边界，不能伪造 toolResult。
    if (maxIterations <= 1) {
      logger.debug(
        `[MaxIterReminder] skip — maxIterations=${maxIterations} <= 1 (one-shot agent)`,
      );
      return makeResult(false, "max-iterations-le-1");
    }

    // Off-by-one: 触发点 = maxIterations - 1
    // 下一个 iteration === maxIterations 是最后一次 LLM 调用，for-loop
    // 结束后 AgentComponent flush metadata → LLM 看到 reminder。
    if (iteration !== maxIterations - 1) {
      // 安静 skip (不记 log 以免噪声)
      return makeResult(false, "iter-not-equal-max-iter-minus-1");
    }

    // after.tool hook 必须有 toolResult
    if (!ctx.toolResult) {
      logger.warn(
        `[MaxIterReminder] skip — toolResult missing at iter=${iteration}`,
      );
      return makeResult(false, "no-tool-result");
    }

    // Per-query idempotency
    if (this.injectedTraceIds.has(traceId)) {
      logger.debug(
        `[MaxIterReminder] skip — traceId=${traceId.slice(0, 20)} already processed`,
      );
      return makeResult(false, "trace-id-already-processed");
    }

    const reminderContent = this.messageTemplate.replace(
      /\{maxIterations\}/g,
      String(maxIterations),
    );

    // ★ 与 AutoTaskPlugin 完全相同：调用共享 helper 写入 metadata
    enqueueToAddFakeUserMessage(
      ctx.toolResult,
      {
        role: "user",
        content: reminderContent,
      } as ModelMessage,
      kind,
    );

    this.injectedTraceIds.add(traceId);

    logger.info(
      `[MaxIterReminder] max-iter reminder meta-protocol set (session=${((ctx.context as any)?.sessionId ?? "unknown").slice(0, 12)}..., iteration=${iteration}, maxIterations=${maxIterations})`,
    );

    return makeResult(true, "fired");
  }
}

/**
 * 创建 MaxIterationReminderPlugin 实例
 */
export function createMaxIterationReminderPlugin(
  config?: MaxIterationReminderPluginConfig,
): Plugin {
  const inst = new MaxIterationReminderPlugin(config);
  return {
    name: inst.name,
    version: inst.version,
    description: inst.description,
    hooks: [
      { point: "agent:after.tool", priority: inst.priority },
    ],
    execute: async (ctx: HookContext): Promise<HookResult> => {
      return inst.execute(ctx);
    },
  };
}
