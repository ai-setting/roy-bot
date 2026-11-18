/**
 * @fileoverview Interactive EventSource Startup Helper
 *
 * 从 interactive.ts 中提取的事件源启动逻辑，使其可独立测试
 *
 * 设计原则：
 * 1. 接受依赖（output, eventSourceComponent, exit）作为参数
 * 2. 不依赖 process.exit（返回结果让调用者决定）
 * 3. 支持多事件源
 * 4. 单个失败不影响其他
 * 5. 已有 running 跳过
 */

import type { OutputService } from "../services/output.service";
import type { EventSourceComponentInterface } from "@ai-setting/roy-bot-core";
import { TracedAs } from "@ai-setting/roy-bot-core";
import { CliQuietModeService } from "../services/quiet-mode.service";

/**
 * 单个事件源启动结果
 */
export interface EventSourceStartupResult {
  /** 事件源 ID（匹配后的完整 ID） */
  id: string;
  /** 事件源名称 */
  name: string;
  /** 是否成功 */
  success: boolean;
  /** 状态：started / skipped (已在运行) / failed (启动失败) / not_found (id 不存在) */
  status: "started" | "skipped" | "failed" | "not_found";
  /** 错误信息（如果失败） */
  error?: string;
}

/**
 * 多事件源启动的汇总结果
 */
export interface EventSourceStartupSummary {
  results: EventSourceStartupResult[];
  total: number;
  successCount: number;
  failedCount: number;
}

/**
 * 进程退出回调（用于测试时替换 process.exit）
 */
export type ExitFn = (code: number) => void;

/**
 * 启动单个事件源（核心实现）
 *
 * 行为：
 * 1. 通过前缀匹配找到事件源
 * 2. 找不到 → status=not_found
 * 3. 已在 running → status=skipped
 * 4. 否则启动 → status=started；启动失败 → status=failed
 */
export async function startSingleEventSource(
  eventSourceComponent: EventSourceComponentInterface,
  output: OutputService,
  eventSourceId: string,
): Promise<EventSourceStartupResult> {
  return EventSourceStarter.instance.runSingle(eventSourceComponent, output, eventSourceId);
}

/**
 * 启动多个事件源（核心循环）
 *
 * 行为：
 * 1. 空数组 → 跳过（不报错）
 * 2. 依次启动每个 id
 * 3. 单个失败不影响其他
 * 4. 汇总成功/失败数量
 */
export async function startEventSources(
  eventSourceIds: string[],
  eventSourceComponent: EventSourceComponentInterface,
  output: OutputService,
): Promise<EventSourceStartupSummary> {
  return EventSourceStarter.instance.run(eventSourceIds, eventSourceComponent, output);
}

/**
 * 内部类：用于附加 @TracedAs 装饰器
 */
class EventSourceStarter {
  static readonly instance = new EventSourceStarter();

  @TracedAs("interactive.startEventSources", { recordParams: false, log: false })
  async run(
    eventSourceIds: string[],
    eventSourceComponent: EventSourceComponentInterface,
    output: OutputService,
  ): Promise<EventSourceStartupSummary> {
    return startEventSourcesImpl(eventSourceIds, eventSourceComponent, output);
  }

  @TracedAs("interactive.startSingleEventSource", { recordParams: false, log: false })
  async runSingle(
    eventSourceComponent: EventSourceComponentInterface,
    output: OutputService,
    eventSourceId: string,
  ): Promise<EventSourceStartupResult> {
    return startSingleEventSourceImpl(eventSourceComponent, output, eventSourceId);
  }
}

/**
 * 实际实现（不附加装饰器）
 */
async function startEventSourcesImpl(
  eventSourceIds: string[],
  eventSourceComponent: EventSourceComponentInterface,
  output: OutputService,
): Promise<EventSourceStartupSummary> {
  const results: EventSourceStartupResult[] = [];

  if (!eventSourceIds || eventSourceIds.length === 0) {
    return { results, total: 0, successCount: 0, failedCount: 0 };
  }

  for (const id of eventSourceIds) {
    if (!id) continue; // 跳过空字符串
    const result = await startSingleEventSource(eventSourceComponent, output, id);
    results.push(result);
  }

  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.length - successCount;

  // 输出总结
  if (results.length > 1) {
    if (failedCount > 0) {
      output.info(`\n✅ 成功启动 ${successCount}/${results.length} 个事件源`);
    } else {
      output.success(`\n✅ 成功启动 ${successCount}/${results.length} 个事件源`);
    }
  }

  return { results, total: results.length, successCount, failedCount };
}

/**
 * 启动单个事件源的实现
 */
async function startSingleEventSourceImpl(
  eventSourceComponent: EventSourceComponentInterface,
  output: OutputService,
  eventSourceId: string,
): Promise<EventSourceStartupResult> {
  // 查找事件源（支持前缀匹配）
  const sources = eventSourceComponent.list();
  const matchedSource = sources.find(
    (s) => s.id === eventSourceId || (s.id as string).startsWith(eventSourceId),
  );

  if (!matchedSource) {
    output.error(`❌ 事件源不存在: ${eventSourceId}`);
    // ★ Task #5117 (M1)：quiet（headless）下不往 stdout 打列表
    //   （error 走 stderr 不受 quiet 影响）。
    if (!CliQuietModeService.getInstance().isQuiet()) {
      output.info(`可用的事件源:`);
      for (const s of sources) {
        output.info(`  - ${(s.id as string).substring(0, 8)}: ${s.name} (${s.type})`);
      }
    }
    return {
      id: eventSourceId,
      name: eventSourceId,
      success: false,
      status: "not_found",
      error: `EventSource not found: ${eventSourceId}`,
    };
  }

  const actualId = matchedSource.id;
  const status = eventSourceComponent.getStatus(actualId);

  if (status === "running") {
    output.info(`📡 事件源 ${matchedSource.name} 已在运行中`);
    return {
      id: actualId,
      name: matchedSource.name,
      success: true,
      status: "skipped",
    };
  }

  try {
    await eventSourceComponent.startSource(actualId);

    // 验证启动成功
    const verifyStatus = eventSourceComponent.getStatus(actualId);
    if (verifyStatus !== "running") {
      const errMsg = `启动后状态异常: ${verifyStatus}`;
      output.error(`❌ ${errMsg}`);
      return {
        id: actualId,
        name: matchedSource.name,
        success: false,
        status: "failed",
        error: errMsg,
      };
    }

    // ★ Task #5117 (M1)：quiet（headless）下不打到 stdout ——
    //   [lifecycle] es-started 摘要行已由 run 主循环输出。
    if (!CliQuietModeService.getInstance().isQuiet()) {
      output.success(`📡 已启动事件源: ${matchedSource.name} (${verifyStatus})`);
    }
    return {
      id: actualId,
      name: matchedSource.name,
      success: true,
      status: "started",
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    output.error(`❌ 启动事件源失败: ${matchedSource.name} - ${errMsg}`);
    return {
      id: actualId,
      name: matchedSource.name,
      success: false,
      status: "failed",
      error: errMsg,
    };
  }
}
