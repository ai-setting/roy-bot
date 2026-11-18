/**
 * @fileoverview Task #5117 (M1) — headless run 摘要行渲染器
 *
 * 方案 docs/task-4954-run-output-simplification-plan.md §4.1-2：
 *   run = headless ES 守护命令后，stdout 只出「机器可读的摘要行」。
 *
 * 协议（§3.4）：
 *   [event]     <sourceId> <eventType> <一句话摘要>
 *   [result]    <sessionId> <status> <耗时ms> [prompt=N completion=N total=N] <一句话结果>
 *   [lifecycle] es-started / es-stopped <sourceId>
 *   [fatal]     <message>
 *
 * 铁律：
 *   - 每条摘要**恰好一行**（内部换行替换为空格，不污染协议）
 *   - 只写 stdout，不写 stderr（stderr 归 core logger 诊断）
 *   - 缺省字段省略，不输出 undefined/null
 */

import { createLogger } from "@ai-setting/roy-bot-core";

const logger = createLogger("cli:run-headless-summary");

/** 摘要单行的三种前缀 */
export type SummaryKind = "event" | "result" | "lifecycle" | "fatal";

/** result() 的入参（字段可选，缺省即省略） */
export interface ResultSummaryInput {
  /** 本次执行归属的 session */
  sessionId: string | undefined;
  /** ok / error / abort ... */
  status: string;
  /** 本轮耗时（毫秒） */
  durationMs: number;
  /** LLM usage（来自 executor.getLastUsage()，缺省省略） */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 一句话结果摘要 */
  summary: string;
}

/** 单行压平：换行 → 空格 */
function flatten(text: string): string {
  return String(text).replace(/\r?\n+/g, " ").trim();
}

/**
 * 组装一行（不含尾部换行）。
 * 导出给测试 / 复用（如未来 JSONL 档）。
 */
export function buildSummaryLine(kind: SummaryKind, body: string): string {
  return `[${kind}] ${flatten(body)}`;
}

/**
 * headless 摘要渲染器。
 *
 * 用法（run.ts handler 内）：
 *   const summary = new RunHeadlessSummary();
 *   summary.lifecycleStarted(sourceId);          // ES 启动后
 *   summary.event(sourceId, eventType, 摘要);     // 事件到达
 *   summary.result({...});                        // 每轮执行完
 *   summary.lifecycleStopped(sourceId);          // SIGTERM 优雅停机
 *   summary.fatal(message);                      // 无法继续时
 */
export class RunHeadlessSummary {
  /** 覆盖默认写 stdout（测试注入用） */
  private writeFn: (line: string) => void;

  constructor(writeFn?: (line: string) => void) {
    this.writeFn = writeFn ?? ((line) => process.stdout.write(line));
  }

  /** 把一行摘要写到 stdout（唯一落点） */
  private emit(line: string): void {
    try {
      this.writeFn(line + "\n");
    } catch (err) {
      // stdout 写失败（EPIPE 等）绝不能打断 ES 守护主循环
      logger.warn("summary write failed", { error: String(err) });
    }
  }

  /** [event] <sourceId> <eventType> <一句话摘要> */
  event(sourceId: string | undefined, eventType: string, summary: string): void {
    const sid = flatten(sourceId ?? "unknown");
    const et = flatten(eventType ?? "unknown");
    this.emit(buildSummaryLine("event", `${sid} ${et} ${summary}`));
  }

  /** [result] <sessionId> <status> <耗时ms> [prompt=N completion=N total=N] <摘要> */
  result(input: ResultSummaryInput): void {
    const sid = flatten(input.sessionId ?? "unknown");
    const parts = [sid, flatten(input.status), `${Math.round(input.durationMs)}ms`];
    if (typeof input.promptTokens === "number") parts.push(`prompt=${input.promptTokens}`);
    if (typeof input.completionTokens === "number") parts.push(`completion=${input.completionTokens}`);
    if (typeof input.totalTokens === "number") parts.push(`total=${input.totalTokens}`);
    parts.push(flatten(input.summary));
    this.emit(buildSummaryLine("result", parts.join(" ")));
  }

  /** [lifecycle] es-started <sourceId> */
  lifecycleStarted(sourceId: string): void {
    this.emit(buildSummaryLine("lifecycle", `es-started ${flatten(sourceId)}`));
  }

  /** [lifecycle] es-stopped <sourceId> */
  lifecycleStopped(sourceId: string): void {
    this.emit(buildSummaryLine("lifecycle", `es-stopped ${flatten(sourceId)}`));
  }

  /** [fatal] <message> — 仅当无法继续时（正常错误仍走 stderr） */
  fatal(message: string): void {
    this.emit(buildSummaryLine("fatal", message));
  }
}
