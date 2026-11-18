/**
 * @fileoverview Act stdout finalize helper
 *
 * Task #2833: [Bug] roy-bot act 命令重复输出 AI 回复（stdout emit 2 次）
 *
 * 根因：
 *   act.ts 在 contextHandler.handleQueryWithContext() 返回 result 后无条件
 *   调用 output.log(result)，与 StreamOutputService 已经通过 process.stdout.write
 *   流式输出的内容重复。
 *
 * 修复策略：
 *   仅当 LLM 流没有发出任何文本时（workflow agent 或零文本响应）才补打印，
 *   否则直接跳过避免重复 emit。
 *
 * 注意：output.log() 走 console.log（无 ANSI 颜色），而 StreamOutputService 走
 * process.stdout.write（带 ANSI 颜色）。两条 stdout 路径并存会导致：
 *   - 用户看到 2 次回复（一次有颜色，一次无颜色）
 *   - think 块和正文会被切分到两个 emit 中（视觉混乱）
 */

import type { OutputService } from "../services/output.service";
import type { StreamOutputService } from "../services/stream-output.service";

export interface FinalizeActStdoutArgs {
  /** handleQueryWithContext 返回的最终文本 */
  result: string;
  /** 已订阅 llm.text 等事件的 StreamOutputService 实例 */
  streamService: StreamOutputService;
  /** OutputService（用于 console.log 输出） */
  output: OutputService;
}

/**
 * Decide whether to call output.log(result) after handleQueryWithContext.
 *
 * 行为契约：
 *   - result 为空 / 0 长度 → 不打印（无内容可打印）
 *   - streamService 已发出文本（fullText 非空） → 不打印（避免与 stdout 流重复）
 *   - streamService 没发出任何文本 → 打印 result（覆盖 workflow agent 等非流式路径）
 *
 * @param args - 见 FinalizeActStdoutArgs
 */
export function finalizeActStdout(args: FinalizeActStdoutArgs): void {
  const { result, streamService, output } = args;
  if (!result || result.length === 0) return;
  // streamService 已通过 process.stdout.write 把 LLM 流输出到 stdout，
  // 再调 output.log(result) 会导致 console.log 第二次 emit 同样内容。
  if (streamService.getFullText().length > 0) return;
  output.log(result);
}