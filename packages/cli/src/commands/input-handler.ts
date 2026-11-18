/**
 * @fileoverview InputHandler - 纯粹 buffer 管理
 *
 * 只负责累积输入，不处理结束检测
 *
 * 安全设计：
 * - pushLine 过滤 C0 控制字符（除 \t \n \r）以避免 EIO 崩溃
 * - 防御性处理 null / undefined
 */

export class InputHandler {
  private buffer: string[] = [];

  // 提示符
  private static readonly USER_PROMPT = "❯ ";
  private static readonly CONTINUATION_PROMPT = "... ";

  /**
   * 过滤 C0 控制字符
   * - 保留：\t (\x09), \n (\x0a), \r (\x0d) — 常用空白
   * - 过滤：\x00-\x08, \x0b-\x0c, \x0e-\x1f, \x7f (DEL)
   * - 保留 \x1b (Esc) — 由 keypress listener 单独处理
   *
   * 目的：避免控制字符（如 \x00-\x1f 序列）进入 stdin read 路径
   * 触发 EIO 崩溃。
   */
  static filterControlChars(input: string): string {
    if (!input) return "";
    // eslint-disable-next-line no-control-regex
    return input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  }

  /**
   * 添加一行输入（自动过滤控制字符；null/undefined 安全）
   */
  pushLine(line: string | null | undefined): void {
    if (line == null) {
      // null/undefined → 跳过（防御性，避免崩溃）
      return;
    }
    this.buffer.push(InputHandler.filterControlChars(line));
  }

  /**
   * 获取当前 buffer 内容
   */
  getBuffer(): string {
    return this.buffer.join("\n");
  }

  /**
   * 重置 buffer
   */
  reset(): void {
    this.buffer = [];
  }

  /**
   * 获取提示符
   */
  getPrompt(): string {
    return this.buffer.length > 0
      ? InputHandler.CONTINUATION_PROMPT
      : InputHandler.USER_PROMPT;
  }
}
