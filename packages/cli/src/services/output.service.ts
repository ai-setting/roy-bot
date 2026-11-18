/**
 * @fileoverview Output Service
 * 
 * 统一的输出格式化服务（非交互式）
 */

import chalk from "chalk";

export interface OutputOptions {
  quiet?: boolean;
  jsonOutput?: boolean;
  noColor?: boolean;
}

/**
 * OutputService - CLI 输出服务
 * 
 * 提供统一的格式化输出：
 * - 普通消息
 * - 成功/警告/错误消息
 * - JSON 输出
 */
export class OutputService {
  private quiet: boolean = false;
  private jsonOutput: boolean = false;
  private noColor: boolean = false;

  /**
   * 配置输出选项
   */
  configure(options: OutputOptions): void {
    this.quiet = options.quiet ?? this.quiet;
    this.jsonOutput = options.jsonOutput ?? this.jsonOutput;
    this.noColor = options.noColor ?? this.noColor;
  }

  /**
   * 获取配置状态
   */
  isQuiet(): boolean {
    return this.quiet;
  }

  isJsonOutput(): boolean {
    return this.jsonOutput;
  }

  isNoColor(): boolean {
    return this.noColor;
  }

  /**
   * 输出普通消息
   */
  info(message: string): void {
    if (!this.quiet) {
      console.log(message);
    }
  }

  /**
   * 输出日志消息（不添加前缀）
   */
  log(message?: string): void {
    console.log(message ?? "");
  }

  /**
   * 输出成功消息
   */
  success(message: string): void {
    if (!this.quiet) {
      console.log(chalk.green("✓ ") + message);
    }
  }

  /**
   * 输出警告消息
   */
  warn(message: string): void {
    if (!this.quiet) {
      console.warn(chalk.yellow("⚠ ") + message);
    }
  }

  /**
   * 输出错误消息
   * 
   * 注意：错误消息即使在安静模式下也会输出
   */
  error(message: string): void {
    console.error(chalk.red("✗ ") + message);
  }

  /**
   * 输出错误消息（详细版）
   */
  errorDetailed(message: string, details?: unknown): void {
    console.error(chalk.red("✗ ") + message);
    if (details && !this.quiet) {
      console.error(JSON.stringify(details, null, 2));
    }
  }

  /**
   * 格式化并输出 JSON
   */
  printJson(data: unknown, pretty: boolean = true): void {
    if (pretty) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(JSON.stringify(data));
    }
  }

  /**
   * 输出 JSON（别名方法）
   */
  json(data: unknown): void {
    this.printJson(data);
  }
}
