/**
 * @fileoverview Task Storage Index
 */

export { SQLiteTaskStore, type TaskStore } from "./sqlite-task-store";
export { getDefaultTaskDbPath, getDefaultDataDir } from "./sqlite-task-store";
// Task #5440 — remote 存储（指向常驻 roy-task-service）
export {
  RemoteTaskStore,
  createRemoteTaskStore,
  RemoteTaskStoreError,
  RemoteAuthError,
  RemoteBatchBusyError,
  RemoteIdempotencyConflictError,
  RemoteProtocolError,
  REMOTE_PROTOCOL_MAJOR,
  REMOTE_TASK_STORE_METHODS,
  type RemoteTaskStoreOptions,
  type RemoteLogger,
  type RemoteTaskStoreStats,
} from "./remote-task-store";
