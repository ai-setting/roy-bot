/**
 * @fileoverview Per-task ProcessRegistry
 *
 * 每个 delegate_task 持有一个 ProcessRegistry，跟踪该 task 派生的子进程 PID。
 * bash 工具 spawn 子进程后立即 register，子进程 `exit` 时立即 unregister。
 * 当 task 超时/stop 时，调用 killAll() 遍历所有剩余 PID，调用 killProcessTree。
 *
 * AsyncLocalStorage 隔离：
 * - runWithProcessRegistryAsync(reg, fn) 把 reg 推到 ALS 栈，进入 fn
 * - getCurrentProcessRegistry() 在 fn 内返回 reg，外部返回 undefined
 * - 这样 bash 工具不感知任务边界，只需要 "我这里有个当前 registry 吗？有就注册"
 *
 * 设计原则：
 * - 不影响非 delegate_task 场景（ALS 拿不到 registry 时 bash 不注册，行为零变化）
 * - 不误杀其他 delegate_task（每个 task 一个独立 registry）
 * - killAll 带验证+重试：每个 PID 最多杀 3 次，间隔 500ms，杀不掉记录 error 日志
 */

import { AsyncLocalStorage } from "async_hooks";

import { killProcessTree } from "../../../util/process/process-tree-killer";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("task:process-registry");

// ----------------------------------------------------------------------------
// Registry class
// ----------------------------------------------------------------------------

export class ProcessRegistry {
  private readonly pids = new Set<number>();

  /**
   * 注册一个 PID 到当前 registry。
   * - 重复 register 同一 PID：幂等
   * - 非正整数 / NaN：静默忽略（避免脏数据）
   */
  register(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }
    this.pids.add(pid);
  }

  /**
   * 反注册一个 PID（子进程 exit 时调用）。
   * 不存在时不报错（幂等）。
   */
  unregister(pid: number): void {
    if (!Number.isInteger(pid)) {
      return;
    }
    this.pids.delete(pid);
  }

  /** 当前注册的 PID 数量（测试 + debug 用途） */
  size(): number {
    return this.pids.size;
  }

  /**
   * 杀掉所有仍注册在本 registry 的进程树（POSIX 杀进程组 / Windows taskkill /T）。
   *
   * 验证 + 重试机制：
   * - 每次 kill 后等待 500ms，验证进程是否真的被干掉
   * - 没干掉则重试，最多 3 次
   * - 3 次还干不掉：记录 error 日志
   *
   * Task #2245 — BL-4：保留 `stillAlive` PID 以便后续强杀可重试。
   * - 旧实现：成功杀掉的 PID 仍被无差别 `clear()`，与 stillAlive 一起丢失。
   * - 新实现：仅 `delete` 真正被杀死的 PID，stillAlive PID 保留供下次重试。
   * - 调用方（如 forceStopAll）可以多次调用 killAll 重试残留 PID。
   * - 内部不 throw — 单个 PID 的 ESRCH/EPERM 不会阻断其他 PID 的清理。
   */
  async killAll(): Promise<void> {
    if (this.pids.size === 0) return;

    const pidList = Array.from(this.pids);
    logger.info(`[bg-process:killAll-begin] count=${pidList.length} pids=[${pidList.join(",")}]`);

    for (const pid of pidList) {
      try {
        const result = await killProcessTree(pid, { retry: 3, retryDelayMs: 500 });

        if (result.stillAlive) {
          // Task #2245 — log but KEEP the PID for retry; do not delete.
          logger.error(
            `进程 PID ${pid} 经过 ${result.attempts} 次重试后仍未杀死！保留 PID 供后续 forceStopAll 重试。`
          );
        } else {
          // Successfully killed; remove from registry.
          this.pids.delete(pid);
        }
      } catch {
        // killProcessTree 自身只对无效 PID throw；其它错误由它内部吞掉
      }
    }
    logger.info(`[bg-process:killAll-done] remaining=${this.pids.size}`);
  }
}

// ----------------------------------------------------------------------------
// AsyncLocalStorage wrapper
// ----------------------------------------------------------------------------

const processRegistryStorage = new AsyncLocalStorage<ProcessRegistry>();

/**
 * 在异步作用域内暴露给定的 ProcessRegistry。
 * 适合用在 executeWithAbort 包裹 env.handle_query 之处。
 */
export function runWithProcessRegistryAsync<T>(
  registry: ProcessRegistry,
  fn: () => Promise<T>
): Promise<T> {
  return processRegistryStorage.run(registry, fn);
}

/**
 * 当前 ALS 栈顶的 ProcessRegistry（如果存在）。
 * 在 bash 工具中调用：若返回 undefined 则退化为不注册（保持非 delegate_task 场景的行为）。
 */
export function getCurrentProcessRegistry(): ProcessRegistry | undefined {
  return processRegistryStorage.getStore();
}
