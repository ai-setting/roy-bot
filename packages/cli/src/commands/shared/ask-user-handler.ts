/**
 * @fileoverview AskUserHandler - 处理 AskUserError 的交互逻辑
 *
 * 功能：
 * 1. 解析 AskUserError 中的 query 和 options
 * 2. 格式化输出，展示问题和选项
 * 3. 等待用户输入（支持数字选择或直接文本输入）
 * 4. 返回用户的选择
 */

import * as readline from "readline";
import chalk from "chalk";
import {
  ASK_USER_TIMEOUT_MS,
  createAskUserTimeoutSentinel,
  withAskUserTimeoutRace,
} from "./ask-user-timeout";

// ============================================================================
// Re-exports — 保持向后兼容：旧代码/测试可能通过 `ask-user-handler.X` 引用。
// ============================================================================

export {
  ASK_USER_TIMEOUT_MS,
  ASK_USER_TIMEOUT_SENTINEL_PREFIX,
  isAskUserTimeoutSentinel,
  createAskUserTimeoutSentinel,
  withAskUserTimeoutRace,
} from "./ask-user-timeout";

/**
 * AskUserError 信息结构
 */
export interface AskUserErrorInfo {
  query: string;
  options?: string[];
  requiredConfirm?: boolean;
  sessionId?: string;
  agentSessionId?: string;
  nodeId?: string;
  nodeType?: string;
}

/**
 * 解析 ask_user query 中的选项
 */
export function parseOptionsFromQuery(query: string): { question: string; options?: string[] } {
  // 匹配格式: "问题 (选项: 选项1, 选项2, 选项3)"
  const optionsMatch = query.match(/\(选项:\s*(.+)\)/);
  if (optionsMatch) {
    const optionsStr = optionsMatch[1];
    const options = optionsStr.split(',').map(o => o.trim()).filter(o => o.length > 0);
    const question = query.replace(/\s*\(选项:.+\)/, '').trim();
    return { question, options };
  }
  return { question: query };
}

/**
 * 格式化 AskUserError 为用户友好的输出
 */
export function formatAskUserOutput(errorInfo: AskUserErrorInfo): string {
  const parts: string[] = [];

  parts.push(chalk.bold('\n🤔 ' + chalk.cyan('需要您的输入')) + '\n');

  // 解析问题和选项
  const { question, options } = parseOptionsFromQuery(errorInfo.query);

  parts.push(chalk.white(question) + '\n');

  // 如果有选项，展示选项列表
  if (options && options.length > 0) {
    parts.push('\n' + chalk.bold('请选择：') + '\n');
    options.forEach((opt, i) => {
      parts.push(chalk.cyan(`  ${i + 1}. `) + chalk.white(opt));
    });
    parts.push('');
  }

  // 提示信息
  if (errorInfo.requiredConfirm) {
    parts.push(chalk.yellow('⚠️ 此操作需要确认，请仔细阅读后再做决定\n'));
  }

  parts.push(chalk.dim('请输入您的回答，或按 Ctrl+C 退出\n'));

  return parts.join('\n');
}

/**
 * 解析用户输入
 *
 * @param input 用户输入
 * @param options 可选的选项列表
 * @returns 解析后的选择（数字索引或原始文本）
 */
export function parseUserInput(input: string, options?: string[]): {
  type: 'option' | 'text';
  value: string | number;
} {
  const trimmedInput = input.trim();

  // 如果有选项，尝试解析为数字选择
  if (options && options.length > 0) {
    const index = parseInt(trimmedInput, 10) - 1;

    // 有效的数字选择
    if (!isNaN(index) && index >= 0 && index < options.length) {
      return { type: 'option', value: index };
    }

    // 精确匹配选项文本
    const exactMatch = options.findIndex(
      opt => opt.toLowerCase() === trimmedInput.toLowerCase()
    );
    if (exactMatch >= 0) {
      return { type: 'option', value: exactMatch };
    }

    // 前缀匹配选项文本
    const prefixMatch = options.findIndex(
      opt => opt.toLowerCase().startsWith(trimmedInput.toLowerCase())
    );
    if (prefixMatch >= 0) {
      return { type: 'option', value: prefixMatch };
    }
  }

  // 无选项或无法匹配，回退到文本输入
  return { type: 'text', value: trimmedInput };
}

/**
 * 获取用户的选择
 *
 * Task #1967: 增加 timeout 支持。
 * - 用户在 timeout 之前输入：原流程不变
 * - timeout 触发：返回 sentinel 字符串，监听器被清理、resolve 一次
 *
 * @param rl readline interface
 * @param errorInfo AskUserError 信息
 * @param opts 可选配置项；opts.timeoutMs 默认 120000ms。测试可注入更短时间。
 * @returns 用户的选择文本，或 sentinel 字符串（用 `isAskUserTimeoutSentinel` 识别）
 */
export async function getUserChoice(
  rl: readline.Interface,
  errorInfo: AskUserErrorInfo,
  opts?: { timeoutMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? ASK_USER_TIMEOUT_MS;

  const { options } = parseOptionsFromQuery(errorInfo.query);

  // 显示格式化输出
  console.log(formatAskUserOutput({ ...errorInfo, options }));

  // 设置提示符
  rl.setPrompt(chalk.cyan('❯ '));
  rl.prompt(true);

  return new Promise((resolve, reject) => {
    const finishWithUserInput = (input: string) => {
      const trimmedInput = input.trim();

      // 忽略空输入：递归重新提示（保留 timeout）
      if (!trimmedInput) {
        console.log(chalk.yellow('⚠️ 输入不能为空，请重新输入\n'));
        // 已经 race winner 处理完了, 递归时不再共享 timer
        getUserChoice(rl, errorInfo, opts).then(resolve).catch(reject);
        return;
      }

      // 解析用户输入
      const parsed = parseUserInput(trimmedInput, options);

      if (parsed.type === 'option' && options) {
        const selectedOption = options[parsed.value as number];
        console.log(chalk.green(`✓ 您选择了: ${selectedOption}\n`));
        resolve(selectedOption);
      } else {
        console.log(chalk.green(`✓ 您的回答: ${parsed.value}\n`));
        resolve(parsed.value as string);
      }
    };

    withAskUserTimeoutRace({
      rl,
      timeoutMs,
      onLine: (input) => {
        finishWithUserInput(input);
      },
      onTimeout: () => {
        console.log(
          chalk.yellow(
            `\n⏱ ask_user 超时：${timeoutMs}ms 内未收到回应，已自动解除等待。`,
          ),
        );
        resolve(
          createAskUserTimeoutSentinel(errorInfo, timeoutMs, { source: 'handler' }),
        );
      },
    });
  });
}

/**
 * AskUserHandler - 处理 AskUserError 的交互逻辑
 */
export class AskUserHandler {
  private rl: readline.Interface;
  /** Task #1967: 可配置 timeout，默认 120000ms */
  public askUserTimeoutMs: number = ASK_USER_TIMEOUT_MS;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /**
   * 处理 AskUserError，等待用户输入
   */
  async handle(errorInfo: AskUserErrorInfo): Promise<string> {
    return getUserChoice(this.rl, errorInfo, {
      timeoutMs: this.askUserTimeoutMs,
    });
  }

  /**
   * 关闭 handler
   */
  close(): void {
    this.rl.close();
  }
}
