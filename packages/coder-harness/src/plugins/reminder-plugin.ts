/**
 * @fileoverview ReminderPlugin - 最大迭代次数提醒插件
 *
 * 在 Agent 的 ReAct 循环中，当达到最大迭代次数时，
 * 通过 agent:before.llm hook 注入 user message 提醒 LLM 不要继续调用工具，
 * 直接基于已有信息给用户一个总结。
 *
 * 避免因达到最大迭代次数而无疾而终的情况。
 * 
 * 改造说明：
 * - 继承 BasePlugin，使用统一的 init(env: PluginEnv) 生命周期
 * - 通过 env.registerHook() 注册 hooks
 */

import { createLogger } from "@ai-setting/roy-bot-core";
import { BasePlugin } from "@ai-setting/roy-bot-core";
import type { PluginEnv, HookHandler, HookContext, HookResult } from "@ai-setting/roy-bot-core";

// ========================================================================
// Types
// ========================================================================

/**
 * agent:before.llm hook 数据类型
 */
interface BeforeLLMHookData {
  iteration: number;
  maxIterations: number;
  messages: any[];
}

/**
 * 内置提醒消息模板
 */
const DEFAULT_REMINDER_MESSAGE = `你已经达到了最大 react 次数限制（{maxIterations}次）。

请不要再调用任何工具，利用目前已有的信息，给用户一个简洁明了的总结，包括：
1. 目前的进展
2. 已完成的工作
3. 遇到的问题（如有）
4. 下一步建议（如有）`;

/**
 * ReminderPlugin 配置
 */
export interface ReminderPluginConfig {
  /** 自定义提醒消息模板（可选） */
  messageTemplate?: string;
}

// ========================================================================
// ReminderPlugin
// ========================================================================

/**
 * ReminderPlugin
 *
 * 利用 Agent 的 agent:before.llm hook，在最后一次 LLM 调用前注入提醒消息。
 *
 * 工作原理：
 * - 监听 agent:before.llm hook
 * - 检查当前迭代次数是否达到最大迭代次数
 * - 如果是最后一次调用，注入 user message 提醒 LLM 直接总结
 */
export class ReminderPlugin extends BasePlugin {
  readonly name = "ReminderPlugin";
  readonly version = "1.0.0";
  readonly description = "在最后一次 LLM 调用前注入提醒，避免达到最大迭代次数而无疾而终";
  readonly priority = 100; // 较高，确保在其他 before.llm hooks 之后执行

  private messageTemplate: string;
  private logger: ReturnType<typeof createLogger>;

  constructor(config?: ReminderPluginConfig) {
    super();
    this.messageTemplate = config?.messageTemplate ?? DEFAULT_REMINDER_MESSAGE;
    this.logger = createLogger("ReminderPlugin");
  }

  /**
   * 初始化
   */
  init(env: PluginEnv): void {
    // 注册 hook
    env.registerHook({
      point: "agent:before.llm",
      priority: this.priority,
      handler: this.onBeforeLLM.bind(this) as HookHandler,
    });

    this.logger.info(`[ReminderPlugin] Registered agent:before.llm hook`);
  }

  /**
   * agent:before.llm hook handler
   */
  async onBeforeLLM(ctx: HookContext<BeforeLLMHookData>): Promise<HookResult> {
    const data = ctx.data as BeforeLLMHookData;
    const { iteration, maxIterations, messages } = data;

    // 检查是否是最后一次 LLM 调用
    const isLastIteration = iteration >= maxIterations;

    if (!isLastIteration) {
      return { stopped: false, results: [] };
    }

    // 构建提醒消息
    const reminderContent = this.messageTemplate.replace(
      /\{maxIterations\}/g,
      String(maxIterations)
    );

    // 注入 user message
    messages.push({
      role: "user",
      content: reminderContent,
    } as any);

    this.logger.debug(`[ReminderPlugin] Injected reminder at iteration ${iteration}/${maxIterations}`);

    return { stopped: false, results: [] };
  }
}

/**
 * 创建 ReminderPlugin 实例的工厂函数
 */
export function createReminderPlugin(config?: ReminderPluginConfig): ReminderPlugin {
  return new ReminderPlugin(config);
}
