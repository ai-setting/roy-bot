/**
 * @fileoverview CLI Quiet Mode Service
 * 
 * 统一管理 CLI 的 quiet 模式状态
 * 
 * 默认 quiet 开启，通过 --no-quiet 关闭
 */

import { setQuietMode as setCoreQuietMode, isQuietMode as isCoreQuietMode } from "@ai-setting/roy-bot-core";

export class CliQuietModeService {
  private static instance: CliQuietModeService;

  private constructor() {}

  static getInstance(): CliQuietModeService {
    if (!CliQuietModeService.instance) {
      CliQuietModeService.instance = new CliQuietModeService();
    }
    return CliQuietModeService.instance;
  }

  setQuiet(value: boolean): void {
    setCoreQuietMode(value);
  }

  isQuiet(): boolean {
    return isCoreQuietMode();
  }

  setQuietFromArgv(argv: { quiet?: boolean }): void {
    if (argv.quiet === true) {
      setCoreQuietMode(true);
    }
    // If argv.quiet is false or undefined, leave current mode unchanged
  }

  reset(): void {
    setCoreQuietMode(false);
  }
}
