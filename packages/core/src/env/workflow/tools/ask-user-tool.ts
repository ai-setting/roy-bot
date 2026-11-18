/**
 * @fileoverview AskUserTool - Tool for requesting user input in workflow
 *
 * When an AgentNode calls this tool, it throws AskUserError to interrupt
 * the workflow, allowing the workflow to pause and wait for user response.
 *
 * ★ Task #4983 — 无 TTY 场景的 **IM 直连投递**。
 *
 * ## 为什么需要这一段（生产日志铁证）
 *
 * traceId `01a1a68652ee79c9c6508579b504e662`（2026-11-04 20:55:38 → 20:56:09，
 * 飞书 p2p `oc_xxxxxxxxxxxxxxxx`）：
 *
 *   20:55:38.788  [BackgroundTaskManager] Event published: task.background.ask_user
 *                  （triggerEventId + replyChannel 都齐 ✅ —— #3147 的 notify 链路完好）
 *   20:55:38.790  cli.query-executor.execute enter: "[通知] ❓ 后台子代理「…」请求用户输入 …"
 *   20:56:09.513  [agent:component] Iteration 1 error
 *                  {runId:"unknown", nodeId:"unknown", type:"ask-user", name:"AskUserError"}
 *   20:56:09.517  cli.query-executor.execute error: __ASK_USER_ERROR__:{…}
 *   ⇒ 此后该 traceId **0 次** lark messages-send / messages-reply
 *
 * 根因链：
 *   1. 本工具只「抛 AskUserError」当作中断信号；
 *   2. 交互层（REPL + readline）在守护进程（无 TTY）里是死的；
 *   3. headless 下没人接这个异常 ⇒ 直接冒泡终止整次查询；
 *   4. `query-executor.ts` 的 `isAskUserError → return` + `error-reply.ts` 的
 *      `ask_user` 规则 `notify:false` ⇒ **双重静默**，连失败兜底都不发。
 *
 * ⇒ **问题正文从未离开进程，用户零感知**（用户原话：「sub agent 的 ask_user 被淹没了」）。
 *
 * ## 本次修复（路线 A：工具自己投递）
 *
 * 在抛 AskUserError **之前**，若当前上下文存在可用的 IM 投递目标，
 * 就**自己把问题（含选项）投递过去**，让用户真正看到并能答复。
 *
 * 契约：
 *   - C1 无投递目标 → 行为不变（抛 AskUserError，交给 TTY 交互层）
 *   - C2 有投递目标 → 先投递，再抛 AskUserError（中断信号保留，agent 本轮终止）
 *   - C3 投递失败 → **绝不抛**（不能让投递故障掩盖原始中断语义），只记 warn
 *   - C4 投递内容含问题正文 + 选项（用户要能选）
 *   - C5 投递目标从 EnvContext 取（replyChannel → envEvent.metadata.replyChannel）
 *
 * ⚠️ **为什么不在 CLI 层兜底**：CLI 层的兜底（query-executor / error-reply）都只能
 * 看到「一次失败的查询」，拿不到「用户到底要回答什么」的结构化信息，而且要靠
 * 规则表区分「TTY 场景该静默 / headless 场景该发」—— 极易再次静默。
 * 在**工具层**投递是唯一能保证「问题一定离开进程」的位置。
 *
 * ⚠️ **TTY 场景不会重复发（精确条件）**：仅当「有可用投递目标
 * （EnvContext.replyChannel 等）**且** TTY 交互层也会打印」时，
 * 用户会同时看到 IM 那条和本地回显那条 ⇒ **两条，这不是 bug**：
 * 投递到 IM 渠道的那条才是「离开进程」的那条；TTY 那条是给本地
 * 用户看的回显。本地 TTY 通常**没有** replyChannel（不投）；
 * 有 replyChannel 且需要静音时，可通过
 * `context.metadata.askUserDelivery === "off"` 关闭（workflow 路径
 * 已默认关闭，agent-component-adapter.ts）。
 */

import { z } from 'zod';
import type { ToolInfo, ToolContext } from '../../tool/types';
import { AskUserError } from '../types/workflow-hil';
import { getEnvContext } from '../../context';
import { createLogger } from '../../log-trace/logger';
import { deliverAskUserMessage } from '../../error-reply';

const logger = createLogger('AskUserTool');

// ==================== Input Schema ====================

/**
 * AskUserTool input schema
 */
export const AskUserInputSchema = z.object({
  query: z.string().describe('The question or request to ask the user'),
  options: z.array(z.string()).optional().describe('Optional choices for the user'),
  required_confirm: z.boolean().optional().describe('If true, user must explicitly confirm'),
});

export type AskUserInput = z.infer<typeof AskUserInputSchema>;

// ==================== Tool Definition ====================

/**
 * AskUserTool
 *
 * A special tool that can be called by Agent to request user input.
 * Calling this tool will throw AskUserError, which the Executor will
 * catch and convert to a workflow pause event.
 */
export type AskUserTool = ToolInfo<typeof AskUserInputSchema>;

/**
 * Task #4983 — 从 EnvContext 解析可用的 IM 投递目标。
 *
 * 优先级（与 buildRunEnvContext 的 replyChannel 优先级一致）：
 *   1. `envContext.replyChannel`（当前层已构建好的渠道，**带 sendMarkdown/reply 实现**）
 *   2. `envContext.envEvent.metadata.replyChannel`（只有裸字段，没有发送实现）
 *
 * 只有 1 能真正发送（它带 `sendMarkdown` / `reply` 函数）。
 * 2 只提供 chatId/messageId 快照 —— 在 core 层没有 lark-cli 发送器可用，
 * 因此**不作为投递目标**（避免在这里 spawn lark-cli 造成职责外 IO）。
 */
interface DeliveryTarget {
  chatId?: string;
  messageId?: string;
  profile?: string;
  /** 真正能发消息的通道（EnvContext.replyChannel） */
  channel?: {
    sendMarkdown?: (text: string) => Promise<void>;
    sendText?: (text: string) => Promise<void>;
    reply?: (content: unknown) => Promise<void>;
  };
}

/**
 * Task #4983 — 「本轮已经在处理 ask_user 事件」的判据。
 *
 * ## 为什么需要这个判据（防重复投递）
 *
 * 事件链（生产 traceId 01a1a686…）：
 *
 *   sub-agent 调 ask_user
 *     → 本工具投递（**第 1 条**，用户看到问题）✅
 *     → 抛 AskUserError → BackgroundTaskManager 发布 task.background.ask_user
 *     → CLI EventHandler → 主 agent 轮次（本轮 envEvent.type =
 *        'task.background.ask_user'）
 *     → 主 agent 按 hints 调 ask_user
 *        → 本工具**若再投递** ⇒ 用户收到**两条**同样的问题 ❌
 *
 * ⇒ 主 agent 那一轮**必须跳过投递**。
 *
 * ## 判据为什么用 envEvent.type
 *
 * - **sub-agent 那一轮**：envEvent 是**原始触发事件**
 *   （`event-source.event.lark-cli` 或 `task.background.completed` 等），
 *   **绝不会是** `task.background.ask_user`（那个事件在 sub-agent 抛错**之后**
 *   才诞生）。
 * - **主 agent 那一轮**：envEvent 就是 `task.background.ask_user` 本身
 *   （生产日志实测：`"envEvent":{"id":"id_mw24ds83_…","type":"task.background.ask_user"`）。
 *
 * ⇒ 判据精确、无歧义、不依赖时间窗口。
 *
 * ⚠️ 注意：**这只影响"主 agent 转发"这一种情况**。如果主 agent 是在处理
 * 一个**全新的**用户请求时主动要问用户（envEvent 是 lark 用户消息，
 * 不是 ask_user 事件），本工具**仍然要投递**——那时用户确实需要看到问题。
 */
function isProcessingAskUserEvent(envContext: any): boolean {
  const type = (envContext?.envEvent as { type?: unknown } | undefined)?.type;
  return type === 'task.background.ask_user';
}

/** getEnvContext 的安全版（吞掉「无 ALS 上下文」异常，测试/日志用）。 */
function getEnvContextSafe(): any {
  try {
    return getEnvContext();
  } catch {
    return undefined;
  }
}

function resolveDeliveryTarget(
  context: ToolContext,
): { target?: DeliveryTarget; skipReason?: "off" | "guarded-turn" | "delivery-failed" } {
  // 显式关闭（metadata.askUserDelivery === 'off'）—— workflow 路径有
  // 自己的呈现通道（renderRunResult 渲染），语义是「无需投递」。
  if (context.metadata?.askUserDelivery === 'off') {
    return { skipReason: 'off' };
  }

  let envContext: any;
  try {
    envContext = getEnvContext();
  } catch {
    envContext = undefined;
  }
  if (!envContext) return {};

  // ★ 防重复投递：本轮已在处理 ask_user 事件 ⇒ 问题已经由 sub-agent
  //   投递过了（Task #4983 R4 / DS review MAJOR-1）。
  //
  //   ⚠️ 这里必须让调用方区分「已投成」和「投递失败」：
  //   guard 命中 =「本轮不该由我投」。但**是否已投递**
  //   以事件 payload.delivered 为准（delegate-tool.ts:1593
  //   把子 agent 工具层的投递结果写进 payload，权威信号）：
  //   - payload.delivered === true → 子 agent 已投成 ⇒
  //       skipReason='guarded-turn' ⇒ execute 置 delivered=true
  //       ⇒ CLI 兜底不再投（防双发）。
  //   - payload.delivered === false / 缺失 → 子 agent **没投成**
  //       ⇒ 不能吞（返回 undefined 会让旧 R4 把它当已投递）。
  //       这里返回 'delivery-failed' ⇒ execute **回落到正常投递**
  //       （有 replyChannel 就直投/spawn），投不成 delivered=false
  //       ⇒ CLI 兜底层补投 ⇒ 用户至少收到一条，绝不静默。
  //
  //   旧 R4 的无条件 delivered=true 会把「投递失败」也吞成
  //   已投递 → 用户零感知（DS R4 review MAJOR-1，RED-13 锁定）。
  if (isProcessingAskUserEvent(envContext)) {
    const payloadDelivered = (
      envContext.envEvent as { payload?: { delivered?: unknown } } | undefined
    )?.payload?.delivered;
    if (payloadDelivered === true) {
      return { skipReason: 'guarded-turn' };
    }
    // payload.delivered === false / 缺失：视为投递失败/旧事件。
    // 不吞：**继续走下面的正常 target 解析**（带 skipReason 标记），
    // 本轮再投一次；投不成 delivered=false ⇒ CLI 兜底补投。
    const fallback = resolveDeliveryTargetFromContext(context, envContext);
    return { ...fallback, skipReason: 'delivery-failed' };
  }

  return resolveDeliveryTargetFromContext(context, envContext);
}

/**
 * 从 EnvContext 解析投递目标（guard 之后的公共部分）。
 *
 * 优先级（与 buildRunEnvContext 的 replyChannel 优先级一致）：
 *   1. `envContext.replyChannel`（当前层已构建好的渠道，**带 sendMarkdown/reply 实现**）
 *   2. `envContext.envEvent.metadata.replyChannel`（只有裸字段，没有发送实现）
 */
function resolveDeliveryTargetFromContext(
  _context: ToolContext,
  envContext: any,
): { target?: DeliveryTarget } {
  // 1) 当前层 replyChannel（带发送实现）
  const replyChannel = envContext.replyChannel as DeliveryTarget['channel'] & {
    chatId?: string;
    messageId?: string;
    profile?: string;
  } | undefined;

  if (replyChannel) {
    const hasSender =
      typeof replyChannel.sendMarkdown === 'function' ||
      typeof replyChannel.sendText === 'function' ||
      typeof replyChannel.reply === 'function';
    // 没有 chatId 也没 messageId → 无有效目标（C6）
    if (!replyChannel.chatId && !replyChannel.messageId) {
      return {};
    }
    return {
      target: {
        chatId: replyChannel.chatId,
        messageId: replyChannel.messageId,
        profile: replyChannel.profile,
        // 有发送实现就用它；只有裸快照则退回 spawn lark-cli 那条路
        ...(hasSender ? { channel: replyChannel } : {}),
      },
    };
  }

  // 2) envEvent.metadata.replyChannel（裸快照）—— 无发送实现，走 spawn lark-cli
  const metaChannel = (envContext.envEvent as
    | {
        metadata?: {
          replyChannel?: { chatId?: string; messageId?: string; profile?: string };
        };
      }
    | undefined)?.metadata?.replyChannel;
  if (metaChannel?.chatId || metaChannel?.messageId) {
    return {
      target: {
        chatId: metaChannel.chatId,
        messageId: metaChannel.messageId,
        profile: metaChannel.profile,
      },
    };
  }

  return {};
}

/**
 * Task #4983 — 渲染投递到用户渠道的正文。
 *
 * 硬要求：
 *   - 必须含**问题正文**（用户要看的就是问题）
 *   - 必须含**全部选项**（用户要能选）
 *   - 必须含**答复指引**（用户不知道回哪儿答）
 *   - 绝不渲染 `undefined` / `NaN`
 */
export function buildAskUserDeliveryText(args: {
  query: string;
  options?: string[];
  requiredConfirm?: boolean;
}): string {
  const lines: string[] = [];

  lines.push('❓ **需要您确认**');
  lines.push('');
  lines.push(args.query.trim());

  if (args.options && args.options.length > 0) {
    lines.push('');
    lines.push('**可选方案：**');
    args.options.forEach((opt, i) => {
      lines.push(`${i + 1}. ${opt}`);
    });
  }

  if (args.requiredConfirm) {
    lines.push('');
    lines.push('（需要您明确确认后才会继续）');
  }

  lines.push('');
  lines.push('👉 直接在本会话回复文字或序号即可（例如「1」）。');

  return lines.join('\n');
}

/**
 * Task #4983 — 投递问题到 IM 渠道。
 *
 * 两条路：
 *   1. **有发送实现**（EnvContext.replyChannel 带 sendMarkdown/reply）→ 直接调，
 *      不 spawn 子进程（快、无额外进程）。
 *      ⚠️ 该路径底层是 `sendLarkMessage`（**无硬超时**，预存在），
 *      为防 lark-cli 卡死把 AskUserError 拖成 120s 工具超时，
 *      这里包一层 `withDeliveryTimeout`（15s 硬顶）。
 *   2. **只有裸快照**（event-cascade 场景：只有 chatId/messageId/profile）
 *      → 用 `deliverAskUserMessage` spawn lark-cli（复用全仓统一的发送口径：
 *      `--as bot` / profile / 硬超时 5s / @-mention 规范化）。
 *
 * **绝不抛**（C3）：投递失败只记 warn，原始 AskUserError 中断语义必须保留。
 *
 * @returns 是否投递成功（仅用于日志/测试断言，不参与控制流）
 */

/** 通道直调路径的投递硬顶（lark-cli 正常 <1s，15s 是 15 倍余量） */
const DELIVERY_TIMEOUT_MS = 15_000;

/** 给一个可能永不 settle 的 promise 套硬顶。超时按失败处理（不 reject 出去）。 */
function withDeliveryTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export async function deliverAskUserToChannel(
  target: DeliveryTarget,
  text: string,
): Promise<boolean> {
  const channel = target.channel;
  if (channel) {
    try {
      if (typeof channel.sendMarkdown === 'function') {
        const r = await withDeliveryTimeout(
          Promise.resolve(channel.sendMarkdown(text)),
          DELIVERY_TIMEOUT_MS,
        );
        if (r === null) {
          logger.warn('[ask_user] Channel delivery timed out (ignored)', {
            chatId: target.chatId,
            timeoutMs: DELIVERY_TIMEOUT_MS,
          });
          return false;
        }
        return true;
      }
      if (typeof channel.sendText === 'function') {
        const r = await withDeliveryTimeout(
          Promise.resolve(channel.sendText(text)),
          DELIVERY_TIMEOUT_MS,
        );
        if (r === null) {
          logger.warn('[ask_user] Channel delivery timed out (ignored)', {
            chatId: target.chatId,
            timeoutMs: DELIVERY_TIMEOUT_MS,
          });
          return false;
        }
        return true;
      }
      if (typeof channel.reply === 'function' && target.messageId) {
        const r = await withDeliveryTimeout(
          Promise.resolve(channel.reply(text)),
          DELIVERY_TIMEOUT_MS,
        );
        if (r === null) {
          logger.warn('[ask_user] Channel delivery timed out (ignored)', {
            chatId: target.chatId,
            timeoutMs: DELIVERY_TIMEOUT_MS,
          });
          return false;
        }
        return true;
      }
      return false;
    } catch (err) {
      // C3：绝不抛 —— 投递故障不能掩盖原始中断语义
      logger.warn('[ask_user] Failed to deliver question to channel (ignored)', {
        error: err instanceof Error ? err.message : String(err),
        chatId: target.chatId,
      });
      return false;
    }
  }

  // 裸快照 → spawn lark-cli
  if (!target.chatId && !target.messageId) return false;
  const result = await deliverAskUserMessage({
    chatId: target.chatId,
    messageId: target.messageId,
    profile: target.profile,
    content: text,
  });
  if (!result.sent) {
    logger.warn('[ask_user] Failed to deliver question via lark-cli (ignored)', {
      error: result.error,
      chatId: target.chatId,
    });
  }
  return result.sent;
}

export const askUserTool: AskUserTool = {
  name: 'ask_user',
  description: 'Ask user for input or confirmation. Use this tool when you need user input or validation to continue the workflow.',

  parameters: AskUserInputSchema,

  /**
   * Execute the tool
   *
   * @param args - Tool arguments including query
   * @param context - Tool context
   * @throws AskUserError - Always throws to interrupt workflow
   */
  async execute(
    args: AskUserInput,
    context: ToolContext
  ): Promise<{ success: boolean; output: string }> {
    // Extract context info from metadata with fallbacks
    // Task #1837: runId == sessionId. runId now natively carries the
    // `workflow_` prefix, so sessionId fallback is just `runId` (not
    // `workflow_${runId}` which would have double-prefixed).
    const runId = (context.metadata?.runId as string) || 'unknown';
    const sessionId = (context.metadata?.sessionId as string) || runId;
    const nodeId = (context.metadata?.nodeId as string) || 'unknown';

    // Build query with options if provided
    let fullQuery = args.query;
    if (args.options && args.options.length > 0) {
      fullQuery = `${args.query} (选项: ${args.options.join(', ')})`;
    }

    // ★ Task #4983：无 TTY 场景的 IM 直连投递（**在抛错之前**）。
    //
    // 三分支语义（R5 / DS R4 review MAJOR-1 修复）：
    //   - target 命中         → 投递，delivered = 投递结果
    //   - skipReason='guarded-turn' → guard 命中且 payload.delivered=true
    //        （sub-agent 已投成）⇒ **视为已投递**（delivered=true）
    //        ⇒ CLI 兜底层不会再投（防双发）。
    //   - skipReason='delivery-failed' → guard 命中但 payload.delivered
    //        非 true（sub-agent 投递失败/旧事件）⇒ **不吞**：
    //        target 已由 resolveDeliveryTarget 解析（guard 分支
    //        继续走 replyChannel 解析），本轮照常投递；
    //        投不成 delivered=false ⇒ CLI 兜底层补投 ⇒ 绝不静默。
    //   - skipReason='off' / 无目标 → 未投递（delivered=false）
    //        ⇒ CLI 兜底层照旧补投（headless 最后一张网）。
    const resolved = resolveDeliveryTarget(context);
    const target = resolved.target;
    let delivered = false;
    if (resolved.skipReason === 'guarded-turn') {
      // guard 命中且子 agent 已投成：本轮不投，语义上是「已投递」
      delivered = true;
      logger.info('[ask_user] Guarded turn — question already delivered by sub-agent, skip (delivered=true)', {
        envEventType: (getEnvContextSafe()?.envEvent as { type?: unknown })?.type,
      });
    } else if (target) {
      // 正常投递（含 delivery-failed 回落：guard 命中但子 agent
      // 没投成，本轮再试一次，投不成交给 CLI 兜底）
      const text = buildAskUserDeliveryText({
        query: args.query,
        options: args.options,
        requiredConfirm: args.required_confirm,
      });
      delivered = await deliverAskUserToChannel(target, text);
      logger.info('[ask_user] Question delivered to channel', {
        chatId: target.chatId,
        delivered,
        skipReason: resolved.skipReason,
        hasOptions: Boolean(args.options && args.options.length > 0),
      });
    }

    // Throw AskUserError to interrupt workflow
    //
    // ★ Task #4983：`delivered` 标记随异常一起上抛 ⇒ CLI 层据此判断
    //   「工具层已经投过了」⇒ 兜底层跳过 ⇒ 用户不会收到两条。
    throw new AskUserError(
      runId,
      sessionId,
      nodeId,
      'agent',
      fullQuery,
      undefined,
      undefined,
      delivered,
    );
  },

  metadata: {
    category: 'workflow',
    tags: ['human-in-loop', 'user-input'],
    version: '1.0.0',
  },
};

// Export singleton instance (alias)
export const askUserToolInstance = askUserTool;
