/**
 * @fileoverview Task Backend — roy 语义的单一实现点
 *
 * Task #4380（架构 review #4371 §8.1「把 roy 语义从 roy-bridge 上移到
 * roy-bot-core」的落地）。
 *
 * ```ts
 * import {
 *   TaskStoreBackend,
 *   createSQLiteTaskPort,
 *   type TaskBackend,
 *   type TaskPersistencePort,
 * } from "@ai-setting/roy-bot-core/env/task/backend";
 * ```
 *
 * - `TaskStoreBackend` — 全部 roy 语义（子树 / depth / deliverable /
 *   create-operation / total / milestone 过滤 / 词汇单一来源）
 * - `TaskPersistencePort` — 纯存取原语，任何 agent 插件实现它即可获得全部语义
 * - `createSQLiteTaskPort` — roy 自己 `SQLiteTaskStore` 的现成 port 实现
 * - `createRemoteTaskPort` / `createTaskPortFromConfig` — 让 backend 走常驻
 *   task-service（Task #5440：MCP 通道与 agent 工具链是两条独立接线路径）
 */

export * from "./types";
export {
  TaskStoreBackend,
  DELIVERABLE_OPERATION_PREFIX,
  formatDeliverableForOperation,
  mergeDeliverableIntoContext,
  allowedIdsByDepth,
  toNumericHandle,
} from "./task-store-backend";
export { createSQLiteTaskPort } from "./sqlite-task-port";
export {
  createRemoteTaskPort,
  createRemoteTaskPortFromStore,
  createTaskPortFromConfig,
  type RemoteTaskPortOptions,
  type TaskPortFromConfig,
} from "./remote-task-port";
export {
  createRoySidecarTaskPort,
  type RoySidecarTaskStore,
  type RoySidecarPortOptions,
  type SidecarOperation,
  type SidecarTask,
  type SidecarVocabulary,
} from "./roy-sidecar-task-port";
