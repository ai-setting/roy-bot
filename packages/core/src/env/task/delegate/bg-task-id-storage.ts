/**
 * @fileoverview Per-bgTask AsyncLocalStorage (Task #2144)
 *
 * 镜像 process-registry.ts 的 ALS 模式：把当前 BackgroundTask 的 bgTaskId
 * 推到 ALS 栈顶，让 workflow_run 等工具在 sub-session 内部能读到所属
 * bgTaskId，从而把启动的 workflow runId 注册到 BackgroundTaskManager 的
 * workflowRunRegistries 里，供 stopTask() 级联 stop。
 *
 * 主 session 直接调用（CLI `roy-bot workflow run ...`）时无 bgTaskId，
 * getCurrentBgTaskId() 返回 undefined，工具跳过 attach —— 保持零变化。
 */
import { AsyncLocalStorage } from "async_hooks";

const bgTaskIdStorage = new AsyncLocalStorage<string>();

/**
 * 在异步作用域内暴露 bgTaskId 给 fn。
 */
export function runWithBgTaskIdAsync<T>(
  bgTaskId: string,
  fn: () => Promise<T>
): Promise<T> {
  return bgTaskIdStorage.run(bgTaskId, fn);
}

/**
 * 当前 ALS 栈顶的 bgTaskId（如果存在）。
 * 在 workflow_run 工具中调用：若返回 undefined 则跳过 attach（主 session 场景）。
 */
export function getCurrentBgTaskId(): string | undefined {
  return bgTaskIdStorage.getStore();
}
