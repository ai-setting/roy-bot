/**
 * @fileoverview Task Component Index
 */

export { TaskComponent, type TaskComponentOptions } from "./task-component";
export * from "./types";
export {
  SQLiteTaskStore,
  getDefaultTaskDbPath,
  type TaskStore,
  // Task #5440 — remote 存储（M2）
  RemoteTaskStore,
  createRemoteTaskStore,
  RemoteTaskStoreError,
  RemoteAuthError,
  RemoteBatchBusyError,
  RemoteIdempotencyConflictError,
  RemoteProtocolError,
  type RemoteTaskStoreOptions,
} from "./storage";

// ★ Task #5063 — 终态 current_status 措辞同源锚点（对外导出，供 CLI 侧引用，
//   避免「已归档」字面量在 CLI 里重复 —— 见 tools/completion-copy.ts）
export {
  TASK_COMPLETED_STATUS_WORD,
  TASK_CANCELLED_STATUS_WORD,
  TASK_ARCHIVED_STATUS_WORD,
  TASK_DELIVERABLE_RECORDED,
} from "./tools/completion-copy";

// 导出 Task Events
export * from "./events";
